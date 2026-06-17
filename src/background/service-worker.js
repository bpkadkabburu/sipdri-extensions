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
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === 'getTokenStatus') {
        chrome.storage.session.get(['accessToken', 'apiKey'], (result) => {
            sendResponse({ hasToken: !!result.accessToken });
        });
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
