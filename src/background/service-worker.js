// Service worker — SIPD-RI Extensions

// Default-nya storage.session cuma bisa diakses dari background/extension context.
// Izinkan content script baca juga, karena widget di halaman perlu id_daerah/tahun hasil auth/me.
chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' });

// Intersep request ke SIPD (domain lama sipd-ri.* maupun baru sipd.*) untuk menangkap
// header Authorization (Bearer). Nilainya disimpan utuh, termasuk prefix "Bearer ".
chrome.webRequest.onBeforeSendHeaders.addListener(
    (details) => {
        const auth = (details.requestHeaders || []).find((h) => h.name.toLowerCase() === 'authorization');
        if (!auth?.value || !/^Bearer\s+\S/i.test(auth.value)) return;

        chrome.storage.session.set({
            accessToken: auth.value,
            // origin tempat token ditangkap, dipakai sebagai base URL API
            apiOrigin: new URL(details.url).origin,
        }).then(() => refreshAuthMe());
    },
    { urls: ['https://*.kemendagri.go.id/*'] },
    ['requestHeaders', 'extraHeaders']
);

// id_daerah, tahun & id_user diambil dari endpoint profil login SIPD
const AUTH_ME_PATH = '/penganggaran/v1/auth/me';
let authMeInflight = null;

