// Reference ephemeral-token endpoint for the realtime mode (Node 18+, no deps).
//
// Why: a published copy of the app shouldn't ask every visitor for a Gemini
// API key, and an API key must never ship in page code. The Live API's
// answer is ephemeral tokens: this server holds the key, mints a short-lived
// token per visitor, and the browser connects to the Live API with the token.
// Point ⚙ Settings → "Realtime token endpoint" at this server's /api/token.
//
//   GEMINI_API_KEY=... ALLOW_ORIGIN=https://you.github.io node server/token-server.js
//
// The token is locked to the translate model and response config; the page
// still chooses the target language (the translationConfig field is left
// unlocked, per the Live Translate docs). Add your own authentication and
// rate limiting in front of this before exposing it publicly — the token
// endpoint is exactly as safe as whatever guards it.
const http = require('http');

const KEY = process.env.GEMINI_API_KEY;
const PORT = Number(process.env.PORT || 8787);
const ORIGIN = process.env.ALLOW_ORIGIN || '*';
const MODEL = process.env.MODEL || 'gemini-3.5-live-translate-preview';
const PER_MINUTE = Number(process.env.TOKENS_PER_MINUTE_PER_IP || 10);

if (!KEY) { console.error('GEMINI_API_KEY is required'); process.exit(1); }

const recent = new Map(); // ip → timestamps of recent mints

function rateLimited(ip) {
  const now = Date.now();
  const list = (recent.get(ip) || []).filter((t) => now - t < 60000);
  if (list.length >= PER_MINUTE) return true;
  list.push(now);
  recent.set(ip, list);
  return false;
}

async function mintToken() {
  const now = Date.now();
  const body = {
    uses: 1,
    expireTime: new Date(now + 30 * 60 * 1000).toISOString(),
    newSessionExpireTime: new Date(now + 2 * 60 * 1000).toISOString(),
    // API-reference wire shape (what the official SDKs send): lock these
    // setup fields; everything else — notably translationConfig — comes
    // from the page's own setup message.
    bidiGenerateContentSetup: {
      model: `models/${MODEL}`,
      generationConfig: { responseModalities: ['AUDIO'] },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      sessionResumption: {},
    },
    fieldMask: 'model,generationConfig.responseModalities,inputAudioTranscription,outputAudioTranscription,sessionResumption',
  };
  const res = await fetch('https://generativelanguage.googleapis.com/v1beta/auth_tokens', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': KEY },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`auth_tokens ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return { token: data.name, expires_at: data.expireTime || body.expireTime };
}

const cors = {
  'Access-Control-Allow-Origin': ORIGIN,
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type',
};

http.createServer(async (req, res) => {
  const json = (code, obj) => { res.writeHead(code, { ...cors, 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  if (req.method !== 'POST' || req.url !== '/api/token') return json(404, { error: 'not found' });
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
  if (rateLimited(ip)) return json(429, { error: 'too many tokens requested, try again in a minute' });
  try {
    json(200, await mintToken());
  } catch (err) {
    console.error(err.message);
    json(502, { error: 'could not mint a token' });
  }
}).listen(PORT, () => console.log(`token endpoint on http://localhost:${PORT}/api/token (origin ${ORIGIN})`));
