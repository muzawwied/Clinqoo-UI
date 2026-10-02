// Cloudflare Pages Functions - Wallet Backend (per-account)
import { currentUser, scopedKey, rowScope } from './user-scope.js';
import { emailTemplate, formatIDR, sendEmail, notifyEvent, getUserByEmail } from './notify-helpers.js';
import { getCpConnection, mirroredBalance, mirrorDelta } from './clincoopay-helpers.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

function j(data, status) {
  return new Response(JSON.stringify(data), { status: status || 200, headers: { 'Content-Type': 'application/json', ...CORS } });
}

export async function onRequestOptions() { return new Response(null, { headers: CORS }); }

// Ambil secret dari env Pages atau tabel env_vars D1 (per-proyek, key global = project_id NULL)
async function getSecret(env, key) {
  if (env[key]) return env[key];
  try {
    const row = await env.DB.prepare("SELECT value FROM env_vars WHERE key = ? AND (project_id IS NULL OR project_id = '')").bind(key).first();
    if (row?.value) return row.value;
  } catch {}
  return null;
}

// Callback top up (Base44/Xendit) datang TANPA login — identifikasi pemilik akun
// dari email di payload (email/payer_email) saja, lalu scope saldo/transaksi/notifikasi/email
// ke akun pemilik. Tanpa token ATAU email dikenal => ditolak (fail-closed).
// Webhook Xendit asli memakai /api/topup dengan verifikasi x-callback-token, bukan endpoint ini.
async function resolveOwner(env, request, body) {
  const u = await currentUser(env, request);
  if (u) return u;
  const cands = [];
  if (body) {
    if (body.email) cands.push(body.email);
    if (body.payer_email) cands.push(body.payer_email);
  }
  for (const c of cands) {
    if (!c) continue;
    const found = await getUserByEmail(env.DB, c);
    if (found) return found;
  }
  return null;
}

// GET /api/wallet?action=transactions — list transaksi; GET /api/wallet — saldo
export async function onRequestGet({ request, env }) {
  const db = env.DB;
  if (!db) return j({ error: 'D1 not bound' }, 500);
  try {
    const url = new URL(request.url);
    const action = url.searchParams.get('action');
    const user = await currentUser(env, request);

    if (action === 'transactions') {
      const uid = await rowScope(db, 'wallet_transactions', user);
      if (!uid) return j({ transactions: [] }); // tanpa login: jangan bocorkan transaksi akun lain
      const txs = await db.prepare('SELECT * FROM wallet_transactions WHERE user_id = ? ORDER BY created_at DESC').bind(uid).all();
      return j({ transactions: txs.results || [] });
    }

    const balKey = await scopedKey(db, 'wallet_balance', user, 'balance');
    const row = await db.prepare('SELECT value FROM wallet_balance WHERE key = ?').bind(balKey).first();
    // ClincooPay: dompet terhubung → saldo live dari web Wallet (mirroring 2 arah, frontend tidak berubah)
    if (user) {
      const conn = await getCpConnection(db, user.id);
      if (conn) {
        const wb = await mirroredBalance(conn);
        if (wb !== null) return j({ balance: wb, mirrored: true, wallet_address: conn.wallet_address });
      }
    }
    return j({ balance: parseFloat(row?.value || '0') });
  } catch (err) {
    return j({ error: err.message }, 500);
  }
}


