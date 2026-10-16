/**
 * l10n — realtime speech-to-speech translation (phase 3)
 *
 * Streams 16 kHz PCM to Gemini's Live API over a WebSocket and plays back the
 * translated 24 kHz speech as it arrives. One model replaces the whole
 * chunk → transcribe → translate → TTS chain, so latency drops to about a
 * second and the output keeps the speaker's pacing and intonation.
 *
 * Protocol notes (API reference https://ai.google.dev/api/live):
 *  - translationConfig lives in generationConfig; the transcription toggles,
 *    sessionResumption and contextWindowCompression are top-level setup keys.
 *  - Connections are recycled every ~10 min: the server sends goAway, then
 *    closes. We open the replacement socket on goAway with the resume handle
 *    and swap once it's ready (make-before-break), like Google's own bridge.
 *  - The translate model is a continuous interpreter and may not send
 *    turnComplete reliably, so transcripts are also finalized on
 *    generationComplete, interrupted, and after a silence gap.
 *  - Pausing input for >1 s requires realtimeInput.audioStreamEnd.
 *
 * Exposes `window.RealtimeTranslator`.
 */

'use strict';

class RealtimeTranslator {
  static DEFAULT_MODEL = 'gemini-3.5-live-translate-preview';
  static ENDPOINT = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
  static CONSTRAINED_ENDPOINT = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained';
  static REST = 'https://generativelanguage.googleapis.com/v1beta';
  static INPUT_RATE = 16000;
  static OUTPUT_RATE = 24000;
  static HANDLE_TTL_MS = 2 * 60 * 60 * 1000; // resume handles stay valid for 2 h
  static TOKENS_PER_SECOND = 25;              // audio tokenization rate (both directions)
  static PRICE_PER_M = { input: 3.5, output: 21 }; // paid tier USD; free tier is $0

  /** Target languages the translate model supports (docs table), as BCP-47 codes. */
  static SUPPORTED = new Set(['af', 'ak', 'sq', 'am', 'ar', 'hy', 'az', 'eu', 'be', 'bn', 'bg', 'my', 'ca', 'zh-Hans', 'zh-Hant', 'hr', 'cs', 'da', 'nl', 'en', 'et', 'fil', 'fi', 'fr', 'gl', 'ka', 'de', 'el', 'gu', 'ha', 'he', 'hi', 'hu', 'is', 'id', 'it', 'ja', 'jv', 'kn', 'kk', 'km', 'rw', 'ko', 'lo', 'lv', 'lt', 'mk', 'ms', 'ml', 'mr', 'mn', 'ne', 'no', 'nb', 'fa', 'pl', 'pt-BR', 'pt-PT', 'pa', 'ro', 'ru', 'sr', 'sd', 'si', 'sk', 'sl', 'es', 'su', 'sw', 'sv', 'ta', 'te', 'th', 'tr', 'uk', 'ur', 'uz', 'vi', 'zu']);

  /** Map app language codes onto what the translate model expects. */
  static toLiveCode(code) {
    const map = { 'zh-CN': 'zh-Hans', 'zh-TW': 'zh-Hant', 'zh-HK': 'zh-Hant', zh: 'zh-Hans', pt: 'pt-BR', iw: 'he', nb: 'no', tl: 'fil' };
    return map[code] || code;
  }

  static supports(code) {
    return RealtimeTranslator.SUPPORTED.has(RealtimeTranslator.toLiveCode(code));
  }

