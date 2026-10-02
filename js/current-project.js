// Validasi proyek aktif — cegah state basi antar-proyek di halaman fitur (MCP, Email, Environment, dst).
// Jika 'clinqoo_current_project_id' menunjuk proyek yang sudah tidak ada (terhapus / pindah proyek),
// otomatis pindah ke proyek terbaru dalam daftar, sehingga fitur & secret selalu mengikuti proyek yang benar.
//
// BUG LAMA (ketemu 2026-10-03): kalau cache 'clinqoo_projects' KOSONG/belum pernah diisi di halaman ini
// (bukan berarti proyeknya gak ada — cuma daftar referensinya belum ke-cache di halaman ini), kode lama
// menganggap pid "tidak ditemukan di daftar" dan MENGHAPUS clinqoo_current_project_id yang sebenarnya
// valid. Efeknya: pindah ke sub-halaman settings (semua link menu di dashboard gak bawa ?id=) bikin pid
// kehapus sendiri -> aksi berikutnya (misal Aktifkan Server MCP) gagal "project_id wajib diisi".
// Fix: list kosong = kita gak punya bukti apa pun soal pid -> JANGAN DIUTAK-ATIK, biarkan apa adanya.
(function () {
    try {
        var pid = localStorage.getItem('clinqoo_current_project_id') || '';
        var list = JSON.parse(localStorage.getItem('clinqoo_projects') || '[]');
        if (!Array.isArray(list) || !list.length) return; // gak ada referensi -> jangan hapus/ubah apa pun
        var ids = {};
        list.forEach(function (p) { if (p && p.id) ids[p.id] = true; });
        if (!pid || !ids[pid]) {
            var latest = null;
            list.forEach(function (p) {
                if (!p || !p.id) return;
                if (!latest || (p.updatedAt || '') > (latest.updatedAt || '')) latest = p;
            });
            if (latest && latest.id) localStorage.setItem('clinqoo_current_project_id', latest.id);
            else localStorage.removeItem('clinqoo_current_project_id');
        }
    } catch (e) {}
})();
