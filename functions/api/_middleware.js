// Middleware /api/* — semua endpoint wajib login (Bearer), KECUALI:
//   - /api/auth/*        (login, register, me, oauth akun)
//   - /api/github-oauth* (redirect callback GitHub, tanpa header Bearer)
//   - /api/topup*        (callback Xendit divalidasi sendiri via x-callback-token)
//   - /api/scheduled-tasks (endpoint memvalidasi sendiri: aksi user wajib Bearer, run_due wajib x-cron-secret)
//   - /api/wallet-sync*  (endpoint memvalidasi sendiri: config wajib Bearer; jalur eksternal wajib api_key)
//   - /api/collab*        (GET info undangan publik via token rahasia; POST divalidasi sendiri di collab.js)
//   - /api/chat*          (PROXY kuota AI per-user — validasi sendiri: token lokal atau be2)
//   - preflight OPTIONS  (CORS)
// Respons 401 sama seperti versi production: {"error":"Login diperlukan","need_login":true}
import { initTables as initAuthTables, getUserByToken, getToken } from './auth/shared.js';

const PUBLIC = [/^\/api\/auth(\/|$)/, /^\/api\/github-oauth(\/|$)/, /^\/api\/topup(\/|$)/, /^\/api\/wallet(\/|$)/, /^\/api\/scheduled-tasks(\/|$)/, /^\/api\/wallet-sync(\/|$)/, /^\/api\/collab(\/|$)/, /^\/api\/chat(\/|$)/]; // chat: proxy kuota AI per-user, validasi sendiri (token lokal ATAU be2)

export async function onRequest({ request, env, next }) {
  if (request.method === 'OPTIONS') return next();
  const path = new URL(request.url).pathname;
  for (const re of PUBLIC) if (re.test(path)) return next();
  try {
    if (env.DB) {
      await initAuthTables(env.DB);
      const user = await getUserByToken(env.DB, getToken(request));
      if (user) return next();
    }
  } catch (e) { /* lanjut ke 401 */ }
  return new Response(JSON.stringify({ error: 'Login diperlukan', need_login: true }), {
    status: 401,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
  });
}
