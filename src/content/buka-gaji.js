/*
 * buka-gaji.js — Content script: buka massal Sub Kegiatan + Rincian Belanja gaji
 * di SIPD-RI (Penganggaran > Sub Kegiatan Belanja), lewat klik UI (bukan API).
 *
 * Cara kerja:
 * - Antrian SKPD disimpan di localStorage, jadi tetap jalan walau halaman reload/pindah SKPD.
 * - Di tiap SKPD: cari kata kunci -> cocokkan nama sub kegiatan -> buka menu Aksi ->
 *   klik "Buka Sub Kegiatan" lalu "Buka Rincian Belanja".
 * - HANYA mengklik item yang teksnya persis "Buka ...". Kalau yang muncul "Kunci ...",
 *   artinya sudah terbuka -> dilewati. Item lain tidak pernah disentuh.
 * - Kalau hasil cocok 0 atau terlalu banyak (> MAX_ROWS), SKPD itu dilewati & dicatat.
 *
 * Penyesuaian untuk ekstensi (dari versi asli Claude in Chrome):
 * - Panel hanya tampil di halaman cascading/belanja (ikut navigasi SPA Angular).
 * - Kalau sedang jalan tapi bukan di halaman belanja (mis. terlempar ke login), antrian
 *   dijeda — tidak redirect terus-menerus. Buka lagi halaman belanja lalu klik "Lanjut".
 * - Kalau sudah 2x diarahkan ke id_skpd yang sama tapi URL tidak pernah cocok,
 *   SKPD itu dilewati & dicatat supaya antrian tetap jalan ke dinas berikutnya.
 * - Tombol Stop berlaku di tengah SKPD (dicek sebelum tiap klik).
 * - Panel di kiri bawah supaya tidak menumpuk dengan panel ekstensi yang sudah ada.
 */
