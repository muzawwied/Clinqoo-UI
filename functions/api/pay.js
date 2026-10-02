// ClincooPay — Clincoo sebagai payment gateway.
// Clincoo menerbitkan kredensial ClincooPay sendiri per proyek (account_id + secret + pay_key).
// Saat pembeli membayar, Clincoo-lah yang memanggil provider QRIS di belakang layar
// memakai kredensial gateway (env: PAY_PROVIDER_ACCOUNT, PAY_PROVIDER_SECRET, PAY_CALLBACK_SECRET).
// User TIDAK pernah tahu/memasukkan kredensial provider.
//
// POST {action:'activate', project_id}                    → aktifkan + terbitkan kredensial  [auth]
// GET  ?action=config&project_id=...                      → status, pay key, saldo            [auth]
// POST {action:'withdraw', project_id, amount}            → permintaan tarik saldo            [auth]
// POST {action:'transactions', project_id}               → log transaksi                    [auth]
// POST {action:'withdrawals', project_id}                → log penarikan                    [auth]
// POST {action:'create', key, amount, description}       → buat transaksi QRIS              [publik via pay_key]
// GET  ?action=status&key=...&order_id=...               → cek status transaksi              [publik via pay_key]
// POST {action:'callback', ...}                          → notifikasi dari provider → forward ke webhook proyek [callback secret]

import { guardProject } from './user-scope.js';

// Semua aksi ClincooPay wajib login + project_id — tidak ada jalur legacy global.
async function guardPay(env, request, projectId) {
  if (!projectId) return json({ error: 'unauthorized', need_login: true }, 401);
  return await guardProject(env, request, projectId);
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

const BQ_API = 'https://api.buatqris.site';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...CORS } });
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

