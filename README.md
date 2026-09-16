# Clinqoo Code — Clinqoo-Editor

Editor kode full-stack di browser untuk proyek Clinqoo. Semua fitur nyata dan berfungsi — tanpa simulasi.

## Fitur editor
- Monaco engine: syntax 20+ bahasa, autocomplete, multi-cursor, minimap, format dokumen (Shift+Alt+F)
- Split editor nyata: Ctrl+klik tab atau klik kanan → "Buka di panel split", tetap terbuka sampai ditutup manual
- Auto simpan (default aktif): tersimpan 900ms setelah berhenti mengetik — bisa dimatikan di Pengaturan
- Cari & ganti lintas berkas: hasil dikelompokkan per berkas, opsi "sama kapital" & "kata utuh", tombol Ganti Semua
- Explorer: tree folder, klik kanan (buka/split/ganti nama/duplikat/hapus), import berkas dari perangkat (teks + gambar jadi dataURL)
- Export: proyek jadi satu berkas HTML (npm run build) atau arsip .zip asli (metode store + CRC32, tanpa dependensi)
- Riwayat versi lokal (git-lite): commit / log / checkout, tersinkron cloud Clinqoo
- Pratinjau melayang ala HP: drag, resize, preset ukuran, live refresh saat mengedit (ekstensi Live Preview)
- Terminal csh nyata: ls/tree/cd/cat/mkdir/mv/cp/rm/echo>/find/stat/grep/wc/git/npm, riwayat perintah ↑↓
- Palette perintah (Ctrl+Shift+P) & buka cepat berkas (Ctrl+P), tema terang/gelap, Mode Zen, Pengaturan lengkap

### Full-stack extras (baru)
- **Database panel** — key-value store lokal per proyek
- **API Tester** — kirim request HTTP nyata, lihat response
- File terpisah: `fullstack.js` (tidak mengubah style inti)

Untuk mengaktifkan: pastikan baris berikut ada sebelum `</body>` di `index.html`:
```html
<script src="fullstack.js" defer></script>
```

## Shortcut
Ctrl+S simpan · Ctrl+Shift+S / Ctrl+K S simpan semua · Ctrl+N berkas baru · Ctrl+P buka berkas · Ctrl+B panel · Ctrl+` terminal · Ctrl+G ke baris · F5 pratinjau

## Sinkronisasi proyek Clinqoo
Editor dibuka dari halaman proyek Clinqoo dengan `?pid=…&name=…`. Berkas tersinkron dua arah: localStorage lintas tab + cloud D1 Clinqoo, dengan push terakhir saat halaman ditutup.

## Struktur
- `index.html` — editor utama (vanilla)
- `fullstack.js` — ekstensi Database + API Tester
- `assets/` — ikon & favicon
