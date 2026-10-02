// Pembayaran QRIS per-proyek via BuatQris (https://buatqris.site).
// Duit masuk LANGSUNG ke akun BuatQris milik user masing-masing — Clincoo
// hanya menjembatani pembuatan QR & cek status (tidak memegang dana).
// Kredensial disimpan di tabel pay_creds (bukan project_settings) supaya
// secret token tidak pernah bocor lewat endpoint settings lain.
//
// POST {action:'save_config', project_id, account_id, secret_token, umkm_name, qris_method, fee_target}  [auth]
// GET  ?action=config&project_id=...          → status kredensial (disamarkan) + pay_key  [auth]
// POST {action:'test', project_id}            → uji kredensial dgn QR Rp 1.000           [auth]
// POST {action:'create', key, amount, description}  → buat transaksi QRIS               [publik, via pay_key]
// GET  ?action=status&key=...&order_id=...   → cek status transaksi                    [publik, via pay_key]
// POST {action:'transactions', project_id}   → riwayat transaksi terakhir              [auth]

import { currentUser } from './user-scope.js';
import { guardProject } from './user-scope.js';

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
    secret_token TEXT NOT NULL,
    umkm_name TEXT DEFAULT '',
    qris_method TEXT DEFAULT 'qris_two',
    fee_target TEXT DEFAULT 'merchant',
    pay_key TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )`).run();
  await db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_pay_creds_key ON pay_creds(pay_key)`).run();
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

function maskAccount(accountId) {
  const a = String(accountId || '');
  if (a.length <= 4) return '••••';
  return a.slice(0, 2) + '••••' + a.slice(-2);
}

