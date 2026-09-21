/**
 * l10n — realtime speech-to-speech translation (phase 3)
 *
 * Streams 16 kHz PCM to Gemini's Live API over a WebSocket and plays back the
 * translated 24 kHz speech as it arrives. One model replaces the whole
 * chunk → transcribe → translate → TTS chain, so latency drops to well under
 * a second and the output keeps the speaker's pacing and intonation.
 *
 * Exposes `window.RealtimeTranslator`.
 */

'use strict';

class RealtimeTranslator {
  static DEFAULT_MODEL = 'gemini-3.5-live-translate-preview';
  static ENDPOINT = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
  static INPUT_RATE = 16000;
  static OUTPUT_RATE = 24000;

  /**
   * @param {object} opts
   * @param {string} opts.apiKey
   * @param {string} opts.targetLang     BCP-47 / ISO code, e.g. 'hi', 'es'
   * @param {AudioContext} opts.audioContext  used to play the returned speech
   * @param {string} [opts.model]
   * @param {string} [opts.endpoint]     override for testing against a mock
   * @param {(status: string) => void} [opts.onStatus]
   * @param {(text: string, final: boolean) => void} [opts.onInputText]   what the model heard
   * @param {(text: string, final: boolean) => void} [opts.onOutputText]  what it said
   * @param {(err: Error) => void} [opts.onError]
   */
  constructor(opts) {
    this.opts = opts;
    this.ctx = opts.audioContext;
    this.model = opts.model || RealtimeTranslator.DEFAULT_MODEL;
    this.endpoint = opts.endpoint || RealtimeTranslator.ENDPOINT;

    this.ws = null;
    this.ready = false;
    this.active = false;          // user intent: keep the session alive
    this.resumeHandle = null;
    this.reconnectAttempts = 0;
    this.minimalSetup = false;    // retry without optional setup fields if rejected

    this.inText = '';
    this.outText = '';

    this.gain = this.ctx.createGain();
    this.gain.connect(this.ctx.destination);
    this.nextStart = 0;
    this.scheduled = new Set();

    this.stats = { chunksSent: 0, audioChunksReceived: 0, reconnects: 0 };
  }

  // ---------------------------------------------------------------------------
  // Connection lifecycle
  // ---------------------------------------------------------------------------
  connect() {
    this.active = true;
    return this._open();
  }

  _open() {
    return new Promise((resolve, reject) => {
      const sep = this.endpoint.includes('?') ? '&' : '?';
      const url = `${this.endpoint}${sep}key=${encodeURIComponent(this.opts.apiKey)}`;
      const ws = new WebSocket(url);
      this.ws = ws;
      this.ready = false;
      let settled = false;
      this._status(this.resumeHandle ? 'Reconnecting…' : 'Connecting…');

      ws.onopen = () => ws.send(JSON.stringify(this._setupMessage()));

      ws.onmessage = async (event) => {
        const raw = event.data instanceof Blob ? await event.data.text() : event.data;
        let msg;
        try { msg = JSON.parse(raw); } catch (_) { return; }
        if (msg.setupComplete !== undefined && !this.ready) {
          this.ready = true;
          this.reconnectAttempts = 0;
          this._status('Live — speak now');
          if (!settled) { settled = true; resolve(); }
          return;
        }
        this._handle(msg);
      };

      ws.onerror = () => { /* onclose carries the detail */ };

      ws.onclose = (event) => {
        const wasReady = this.ready;
        this.ready = false;
        this._flushPlayback();
        if (!settled) {
          settled = true;
          // A rejected setup closes the socket before setupComplete. Retry once
          // with only the required fields in case an optional one was refused.
          if (!this.minimalSetup && this.active) {
            this.minimalSetup = true;
            this._open().then(resolve, reject);
            return;
          }
          reject(new Error(`Live API connection failed (${event.code}${event.reason ? ': ' + event.reason : ''})`));
          return;
        }
        if (this.active && wasReady) this._reconnect(event);
        else if (!this.active) this._status('Disconnected');
      };
    });
  }

  _setupMessage() {
    const setup = {
      model: `models/${this.model}`,
      generationConfig: {
        responseModalities: ['AUDIO'],
        translationConfig: {
          targetLanguageCode: this.opts.targetLang,
          echoTargetLanguage: false,
        },
      },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
    };
    if (!this.minimalSetup) {
      // Connections are recycled every ~10 min; the handle lets us resume
      // without losing context. Compression lifts the 15-min audio cap.
      setup.sessionResumption = this.resumeHandle ? { handle: this.resumeHandle } : {};
      setup.contextWindowCompression = { slidingWindow: {} };
    }
    return { setup };
  }

