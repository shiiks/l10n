// Realtime-mode end-to-end test against the mock Live API (no API key needed).
//
//   npm i ws playwright && npx playwright install chromium   (once)
//   node test/mock-live.js &                                  (ws://localhost:9001)
//   ./run.sh &                                                (http://localhost:8000)
//   node test/e2e-realtime.js path/to/speech.wav [http://localhost:8000] [ws://localhost:9001]
//
// Phase A streams a file through realtime mode and checks transcripts, audio
// replies, and that the client survived the server's goAway by reconnecting
// with the resume handle. Phase B does the same with Chromium's fake mic and
// checks a clean stop.
const { chromium } = require('playwright');
const path = require('path');

const file = process.argv[2];
const base = process.argv[3] || 'http://localhost:8000';
const mock = process.argv[4] || 'ws://localhost:9001';
if (!file) { console.error('usage: node test/e2e-realtime.js <audio-file> [base-url] [mock-ws-url]'); process.exit(2); }

(async () => {
  const args = [
    '--autoplay-policy=no-user-gesture-required',
    '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
  ];
  if (process.env.E2E_PROXY) {
    args.push(`--proxy-server=${process.env.E2E_PROXY}`, '--proxy-bypass-list=localhost;127.0.0.1', '--ignore-certificate-errors');
  }
  const browser = await chromium.launch({ headless: true, args });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.addInitScript(() => {
    localStorage.setItem('l10n.apiKey', 'test-key');
    localStorage.setItem('l10n.mode', 'realtime');
    localStorage.setItem('l10n.tgt', 'hi');
  });
  await page.goto(`${base}/?rtEndpoint=${encodeURIComponent(mock)}`, { waitUntil: 'load' });

  const snapshot = () => page.evaluate(() => ({
    status: document.getElementById('status').textContent,
    src: [...document.querySelectorAll('#srcFinal .line')].map((l) => l.textContent),
    tgt: [...document.querySelectorAll('#tgtFinal .line')].map((l) => l.textContent),
    stats: window.l10nDebug.state.rt?.stats || null,
    resumeHandle: window.l10nDebug.state.rt?.resumeHandle || null,
  }));

  // Phase A: file source
  await page.click('.tab[data-source="file"]');
  await page.setInputFiles('#fileInput', path.resolve(file));
  await page.waitForTimeout(800);
  await page.evaluate(() => document.getElementById('mediaVideo').play());
  await page.waitForFunction(() => document.querySelectorAll('#tgtFinal .line').length >= 3, null, { timeout: 30000 });
  await page.waitForTimeout(1500);
  const a = await snapshot();

  // Phase B: microphone source (fake device)
  await page.click('.tab[data-source="mic"]');
  const before = a.tgt.length;
  await page.click('#micBtn');
  await page.waitForFunction((n) => document.querySelectorAll('#tgtFinal .line').length >= n + 2, before, { timeout: 20000 });
  const b = await snapshot();
  await page.click('#micBtn');
  await page.waitForTimeout(300);
  const after = await snapshot();
  await browser.close();

  const checks = {
    'file: transcripts shown': a.src.length >= 3,
    'file: translated audio received': a.stats?.audioChunksReceived >= 3,
    'file: survived goAway via resume handle': a.stats?.reconnects >= 1 && !!a.resumeHandle,
    'mic: audio streamed and answered': b.src.length >= before + 2 && b.stats?.chunksSent >= 20,
    'mic: clean stop': after.stats === null && after.status === 'Idle',
    'no page errors': pageErrors.length === 0,
  };
  for (const [name, ok] of Object.entries(checks)) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (pageErrors.length) console.log(pageErrors.join('\n'));
  const ok = Object.values(checks).every(Boolean);
  console.log(ok ? 'REALTIME E2E PASS' : 'REALTIME E2E FAIL');
  process.exit(ok ? 0 : 1);
})();
