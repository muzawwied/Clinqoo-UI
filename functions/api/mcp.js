// Cloudflare Pages Functions — Server MCP Clincoo (Clincoo SEBAGAI server MCP)
// Endpoint: https://clincoo.pages.dev/api/mcp?project_id=<pid>
// Transport: Streamable HTTP (JSON-RPC 2.0), auth Bearer token MCP per proyek.
// Tools: list_items, read_file, write_file, delete_item, get_project_info
// Data file real-time diambil dari backend utama clincoo-be2 (/api/project-files).

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, Mcp-Session-Id, X-Project-Id',
  'Access-Control-Expose-Headers': 'Mcp-Session-Id'
};

const BE2 = 'https://clincoo-be2.pages.dev/api';
const PROTOCOL_VERSION = '2025-06-18';
const SERVER_INFO = { name: 'clincoo-mcp', version: '1.0.0' };

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

// Validasi request MCP: Bearer token cocok dengan token MCP proyek ini.
async function authMcp(request, env, projectId) {
  if (!projectId) return { res: json({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Parameter project_id wajib' } }, 401) };
  await ensureTables(env);
  const h = request.headers.get('Authorization') || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  const tok = m ? m[1].trim() : '';
  if (!tok) return { res: json({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Header Authorization Bearer wajib diisi (token MCP dari halaman Server MCP Clincoo)' } }, 401) };
  const row = await env.DB.prepare('SELECT token, be2_token, scopes FROM mcp_tokens WHERE project_id = ?').bind(projectId).first();
  if (!row || row.token !== tok) {
    return { res: json({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Token MCP tidak valid atau sudah dicabut untuk proyek ini' } }, 401) };
  }
  let scopes = null;
  try { scopes = row.scopes ? JSON.parse(row.scopes) : null; } catch (e) {}
  if (!scopes) scopes = { read: true, write: false, delete: false };
  return { token: tok, be2Token: row.be2_token, scopes };
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...CORS, ...headers } });
}

function rpcResult(id, result) {
  return json({ jsonrpc: '2.0', id, result });
}
function rpcError(id, code, message) {
  return json({ jsonrpc: '2.0', id, error: { code, message } });
}

// ---- Operasi workspace via be2 (read-modify-write seluruh set file) ----

async function fetchFiles(be2Token, projectId) {
  const r = await be2Json('/project-files?project_id=' + encodeURIComponent(projectId), be2Token);
  if (!r.ok) throw new Error('Gagal mengambil file proyek dari backend (' + r.status + ')');
  return (r.data && r.data.files) || [];
}

async function pushFiles(be2Token, projectId, files) {
  // sinkron total: hapus lalu POST set baru (pola yang sama dipakai frontend chat)
  await fetch(BE2 + '/project-files?project_id=' + encodeURIComponent(projectId), {
    method: 'DELETE', headers: { Authorization: 'Bearer ' + be2Token }
  }).catch(() => {});
  const r = await be2Json('/project-files', be2Token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project_id: projectId, files })
  });
  if (!r.ok) throw new Error('Gagal menyimpan file proyek (' + r.status + ')');
}

function safePath(p) {
  const s = String(p == null ? '' : p).trim().replace(/^\/+/, '');
  if (!s) throw new Error('Parameter path wajib');
  if (s.includes('..')) throw new Error('Path tidak boleh mengandung ".."');
  return s;
}

// Pemetaan tool -> izin yang dibutuhkan (null = selalu diizinkan)
function toolScope(name) {
  return { list_items: null, read_file: 'read', write_file: 'write', delete_item: 'delete', get_project_info: null }[name] !== undefined
    ? { list_items: null, read_file: 'read', write_file: 'write', delete_item: 'delete', get_project_info: null }[name]
    : 'unknown';
}

function allowedTools(scopes) {
  return TOOLS.filter(t => {
    const need = toolScope(t.name);
    return need === null || scopes[need] !== false;
  });
}

const TOOLS = [
  {
    name: 'list_items',
    description: 'Daftar file & folder workspace proyek Clincoo. Optional: folder (mis. "css" atau "" untuk root).',
    inputSchema: {
      type: 'object',
      properties: {
        folder: { type: 'string', description: 'Nama folder (kosongkan untuk seluruh workspace)' }
      },
      required: []
    }
  },
  {
    name: 'read_file',
    description: 'Baca isi satu file di workspace proyek secara real-time.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path file relatif, mis. "index.html" atau "css/style.css"' }
      },
      required: ['path']
    }
  },
  {
    name: 'write_file',
    description: 'Tulis/ubah isi file di workspace proyek secara real-time. File baru otomatis dibuat.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path file relatif, mis. "index.html"' },
        content: { type: 'string', description: 'Isi lengkap file (full overwrite)' }
      },
      required: ['path', 'content']
    }
  },
  {
    name: 'delete_item',
    description: 'Hapus file atau folder (beserta isinya) dari workspace proyek.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path file/folder relatif yang akan dihapus' }
      },
      required: ['path']
    }
  },
  {
    name: 'get_project_info',
    description: 'Info proyek Clincoo: nama aplikasi, pengaturan, dan jumlah file.',
    inputSchema: { type: 'object', properties: {}, required: [] }
  }
];

