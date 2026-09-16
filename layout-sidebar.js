/* Clinqoo Editor — Layout patch
 * - Sidebar kiri: full height, HANYA file & folder (hide sb-clinqoo, hide AI panel)
 * - Sidebar kanan (desktop): Workspace, Agent, Pengaturan
 * - Chat AI: tombol bawah → halaman terpisah (bukan popup di editor)
 * - Mobile: activity bar bawah disederhanakan (Explorer + Git saja)
 */
(function () {
  'use strict';

  function $$(s) { return Array.from(document.querySelectorAll(s)); }

  function injectCSS() {
    if (document.getElementById('layout-sidebar-css')) return;
    const style = document.createElement('style');
    style.id = 'layout-sidebar-css';
    style.textContent = `
/* Left sidebar: files only, full height — boleh ditutup (jangan paksa display !important) */
#sidebar{flex-direction:column;height:100%;}
#sidebar.hidden{display:none!important;}
@media (max-width:780px){
  #sidebar{display:none!important;}
  #sidebar.mobile-open{display:flex!important;}
}
#sidebar .panel-body{flex:1;min-height:0;overflow:auto;}
#sidebar .sb-clinqoo{display:none!important;visibility:hidden!important;height:0!important;overflow:hidden!important;padding:0!important;border:none!important;}
#p-ai{display:none!important;}
.act-btn[data-panel="ai"]{display:none!important;}

/* Hide settings gear from left activitybar (moved to right / mobile menu) */
#activitybar > .act-btn[onclick*="openSettings"]{display:none!important;}

/* Desktop right bar */
#rightbar{
  width:52px;background:var(--bg2);border-left:1px solid var(--line);
  display:flex;flex-direction:column;align-items:center;padding:8px 0;gap:4px;flex-shrink:0;
}
#rightbar .rb-btn{
  width:44px;height:44px;border-radius:10px;display:grid;place-items:center;
  color:var(--text3);transition:.15s;text-decoration:none;border:none;background:none;cursor:pointer;
}
#rightbar .rb-btn:hover{color:var(--text);background:var(--bg4);}
#rightbar .spacer{flex:1;}

/* Chat AI FAB — buka halaman terpisah */
#ai-chat-fab{
  position:fixed;bottom:58px;right:14px;z-index:850;
  height:46px;padding:0 16px 0 14px;border-radius:23px;
  background:var(--btn-bg);color:#fff;font-weight:600;font-size:13px;
  display:flex;align-items:center;gap:8px;box-shadow:0 8px 28px rgba(0,0,0,.45);
  border:none;cursor:pointer;transition:.15s;
}
#ai-chat-fab:hover{filter:brightness(1.12);transform:translateY(-1px);}
#ai-chat-fab svg{flex-shrink:0;}

/* Mobile: simplify bottom activity bar — only explorer + git visible as primary */
@media (max-width:780px){
  #rightbar{display:none!important;}
  #ai-chat-fab{bottom:70px;right:12px;}
  /* Hide extra act buttons on mobile bottom bar to reduce "CTA" clutter */
  #activitybar .act-btn[data-panel="db"],
  #activitybar .act-btn[data-panel="api"],
  #activitybar .act-btn[data-panel="ai"]{display:none!important;}
  /* Keep explorer + git; settings stays hidden from left */
  #sidebar{bottom:54px;}
}
`;
    document.head.appendChild(style);
  }

  function openChatAIPage() {
    if (typeof openChatPage === 'function') { openChatPage(); return; }
    try {
      const pid = (typeof LINK_PID !== 'undefined' && LINK_PID)
        ? LINK_PID
        : (new URLSearchParams(location.search).get('pid') || '');
      const name = (typeof LINK_NAME !== 'undefined' && LINK_NAME) ? LINK_NAME : '';
      let url = 'https://muzawwied.github.io/Clinqoo./proyek/chat/';
      if (pid) url += '?id=' + encodeURIComponent(pid) + (name ? '&name=' + encodeURIComponent(name) : '');
      window.open(url, '_blank', 'noopener');
    } catch (e) {
      window.open('https://muzawwied.github.io/Clinqoo./proyek/chat/', '_blank');
    }
  }

  function buildRightbar() {
    if (document.getElementById('rightbar')) return;
    const main = document.getElementById('main');
    const editorCol = document.getElementById('editor-col');
    if (!main || !editorCol) return;

    const rb = document.createElement('div');
    rb.id = 'rightbar';
    rb.innerHTML = `
      <a class="rb-btn" id="rb-workspace" href="https://muzawwied.github.io/Clinqoo./proyek/workspace/" target="_blank" rel="noopener" title="Workspace">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="16" y="16" width="6" height="6" rx="1"/><rect x="2" y="16" width="6" height="6" rx="1"/><rect x="9" y="2" width="6" height="6" rx="1"/><path d="M5 16v-3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3"/><path d="M12 12V8"/></svg>
      </a>
      <a class="rb-btn" id="rb-agent" href="https://muzawwied.github.io/Clinqoo./proyek/chat/" target="_blank" rel="noopener" title="Agent">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="14" x="3" y="8" rx="2"/><path d="M12 5a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z"/><path d="M12 5v3"/><path d="M8 14h.01"/><path d="M16 14h.01"/><path d="M10 18h4"/></svg>
      </a>
      <div class="spacer"></div>
      <button class="rb-btn" type="button" title="Pengaturan">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M2 12h3M19 12h3M4.9 19.1L7 17M17 7l2.1-2.1"/></svg>
      </button>
    `;
    const settingsBtn = rb.querySelector('button.rb-btn');
    settingsBtn.addEventListener('click', function () {
      if (typeof openSettings === 'function') openSettings();
      else if (typeof openSettingsDrawer === 'function') openSettingsDrawer();
    });

    if (editorCol.nextSibling) main.insertBefore(rb, editorCol.nextSibling);
    else main.appendChild(rb);

    try {
      const pid = (typeof LINK_PID !== 'undefined' && LINK_PID)
        ? LINK_PID
        : (new URLSearchParams(location.search).get('pid') || '');
      const name = (typeof LINK_NAME !== 'undefined' && LINK_NAME) ? LINK_NAME : '';
      const q = pid ? ('?id=' + encodeURIComponent(pid) + (name ? '&name=' + encodeURIComponent(name) : '')) : '';
      const w = document.getElementById('rb-workspace');
      const a = document.getElementById('rb-agent');
      if (w) w.href = 'https://muzawwied.github.io/Clinqoo./proyek/workspace/' + q;
      if (a) a.href = 'https://muzawwied.github.io/Clinqoo./proyek/chat/' + q;
    } catch (e) {}
  }

  function buildFab() {
    if (document.getElementById('ai-chat-fab')) return;
    const btn = document.createElement('button');
    btn.id = 'ai-chat-fab';
    btn.type = 'button';
    btn.title = 'Buka Chat AI';
    btn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/></svg> Chat AI';
    btn.addEventListener('click', openChatAIPage);
    document.body.appendChild(btn);
  }

  function hideLeftExtras() {
    // Force-hide clinqoo CTA block in left sidebar
    $$('.sb-clinqoo').forEach(function (el) {
      el.style.display = 'none';
      el.style.visibility = 'hidden';
      el.style.height = '0';
      el.style.overflow = 'hidden';
      el.style.padding = '0';
      el.style.border = 'none';
    });
    // Hide AI panel + AI act button
    $$('.act-btn[data-panel="ai"]').forEach(function (b) { b.style.display = 'none'; });
    $$('#activitybar .act-btn[onclick*="openSettings"]').forEach(function (b) { b.style.display = 'none'; });
    var pai = document.getElementById('p-ai');
    if (pai) pai.style.display = 'none';
  }

  function boot() {
    injectCSS();
    hideLeftExtras();
    buildRightbar();
    buildFab();
    // Re-hide after fullstack injects DB/API buttons (timing)
    setTimeout(hideLeftExtras, 600);
    setTimeout(hideLeftExtras, 1500);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(boot, 150); });
  } else {
    setTimeout(boot, 150);
  }

  window.openChatAIPage = openChatAIPage;
})();
