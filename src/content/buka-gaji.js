/*
 * buka-gaji.js — Content script: buka/kunci massal Sub Kegiatan + Rincian Belanja
 * di SIPD (Penganggaran > Sub Kegiatan Belanja), lewat API SIPD baru.
 *
 * Yang bisa diatur user di panel:
 * - Nama/kata kunci sub kegiatan (boleh lebih dari satu, satu per baris). Jadi
 *   kalau diisi "gaji", yang diproses ya sub kegiatan yang namanya memuat
 *   "gaji" (ASN, KDH, dll). Kalau diisi nama sub kegiatan lain, yang diproses
 *   ya itu.
 * - Aksi untuk Sub Kegiatan & Rincian Belanja, masing-masing: Buka / Kunci /
 *   Lewati (dua-duanya tidak boleh "Lewati" sekaligus).
 * - Dinas/SKPD mana saja yang diproses (centang per dinas, ada Pilih Semua /
 *   Hapus Semua + pencarian).
 *
 * Cara kerja (API, tanpa pindah halaman / klik menu):
 * - Per SKPD: GET /penganggaran/v1/belanja/perangkat-daerah/{id_skpd}/sub-kegiatan
 *   (semua halaman) -> cocokkan sub kegiatan yang namanya memuat kata kunci.
 * - Per sub kegiatan cocok: kirim ke /penganggaran/v1/belanja/sub-kegiatan/{id}/kunci
 *     Sub Kegiatan    -> { kunci_bl: 1 | 0 }        (1 = kunci, 0 = buka)
 *     Rincian Belanja -> { kunci_bl_rinci: 1 | 0 }
 *   Kalau data baris sudah menunjukkan status yang sama, dilewati & dicatat
 *   "sudah terbuka"/"sudah terkunci".
 * - Kalau hasil cocok 0 atau terlalu banyak (> MAX_ROWS), kata kunci itu (untuk
 *   SKPD tersebut) dilewati & dicatat di log.
 * - Antrian SKPD + pengaturan disimpan di localStorage; kalau halaman reload saat
 *   berjalan, antrian dilanjutkan otomatis. Tombol Stop dicek sebelum tiap request.
 * - Panel bisa digeser (drag); posisi & pengaturan terakhir diingat.
 */