async function callTool(name, args, ctx) {
  const { be2Token, projectId } = ctx;
  switch (name) {
    case 'list_items': {
      const files = await fetchFiles(be2Token, projectId);
      const folder = args.folder ? String(args.folder).trim().replace(/^\/+|\/+$/g, '') : '';
      let lines = [];
      const seen = new Set();
      files.forEach(f => {
        const p = String(f.path || '');
        if (!p) return;
        if (folder && !p.toLowerCase().startsWith(folder.toLowerCase() + '/')) return;
        const rel = folder ? p.slice(folder.length + 1) : p;
        seen.add(p);
        const size = new Blob([f.content || '']).size;
        lines.push('- ' + rel + ' (' + (size > 1024 ? (size / 1024).toFixed(1) + ' KB' : size + ' B') + ')');
      });
      const text = lines.length
        ? 'Workspace proyek (' + files.length + ' item):\n' + lines.join('\n')
        : 'Workspace proyek kosong.';
      return { content: [{ type: 'text', text }] };
    }
    case 'read_file': {
      const path = safePath(args.path);
      const files = await fetchFiles(be2Token, projectId);
      const f = files.find(x => String(x.path).toLowerCase() === path.toLowerCase());
      if (!f) throw new Error('File tidak ditemukan: ' + path);
      let content = String(f.content || '');
      if (content.length > 120000) content = content.slice(0, 120000) + '\n...[dipotong]';
      return { content: [{ type: 'text', text: content || '(file kosong)' }] };
    }
    case 'write_file': {
      const path = safePath(args.path);
      const content = String(args.content == null ? '' : args.content);
      const files = await fetchFiles(be2Token, projectId);
      const idx = files.findIndex(x => String(x.path).toLowerCase() === path.toLowerCase());
      if (idx >= 0) files[idx].content = content; else files.push({ path, content });
      await pushFiles(be2Token, projectId, files);
      return { content: [{ type: 'text', text: 'Berhasil menulis ' + path + ' (' + new Blob([content]).size + ' B). Perubahan langsung terlihat di Clincoo.' }] };
    }
    case 'delete_item': {
      const path = safePath(args.path);
      const files = await fetchFiles(be2Token, projectId);
      const before = files.length;
      const kept = files.filter(x => {
        const p = String(x.path || '');
        const pl = p.toLowerCase();
        const dl = path.toLowerCase();
        if (pl === dl) return false;                    // file persis
        if (pl.startsWith(dl + '/')) return false;    // isi folder
        if (dl + '/' === pl && p.endsWith('/')) return false; // folder eksplisit
        return true;
      });
      if (kept.length === before) throw new Error('Tidak ditemukan: ' + path);
      await pushFiles(be2Token, projectId, kept);
      return { content: [{ type: 'text', text: 'Berhasil menghapus ' + path + '.' }] };
    }
    case 'get_project_info': {
      const [st, files] = await Promise.all([
        be2Json('/project-settings?project_id=' + encodeURIComponent(projectId), be2Token),
        fetchFiles(be2Token, projectId)
      ]);
      const settings = (st.ok && st.data && !st.data.error) ? (st.data.settings || {}) : {};
      let info = { project_id: projectId, total_files: files.filter(f => !String(f.path).endsWith('/')).length, app_name: settings.app_name || null };
      return { content: [{ type: 'text', text: JSON.stringify(info, null, 2) }] };
    }
    default:
      throw new Error('Tool tidak dikenal: ' + name);
  }
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestGet() {
  // Streamable HTTP: server ini tidak menyediakan stream GET (cukup POST request/response)
  return json({ error: 'Method GET tidak didukung endpoint ini. Gunakan POST (JSON-RPC 2.0).' }, 405);
}

export async function onRequestDelete() {
  return json({ error: 'Method DELETE tidak didukung endpoint ini.' }, 405);
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const projectId = url.searchParams.get('project_id') || request.headers.get('X-Project-Id') || '';
  const auth = await authMcp(request, env, projectId);
  if (auth.res) return auth.res;
  const ctx = { be2Token: auth.be2Token, projectId, scopes: auth.scopes };

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Body JSON tidak valid' } }, 400);
  }

  const id = body && body.id !== undefined ? body.id : null;
  const method = body && body.method;
  const isNotification = body && body.id === undefined;

  if (isNotification) return new Response(null, { status: 202, headers: CORS });

  try {
    if (method === 'initialize') {
      const requested = (body.params && body.params.protocolVersion) || '';
      const protocolVersion = ['2024-11-05', '2025-03-26', '2025-06-18'].includes(requested) ? requested : PROTOCOL_VERSION;
      return rpcResult(id, { protocolVersion, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
    }
    if (method === 'ping') return rpcResult(id, {});
    if (method === 'tools/list') return rpcResult(id, { tools: allowedTools(ctx.scopes) });
    if (method === 'tools/call') {
      const name = body.params && body.params.name;
      const args = (body.params && body.params.arguments) || {};
      const denied = toolScope(name);
      if (denied && ctx.scopes[denied] === false) {
        return rpcResult(id, { content: [{ type: 'text', text: 'Error: akses ditolak. Izin "' + denied + '" tidak diaktifkan untuk server MCP proyek ini (atur di halaman Server MCP Clincoo).' }], isError: true });
      }
      try {
        const result = await callTool(name, args, ctx);
        return rpcResult(id, result);
      } catch (e) {
        // error tool -> hasil isError (bukan error protokol)
        return rpcResult(id, { content: [{ type: 'text', text: 'Error: ' + e.message }], isError: true });
      }
    }
    return rpcError(id, -32601, 'Method tidak dikenal: ' + method);
  } catch (e) {
    return rpcError(id, -32603, 'Error internal: ' + e.message);
  }
}
