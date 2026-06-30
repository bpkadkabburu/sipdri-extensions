(function () {
    const ROOT_ID = 'sipd-ext-root';
    const STATE_KEY = 'sipd_auto_state';

    const PAGES = [
        {
            pattern: /\/master\/sub_giat\b/,
            title: 'Sub Kegiatan SIPD-RI',
            btnText: 'Ambil Semua Data Sub Kegiatan',
            action: 'fetchSubGiat',
            sheetName: 'Sub Kegiatan',
            filename: 'sub_kegiatan',
        },
        {
            pattern: /\/master\/sumber_dana\b/,
            title: 'Sumber Dana SIPD-RI',
            btnText: 'Ambil Semua Data Sumber Dana',
            action: 'fetchSumberDana',
            sheetName: 'Sumber Dana',
            filename: 'sumber_dana',
        },
        {
            pattern: /\/master\/skpd\b/,
            title: 'Sinkronisasi SKPD',
            btnText: 'Sinkronisasi SKPD ke SIPDRI',
            action: 'syncSkpd',
            sheetName: '',
            filename: '',
        },
        {
            pattern: /\/rincian\b|\/belanja\b|\/detail\b|\/jadwal\b|\/sub_giat\b/,
            title: 'Automasi Sumber Dana',
            btnText: 'Mulai Automasi DAU',
            action: 'autoUpdateDAU',
            sheetName: '',
            filename: '',
        }
    ];

    function getPageConfig() {
        return PAGES.find(p => p.pattern.test(window.location.pathname)) || null;
    }

    function removeWidget() {
        const el = document.getElementById(ROOT_ID);
        if (el) el.remove();
    }

    function inject(cfg) {
        const existing = document.getElementById(ROOT_ID);
        if (existing) {
            if (existing.dataset.action === cfg.action) return;
            existing.remove();
        }

        const root = document.createElement('div');
        root.id = ROOT_ID;
        root.dataset.action = cfg.action;
        document.body.appendChild(root);
        const shadow = root.attachShadow({ mode: 'open' });

        const style = document.createElement('style');
        style.textContent = `
            * { box-sizing: border-box; margin: 0; padding: 0; }
            #widget {
                position: fixed; bottom: 20px; right: 20px; width: 260px;
                background: white; z-index: 2147483647; border-radius: 10px;
                box-shadow: 0 4px 24px rgba(0,0,0,0.18);
                font-family: 'Segoe UI', Tahoma, sans-serif; font-size: 13px; color: #1e293b; overflow: hidden;
            }
            .ph { background: #1e3a5f; color: white; padding: 10px 14px; }
            .ph span { font-size: 13px; font-weight: 700; }
            .body { padding: 12px; display: flex; flex-direction: column; gap: 8px; }
            #btn-fetch {
                width: 100%; padding: 10px; background: #3b82f6; color: white;
                border: none; border-radius: 7px; font-size: 13px; font-weight: 600; cursor: pointer;
            }
            #btn-fetch:hover:not(:disabled) { background: #2563eb; }
            #btn-fetch:disabled { background: #93c5fd; cursor: not-allowed; }
            #progress-wrap { display: none; background: #e2e8f0; border-radius: 4px; height: 6px; overflow: hidden; }
            #progress-bar { height: 100%; background: #3b82f6; width: 0%; transition: width 0.2s ease; }
            #status { font-size: 12px; min-height: 16px; color: #64748b; line-height: 1.4; }
            #status.loading { color: #3b82f6; }
            #status.err { color: #dc2626; }
            #status.ok { color: #16a34a; }
        `;

        const widget = document.createElement('div');
        widget.id = 'widget';
        widget.innerHTML = `
            <div class="ph"><span>${cfg.title}</span></div>
            <div class="body">
                <button id="btn-fetch">${cfg.btnText}</button>
                <div id="progress-wrap"><div id="progress-bar"></div></div>
                <div id="status"></div>
            </div>
        `;

        shadow.appendChild(style);
        shadow.appendChild(widget);

        const $ = (id) => shadow.querySelector('#' + id);

        function setStatus(msg, type) {
            const el = $('status');
            el.className = type || '';
            el.textContent = msg;
        }

        function setProgress(current, total) {
            const wrap = $('progress-wrap');
            const bar = $('progress-bar');
            if (total > 0) {
                wrap.style.display = '';
                bar.style.width = Math.min(100, Math.round(current / total * 100)) + '%';
            } else {
                wrap.style.display = 'none';
                bar.style.width = '0%';
            }
        }

        // ==========================================
        // SISTEM KECEPATAN OTOMATIS & ATURAN SUMBER DANA
        // ==========================================
        let speedMultiplier = 1; // Default Normal
        let fundRules = [
            // Default bawaan jika belum ada yang disimpan di settings
            { search: 'Dana Alokasi Umum', replace: 'DAU yang Ditentukan Penggunaannya Bidang Pendidikan' }
        ];
        chrome.storage.sync.get(['speedMultiplier', 'fundRules'], (res) => {
            if (res.speedMultiplier) speedMultiplier = parseFloat(res.speedMultiplier);
            if (res.fundRules && res.fundRules.length > 0) fundRules = res.fundRules;
        });

        // Semua sleep sekarang akan dikalikan dengan opsi di pengaturan!
        // Kalau milih "Ngebut" (0.5), maka 2000ms otomatis jadi 1000ms.
        const sleep = (ms) => new Promise(r => setTimeout(r, ms * speedMultiplier));
        let stopRequested = false;

        async function setPaginatorToMax() {
            if (stopRequested) return;
            const paginatorSelect = document.querySelector('mat-select[aria-label="Items per page:"], mat-select[aria-label*="Items"]');
            if (!paginatorSelect) return;

            const currentText = paginatorSelect.innerText || "";
            if (currentText.includes('2147483647') || currentText.includes('All')) return;

            setStatus('Membuka seluruh baris paginasi...', 'loading');
            paginatorSelect.click();
            await sleep(1000); // Base Normal = 1000ms

            if (stopRequested) return;
            const options = Array.from(document.querySelectorAll('.cdk-overlay-container mat-option, .mat-select-panel mat-option'));
            if (options.length > 0) {
                options[options.length - 1].click();
                await sleep(3000); // Base Normal = 3000ms
            }
        }

        async function startAutomasiDAU() {
            let userInput = prompt("Mulai dari baris ke berapa? (Ketik angkanya saja)", "1");
            let startRow = parseInt(userInput);

            if (isNaN(startRow) || startRow < 1) {
                setStatus('Automasi dibatalkan.', 'err');
                return;
            }

            stopRequested = false;
            sessionStorage.setItem(STATE_KEY, JSON.stringify({ isRunning: true, targetRow: startRow - 1 }));
            resumeAutomasiDAU(true);
        }

        async function resumeAutomasiDAU(isStartingJustNow = false) {
            const stateStr = sessionStorage.getItem(STATE_KEY);
            if (!stateStr) return;

            const state = JSON.parse(stateStr);
            if (!state.isRunning) return;

            const btn = $('btn-fetch');
            if (btn) btn.textContent = 'Stop Automasi';

            try {
                if (!isStartingJustNow) {
                    setStatus('Tabel Ter-refresh! Menunggu sinkronisasi...', 'loading');
                    await sleep(2000); // Base Normal = 2000ms
                }

                if (stopRequested) return;
                await setPaginatorToMax();

                while (true) {
                    if (stopRequested || !sessionStorage.getItem(STATE_KEY)) {
                        setStatus('Automasi Dihentikan oleh User.', 'err');
                        return;
                    }

                    const editBtns = Array.from(document.querySelectorAll('button[ngbtooltip="Ubah Rincian Belanja"]'))
                        .filter(el => el.offsetParent !== null);

                    if (editBtns.length === 0) {
                        setStatus(`Selesai. Tidak menemukan baris lagi.`, 'ok');
                        sessionStorage.removeItem(STATE_KEY);
                        if (btn) btn.textContent = 'Mulai Automasi DAU';
                        return;
                    }

                    if (state.targetRow >= editBtns.length) {
                        setStatus('Automasi Selesai! Semua Baris Berhasil Diproses.', 'ok');
                        sessionStorage.removeItem(STATE_KEY);
                        if (btn) btn.textContent = 'Mulai Automasi DAU';
                        return;
                    }

                    setStatus(`Baris ke-${state.targetRow + 1}/${editBtns.length}`, 'loading');
                    setProgress(state.targetRow, editBtns.length);

                    editBtns[state.targetRow].click();
                    await sleep(1500); // Base Normal = 1500ms

                    if (stopRequested || !sessionStorage.getItem(STATE_KEY)) return;

                    const visibleModal = Array.from(document.querySelectorAll('.modal, .modal-dialog, modal-container'))
                        .find(m => m.offsetParent !== null && window.getComputedStyle(m).display !== 'none');

                    if (!visibleModal) {
                        state.targetRow++;
                        sessionStorage.setItem(STATE_KEY, JSON.stringify(state));
                        continue;
                    }

                    let shouldSave = false;

                    const selectDana = visibleModal.querySelector('select#sumberDana, select[formcontrolname="sumberDana"]');
                    if (selectDana) {
                        const selectedText = selectDana.options[selectDana.selectedIndex]?.innerText || "";
                        const isEmptyOrPlaceholder = selectedText.trim() === "" || selectedText.includes("Pilih");

                        // Cek semua aturan penggantian sumber dana
                        for (const rule of fundRules) {
                            const matchesCurrent = selectedText.includes(rule.search);
                            // Juga cek apakah sudah berisi teks target (supaya tidak re-replace)
                            const alreadyTarget = selectedText.includes(rule.replace);

                            if ((matchesCurrent && !alreadyTarget) || isEmptyOrPlaceholder) {
                                const targetOption = Array.from(selectDana.options).find(o => o.innerText.includes(rule.replace));
                                if (targetOption && selectDana.value !== targetOption.value) {
                                    selectDana.value = targetOption.value;
                                    selectDana.dispatchEvent(new Event('change', { bubbles: true }));
                                    selectDana.dispatchEvent(new Event('input', { bubbles: true }));
                                    shouldSave = true;
                                    await sleep(500); // Base Normal = 500ms
                                    break; // Aturan pertama yang cocok langsung diterapkan
                                }
                            }
                        }
                    }

                    if (shouldSave) {
                        const btnSimpan = visibleModal.querySelector('button.btn-primary, button[type="submit"], button.btn-success');
                        if (btnSimpan) {
                            if (stopRequested || !sessionStorage.getItem(STATE_KEY)) return;

                            state.targetRow++;
                            sessionStorage.setItem(STATE_KEY, JSON.stringify(state));

                            btnSimpan.click();

                            setStatus('Disimpan! Menunggu tabel refresh...', 'loading');
                            await sleep(4000); // Base Normal = 4000ms

                            if (stopRequested || !sessionStorage.getItem(STATE_KEY)) return;
                            resumeAutomasiDAU(false);
                            return;
                        }
                    }

                    const btnBatal = visibleModal.querySelector('button.btn-warning, button.btn-danger, button.btn-default, button[data-dismiss="modal"], .btn-close');
                    if (btnBatal) btnBatal.click();

                    await sleep(2500); // Base Normal = 1000ms

                    if (stopRequested || !sessionStorage.getItem(STATE_KEY)) return;

                    state.targetRow++;
                    sessionStorage.setItem(STATE_KEY, JSON.stringify(state));
                }

            } catch (err) {
                setStatus('Error: ' + err.message, 'err');
                sessionStorage.removeItem(STATE_KEY);
            }
        }

        $('btn-fetch').addEventListener('click', async () => {
            if (cfg.action === 'autoUpdateDAU') {
                const stateStr = sessionStorage.getItem(STATE_KEY);
                if (stateStr && JSON.parse(stateStr).isRunning) {
                    stopRequested = true;
                    sessionStorage.removeItem(STATE_KEY);
                    $('btn-fetch').textContent = 'Mulai Automasi DAU';
                    setStatus('Automasi berhasil dihentikan!', 'err');
                } else {
                    startAutomasiDAU();
                }
                return;
            }

            if (cfg.action === 'syncSkpd') {
                const saved = await new Promise(resolve => chrome.storage.sync.get(['idDaerah', 'tahun', 'localApiUrl', 'localToken'], resolve));

                if (!saved.idDaerah) {
                    setStatus('Set ID Daerah di Pengaturan dulu', 'err');
                    return;
                }
                if (!saved.localApiUrl || !saved.localToken) {
                    setStatus('Set URL & Token API Lokal di Pengaturan dulu', 'err');
                    return;
                }

                const btn = $('btn-fetch');
                btn.disabled = true;
                setStatus('Mengambil data SKPD dari SIPD-RI...', 'loading');
                setProgress(0, 0);

                const tahun = Number(saved.tahun) || new Date().getFullYear();

                try {
                    const res = await new Promise((resolve, reject) => {
                        chrome.runtime.sendMessage({
                            action: 'syncSkpd',
                            params: {
                                idDaerah: Number(saved.idDaerah),
                                tahun,
                                localApiUrl: saved.localApiUrl.replace(/\/$/, '') + '/api/referensi/skpd',
                                localToken: saved.localToken,
                            }
                        }, (r) => {
                            if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
                            else if (!r) reject(new Error('Tidak ada response dari service worker'));
                            else if (!r.success) reject(new Error(r.error || 'Gagal tanpa pesan error'));
                            else resolve(r.data);
                        });
                    });

                    setProgress(1, 1);
                    setStatus(`✓ ${res?.total ?? '?'} SKPD berhasil disinkronisasi`, 'ok');
                } catch (err) {
                    setStatus('Error: ' + err.message, 'err');
                } finally {
                    btn.disabled = false;
                    setTimeout(() => setProgress(0, 0), 3000);
                }
                return;
            }

            // --- KODE FETCH EXCEL BAWAAN ---
            function exportXlsx(rows, cols) {
                const ws = XLSX.utils.json_to_sheet(rows, { header: cols });
                const wb = XLSX.utils.book_new();
                XLSX.utils.book_append_sheet(wb, ws, cfg.sheetName);
                const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
                const blob = new Blob([buf], { type: 'application/octet-stream' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `${cfg.filename}_${new Date().toISOString().slice(0, 10)}.xlsx`;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
            }

            function fetchPage(params) {
                return new Promise((resolve, reject) => {
                    chrome.runtime.sendMessage({ action: cfg.action, params }, (res) => {
                        if (chrome.runtime.lastError) {
                            reject(new Error(chrome.runtime.lastError.message));
                        } else if (!res.success) {
                            reject(new Error(res.error));
                        } else {
                            resolve(res.data);
                        }
                    });
                });
            }

            const saved = await new Promise(resolve => chrome.storage.sync.get(['idDaerah', 'tahun'], resolve));

            if (!saved.idDaerah) {
                setStatus('Set ID Daerah di Pengaturan dulu', 'err');
                return;
            }

            const btn = $('btn-fetch');
            btn.disabled = true;
            setStatus('Memulai pengambilan data...', 'loading');
            setProgress(0, 0);

            const PAGE_SIZE = 100;
            const baseParams = {
                idDaerah: Number(saved.idDaerah),
                tahun: Number(saved.tahun) || new Date().getFullYear(),
                search: '',
                length: PAGE_SIZE,
            };

            try {
                const allRows = [];
                let cols = [];
                let start = 0;
                let total = null;

                while (true) {
                    const res = await fetchPage({ ...baseParams, start });
                    const inner = res?.data;
                    const rows = Array.isArray(inner?.data) ? inner.data : [];

                    if (total === null) total = inner?.recordsTotal ?? inner?.recordsFiltered ?? rows.length;
                    if (rows.length === 0) break;

                    if (cols.length === 0) cols = Object.keys(rows[0]);
                    allRows.push(...rows);
                    start += PAGE_SIZE;

                    setStatus(`Mengambil... ${allRows.length} / ${total}`, 'loading');
                    setProgress(allRows.length, total);

                    if (allRows.length >= total) break;
                }

                if (allRows.length === 0) {
                    setStatus('Tidak ada data ditemukan', 'err');
                    return;
                }

                setProgress(total, total);
                setStatus(`Menyimpan ${allRows.length} data...`, 'loading');
                exportXlsx(allRows, cols);
                setStatus(`✓ ${allRows.length} data berhasil diunduh`, 'ok');
            } catch (err) {
                setStatus('Error: ' + err.message, 'err');
            } finally {
                btn.disabled = false;
                setTimeout(() => setProgress(0, 0), 2000);
            }
        });

        if (cfg.action === 'autoUpdateDAU') {
            const stateStr = sessionStorage.getItem(STATE_KEY);
            if (stateStr && JSON.parse(stateStr).isRunning) {
                resumeAutomasiDAU();
            }
        }
    }

    function update() {
        const cfg = getPageConfig();
        if (cfg) {
            inject(cfg);
        } else {
            removeWidget();
        }
    }

    update();

    const observer = new MutationObserver(update);
    observer.observe(document.body, { childList: true, subtree: false });

    window.addEventListener('popstate', update);

    const _push = history.pushState.bind(history);
    const _replace = history.replaceState.bind(history);
    history.pushState = function (...a) { _push(...a); update(); };
    history.replaceState = function (...a) { _replace(...a); update(); };
})();