(() => {
  'use strict';

  // Endpoint API SIPD baru
  const API = {
    subKegiatanSkpd: id => `/penganggaran/v1/belanja/perangkat-daerah/${encodeURIComponent(id)}/sub-kegiatan`,
    kunci: idSubBl => `/penganggaran/v1/belanja/sub-kegiatan/${encodeURIComponent(idSubBl)}/kunci`,
  };
  const PAGE_RE = /\/penganggaran\/anggaran\/cascading\/belanja\b/;
  const KEY = 'bukaGaji_state_v3';            // v3: nambah field `actions` (buka/kunci) & queue dari pilihan dinas
  const TERMS_KEY = 'bukaGaji_terms_v1';      // kata kunci terakhir, diingat lepas dari status antrian
  const ACTIONS_KEY = 'bukaGaji_actions_v1';  // aksi terakhir (sub kegiatan / rincian belanja)
  const SELECTED_KEY = 'bukaGaji_selected_v1'; // id SKPD yang dicentang terakhir
  const POS_KEY = 'bukaGaji_pos_v1';          // posisi panel (hasil drag)
  const MAX_ROWS = 3;          // pengaman: jangan proses massal kalau hasil cocok aneh-aneh
  const DELAY = { action: 300 }; // jeda antar request kunci/buka supaya tidak membanjiri server
  const DEFAULT_TERMS = ['gaji'];
  const DEFAULT_ACTIONS = { subKegiatan: 'buka', rincian: 'buka' };
  // field = nama field payload & status di data baris
  const STEPS = [
    { key: 'subKegiatan', label: 'Sub Kegiatan', field: 'kunci_bl' },
    { key: 'rincian', label: 'Rincian Belanja', field: 'kunci_bl_rinci' },
  ];

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
  const onPage = () => PAGE_RE.test(location.pathname);

  const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) || null; } catch { return null; } };
  const save = s => localStorage.setItem(KEY, JSON.stringify(s));

  // Kata kunci sub kegiatan: satu per baris, trim, buang yang kosong/duplikat.
  function parseTerms(str) {
    const seen = new Set();
    return (str || '').split('\n').map(s => s.trim()).filter(s => {
      if (!s || seen.has(s.toLowerCase())) return false;
      seen.add(s.toLowerCase());
      return true;
    });
  }
  const loadTerms = () => { try { return JSON.parse(localStorage.getItem(TERMS_KEY)) || null; } catch { return null; } };
  const saveTerms = terms => localStorage.setItem(TERMS_KEY, JSON.stringify(terms));

  const loadActions = () => { try { return JSON.parse(localStorage.getItem(ACTIONS_KEY)) || null; } catch { return null; } };
  const saveActions = actions => localStorage.setItem(ACTIONS_KEY, JSON.stringify(actions));

  const loadSelected = () => { try { return JSON.parse(localStorage.getItem(SELECTED_KEY)) || null; } catch { return null; } };
  const saveSelected = ids => localStorage.setItem(SELECTED_KEY, JSON.stringify(ids));

  function loadPos() { try { return JSON.parse(localStorage.getItem(POS_KEY)) || null; } catch { return null; } }
  function savePos(pos) { localStorage.setItem(POS_KEY, JSON.stringify(pos)); }

  class Stopped extends Error {}
  const checkStop = () => { if (!load()?.running) throw new Stopped('Dihentikan'); };

  // ---------- Drag ----------
  function clampPos(el, left, top) {
    const maxLeft = Math.max(0, window.innerWidth - el.offsetWidth - 4);
    const maxTop = Math.max(0, window.innerHeight - el.offsetHeight - 4);
    return { left: Math.min(Math.max(0, left), maxLeft), top: Math.min(Math.max(0, top), maxTop) };
  }
  function applyPos(el, left, top) {
    const p = clampPos(el, left, top);
    el.style.left = p.left + 'px';
    el.style.top = p.top + 'px';
    el.style.right = 'auto';
    el.style.bottom = 'auto';
  }
  function setupDrag(el, handle) {
    let dragging = false, offsetX = 0, offsetY = 0;
    handle.addEventListener('pointerdown', e => {
      dragging = true;
      el.style.transition = 'none';
      el.style.opacity = '0.9';
      const rect = el.getBoundingClientRect();
      offsetX = e.clientX - rect.left;
      offsetY = e.clientY - rect.top;
      handle.setPointerCapture(e.pointerId);
    });
    handle.addEventListener('pointermove', e => {
      if (!dragging) return;
      applyPos(el, e.clientX - offsetX, e.clientY - offsetY);
    });
    function endDrag() {
      if (!dragging) return;
      dragging = false;
      el.style.opacity = '';
      const rect = el.getBoundingClientRect();
      savePos({ left: rect.left, top: rect.top });
    }
    handle.addEventListener('pointerup', endDrag);
    handle.addEventListener('pointercancel', endDrag);
    window.addEventListener('resize', () => {
      const rect = el.getBoundingClientRect();
      applyPos(el, rect.left, rect.top);
    });
  }

  // ---------- Panel: daftar centang dinas/SKPD ----------
  function buildSkpdList(container, selectedIds) {
    const selected = new Set(selectedIds);
    container.innerHTML = '';
    for (const s of SKPD) {
      const row = document.createElement('label');
      row.style.cssText = 'display:flex;gap:6px;align-items:center;font-size:11px;padding:2px 0;cursor:pointer';
      row.dataset.nama = s.nama.toLowerCase();
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.dataset.id = s.id;
      cb.checked = selected.has(s.id);
      const span = document.createElement('span');
      span.textContent = s.nama;
      row.appendChild(cb);
      row.appendChild(span);
      container.appendChild(row);
    }
  }
  const getChecked = container => [...container.querySelectorAll('input[type="checkbox"]')].filter(c => c.checked).map(c => c.dataset.id);

  function panel() {
    let p = document.getElementById('bukaGajiPanel');
    if (p) return p;
    p = document.createElement('div');
    p.id = 'bukaGajiPanel';
    p.style.cssText = 'position:fixed;left:16px;bottom:16px;z-index:2147483647;width:340px;max-height:85vh;' +
      'background:#fff;border-radius:10px;box-shadow:0 4px 24px rgba(0,0,0,.18);' +
      "font:12px/1.4 'Segoe UI',Tahoma,sans-serif;color:#1e293b;display:flex;flex-direction:column;overflow:hidden";
    p.innerHTML =
      '<div id="bgHandle" style="background:#1e3a5f;color:#fff;padding:9px 12px;cursor:move;' +
      'user-select:none;touch-action:none;display:flex;align-items:center;gap:6px;flex:0 0 auto">' +
      '<b style="flex:1;font-size:13px">Buka/Kunci Sub Kegiatan Massal</b></div>' +

      '<div id="bgBody" style="padding:10px 12px;display:flex;flex-direction:column;gap:8px;overflow:auto;flex:1;min-height:0;border-bottom:1px solid #eee">' +

      '<div style="display:flex;flex-direction:column;gap:4px">' +
      '<label style="font-size:11px;color:#64748b">Nama / kata kunci Sub Kegiatan (satu per baris, boleh lebih dari satu)</label>' +
      '<textarea id="bgTerms" rows="3" placeholder="contoh: gaji" style="width:100%;resize:vertical;' +
      "font:12px/1.3 'Segoe UI',Tahoma,sans-serif;padding:6px;border:1px solid #cbd5e1;border-radius:6px;box-sizing:border-box\"></textarea>" +
      '</div>' +

      '<div style="display:flex;gap:6px">' +
      '<div style="flex:1;display:flex;flex-direction:column;gap:3px">' +
      '<label style="font-size:11px;color:#64748b">Sub Kegiatan</label>' +
      '<select id="bgActSub" style="width:100%;padding:5px;border:1px solid #cbd5e1;border-radius:6px;box-sizing:border-box">' +
      '<option value="buka">Buka</option><option value="kunci">Kunci</option><option value="lewati">Lewati</option>' +
      '</select></div>' +
      '<div style="flex:1;display:flex;flex-direction:column;gap:3px">' +
      '<label style="font-size:11px;color:#64748b">Rincian Belanja</label>' +
      '<select id="bgActRincian" style="width:100%;padding:5px;border:1px solid #cbd5e1;border-radius:6px;box-sizing:border-box">' +
      '<option value="buka">Buka</option><option value="kunci">Kunci</option><option value="lewati">Lewati</option>' +
      '</select></div>' +
      '</div>' +

      '<details id="bgSkpdWrap" style="border:1px solid #e2e8f0;border-radius:6px">' +
      '<summary style="padding:6px 8px;cursor:pointer;font-size:11px;color:#334155">' +
      'Dinas/SKPD: <span id="bgSkpdCount">-</span> dipilih</summary>' +
      '<div style="padding:6px 8px;border-top:1px solid #e2e8f0;display:flex;flex-direction:column;gap:6px">' +
      '<input id="bgSkpdFilter" placeholder="Cari dinas..." style="width:100%;padding:5px;border:1px solid #cbd5e1;border-radius:6px;box-sizing:border-box" />' +
      '<div style="display:flex;gap:6px">' +
      '<button id="bgSkpdAll" type="button" style="flex:1;padding:4px;border:1px solid #cbd5e1;border-radius:6px;background:#fff;cursor:pointer">Pilih Semua</button>' +
      '<button id="bgSkpdNone" type="button" style="flex:1;padding:4px;border:1px solid #cbd5e1;border-radius:6px;background:#fff;cursor:pointer">Hapus Semua</button>' +
      '</div>' +
      '<div id="bgSkpdList" style="max-height:150px;overflow:auto;display:flex;flex-direction:column;gap:2px"></div>' +
      '</div></details>' +

      '<div style="display:flex;gap:6px">' +
      '<button id="bgStart" style="flex:1;padding:7px;border:none;border-radius:6px;background:#3b82f6;color:#fff;font-weight:600;cursor:pointer">Mulai</button>' +
      '<button id="bgResume" style="flex:1;padding:7px;border:none;border-radius:6px;background:#64748b;color:#fff;font-weight:600;cursor:pointer">Lanjut</button>' +
      '<button id="bgStop" style="flex:1;padding:7px;border:none;border-radius:6px;background:#dc2626;color:#fff;font-weight:600;cursor:pointer">Stop</button>' +
      '</div>' +

      '</div>' + // #bgBody

      '<div id="bgLog" style="padding:8px 12px;max-height:160px;overflow:auto;white-space:pre-wrap;font-size:11px;line-height:1.5;color:#475569;flex:0 0 auto"></div>';
    document.body.appendChild(p);

    const runningState = load();

    // Kata kunci
    const termsEl = p.querySelector('#bgTerms');
    termsEl.value = (runningState?.terms || loadTerms() || DEFAULT_TERMS).join('\n');
    termsEl.addEventListener('input', () => saveTerms(parseTerms(termsEl.value)));

    // Aksi
    const actions = runningState?.actions || loadActions() || DEFAULT_ACTIONS;
    const subSel = p.querySelector('#bgActSub');
    const rincianSel = p.querySelector('#bgActRincian');
    subSel.value = actions.subKegiatan || 'buka';
    rincianSel.value = actions.rincian || 'buka';
    const onActionChange = () => saveActions({ subKegiatan: subSel.value, rincian: rincianSel.value });
    subSel.addEventListener('change', onActionChange);
    rincianSel.addEventListener('change', onActionChange);

    // Dinas/SKPD
    const skpdList = p.querySelector('#bgSkpdList');
    const skpdCount = p.querySelector('#bgSkpdCount');
    const allIds = SKPD.map(s => s.id);
    // Centang ikut pilihan terakhir yang disimpan user (bukan sisa antrian yang sedang/sudah berjalan).
    const initialSelected = loadSelected() || allIds;
    buildSkpdList(skpdList, initialSelected);
    const updateSkpdCount = () => {
      const n = getChecked(skpdList).length;
      skpdCount.textContent = `${n}/${SKPD.length}`;
    };
    updateSkpdCount();
    skpdList.addEventListener('change', e => {
      if (e.target.matches('input[type="checkbox"]')) { saveSelected(getChecked(skpdList)); updateSkpdCount(); }
    });
    p.querySelector('#bgSkpdAll').onclick = () => {
      skpdList.querySelectorAll('input[type="checkbox"]').forEach(cb => { cb.checked = true; });
      saveSelected(getChecked(skpdList)); updateSkpdCount();
    };
    p.querySelector('#bgSkpdNone').onclick = () => {
      skpdList.querySelectorAll('input[type="checkbox"]').forEach(cb => { cb.checked = false; });
      saveSelected(getChecked(skpdList)); updateSkpdCount();
    };
    p.querySelector('#bgSkpdFilter').addEventListener('input', e => {
      const q = e.target.value.toLowerCase();
      skpdList.querySelectorAll('label').forEach(row => { row.style.display = row.dataset.nama.includes(q) ? '' : 'none'; });
    });

    // Mulai / Lanjut / Stop
    p.querySelector('#bgStart').onclick = () => {
      const terms = parseTerms(termsEl.value);
      if (!terms.length) { alert('Isi dulu nama/kata kunci Sub Kegiatan yang mau diproses.'); return; }

      const act = { subKegiatan: subSel.value, rincian: rincianSel.value };
      if (act.subKegiatan === 'lewati' && act.rincian === 'lewati') {
        alert('Pilih minimal satu aksi: Sub Kegiatan atau Rincian Belanja (jangan "Lewati" keduanya).');
        return;
      }

      const selectedIds = getChecked(skpdList);
      if (!selectedIds.length) { alert('Pilih minimal satu Dinas/SKPD.'); return; }
      const queue = SKPD.filter(s => selectedIds.includes(s.id)).map(s => s.id);

      const ringkasan = `Dinas: ${queue.length} dipilih\n` +
        `Kata kunci: ${terms.join(', ')}\n` +
        `Sub Kegiatan: ${act.subKegiatan} | Rincian Belanja: ${act.rincian}`;
      if (confirm(`Mulai dari awal?\n\n${ringkasan}\n\nAntrian & log sebelumnya akan direset.`)) {
        saveTerms(terms); saveActions(act); saveSelected(selectedIds);
        start(queue, terms, act);
      }
    };
    p.querySelector('#bgResume').onclick = resume;
    p.querySelector('#bgStop').onclick = () => { const s = load(); if (s) { s.running = false; save(s); } log('⏹ Dihentikan.'); };

    if (runningState?.log) p.querySelector('#bgLog').textContent = runningState.log.join('\n');

    const pos = loadPos();
    if (pos) applyPos(p, pos.left, pos.top);
    setupDrag(p, p.querySelector('#bgHandle'));

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

  // ---------- API SIPD ----------
  // Token Bearer ditangkap service worker dari request asli SIPD (storage.session)
  async function getToken() {
    const r = await new Promise(resolve => chrome.storage.session.get(['accessToken'], v => {
      resolve(chrome.runtime.lastError ? {} : v);
    }));
    if (!r.accessToken) throw new Error('Token belum tersedia — klik apa saja di halaman SIPD dulu, lalu Lanjut');
    return r.accessToken;
  }

  async function api(path, { method = 'GET', query, body } = {}) {
    const u = new URL(path, location.origin);
    for (const [k, v] of Object.entries(query || {})) u.searchParams.set(k, String(v));
    const headers = { Authorization: await getToken(), Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(u.toString(), { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    const text = await res.text().catch(() => '');
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* bukan JSON */ }
    return { ok: res.ok, status: res.status, json, text };
  }

  const apiMsg = r => (r.json?.message || r.json?.msg || r.text || '').toString().replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);

  // GET semua halaman (?page=N&limit=M); bentuk respon dicoba beberapa kemungkinan
  async function getAll(path, query = {}) {
    const LIMIT = 100, MAX_PAGES = 200;
    const all = [];
    let prevFirst = null;
    for (let page = 1; page <= MAX_PAGES; page++) {
      checkStop();
      const r = await api(path, { query: { ...query, page, limit: LIMIT } });
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${apiMsg(r)}`);
      const j = r.json;
      const rows = [j?.data, j?.data?.items, j?.data?.data, j?.data?.rows, j?.data?.list, j?.items, j?.rows].find(Array.isArray) || [];
      if (!rows.length) break;
      const first = JSON.stringify(rows[0]);
      if (first === prevFirst) break;              // server mengabaikan page
      prevFirst = first;
      all.push(...rows);
      const m = j?.meta || j?.data?.meta || j?.pagination || j?.data?.pagination || j?.data || j || {};
      const t = Number(m.total ?? m.total_data ?? m.totalItems ?? m.total_items ?? m.recordsTotal);
      if (Number.isFinite(t) && all.length >= t) break;
      if (!Number.isFinite(t) && rows.length < LIMIT) break;
    }
    return all;
  }

  // Ambil id / kode / nama dari baris sub kegiatan (nama field API baru belum pasti)
  const rowId = r => r.id_sub_bl ?? r.id ?? r.id_sub_kegiatan;
  const rowKode = r => r.kode_sub_giat ?? r.kode_sub_kegiatan ?? r.kode ?? '';
  const rowNama = r => String(r.nama_sub_giat ?? r.nama_sub_kegiatan ?? r.nama ?? '').replace(/^[\d.]+\s*/, '');

  // Mode HTTP endpoint kunci belum pasti → coba berurutan, ingat yang berhasil
  let kunciMethod = null;
  async function setKunci(idSubBl, field, value) {
    const methods = kunciMethod ? [kunciMethod] : ['PUT', 'PATCH', 'POST'];
    let last;
    for (const method of methods) {
      last = await api(API.kunci(idSubBl), { method, body: { [field]: value } });
      if (last.status === 405 || (last.status === 404 && !kunciMethod && method !== methods[methods.length - 1])) continue;
      if (last.ok) kunciMethod = method;
      break;
    }
    return last;
  }

  // Jalankan aksi ('buka' | 'kunci') untuk satu step (Sub Kegiatan / Rincian) pada satu baris
  async function applyStep(row, step, action) {
    checkStop();
    const value = action === 'kunci' ? 1 : 0;
    const cur = row[step.field];
    if (cur !== undefined && cur !== null && Number(cur) === value) {
      return action === 'kunci' ? 'sudah terkunci' : 'sudah terbuka';
    }
    const r = await setKunci(rowId(row), step.field, value);
    await sleep(DELAY.action);
    if (!r.ok) return `gagal: HTTP ${r.status}${apiMsg(r) ? ' ' + apiMsg(r) : ''}`;
    const msg = apiMsg(r);
    return (action === 'kunci' ? 'dikunci' : 'dibuka') + (msg ? ` (${msg})` : '');
  }

  // Untuk tiap kata kunci: cocokkan sub kegiatan yang namanya memuat kata kunci itu
  // (case-insensitive) -> jalankan aksi (buka/kunci) yang dipilih untuk Sub Kegiatan
  // dan/atau Rincian Belanja, di tiap baris yang cocok.
  async function processSkpd(skpd, terms, actions) {
    const steps = STEPS.filter(st => (actions?.[st.key] || 'lewati') !== 'lewati');
    if (!steps.length) return;

    const all = await getAll(API.subKegiatanSkpd(skpd.id));
    if (!all.length) { log(`⚠ ${skpd.nama}: tidak ada sub kegiatan`); return; }

    for (const term of terms) {
      checkStop();
      const needle = term.toLowerCase();
      const rows = all.filter(r => `${rowKode(r)} ${rowNama(r)}`.toLowerCase().includes(needle));
      if (rows.length === 0) { log(`⚠ ${skpd.nama}: "${term}" tidak ditemukan`); continue; }
      if (rows.length > MAX_ROWS) { log(`⚠ ${skpd.nama}: "${term}" cocok ${rows.length} baris, terlalu banyak → dilewati`); continue; }

      for (const row of rows) {
        if (rowId(row) == null) { log(`✖ ${skpd.nama} | ${rowNama(row).slice(0, 60)}: id sub kegiatan tidak ditemukan di data`); continue; }
        const results = [];
        for (const st of steps) {
          results.push(`${st.label}: ${await applyStep(row, st, actions[st.key])}`);
        }
        log(`✔ ${skpd.nama} | ${rowKode(row)} ${rowNama(row).slice(0, 60)}\n   ${results.join(' | ')}`);
      }
    }
  }

  // ---------- Alur antrian ----------
  function start(queue, terms, actions) {
    const s = {
      running: true, queue: queue.slice(), terms, actions,
      log: [`▶ Mulai: ${queue.length} SKPD, kata kunci: ${terms.join(', ')}, Sub Kegiatan=${actions.subKegiatan}, Rincian Belanja=${actions.rincian}`],
    };
    save(s);
    run();
  }

  function resume() {
    const s = load();
    if (!s?.queue?.length) { log('Tidak ada antrian tersisa. Atur pengaturan lalu klik Mulai.'); return; }
    s.running = true;
    save(s);
    const actions = s.actions || DEFAULT_ACTIONS;
    log(`▶ Lanjut: sisa ${s.queue.length} SKPD, kata kunci: ${(s.terms || DEFAULT_TERMS).join(', ')}, Sub Kegiatan=${actions.subKegiatan}, Rincian Belanja=${actions.rincian}`);
    run();
  }

  let busy = false;
  async function run() {
    if (busy) return;
    busy = true;
    try {
      while (true) {
        const s = load();
        if (!s?.running) return;
        if (!s.queue?.length) { s.running = false; save(s); log('🏁 Selesai semua SKPD.'); return; }

        const id = s.queue[0];
        const skpd = SKPD.find(x => x.id === id) || { id, nama: 'id_skpd ' + id };
        try {
          await processSkpd(skpd, s.terms || DEFAULT_TERMS, s.actions || DEFAULT_ACTIONS);
        } catch (e) {
          if (e instanceof Stopped) return;
          log(`✖ ${skpd.nama}: ${e.message}`);
          // token habis/tidak ada → jeda supaya tidak menghabiskan antrian dengan error
          if (/Token belum tersedia|HTTP 401|HTTP 403/.test(e.message)) {
            const s3 = load(); if (s3) { s3.running = false; save(s3); }
            log('⏸ Dijeda: sesi/token bermasalah. Login ulang / klik di halaman SIPD, lalu klik "Lanjut".');
            return;
          }
        }

        const s2 = load();
        if (!s2?.running) return;                     // ditekan Stop saat proses
        s2.queue.shift();
        save(s2);
      }
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
    run();   // lanjutkan otomatis kalau halaman reload saat antrian berjalan
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
