// End-to-end test: feeds a speech file into the "Video / audio file" source
// and checks that in-browser Whisper transcribes it and a translation appears.
//
//   npm i -g playwright && npx playwright install chromium   (once)
//   ./run.sh &   # or any server on http://localhost:8000
//   node test/e2e.js path/to/speech.wav [http://localhost:8000]
//
// Downloads ~40 MB of Whisper-tiny model weights on first run (browser-cached).

const { chromium } = require('playwright');
const path = require('path');

const file = process.argv[2];
const base = process.argv[3] || 'http://localhost:8000';
if (!file) { console.error('usage: node test/e2e.js <audio-or-video-file> [base-url]'); process.exit(2); }

(async () => {
  const args = ['--autoplay-policy=no-user-gesture-required'];
  if (process.env.E2E_PROXY) {
    args.push(`--proxy-server=${process.env.E2E_PROXY}`, '--proxy-bypass-list=localhost;127.0.0.1', '--ignore-certificate-errors');
  }
  const browser = await chromium.launch({ headless: true, args });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto(base, { waitUntil: 'load' });
  await page.click('.tab[data-source="file"]');
  await page.selectOption('#engineSelect', 'Xenova/whisper-tiny');
  await page.selectOption('#srcLang', 'en');
  await page.selectOption('#tgtLang', 'es');
  await page.setInputFiles('#fileInput', path.resolve(file));
  await page.waitForTimeout(500);
  await page.evaluate(() => document.getElementById('mediaVideo').play());

  const t0 = Date.now();
  let ok = true;
  try {
    await page.waitForFunction(
      () => document.querySelectorAll('#srcFinal .line').length > 0,
      null, { timeout: 480000, polling: 1000 },
    );
    await page.waitForTimeout(8000); // let remaining chunks land
  } catch (_) {
    ok = false;
  }

  const result = await page.evaluate(() => ({
    status: document.getElementById('status').textContent,
    transcript: [...document.querySelectorAll('#srcFinal .line')].map((l) => l.textContent),
    translation: [...document.querySelectorAll('#tgtFinal .line:not(.error)')].map((l) => l.textContent),
    errors: [...document.querySelectorAll('#tgtFinal .line.error')].map((l) => l.textContent),
  }));
  await browser.close();

  console.log(`${ok ? 'PASS' : 'FAIL'} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(JSON.stringify({ ...result, pageErrors: errors }, null, 2));
  process.exit(ok && result.translation.length > 0 ? 0 : 1);
})();
