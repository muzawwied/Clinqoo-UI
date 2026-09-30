/**
 * Clincoo URL Path Router
 * Parses nested URLs and patches sidebar links with project_id.
 * Supports Cloudflare Pages (root) and GitHub Pages (subpath /Clincoo. or /Clinqoo-UI).
 *
 * Canonical URL scheme (file structure yang benar-benar ada):
 *   /proyek/workspace/?id={projectId}
 *   /proyek/chat/?id={projectId}
 *   /proyek/pengaturan/?id={projectId}
 *   /proyek/pengaturan/environment/?id={projectId}
 *   /proyek/pengaturan/keamanan/?id={projectId}
 *   /proyek/workspace/editor/?id={projectId}
 *   /integrasi/
 *   /  (beranda)
 */

// Detect GitHub Pages subpath
const _BASE = (function () {
    var m = location.pathname.match(/^(\/(?:Clincoo\.?|Clinqoo-UI))/);
    if (m) return m[1];
    if (/github\.io$/i.test(location.hostname)) return '/Clinqoo-UI';
    return '';
})();
const _isGitHubPages = _BASE.length > 0;

const PathRouter = {
    getSegments() {
        let path = window.location.pathname.replace(/\.html$/, '');
        if (_BASE && path.startsWith(_BASE)) {
            path = path.substring(_BASE.length);
        }
        return path.split('/').filter(s => s.length > 0);
    },

    getProjectId() {
        const params = new URLSearchParams(window.location.search);
        const fromQuery = params.get('id');
        if (fromQuery) return fromQuery;

        // Legacy clean URL: /workspace/{projectId}/...
        const segments = this.getSegments();
        if (segments.length >= 2 && segments[0] === 'workspace') {
            return decodeURIComponent(segments[1]);
        }
        return null;
    },

    getSection() {
        const segments = this.getSegments();
        // /proyek/chat, /proyek/workspace, /proyek/pengaturan, ...
        if (segments[0] === 'proyek' && segments[1]) {
            return segments[1];
        }
        // Legacy /workspace/{id}/{section}
        if (segments[0] === 'workspace' && segments.length >= 3) {
            return segments[2];
        }
        return null;
    },

    getSubmenu() {
        const segments = this.getSegments();
        // /proyek/pengaturan/environment
        if (segments[0] === 'proyek' && segments[1] === 'pengaturan' && segments[2]) {
            return segments[2];
        }
        if (segments[0] === 'workspace' && segments.length >= 4) {
            return segments[3];
        }
        return null;
    },

    getProfileSection() {
        const segments = this.getSegments();
        if (segments.length >= 2 && (segments[0] === 'profil' || segments[0] === 'akun')) {
            return segments[1];
        }
        return null;
    },

    buildProjectUrl(subpath) {
        const projectId = this.getProjectId() || localStorage.getItem('clinqoo_current_project_id');
        if (!projectId) return _BASE + '/';
        const idQ = '?id=' + encodeURIComponent(projectId);
        if (!subpath) {
            return _BASE + '/proyek/workspace/' + idQ;
        }
        const map = {
            'workspace': '/proyek/workspace/',
            'chat': '/proyek/chat/',
            'pengaturan': '/proyek/pengaturan/',
            'environment': '/proyek/pengaturan/environment/',
            'keamanan': '/proyek/pengaturan/keamanan/',
            'umum': '/proyek/pengaturan/umum/',
            'editor': '/proyek/workspace/editor/',
            'plugin': '/integrasi/',
            'integrasi': '/integrasi/'
        };
        const path = map[subpath] || ('/proyek/' + subpath.replace(/^\//, '') + '/');
        if (subpath === 'plugin' || subpath === 'integrasi') {
            return _BASE + path;
        }
        return _BASE + path + idQ;
    },

    navigate(subpath) {
        window.location.href = this.buildProjectUrl(subpath);
    },

    goBack() {
        const segments = this.getSegments();
        if (segments[0] === 'proyek' || segments[0] === 'workspace') {
            if (segments.length >= 3 || this.getSubmenu()) {
                window.ClinqooBack ? window.ClinqooBack(this.buildProjectUrl('workspace')) : (window.location.href = this.buildProjectUrl('workspace'));
            } else {
                window.ClinqooBack ? window.ClinqooBack(_BASE + '/') : (window.location.href = _BASE + '/');
            }
        } else if (segments[0] === 'profil' || segments[0] === 'akun') {
            window.ClinqooBack ? window.ClinqooBack(_BASE + '/') : (window.location.href = _BASE + '/');
        } else {
            window.history.back();
        }
    },

    persistProjectId() {
        const id = this.getProjectId();
        if (id) {
            try { localStorage.setItem('clinqoo_current_project_id', id); } catch (e) {}
        }
    },

    getProjectIdWithFallback() {
        let id = this.getProjectId();
        if (!id) {
            try { id = localStorage.getItem('clinqoo_current_project_id'); } catch (e) {}
        }
        return id;
    },

    patchSidebarLinks() {
        const projectId = this.getProjectIdWithFallback();
        const idQ = projectId ? ('?id=' + encodeURIComponent(projectId)) : '';

        const linkMap = {
            'app': _BASE + '/',
            'chat': _BASE + '/proyek/chat/' + idQ,
            'workspace': _BASE + '/proyek/workspace/' + idQ,
            'editor': _BASE + '/proyek/workspace/editor/' + idQ,
            'plugin': _BASE + '/integrasi/',
            'integrasi': _BASE + '/integrasi/',
            'pengaturan': _BASE + '/proyek/pengaturan/' + idQ,
            'environment': _BASE + '/proyek/pengaturan/environment/' + idQ,
            'keamanan': _BASE + '/proyek/pengaturan/keamanan/' + idQ,
            'umum': _BASE + '/proyek/pengaturan/umum/' + idQ
        };

        document.querySelectorAll('.sidebar-nav-link[data-page]').forEach(link => {
            const page = link.getAttribute('data-page');
            if (linkMap[page]) {
                link.setAttribute('href', linkMap[page]);
            }
        });

        document.querySelectorAll('a.tab-btn[href]').forEach(link => {
            const href = link.getAttribute('href') || '';
            if (!projectId) return;
            if (href.indexOf('pengaturan') !== -1 || href.indexOf('environment') !== -1 || href.indexOf('keamanan') !== -1) {
                try {
                    if (href.startsWith('/') || href.startsWith('http')) {
                        const u = new URL(href, location.origin);
                        if (!u.searchParams.get('id')) {
                            u.searchParams.set('id', projectId);
                            link.setAttribute('href', u.pathname + u.search);
                        }
                    } else {
                        const base = href.split('?')[0];
                        if (href.indexOf('id=') === -1) {
                            link.setAttribute('href', base + (href.indexOf('?') >= 0 ? '&' : '?') + 'id=' + encodeURIComponent(projectId));
                        }
                    }
                } catch (e) {}
            }
        });
    },

    highlightActiveLink() {
        const section = this.getSection();
        const submenu = this.getSubmenu();
        const path = window.location.pathname.replace(/\/$/, '');

        document.querySelectorAll('.sidebar-nav-link').forEach(link => {
            link.classList.remove('bg-gray-50', 'text-gray-800');
            link.classList.add('text-gray-700');

            const page = link.getAttribute('data-page');
            let active = false;

            if (page === 'app' && (path === '' || path === '/' || path === _BASE || path === _BASE + '/')) {
                active = true;
            } else if (page === 'chat' && (section === 'chat' || path.indexOf('/proyek/chat') !== -1)) {
                active = true;
            } else if (page === 'workspace' && (section === 'workspace' || path.indexOf('/proyek/workspace') !== -1) && path.indexOf('/editor') === -1) {
                active = true;
            } else if (page === 'editor' && path.indexOf('/editor') !== -1) {
                active = true;
            } else if ((page === 'plugin' || page === 'integrasi') && path.indexOf('/integrasi') !== -1) {
                active = true;
            } else if (page === 'pengaturan' && section === 'pengaturan' && !submenu) {
                active = true;
            } else if (page === 'environment' && (submenu === 'environment' || section === 'environment')) {
                active = true;
            } else if (page === 'keamanan' && (submenu === 'keamanan' || section === 'keamanan')) {
                active = true;
            }

            if (active) {
                link.classList.add('bg-gray-50', 'text-gray-800');
                link.classList.remove('text-gray-700');
            }
        });
    },

    init() {
        this.persistProjectId();
        const run = () => {
            this.patchSidebarLinks();
            this.highlightActiveLink();
        };
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', run);
        } else {
            run();
        }
        return {
            projectId: this.getProjectIdWithFallback(),
            section: this.getSection(),
            submenu: this.getSubmenu(),
            profileSection: this.getProfileSection(),
            segments: this.getSegments(),
            base: _BASE
        };
    }
};

window.PathRouter = PathRouter;
window._pathInfo = PathRouter.init();
