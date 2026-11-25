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

    // Info akun dari /penganggaran/v1/auth/me (diambil service worker)
    chrome.runtime.sendMessage({ action: 'getAuthInfo' }, (r) => {
        if (chrome.runtime.lastError || !r?.idDaerah) return;
        const set = (id, v) => { document.getElementById(id).textContent = v || '-'; };
        set('acc-daerah', r.namaDaerah);
        set('acc-id-daerah', r.idDaerah);
        set('acc-tahun', r.tahun);
        set('acc-user', r.namaUser);
        set('acc-role', r.roleName);
        document.getElementById('account').hidden = false;
    });

    document.getElementById('btn-options').addEventListener('click', () => {
        chrome.runtime.openOptionsPage();
    });
});