  /**
   * @param {object} opts
   * @param {string} [opts.apiKey]            Gemini API key (browser-side; fine for a personal tool)
   * @param {string} [opts.tokenEndpoint]     URL that POSTs back {token} — an ephemeral token minted
   *                                          server-side; used instead of apiKey when set
   * @param {string} opts.targetLang          app language code, e.g. 'hi', 'zh-CN'
   * @param {boolean} [opts.echoTargetLanguage=false]  re-speak input already in the target language
   * @param {AudioContext} opts.audioContext  used to play the returned speech
   * @param {string} [opts.model]
   * @param {string} [opts.endpoint]          override for testing against a mock (used for both modes)
   * @param {boolean} [opts.persistHandle=true]  keep the resume handle in sessionStorage across reloads
   * @param {(status: string) => void} [opts.onStatus]
   * @param {(text: string, final: boolean, lang?: string) => void} [opts.onInputText]   what the model heard
   * @param {(text: string, final: boolean, lang?: string) => void} [opts.onOutputText]  what it said
   * @param {(usage: {secondsIn:number, secondsOut:number, tokens:number, estCostUsd:number}) => void} [opts.onUsage]
   * @param {(err: Error) => void} [opts.onError]
   */
  constructor(opts) {
    this.opts = opts;
    this.ctx = opts.audioContext;
    this.model = opts.model || RealtimeTranslator.DEFAULT_MODEL;
    this.endpoint = opts.endpoint || null;

    this.ws = null;           // active socket
    this.ready = false;
    this.active = false;      // user intent: keep the session alive
    this.rollingOver = false;
    this.rolloverAgain = false;
    this.resumeHandle = null;
    this.reconnectAttempts = 0;
    this.setupMode = 'full';  // 'full' | 'noHandle' | 'minimal' — degrades if setup is rejected

    this.inText = ''; this.inLang = '';
    this.outText = ''; this.outLang = '';
    this.finalizeTimer = null;

    this.streaming = false;   // audio sent since the last audioStreamEnd
    this.lastSendAt = 0;
    this.watchdog = null;

    this.gain = this.ctx.createGain();
    this.gain.connect(this.ctx.destination);
    this.nextStart = 0;
    this.scheduled = new Set();

    this.usage = { secondsIn: 0, secondsOut: 0, tokens: 0 };
    this.usageReportedAt = 0;
    this.stats = { chunksSent: 0, audioChunksReceived: 0, reconnects: 0, rollovers: 0, audioStreamEnds: 0, finalizedBy: {} };

    if (opts.persistHandle !== false) this._loadHandle();
  }

  // ---------------------------------------------------------------------------
  // Connection lifecycle
  // ---------------------------------------------------------------------------
  async connect() {
    this.active = true;
    await this._preflight();
    this.ws = await this._openWithFallback();
    this._afterSocketReady();
  }

  /** A REST call that fails fast with a readable reason; WebSocket handshake errors are opaque. */
  async _preflight() {
    if (this.endpoint || this.opts.tokenEndpoint || !this.opts.apiKey) return;
    let res;
    try {
      res = await fetch(`${RealtimeTranslator.REST}/models?pageSize=1&key=${encodeURIComponent(this.opts.apiKey)}`);
    } catch (_) {
      return; // offline or blocked — let the socket report it
    }
    if (res.status === 400 || res.status === 401 || res.status === 403) {
      throw new Error('Gemini rejected the API key — check it in ⚙ Settings');
    }
  }

  async _credentials() {
    if (this.opts.tokenEndpoint) {
      const res = await fetch(this.opts.tokenEndpoint, { method: 'POST' });
      if (!res.ok) throw new Error(`Token endpoint returned ${res.status}`);
      const data = await res.json();
      if (!data.token) throw new Error('Token endpoint returned no token');
      const base = this.endpoint || RealtimeTranslator.CONSTRAINED_ENDPOINT;
      return `${base}${base.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(data.token)}`;
    }
    const base = this.endpoint || RealtimeTranslator.ENDPOINT;
    return `${base}${base.includes('?') ? '&' : '?'}key=${encodeURIComponent(this.opts.apiKey || '')}`;
  }

  /**
   * Open a socket and resolve once the server acknowledges setup. A close
   * before setupComplete with code 1007 means the setup was rejected:
   * degrade from a stale handle, then to a minimal setup. Any other
   * pre-setup close is treated as transient and retried with backoff.
   */
  async _openWithFallback() {
    let transientTries = 0;
    for (;;) {
      try {
        return await this._openSocket();
      } catch (err) {
        if (!this.active) throw err;
        if (err.code === 1007) {
          if (this.setupMode === 'full' && this.resumeHandle) {
            this.resumeHandle = null;
            this._saveHandle();
            this.setupMode = 'noHandle';
            this._status('Previous session could not be resumed — starting fresh');
          } else if (this.setupMode !== 'minimal') {
            this.setupMode = 'minimal';
          } else {
            throw err;
          }
        } else if (transientTries < 3) {
          const delay = 500 * 2 ** transientTries++;
          this._status(`Connection failed — retrying in ${(delay / 1000).toFixed(1)} s`);
          await new Promise((r) => setTimeout(r, delay));
        } else {
          throw err;
        }
      }
    }
  }