// ---- Panggilan upstream BuatQris ----
async function bqCall(params) {
  const body = new URLSearchParams(params);
  try {
    const r = await fetch(BQ_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body
    });
    const text = await r.text();
    try { return JSON.parse(text); } catch (e) { return { success: false, message: 'Respon tidak valid dari penyedia pembayaran' }; }
  } catch (e) {
    return { success: false, message: 'Tidak dapat terhubung ke penyedia pembayaran' };
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
    const deny = await guardProject(env, request, projectId);
    if (deny) return deny;
    const row = await db.prepare('SELECT * FROM pay_creds WHERE project_id = ?').bind(projectId).first();
    if (!row) return json({ success: true, configured: false });
    return json({
      success: true,
      configured: true,
      account_id_masked: maskAccount(row.account_id),
      umkm_name: row.umkm_name || '',
      qris_method: row.qris_method || 'qris_two',
      fee_target: row.fee_target || 'merchant',
      pay_key: row.pay_key
    });
  }

  if (action === 'status') {
    const key = url.searchParams.get('key') || '';
    const orderId = url.searchParams.get('order_id') || '';
    if (!key || !orderId) return json({ error: 'key dan order_id wajib diisi' }, 400);
    const tx = await db.prepare('SELECT * FROM pay_transactions WHERE pay_key = ? AND order_id = ?').bind(key, orderId).first();
    if (!tx) return json({ error: 'transaksi tidak ditemukan' }, 404);
    if (tx.status === 'paid') return json({ success: true, status: 'paid', amount: tx.amount });
    const creds = await db.prepare('SELECT * FROM pay_creds WHERE pay_key = ?').bind(key).first();
    if (!creds) return json({ success: true, status: tx.status, amount: tx.amount });
    const d = await bqCall({
      action: 'api_check_status',
      account_id: creds.account_id,
      secret_token: creds.secret_token,
      order_id: tx.trx_ref || tx.order_id,
      trx_id: tx.trx_ref,
      amount: String(tx.amount)
    });
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

  // ===== Simpan kredensial (auth + pemilik proyek) =====
  if (action === 'save_config') {
    const deny = await guardProject(env, request, projectId);
    if (deny) return deny;
    const accountId = String(body.account_id || '').trim();
    const secretToken = String(body.secret_token || '').trim();
    const umkmName = String(body.umkm_name || '').trim().slice(0, 60);
    const qrisMethod = ['qris_one', 'qris_two', 'qris_three', 'qris_four'].includes(body.qris_method) ? body.qris_method : 'qris_two';
    const feeTarget = ['merchant', 'customer'].includes(body.fee_target) ? body.fee_target : 'merchant';
    if (!accountId || !secretToken) return json({ error: 'account_id dan secret_token wajib diisi' }, 400);

    const existing = await db.prepare('SELECT pay_key FROM pay_creds WHERE project_id = ?').bind(projectId).first();
    const payKey = existing?.pay_key || ('pk_' + randKey(28));
    // hapus mapping pay_key lama bila berganti proyek (pay_key unik)
    if (existing) {
      await db.prepare('DELETE FROM pay_creds WHERE pay_key = ? AND project_id != ?').bind(payKey, projectId).run();
    }
    await db.prepare(`INSERT INTO pay_creds (project_id, account_id, secret_token, umkm_name, qris_method, fee_target, pay_key, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(project_id) DO UPDATE SET
        account_id = excluded.account_id, secret_token = excluded.secret_token,
        umkm_name = excluded.umkm_name, qris_method = excluded.qris_method,
        fee_target = excluded.fee_target, pay_key = excluded.pay_key,
        updated_at = datetime('now')`).bind(projectId, accountId, secretToken, umkmName, qrisMethod, feeTarget, payKey).run();
    return json({ success: true, pay_key: payKey, account_id_masked: maskAccount(accountId) });
  }

  // ===== Uji kredensial (auth): bikin QR Rp 1.000, kalau sukses kredensial valid =====
  if (action === 'test') {
    const deny = await guardProject(env, request, projectId);
    if (deny) return deny;
    const creds = await db.prepare('SELECT * FROM pay_creds WHERE project_id = ?').bind(projectId).first();
    if (!creds) return json({ success: false, error: 'payment_not_configured', message: 'Simpan kredensial pembayaran dulu.' }, 400);
    const d = await bqCall({
      action: 'api_create_qris',
      account_id: creds.account_id,
      secret_token: creds.secret_token,
      amount: '1000',
      description: 'Uji koneksi Clincoo',
      qris_method: creds.qris_method || 'qris_two'
    });
    if (d && d.success) return json({ success: true, message: 'Kredensial valid — QR uji berhasil dibuat.' });
    return json({ success: false, message: (d && d.message) || 'Kredensial ditolak penyedia pembayaran.' });
  }

  // ===== Buat transaksi (PUBLIK via pay_key — dipanggil situs yang di-deploy) =====
  if (action === 'create') {
    const key = String(body.key || '').trim();
    const amount = Math.floor(Number(body.amount || 0));
    const description = String(body.description || '').slice(0, 100);
    if (!key) return json({ error: 'pay key wajib diisi' }, 400);
    if (!amount || amount < 1000 || amount > 100000000) return json({ error: 'Nominal harus Rp 1.000 – Rp 100.000.000' }, 400);
    const creds = await db.prepare('SELECT * FROM pay_creds WHERE pay_key = ?').bind(key).first();
    if (!creds) return json({ error: 'pay key tidak dikenal' }, 404);

    const orderId = genOrderId();
    const d = await bqCall({
      action: 'api_create_qris',
      account_id: creds.account_id,
      secret_token: creds.secret_token,
      amount: String(amount),
      description: description || 'Pembayaran',
      qris_method: creds.qris_method || 'qris_two',
      fee_target: creds.fee_target || 'merchant',
      umkm_name: creds.umkm_name || ''
    });
    const trxRef = pickTrxRef(d);
    await db.prepare('INSERT INTO pay_transactions (project_id, pay_key, order_id, trx_ref, amount, description, status) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(creds.project_id, key, orderId, trxRef, amount, description, d && d.success ? 'pending' : 'failed').run();
    if (!d || !d.success) {
      return json({ success: false, message: (d && d.message) || 'Gagal membuat QRIS pembayaran.' }, 502);
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

  // ===== Riwayat transaksi (auth) =====
  if (action === 'transactions') {
    const deny = await guardProject(env, request, projectId);
    if (deny) return deny;
    const rows = await db.prepare('SELECT order_id, amount, description, status, created_at FROM pay_transactions WHERE project_id = ? ORDER BY id DESC LIMIT 20').bind(projectId).all();
    return json({ success: true, transactions: rows.results || [] });
  }

  return json({ error: 'action tidak dikenal' }, 400);
}
