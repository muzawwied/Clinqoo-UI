// Cloudflare Pages Functions — Manajemen token MCP per proyek (dipanggil halaman Server MCP)
// POST   /api/mcp-token { project_id }        -> buat/ganti token MCP (butuh login Clincoo)
// GET    /api/mcp-token?project_id=xxx       -> status + token (butuh login)
// DELETE /api/mcp-token?project_id=xxx        -> cabut akses (butuh login)
// Token dipakai platform AI lain sebagai Bearer untuk endpoint /api/mcp.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

const J = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...CORS } });

const BE2 = 'https://clincoo-be2.pages.dev/api';

async function be2Json(path, token, init = {}) {
  const res = await fetch(BE2 + path, { ...init, headers: { ...(init.headers || {}), Authorization: 'Bearer ' + token } });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

async function ensureTables(env) {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS mcp_tokens (
      project_id TEXT PRIMARY KEY,
      token TEXT NOT NULL,
      be2_token TEXT NOT NULL,
      scopes TEXT DEFAULT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    )`
  ).run();
  try {
    await env.DB.prepare('ALTER TABLE mcp_tokens ADD COLUMN scopes TEXT DEFAULT NULL').run();
  } catch (e) { /* kolom sudah ada */ }
}

// Guard: wajib token be2 milik akun yang memiliki proyek ini.
async function guardOwner(request, env, projectId) {
  if (!projectId) return { res: J({ error: 'Parameter project_id wajib' }, 400) };
  const h = request.headers.get('Authorization') || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  if (!m) return { res: J({ error: 'Login diperlukan' }, 401) };
  const tok = m[1].trim();
  const me = await be2Json('/auth/me', tok);
  if (!me.ok || !me.data.authenticated) return { res: J({ error: 'Token tidak valid' }, 401) };
  const pj = await be2Json('/projects', tok);
  const owned = (pj.data.projects || []).some(p => String(p.id) === String(projectId));
  if (!owned) return { res: J({ error: 'Proyek tidak ditemukan atau bukan milik akun ini' }, 403) };
  return { token: tok };
}

function newMcpToken() {
  const b = new Uint8Array(24);
  crypto.getRandomValues(b);
  return Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

function normalizeScopes(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  return {
    read: r.read !== false,          // default: boleh lihat & baca file
    write: r.write === true,        // default: TIDAK boleh menulis
    delete: r.delete === true       // default: TIDAK boleh menghapus
  };
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const projectId = url.searchParams.get('project_id') || '';
  const g = await guardOwner(request, env, projectId);
  if (g.res) return g.res;
  await ensureTables(env);
  const row = await env.DB.prepare('SELECT token, scopes, created_at FROM mcp_tokens WHERE project_id = ?').bind(projectId).first();
  let scopes = null;
  try { scopes = row && row.scopes ? JSON.parse(row.scopes) : null; } catch (e) {}
  return J({
    active: !!row,
    token: row ? row.token : null,
    scopes: scopes || normalizeScopes(null),
    created_at: row ? row.created_at : null,
    url: 'https://app.clincoo.buzz/api/mcp?project_id=' + encodeURIComponent(projectId)
  });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  let body = {};
  try { body = await request.json(); } catch (e) {}
  const projectId = body.project_id || new URL(request.url).searchParams.get('project_id') || '';
  const g = await guardOwner(request, env, projectId);
  if (g.res) return g.res;
  await ensureTables(env);
  const token = newMcpToken();
  // Izin akses default (least privilege): hanya baca. Halaman Server MCP bisa mengubahnya per proyek.
  const scopes = normalizeScopes(body.scopes);
  await env.DB.prepare(
    `INSERT INTO mcp_tokens (project_id, token, be2_token, scopes, created_at) VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(project_id) DO UPDATE SET token = excluded.token, be2_token = excluded.be2_token, scopes = excluded.scopes, created_at = excluded.created_at`
  ).bind(projectId, token, g.token, JSON.stringify(scopes)).run();
  return J({
    ok: true,
    token,
    scopes,
    url: 'https://app.clincoo.buzz/api/mcp?project_id=' + encodeURIComponent(projectId)
  });
}

// PATCH /api/mcp-token { project_id, scopes } -> ubah izin akses tanpa mengganti token
export async function onRequestPatch(context) {
  const { request, env } = context;
  let body = {};
  try { body = await request.json(); } catch (e) {}
  const projectId = body.project_id || '';
  const g = await guardOwner(request, env, projectId);
  if (g.res) return g.res;
  await ensureTables(env);
  const scopes = normalizeScopes(body.scopes);
  const r = await env.DB.prepare('UPDATE mcp_tokens SET scopes = ? WHERE project_id = ?').bind(JSON.stringify(scopes), projectId).run();
  if (!r || !r.meta || !r.meta.changes) return J({ error: 'Token MCP belum aktif untuk proyek ini — aktifkan dulu di halaman Server MCP' }, 404);
  return J({ ok: true, scopes });
}

export async function onRequestDelete(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const projectId = url.searchParams.get('project_id') || '';
  const g = await guardOwner(request, env, projectId);
  if (g.res) return g.res;
  await ensureTables(env);
  await env.DB.prepare('DELETE FROM mcp_tokens WHERE project_id = ?').bind(projectId).run();
  return J({ ok: true });
}
