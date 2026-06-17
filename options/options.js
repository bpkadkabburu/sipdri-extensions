document.addEventListener('DOMContentLoaded', async () => {
    const saved = await chrome.storage.sync.get(['idDaerah', 'tahun']);
    if (saved.idDaerah) document.getElementById('idDaerah').value = saved.idDaerah;
    if (saved.tahun) document.getElementById('tahun').value = saved.tahun;

    document.getElementById('save-btn').addEventListener('click', async () => {
        const data = {
            idDaerah: document.getElementById('idDaerah').value.trim(),
            tahun: document.getElementById('tahun').value.trim(),
        };
        await chrome.storage.sync.set(data);
        const msg = document.getElementById('saved-msg');
        msg.textContent = '✓ Tersimpan';
        setTimeout(() => { msg.textContent = ''; }, 2500);
    });
});
