#!/usr/bin/env python3
"""Tarik modul ClincooPay dari build produksi sebelum deploy (papan sesi user).
Hapus: functions/api/pay.js, functions/api/clincoopay.js, functions/api/pay/,
proyek/pengaturan/pembayaran/, link menu pembayaran dari semua halaman,
dan route /api/pay dari _middleware.js. Jalan dari root repo."""
import re, os, glob, shutil, sys

T = os.getcwd() + '/'
removed = []
for f in ['functions/api/pay.js', 'functions/api/clincoopay.js', 'functions/api/pay',
          'proyek/pengaturan/pembayaran']:
    p = T + f
    if os.path.isdir(p):
        shutil.rmtree(p, ignore_errors=True); removed.append(f)
    elif os.path.isfile(p):
        os.remove(p); removed.append(f)

n = 0
for p in glob.glob(T + 'proyek/**/*.html', recursive=True):
    s = open(p).read()
    if 'href="/proyek/pengaturan/pembayaran/"' not in s:
        continue
    while '<a href="/proyek/pengaturan/pembayaran/"' in s:
        i = s.find('<a href="/proyek/pengaturan/pembayaran/"')
        j = s.find('</a>', i) + 4
        while j < len(s) and s[j] == '\n':
            j += 1
        k = j
        while k < len(s) and s[k] == ' ':
            k += 1
        s = s[:i] + s[k:]
    open(p, 'w').write(s)
    n += 1

mp = T + 'functions/api/_middleware.js'
s = open(mp).read()
s2 = s.replace(', /^\\/api\\/pay(\\/|$)/]', ']')
s2 = re.sub(r'\n//   - /api/pay\*[^\n]*', '', s2)
open(mp, 'w').write(s2)
if 'api/pay' in s2:
    print('FATAL: route /api/pay masih ada di _middleware.js', file=sys.stderr)
    sys.exit(1)

print('ClincooPay ditarik:', removed, '| menu dari', n, 'halaman')
