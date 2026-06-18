document.addEventListener('DOMContentLoaded', async () => {
    const saved = await chrome.storage.sync.get(['idDaerah', 'tahun', 'speedMultiplier', 'fundRules']);
    
    if (saved.idDaerah) document.getElementById('idDaerah').value = saved.idDaerah;
    if (saved.tahun) document.getElementById('tahun').value = saved.tahun;
    if (saved.speedMultiplier) document.getElementById('speedMultiplier').value = saved.speedMultiplier;

    // ===== ATURAN PENGGANTIAN SUMBER DANA =====
    const rulesContainer = document.getElementById('rules-container');
    const btnAddRule = document.getElementById('btn-add-rule');

    function createRuleRow(search = '', replace = '') {
        const row = document.createElement('div');
        row.className = 'rule-row';
        
        const ruleCount = rulesContainer.querySelectorAll('.rule-row').length + 1;

        row.innerHTML = `
            <div class="rule-fields">
                <div class="rule-field-group">
                    <span class="rule-label search">Cari</span>
                    <input type="text" class="rule-search" value="${escapeHtml(search)}" placeholder="cth: Dana Alokasi Umum">
                </div>
                <div class="rule-field-group">
                    <span class="rule-label replace">Ganti</span>
                    <input type="text" class="rule-replace" value="${escapeHtml(replace)}" placeholder="cth: DAU Bidang Pendidikan">
                </div>
            </div>
            <button type="button" class="btn-remove-rule" title="Hapus aturan ini">✕</button>
            <span class="rule-number">#${ruleCount}</span>
        `;

        row.querySelector('.btn-remove-rule').addEventListener('click', () => {
            row.style.animation = 'none';
            row.style.transition = 'opacity 0.2s, transform 0.2s';
            row.style.opacity = '0';
            row.style.transform = 'translateX(20px)';
            setTimeout(() => {
                row.remove();
                updateRuleNumbers();
            }, 200);
        });

        return row;
    }

    function updateRuleNumbers() {
        const rows = rulesContainer.querySelectorAll('.rule-row');
        rows.forEach((row, i) => {
            row.querySelector('.rule-number').textContent = `#${i + 1}`;
        });
    }

    function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML.replace(/"/g, '&quot;');
    }

    // Load saved rules
    const rules = saved.fundRules || [];
    
    if (rules.length === 0) {
        // Tambahkan default rule bawaan agar user tahu contoh penggunaannya
        rulesContainer.appendChild(createRuleRow('Dana Alokasi Umum', 'DAU yang Ditentukan Penggunaannya Bidang Pendidikan'));
    } else {
        rules.forEach(r => {
            rulesContainer.appendChild(createRuleRow(r.search, r.replace));
        });
    }

    btnAddRule.addEventListener('click', () => {
        rulesContainer.appendChild(createRuleRow());
        updateRuleNumbers();
        // Focus ke input pertama di baris baru
        const newRow = rulesContainer.lastElementChild;
        const firstInput = newRow.querySelector('.rule-search');
        if (firstInput) firstInput.focus();
    });

    // ===== TOMBOL SIMPAN =====
    document.getElementById('save-btn').addEventListener('click', async () => {
        // Kumpulkan aturan sumber dana
        const ruleRows = rulesContainer.querySelectorAll('.rule-row');
        const fundRules = [];
        ruleRows.forEach(row => {
            const search = row.querySelector('.rule-search').value.trim();
            const replace = row.querySelector('.rule-replace').value.trim();
            if (search && replace) {
                fundRules.push({ search, replace });
            }
        });

        const data = {
            idDaerah: document.getElementById('idDaerah').value.trim(),
            tahun: document.getElementById('tahun').value.trim(),
            speedMultiplier: document.getElementById('speedMultiplier').value,
            fundRules: fundRules
        };
        
        await chrome.storage.sync.set(data);
        
        const msg = document.getElementById('saved-msg');
        msg.textContent = `✓ Tersimpan — ${fundRules.length} aturan sumber dana aktif`;
        setTimeout(() => { msg.textContent = ''; }, 3000);
    });
});