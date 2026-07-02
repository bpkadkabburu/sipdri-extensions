// Service worker — SIPD-RI Extensions

// Intersep request body untuk menangkap id_user (dipakai di list_skpd cascading)
chrome.webRequest.onBeforeRequest.addListener(
    (details) => {
        if (details.method !== 'POST') return;
        const body = details.requestBody;

        // FormData / urlencoded
        let idUser = body?.formData?.id_user?.[0];

        // JSON body
        if (!idUser && body?.raw?.[0]?.bytes) {
            try {
                const text = new TextDecoder().decode(new Uint8Array(body.raw[0].bytes));
                const json = JSON.parse(text);
                if (json.id_user) idUser = String(json.id_user);
            } catch (e) {}
        }

        if (idUser) chrome.storage.session.set({ idUser });
    },
    { urls: ['https://sipd-ri.kemendagri.go.id/api/*'] },
    ['requestBody']
);

// Intersep setiap request ke API SIPD-RI untuk menangkap token auth
chrome.webRequest.onBeforeSendHeaders.addListener(
    (details) => {
        const headers = details.requestHeaders || [];
        const token = headers.find((h) => h.name.toLowerCase() === 'x-access-token');
        const apiKey = headers.find((h) => h.name.toLowerCase() === 'x-api-key');

        const update = {};
        if (token?.value) update.accessToken = token.value;
        if (apiKey?.value) update.apiKey = apiKey.value;

        if (Object.keys(update).length > 0) {
            chrome.storage.session.set(update);
        }
    },
    { urls: ['https://sipd-ri.kemendagri.go.id/api/*'] },
    ['requestHeaders', 'extraHeaders']
);