async function ensureTables(db) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS pay_creds (
    project_id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    secret TEXT NOT NULL,
    pay_key TEXT NOT NULL,
    qris_method TEXT DEFAULT 'qris_two',
    fee_target TEXT DEFAULT 'merchant',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )`).run();
  await db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_pay_creds_key ON pay_creds(pay_key)`).run();
  await db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_pay_creds_account ON pay_creds(account_id)`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS pay_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL,
    pay_key TEXT NOT NULL,
    order_id TEXT NOT NULL,
    trx_ref TEXT DEFAULT '',
    amount INTEGER NOT NULL,
    description TEXT DEFAULT '',
    status TEXT DEFAULT 'pending',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )`).run();
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_pay_tx_order ON pay_transactions(pay_key, order_id)`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS pay_withdrawals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL,
    amount INTEGER NOT NULL,
    status TEXT DEFAULT 'pending',
    note TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )`).run();
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_pay_wd_project ON pay_withdrawals(project_id)`).run();
}

function randKey(n) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  for (let i = 0; i < n; i++) s += chars[bytes[i] % chars.length];
  return s;
}

function genOrderId() {
  return 'PAY' + Date.now().toString(36).toUpperCase() + randKey(4).toUpperCase();
}

// ---- Saldo: total masuk (paid) - penarikan (pending + done) ----
async function calcBalance(db, projectId) {
  const paid = await db.prepare(`SELECT COALESCE(SUM(amount),0) AS total FROM pay_transactions WHERE project_id = ? AND status = 'paid'`).bind(projectId).first();
  const wd = await db.prepare(`SELECT COALESCE(SUM(amount),0) AS total FROM pay_withdrawals WHERE project_id = ? AND status != 'rejected'`).bind(projectId).first();
  const totalPaid = (paid && paid.total) || 0;
  const totalWithdrawn = (wd && wd.total) || 0;
  return { total_paid: totalPaid, total_withdrawn: totalWithdrawn, available: Math.max(0, totalPaid - totalWithdrawn) };
}

// ---- Panggilan provider (hanya Clincoo yang tahu) ----
async function providerCall(env, params) {
  const account = env.PAY_PROVIDER_ACCOUNT;
  const secret = env.PAY_PROVIDER_SECRET;
  if (!account || !secret) return { success: false, error: 'gateway_not_ready' };
  const body = new URLSearchParams({ account_id: account, secret_token: secret, ...params });
  try {
    const r = await fetch(BQ_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body
    });
    const text = await r.text();
    try { return JSON.parse(text); } catch (e) { return { success: false, message: 'Respon tidak valid dari server pembayaran' }; }
  } catch (e) {
    return { success: false, message: 'Tidak dapat terhubung ke server pembayaran' };
  }
}

function pickTrxRef(d) {
  return String(d.order_id || d.trx_id || d.transaction_id || d.id || d.invoice || d.reference || '');
}

function pickStatus(d) {
  const s = (d.status || (d.data && d.data.status) || d.transaction_status || '').toLowerCase();
  if (['success', 'paid', 'berhasil', 'settlement', 'completed', 'lunas'].includes(s)) return 'paid';
  if (['expired', 'expire', 'gagal', 'failed', 'cancel', 'cancelled', 'batal'].includes(s)) return 'expired';
  return 'pending';
}

// ---- GET ----
export async function onRequestGet({ request, env }) {
  const db = env.DB;
  if (!db) return json({ error: 'D1 not bound' }, 500);
  await ensureTables(db);
  const url = new URL(request.url);
  const action = url.searchParams.get('action') || '';
  const projectId = url.searchParams.get('project_id') || '';

  if (action === 'config') {
    const deny = await guardPay(env, request, projectId);
    if (deny) return deny;
    const row = await db.prepare('SELECT * FROM pay_creds WHERE project_id = ?').bind(projectId).first();
    const bal = await calcBalance(db, projectId);
    if (!row) return json({ success: true, active: false, gateway_ready: !!(env.PAY_PROVIDER_ACCOUNT && env.PAY_PROVIDER_SECRET), ...bal });
    return json({
      success: true,
      active: true,
      gateway_ready: !!(env.PAY_PROVIDER_ACCOUNT && env.PAY_PROVIDER_SECRET),
      account_id: row.account_id,
      pay_key: row.pay_key,
      ...bal
    });
  }

  if (action === 'status') {
    const key = url.searchParams.get('key') || '';
    const orderId = url.searchParams.get('order_id') || '';
    if (!key || !orderId) return json({ error: 'key dan order_id wajib diisi' }, 400);
    const tx = await db.prepare('SELECT * FROM pay_transactions WHERE pay_key = ? AND order_id = ?').bind(key, orderId).first();
    if (!tx) return json({ error: 'transaksi tidak ditemukan' }, 404);
    if (tx.status === 'paid') return json({ success: true, status: 'paid', amount: tx.amount });
    const d = await providerCall(env, {
      action: 'api_check_status',
      order_id: tx.trx_ref || tx.order_id,
      trx_id: tx.trx_ref,
      amount: String(tx.amount)
    });
    if (d.error === 'gateway_not_ready') return json({ success: true, status: tx.status, amount: tx.amount });
    const st = pickStatus(d);
    if (st !== tx.status) {
      await db.prepare('UPDATE pay_transactions SET status = ?, updated_at = datetime(\'now\') WHERE id = ?').bind(st, tx.id).run();
    }
    return json({ success: true, status: st, amount: tx.amount, message: d.message || '' });
  }

  return json({ error: 'action tidak dikenal' }, 400);
}

// ---- POST ----
export async function onRequestPost({ request, env }) {
  const db = env.DB;
  if (!db) return json({ error: 'D1 not bound' }, 500);
  await ensureTables(db);

  let body = {};
  try { body = await request.json(); } catch (e) { return json({ error: 'body JSON tidak valid' }, 400); }
  const action = body.action || '';
  const projectId = body.project_id || '';

  // ===== Aktifkan ClincooPay + terbitkan kredensial (auth) =====
  if (action === 'activate') {
    const deny = await guardPay(env, request, projectId);
    if (deny) return deny;
    const existing = await db.prepare('SELECT * FROM pay_creds WHERE project_id = ?').bind(projectId).first();
    if (existing) return json({ success: true, account_id: existing.account_id, pay_key: existing.pay_key });
    let accountId, secret, payKey;
    for (let i = 0; i < 5; i++) {
      accountId = 'CP' + randKey(10).toUpperCase();
      secret = 'cps_' + randKey(32);
      payKey = 'pk_' + randKey(28);
      try {
        await db.prepare(`INSERT INTO pay_creds (project_id, account_id, secret, pay_key) VALUES (?, ?, ?, ?)`)
          .bind(projectId, accountId, secret, payKey).run();
        return json({ success: true, account_id: accountId, pay_key: payKey });
      } catch (e) { /* unik bentrok — ulangi */ }
    }
    return json({ error: 'Gagal menerbitkan kredensial, coba lagi.' }, 500);
  }

  // ===== Saldo ringkas (auth) =====
  if (action === 'summary') {
    const deny = await guardPay(env, request, projectId);
    if (deny) return deny;
    const bal = await calcBalance(db, projectId);
    return json({ success: true, ...bal, gateway_ready: !!(env.PAY_PROVIDER_ACCOUNT && env.PAY_PROVIDER_SECRET) });
  }

  // ===== Tarik saldo → permintaan penarikan (auth) =====
  if (action === 'withdraw') {
    const deny = await guardPay(env, request, projectId);
    if (deny) return deny;
    const amount = Math.floor(Number(body.amount || 0));
    if (!amount || amount < 10000) return json({ success: false, message: 'Penarikan minimal Rp 10.000.' }, 400);
    const bal = await calcBalance(db, projectId);
    if (amount > bal.available) return json({ success: false, message: 'Saldo tersedia tidak cukup.' }, 400);
    await db.prepare(`INSERT INTO pay_withdrawals (project_id, amount, status) VALUES (?, ?, 'pending')`).bind(projectId, amount).run();
    return json({ success: true, message: 'Permintaan penarikan dikirim — tim Clincoo akan memprosesnya.' });
  }

  // ===== Log transaksi (auth) =====
  if (action === 'transactions') {
    const deny = await guardPay(env, request, projectId);
    if (deny) return deny;
    const rows = await db.prepare('SELECT order_id, amount, description, status, created_at FROM pay_transactions WHERE project_id = ? ORDER BY id DESC LIMIT 25').bind(projectId).all();
    return json({ success: true, transactions: rows.results || [] });
  }

  // ===== Log penarikan (auth) =====
  if (action === 'withdrawals') {
    const deny = await guardPay(env, request, projectId);
    if (deny) return deny;
    const rows = await db.prepare('SELECT id, amount, status, note, created_at FROM pay_withdrawals WHERE project_id = ? ORDER BY id DESC LIMIT 25').bind(projectId).all();
    return json({ success: true, withdrawals: rows.results || [] });
  }

  // ===== Buat transaksi (PUBLIK via pay_key — dipanggil situs deploy user) =====
  if (action === 'create') {
    const key = String(body.key || '').trim();
    const amount = Math.floor(Number(body.amount || 0));
    const description = String(body.description || '').slice(0, 100);
    if (!key) return json({ error: 'pay key wajib diisi' }, 400);
    if (!amount || amount < 1000 || amount > 100000000) return json({ error: 'Nominal harus Rp 1.000 – Rp 100.000.000' }, 400);
    const creds = await db.prepare('SELECT * FROM pay_creds WHERE pay_key = ?').bind(key).first();
    if (!creds) return json({ error: 'pay key tidak dikenal' }, 404);
    if (!env.PAY_PROVIDER_ACCOUNT || !env.PAY_PROVIDER_SECRET) {
      return json({ success: false, error: 'gateway_not_ready', message: 'Pembayaran QRIS ClincooPay sedang dalam proses aktivasi. Hubungi tim Clincoo.' }, 503);
    }

    const orderId = genOrderId();
    const d = await providerCall(env, {
      action: 'api_create_qris',
      amount: String(amount),
      description: description || 'Pembayaran',
      qris_method: creds.qris_method || 'qris_two',
      fee_target: creds.fee_target || 'merchant'
    });
    const trxRef = pickTrxRef(d);
    await db.prepare('INSERT INTO pay_transactions (project_id, pay_key, order_id, trx_ref, amount, description, status) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(creds.project_id, key, orderId, trxRef, amount, description, d && d.success ? 'pending' : 'failed').run();
    if (!d || !d.success) {
      return json({ success: false, message: (d && d.message) || 'Gagal membuat QRIS ClincooPay.' }, 502);
    }
    return json({
      success: true,
      order_id: orderId,
      amount: amount,
      qr_image: d.qr_image || d.qr_string || d.qris_string || d.qr_url || d.qr_link || '',
      payment_url: d.payment_url || d.pay_url || d.link || '',
      total_payment: d.total_amount || d.amount || d.jumlah || amount
    });
  }

  // ===== Callback dari provider → perbarui status + forward ke webhook proyek =====
  if (action === 'callback') {
    if (env.PAY_CALLBACK_SECRET) {
      const tok = request.headers.get('X-Callback-Token') || body.callback_token || '';
      if (tok !== env.PAY_CALLBACK_SECRET) return json({ error: 'unauthorized' }, 401);
    }
    const ref = String(body.order_id || body.trx_id || body.transaction_id || body.invoice || body.reference || '').trim();
    if (!ref) return json({ error: 'order_id/trx_id wajib diisi' }, 400);
    let tx = await db.prepare('SELECT * FROM pay_transactions WHERE trx_ref = ?').bind(ref).first();
    if (!tx) tx = await db.prepare('SELECT * FROM pay_transactions WHERE order_id = ?').bind(ref).first();
    if (!tx) return json({ error: 'transaksi tidak ditemukan' }, 404);
    const st = pickStatus(body);
    if (st !== tx.status) {
      await db.prepare('UPDATE pay_transactions SET status = ?, updated_at = datetime(\'now\') WHERE id = ?').bind(st, tx.id).run();
    }
    // forward ke webhook pembayaran milik proyek (dikonfigurasi di halaman Integrasi & Webhook)
    try {
      const row = await db.prepare(`SELECT value FROM project_settings WHERE project_id = ? AND key = 'webhook_settings'`).bind(tx.project_id).first();
      let url = '';
      if (row && row.value) { try { url = (JSON.parse(row.value) || {}).payWebhookUrl || ''; } catch (e) {} }
      if (url && st === 'paid') {
        await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ event: 'payment.paid', order_id: tx.order_id, amount: tx.amount, description: tx.description, status: st, paid_at: new Date().toISOString() })
        }).catch(() => {});
      }
    } catch (e) {}
    return json({ success: true, status: st });
  }

  return json({ error: 'action tidak dikenal' }, 400);
}
