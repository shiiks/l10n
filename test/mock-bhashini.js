// Mock of Bhashini's ULCA/Dhruva pipeline for testing without credentials.
//   POST /config    ≙ getModelsPipeline  (needs userID + ulcaApiKey headers)
//   POST /inference ≙ callbackUrl        (needs the Authorization value it issued)
// Validates the request shapes the client sends and answers with canned
// ASR / translation / TTS results (TTS is a 0.4 s WAV tone).
//
//   node test/mock-bhashini.js        (listens on http://localhost:9002)
const http = require('http');

const PORT = Number(process.env.PORT || 9002);
const AUTH = 'mock-inference-key';

function wavTone(seconds, rate = 22050, hz = 660) {
  const n = Math.round(rate * seconds);
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * hz * i) / rate) * 0.3 * 0x7fff), 44 + i * 2);
  return buf.toString('base64');
}

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type,userid,ulcaapikey,authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (res, code, body) => { res.writeHead(code, { ...cors, 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  let raw = '';
  req.on('data', (d) => { raw += d; });
  req.on('end', () => {
    let body;
    try { body = JSON.parse(raw); } catch (_) { return json(res, 400, { error: 'bad json' }); }

    if (req.url === '/config') {
      if (req.headers.userid !== 'mock-user' || req.headers.ulcaapikey !== 'mock-key') {
        console.log('config: bad credentials', req.headers.userid, req.headers.ulcaapikey);
        return json(res, 401, { message: 'unauthorized' });
      }
      if (!Array.isArray(body.pipelineTasks) || !body.pipelineRequestConfig?.pipelineId) {
        console.log('config: bad shape', raw);
        return json(res, 400, { message: 'bad request' });
      }
      const pipelineResponseConfig = body.pipelineTasks.map((t) => {
        const lang = t.config?.language || {};
        if (!lang.sourceLanguage || (t.taskType === 'translation' && !lang.targetLanguage)) {
          console.log('config: task missing language', JSON.stringify(t));
        }
        return { taskType: t.taskType, config: [{ serviceId: `svc-${t.taskType}`, language: lang }] };
      });
      console.log('config ok:', body.pipelineTasks.map((t) => t.taskType).join('+'));
      return json(res, 200, {
        pipelineResponseConfig,
        pipelineInferenceAPIEndPoint: {
          callbackUrl: `http://localhost:${PORT}/inference`,
          inferenceApiKey: { name: 'Authorization', value: AUTH },
        },
      });
    }

    if (req.url === '/inference') {
      if (req.headers.authorization !== AUTH) { console.log('inference: bad auth'); return json(res, 401, { message: 'unauthorized' }); }
      const pipelineResponse = [];
      for (const t of body.pipelineTasks || []) {
        const c = t.config || {};
        if (c.serviceId !== `svc-${t.taskType}`) console.log('inference: unexpected serviceId', JSON.stringify(c));
        if (t.taskType === 'asr') {
          const audio = body.inputData?.audio?.[0]?.audioContent || '';
          const bytes = Buffer.from(audio, 'base64');
          const isWav = bytes.slice(0, 4).toString() === 'RIFF' && bytes.readUInt32LE(24) === 16000;
          console.log(`asr: lang=${c.language?.sourceLanguage} format=${c.audioFormat}@${c.samplingRate} wav16k=${isWav} bytes=${bytes.length}`);
          pipelineResponse.push({ taskType: 'asr', output: [{ source: isWav ? `mock transcript ${bytes.length}B` : '' }] });
        } else if (t.taskType === 'translation') {
          const src = body.inputData?.input?.[0]?.source || '';
          console.log(`translation: ${c.language?.sourceLanguage}→${c.language?.targetLanguage} "${src}"`);
          pipelineResponse.push({ taskType: 'translation', output: [{ source: src, target: `[${c.language?.targetLanguage}] ${src}` }] });
        } else if (t.taskType === 'tts') {
          const src = body.inputData?.input?.[0]?.source || '';
          console.log(`tts: lang=${c.language?.sourceLanguage} gender=${c.gender} "${src}"`);
          pipelineResponse.push({ taskType: 'tts', audio: [{ audioContent: wavTone(0.4) }] });
        }
      }
      return json(res, 200, { pipelineResponse });
    }
    json(res, 404, { message: 'not found' });
  });
});

server.listen(PORT, () => console.log(`mock bhashini on http://localhost:${PORT}`));