const ACTION_URLS = {
    fetchSubGiat:    'https://sipd-ri.kemendagri.go.id/api/master/sub_giat/list_table',
    fetchSumberDana: 'https://sipd-ri.kemendagri.go.id/api/master/sumber_dana/listNew',
    fetchSkpd:       'https://sipd-ri.kemendagri.go.id/api/master/skpd/listNew',
    listSkpdCascading: 'https://sipd-ri.kemendagri.go.id/api/renja/sub_bl/list_skpd',
    listBelanjaUnit:   'https://sipd-ri.kemendagri.go.id/api/renja/sub_bl/list_belanja_by_tahun_daerah_unit',
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === 'getTokenStatus') {
        chrome.storage.session.get(['accessToken', 'apiKey'], (result) => {
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

async function handleSyncSkpd(params, tabId) {
    const { accessToken, apiKey } = await chrome.storage.session.get(['accessToken', 'apiKey']);

    if (!accessToken) {
        return {
            success: false,
            error: 'Token belum tersedia. Buka halaman SIPD-RI dan lakukan aktivitas apa saja, lalu coba lagi.',
        };
    }

    const sipdUrl = ACTION_URLS.fetchSkpd;
    const { idDaerah, tahun, localApiUrl, localToken } = params;

    // Langkah 1: Ambil semua data SKPD dari SIPD-RI via page context
    // (harus dari page context agar Origin & cookies SIPD-RI valid)
    const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: async (idDaerah, tahun, token, key, sipdUrl) => {
            try {
                const PAGE_SIZE = 1000;
                const allRows = [];
                let start = 0;

                while (true) {
                    const formData = new FormData();
                    formData.append('id_daerah', String(idDaerah));
                    formData.append('tahun', String(tahun));
                    formData.append('deleted_data', 'true');
                    formData.append('order[0][column]', '0');
                    formData.append('order[0][dir]', 'asc');
                    formData.append('search[value]', '');
                    formData.append('length', String(PAGE_SIZE));
                    formData.append('start', String(start));

                    const headers = { 'x-access-token': token };
                    if (key) headers['x-api-key'] = key;

                    const res = await fetch(sipdUrl, { method: 'POST', headers, body: formData });
                    if (!res.ok) {
                        const text = await res.text().catch(() => '');
                        return { ok: false, error: `SIPD HTTP ${res.status}: ${text.substring(0, 150)}` };
                    }

                    const json = await res.json();
                    const inner = json?.data;
                    const rows = Array.isArray(inner) ? inner : (inner?.data ?? []);
                    const total = inner?.recordsTotal ?? inner?.recordsFiltered ?? null;

                    if (rows.length === 0) break;
                    allRows.push(...rows);
                    start += PAGE_SIZE;
                    if (total !== null && allRows.length >= total) break;
                }

                return { ok: true, rows: allRows };
            } catch (e) {
                return { ok: false, error: e.message };
            }
        },
        args: [idDaerah, tahun, accessToken, apiKey || null, sipdUrl],
    });

    if (!results?.[0]) throw new Error('Gagal menjalankan script di tab');
    if (results[0].error) throw new Error(results[0].error.message || String(results[0].error));

    const scriptResult = results[0].result;
    if (!scriptResult) throw new Error('executeScript tidak mengembalikan hasil');
    if (!scriptResult.ok) throw new Error(scriptResult.error);

    const allRows = scriptResult.rows;

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
    const { accessToken, apiKey, idUser } = await chrome.storage.session.get(['accessToken', 'apiKey', 'idUser']);

    if (!accessToken) {
        return {
            success: false,
            error: 'Token belum tersedia. Buka halaman SIPD-RI dan lakukan aktivitas apa saja, lalu coba lagi.',
        };
    }

    const { idDaerah, tahun, localApiUrl, localToken, isAnggaran } = params;
    const skpdUrl   = ACTION_URLS.listSkpdCascading;
    const belanjaUrl = ACTION_URLS.listBelanjaUnit;

    // Langkah 1: Ambil daftar unit SKPD
    const skpdResult = await chrome.scripting.executeScript({
        target: { tabId },
        func: async (idDaerah, tahun, idUser, token, key, skpdUrl, isAnggaran) => {
            try {
                const allUnits = [];
                let offset = 0;
                const limit = 500;

                while (true) {
                    const fd = new FormData();
                    fd.append('tahun', String(tahun));
                    fd.append('id_daerah', String(idDaerah));
                    fd.append('id_user', String(idUser || 0));
                    fd.append('id_unit', '0');
                    fd.append('id_level', '2');
                    fd.append('search', '');
                    fd.append('limit', String(limit));
                    fd.append('offset', String(offset));
                    fd.append('is_anggaran', String(isAnggaran));

                    const headers = { 'x-access-token': token };
                    if (key) headers['x-api-key'] = key;

                    const res = await fetch(skpdUrl, { method: 'POST', headers, body: fd });
                    if (!res.ok) {
                        const text = await res.text().catch(() => '');
                        return { ok: false, error: `list_skpd HTTP ${res.status}: ${text.substring(0, 150)}` };
                    }

                    const json = await res.json();
                    const rows = json?.data ?? [];
                    const total = json?.recordsTotal ?? json?.recordsFiltered ?? null;

                    if (rows.length === 0) break;
                    allUnits.push(...rows);
                    offset += limit;
                    if (total !== null && allUnits.length >= total) break;
                }

                return { ok: true, units: allUnits };
            } catch (e) {
                return { ok: false, error: e.message };
            }
        },
        args: [idDaerah, tahun, idUser || 0, accessToken, apiKey || null, skpdUrl, isAnggaran ?? 1],
    });

    if (!skpdResult?.[0]) throw new Error('Gagal menjalankan script di tab');
    if (skpdResult[0].error) throw new Error(skpdResult[0].error.message || String(skpdResult[0].error));
    const skpdData = skpdResult[0].result;
    if (!skpdData?.ok) throw new Error(skpdData?.error || 'Gagal ambil daftar unit SKPD');

    const allUnits = skpdData.units;
    if (allUnits.length === 0) throw new Error('Tidak ada unit SKPD ditemukan');

    // Langkah 2: Per unit — ambil sub kegiatan lalu langsung POST ke server lokal
    let totalRows = 0;
    let failed = 0;

    for (let i = 0; i < allUnits.length; i++) {
        const unit = allUnits[i];
        if ((unit.set_pagu_skpd ?? 0) === 0) continue;

        const namaSkpd = unit.nama_skpd || `Unit ${unit.id_unit}`;

        chrome.tabs.sendMessage(tabId, {
            action: 'syncSubGiatProgress',
            namaSkpd,
            unitIndex: i + 1,
            totalUnits: allUnits.length,
            totalRowsSent: totalRows,
            phase: 'fetch',
        });

        const belanjaResult = await chrome.scripting.executeScript({
            target: { tabId },
            func: async (idDaerah, tahun, idUnit, token, key, belanjaUrl, isAnggaran) => {
                try {
                    const fd = new FormData();
                    fd.append('tahun', String(tahun));
                    fd.append('id_daerah', String(idDaerah));
                    fd.append('id_unit', String(idUnit));
                    fd.append('is_prop', '0');
                    fd.append('is_anggaran', String(isAnggaran));

                    const headers = { 'x-access-token': token };
                    if (key) headers['x-api-key'] = key;

                    const res = await fetch(belanjaUrl, { method: 'POST', headers, body: fd });
                    if (!res.ok) {
                        const text = await res.text().catch(() => '');
                        return { ok: false, error: `HTTP ${res.status}: ${text.substring(0, 100)}` };
                    }

                    const json = await res.json();
                    return { ok: true, rows: json?.data ?? [] };
                } catch (e) {
                    return { ok: false, error: e.message };
                }
            },
            args: [idDaerah, tahun, unit.id_skpd, accessToken, apiKey || null, belanjaUrl, isAnggaran ?? 1],
        });

        const belanjaData = belanjaResult?.[0]?.result;
        if (!belanjaData?.ok) { failed++; continue; }

        const postRes = await fetch(localApiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-API-Key': localToken },
            body: JSON.stringify({ tahun, id_skpd: unit.id_skpd, data: belanjaData.rows }),
        });

        if (!postRes.ok) { failed++; continue; }

        await postRes.json().catch(() => ({}));
        totalRows += belanjaData.rows.length;

        chrome.tabs.sendMessage(tabId, {
            action: 'syncSubGiatProgress',
            namaSkpd,
            unitIndex: i + 1,
            totalUnits: allUnits.length,
            totalRowsSent: totalRows,
            phase: 'done',
        });
    }

    return { success: true, data: { total: totalRows, totalUnits: allUnits.length, failed } };
}

async function handleFetch(params, tabId, apiUrl) {
    const { accessToken, apiKey } = await chrome.storage.session.get(['accessToken', 'apiKey']);

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
        func: async (p, token, key, url) => {
            const formData = new FormData();
            formData.append('id_daerah', String(p.idDaerah));
            formData.append('tahun', String(p.tahun));
            formData.append('deleted_data', 'false');
            formData.append('search[value]', p.search || '');
            formData.append('length', String(p.length));
            formData.append('start', String(p.start));

            const headers = { 'x-access-token': token };
            if (key) headers['x-api-key'] = key;

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
        args: [params, accessToken, apiKey || null, apiUrl],
    });

    if (!results?.[0]) {
        throw new Error('Gagal menjalankan script di tab');
    }

    if (results[0].error) {
        throw new Error(results[0].error.message || String(results[0].error));
    }

    return { success: true, data: results[0].result };
}
