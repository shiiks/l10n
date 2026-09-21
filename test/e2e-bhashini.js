// Bhashini integration e2e against the mock (no credentials needed).
//
//   node test/mock-bhashini.js &                 (http://localhost:9002)
//   ./run.sh &                                   (http://localhost:8000)
//   node test/e2e-bhashini.js path/to/speech.wav [http://localhost:8000] [http://localhost:9002]
//
// Sets Bhashini as speech-to-text engine, translation provider and speech
// output, streams a file through the chunked pipeline, and checks that all
// three stages ran (transcript, translated text, spoken audio) with no errors.
const { chromium } = require('playwright');
const path = require('path');

const file = process.argv[2];
const base = process.argv[3] || 'http://localhost:8000';
const mock = process.argv[4] || 'http://localhost:9002';
if (!file) { console.error('usage: node test/e2e-bhashini.js <audio-file> [base-url] [mock-url]'); process.exit(2); }

(async () => {
  const args = ['--autoplay-policy=no-user-gesture-required', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'];
  if (process.env.E2E_PROXY) {
    args.push(`--proxy-server=${process.env.E2E_PROXY}`, '--proxy-bypass-list=localhost;127.0.0.1', '--ignore-certificate-errors');
  }
  const browser = await chromium.launch({ headless: true, args });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.addInitScript(() => {
    localStorage.setItem('l10n.mode', 'chunked');
    localStorage.setItem('l10n.provider', 'bhashini');
    localStorage.setItem('l10n.tts', 'bhashini');
    localStorage.setItem('l10n.bhashiniUserId', 'mock-user');
    localStorage.setItem('l10n.bhashiniKey', 'mock-key');
    localStorage.setItem('l10n.src', 'hi');
    localStorage.setItem('l10n.tgt', 'ta');
  });
  await page.goto(`${base}/?bhashiniConfigUrl=${encodeURIComponent(mock + '/config')}`, { waitUntil: 'load' });

  const snapshot = () => page.evaluate(() => ({
    status: document.getElementById('status').textContent,
    src: [...document.querySelectorAll('#srcFinal .line')].map((l) => l.textContent),
    tgt: [...document.querySelectorAll('#tgtFinal .line:not(.error)')].map((l) => l.textContent),
    errors: [...document.querySelectorAll('#tgtFinal .line.error')].map((l) => l.textContent),
    speaking: window.l10nDebug.state.speaking,
  }));

  // Phase A: file source through Bhashini ASR → translation → TTS
  await page.click('.tab[data-source="file"]');
  await page.selectOption('#engineSelect', 'bhashini');
  await page.setInputFiles('#fileInput', path.resolve(file));
  await page.waitForTimeout(500);
  await page.evaluate(() => document.getElementById('mediaVideo').play());
  await page.waitForFunction(() => document.querySelectorAll('#tgtFinal .line:not(.error)').length >= 2, null, { timeout: 40000 });
  await page.waitForTimeout(2500); // let TTS playback finish
  const a = await snapshot();

  // Phase B: microphone routed through the media engine (fake mic)
  await page.click('.tab[data-source="mic"]');
  await page.selectOption('#micEngineSelect', 'media');
  const before = a.tgt.length;
  await page.click('#micBtn');
  await page.waitForFunction((n) => document.querySelectorAll('#tgtFinal .line:not(.error)').length >= n + 1, before, { timeout: 40000 });
  const b = await snapshot();
  await page.click('#micBtn');
  await page.waitForTimeout(3000);
  const after = await snapshot();
  await browser.close();

  const checks = {
    'file: Bhashini ASR transcript shown': a.src.length >= 2 && a.src.every((s) => s.startsWith('mock transcript')),
    'file: Bhashini translation shown': a.tgt.length >= 2 && a.tgt.every((s) => s.startsWith('[ta] ')),
    'file: Bhashini TTS played without error': a.errors.length === 0 && !a.speaking,
    'mic via media engine: transcribed + translated': b.src.length > a.src.length && b.tgt.length >= before + 1,
    'mic: clean stop': after.status === 'Idle' && after.errors.length === 0,
    'no page errors': pageErrors.length === 0,
  };
  for (const [name, ok] of Object.entries(checks)) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!Object.values(checks).every(Boolean)) console.log(JSON.stringify({ a, b, after, pageErrors }, null, 2));
  const ok = Object.values(checks).every(Boolean);
  console.log(ok ? 'BHASHINI E2E PASS' : 'BHASHINI E2E FAIL');
  process.exit(ok ? 0 : 1);
})();