// Ambil profil login; hanya fetch ulang kalau token berubah sejak fetch terakhir (atau force).
async function refreshAuthMe(force = false) {
    const { accessToken, apiOrigin, authMeToken, idDaerah } =
        await chrome.storage.session.get(['accessToken', 'apiOrigin', 'authMeToken', 'idDaerah']);
    if (!accessToken || !apiOrigin) return null;
    if (!force && authMeToken === accessToken && idDaerah) return null;
    if (authMeInflight) return authMeInflight;

    authMeInflight = (async () => {
        try {
            const res = await fetch(apiOrigin + AUTH_ME_PATH, {
                headers: { Authorization: accessToken, Accept: 'application/json' },
                credentials: 'include',
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const json = await res.json();
            const asg = json?.data?.assignment;
            if (!asg?.id_daerah) throw new Error('assignment.id_daerah tidak ada di respon auth/me');

            const info = {
                idDaerah: String(asg.id_daerah),
                tahun: asg.tahun != null ? String(asg.tahun) : '',
                idUser: json.data.user?.id != null ? String(json.data.user.id) : '',
                namaDaerah: asg.nama_daerah || '',
                roleName: asg.role_name || '',
                namaUser: json.data.user?.nama || '',
                authMeToken: accessToken,
            };
            await chrome.storage.session.set(info);
            return info;
        } catch (e) {
            console.warn('[SIPD ext] auth/me gagal:', e.message);
            return null;
        } finally {
            authMeInflight = null;
        }
    })();
    return authMeInflight;
}

// Path saja; origin diambil dari request asli yang tertangkap (apiOrigin),
// fallback ke origin halaman (fetch relatif di page context).
const ACTION_URLS = {
    fetchSubGiat:    '/api/master/sub_giat/list_table',
    // SIPD baru: GET /penganggaran/v1/referensi/sumber-dana?induk=*&page=N&limit=M
    // (id_daerah & tahun ditentukan server dari token login)
    fetchSumberDana: '/penganggaran/v1/referensi/sumber-dana',
    // SIPD baru: GET ?page=N&limit=M (id_daerah & tahun dari token login)
    fetchSkpd:       '/penganggaran/v1/perangkat-daerah',
    // Detail per SKPD (nip_kepala, nama_kepala, pangkat_kepala, status_kepala, id_unit, dll)
    fetchSkpdDetail: (idSkpd) => `/penganggaran/v1/perangkat-daerah/${encodeURIComponent(idSkpd)}`,
    // SIPD baru: GET ?kind=budget&page=N&limit=M
    listSkpdCascading: '/penganggaran/v1/belanja/perangkat-daerah',
    // SIPD baru: GET /penganggaran/v1/belanja/perangkat-daerah/{id_skpd}/sub-kegiatan?page=N&limit=M
    listBelanjaUnit:   (idSkpd) => `/penganggaran/v1/belanja/perangkat-daerah/${encodeURIComponent(idSkpd)}/sub-kegiatan`,
};

async function resolveApi(path) {
    const { apiOrigin } = await chrome.storage.session.get('apiOrigin');
    return apiOrigin ? apiOrigin + path : path;
}

// GET semua halaman dari endpoint SIPD baru (?page=N&limit=M), dijalankan di page context
// supaya Origin & cookies sama seperti request asli. Mengembalikan array semua baris.
async function sipdGetAll(tabId, path, query = {}) {
    const { accessToken } = await chrome.storage.session.get(['accessToken']);
    if (!accessToken) {
        throw new Error('Token belum tersedia. Buka halaman SIPD dan lakukan aktivitas apa saja, lalu coba lagi.');
    }
    const url = await resolveApi(path);

    const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: async (auth, baseUrl, query) => {
            try {
                const LIMIT = 100;
                const MAX_PAGES = 500;
                const allRows = [];
                let prevFirst = null;

                // Ambil array baris & info total dari beberapa kemungkinan bentuk respon
                const pickRows = (j) => {
                    const c = [j?.data, j?.data?.items, j?.data?.data, j?.data?.rows, j?.data?.list, j?.items, j?.rows];
                    return c.find(Array.isArray) || [];
                };
                const pickTotal = (j) => {
                    const m = j?.meta || j?.data?.meta || j?.pagination || j?.data?.pagination || j?.data || j || {};
                    const t = m.total ?? m.total_data ?? m.totalItems ?? m.total_items ?? m.recordsTotal;
                    return Number.isFinite(Number(t)) ? Number(t) : null;
                };

                for (let page = 1; page <= MAX_PAGES; page++) {
                    const u = new URL(baseUrl, location.origin);
                    for (const [k, v] of Object.entries(query || {})) u.searchParams.set(k, String(v));
                    u.searchParams.set('page', String(page));
                    u.searchParams.set('limit', String(LIMIT));

                    const res = await fetch(u.toString(), {
                        method: 'GET',
                        headers: { Authorization: auth, Accept: 'application/json' },
                    });
                    if (!res.ok) {
                        const text = await res.text().catch(() => '');
                        return { ok: false, error: `SIPD HTTP ${res.status} (${u.pathname}): ${text.substring(0, 150)}` };
                    }

                    const json = await res.json();
                    const rows = pickRows(json);
                    if (rows.length === 0) break;

                    // pengaman kalau server mengabaikan parameter page (halaman berulang)
                    const first = JSON.stringify(rows[0]);
                    if (first === prevFirst) break;
                    prevFirst = first;

                    allRows.push(...rows);

                    const total = pickTotal(json);
                    if (total !== null && allRows.length >= total) break;
                    if (total === null && rows.length < LIMIT) break;
                }

                return { ok: true, rows: allRows };
            } catch (e) {
                return { ok: false, error: e.message };
            }
        },
        args: [accessToken, url, query],
    });

    if (!results?.[0]) throw new Error('Gagal menjalankan script di tab');
    if (results[0].error) throw new Error(results[0].error.message || String(results[0].error));
    const r = results[0].result;
    if (!r) throw new Error('executeScript tidak mengembalikan hasil');
    if (!r.ok) throw new Error(r.error);
    return r.rows;
}

