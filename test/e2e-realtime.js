// Realtime-mode end-to-end test against the mock Live API (no API key needed).
//
//   npm i ws playwright && npx playwright install chromium   (once)
//   node test/mock-live.js &                                  (ws://localhost:9001)
//   ./run.sh &                                                (http://localhost:8000)
//   node test/e2e-realtime.js path/to/speech.wav [http://localhost:8000] [ws://localhost:9001]
//
// Phases: A file source — transcripts with detected language, translated audio,
// the server's goAway handled make-before-break (replacement socket opened
// with the resume handle before the old one closes) and the status wording
// kept; B pausing the video sends audioStreamEnd; C changing the target
// language reuses the session via the resume handle and maps the app's code
// to the model's (zh-CN → zh-Hans); D fake microphone, then Stop waits for a
// late final translation before closing; E ephemeral-token auth against the
// Constrained endpoint; F a quota close (1011) stops retrying with a readable
// error, and re-selecting the file after fixing the key recovers.
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
  const selectFile = async (page) => {
    await page.click('.tab[data-source="file"]');
    await page.setInputFiles('#fileInput', path.resolve(file));
    await page.waitForFunction(() => /Press play|not connected/.test(document.getElementById('status').textContent), null, { timeout: 15000 });
  };
  const play = (page) => page.evaluate(() => document.getElementById('mediaVideo').play());
  const waitLines = (page, n, timeout = 60000) =>
    page.waitForFunction((n) => document.querySelectorAll('#tgtFinal .line:not(.error)').length >= n, n, { timeout });
  const linesNow = (page) => page.evaluate(() => document.querySelectorAll('#tgtFinal .line:not(.error)').length);

  const checks = {};
  const connsBefore = (await stats()).length;

  // --- A: file source, key auth, rollover ------------------------------------
  const page = await openPage({ 'l10n.apiKey': 'test-key', 'l10n.mode': 'realtime', 'l10n.tgt': 'hi', 'l10n.src': 'en' }, mockWs);
  await selectFile(page);
  await play(page);
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
  checks['A file: status keeps the media wording after rollover'] = /Live — translating media|switching over/.test(a.status);
  checks['A file: transcription config at setup top level'] = !!first && first.fields.includes('inputAudioTranscription');

  // --- B: pause sends audioStreamEnd ------------------------------------------
  await page.evaluate(() => document.getElementById('mediaVideo').pause());
  await sleep(800);
  const bConns = (await stats()).slice(connsBefore);
  const bSnap = await snapshot(page);
  checks['B pause: audioStreamEnd sent'] = bConns.reduce((n, c) => n + c.audioStreamEnds, 0) >= 1 && bSnap.rt?.stats.audioStreamEnds >= 1;
  await play(page);
  await sleep(1200);

  // --- C: target language change reuses the session, code mapped ------------
  const beforeC = await linesNow(page);
  await page.selectOption('#tgtLang', 'zh-CN');
  await page.waitForFunction(() => window.l10nDebug.state.rt?.ready && window.l10nDebug.state.rt?.opts.targetLang === 'zh-CN', null, { timeout: 10000 });
  let cConns;
  for (let i = 0; i < 40; i++) { cConns = (await stats()).slice(connsBefore); if (cConns.some((c) => c.target === 'zh-Hans')) break; await sleep(250); }
  await waitLines(page, beforeC + 1, 15000).catch(() => {});
  const zhConn = cConns.find((c) => c.target === 'zh-Hans');
  const cSnap = await snapshot(page);
  checks['C retarget: resumed with handle, code mapped to zh-Hans'] = !!zhConn && zhConn.resumed && cSnap.rt?.target === 'zh-CN';
  checks['C retarget: translation continues'] = cSnap.tgt.length > beforeC;
  await page.close();

  // --- D: microphone (fake device), stop drains the late final translation ----
  const dBefore = (await stats()).length;
  const pageD = await openPage({ 'l10n.apiKey': 'slow-key', 'l10n.mode': 'realtime', 'l10n.tgt': 'hi' }, mockWs);
  await pageD.click('.tab[data-source="mic"]');
  await pageD.click('#micBtn');
  await waitLines(pageD, 2, 20000);
  const d = await snapshot(pageD);
  const atStop = await linesNow(pageD);
  await pageD.click('#micBtn');
  await pageD.waitForFunction(() => /Finishing/.test(document.getElementById('status').textContent), null, { timeout: 3000 }).catch(() => {});
  const draining = await snapshot(pageD);
  await pageD.waitForFunction(() => window.l10nDebug.state.rt === null, null, { timeout: 12000 });
  const after = await snapshot(pageD);
  const dConns = (await stats()).slice(dBefore);
  checks['D mic: audio streamed and answered'] = d.rt?.stats.chunksSent >= 20;
  checks['D mic: stop drains the late final translation before closing'] = /Finishing/.test(draining.status)
    && after.tgt.length === atStop + 1 && after.tgt[after.tgt.length - 1] === 'late final translation'
    && dConns.some((c) => c.audioStreamEnds >= 1);
  checks['D mic: clean stop'] = after.rt === null && after.status === 'Idle';
  await pageD.close();

  // --- E: ephemeral-token auth on the Constrained endpoint ---------------------
  const eBefore = (await stats()).length;
  const pageE = await openPage({ 'l10n.apiKey': '', 'l10n.tokenEndpoint': `${mockHttp}/api/token`, 'l10n.mode': 'realtime', 'l10n.tgt': 'es' },
    `${mockWs}/ws/BidiGenerateContentConstrained`);
  await selectFile(pageE);
  await play(pageE);
  await waitLines(pageE, 1, 20000);
  const eConn = (await stats())[eBefore];
  checks['E token: connected via access_token on the Constrained path'] = !!eConn && eConn.auth === 'token' && eConn.target === 'es';
  await pageE.close();

  // --- F: quota close stops retrying; recovery after fixing the key ------------
  const fBefore = (await stats()).length;
  const pageF = await openPage({ 'l10n.apiKey': 'quota-key', 'l10n.mode': 'realtime', 'l10n.tgt': 'hi' }, mockWs);
  await selectFile(pageF);
  await pageF.waitForFunction(() => [...document.querySelectorAll('#tgtFinal .line.error')].some((l) => /quota/i.test(l.textContent)), null, { timeout: 10000 });
  await sleep(1500);
  const f = await snapshot(pageF);
  const fConns = (await stats()).slice(fBefore);
  checks['F quota: readable error, no retry storm'] = f.rt?.active === false && /Disconnected/.test(f.status) && fConns.length === 1;
  // Fix the key, then simply press play: the dead session is replaced.
  await pageF.evaluate(() => { window.l10nDebug.settings.apiKey = 'test-key'; });
  await play(pageF);
  await waitLines(pageF, 1, 20000).catch(() => {});
  const f2 = await snapshot(pageF);
  const f2Conns = (await stats()).slice(fBefore);
  checks['F quota: pressing play after fixing the key recovers'] = f2Conns.length === 2 && f2Conns[1].key === 'test-key' && f2.rt?.active === true && f2.tgt.length >= 1 && /Live — translating media/.test(f2.status);
  await pageF.close();

  checks['no page errors'] = pageErrors.length === 0;
  await browser.close();

  for (const [name, ok] of Object.entries(checks)) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  const ok = Object.values(checks).every(Boolean);
  if (!ok) console.log(JSON.stringify({ a, bSnap, cSnap, d, draining, after, f, f2, pageErrors, conns: await (async () => (await stats()).slice(connsBefore))() }, null, 1));
  console.log(ok ? 'REALTIME E2E PASS' : 'REALTIME E2E FAIL');
  process.exit(ok ? 0 : 1);
})();