  _openSocket() {
    return new Promise(async (resolve, reject) => {
      let url;
      try { url = await this._credentials(); } catch (err) { reject(err); return; }
      const ws = new WebSocket(url);
      ws.binaryType = 'arraybuffer'; // decoded synchronously, so message order is preserved
      ws._setupDone = false;
      this._status(this.resumeHandle ? 'Reconnecting…' : 'Connecting…');

      ws.onopen = () => ws.send(JSON.stringify(this._setupMessage()));
      ws.onmessage = (event) => {
        const msg = RealtimeTranslator._parse(event.data);
        if (!msg) return;
        if (msg.setupComplete !== undefined && !ws._setupDone) {
          ws._setupDone = true;
          resolve(ws);
          return;
        }
        if (ws === this.ws) this._handle(msg);
        else if (msg.sessionResumptionUpdate) this._handle({ sessionResumptionUpdate: msg.sessionResumptionUpdate });
        // Anything else from a socket that isn't (or no longer is) the active one is ignored.
      };
      ws.onerror = () => { /* onclose carries the detail */ };
      ws.onclose = (event) => {
        if (!ws._setupDone) {
          const err = new Error(RealtimeTranslator.describeClose(event, 'setup rejected'));
          err.code = event.code;
          reject(err);
          return;
        }
        if (ws === this.ws) this._onActiveClose(event);
      };
    });
  }

  static _parse(data) {
    const raw = data instanceof ArrayBuffer ? new TextDecoder().decode(data) : data;
    try { return JSON.parse(raw); } catch (_) { return null; }
  }

  _afterSocketReady() {
    this.ready = true;
    this.reconnectAttempts = 0;
    this.setupMode = 'full';
    this.streaming = false;
    this._status('Live — speak now');
    if (!this.watchdog) {
      // Input that stalls for >1 s must be flushed with audioStreamEnd.
      this.watchdog = setInterval(() => {
        if (this.ready && this.streaming && performance.now() - this.lastSendAt > 1200) this.endAudioStream();
      }, 400);
    }
  }

  _setupMessage() {
    const setup = {
      model: `models/${this.model}`,
      generationConfig: {
        responseModalities: ['AUDIO'],
        translationConfig: {
          targetLanguageCode: RealtimeTranslator.toLiveCode(this.opts.targetLang),
          echoTargetLanguage: !!this.opts.echoTargetLanguage,
        },
      },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
    };
    if (this.setupMode !== 'minimal') {
      setup.sessionResumption = this.resumeHandle && this.setupMode === 'full' ? { handle: this.resumeHandle } : {};
      // Lifts the 15-min audio cap. Explicit, small bounds keep each
      // compression cheap and stop per-turn billing (which re-reads the
      // whole context) from growing for an hour first — translation never
      // needs long history anyway. 25 600 tokens ≈ 17 min of audio.
      setup.contextWindowCompression = { triggerTokens: 25600, slidingWindow: { targetTokens: 12800 } };
    }
    return { setup };
  }

  /** Open the replacement socket now (with the resume handle) and swap when it's ready. */
  async _rollover(reason) {
    if (!this.active) return;
    if (this.rollingOver) { this.rolloverAgain = true; return; } // config changed mid-swap: run once more after
    this.rollingOver = true;
    const old = this.ws;
    try {
      const next = await this._openSocket();
      if (!this.active) { next.close(1000, 'client closed'); return; }
      this.ws = next;
      this.stats.rollovers++;
      if (old && old !== next) {
        old.onclose = old.onerror = old.onmessage = null;
        try { old.close(1000, reason); } catch (_) {}
      }
      this._afterSocketReady();
    } catch (err) {
      if (!this.ws) {
        // The old socket died while the replacement was connecting: fall
        // back to the ordinary reconnect path instead of staying silent.
        this._scheduleReconnect({ code: 0, reason: err.message });
      } else {
        this._status(`Reconnect ahead of time failed (${err.message}) — will retry on close`);
      }
    } finally {
      this.rollingOver = false;
      if (this.rolloverAgain) { this.rolloverAgain = false; this._rollover('settings changed'); }
    }
  }

  _onActiveClose(event) {
    this.ready = false;
    this.streaming = false;
    this._flushPlayback();
    this._finalize('close');
    if (!this.active) { this._status('Disconnected'); return; }
    if (this.rollingOver) {
      // The replacement is already on its way; let it take over.
      this.ws = null;
      this._status('Switching connection…');
      return;
    }
    this._scheduleReconnect(event);
  }

