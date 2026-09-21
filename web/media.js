/**
 * l10n — media input layer
 *
 * Turns any Web Audio source (a <video>/<audio> element, a shared browser
 * tab, any MediaStream) into speech chunks, and transcribes them with a
 * pluggable engine. The Web Speech API only listens to the microphone, so
 * file/tab audio needs a real speech-to-text model that accepts raw audio.
 *
 * Exposes `window.L10nMedia`.
 */

'use strict';

const L10nMedia = (() => {
  const SAMPLE_RATE = 16000;
  const TRANSFORMERS_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.1';

  let audioCtx = null;
  function getAudioContext() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    return audioCtx;
  }

  let workletReady = null;
  function ensureWorklet(ctx) {
    if (!workletReady) workletReady = ctx.audioWorklet.addModule('pcm-worklet.js');
    return workletReady;
  }

  // -------------------------------------------------------------------------
  // Chunker: 16 kHz PCM in → speech chunks out, cut at pauses (energy VAD).
  // -------------------------------------------------------------------------
  class SpeechChunker {
    constructor({ onChunk, onLevel, minSec = 1.0, maxSec = 8, silenceMs = 600, threshold = 0.012 }) {
      Object.assign(this, { onChunk, onLevel, minSec, maxSec, silenceMs, threshold });
      this.reset();
    }

    reset() {
      this.parts = [];
      this.length = 0;
      this.silentSamples = 0;
      this.hasSpeech = false;
    }

    push(samples) {
      let sum = 0;
      for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
      const rms = Math.sqrt(sum / samples.length);
      if (this.onLevel) this.onLevel(rms);

      if (rms < this.threshold) {
        this.silentSamples += samples.length;
      } else {
        this.silentSamples = 0;
        this.hasSpeech = true;
      }

      // Don't accumulate leading silence — it just delays the first chunk.
      if (!this.hasSpeech) {
        this.parts = [samples];
        this.length = samples.length;
        return;
      }

      this.parts.push(samples);
      this.length += samples.length;

      const seconds = this.length / SAMPLE_RATE;
      const pauseReached = this.silentSamples >= (this.silenceMs / 1000) * SAMPLE_RATE;
      if ((seconds >= this.minSec && pauseReached) || seconds >= this.maxSec) this.flush();
    }

    flush() {
      if (!this.hasSpeech || this.length < SAMPLE_RATE * 0.3) { this.reset(); return; }
      const chunk = new Float32Array(this.length);
      let offset = 0;
      for (const part of this.parts) { chunk.set(part, offset); offset += part.length; }
      this.reset();
      this.onChunk(chunk);
    }
  }

  // -------------------------------------------------------------------------
  // Sessions: wire a source node → worklet → chunker and/or raw sample sink.
  //   opts.onChunk   (Float32Array) speech chunk cut at a pause (chunked mode)
  //   opts.onSamples (Float32Array) every 100 ms batch as-is (realtime mode)
  // -------------------------------------------------------------------------
  async function openSession(sourceNode, { passthrough, opts }) {
    const ctx = getAudioContext();
    await ensureWorklet(ctx);

    const chunker = opts.onChunk ? new SpeechChunker(opts) : null;
    const capture = new AudioWorkletNode(ctx, 'pcm-capture');
    let muted = false;
    capture.port.onmessage = (event) => {
      if (muted) return;
      if (opts.onSamples) opts.onSamples(event.data);
      if (chunker) chunker.push(event.data);
    };
    sourceNode.connect(capture);

    let gain = null;
    if (passthrough) {
      gain = ctx.createGain();
      sourceNode.connect(gain);
      gain.connect(ctx.destination);
    }

    return {
      chunker,
      resume: () => ctx.resume(),
      setOriginalVolume(v) { if (gain) gain.gain.value = v; },
      /** Drop captured audio (e.g. while the app itself is speaking). */
      setMuted(v) { muted = v; if (v && chunker) chunker.reset(); },
      close() {
        if (chunker) chunker.flush();
        try { sourceNode.disconnect(capture); } catch (_) {}
        if (gain) { try { sourceNode.disconnect(gain); gain.disconnect(); } catch (_) {} }
        capture.port.onmessage = null;
        capture.disconnect();
      },
    };
  }

  const elementSources = new WeakMap(); // createMediaElementSource is once-per-element

  /** Session for a <video>/<audio> element; its audio keeps playing through `gain`. */
  async function openElementSession(mediaEl, opts) {
    const ctx = getAudioContext();
    let source = elementSources.get(mediaEl);
    if (!source) {
      source = ctx.createMediaElementSource(mediaEl);
      elementSources.set(mediaEl, source);
    }
    return openSession(source, { passthrough: true, opts });
  }

  /** Session for a MediaStream (shared tab, screen, or any getUserMedia stream). */
  async function openStreamSession(stream, opts) {
    const ctx = getAudioContext();
    const source = ctx.createMediaStreamSource(stream);
    return openSession(source, { passthrough: false, opts });
  }

  // -------------------------------------------------------------------------
  // Transcription engines — load(opts) → async (Float32Array, langCode) => text
  // -------------------------------------------------------------------------
  const HALLUCINATION = /^[\s\[\(].*[\]\)]\s*$|^(thank you\.?|thanks for watching\.?|you)$/i;
  function clean(text) {
    const t = (text || '').trim();
    return HALLUCINATION.test(t) ? '' : t;
  }

  const whisperCache = new Map(); // model → Promise<transcribe>, shared by concurrent callers

  async function pickDevice() {
    // navigator.gpu can exist without a usable adapter (headless, blocked GPU).
    if (!navigator.gpu) return 'wasm';
    try {
      const adapter = await navigator.gpu.requestAdapter();
      return adapter ? 'webgpu' : 'wasm';
    } catch (_) {
      return 'wasm';
    }
  }

  const Engines = {
    /** Whisper running in the browser via transformers.js. No API key. */
    whisper({ model = 'Xenova/whisper-base', onProgress } = {}) {
      if (whisperCache.has(model)) return whisperCache.get(model);

      const load = (async () => {
        const { pipeline } = await import(TRANSFORMERS_URL);
        const progress_callback = (p) => {
          if (onProgress && p.status === 'progress') onProgress(p.file, p.progress || 0);
          if (onProgress && p.status === 'ready') onProgress('ready', 100);
        };

        const device = await pickDevice();
        let asr;
        try {
          asr = await pipeline('automatic-speech-recognition', model, { device, progress_callback });
        } catch (err) {
          if (device === 'wasm') throw err;
          console.warn('WebGPU failed, falling back to WASM', err);
          asr = await pipeline('automatic-speech-recognition', model, { device: 'wasm', progress_callback });
        }

        return async (audio, lang) => {
          const language = (lang || 'en').split('-')[0];
          const out = await asr(audio, { language, task: 'transcribe', chunk_length_s: 30 });
          return clean(out.text);
        };
      })();

      whisperCache.set(model, load);
      load.catch(() => whisperCache.delete(model)); // allow a retry after a failed load
      return load;
    },

    /** Bhashini ASR (IndicConformer) for Indian languages. Needs ULCA credentials. */
    async bhashini() {
      return (audio, lang) => Bhashini.transcribe(audio, lang);
    },

    /** Gemini multimodal transcription of a WAV chunk. Needs an API key. */
    async gemini({ apiKey, langName = 'the source language' } = {}) {
      if (!apiKey) throw new Error('Gemini API key missing — set it in Settings');
      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${encodeURIComponent(apiKey)}`;
      return async (audio) => {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{
              parts: [
                { inline_data: { mime_type: 'audio/wav', data: encodeWavBase64(audio) } },
                { text: `Transcribe this ${langName} speech verbatim. Reply with ONLY the transcript. If there is no speech, reply with nothing.` },
              ],
            }],
          }),
        });
        if (!res.ok) throw new Error(`Gemini ${res.status}`);
        const data = await res.json();
        return clean(data.candidates?.[0]?.content?.parts?.[0]?.text);
      };
    },
  };

  function encodeWavBase64(samples) {
    const buffer = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(buffer);
    const str = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); view.setUint32(4, 36 + samples.length * 2, true); str(8, 'WAVE');
    str(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, SAMPLE_RATE, true); view.setUint32(28, SAMPLE_RATE * 2, true);
    view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    str(36, 'data'); view.setUint32(40, samples.length * 2, true);
    for (let i = 0; i < samples.length; i++) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary);
  }

  return { SAMPLE_RATE, openElementSession, openStreamSession, Engines, getAudioContext, encodeWavBase64 };
})();

window.L10nMedia = L10nMedia;
