// Realtime-mode end-to-end test against the mock Live API (no API key needed).
//
//   npm i ws playwright && npx playwright install chromium   (once)
//   node test/mock-live.js &                                  (ws://localhost:9001)
//   ./run.sh &                                                (http://localhost:8000)
//   node test/e2e-realtime.js path/to/speech.wav [http://localhost:8000] [ws://localhost:9001]
//
// Phases: A file source — transcripts with detected language, translated audio,
// and the server's goAway handled make-before-break (replacement socket opened
// with the resume handle before the old one closes); B pausing the video sends
// audioStreamEnd; C changing the target language reuses the session via the
// resume handle; D fake microphone with a clean stop; E ephemeral-token auth
// against the Constrained endpoint; F a quota close (1011) stops retrying with
// a readable error.
const { chromium } = require('playwright');
const path = require('path');

const file = process.argv[2];
const base = process.argv[3] || 'http://localhost:8000';
const mockWs = process.argv[4] || 'ws://localhost:9001';
const mockHttp = mockWs.replace(/^ws/, 'http');
if (!file) { console.error('usage: node test/e2e-realtime.js <audio-file> [base-url] [mock-ws-url]'); process.exit(2); }

const stats = async () => (await (await fetch(`${mockHttp}/stats`)).json()).connections;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const args = [
    '--autoplay-policy=no-user-gesture-required',
    '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
  ];
  if (process.env.E2E_PROXY) {
    args.push(`--proxy-server=${process.env.E2E_PROXY}`, '--proxy-bypass-list=localhost;127.0.0.1', '--ignore-certificate-errors');
  }
  const browser = await chromium.launch({ headless: true, args });
  const pageErrors = [];

  async function openPage(storage, endpoint) {
    const page = await browser.newPage();
    page.on('pageerror', (e) => pageErrors.push(e.message));
    await page.addInitScript((s) => { for (const [k, v] of Object.entries(s)) localStorage.setItem(k, v); }, storage);
    await page.goto(`${base}/?rtEndpoint=${encodeURIComponent(endpoint)}`, { waitUntil: 'load' });
    return page;
  }
  const snapshot = (page) => page.evaluate(() => ({
    status: document.getElementById('status').textContent,
    badge: document.getElementById('detectedLang').textContent,
    usage: document.getElementById('latency').textContent,
    src: [...document.querySelectorAll('#srcFinal .line')].map((l) => l.textContent),
    tgt: [...document.querySelectorAll('#tgtFinal .line:not(.error)')].map((l) => l.textContent),
    errors: [...document.querySelectorAll('#tgtFinal .line.error')].map((l) => l.textContent),
    rt: window.l10nDebug.state.rt ? { stats: window.l10nDebug.state.rt.stats, active: window.l10nDebug.state.rt.active, target: window.l10nDebug.state.rt.opts.targetLang } : null,
  }));
  const playFile = async (page) => {
    await page.click('.tab[data-source="file"]');
    await page.setInputFiles('#fileInput', path.resolve(file));
    await page.waitForTimeout(800);
    await page.evaluate(() => document.getElementById('mediaVideo').play());
  };
  const waitLines = (page, n, timeout = 60000) =>
    page.waitForFunction((n) => document.querySelectorAll('#tgtFinal .line:not(.error)').length >= n, n, { timeout });

  const checks = {};
  const connsBefore = (await stats()).length;

  // --- A: file source, key auth, rollover ------------------------------------
  const page = await openPage({ 'l10n.apiKey': 'test-key', 'l10n.mode': 'realtime', 'l10n.tgt': 'hi', 'l10n.src': 'en' }, mockWs);
  await playFile(page);
  await waitLines(page, 3);
  await sleep(2500);
  const a = await snapshot(page);
  const connsA = (await stats()).slice(connsBefore);
  const first = connsA[0], second = connsA[1];
  checks['A file: transcripts + translations shown'] = a.src.length >= 3 && a.tgt.length >= 3;
  checks['A file: detected language badge'] = /English/.test(a.badge);
  checks['A file: translated audio received'] = a.rt?.stats.audioChunksReceived >= 3;
  checks['A file: usage meter shown'] = /live:.*in.*out/.test(a.usage);
  checks['A file: goAway handled make-before-break'] = !!second && second.resumed && a.rt?.stats.rollovers >= 1 && a.rt?.stats.reconnects === 0
    && first.closedAt !== null && second.openedAt <= first.closedAt;
  checks['A file: transcription config at setup top level'] = !!first && first.fields.includes('inputAudioTranscription');

  // --- B: pause sends audioStreamEnd ------------------------------------------
  await page.evaluate(() => document.getElementById('mediaVideo').pause());
  await sleep(600);
  const bConns = (await stats()).slice(connsBefore);
  const bSnap = await snapshot(page);
  checks['B pause: audioStreamEnd sent'] = bConns.reduce((n, c) => n + c.audioStreamEnds, 0) >= 1 && bSnap.rt?.stats.audioStreamEnds >= 1;
  await page.evaluate(() => document.getElementById('mediaVideo').play());
  await sleep(1200);

  // --- C: target language change reuses the session ---------------------------
  await page.selectOption('#tgtLang', 'ta');
  await page.waitForFunction(() => window.l10nDebug.state.rt?.stats.rollovers >= 2 && window.l10nDebug.state.rt?.ready, null, { timeout: 10000 });
  await sleep(1500);
  const cConns = (await stats()).slice(connsBefore);
  const taConn = cConns.find((c) => c.target === 'ta');
  const cSnap = await snapshot(page);
  checks['C retarget: new connection resumed with handle and target ta'] = !!taConn && taConn.resumed && cSnap.rt?.target === 'ta';
  checks['C retarget: translation continues'] = cSnap.tgt.length > a.tgt.length;

  // --- D: microphone (fake device) + clean stop -------------------------------
  await page.click('.tab[data-source="mic"]');
  const before = (await snapshot(page)).tgt.length;
  await page.click('#micBtn');
  await page.waitForFunction((n) => document.querySelectorAll('#tgtFinal .line:not(.error)').length >= n + 2, before, { timeout: 20000 });
  const d = await snapshot(page);
  await page.click('#micBtn');
  // The session drains for up to ~3 s so the last translation can arrive, then closes.
  await page.waitForFunction(() => window.l10nDebug.state.rt === null, null, { timeout: 6000 });
  const after = await snapshot(page);
  checks['D mic: audio streamed and answered'] = d.rt?.stats.chunksSent >= 20;
  checks['D mic: clean stop'] = after.rt === null && after.status === 'Idle';
  await page.close();

  // --- E: ephemeral-token auth on the Constrained endpoint ---------------------
  const eBefore = (await stats()).length;
  const pageE = await openPage({ 'l10n.apiKey': '', 'l10n.tokenEndpoint': `${mockHttp}/api/token`, 'l10n.mode': 'realtime', 'l10n.tgt': 'es' },
    `${mockWs}/ws/BidiGenerateContentConstrained`);
  await playFile(pageE);
  await waitLines(pageE, 1, 20000);
  const eConn = (await stats())[eBefore];
  checks['E token: connected via access_token on the Constrained path'] = !!eConn && eConn.auth === 'token' && eConn.target === 'es';
  await pageE.close();

  // --- F: quota close stops retrying with a clear error ------------------------
  const fBefore = (await stats()).length;
  const pageF = await openPage({ 'l10n.apiKey': 'quota-key', 'l10n.mode': 'realtime', 'l10n.tgt': 'hi' }, mockWs);
  await playFile(pageF);
  await pageF.waitForFunction(() => [...document.querySelectorAll('#tgtFinal .line.error')].some((l) => /quota/i.test(l.textContent)), null, { timeout: 10000 });
  await sleep(1500);
  const f = await snapshot(pageF);
  const fConns = (await stats()).slice(fBefore);
  checks['F quota: readable error, no retry storm'] = f.rt?.active === false && /Disconnected|not connected/.test(f.status) && fConns.length === 1;
  await pageF.close();

  checks['no page errors'] = pageErrors.length === 0;
  await browser.close();

  for (const [name, ok] of Object.entries(checks)) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  const ok = Object.values(checks).every(Boolean);
  if (!ok) console.log(JSON.stringify({ a, bSnap, cSnap, d, after, f, pageErrors, conns: await (async () => (await stats()).slice(connsBefore))() }, null, 1));
  console.log(ok ? 'REALTIME E2E PASS' : 'REALTIME E2E FAIL');
  process.exit(ok ? 0 : 1);
})();