  _reconnect(closeEvent) {
    if (this.reconnectAttempts >= 4) {
      this.active = false;
      this._error(new Error(`Live session lost (${closeEvent.code}${closeEvent.reason ? ': ' + closeEvent.reason : ''})`));
      this._status('Disconnected');
      return;
    }
    const delay = 500 * 2 ** this.reconnectAttempts++;
    this.stats.reconnects++;
    this._status(`Connection dropped — reconnecting in ${(delay / 1000).toFixed(1)} s`);
    setTimeout(() => { if (this.active) this._open().catch((err) => this._error(err)); }, delay);
  }

  close() {
    this.active = false;
    this._flushPlayback();
    if (this.ws) {
      // Detach first: the close event fires asynchronously and must not
      // report status for a session the app has already moved past.
      this.ws.onopen = this.ws.onmessage = this.ws.onerror = this.ws.onclose = null;
      try { this.ws.close(1000, 'client closed'); } catch (_) {}
    }
    this.ws = null;
    this.ready = false;
    this._status('Disconnected');
  }

  // ---------------------------------------------------------------------------
  // Outbound audio: Float32 @ 16 kHz → PCM16 → base64 → realtimeInput
  // ---------------------------------------------------------------------------
  sendSamples(float32) {
    if (!this.ready || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const pcm = new Int16Array(float32.length);
    for (let i = 0; i < float32.length; i++) {
      const s = Math.max(-1, Math.min(1, float32[i]));
      pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    this.ws.send(JSON.stringify({
      realtimeInput: {
        audio: { mimeType: `audio/pcm;rate=${RealtimeTranslator.INPUT_RATE}`, data: bytesToBase64(new Uint8Array(pcm.buffer)) },
      },
    }));
    this.stats.chunksSent++;
  }

  // ---------------------------------------------------------------------------
  // Inbound messages
  // ---------------------------------------------------------------------------
  _handle(msg) {
    if (msg.sessionResumptionUpdate) {
      const u = msg.sessionResumptionUpdate;
      if (u.resumable && u.newHandle) this.resumeHandle = u.newHandle;
    }
    if (msg.goAway) {
      this._status('Server is recycling the connection — will resume');
      // Let onclose drive the reconnect; the resume handle carries context.
    }
    const sc = msg.serverContent;
    if (!sc) return;

    if (sc.interrupted) {
      this._flushPlayback();
      return;
    }
    if (sc.inputTranscription?.text) {
      this.inText += sc.inputTranscription.text;
      this.opts.onInputText?.(this.inText.trim(), false);
    }
    if (sc.outputTranscription?.text) {
      this.outText += sc.outputTranscription.text;
      this.opts.onOutputText?.(this.outText.trim(), false);
    }
    for (const part of sc.modelTurn?.parts || []) {
      if (part.inlineData?.data) this._playPcm(part.inlineData.data);
    }
    if (sc.turnComplete) {
      if (this.inText.trim()) this.opts.onInputText?.(this.inText.trim(), true);
      if (this.outText.trim()) this.opts.onOutputText?.(this.outText.trim(), true);
      this.inText = '';
      this.outText = '';
    }
  }

  // ---------------------------------------------------------------------------
  // Playback: PCM16 @ 24 kHz scheduled back-to-back on the AudioContext clock
  // ---------------------------------------------------------------------------
  _playPcm(base64) {
    const bytes = base64ToBytes(base64);
    const pcm = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 1);
    if (pcm.length === 0) return;
    const buffer = this.ctx.createBuffer(1, pcm.length, RealtimeTranslator.OUTPUT_RATE);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) channel[i] = pcm[i] / 0x8000;

    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.gain);
    const startAt = Math.max(this.ctx.currentTime + 0.02, this.nextStart);
    source.start(startAt);
    this.nextStart = startAt + buffer.duration;
    this.scheduled.add(source);
    source.onended = () => this.scheduled.delete(source);
    this.stats.audioChunksReceived++;
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  _flushPlayback() {
    for (const source of this.scheduled) { try { source.stop(); } catch (_) {} }
    this.scheduled.clear();
    this.nextStart = 0;
  }

  setPlayback(enabled) {
    this.gain.gain.value = enabled ? 1 : 0;
  }

  _status(text) { this.opts.onStatus?.(text); }
  _error(err) { this.opts.onError?.(err); }
}

function bytesToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

window.RealtimeTranslator = RealtimeTranslator;
