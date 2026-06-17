document.addEventListener('DOMContentLoaded', async () => {
    const saved = await chrome.storage.sync.get(['idDaerah', 'tahun', 'speedMultiplier']);
    
    if (saved.idDaerah) document.getElementById('idDaerah').value = saved.idDaerah;
    if (saved.tahun) document.getElementById('tahun').value = saved.tahun;
    if (saved.speedMultiplier) document.getElementById('speedMultiplier').value = saved.speedMultiplier;

    document.getElementById('save-btn').addEventListener('click', async () => {
        const data = {
            idDaerah: document.getElementById('idDaerah').value.trim(),
            tahun: document.getElementById('tahun').value.trim(),
            speedMultiplier: document.getElementById('speedMultiplier').value
        };
        
        await chrome.storage.sync.set(data);
        
        const msg = document.getElementById('saved-msg');
        msg.textContent = '✓ Tersimpan';
        setTimeout(() => { msg.textContent = ''; }, 2500);
    });
});