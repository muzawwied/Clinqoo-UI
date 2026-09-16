/* Clinqoo Editor Full-stack extensions (Database + API Tester)
 * Loaded separately so main index.html style stays untouched.
 * Also loads layout-sidebar.js for the new sidebar layout.
 */
(function () {
  'use strict';
  // Load layout sidebar patch (left = files only, right = Workspace/Agent/Settings, Chat AI FAB)
  (function loadLayout() {
    if (document.querySelector('script[src*="layout-sidebar"]')) return;
    var s = document.createElement('script');
    s.src = 'layout-sidebar.js?v=20260917';
    s.defer = true;
    document.head.appendChild(s);
  })();

  function $(sel) { return document.querySelector(sel); }
  function $$(sel) { return Array.from(document.querySelectorAll(sel)); }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&').replace(/</g, '<').replace(/>/g, '>')
      .replace(/"/g, '"').replace(/'/g, '&#39;');
  }
  function dbStoreKey() {
    return 'clinqoo_db_' + (typeof LINK_PID !== 'undefined' && LINK_PID ? LINK_PID : 'local');
  }
  function dbLoad() {
    try { return JSON.parse(localStorage.getItem(dbStoreKey()) || '{}'); } catch (e) { return {}; }
  }
  function dbSave(obj) {
    try { localStorage.setItem(dbStoreKey(), JSON.stringify(obj)); } catch (e) {
      if (typeof toast === 'function') toast('Gagal simpan DB');
    }
  }
  function dbRefresh() {
    const data = dbLoad();
    const keys = Object.keys(data);
    const el = document.getElementById('db-list');
    if (!el) return;
    if (!keys.length) {
      el.className = 'empty-note';
      el.textContent = 'Belum ada data lokal. Gunakan sebagai store sederhana per proyek.';
      return;
    }
    el.className = '';
    const rows = keys.map(k => {
      let v = data[k];
      if (typeof v === 'object') v = JSON.stringify(v);
      v = String(v).slice(0, 80);
      const safeK = String(k).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
      return '<tr><td style="font-family:Fira Code,monospace;font-size:11.5px">' + esc(k) +
        '</td><td style="color:var(--text2);font-size:11.5px">' + esc(v) +
        '</td><td style="width:60px"><button class="ghost" style="height:22px;padding:0 7px;font-size:11px" onclick="window.__clinqooFS.dbDel(\'' + safeK + '\')">Hapus</button></td></tr>';
    }).join('');
    el.innerHTML = '<table class="db-table"><thead><tr><th>Key</th><th>Value</th><th></th></tr></thead><tbody>' + rows + '</tbody></table>';
  }
  function dbSet() {
    const k = (document.getElementById('db-key') || {}).value || '';
    let v = (document.getElementById('db-val') || {}).value || '';
    if (!k.trim()) { if (typeof toast === 'function') toast('Key wajib'); return; }
    try { v = JSON.parse(v); } catch (e) {}
    const data = dbLoad(); data[k.trim()] = v; dbSave(data);
    const ke = document.getElementById('db-key'); if (ke) ke.value = '';
    const ve = document.getElementById('db-val'); if (ve) ve.value = '';
    dbRefresh();
    if (typeof toast === 'function') toast('Disimpan');
  }
  function dbDel(k) { const data = dbLoad(); delete data[k]; dbSave(data); dbRefresh(); }
  function dbClear() {
    if (!confirm('Hapus semua data lokal proyek ini?')) return;
    dbSave({}); dbRefresh();
    if (typeof toast === 'function') toast('DB dikosongkan');
  }
  async function apiSend() {
    const method = (document.getElementById('api-method') || {}).value || 'GET';
    const url = ((document.getElementById('api-url') || {}).value || '').trim();
    if (!url) { if (typeof toast === 'function') toast('URL wajib'); return; }
    let headers = {};
    try {
      headers = JSON.parse((document.getElementById('api-headers') || {}).value || '{}');
    } catch (e) {
      if (typeof toast === 'function') toast('Headers JSON tidak valid');
      return;
    }
    const body = (document.getElementById('api-body') || {}).value || '';
    const opts = { method, headers };
    if (method !== 'GET' && method !== 'HEAD' && body) {
      opts.body = body;
      if (!headers['Content-Type'] && !headers['content-type']) {
        opts.headers = Object.assign({ 'Content-Type': 'application/json' }, headers);
      }
    }
    const t0 = performance.now();
    const resEl = document.getElementById('api-result');
    const stEl = document.getElementById('api-status');
    const pre = document.getElementById('api-resp-body');
    if (resEl) resEl.style.display = 'block';
    if (stEl) { stEl.textContent = 'Mengirim...'; stEl.className = 'api-status'; }
    if (pre) pre.textContent = '';
    try {
      const res = await fetch(url, opts);
      const ms = Math.round(performance.now() - t0);
      const timeEl = document.getElementById('api-time');
      if (timeEl) timeEl.textContent = ms + ' ms';
      const text = await res.text();
      let display = text;
      try { display = JSON.stringify(JSON.parse(text), null, 2); } catch (e) {}
      if (stEl) {
        stEl.textContent = res.status + ' ' + res.statusText;
        stEl.className = 'api-status ' + (res.ok ? 'ok' : 'err');
      }
      if (pre) pre.textContent = display || '(kosong)';
    } catch (err) {
      const timeEl = document.getElementById('api-time');
      if (timeEl) timeEl.textContent = Math.round(performance.now() - t0) + ' ms';
      if (stEl) { stEl.textContent = 'Error'; stEl.className = 'api-status err'; }
      if (pre) pre.textContent = String(err.message || err);
    }
  }
  function injectUI() {
    if (!document.getElementById('fs-style')) {
      const style = document.createElement('style');
      style.id = 'fs-style';
      style.textContent = '.db-table{width:100%;border-collapse:collapse;font-size:12px}.db-table th,.db-table td{padding:6px 8px;border-bottom:1px solid var(--line);text-align:left}.db-table th{color:var(--text2);font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.04em}.db-table tr:hover td{background:var(--bg4)}.db-actions{display:flex;gap:6px;margin-bottom:10px;flex-wrap:wrap}.db-actions button,.api-row button{height:28px;padding:0 11px;border-radius:7px;background:var(--btn-bg);color:#fff;font-size:12px;font-weight:600;border:none;cursor:pointer}.db-actions button.ghost,.api-row button.ghost{background:var(--bg4);color:var(--text2);border:1px solid var(--line)}.db-actions input,.api-input{height:28px;background:var(--bg3);border:1px solid var(--line);border-radius:7px;padding:0 9px;font-size:12px;outline:none;color:var(--text);flex:1;min-width:0}.db-actions input:focus,.api-input:focus{border-color:var(--accent)}.api-row{display:flex;gap:6px;margin-bottom:8px;align-items:center}.api-row select{height:28px;background:var(--bg3);border:1px solid var(--line);border-radius:7px;color:var(--text);font-size:12px;padding:0 6px}.api-ta{width:100%;min-height:70px;background:var(--bg3);border:1px solid var(--line);border-radius:8px;padding:8px 10px;font-family:"Fira Code",monospace;font-size:11.5px;color:var(--text);resize:vertical;outline:none}.api-ta:focus{border-color:var(--accent)}.api-resp{margin-top:10px;border:1px solid var(--line);border-radius:9px;background:var(--bg);overflow:hidden}.api-resp-head{display:flex;justify-content:space-between;padding:6px 10px;background:var(--bg4);font-size:11px;color:var(--text2);border-bottom:1px solid var(--line)}.api-resp pre{margin:0;padding:10px;font-family:"Fira Code",monospace;font-size:11.5px;line-height:1.5;max-height:220px;overflow:auto;white-space:pre-wrap;word-break:break-all}.api-status.ok{color:#2fbf71}.api-status.err{color:var(--err)}';
      document.head.appendChild(style);
    }
    const act = document.getElementById('activitybar');
    if (act && !document.querySelector('[data-panel="db"]')) {
      const spacer = act.querySelector('.spacer');
      const dbBtn = document.createElement('button');
      dbBtn.className = 'act-btn';
      dbBtn.dataset.panel = 'db';
      dbBtn.title = 'Database Lokal';
      dbBtn.innerHTML = '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/><path d="M3 12c0 1.66 4 3 9 3s9-1.34 9-3"/></svg>';
      const apiBtn = document.createElement('button');
      apiBtn.className = 'act-btn';
      apiBtn.dataset.panel = 'api';
      apiBtn.title = 'API Tester';
      apiBtn.innerHTML = '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>';
      if (spacer) { act.insertBefore(dbBtn, spacer); act.insertBefore(apiBtn, spacer); }
      else { act.appendChild(dbBtn); act.appendChild(apiBtn); }
    }
    const sidebar = document.getElementById('sidebar');
    if (sidebar && !document.getElementById('p-db')) {
      const clinqoo = sidebar.querySelector('.sb-clinqoo');
      const dbPanel = document.createElement('div');
      dbPanel.className = 'panel';
      dbPanel.id = 'p-db';
      dbPanel.innerHTML = '<div class="db-actions"><input id="db-key" class="api-input" placeholder="key" style="max-width:90px"><input id="db-val" class="api-input" placeholder="value (JSON ok)"><button onclick="window.__clinqooFS.dbSet()">Set</button><button class="ghost" onclick="window.__clinqooFS.dbRefresh()">Segarkan</button><button class="ghost" onclick="window.__clinqooFS.dbClear()">Hapus Semua</button></div><div id="db-list" class="empty-note">Belum ada data lokal. Gunakan sebagai store sederhana per proyek.</div>';
      const apiPanel = document.createElement('div');
      apiPanel.className = 'panel';
      apiPanel.id = 'p-api';
      apiPanel.innerHTML = '<div class="api-row"><select id="api-method"><option>GET</option><option>POST</option><option>PUT</option><option>PATCH</option><option>DELETE</option></select><input id="api-url" class="api-input" placeholder="https://api.example.com/..."><button onclick="window.__clinqooFS.apiSend()">Kirim</button></div><div style="font-size:11px;color:var(--text3);margin:4px 0 6px">Headers (JSON)</div><textarea id="api-headers" class="api-ta" style="min-height:48px" placeholder="{\"Authorization\":\"Bearer ...\",\"Content-Type\":\"application/json\"}"></textarea><div style="font-size:11px;color:var(--text3);margin:8px 0 6px">Body</div><textarea id="api-body" class="api-ta" placeholder="{\"name\":\"value\"}"></textarea><div id="api-result" class="api-resp" style="display:none"><div class="api-resp-head"><span class="api-status" id="api-status">-</span><span id="api-time">-</span></div><pre id="api-resp-body"></pre></div>';
      if (clinqoo) { sidebar.insertBefore(dbPanel, clinqoo); sidebar.insertBefore(apiPanel, clinqoo); }
      else { sidebar.appendChild(dbPanel); sidebar.appendChild(apiPanel); }
    }
    if (typeof showPanel === 'function' && !showPanel.__fsHooked) {
      const orig = showPanel;
      window.showPanel = function (name) {
        orig(name);
        if (name === 'db') try { dbRefresh(); } catch (e) {}
      };
      window.showPanel.__fsHooked = true;
      $$('.act-btn[data-panel]').forEach(b => {
        b.onclick = () => {
          if (b.classList.contains('active') && typeof sbOpen !== 'undefined' && sbOpen) {
            const sb = $('#sidebar'); if (sb) { sb.classList.add('hidden'); window.sbOpen = false; }
          } else {
            window.showPanel(b.dataset.panel);
          }
        };
      });
    }
  }
  window.__clinqooFS = { dbSet, dbRefresh, dbClear, dbDel, apiSend };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectUI);
  } else {
    setTimeout(injectUI, 400);
  }
})();
