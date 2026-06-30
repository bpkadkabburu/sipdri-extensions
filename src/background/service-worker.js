// Service worker — SIPD-RI Extensions

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
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === 'getTokenStatus') {
        chrome.storage.session.get(['accessToken', 'apiKey'], (result) => {
            sendResponse({ hasToken: !!result.accessToken });
        });
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
            'Authorization': `Bearer ${localToken}`,
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
