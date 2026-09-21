// Mock of Gemini's Live API (BidiGenerateContent) for testing the realtime
// client without an API key. Speaks the same message shapes:
//   client → setup / realtimeInput.audio
//   server → setupComplete / sessionResumptionUpdate / serverContent{...} / goAway
// Every 10 audio chunks (~1 s) it answers with a transcript, a 0.3 s tone as
// "translated speech", and turnComplete. After RECYCLE_AT chunks it sends
// goAway and closes, expecting the client to reconnect with the resume handle.
//
//   npm i ws && node test/mock-live.js        (listens on ws://localhost:9001)
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT || 9001);
const RECYCLE_AT = Number(process.env.RECYCLE_AT || 25);
const HANDLE = 'resume-handle-1';

function tonePcm24k(seconds, hz = 440) {
  const n = Math.round(24000 * seconds);
  const pcm = new Int16Array(n);
  for (let i = 0; i < n; i++) pcm[i] = Math.round(Math.sin((2 * Math.PI * hz * i) / 24000) * 0.3 * 0x7fff);
  return Buffer.from(pcm.buffer).toString('base64');
}

const wss = new WebSocketServer({ port: PORT });
let connections = 0;
console.log(`mock live api on ws://localhost:${PORT}`);

wss.on('connection', (ws, req) => {
  const id = ++connections;
  const key = new URL(req.url, 'http://x').searchParams.get('key');
  let chunks = 0, turns = 0, recycled = false;
  const send = (obj) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(obj));
  console.log(`#${id} connected key=${key}`);

  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());

    if (msg.setup) {
      const s = msg.setup;
      const tgt = s.generationConfig?.translationConfig?.targetLanguageCode;
      if (!s.model?.startsWith('models/') || !tgt || !s.generationConfig.responseModalities?.includes('AUDIO')) {
        console.log(`#${id} bad setup`, JSON.stringify(s));
        ws.close(1007, 'invalid setup');
        return;
      }
      const resumed = s.sessionResumption?.handle === HANDLE;
      console.log(`#${id} setup ok target=${tgt} resumed=${resumed} fields=${Object.keys(s).join(',')}`);
      send({ setupComplete: {} });
      send({ sessionResumptionUpdate: { newHandle: HANDLE, resumable: true } });
      return;
    }

    if (msg.realtimeInput?.audio) {
      const { mimeType, data } = msg.realtimeInput.audio;
      const bytes = Buffer.from(data, 'base64').length;
      if (mimeType !== 'audio/pcm;rate=16000' || bytes % 2 !== 0 || bytes === 0) {
        console.log(`#${id} bad audio chunk mime=${mimeType} bytes=${bytes}`);
        return;
      }
      chunks++;
      if (chunks % 10 === 0) {
        turns++;
        send({ serverContent: { inputTranscription: { text: `heard ${bytes}B x10 (turn ${turns}) ` } } });
        send({ serverContent: {
          modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: tonePcm24k(0.3) } }] },
          outputTranscription: { text: `translated turn ${turns}` },
        } });
        send({ serverContent: { turnComplete: true } });
      }
      if (!recycled && chunks >= RECYCLE_AT) {
        recycled = true;
        console.log(`#${id} recycling connection after ${chunks} chunks`);
        send({ goAway: { timeLeft: '1s' } });
        setTimeout(() => ws.close(1000, 'recycled'), 100);
      }
    }
  });

  ws.on('close', (code, reason) => console.log(`#${id} closed ${code} ${reason} after ${chunks} chunks`));
});
