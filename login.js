require('dotenv').config();
const puppeteer = require('puppeteer');
const fs = require('fs');
const { solveCaptcha } = require('./captcha-solver');

// ─── Configuration ───────────────────────────────────────
const CONFIG = {
    username: process.env.SIPD_USERNAME,
    password: process.env.SIPD_PASSWORD,
    provinsi: process.env.SIPD_PROVINSI || 'Maluku',
    kabupaten: process.env.SIPD_KABUPATEN || 'Kab. Buru',
    tahun: process.env.SIPD_TAHUN || '2026',
    loginUrl: 'https://sipd-ri.kemendagri.go.id/auth/login',
    cookiesFile: 'cookies.json',
    maxCaptchaAttempts: 5,
    headless: false,
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function log(message) {
    const time = new Date().toLocaleTimeString('id-ID');
    console.log(`[${time}] ${message}`);
}

// ─── Select from typeahead dropdown ──────────────────────
async function selectTypeahead(page, inputSelector, searchText, optionText) {
    log(`Selecting "${optionText}" from ${inputSelector}...`);

    await page.click(inputSelector);
    await delay(300);

    // Clear existing value
    await page.keyboard.down('Control');
    await page.keyboard.press('a');
    await page.keyboard.up('Control');
    await page.keyboard.press('Backspace');
    await delay(300);

    // Type search text
    await page.type(inputSelector, searchText, { delay: 100 });

    // Wait for dropdown
    log('  Waiting for dropdown options...');
    await page.waitForSelector('ngb-typeahead-window button', { timeout: 15000 });
    await delay(800);

    // Get all dropdown buttons via Puppeteer element handles
    const buttons = await page.$$('ngb-typeahead-window button');
    let clicked = false;

    // First: try exact match
    for (const btn of buttons) {
        const text = await page.evaluate((el) => el.textContent.trim(), btn);
        const textLower = text.toLowerCase();
        const optLower = optionText.toLowerCase();
        if (textLower === optLower ||
            textLower === `provinsi ${optLower}` ||
            textLower === `kab. ${optLower}` ||
            textLower === optLower.replace('kab. ', '')) {
            log(`  Found exact match: "${text}"`);
            await btn.click();
            clicked = true;
            break;
        }
    }

    // Second: shortest text containing the option
    if (!clicked) {
        let bestBtn = null;
        let bestLen = Infinity;
        for (const btn of buttons) {
            const text = await page.evaluate((el) => el.textContent.trim(), btn);
            if (text.toLowerCase().includes(optionText.toLowerCase()) && text.length < bestLen) {
                bestBtn = btn;
                bestLen = text.length;
            }
        }
        if (bestBtn) {
            const text = await page.evaluate((el) => el.textContent.trim(), bestBtn);
            log(`  Found best match: "${text}"`);
            await bestBtn.click();
            clicked = true;
        }
    }

    if (!clicked) {
        throw new Error(`Could not find option "${optionText}" in dropdown`);
    }

    // Wait for dropdown to close
    log('  Waiting for dropdown to close...');
    try {
        await page.waitForFunction(
            () => !document.querySelector('ngb-typeahead-window'),
            { timeout: 5000 }
        );
    } catch {
        log('  ⚠ Dropdown still open, clicking elsewhere...');
        await page.click('body');
        await delay(500);
    }

    const inputValue = await page.$eval(inputSelector, (el) => el.value);
    log(`  ✓ Selected (input value: "${inputValue}")`);
    await delay(1500);
}

// ─── Solve CAPTCHA with retry ────────────────────────────
// Modal structure from SIPD-RI:
//   ngb-modal-window > .modal-dialog > .modal-content > app-captcha
//     canvas#captcahCanvas                         ← CAPTCHA image
//     .captcha-actions input[type="text"]           ← user types answer here
//     .captcha-actions input[type="button"][value="Check"] ← Check button
//     a.cpt-btn.reload                             ← Refresh CAPTCHA
async function handleCaptcha(page) {
    log('Waiting for CAPTCHA modal...');

    // Wait for the modal to appear
    await page.waitForSelector('ngb-modal-window', { timeout: 10000 });
    log('  ✓ CAPTCHA modal detected');
    await delay(1500);

    for (let attempt = 1; attempt <= CONFIG.maxCaptchaAttempts; attempt++) {
        log(`CAPTCHA attempt ${attempt}/${CONFIG.maxCaptchaAttempts}...`);

        try {
            // Screenshot the canvas to get CAPTCHA image
            const imageBase64 = await page.evaluate(() => {
                const canvas = document.querySelector('canvas#captcahCanvas') ||
                    document.querySelector('canvas');
                if (canvas) return canvas.toDataURL('image/png').split(',')[1];
                return null;
            });

            if (!imageBase64) throw new Error('No CAPTCHA canvas found');

            const imageBuffer = Buffer.from(imageBase64, 'base64');
            const captchaText = await solveCaptcha(imageBuffer);

            if (captchaText && captchaText.length >= 3) {
                log(`  Typing CAPTCHA answer: "${captchaText}"`);

                // Find and fill the text input
                const captchaInput = await page.$('.captcha-actions input[type="text"]');
                if (!captchaInput) throw new Error('CAPTCHA input not found');

                // Clear and type
                await captchaInput.click({ clickCount: 3 });
                await page.keyboard.press('Backspace');
                await delay(200);
                await captchaInput.type(captchaText, { delay: 50 });

                // Click the Check button (input[type="button"][value="Check"])
                const checkBtn = await page.$('.captcha-actions input[type="button"][value="Check"]');
                if (checkBtn) {
                    await checkBtn.click();
                    log('  ✓ Clicked Check button');
                } else {
                    log('  ⚠ Check button not found, pressing Enter...');
                    await page.keyboard.press('Enter');
                }

                await delay(3000);

                // Check if redirected (login success)
                const currentUrl = page.url();
                if (!currentUrl.includes('/auth/login')) {
                    log(`  ✓ CAPTCHA solved on attempt ${attempt}! Redirected.`);
                    return true;
                }

                // Check if modal is gone
                const modalStill = await page.$('ngb-modal-window');
                if (!modalStill) {
                    log(`  ✓ CAPTCHA solved on attempt ${attempt}! Modal closed.`);
                    await delay(2000);
                    return true;
                }

                // Check for error text in the modal (red text)
                const errorText = await page.evaluate(() => {
                    const el = document.querySelector('ngb-modal-window [style*="color: red"]');
                    return el ? el.textContent.trim() : '';
                });
                if (errorText) {
                    log(`  CAPTCHA error message: "${errorText}"`);
                }
            } else {
                log(`  OCR returned too short/empty: "${captchaText}"`);
            }

            // Failed — refresh CAPTCHA
            log(`  ✗ Attempt ${attempt} failed, refreshing CAPTCHA...`);
            const reloadLink = await page.$('a.cpt-btn.reload');
            if (reloadLink) {
                await reloadLink.click();
                log('  ✓ Clicked reload button');
            } else {
                log('  ⚠ Reload button not found');
            }

            await delay(1500);
        } catch (err) {
            log(`  ✗ Error on attempt ${attempt}: ${err.message}`);
            await delay(1000);
        }
    }

    log('❌ Failed to solve CAPTCHA after max attempts');
    return false;
}

// ─── Select Tahun Anggaran ───────────────────────────────
async function selectTahun(page) {
    log(`Selecting tahun anggaran: ${CONFIG.tahun}...`);
    await delay(2000);

    try {
        const tahunSelected = await page.evaluate((tahun) => {
            const select = document.querySelector('select');
            if (select) {
                for (const option of select.options) {
                    if (option.value === tahun || option.textContent.includes(tahun)) {
                        select.value = option.value;
                        select.dispatchEvent(new Event('change', { bubbles: true }));
                        return true;
                    }
                }
            }
            const allElements = document.querySelectorAll('button, a, div, span, li');
            for (const el of allElements) {
                if (el.textContent.trim() === tahun) { el.click(); return true; }
            }
            return false;
        }, CONFIG.tahun);

        if (tahunSelected) {
            log(`  ✓ Selected tahun ${CONFIG.tahun}`);
            await delay(1000);
            await page.evaluate(() => {
                const buttons = document.querySelectorAll('button');
                for (const btn of buttons) {
                    const text = btn.textContent.toLowerCase().trim();
                    if (text.includes('masuk') || text.includes('submit') || text.includes('lanjut')) {
                        btn.click(); return true;
                    }
                }
            });
            log('  ✓ Clicked Masuk button');
        }
    } catch (err) {
        log(`  ⚠ Tahun selection: ${err.message}`);
    }
    await delay(2000);
}

// ─── Save Cookies ────────────────────────────────────────
async function saveCookies(page) {
    const cookies = await page.cookies();
    fs.writeFileSync(CONFIG.cookiesFile, JSON.stringify(cookies, null, 2));
    log(`✓ Cookies saved to ${CONFIG.cookiesFile} (${cookies.length} cookies)`);
}

// ─── Main Login Flow ─────────────────────────────────────
async function main() {
    console.log('');
    console.log('╔══════════════════════════════════════╗');
    console.log('║   SIPD-RI Login Automation           ║');
    console.log('╚══════════════════════════════════════╝');
    console.log('');

    const browser = await puppeteer.launch({
        headless: CONFIG.headless,
        defaultViewport: { width: 1366, height: 768 },
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1366,768'],
    });

    const page = await browser.newPage();
    await page.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
    );

    try {
        // Step 1: Navigate
        log('Step 1: Navigating to login page...');
        await page.goto(CONFIG.loginUrl, { waitUntil: 'networkidle2', timeout: 30000 });
        log('  ✓ Login page loaded');

        // Step 2: Select Provinsi
        log('Step 2: Select Provinsi...');
        await page.waitForSelector('#prov-autocomplete', { timeout: 10000 });
        await selectTypeahead(page, '#prov-autocomplete', CONFIG.provinsi, CONFIG.provinsi);
        log('  Waiting for kabupaten list to load...');
        await delay(3000);

        // Step 3: Select Kabupaten
        log('Step 3: Select Kabupaten...');
        await page.waitForSelector('#kabkot-autocomplete', { timeout: 15000 });
        await delay(1000);
        await selectTypeahead(page, '#kabkot-autocomplete', CONFIG.kabupaten.replace('Kab. ', ''), CONFIG.kabupaten);
        log('  Waiting for form to stabilize...');
        await delay(3000);

        // Step 4: Input Username (name="email")
        log('Step 4: Input Username...');
        await page.waitForSelector('input[name="email"]', { timeout: 10000 });
        const usernameInput = await page.$('input[name="email"]');
        await usernameInput.click();
        await delay(300);
        await usernameInput.type(CONFIG.username, { delay: 30 });
        const uVal = await page.$eval('input[name="email"]', (el) => el.value);
        log(`  ✓ Username entered: "${uVal}"`);

        // Step 5: Input Password (name="password")
        log('Step 5: Input Password...');
        await page.waitForSelector('input[name="password"]', { timeout: 10000 });
        const passwordInput = await page.$('input[name="password"]');
        await passwordInput.click();
        await delay(300);
        await passwordInput.type(CONFIG.password, { delay: 30 });
        const pVal = await page.$eval('input[name="password"]', (el) => el.value);
        log(`  ✓ Password entered (${pVal.length} chars)`);
        await delay(500);

        // Step 6: Click Login
        log('Step 6: Click Login...');
        await page.click('button.btn-primary');
        log('  ✓ Login button clicked');

        // Step 7: Handle CAPTCHA
        log('Step 7: Handle CAPTCHA...');
        const captchaSolved = await handleCaptcha(page);
        if (!captchaSolved) throw new Error('Failed to solve CAPTCHA');

        // Step 8: Wait for redirect
        log('Waiting for login to complete...');
        await delay(3000);

        // Step 9: Select Tahun Anggaran
        const currentUrl = page.url();
        log(`Current URL: ${currentUrl}`);
        if (currentUrl.includes('auth') || currentUrl.includes('tahun')) {
            await selectTahun(page);
        }

        // Step 10: Verify Dashboard
        await delay(3000);
        const finalUrl = page.url();
        log(`Final URL: ${finalUrl}`);

        if (finalUrl.includes('dashboard') || !finalUrl.includes('login')) {
            log('');
            log('✅ LOGIN SUCCESSFUL! Now on dashboard.');
            await saveCookies(page);
            await page.screenshot({ path: 'dashboard-screenshot.png', fullPage: true });
            log('📸 Dashboard screenshot saved');
        } else {
            log('');
            log('⚠ Login may not have been fully successful.');
            await page.screenshot({ path: 'login-result.png', fullPage: true });
            log('📸 Screenshot saved for debugging');
        }
    } catch (error) {
        console.error(`\n❌ Error: ${error.message}`);
        try {
            await page.screenshot({ path: 'error-screenshot.png', fullPage: true });
            console.error('📸 Error screenshot saved');
        } catch (e) { /* ignore */ }
    } finally {
        if (CONFIG.headless) {
            await browser.close();
        } else {
            log('\nBrowser left open for inspection. Press Ctrl+C to exit.');
        }
    }
}

main().catch(console.error);