// GET detail banyak item sekaligus (paralel terbatas) di page context.
// paths: array path; hasil: array { ok, data | error } dengan urutan sama.
async function sipdGetMany(tabId, paths, concurrency = 5) {
    const { accessToken } = await chrome.storage.session.get(['accessToken']);
    if (!accessToken) {
        throw new Error('Token belum tersedia. Buka halaman SIPD dan lakukan aktivitas apa saja, lalu coba lagi.');
    }
    const urls = await Promise.all(paths.map(resolveApi));

    const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: async (auth, urls, concurrency) => {
            const out = new Array(urls.length);
            let next = 0;
            const worker = async () => {
                while (next < urls.length) {
                    const i = next++;
                    try {
                        const res = await fetch(new URL(urls[i], location.origin).toString(), {
                            headers: { Authorization: auth, Accept: 'application/json' },
                        });
                        if (!res.ok) { out[i] = { ok: false, error: `HTTP ${res.status}` }; continue; }
                        const j = await res.json();
                        // detail bisa langsung objek, atau dibungkus { data: {...} }
                        const d = j && j.data && typeof j.data === 'object' && !Array.isArray(j.data) ? j.data : j;
                        out[i] = { ok: true, data: d };
                    } catch (e) {
                        out[i] = { ok: false, error: e.message };
                    }
                }
            };
            await Promise.all(Array.from({ length: Math.min(concurrency, urls.length) }, worker));
            return out;
        },
        args: [accessToken, urls, concurrency],
    });

    if (!results?.[0]) throw new Error('Gagal menjalankan script di tab');
    if (results[0].error) throw new Error(results[0].error.message || String(results[0].error));
    return results[0].result || [];
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === 'getAuthInfo') {
        (async () => {
            await refreshAuthMe(!!msg.force);
            const r = await chrome.storage.session.get(['idDaerah', 'tahun', 'idUser', 'namaDaerah', 'roleName', 'namaUser']);
            sendResponse(r);
        })().catch(() => sendResponse({}));
        return true;
    }

    if (msg.action === 'getTokenStatus') {
        chrome.storage.session.get(['accessToken'], (result) => {
            sendResponse({ hasToken: !!result.accessToken });
        });
        return true;
    }

    if (msg.action === 'syncSubGiat') {
        const tabId = sender.tab?.id;
        if (!tabId) {
            sendResponse({ success: false, error: 'Tab tidak ditemukan' });
            return;
        }
        handleSyncSubGiat(msg.params, tabId)
            .then(sendResponse)
            .catch((err) => sendResponse({ success: false, error: err.message }));
        return true;
    }

    if (msg.action === 'syncSkpd') {
        const tabId = sender.tab?.id;
        if (!tabId) {
            sendResponse({ success: false, error: 'Tab tidak ditemukan' });
            return;
        }
        handleSyncSkpd(msg.params, tabId)
            .then(sendResponse)
            .catch((err) => sendResponse({ success: false, error: err.message }));
        return true;
    }

    if (msg.action === 'syncSumberDana') {
        const tabId = sender.tab?.id;
        if (!tabId) {
            sendResponse({ success: false, error: 'Tab tidak ditemukan' });
            return;
        }
        handleSyncSumberDana(msg.params, tabId)
            .then(sendResponse)
            .catch((err) => sendResponse({ success: false, error: err.message }));
        return true;
    }

    const apiUrl = ACTION_URLS[msg.action];
    if (apiUrl) {
        const tabId = sender.tab?.id;
        if (!tabId) {
            sendResponse({ success: false, error: 'Tab tidak ditemukan' });
            return;
        }
        handleFetch(msg.params, tabId, apiUrl)
            .then(sendResponse)
            .catch((err) => sendResponse({ success: false, error: err.message }));
        return true;
    }
});

// Bentuk baris SKPD sesuai kolom tabel server lokal (lihat /api/sync/skpd).
// Aturan mengikuti pola data 2024–2026 di server lokal:
// - is_skpd  = id_unit == id_skpd (cadangan: kode_skpd berakhiran .0000)
// - status   = is_skpd ? 'SKPD' : 'Unit SKPD'
// - id_unit  = dari detail SIPD; kalau tidak ada, cari induk: kode_skpd berawalan sama & berakhiran .0000
// - setup_unit = 1, kunci_skpd = 0, posisi = '' (tidak dipakai server, cukup default)
const kodePrefix = (kode) => String(kode || '').replace(/\.[^.]*$/, '');
const isKodeInduk = (kode) => /\.0000$/.test(String(kode || ''));

function mapSkpdRows(rows, idDaerah) {
    // indeks SKPD induk berdasarkan awalan kode, untuk mencari id_unit yang hilang
    const indukByPrefix = new Map();
    for (const r of rows) {
        if (isKodeInduk(r.kode_skpd)) indukByPrefix.set(kodePrefix(r.kode_skpd), r.id_skpd);
    }

    return rows.map((r) => {
        const idUnit = r.id_unit ?? indukByPrefix.get(kodePrefix(r.kode_skpd)) ?? null;
        const isSkpd = idUnit != null
            ? (Number(idUnit) === Number(r.id_skpd) ? 1 : 0)
            : (isKodeInduk(r.kode_skpd) ? 1 : 0);
        return {
            id_skpd: r.id_skpd,
            kode_skpd: r.kode_skpd ?? null,
            nama_skpd: r.nama_skpd ?? null,
            is_skpd: isSkpd,
            status: isSkpd ? 'SKPD' : 'Unit SKPD',
            nama_kepala: r.nama_kepala ?? null,
            nip_kepala: r.nip_kepala ?? null,
            id_daerah: idDaerah ?? null,
            id_unit: idUnit,
            setup_unit: 1,
            kunci_skpd: 0,
            posisi: '',
        };
    });
}