  _scheduleReconnect(event) {
    const quota = event.code === 1011 && /quota/i.test(event.reason || '');
    if (quota) {
      this.active = false;
      this._error(new Error('Gemini quota exceeded — check your plan and billing, then reconnect'));
      this._status('Disconnected');
      return;
    }
    if (this.reconnectAttempts >= 6) {
      this.active = false;
      this._error(new Error(`Live session lost (${RealtimeTranslator.describeClose(event)})`));
      this._status('Disconnected');
      return;
    }
    const delay = event.code === 1008 ? 0 : 500 * 2 ** this.reconnectAttempts; // 1008 = routine expiry
    this.reconnectAttempts++;
    this.stats.reconnects++;
    this._status(delay ? `Connection dropped — reconnecting in ${(delay / 1000).toFixed(1)} s` : 'Reconnecting…');
    setTimeout(async () => {
      if (!this.active || this.ws) return; // a rollover may have completed meanwhile
      try {
        this.ws = await this._openWithFallback();
        this._afterSocketReady();
      } catch (err) {
        this._error(err);
        this._status('Disconnected');
        this.active = false;
      }
    }, delay);
  }

  static describeClose(event, fallback = 'connection closed') {
    const reason = event.reason ? `: ${event.reason}` : '';
    switch (event.code) {
      case 1006: return 'connection refused — check the API key, network, or quota';
      case 1007: return `setup rejected by the server${reason}`;
      case 1008: return 'connection expired (routine, ~10 min)';
      case 1011: return `server error${reason}`;
      default: return `${fallback} (${event.code}${reason})`;
    }
  }

  close() {
    this.active = false;
    clearInterval(this.watchdog); this.watchdog = null;
    clearTimeout(this.finalizeTimer); this.finalizeTimer = null;
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
  // Mid-session configuration: the target language is fixed at setup, but
  // any setting except the model may change when resuming with the handle.
  // ---------------------------------------------------------------------------
  setTargetLang(code) {
    if (code === this.opts.targetLang) return;
    this.opts.targetLang = code;
    this._finalize('language-change');
    if (this.ready) this._rollover('target language changed');
  }

  setEchoTargetLanguage(enabled) {
    if (!!enabled === !!this.opts.echoTargetLanguage) return;
    this.opts.echoTargetLanguage = !!enabled;
    if (this.ready) this._rollover('echo setting changed');
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
    this.streaming = true;
    this.lastSendAt = performance.now();
    this._addUsage(float32.length / RealtimeTranslator.INPUT_RATE, 0);
  }

  /** Tell the server the input paused (mute, video paused) so cached audio is flushed. */
  endAudioStream() {
    if (!this.streaming || !this.ready || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));
    this.streaming = false;
    this.stats.audioStreamEnds++;
  }

  // ---------------------------------------------------------------------------
  // Inbound messages — every key is checked independently because one message
  // can bundle audio, transcripts and completion flags.
  // ---------------------------------------------------------------------------
  _handle(msg) {
    if (msg.usageMetadata?.totalTokenCount) {
      this.usage.tokens = Math.max(this.usage.tokens, msg.usageMetadata.totalTokenCount);
    }
    if (msg.sessionResumptionUpdate) {
      const u = msg.sessionResumptionUpdate;
      if (u.resumable && u.newHandle) { this.resumeHandle = u.newHandle; this._saveHandle(); }
    }
    if (msg.goAway) {
      const secs = RealtimeTranslator.parseDuration(msg.goAway.timeLeft);
      this._status(`Server is recycling the connection${secs ? ` in ${Math.round(secs)} s` : ''} — switching over`);
      this._rollover('server goAway');
    }
    const sc = msg.serverContent;
    if (!sc) return;

    if (sc.interrupted) this._flushPlayback();

    if (sc.inputTranscription?.text) {
      this.inText += sc.inputTranscription.text;
      if (sc.inputTranscription.languageCode) this.inLang = sc.inputTranscription.languageCode;
      this.opts.onInputText?.(this.inText.trim(), false, this.inLang);
      this._armFinalize();
    }
    if (sc.outputTranscription?.text) {
      this.outText += sc.outputTranscription.text;
      if (sc.outputTranscription.languageCode) this.outLang = sc.outputTranscription.languageCode;
      this.opts.onOutputText?.(this.outText.trim(), false, this.outLang);
      this._armFinalize();
    }
    for (const part of sc.modelTurn?.parts || []) {
      if (part.inlineData?.data) this._playPcm(part.inlineData.data, part.inlineData.mimeType);
    }
    if (sc.interrupted) this._finalize('interrupted');
    else if (sc.generationComplete) this._finalize('generationComplete');
    else if (sc.turnComplete) this._finalize('turnComplete');
  }