(() => {
  'use strict';

  const BASE = 'https://sipd-ri.kemendagri.go.id/penganggaran/anggaran/cascading/belanja?id_skpd=';
  const PAGE_RE = /\/penganggaran\/anggaran\/cascading\/belanja\b/;
  const KEY = 'bukaGaji_state_v1';
  const MAX_ROWS = 3;          // pengaman: jangan buka massal kalau hasil cocok aneh-aneh
  const MAX_NAV = 2;           // maksimal redirect ke id_skpd yang sama sebelum dilewati
  const DELAY = { short: 600, action: 2200, search: 2500, pageReady: 1500 };

  // ---------- Aturan per SKPD ----------
  const GAJI_ASN = { search: 'gaji', match: /Penyediaan Gaji dan Tunjangan ASN/i };

  function rulesFor(nama) {
    if (/Puskesmas|Satuan PNF/i.test(nama)) return null;                 // skip
    if (/^Bagian Keuangan dan Perencanaan/i.test(nama))
      return [{ search: 'gaji', match: /gaji/i }];                        // gaji ASN + gaji KDH
    if (/^Bagian /i.test(nama)) return null;                              // bagian setda lain: skip
    if (/^Sekretariat DPRD/i.test(nama))
      return [GAJI_ASN, {
        search: 'Penyelenggaraan Administrasi Keuangan DPRD',
        match: /Penyelenggaraan Administrasi Keuangan DPRD/i,
      }];
    return [GAJI_ASN];
  }

  // Daftar SKPD Kab. Buru TA 2027 (id_skpd | nama). Tambah/hapus sesuai kebutuhan.
  const SKPD = `
277|Dinas Pendidikan dan Kebudayaan
444|Satuan PNF Sanggar Kegiatan Belajar
392|Dinas Kesehatan
1908|Puskesmas Namlea
1909|Puskesmas Sawa
1911|Puskesmas Waplau
1913|Puskesmas Wamlana
1916|Puskesmas Airbuaya
1917|Puskesmas Kayeli
1918|Puskesmas Ilath
1920|Puskesmas Savana Jaya
1923|Puskesmas Mako
1925|Puskesmas Lolong Guba
1926|Puskesmas Waelo
12791|Puskesmas Bara
12792|Puskesmas Waegrahe
434|RSUD Namlea
393|Dinas Pekerjaan Umum dan Penataan Ruang
443|Dinas Perumahan dan Kawasan Pemukiman
395|Dinas Satuan Polisi Pamong Praja
428|Badan Penanggulangan Bencana Daerah
396|Dinas Sosial
397|Dinas Tenaga Kerja dan Transmigrasi
398|Dinas Pemberdayaan Perempuan dan Perlindungan Anak
399|Dinas Ketahanan Pangan
400|Dinas Lingkungan Hidup
401|Dinas Kependudukan dan Pencatatan Sipil
402|Dinas Pemberdayaan Masyarakat dan Pemerintah Desa
403|Dinas Pengendalian Penduduk dan Keluarga Berencana
406|Dinas Perhubungan
407|Dinas Komunikasi dan Informatika
408|Dinas Koperasi Usaha Kecil dan Menengah
409|Dinas Penanaman Modal dan Pelayanan Terpadu Satu Pintu
410|Dinas Pemuda dan Olahraga
411|Dinas Perpustakaan dan Arsip Daerah
412|Dinas Perikanan
413|Dinas Pariwisata
414|Dinas Pertanian
415|Dinas Perindustrian dan Perdagangan
416|Sekretariat Daerah
436|Bagian Tata Pemerintahan
437|Bagian Hukum
435|Bagian Umum dan Perlengkapan
438|Bagian Ekonomi dan Pembangunan
439|Bagian Kesejahteraan Rakyat
440|Bagian Organisasi
441|Bagian Hubungan Masyarakat dan Protokol
442|Bagian Sumber Daya Alam
1590|Bagian Keuangan dan Perencanaan
417|Sekretariat DPRD
432|Badan Perencanaan Pembangunan, Riset dan Inovasi Daerah
430|Badan Pengelolaan Keuangan dan Aset Daerah
433|Badan Pendapatan Daerah
431|Badan Kepegawaian dan Pengembangan Sumber Daya Manusia
429|Inspektorat Daerah
418|Kecamatan Namlea
419|Kecamatan Air Buaya
420|Kecamatan Batabual
421|Kecamatan Waeapo
422|Kecamatan Waplau
423|Kecamatan Lolong Guba
424|Kecamatan Waelata
425|Kecamatan Fena Leisela
426|Kecamatan Teluk Kaiely
427|Kecamatan Lilialy
405|Badan Bina Kesatuan Bangsa dan Politik
`.trim().split('\n').map(l => { const [id, nama] = l.split('|'); return { id: id.trim(), nama: nama.trim() }; });

  // ---------- Util ----------
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const txt = el => (el?.innerText || '').replace(/\s+/g, ' ').trim();
  const visible = el => !!el && el.offsetParent !== null;
  const onPage = () => PAGE_RE.test(location.pathname);

  async function waitFor(fn, timeout = 20000, step = 300) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) { const v = fn(); if (v) return v; await sleep(step); }
    return null;
  }

  const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) || null; } catch { return null; } };
  const save = s => localStorage.setItem(KEY, JSON.stringify(s));
  const clear = () => localStorage.removeItem(KEY);
  const currentId = () => new URLSearchParams(location.search).get('id_skpd');

  class Stopped extends Error {}
  const checkStop = () => { if (!load()?.running) throw new Stopped('Dihentikan'); };

  // ---------- Panel kecil ----------
  function panel() {
    let p = document.getElementById('bukaGajiPanel');
    if (p) return p;
    p = document.createElement('div');
    p.id = 'bukaGajiPanel';
    p.style.cssText = 'position:fixed;left:16px;bottom:16px;z-index:99999;width:340px;max-height:50vh;' +
      'background:#fff;border:1px solid #ccc;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.15);' +
      'font:12px/1.4 sans-serif;display:flex;flex-direction:column';
    p.innerHTML =
      '<div style="padding:8px;border-bottom:1px solid #eee;display:flex;gap:6px;align-items:center">' +
      '<b style="flex:1">Buka Gaji Massal</b>' +
      '<button id="bgStart" style="padding:3px 8px">Mulai</button>' +
      '<button id="bgResume" style="padding:3px 8px">Lanjut</button>' +
      '<button id="bgStop" style="padding:3px 8px">Stop</button></div>' +
      '<div id="bgLog" style="padding:8px;overflow:auto;white-space:pre-wrap"></div>';
    document.body.appendChild(p);
    p.querySelector('#bgStart').onclick = () => {
      if (confirm('Mulai dari awal? Antrian & log sebelumnya akan direset.')) start();
    };
    p.querySelector('#bgResume').onclick = resume;
    p.querySelector('#bgStop').onclick = () => { const s = load(); if (s) { s.running = false; save(s); } log('⏹ Dihentikan.'); };
    const s = load(); if (s?.log) p.querySelector('#bgLog').textContent = s.log.join('\n');
    return p;
  }

  function log(msg) {
    const s = load() || { log: [] };
    s.log = [...(s.log || []), msg].slice(-300);
    save(s);
    const p = document.getElementById('bukaGajiPanel');
    if (p) {
      const el = p.querySelector('#bgLog');
      el.textContent = s.log.join('\n');
      el.scrollTop = el.scrollHeight;
    }
    console.log('[BukaGaji]', msg);
  }

  // ---------- Aksi di halaman ----------
  async function search(term) {
    const inp = document.querySelector('input[placeholder="Pencarian"]');
    if (!inp) throw new Error('Kotak pencarian tidak ditemukan');
    inp.value = term;
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    inp.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
    await sleep(DELAY.search);
  }

  // Baris sub kegiatan = <tr> yang punya kode sub kegiatan (x.xx.xx.x.xx.xxxx) + tombol Aksi
  const rowCode = r => (txt(r).match(/\d+\.\d+\.\d+\.\d\.\d+\.\d+/) || [])[0];
  const subRows = () => [...document.querySelectorAll('tbody tr')]
    .filter(r => rowCode(r) && r.querySelector('button[ngbdropdowntoggle]'));

  async function openMenu(row) {
    row.querySelector('button[ngbdropdowntoggle]').click();
    await sleep(DELAY.short);
    // container="body" -> menu dipindah ke <body> saat terbuka
    return [...document.querySelectorAll('button.dropdown-item')].filter(visible);
  }

  async function closeMenu() {
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    document.body.click();
    await sleep(300);
  }

  function lastToast() {
    const t = [...document.querySelectorAll('[class*="toast"], .swal2-popup')].map(txt).filter(Boolean);
    return t.length ? t[t.length - 1] : '';
  }

  // Klik item "Buka <label>" untuk baris berkode `code`. Return: 'dibuka' | 'sudah terbuka' | 'gagal: ...'
  async function bukaItem(term, code, label) {
    checkStop();
    await search(term);
    const row = subRows().find(r => rowCode(r) === code);
    if (!row) return 'gagal: baris hilang setelah dicari ulang';
    const items = await openMenu(row);
    const buka = items.find(b => txt(b) === 'Buka ' + label);
    const kunci = items.find(b => txt(b) === 'Kunci ' + label);
    if (buka) {
      checkStop();
      buka.click();
      await sleep(DELAY.action);
      return 'dibuka' + (lastToast() ? ` (${lastToast()})` : '');
    }
    await closeMenu();
    return kunci ? 'sudah terbuka' : 'gagal: item menu tidak ditemukan';
  }

  async function processSkpd(skpd) {
    const rules = rulesFor(skpd.nama);
    if (!rules) { log(`⏭ ${skpd.nama}: dilewati (aturan)`); return; }

    for (const rule of rules) {
      checkStop();
      await search(rule.search);
      const rows = subRows().filter(r => rule.match.test(txt(r)));
      if (rows.length === 0) { log(`⚠ ${skpd.nama}: "${rule.match.source}" tidak ditemukan`); continue; }
      if (rows.length > MAX_ROWS) { log(`⚠ ${skpd.nama}: ${rows.length} baris cocok, terlalu banyak → dilewati`); continue; }

      const targets = rows.map(r => ({ code: rowCode(r), nama: txt(r.children[1]).replace(/^[\d.]+\s*/, '').slice(0, 60) }));
      for (const t of targets) {
        const a = await bukaItem(rule.search, t.code, 'Sub Kegiatan');
        const b = await bukaItem(rule.search, t.code, 'Rincian Belanja');
        log(`✔ ${skpd.nama} | ${t.code} ${t.nama}\n   Sub: ${a} | Rincian: ${b}`);
      }
    }
  }

  // ---------- Alur antrian ----------
  function go(s, id) {
    s.nav = s.nav?.id === id ? { id, n: s.nav.n + 1 } : { id, n: 1 };
    save(s);
    location.href = BASE + id;
  }

  function nextSkpd(s) {
    s.queue.shift();
    s.nav = null;
    save(s);
    if (s.queue.length) go(s, s.queue[0]);
    else { s.running = false; save(s); log('🏁 Selesai semua SKPD.'); }
  }

  function start() {
    const queue = SKPD.filter(s => rulesFor(s.nama)).map(s => s.id);
    const s = { running: true, queue, nav: null, log: [`▶ Mulai: ${queue.length} SKPD`] };
    save(s);
    go(s, queue[0]);
  }

  function resume() {
    const s = load();
    if (!s?.queue?.length) { log('Tidak ada antrian tersisa. Klik Mulai.'); return; }
    s.running = true; s.nav = null;
    save(s);
    log(`▶ Lanjut: sisa ${s.queue.length} SKPD`);
    go(s, s.queue[0]);
  }

  let busy = false;
  async function tick() {
    if (busy) return;
    const s = load();
    if (!s?.running || !s.queue?.length) return;

    // Bukan di halaman belanja (mis. sesi habis -> login): jeda, jangan redirect terus.
    if (!onPage()) {
      s.running = false; save(s);
      log(`⏸ Dijeda: bukan di halaman Sub Kegiatan Belanja (${location.pathname}). Login/buka halamannya lalu klik "Lanjut".`);
      return;
    }

    const id = s.queue[0];
    const skpd = SKPD.find(x => x.id === id) || { id, nama: 'id_skpd ' + id };
    if (currentId() !== id) {
      if ((s.nav?.id === id ? s.nav.n : 0) >= MAX_NAV) {
        log(`⚠ ${skpd.nama}: halaman tidak bisa dibuka (id_skpd di URL tidak cocok) → dilewati`);
        nextSkpd(s);
      } else go(s, id);
      return;
    }

    busy = true;
    try {
      const ready = await waitFor(() => document.querySelector('input[placeholder="Pencarian"]') && subRows().length);
      await sleep(DELAY.pageReady);

      if (!ready) log(`⚠ ${skpd.nama}: halaman tidak siap / tidak ada sub kegiatan`);
      else {
        try { await processSkpd(skpd); }
        catch (e) {
          if (e instanceof Stopped) return;
          log(`✖ ${skpd.nama}: ${e.message}`);
        }
      }

      const s2 = load();
      if (!s2?.running) return;                       // ditekan Stop saat proses
      nextSkpd(s2);
    } finally {
      busy = false;
    }
  }

  // Tampilkan/sembunyikan panel mengikuti navigasi SPA (Angular tidak reload halaman).
  function syncPanel() {
    const p = document.getElementById('bukaGajiPanel');
    if (onPage()) { if (!p) panel(); else p.style.display = 'flex'; }
    else if (p) p.style.display = 'none';
  }

  function init() {
    syncPanel();
    setInterval(syncPanel, 1000);
    tick();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