async function handleSyncSkpd(params, tabId) {
    const { idDaerah, tahun, localApiUrl, localToken } = params;

    // Langkah 1: Ambil daftar SKPD dari SIPD (id_daerah & tahun dari token login)
    const list = await sipdGetAll(tabId, ACTION_URLS.fetchSkpd);

    // Langkah 1b: Ambil detail tiap SKPD (data kepala, id_unit, dll) lalu gabungkan dengan baris daftar.
    // Kalau detail gagal, baris daftar tetap dikirim apa adanya.
    const details = await sipdGetMany(tabId, list.map((r) => ACTION_URLS.fetchSkpdDetail(r.id_skpd)));
    const detailErrors = [];
    const merged = list.map((row, i) => {
        const d = details[i];
        if (d?.ok && d.data && typeof d.data === 'object') return { ...row, ...d.data };
        detailErrors.push(`${row.nama_skpd || row.id_skpd}: ${d?.error || 'tidak ada respon'}`);
        return row;
    }).filter((r) => r.id_skpd != null);   // id_skpd wajib (NOT NULL) di server lokal
    const allRows = mapSkpdRows(merged, idDaerah);
    if (detailErrors.length) console.warn('[SIPD ext] detail SKPD gagal:', detailErrors);

    // Langkah 2: POST ke server lokal dari service worker
    // (tidak ada masalah CORS karena service worker tidak punya Origin header seperti browser page)
    const postRes = await fetch(localApiUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-API-Key': localToken,
        },
        body: JSON.stringify({ tahun, data: allRows }),
    });

    if (!postRes.ok) {
        const text = await postRes.text().catch(() => '');
        throw new Error(`Gagal kirim ke server lokal (HTTP ${postRes.status}): ${text.substring(0, 200)}`);
    }

    const postJson = await postRes.json().catch(() => ({}));
    return { success: true, data: { total: allRows.length, response: postJson, detailFailed: detailErrors.length, detailErrors: detailErrors.slice(0, 10) } };
}

async function handleSyncSumberDana(params, tabId) {
    const { tahun, localApiUrl, localToken } = params;

    // Langkah 1: Ambil semua data Sumber Dana dari SIPD (id_daerah & tahun dari token login)
    const allRows = await sipdGetAll(tabId, ACTION_URLS.fetchSumberDana, { induk: '*' });

    // Langkah 2: POST ke server lokal dari service worker
    // (tidak ada masalah CORS karena service worker tidak punya Origin header seperti browser page)
    const postRes = await fetch(localApiUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-API-Key': localToken,
        },
        body: JSON.stringify({ tahun, data: allRows }),
    });

    if (!postRes.ok) {
        const text = await postRes.text().catch(() => '');
        throw new Error(`Gagal kirim ke server lokal (HTTP ${postRes.status}): ${text.substring(0, 200)}`);
    }

    const postJson = await postRes.json().catch(() => ({}));
    return { success: true, data: { total: allRows.length, response: postJson } };
}