  /** The continuous translate model may never send turnComplete; a gap in transcripts ends a line. */
  _armFinalize() {
    clearTimeout(this.finalizeTimer);
    this.finalizeTimer = setTimeout(() => this._finalize('silence'), 2000);
  }

  _finalize(by) {
    clearTimeout(this.finalizeTimer); this.finalizeTimer = null;
    const inText = this.inText.trim(), outText = this.outText.trim();
    if (!inText && !outText) return;
    this.stats.finalizedBy[by] = (this.stats.finalizedBy[by] || 0) + 1;
    if (inText) this.opts.onInputText?.(inText, true, this.inLang);
    if (outText) this.opts.onOutputText?.(outText, true, this.outLang);
    this.inText = ''; this.outText = '';
  }

  static parseDuration(d) {
    if (typeof d === 'number') return d;
    const m = /^([\d.]+)s$/.exec(d || '');
    return m ? parseFloat(m[1]) : (d?.seconds ? Number(d.seconds) : 0);
  }

  // ---------------------------------------------------------------------------
  // Playback: PCM16 @ 24 kHz scheduled back-to-back on the AudioContext clock
  // ---------------------------------------------------------------------------
  _playPcm(base64, mimeType) {
    if (mimeType && !mimeType.startsWith('audio/pcm')) return; // only raw PCM is documented
    const rate = Number(/rate=(\d+)/.exec(mimeType || '')?.[1]) || RealtimeTranslator.OUTPUT_RATE;
    const bytes = base64ToBytes(base64);
    const pcm = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 1);
    if (pcm.length === 0) return;
    const buffer = this.ctx.createBuffer(1, pcm.length, rate);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) channel[i] = pcm[i] / 0x8000;

    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.gain);
    // A short lead absorbs network jitter between consecutive chunks.
    const startAt = Math.max(this.ctx.currentTime + 0.06, this.nextStart);
    source.start(startAt);
    this.nextStart = startAt + buffer.duration;
    this.scheduled.add(source);
    source.onended = () => this.scheduled.delete(source);
    this.stats.audioChunksReceived++;
    this._addUsage(0, buffer.duration);
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

  // ---------------------------------------------------------------------------
  // Usage / cost estimate from the audio clock (25 tokens per second each way)
  // ---------------------------------------------------------------------------
  _addUsage(secIn, secOut) {
    this.usage.secondsIn += secIn;
    this.usage.secondsOut += secOut;
    const now = performance.now();
    if (now - this.usageReportedAt < 1000) return;
    this.usageReportedAt = now;
    const t = RealtimeTranslator.TOKENS_PER_SECOND;
    const estCostUsd = (this.usage.secondsIn * t * RealtimeTranslator.PRICE_PER_M.input
      + this.usage.secondsOut * t * RealtimeTranslator.PRICE_PER_M.output) / 1e6;
    this.opts.onUsage?.({ ...this.usage, estCostUsd });
  }

  // ---------------------------------------------------------------------------
  // Resume-handle persistence (survives a reload within the 2 h validity)
  // ---------------------------------------------------------------------------
  _handleKey() { return `l10n.rt.handle.${this.model}`; }

  _loadHandle() {
    try {
      const saved = JSON.parse(sessionStorage.getItem(this._handleKey()) || 'null');
      if (saved?.handle && Date.now() - saved.ts < RealtimeTranslator.HANDLE_TTL_MS) this.resumeHandle = saved.handle;
    } catch (_) { /* storage unavailable */ }
  }

  _saveHandle() {
    if (this.opts.persistHandle === false) return;
    try {
      if (this.resumeHandle) sessionStorage.setItem(this._handleKey(), JSON.stringify({ handle: this.resumeHandle, ts: Date.now() }));
      else sessionStorage.removeItem(this._handleKey());
    } catch (_) { /* storage unavailable */ }
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
