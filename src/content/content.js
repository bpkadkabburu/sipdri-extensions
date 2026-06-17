(function () {
    const ROOT_ID = 'sipd-ext-root';

    const PAGES = [
        {
            pattern:   /\/master\/sub_giat\b/,
            title:     'Sub Kegiatan SIPD-RI',
            btnText:   'Ambil Semua Data Sub Kegiatan',
            action:    'fetchSubGiat',
            sheetName: 'Sub Kegiatan',
            filename:  'sub_kegiatan',
        },
        {
            pattern:   /\/master\/sumber_dana\b/,
            title:     'Sumber Dana SIPD-RI',
            btnText:   'Ambil Semua Data Sumber Dana',
            action:    'fetchSumberDana',
            sheetName: 'Sumber Dana',
            filename:  'sumber_dana',
        },
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
                position: fixed;
                bottom: 20px;
                right: 20px;
                width: 260px;
                background: white;
                z-index: 2147483647;
                border-radius: 10px;
                box-shadow: 0 4px 24px rgba(0,0,0,0.18);
                font-family: 'Segoe UI', Tahoma, sans-serif;
                font-size: 13px;
                color: #1e293b;
                overflow: hidden;
            }

            .ph {
                background: #1e3a5f;
                color: white;
                padding: 10px 14px;
            }
            .ph span { font-size: 13px; font-weight: 700; }

            .body { padding: 12px; display: flex; flex-direction: column; gap: 8px; }

            #btn-fetch {
                width: 100%;
                padding: 10px;
                background: #3b82f6;
                color: white;
                border: none;
                border-radius: 7px;
                font-size: 13px;
                font-weight: 600;
                cursor: pointer;
                font-family: inherit;
            }
            #btn-fetch:hover:not(:disabled) { background: #2563eb; }
            #btn-fetch:disabled { background: #93c5fd; cursor: not-allowed; }

            #progress-wrap {
                display: none;
                background: #e2e8f0;
                border-radius: 4px;
                height: 6px;
                overflow: hidden;
            }
            #progress-bar {
                height: 100%;
                background: #3b82f6;
                width: 0%;
                transition: width 0.2s ease;
            }

            #status {
                font-size: 12px;
                min-height: 16px;
                color: #64748b;
                line-height: 1.4;
            }
            #status.loading { color: #3b82f6; }
            #status.err    { color: #dc2626; }
            #status.ok     { color: #16a34a; }
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
            const bar  = $('progress-bar');
            if (total > 0) {
                wrap.style.display = '';
                bar.style.width = Math.min(100, Math.round(current / total * 100)) + '%';
            } else {
                wrap.style.display = 'none';
                bar.style.width = '0%';
            }
        }

        function exportXlsx(rows, cols) {
            const ws   = XLSX.utils.json_to_sheet(rows, { header: cols });
            const wb   = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(wb, ws, cfg.sheetName);
            const buf  = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
            const blob = new Blob([buf], { type: 'application/octet-stream' });
            const url  = URL.createObjectURL(blob);
            const a    = document.createElement('a');
            a.href     = url;
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

        $('btn-fetch').addEventListener('click', async () => {
            const saved = await new Promise(resolve =>
                chrome.storage.sync.get(['idDaerah', 'tahun'], resolve)
            );

            if (!saved.idDaerah) {
                setStatus('Set ID Daerah di Pengaturan dulu', 'err');
                return;
            }

            const btn = $('btn-fetch');
            btn.disabled = true;
            setStatus('Memulai pengambilan data...', 'loading');
            setProgress(0, 0);

            const PAGE_SIZE  = 100;
            const baseParams = {
                idDaerah: Number(saved.idDaerah),
                tahun:    Number(saved.tahun) || new Date().getFullYear(),
                search:   '',
                length:   PAGE_SIZE,
            };

            try {
                const allRows = [];
                let cols  = [];
                let start = 0;
                let total = null;

                while (true) {
                    const res    = await fetchPage({ ...baseParams, start });
                    const inner  = res?.data;   // { data:[], recordsFiltered, recordsTotal }
                    const rows   = Array.isArray(inner?.data) ? inner.data : [];

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

    // Handle SPA navigation
    const observer = new MutationObserver(update);
    observer.observe(document.body, { childList: true, subtree: false });

    window.addEventListener('popstate', update);

    const _push    = history.pushState.bind(history);
    const _replace = history.replaceState.bind(history);
    history.pushState    = function (...a) { _push(...a);    update(); };
    history.replaceState = function (...a) { _replace(...a); update(); };
})();