async function handleSyncSubGiat(params, tabId) {
    const { tahun, localApiUrl, localToken } = params;

    // Langkah 1: Ambil daftar perangkat daerah (kind=budget = penganggaran)
    const topLevel = await sipdGetAll(tabId, ACTION_URLS.listSkpdCascading, { kind: 'budget' });

    // Respon bertingkat: SKPD induk bisa punya key `unit` berisi unit SKPD di bawahnya
    // (mis. Sekretariat Daerah → Bagian-bagian). Induknya sendiri sering tanpa sub kegiatan,
    // jadi induk + semua unit diratakan jadi satu daftar (tanpa duplikat id_skpd).
    const allUnits = [];
    const seen = new Set();
    const collect = (items) => {
        for (const it of items || []) {
            const id = it?.id_skpd ?? it?.id ?? it?.id_unit;
            if (id != null && !seen.has(String(id))) {
                seen.add(String(id));
                const { unit, ...rest } = it;
                allUnits.push(rest);
            }
            if (Array.isArray(it?.unit)) collect(it.unit);
        }
    };
    collect(topLevel);
    if (allUnits.length === 0) throw new Error('Tidak ada unit SKPD ditemukan');

    // Langkah 2: Per unit — ambil sub kegiatan lalu langsung POST ke server lokal
    let totalRows = 0;
    let failed = 0;
    let skipped = 0;
    const errors = [];

    for (let i = 0; i < allUnits.length; i++) {
        const unit = allUnits[i];
        // hanya lewati unit yang jelas pagunya 0 (field bisa saja tidak ada di API baru)
        if (unit.set_pagu_skpd !== undefined && Number(unit.set_pagu_skpd) === 0) continue;

        const idSkpd = unit.id_skpd ?? unit.id ?? unit.id_unit;
        const namaSkpd = unit.nama_skpd || unit.nama || `SKPD ${idSkpd}`;
        if (idSkpd == null) { failed++; errors.push(`${namaSkpd}: id SKPD tidak ditemukan`); continue; }

        const progress = (phase) => chrome.tabs.sendMessage(tabId, {
            action: 'syncSubGiatProgress',
            namaSkpd,
            unitIndex: i + 1,
            totalUnits: allUnits.length,
            totalRowsSent: totalRows,
            phase,
        });

        progress('fetch');

        let rows;
        try {
            rows = await sipdGetAll(tabId, ACTION_URLS.listBelanjaUnit(idSkpd));
        } catch (e) {
            failed++; errors.push(`${namaSkpd}: ${e.message}`);
            continue;
        }

        // SKPD induk (mis. Sekretariat Daerah) bisa tidak punya sub kegiatan sendiri —
        // sub kegiatannya ada di unit/bagian. Jangan kirim data kosong ke server lokal.
        if (rows.length === 0) { skipped++; progress('done'); continue; }

        const postRes = await fetch(localApiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-API-Key': localToken },
            body: JSON.stringify({ tahun, id_skpd: idSkpd, data: rows }),
        }).catch((e) => ({ ok: false, status: e.message }));

        if (!postRes.ok) {
            const body = postRes.text ? await postRes.text().catch(() => '') : '';
            let detail = body;
            try { const j = JSON.parse(body); detail = j.message || j.error || JSON.stringify(j.errors || j); } catch { /* teks biasa */ }
            failed++; errors.push(`${namaSkpd} (id ${idSkpd}, ${rows.length} baris): server lokal HTTP ${postRes.status}${detail ? ' — ' + String(detail).substring(0, 200) : ''}`);
            continue;
        }

        await postRes.json().catch(() => ({}));
        totalRows += rows.length;
        progress('done');
    }

    if (errors.length) console.warn('[SIPD ext] sync sub kegiatan gagal:', errors);
    return { success: true, data: { total: totalRows, totalUnits: allUnits.length, failed, skipped, errors: errors.slice(0, 10) } };
}

async function handleFetch(params, tabId, apiPath) {
    const apiUrl = await resolveApi(apiPath);
    const { accessToken } = await chrome.storage.session.get(['accessToken']);

    if (!accessToken) {
        return {
            success: false,
            error: 'Token belum tersedia. Buka halaman SIPD-RI dan lakukan aktivitas apa saja, lalu coba lagi.',
        };
    }

    // Jalankan fetch di dalam tab (page context) agar muncul di Network tab
    // dan menggunakan Origin/cookies yang benar seperti request asli user
    const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: async (p, auth, url) => {
            const formData = new FormData();
            formData.append('id_daerah', String(p.idDaerah));
            formData.append('tahun', String(p.tahun));
            formData.append('deleted_data', 'false');
            formData.append('search[value]', p.search || '');
            formData.append('length', String(p.length));
            formData.append('start', String(p.start));

            const headers = { Authorization: auth };

            const res = await fetch(url, {
                method: 'POST',
                headers,
                body: formData,
            });

            if (!res.ok) {
                const text = await res.text().catch(() => '');
                throw new Error(`HTTP ${res.status}${text ? ': ' + text.substring(0, 150) : ''}`);
            }

            return res.json();
        },
        args: [params, accessToken, apiUrl],
    });

    if (!results?.[0]) {
        throw new Error('Gagal menjalankan script di tab');
    }

    if (results[0].error) {
        throw new Error(results[0].error.message || String(results[0].error));
    }

    return { success: true, data: results[0].result };
}