// POST /api/wallet — add_transaction | set_balance | clear_transactions
export async function onRequestPost({ request, env }) {
  const db = env.DB;
  if (!db) return j({ error: 'D1 not bound' }, 500);
  try {
    const body = await request.json();
    const action = body.action || 'add_transaction';
    const user = await resolveOwner(env, request, body);
    const balKey = await scopedKey(db, 'wallet_balance', user, 'balance');
    const uid = user ? user.id : null;

    // Mutasi dompet wajib login — mencegah penulisan/penghapusan data lintas akun
    if (!uid) return j({ error: 'Login diperlukan', need_login: true }, 401);

    if (action === 'add_transaction') {
      const { title, amount, type, method } = body;
      if (!title || amount == null || !type) return j({ error: 'title, amount, type required' }, 400);
      const parsedAmount = parseFloat(amount);
      if (isNaN(parsedAmount)) return j({ error: 'amount tidak valid' }, 400);

      await rowScope(db, 'wallet_transactions', user);

      // Idempotensi top up Xendit: order_id yang sudah pernah dikreditkan tidak dikreditkan/dinotifikasi lagi
      // (mencegah saldo & notif dobel jika pemanggil — mis. callback Koda — mengirim request yang sama 2x)
      const orderId = (String(title).match(/\[(TOPUP-[^\]]+)\]/) || [])[1] || null;
      if (orderId) {
        const dup = await db.prepare('SELECT id FROM wallet_transactions WHERE user_id = ? AND title = ? LIMIT 1').bind(uid, title).first();
        if (dup) {
          const balRowDup = await db.prepare('SELECT value FROM wallet_balance WHERE key = ?').bind(balKey).first();
          return j({ success: true, id: dup.id, balance: parseFloat(balRowDup?.value || '0'), duplicate: true });
        }
      }

      const txId = 'TX-' + Math.floor(100000 + Math.random() * 900000);
      await db.prepare('INSERT INTO wallet_transactions (id, title, amount, type, method, user_id) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(txId, title, parsedAmount, type, method || '', uid).run();

      // ClincooPay: pengguna terhubung → saldo di web Wallet yang diubah (mirroring 2 arah)
      const cpConn = await getCpConnection(db, uid);
      if (cpConn && (type === 'in' || type === 'out')) {
        const delta = type === 'in' ? Math.abs(parsedAmount) : -Math.abs(parsedAmount);
        const mr = await mirrorDelta(cpConn, delta, 'Clincoo: ' + String(title), txId);
        if (!mr.ok) {
          const kurang = String(mr.error).indexOf('tidak cukup') >= 0;
          return j({ error: kurang ? 'Saldo ClincooPay tidak cukup.' : mr.error }, kurang ? 402 : 502);
        }
        return j({ success: true, id: txId, balance: mr.balance, mirrored: true });
      }

      const balRow = await db.prepare('SELECT value FROM wallet_balance WHERE key = ?').bind(balKey).first();
      let balance = parseFloat(balRow?.value || '0');
      if (type === 'in') balance += parsedAmount;
      else if (type === 'out') balance -= parsedAmount;

      await db.prepare('INSERT INTO wallet_balance (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .bind(balKey, String(balance)).run();

      // Notifikasi in-app + email konfirmasi (Brevo) — hanya utk transaksi hasil top up Xendit
      if (/^top up xendit/i.test(String(title))) {
        const nres = { notif: false, email: null };
        try {
          nres.notif = await notifyEvent(db, user, {
            source: 'Dompet', type: 'wallet',
            message: 'Top up ' + formatIDR(parsedAmount) + ' via ' + (method || 'Xendit') + ' berhasil. Saldo sekarang ' + formatIDR(balance) + '.',
            link: 'https://muzawwied.github.io/Clincoo./akun/dompet/'
          });
        } catch (e) { nres.notifErr = String(e && e.message || e); }
        if (user && user.email) {
          try {
            nres.email = await sendEmail(env, {
              toEmail: user.email, toName: user.name || '',
              subject: 'Konfirmasi Top Up Clincoo — ' + formatIDR(parsedAmount),
              html: emailTemplate(
                'Top Up Berhasil',
                user.name || '',
                'Top up saldo Clincoo Anda telah berhasil diproses dan saldo telah masuk ke Dompet Anda. Berikut rincian transaksinya:',
                [
                  ['Jumlah Top Up', formatIDR(parsedAmount) + ' (' + (method || 'Xendit') + ')'],
                  ['Saldo Saat Ini', formatIDR(balance)],
                  ['ID Transaksi', txId],
                  ['Order ID', orderId]
                ],
                'Lihat Riwayat Dompet',
                'https://muzawwied.github.io/Clincoo./akun/dompet/',
                'Rincian lengkap transaksi dapat dilihat di halaman Dompet pada akun Clincoo Anda.'
              )
            });
          } catch (e) { nres.emailErr = String(e && e.message || e); }
        }
        try {
          await rowScope(db, 'activity_log', user);
          await db.prepare('INSERT INTO activity_log (action, details, user_id) VALUES (?, ?, ?)')
            .bind('notify_email_result', 'notif=' + String(nres.notif) + ' email=' + JSON.stringify(nres.email).slice(0, 200), uid).run();
        } catch (e2) {}
      }

      try {
        await rowScope(db, 'activity_log', user);
        await db.prepare('INSERT INTO activity_log (action, details, user_id) VALUES (?, ?, ?)').bind('wallet_transaction', title + ' (' + type + ': ' + amount + ')', uid).run();
      } catch {}

      return j({ success: true, id: txId, balance });
    }

    if (action === 'transfer') {
      // Kirim saldo ke pengguna Clincoo lain (via email) — double-entry: out pengirim, in penerima
      const toEmail = String(body.to_email || '').trim().toLowerCase();
      const amount = Math.floor(parseFloat(body.amount));
      const note = String(body.note || '').slice(0, 140);
      if (!toEmail || toEmail.indexOf('@') < 1) return j({ error: 'Email penerima tidak valid' }, 400);
      if (!amount || amount < 1000) return j({ error: 'Minimal kirim saldo Rp 1.000' }, 400);
      if (String(user.email || '').toLowerCase() === toEmail) return j({ error: 'Tidak bisa mengirim ke akun sendiri' }, 400);
      const target = await getUserByEmail(db, toEmail);
      if (!target) return j({ error: 'Akun penerima tidak ditemukan. Pastikan email sudah terdaftar di Clincoo.' }, 404);

      const senderBalKey = await scopedKey(db, 'wallet_balance', user, 'balance');
      const balRow = await db.prepare('SELECT value FROM wallet_balance WHERE key = ?').bind(senderBalKey).first();
      let balance = parseFloat(balRow?.value || '0');
      // ClincooPay: pengirim terhubung → cek saldo live web Wallet
      const senderConn = await getCpConnection(db, uid);
      if (senderConn) {
        const wb = await mirroredBalance(senderConn);
        if (wb !== null) balance = wb;
      }
      if (balance < amount) return j({ error: 'Saldo tidak cukup. Saldo Anda ' + formatIDR(balance) + '.', balance: balance, required: amount }, 402);

      const recvBalKey = await scopedKey(db, 'wallet_balance', target, 'balance');
      const txIdOut = 'TX-' + Math.floor(100000 + Math.random() * 900000);
      const txIdIn = 'TX-' + Math.floor(100000 + Math.random() * 900000);
      const recvRow = await db.prepare('SELECT value FROM wallet_balance WHERE key = ?').bind(recvBalKey).first();
      let newBalance = balance - amount;
      const senderLabel = (user.name || user.email || 'Pengirim');
      const targetLabel = (target.name || target.email || 'Penerima');
      const titleOut = 'Kirim Saldo ke ' + targetLabel + (note ? ' — ' + note : '');
      const titleIn = 'Terima Saldo dari ' + senderLabel + (note ? ' — ' + note : '');

      // Catat transaksi kedua pihak
      await db.prepare('INSERT INTO wallet_transactions (id, title, amount, type, method, user_id) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(txIdOut, titleOut, amount, 'out', 'Kirim Saldo', uid).run();
      await db.prepare('INSERT INTO wallet_transactions (id, title, amount, type, method, user_id) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(txIdIn, titleIn, amount, 'in', 'Terima Saldo', target.id).run();

      // ClincooPay: mirror debit pengirim ke web Wallet (idempotent via txIdOut)
      if (senderConn) {
        const mr = await mirrorDelta(senderConn, -amount, 'Clincoo: ' + titleOut, txIdOut);
        if (!mr.ok) {
          const kurang = String(mr.error).indexOf('tidak cukup') >= 0;
          return j({ error: kurang ? 'Saldo ClincooPay tidak cukup.' : mr.error }, kurang ? 402 : 502);
        }
        newBalance = mr.balance;
      }
      // ClincooPay: mirror kredit penerima bila terhubung
      const recvConn = await getCpConnection(db, target.id);
      let recvBalance = parseFloat(recvRow?.value || '0') + amount;
      if (recvConn) {
        const mr2 = await mirrorDelta(recvConn, amount, 'Clincoo: ' + titleIn, txIdIn);
        if (mr2.ok) recvBalance = mr2.balance;
      }

      // Update saldo kedua pihak (hanya yang LOKAL — pengguna terhubung ClincooPay dikelola web Wallet)
      if (!senderConn) {
        await db.prepare('INSERT INTO wallet_balance (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
          .bind(senderBalKey, String(newBalance)).run();
      }
      if (!recvConn) {
        await db.prepare('INSERT INTO wallet_balance (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
          .bind(recvBalKey, String(recvBalance)).run();
      }

      // Notifikasi in-app kedua pihak
      try {
        await notifyEvent(db, user, {
          source: 'Dompet', type: 'wallet',
          message: 'Kirim ' + formatIDR(amount) + ' ke ' + targetLabel + ' berhasil. Saldo sekarang ' + formatIDR(newBalance) + '.',
          link: 'https://muzawwied.github.io/Clincoo./akun/dompet/'
        });
      } catch (e) {}
      try {
        await notifyEvent(db, target, {
          source: 'Dompet', type: 'wallet',
          message: 'Anda menerima ' + formatIDR(amount) + ' dari ' + senderLabel + '. Saldo sekarang ' + formatIDR(recvBalance) + '.',
          link: 'https://muzawwied.github.io/Clincoo./akun/dompet/'
        });
      } catch (e) {}

      // Email konfirmasi ke penerima
      if (target && target.email) {
        try {
          await sendEmail(env, {
            toEmail: target.email, toName: target.name || '',
            subject: 'Anda Menerima Saldo Clincoo — ' + formatIDR(amount),
            html: emailTemplate(
              'Saldo Diterima',
              target.name || '',
              'Anda baru saja menerima saldo dari pengguna Clincoo lain. Berikut rinciannya:',
              [
                ['Pengirim', senderLabel],
                ['Jumlah', formatIDR(amount)],
                ['Saldo Saat Ini', formatIDR(recvBalance)],
                ['ID Transaksi', txIdIn]
              ],
              'Lihat Riwayat Dompet',
              'https://muzawwied.github.io/Clincoo./akun/dompet/',
              'Rincian lengkap transaksi dapat dilihat di halaman Dompet pada akun Clincoo Anda.'
            )
          });
        } catch (e) {}
      }

      // Catat aktivitas kedua pihak
      try { await db.prepare('INSERT INTO activity_log (action, details, user_id) VALUES (?, ?, ?)').bind('wallet_transfer', titleOut + ' (' + formatIDR(amount) + ')', uid).run(); } catch (e) {}
      try { await db.prepare('INSERT INTO activity_log (action, details, user_id) VALUES (?, ?, ?)').bind('wallet_transfer', titleIn + ' (' + formatIDR(amount) + ')', target.id).run(); } catch (e) {}

      return j({ success: true, balance: newBalance, to: targetLabel, tx_id: txIdOut });
    }

    if (action === 'set_balance') {
      const balance = parseFloat(body.balance || 0);
      const conn0 = await getCpConnection(db, uid);
      if (conn0) {
        const live = await mirroredBalance(conn0);
        const mr = await mirrorDelta(conn0, Math.round(balance - (live || 0)), 'Clincoo: set saldo', 'CP-SET-' + Date.now());
        if (!mr.ok) return j({ error: mr.error }, 502);
        return j({ success: true, balance: mr.balance, mirrored: true });
      }
      await db.prepare('INSERT INTO wallet_balance (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .bind(balKey, String(balance)).run();
      return j({ success: true, balance });
    }

    if (action === 'clear_transactions') {
      await rowScope(db, 'wallet_transactions', user);
      await db.prepare('DELETE FROM wallet_transactions WHERE user_id = ?').bind(uid).run();
      await db.prepare('INSERT INTO wallet_balance (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .bind(balKey, '0').run();
      return j({ success: true, balance: 0 });
    }

    return j({ error: 'Unknown action' }, 400);
  } catch (err) {
    return j({ error: err.message }, 500);
  }
}

// DELETE /api/wallet?id=... — hapus satu transaksi; tanpa id — hapus semua (milik user)
export async function onRequestDelete({ request, env }) {
  const db = env.DB;
  if (!db) return j({ error: 'D1 not bound' }, 500);
  try {
    const url = new URL(request.url);
    const id = url.searchParams.get('id');
    const user = await currentUser(env, request);
    const balKey = await scopedKey(db, 'wallet_balance', user, 'balance');
    const uid = user ? user.id : null;

    // Hapus transaksi wajib login — mencegah penghapusan data akun lain
    if (!uid) return j({ error: 'Login diperlukan', need_login: true }, 401);
    await rowScope(db, 'wallet_transactions', user);

    if (id) {
      const tx = await db.prepare('SELECT * FROM wallet_transactions WHERE id = ? AND user_id = ?').bind(id, uid).first();
      if (tx) {
        const balRow = await db.prepare('SELECT value FROM wallet_balance WHERE key = ?').bind(balKey).first();
        let balance = parseFloat(balRow?.value || '0');
        if (tx.type === 'in') balance -= parseFloat(tx.amount);
        else if (tx.type === 'out') balance += parseFloat(tx.amount);
        if (balance < 0) balance = 0;

        await db.prepare('DELETE FROM wallet_transactions WHERE id = ? AND user_id = ?').bind(id, uid).run();
        await db.prepare('INSERT INTO wallet_balance (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
          .bind(balKey, String(balance)).run();
        return j({ success: true, balance });
      }
      const cur = await db.prepare('SELECT value FROM wallet_balance WHERE key = ?').bind(balKey).first();
      return j({ success: true, balance: parseFloat(cur?.value || '0') });
    }

    if (uid) await db.prepare('DELETE FROM wallet_transactions WHERE user_id = ?').bind(uid).run();
    else await db.prepare('DELETE FROM wallet_transactions').run();
    await db.prepare('INSERT INTO wallet_balance (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .bind(balKey, '0').run();
    return j({ success: true, balance: 0 });
  } catch (err) {
    return j({ error: err.message }, 500);
  }
}
