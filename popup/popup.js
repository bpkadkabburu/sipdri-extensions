document.addEventListener('DOMContentLoaded', () => {
    const statusEl = document.getElementById('token-status');
    const dotEl    = document.getElementById('token-dot');
    const textEl   = document.getElementById('token-text');

    chrome.storage.session.get(['accessToken'], (result) => {
        const hasToken = !!result.accessToken;
        if (hasToken) {
            statusEl.className = 'token-status ok';
            dotEl.className    = 'dot ok';
            textEl.className   = 'ok';
            textEl.textContent = 'Token aktif — siap mengambil data';
        } else {
            statusEl.className = 'token-status no';
            dotEl.className    = 'dot no';
            textEl.className   = '';
            textEl.textContent = 'Token belum tersedia — buka dan gunakan halaman SIPD-RI terlebih dahulu';
        }
    });

    document.getElementById('btn-options').addEventListener('click', () => {
        chrome.runtime.openOptionsPage();
    });
});
