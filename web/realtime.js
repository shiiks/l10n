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
 *    and swap once it's ready (make-before-break), like Google's own bridge;
 *    the retiring socket keeps delivering its last sentence meanwhile.
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
  static CONNECT_TIMEOUT_MS = 15000;
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
   * @param {string} [opts.tokenEndpoint]     URL that POSTs back {token, expires_at} — an ephemeral
   *                                          token minted server-side; used instead of apiKey when set
   * @param {string} opts.targetLang          app language code, e.g. 'hi', 'zh-CN'
   * @param {boolean} [opts.echoTargetLanguage=false]  re-speak input already in the target language
   * @param {AudioContext} opts.audioContext  used to play the returned speech
   * @param {string} [opts.model]
   * @param {string} [opts.endpoint]          override for testing against a mock (used for both modes)
   * @param {boolean} [opts.persistHandle=true]  keep the resume handle in sessionStorage so a page
   *                                          reload continues the session (an explicit close() ends it)
   * @param {(status: string) => void} [opts.onStatus]   'Live' once a socket is ready; wording is the app's
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
    this.retiring = null;     // old socket still delivering its last sentence after a goAway swap
    this.opening = null;      // socket whose setup is in flight
    this.ready = false;
    this.active = false;      // user intent: keep the session alive
    this.closed = false;      // close() ran: callbacks go quiet
    this.gen = 0;             // bumped by close(); in-flight opens from an older gen are discarded
    this.rollingOver = false;
    this.rolloverAgain = false;
    this.reconnectTimer = null;
    this.reconnectAttempts = 0;
    this.resumeHandle = null;
    this.setupMode = 'full';  // 'full' | 'noHandle' | 'minimal' — degrades if setup is rejected
    this.token = null;        // { value, expiresAt } cached ephemeral token

    this.inText = ''; this.inLang = '';
    this.outText = ''; this.outLang = '';
    this.finalizeTimer = null;

    this.streaming = false;   // audio sent since the last audioStreamEnd
    this.lastSendAt = 0;
    this.watchdog = null;
    this.drainState = null;   // { resolve, timer, idleTimer, received, completed }

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
    const gen = this.gen;
    await this._preflight();
    const ws = await this._openWithFallback();
    if (gen !== this.gen || !this.active) { try { ws.close(1000, 'client closed'); } catch (_) {} return; }
    this.ws = ws;
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
      // Reuse a token while it's valid: resuming a session doesn't consume a
      // use, and a fresh token per reconnect would fork the session's identity.
      if (!this.token || this.token.expiresAt - Date.now() < 60000) {
        // Default credentials mode: cookies reach a same-origin token endpoint,
        // and a cross-origin one that answers with '*' still works.
        const res = await fetch(this.opts.tokenEndpoint, { method: 'POST' });
        if (!res.ok) throw new Error(`Token endpoint returned ${res.status}`);
        const data = await res.json();
        if (!data.token) throw new Error('Token endpoint returned no token');
        const expiresAt = Date.parse(data.expires_at || data.expiresAt || '') || Date.now() + 25 * 60 * 1000;
        this.token = { value: data.token, expiresAt };
      }
      const base = this.endpoint || RealtimeTranslator.CONSTRAINED_ENDPOINT;
      return `${base}${base.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(this.token.value)}`;
    }
    const base = this.endpoint || RealtimeTranslator.ENDPOINT;
    return `${base}${base.includes('?') ? '&' : '?'}key=${encodeURIComponent(this.opts.apiKey || '')}`;
  }

  static _cancelled() {
    return Object.assign(new Error('session closed'), { cancelled: true, code: 0 });
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
      if (!this.active) throw RealtimeTranslator._cancelled();
      try {
        return await this._openSocket();
      } catch (err) {
        if (err.cancelled || !this.active) throw err;
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
    const gen = this.gen;
    return new Promise((resolve, reject) => {
      this._credentials().then((url) => {
        if (gen !== this.gen || !this.active) { reject(RealtimeTranslator._cancelled()); return; }
        let ws;
        try { ws = new WebSocket(url); } catch (err) { reject(err); return; }
        ws.binaryType = 'arraybuffer'; // decoded synchronously, so message order is preserved
        ws._setupDone = false;
        ws._config = null;
        this.opening = ws;
        this._status(this.resumeHandle ? 'Reconnecting…' : 'Connecting…');

        const settle = () => {
          clearTimeout(timeout);
          if (this.opening === ws) this.opening = null;
        };
        const timeout = setTimeout(() => {
          if (ws._setupDone) return;
          try { ws.close(1000, 'connect timeout'); } catch (_) {}
          settle();
          reject(Object.assign(new Error('Live API did not answer within 15 s'), { code: 0 }));
        }, RealtimeTranslator.CONNECT_TIMEOUT_MS);

        ws.onopen = () => {
          ws._config = { target: this.opts.targetLang, echo: !!this.opts.echoTargetLanguage };
          ws.send(JSON.stringify(this._setupMessage()));
        };
        ws.onmessage = (event) => {
          const msg = RealtimeTranslator._parse(event.data);
          if (!msg) return;
          if (msg.setupComplete !== undefined && !ws._setupDone) {
            ws._setupDone = true;
            settle();
            if (gen !== this.gen || !this.active) {
              try { ws.close(1000, 'client closed'); } catch (_) {}
              reject(RealtimeTranslator._cancelled());
              return;
            }
            resolve(ws);
            return;
          }
          if (ws === this.ws) this._handle(msg);
          else if (ws === this.retiring) this._handle(msg, true);
          else if (msg.sessionResumptionUpdate) this._handle({ sessionResumptionUpdate: msg.sessionResumptionUpdate });
          // Anything else from a socket that isn't (or no longer is) the active one is ignored.
        };
        ws.onerror = () => { /* onclose carries the detail */ };
        ws.onclose = (event) => {
          if (!ws._setupDone) {
            settle();
            const err = new Error(RealtimeTranslator.describeClose(event, 'setup rejected'));
            err.code = event.code;
            err.cancelled = gen !== this.gen || !this.active;
            reject(err);
            return;
          }
          if (ws === this.ws) this._onActiveClose(event);
          else if (ws === this.retiring) this._retireDone();
        };
      }, reject);
    });
  }

  static _parse(data) {
    const raw = data instanceof ArrayBuffer ? new TextDecoder().decode(data) : data;
    try { return JSON.parse(raw); } catch (_) { return null; }
  }

  _afterSocketReady() {
    this.ready = true;
    this.reconnectAttempts = 0;
    // A server that rejected the optional fields keeps rejecting them: stay minimal.
    this.setupMode = this.setupMode === 'minimal' ? 'minimal' : 'full';
    this.streaming = false;
    this._status('Live');
    if (!this.watchdog) {
      // Input that stalls for >1 s must be flushed with audioStreamEnd.
      this.watchdog = setInterval(() => {
        if (this.ready && this.streaming && performance.now() - this.lastSendAt > 1200) this.endAudioStream();
      }, 400);
    }
    // Settings changed while this socket was connecting: its setup is stale.
    const c = this.ws._config;
    if (c && (c.target !== this.opts.targetLang || c.echo !== !!this.opts.echoTargetLanguage)) {
      this._rollover('settings changed');
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

  /**
   * Open the replacement socket now (with the resume handle) and swap when
   * it's ready. On a server-initiated recycle the old socket is kept as
   * `retiring` so the sentence it was translating still arrives; on a
   * settings change it is closed at once.
   */
  async _rollover(reason, { graceful = false } = {}) {
    if (!this.active) return;
    if (this.rollingOver) { this.rolloverAgain = true; return; } // config changed mid-swap: run once more after
    this.rollingOver = true;
    const old = this.ws;
    try {
      const next = await this._openWithFallback();
      if (!this.active) { try { next.close(1000, 'client closed'); } catch (_) {} return; }
      this.ws = next;
      this.stats.rollovers++;
      if (old && old !== next) {
        if (graceful) this._retire(old);
        else { old.onclose = old.onerror = old.onmessage = null; try { old.close(1000, reason); } catch (_) {} }
      }
      this._afterSocketReady();
    } catch (err) {
      if (err.cancelled || !this.active) return;
      if (this.ws) {
        // The old socket is healthy but the new settings never took effect:
        // close it so the ordinary reconnect applies them (it reads current opts).
        this._error(new Error(`Could not switch settings on the live session (${err.message}) — reconnecting`));
        const stale = this.ws;
        try { stale.close(1000, reason); } catch (_) {}
      } else {
        // The old socket died while the replacement was connecting.
        this._scheduleReconnect({ code: 0, reason: err.message });
      }
    } finally {
      this.rollingOver = false;
      if (this.rolloverAgain) {
        this.rolloverAgain = false;
        // With no live socket the reconnect path (already armed) applies the
        // current opts; a second opener here would race it.
        if (this.ws) this._rollover('settings changed');
      }
    }
  }

  _retire(ws) {
    if (this.retiring) this._retireDone();
    this.retiring = ws;
    ws.onerror = null;
    this.retireTimer = setTimeout(() => { if (this.retiring === ws) this._retireDone(); }, 6000);
  }

  _retireDone() {
    clearTimeout(this.retireTimer);
    const ws = this.retiring;
    this.retiring = null;
    if (!ws) return;
    ws.onclose = ws.onerror = ws.onmessage = null;
    try { ws.close(1000, 'retired'); } catch (_) {}
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
    this.ws = null;
    this._scheduleReconnect(event);
  }

  _scheduleReconnect(event) {
    const quota = event.code === 1011 && /quota/i.test(event.reason || '');
    if (quota) {
      this._giveUp(new Error('Gemini quota exceeded — check your plan and billing, then reconnect'));
      return;
    }
    if (this.reconnectAttempts >= 6) {
      this._giveUp(new Error(`Live session lost (${RealtimeTranslator.describeClose(event)})`));
      return;
    }
    const delay = event.code === 1008 ? 0 : 500 * 2 ** this.reconnectAttempts; // 1008 = routine expiry
    this.reconnectAttempts++;
    this.stats.reconnects++;
    this._status(delay ? `Connection dropped — reconnecting in ${(delay / 1000).toFixed(1)} s` : 'Reconnecting…');
    clearTimeout(this.reconnectTimer);
    const gen = this.gen;
    this.reconnectTimer = setTimeout(async () => {
      if (!this.active || this.ws || this.rollingOver) return; // a rollover may have completed meanwhile
      try {
        const ws = await this._openWithFallback();
        if (gen !== this.gen || !this.active || this.ws) { try { ws.close(1000, 'client closed'); } catch (_) {} return; }
        this.ws = ws;
        this._afterSocketReady();
      } catch (err) {
        if (err.cancelled) return;
        this._giveUp(err);
      }
    }, delay);
  }

  _giveUp(err) {
    this.active = false;
    this._error(err);
    this._status('Disconnected');
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

  /** End the session. Pending transcript lines are delivered first; the resume handle is dropped. */
  close() {
    if (this.closed) return;
    this.active = false;
    this.gen++;
    clearTimeout(this.reconnectTimer); this.reconnectTimer = null;
    clearInterval(this.watchdog); this.watchdog = null;
    this._finalize('close');
    this._resolveDrain('closed');
    this._flushPlayback();
    for (const ws of [this.ws, this.retiring]) {
      if (!ws) continue;
      // Detach first: the close event fires asynchronously and must not
      // report status for a session the app has already moved past.
      ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
      try { ws.close(1000, 'client closed'); } catch (_) {}
    }
    // The in-flight socket keeps its handlers so its promise settles (as cancelled).
    if (this.opening) { try { this.opening.close(1000, 'client closed'); } catch (_) {} }
    clearTimeout(this.retireTimer);
    this.ws = this.retiring = null;
    this.ready = false;
    this.resumeHandle = null;
    this._saveHandle();
    this._status('Disconnected');
    this.closed = true;
  }

  // ---------------------------------------------------------------------------
  // Mid-session configuration: the target language is fixed at setup, but
  // any setting except the model may change when resuming with the handle.
  // A change while a socket is still connecting is applied by
  // _afterSocketReady, which compares the setup it sent with current opts.
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

  /**
   * After the input ended, wait for the translation of what was said to
   * arrive and finish playing: resolves once a completion (or the silence
   * finalizer) has fired since the drain began and nothing is still
   * scheduled — or after ~1.5 s if nothing arrives at all, or at maxMs.
   */
  drain({ maxMs = 8000, idleMs = 1500 } = {}) {
    this._resolveDrain('superseded');
    if (!this.active || !this.ready) return Promise.resolve('inactive');
    return new Promise((resolve) => {
      const d = { resolve, received: false, completed: false };
      d.timer = setTimeout(() => this._resolveDrain('timeout'), maxMs);
      d.idleTimer = setTimeout(() => { if (!d.received) this._resolveDrain('idle'); }, idleMs);
      this.drainState = d;
    });
  }

  cancelDrain() { this._resolveDrain('cancelled'); }

  _resolveDrain(why) {
    const d = this.drainState;
    if (!d) return;
    clearTimeout(d.timer); clearTimeout(d.idleTimer);
    this.drainState = null;
    d.resolve(why);
  }

  _checkDrain() {
    const d = this.drainState;
    if (!d || !d.completed) return;
    if (this.scheduled.size === 0 || this.gain.gain.value === 0) this._resolveDrain('done');
  }

  // ---------------------------------------------------------------------------
  // Inbound messages — every key is checked independently because one message
  // can bundle audio, transcripts and completion flags.
  // ---------------------------------------------------------------------------
  _handle(msg, fromRetiring = false) {
    if (msg.usageMetadata?.totalTokenCount) this.usage.tokens += msg.usageMetadata.totalTokenCount;
    if (!fromRetiring) {
      if (msg.sessionResumptionUpdate) {
        const u = msg.sessionResumptionUpdate;
        if (u.resumable && u.newHandle) { this.resumeHandle = u.newHandle; this._saveHandle(); }
      }
      if (msg.goAway) {
        const secs = RealtimeTranslator.parseDuration(msg.goAway.timeLeft);
        this._status(`Server is recycling the connection${secs ? ` in ${Math.round(secs)} s` : ''} — switching over`);
        this._rollover('server goAway', { graceful: true });
      }
    }
    const sc = msg.serverContent;
    if (!sc) return;

    if (sc.interrupted) this._flushPlayback();

    if (sc.inputTranscription?.text) {
      this.inText += sc.inputTranscription.text;
      if (sc.inputTranscription.languageCode) this.inLang = sc.inputTranscription.languageCode;
      this.opts.onInputText?.(this.inText.trim(), false, this.inLang);
      this._armFinalize();
      if (this.drainState) this.drainState.received = true;
    }
    if (sc.outputTranscription?.text) {
      this.outText += sc.outputTranscription.text;
      if (sc.outputTranscription.languageCode) this.outLang = sc.outputTranscription.languageCode;
      this.opts.onOutputText?.(this.outText.trim(), false, this.outLang);
      this._armFinalize();
      if (this.drainState) this.drainState.received = true;
    }
    for (const part of sc.modelTurn?.parts || []) {
      if (part.inlineData?.data) {
        this._playPcm(part.inlineData.data, part.inlineData.mimeType);
        if (this.drainState) this.drainState.received = true;
      }
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
    if (this.drainState && this.drainState.received) { this.drainState.completed = true; this._checkDrain(); }
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
    source.onended = () => { this.scheduled.delete(source); this._checkDrain(); };
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
  // Resume-handle persistence: survives a page reload (handles are valid for
  // 2 h); an explicit close() ends the session and drops it.
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

  _status(text) { if (!this.closed) this.opts.onStatus?.(text); }
  _error(err) { if (!this.closed) this.opts.onError?.(err); }
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
