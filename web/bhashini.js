/**
 * l10n — Bhashini engine (India's national language platform, MeitY)
 *
 * Open, free APIs for 22 scheduled Indian languages via the ULCA/Dhruva
 * pipeline: ASR (IndicConformer), translation (IndicTrans2) and TTS
 * (IndicParler and others). Two-step flow: a config call resolves service
 * IDs and an inference endpoint + key for the requested tasks; compute calls
 * then go to that endpoint. Both endpoints allow direct browser calls.
 *
 * Credentials (userID + ulcaApiKey) come from bhashini.gov.in → ULCA →
 * My Profile. Exposes `window.Bhashini`.
 */

'use strict';

const Bhashini = (() => {
  const CONFIG_URL = 'https://meity-auth.ulcacontrib.org/ulca/apis/v0/model/getModelsPipeline';
  const PIPELINE_ID = '64392f96daac500b55c543cd'; // MeitY's public pipeline

  // Scheduled languages the pipeline commonly serves; ISO 639-1/2 codes.
  const LANGS = new Set(['en', 'hi', 'bn', 'ta', 'te', 'mr', 'gu', 'ur', 'kn', 'ml', 'pa', 'or', 'as']);

  let creds = { userID: '', ulcaApiKey: '' };
  let configUrl = CONFIG_URL;
  const pipelineCache = new Map(); // task signature → Promise<pipeline>

  function configure(next) {
    if (next.userID !== creds.userID || next.ulcaApiKey !== creds.ulcaApiKey) pipelineCache.clear();
    creds = { userID: next.userID || '', ulcaApiKey: next.ulcaApiKey || '' };
    if (next.configUrl) configUrl = next.configUrl; // test hook
  }

  const supports = (lang) => LANGS.has(lang);

  function assertLang(lang, what) {
    if (!supports(lang)) throw new Error(`Bhashini has no ${what} model for "${lang}" — it covers Indian languages and English`);
  }

  /** Resolve service IDs + inference endpoint for a set of tasks (cached). */
  function getPipeline(tasks) {
    const key = JSON.stringify(tasks);
    if (pipelineCache.has(key)) return pipelineCache.get(key);
    const load = (async () => {
      if (!creds.userID || !creds.ulcaApiKey) {
        throw new Error('Bhashini credentials missing — add your ULCA userID and API key in ⚙ Settings');
      }
      const res = await fetch(configUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', userID: creds.userID, ulcaApiKey: creds.ulcaApiKey },
        body: JSON.stringify({ pipelineTasks: tasks, pipelineRequestConfig: { pipelineId: PIPELINE_ID } }),
      });
      if (!res.ok) throw new Error(`Bhashini config call failed (${res.status}) — check credentials`);
      const data = await res.json();
      const endpoint = data.pipelineInferenceAPIEndPoint;
      if (!endpoint?.callbackUrl) throw new Error('Bhashini config response had no inference endpoint');
      const serviceIds = {};
      for (const task of data.pipelineResponseConfig || []) {
        serviceIds[task.taskType] = task.config?.[0]?.serviceId;
      }
      return {
        url: endpoint.callbackUrl,
        authName: endpoint.inferenceApiKey?.name || 'Authorization',
        authValue: endpoint.inferenceApiKey?.value || '',
        serviceIds,
      };
    })();
    pipelineCache.set(key, load);
    load.catch(() => pipelineCache.delete(key));
    return load;
  }

  async function compute(pipeline, pipelineTasks, inputData) {
    const res = await fetch(pipeline.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [pipeline.authName]: pipeline.authValue },
      body: JSON.stringify({ pipelineTasks, inputData }),
    });
    if (!res.ok) throw new Error(`Bhashini inference failed (${res.status})`);
    const data = await res.json();
    return data.pipelineResponse || [];
  }

  const taskOf = (response, type) => response.find((t) => t.taskType === type);

  /** Speech-to-text: Float32Array @ 16 kHz → transcript. */
  async function transcribe(audio, lang) {
    assertLang(lang, 'speech recognition');
    const language = { sourceLanguage: lang };
    const pipeline = await getPipeline([{ taskType: 'asr', config: { language } }]);
    const response = await compute(pipeline, [{
      taskType: 'asr',
      config: { language, serviceId: pipeline.serviceIds.asr, audioFormat: 'wav', samplingRate: 16000 },
    }], { audio: [{ audioContent: L10nMedia.encodeWavBase64(audio) }] });
    return (taskOf(response, 'asr')?.output?.[0]?.source || '').trim();
  }

  async function translate(text, src, tgt) {
    assertLang(src, 'translation');
    assertLang(tgt, 'translation');
    const language = { sourceLanguage: src, targetLanguage: tgt };
    const pipeline = await getPipeline([{ taskType: 'translation', config: { language } }]);
    const response = await compute(pipeline, [{
      taskType: 'translation',
      config: { language, serviceId: pipeline.serviceIds.translation },
    }], { input: [{ source: text }] });
    return (taskOf(response, 'translation')?.output?.[0]?.target || '').trim();
  }

  /** Text-to-speech → base64 WAV. */
  async function synthesize(text, lang, gender = 'female') {
    assertLang(lang, 'speech synthesis');
    const language = { sourceLanguage: lang };
    const pipeline = await getPipeline([{ taskType: 'tts', config: { language } }]);
    const response = await compute(pipeline, [{
      taskType: 'tts',
      config: { language, serviceId: pipeline.serviceIds.tts, gender, samplingRate: 22050 },
    }], { input: [{ source: text }] });
    const audio = taskOf(response, 'tts')?.audio?.[0]?.audioContent;
    if (!audio) throw new Error('Bhashini returned no audio');
    return audio;
  }

  return { configure, supports, transcribe, translate, synthesize, LANGS };
})();

window.Bhashini = Bhashini;
