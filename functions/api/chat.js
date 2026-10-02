// Cloudflare Pages Functions — PROXY /api/chat dengan KUOTA AI PER-USER
// Melindungi kredit Gemini agar tidak dibakar habis oleh pengguna gratis:
//   - Auth ganda: token lokal (D1 proxy) ATAU token be2 (divalidasi ke be2 /api/auth/me)
//   - Kuota harian per user di D1 lokal (tabel ai_quota, reset otomatis tiap hari)
//   - Hemat kredit: riwayat chat dipotong hanya MAX_HISTORY pesan terakhir
//   - Hop tool lanjutan (save_user_message === false) tidak dihitung kuota
//   - Aksi manajemen (delete_session) diteruskan tanpa kuota
// Request asli diteruskan ke backend utama be2 dengan token user yang sama.
import { initTables as initAuthTables, getUserByToken, getToken } from './auth/shared.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};
const BE2_CHAT = 'https://clincoo-be2.pages.dev/api/chat';
const BE2_ME = 'https://clincoo-be2.pages.dev/api/auth/me';
const ADMIN_EMAILS = new Set(['devconium@gmail.com', 'muzawwied@gmail.com']);
const DAILY_LIMIT = 25;          // pesan/hari per user gratis
const ADMIN_DAILY_LIMIT = 500;  // pesan/hari akun pemilik
const MAX_HISTORY = 12;         // hanya kirim N pesan terakhir ke Gemini (hemat token)

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

async function resolveUser(env, request) {
  const token = getToken(request);
  if (!token) return null;
  try {
    await initAuthTables(env.DB);
    const u = await getUserByToken(env.DB, token);
    if (u) return { key: 'local:' + u.id, email: String(u.email || '').toLowerCase(), token };
  } catch (e) { /* coba be2 */ }
  try {
    const r = await fetch(BE2_ME, { headers: { Authorization: 'Bearer ' + token } });
    if (r.ok) {
      const d = await r.json();
      if (d && d.authenticated && d.user) {
        return { key: 'be2:' + (d.user.id || d.user.email), email: String(d.user.email || '').toLowerCase(), token };
      }
    }
  } catch (e) { /* fallthrough */ }
  return null;
}

async function quotaState(env, user) {
  const isAdmin = ADMIN_EMAILS.has(user.email);
  const limit = isAdmin ? ADMIN_DAILY_LIMIT : DAILY_LIMIT;
  const day = new Date().toISOString().slice(0, 10);
  try {
    await env.DB.prepare(
      'CREATE TABLE IF NOT EXISTS ai_quota (user_key TEXT, day TEXT, count INTEGER, PRIMARY KEY (user_key, day))'
    ).run();
    const row = await env.DB.prepare('SELECT count FROM ai_quota WHERE user_key = ? AND day = ?').bind(user.key, day).first();
    return { count: row ? row.count : 0, limit, day, isAdmin };
  } catch (e) {
    return { count: 0, limit, day, isAdmin };
  }
}

function quotaExceeded(limit) {
  return new Response(JSON.stringify({
    quota_exhausted: true,
    error: 'Kuota AI harian Anda sudah habis (' + limit + ' pesan/hari). Kuota reset otomatis tiap hari — silakan coba lagi besok.'
  }), { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': '3600', ...CORS } });
}

async function forward(rawBody, token) {
  try {
    const r = await fetch(BE2_CHAT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: rawBody
    });
    const text = await r.text();
    return new Response(text, { status: r.status, headers: { 'Content-Type': 'application/json', ...CORS } });
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Backend AI tidak terjangkau: ' + e.message }), {
      status: 502, headers: { 'Content-Type': 'application/json', ...CORS }
    });
  }
}

export async function onRequestPost({ request, env }) {
  try {
    const user = await resolveUser(env, request);
    if (!user) {
      return new Response(JSON.stringify({ error: 'Login diperlukan', need_login: true }), {
        status: 401, headers: { 'Content-Type': 'application/json', ...CORS }
      });
    }

    const raw = await request.text();
    if (raw.length > 2_000_000) {
      return new Response(JSON.stringify({ error: 'Payload terlalu besar (maks 2MB).' }), {
        status: 413, headers: { 'Content-Type': 'application/json', ...CORS }
      });
    }
    let body;
    try { body = JSON.parse(raw); } catch (e) {
      return new Response(JSON.stringify({ error: 'Body JSON tidak valid' }), {
        status: 400, headers: { 'Content-Type': 'application/json', ...CORS }
      });
    }

    // Aksi manajemen sesi tidak memakai AI → teruskan tanpa kuota
    if (body.action === 'delete_session') return forward(raw, user.token);

    // Hemat kredit: hanya kirim MAX_HISTORY pesan terakhir sebagai konteks
    if (Array.isArray(body.messages) && body.messages.length > MAX_HISTORY) {
      body.messages = body.messages.slice(-MAX_HISTORY);
    }

    const st = await quotaState(env, user);
    if (st.count >= st.limit) return quotaExceeded(st.limit);

    // Hop pertama (save_user_message !== false) dihitung 1 kuota per pesan;
    // hop tool lanjutan oleh AI tidak memotong kuota user.
    if (body.save_user_message !== false) {
      try {
        await env.DB.prepare(
          'INSERT INTO ai_quota (user_key, day, count) VALUES (?, ?, 1) ON CONFLICT(user_key, day) DO UPDATE SET count = count + 1'
        ).bind(user.key, st.day).run();
      } catch (e) { /* jangan gagalkan chat karena counter error */ }
    }

    return forward(JSON.stringify(body), user.token);
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Gagal memproses: ' + e.message }), {
      status: 500, headers: { 'Content-Type': 'application/json', ...CORS }
    });
  }
}
