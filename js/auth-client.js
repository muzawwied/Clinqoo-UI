// Clincoo Auth Client — gate login + injeksi token ke semua API call
// Wajib dimuat PERTAMA di semua halaman (kecuali halaman auth di /auth/).
(function () {
  var TOKEN_KEY = 'clinqoo_auth_token';
  var isAuthPage = /\/auth\/(index\.html)?(\?|$)|akun\/auth\.html(\?|$)/.test(location.pathname + location.search);
  var AUTH_URL = (location.hostname.indexOf('github.io') !== -1)
    ? '/Clincoo./auth/'
    : '/auth/';

// ===== NAMESPACE DATA PER AKUN =====
// Semua kunci localStorage (kecuali clinqoo_auth_*) otomatis diawali u<id>:
// sehingga data tiap akun (proyek, chat, file workspace, preferensi) terpisah total.
// Data lama (tanpa prefix) diklaim SEKALI oleh akun pertama yang login di device ini.
var NS_USER_KEY = 'clinqoo_auth_user';
var NS_AUTH_RE = /^clinqoo_auth_/;
var NS_NS_RE = /^u\d+:/;
var NS_raw = window.localStorage;

function nsPrefix() {
  try {
    var u = JSON.parse(NS_raw.getItem(NS_USER_KEY) || 'null');
    if (u && u.id) return 'u' + u.id + ':';
  } catch (e) {}
  return '';
}

function nsRealKey(k) {
  k = String(k);
  if (NS_AUTH_RE.test(k)) return k;          // kunci auth tetap global
  nsClaimLegacy();                            // klaim legacy begitu akun diketahui
  var p = nsPrefix();
  return p ? p + k : k;
}

// Klaim data legacy: pindahkan semua kunci tanpa prefix ke namespace akun ini (sekali).
var NS_claimedPrefix = '';
function nsClaimLegacy() {
  var p = nsPrefix();
  if (!p || p === NS_claimedPrefix || NS_raw.getItem(p + '__claimed')) return;
  NS_claimedPrefix = p;
  try {
    var toMove = [];
    for (var i = 0; i < NS_raw.length; i++) {
      var k = NS_raw.key(i);
      if (k && !NS_AUTH_RE.test(k) && !NS_NS_RE.test(k)) toMove.push(k);
    }
    for (var j = 0; j < toMove.length; j++) {
      var kk = toMove[j];
      NS_raw.setItem(p + kk, NS_raw.getItem(kk));
      NS_raw.removeItem(kk);
    }
    NS_raw.setItem(p + '__claimed', '1');
  } catch (e) {}
}

function nsEach(fn) {
  var p = nsPrefix();
  if (!p) { for (var i = 0; i < NS_raw.length; i++) { var k = NS_raw.key(i); if (k) fn(k, k); } return; }
  for (var m = 0; m < NS_raw.length; m++) {
    var kk = NS_raw.key(m);
    if (kk && kk.indexOf(p) === 0) fn(kk, kk.slice(p.length));
  }
}

var NS_shim = {
  getItem: function (k) { return NS_raw.getItem(nsRealKey(k)); },
  setItem: function (k, v) { NS_raw.setItem(nsRealKey(k), String(v)); },
  removeItem: function (k) { NS_raw.removeItem(nsRealKey(k)); },
  clear: function () { nsEach(function (real) { NS_raw.removeItem(real); }); },
  key: function (i) { var c = 0, out = null; nsEach(function (real, user) { if (c++ === i) out = user; }); return out; }
};
Object.defineProperty(NS_shim, 'length', { get: function () { var c = 0; nsEach(function () { c++; }); return c; } });

var NS_proxy = new Proxy(NS_shim, {
  get: function (t, prop) {
    if (prop in t) return t[prop];
    return NS_raw.getItem(nsRealKey(prop));
  },
  set: function (t, prop, v) {
    if (prop in t) return true;
    NS_raw.setItem(nsRealKey(prop), String(v));
    return true;
  },
  deleteProperty: function (t, prop) {
    if (prop in t) return true;
    NS_raw.removeItem(nsRealKey(prop));
    return true;
  },
  has: function (t, prop) {
    if (prop in t) return true;
    return NS_raw.getItem(nsRealKey(prop)) !== null;
  }
});

try {
  Object.defineProperty(window, 'localStorage', { value: NS_proxy, configurable: true, writable: true });
  nsClaimLegacy();
} catch (e) { /* fallback: localStorage polos */ }
// ===== AKHIR NAMESPACE PER AKUN =====

  function getToken() {
    try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; }
  }
  window.ClinqooAuth = {
    getToken: getToken,
    authUrl: AUTH_URL,
    logout: function (ev) {
      if (ev && ev.preventDefault) { try { ev.preventDefault(); } catch (e) {} }
      var API = (['clincoo-be2.pages.dev','localhost','127.0.0.1'].indexOf(location.hostname) === -1) ? 'https://clincoo-be2.pages.dev' : '';
      var done = false;
      var finish = function () {
        if (done) return;
        done = true;
        try { localStorage.removeItem(TOKEN_KEY); } catch (e) {}
        location.replace(AUTH_URL);
      };
      var tk = getToken();
      if (tk) {
        try {
          fetch(API + '/api/auth/logout', { method: 'POST', headers: { 'Authorization': 'Bearer ' + tk } })
            .catch(function () {}).then(finish);
          setTimeout(finish, 2000);
        } catch (e) { finish(); }
      } else { finish(); }
      return false;
    }
  };

  var origFetch = window.fetch;

  // Tombol kembali cerdas (fix loop A-B-A-B):
// - datang dari halaman aplikasi ini -> history.back() beneran (TANPA entri baru)
// - dibuka langsung/deep-link -> location.replace ke halaman induk (TANPA entri baru)
// Sebelumnya beberapa tombol kembali pakai location.href = navigasi MAJU yang menambah
// entri riwayat, sehingga bolak-balik klik kembali mantul antara dua halaman tanpa henti.
window.ClinqooBack = function (fallbackUrl) {
  try {
    var sameOrigin = document.referrer && new URL(document.referrer).origin === location.origin;
    if (sameOrigin && history.length > 1) { window.history.back(); return; }
  } catch (e) {}
  if (fallbackUrl) { try { location.replace(fallbackUrl); return; } catch (e2) {} }
  try { window.history.back(); } catch (e3) {}
};

// Gate: buka halaman apa pun tanpa login -> langsung ke halaman auth
  if (!isAuthPage && !getToken()) {
    try { location.replace(AUTH_URL + '?next=' + encodeURIComponent(location.href)); } catch (e) { location.replace(AUTH_URL); }
    return;
  }

  // Validasi token ke backend: token mati (logout perangkat / reset) -> auth ulang
  if (!isAuthPage && getToken()) {
    var API = (['clincoo-be2.pages.dev','localhost','127.0.0.1'].indexOf(location.hostname) === -1) ? 'https://clincoo-be2.pages.dev' : '';
    origFetch(API + '/api/auth/me', { headers: { 'Authorization': 'Bearer ' + getToken() } })
      .then(function (r) { return r.ok ? r.json() : { authenticated: false }; })
      .then(function (d) {
        if (d && d.authenticated && d.user) {
          try {
            var prevUser = JSON.parse(NS_raw.getItem(NS_USER_KEY) || 'null');
            if (!prevUser || !prevUser.id || String(prevUser.id) !== String(d.user.id)) {
              NS_raw.setItem(NS_USER_KEY, JSON.stringify(d.user));
              // aktivasi namespace per akun butuh reload sekali
              if (!sessionStorage.getItem('clinqoo_ns_reload')) {
                try { sessionStorage.setItem('clinqoo_ns_reload', '1'); } catch (e2) {}
                location.reload();
              }
            }
          } catch (e1) {}
        }
        if (!d || !d.authenticated) {
          try { NS_raw.removeItem(TOKEN_KEY); } catch (e) {}
          location.replace(AUTH_URL + '?next=' + encodeURIComponent(location.href));
        }
      })
      .catch(function () {});
  }

  // Wrapper fetch: semua call ke backend dibawa token Bearer; 401 -> auth
  window.fetch = function (input, init) {
    init = init || {};
    var url = '';
    try { url = typeof input === 'string' ? input : (input && input.url) || ''; } catch (e) {}
    var isApi = url.indexOf('clincoo-be2.pages.dev/api') !== -1 || url.indexOf('clincoo.pages.dev/api') !== -1 || /^\/api\//.test(url) || /^https?:\/\/[^\/]*clinqoo-be2\.pages\.dev\/api/.test(url);
    var isAuthApi = url.indexOf('/api/auth/') !== -1;
    if (isApi && !isAuthApi) {
      try {
        var headers = new Headers((init && init.headers) || (input && input.headers) || undefined);
        var tk = getToken();
        if (tk && !headers.get('Authorization')) headers.set('Authorization', 'Bearer ' + tk);
        init.headers = headers;
        if (typeof input === 'object' && input && input.headers && !(init && init.headers)) { /* noop */ }
      } catch (e) {}
    }
    var p = origFetch.call(this, input, init);
    return p.then(function (res) {
      try {
        if (res.status === 401 && !isAuthPage && isApi && !isAuthApi) {
          location.replace(AUTH_URL + '?next=' + encodeURIComponent(location.href));
        }
      } catch (e) {}
      return res;
    });
  };

  // ---- FIX: project id yang benar harus IKUT di setiap link, bukan cuma di localStorage.
  // localStorage (walau sudah dinamespace per akun di atas) tetap dibagi oleh SEMUA TAB
  // dari akun yang sama -- kalau user punya banyak tab proyek berbeda terbuka, tab yang
  // paling akhir aktif bisa menimpa 'clinqoo_current_project_id' milik tab lain, sehingga
  // Deploy/Pengaturan dsb membaca proyek yang SALAH ("Proyek tidak ditemukan atau bukan
  // milik akun ini"). Solusi: begitu halaman proyek/ dimuat, ID dari URL (paling dipercaya)
  // dipatch ke semua link sesama halaman proyek/ supaya klik selanjutnya selalu bawa ?id=
  // yang benar, tidak bergantung urutan tab.
  var PROJECT_PAGES = ['chat', 'workspace', 'environment', 'keamanan',
    'pengaturan', 'umum', 'build-deployment', 'build-deployment-config', 'build-deployment-dashboard', 'domain-kustom',
    'keamanan-https', 'visibilitas-akses', 'integrasi-webhook', 'zona-bahaya', 'workspace-editor'];

  function patchProjectLinks() {
    if (!isAuthPage && location.pathname.indexOf('/proyek/') !== -1) {
      try {
        var qid = new URLSearchParams(location.search).get('id');
        var pid = qid || (function () { try { return localStorage.getItem('clinqoo_current_project_id') || ''; } catch (e) { return ''; } })();
        if (!pid) return;
        try { localStorage.setItem('clinqoo_current_project_id', pid); } catch (e) {}
        var anchors = document.querySelectorAll('a[href]');
        for (var i = 0; i < anchors.length; i++) {
          var href = anchors[i].getAttribute('href') || '';
          var bare = href.split('?')[0];
          var bareKey = (bare.split('/').filter(Boolean).pop() || '').replace(/\.html$/, '');
          if (PROJECT_PAGES.indexOf(bareKey) !== -1) {
            anchors[i].setAttribute('href', bare + '?id=' + encodeURIComponent(pid));
          }
        }
      } catch (e) {}
    }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', patchProjectLinks);
  } else {
    patchProjectLinks();
  }
})();
