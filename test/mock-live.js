// Mock of Gemini's Live API (BidiGenerateContent) for testing the realtime
// client without an API key. Speaks the same message shapes:
//   client → setup / realtimeInput.audio / realtimeInput.audioStreamEnd
//   server → setupComplete / sessionResumptionUpdate / serverContent{...}
//            / goAway / usageMetadata
// Every 10 audio chunks (~1 s) it answers with a source transcript (with
// languageCode), a 0.3 s tone as "translated speech" plus its transcript,
// generationComplete and turnComplete. After RECYCLE_AT chunks it sends
// goAway and closes 1008 a little later, like the real ~10-minute recycle,
// so a make-before-break client can be seen opening its replacement first.
//
// Also serves, on the same port:
//   POST /api/token   → {token}  (ephemeral-token endpoint; the Constrained
//                        WebSocket path then requires ?access_token=<token>)
//   GET  /stats       → per-connection records for test assertions
// Special API keys: 'quota-key' closes 1011 with a quota message after setup.
//
//   npm i ws && node test/mock-live.js        (listens on ws://localhost:9001)
const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT || 9001);
const RECYCLE_AT = Number(process.env.RECYCLE_AT || 25);
const CLOSE_DELAY_MS = Number(process.env.CLOSE_DELAY_MS || 1500);
const HANDLE = 'resume-handle-1';
const TOKEN = 'mock-ephemeral-token';
// Target codes the real translate model documents (same table the client uses).
const SUPPORTED = new Set(['af', 'ak', 'sq', 'am', 'ar', 'hy', 'az', 'eu', 'be', 'bn', 'bg', 'my', 'ca', 'zh-Hans', 'zh-Hant', 'hr', 'cs', 'da', 'nl', 'en', 'et', 'fil', 'fi', 'fr', 'gl', 'ka', 'de', 'el', 'gu', 'ha', 'he', 'hi', 'hu', 'is', 'id', 'it', 'ja', 'jv', 'kn', 'kk', 'km', 'rw', 'ko', 'lo', 'lv', 'lt', 'mk', 'ms', 'ml', 'mr', 'mn', 'ne', 'no', 'nb', 'fa', 'pl', 'pt-BR', 'pt-PT', 'pa', 'ro', 'ru', 'sr', 'sd', 'si', 'sk', 'sl', 'es', 'su', 'sw', 'sv', 'ta', 'te', 'th', 'tr', 'uk', 'ur', 'uz', 'vi', 'zu']);

function tonePcm24k(seconds, hz = 440) {
  const n = Math.round(24000 * seconds);
  const pcm = new Int16Array(n);
  for (let i = 0; i < n; i++) pcm[i] = Math.round(Math.sin((2 * Math.PI * hz * i) / 24000) * 0.3 * 0x7fff);
  return Buffer.from(pcm.buffer).toString('base64');
}

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};
const connections = [];

const server = http.createServer((req, res) => {
  const json = (code, body) => { res.writeHead(code, { ...cors, 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  if (req.method === 'POST' && req.url === '/api/token') {
    return json(200, { token: TOKEN, expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString() });
  }
  if (req.method === 'GET' && req.url === '/stats') return json(200, { connections });
  json(404, { message: 'not found' });
});

const wss = new WebSocketServer({ server });
console.log(`mock live api on ws://localhost:${PORT}  (token endpoint POST /api/token, stats GET /stats)`);

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://x');
  const constrained = url.pathname.includes('BidiGenerateContentConstrained');
  const key = url.searchParams.get('key');
  const rec = {
    id: connections.length + 1, path: url.pathname,
    auth: constrained ? 'token' : 'key', key,
    target: null, echo: null, resumed: false, fields: [],
    chunks: 0, audioStreamEnds: 0, openedAt: Date.now(), closedAt: null, closeCode: null,
  };
  connections.push(rec);
  const send = (obj) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(obj));
  const log = (m) => console.log(`#${rec.id} ${m}`);
  log(`connected ${rec.auth}${key ? ` key=${key}` : ''} path=${url.pathname}`);

  if (constrained && url.searchParams.get('access_token') !== TOKEN) {
    log('bad or missing access_token'); ws.close(1008, 'invalid token'); return;
  }
  if (!constrained && !key) { log('missing key'); ws.close(1008, 'missing key'); return; }

  let recycled = false, turns = 0;

  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());

    if (msg.setup) {
      const s = msg.setup;
      const tc = s.generationConfig?.translationConfig;
      const transcriptionOk = s.inputAudioTranscription !== undefined && s.outputAudioTranscription !== undefined
        && s.generationConfig?.inputAudioTranscription === undefined; // must be top-level, not in generationConfig
      if (!s.model?.startsWith('models/') || !tc?.targetLanguageCode || !s.generationConfig.responseModalities?.includes('AUDIO') || !transcriptionOk) {
        log(`bad setup ${JSON.stringify(s)}`);
        ws.close(1007, 'invalid setup');
        return;
      }
      if (!SUPPORTED.has(tc.targetLanguageCode)) {
        log(`unsupported target ${tc.targetLanguageCode}`);
        ws.close(1007, `unsupported target language ${tc.targetLanguageCode}`);
        return;
      }
      rec.target = tc.targetLanguageCode;
      rec.echo = !!tc.echoTargetLanguage;
      rec.resumed = s.sessionResumption?.handle === HANDLE;
      rec.fields = Object.keys(s);
      log(`setup ok target=${rec.target} echo=${rec.echo} resumed=${rec.resumed} fields=${rec.fields.join(',')}`);
      send({ setupComplete: {} });
      if (s.sessionResumption) send({ sessionResumptionUpdate: { newHandle: HANDLE, resumable: true } });
      if (key === 'quota-key') {
        setTimeout(() => ws.close(1011, 'You exceeded your current quota, please check your plan and billing details.'), 200);
      }
      return;
    }

    if (msg.realtimeInput?.audioStreamEnd) {
      rec.audioStreamEnds++;
      log('audioStreamEnd');
      if (key === 'slow-key') {
        // Like the real model finishing the last sentence after the input
        // ended: transcript + 2 s of audio, late, and with no completion flag.
        setTimeout(() => {
          send({ serverContent: { inputTranscription: { text: 'late final sentence ', languageCode: 'en' } } });
          send({ serverContent: {
            modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: tonePcm24k(2.0, 330) } }] },
            outputTranscription: { text: 'late final translation', languageCode: rec.target },
          } });
        }, 1200);
      }
      return;
    }

    if (msg.realtimeInput?.audio) {
      const { mimeType, data } = msg.realtimeInput.audio;
      const bytes = Buffer.from(data, 'base64').length;
      if (mimeType !== 'audio/pcm;rate=16000' || bytes % 2 !== 0 || bytes === 0) {
        log(`bad audio chunk mime=${mimeType} bytes=${bytes}`);
        return;
      }
      if (bytes !== 3200) rec.partialChunks = (rec.partialChunks || 0) + 1; // only expected at a flush
      rec.chunks++;
      if (rec.chunks % 10 === 0) {
        turns++;
        send({ serverContent: { inputTranscription: { text: `heard ${bytes}B x10 (turn ${turns}) `, languageCode: 'en' } } });
        send({ serverContent: {
          modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: tonePcm24k(0.3) } }] },
          outputTranscription: { text: `translated turn ${turns}`, languageCode: rec.target },
        } });
        send({ serverContent: { generationComplete: true } });
        send({ serverContent: { turnComplete: true, interactionStatus: 'IDLE' }, usageMetadata: { totalTokenCount: rec.chunks * 25 } });
      }
      if (!recycled && rec.chunks >= RECYCLE_AT) {
        recycled = true;
        log(`recycling connection after ${rec.chunks} chunks (goAway, close in ${CLOSE_DELAY_MS} ms)`);
        send({ goAway: { timeLeft: `${CLOSE_DELAY_MS / 1000}s` } });
        setTimeout(() => ws.close(1008, 'connection expired'), CLOSE_DELAY_MS);
      }
    }
  });

  ws.on('close', (code, reason) => {
    rec.closedAt = Date.now();
    rec.closeCode = code;
    log(`closed ${code} ${reason} after ${rec.chunks} chunks, ${rec.audioStreamEnds} audioStreamEnd`);
  });
});

server.listen(PORT);
