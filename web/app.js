/**
 * l10n — live translator (software-first prototype)
 *
 * Pipeline: source → speech-to-text → Translator (pluggable)
 *           → speechSynthesis (TTS) → active audio output (e.g. earbuds).
 *
 * Sources: microphone (Web Speech API streaming STT), typed text, a video or
 * audio file, or any browser tab (both via media.js: Whisper in-browser or
 * Gemini audio). The stages are deliberately decoupled so any of them can be
 * swapped for a native realtime speech-to-speech model or on-device hardware.
 */

'use strict';

// ---------------------------------------------------------------------------
// Languages: recognition uses BCP-47 tags, translation uses short ISO codes.
// ---------------------------------------------------------------------------
const LANGUAGES = [
  { code: 'en', bcp47: 'en-US', name: 'English' },
  { code: 'hi', bcp47: 'hi-IN', name: 'Hindi' },
  { code: 'es', bcp47: 'es-ES', name: 'Spanish' },
  { code: 'fr', bcp47: 'fr-FR', name: 'French' },
  { code: 'de', bcp47: 'de-DE', name: 'German' },
  { code: 'it', bcp47: 'it-IT', name: 'Italian' },
  { code: 'pt', bcp47: 'pt-BR', name: 'Portuguese' },
  { code: 'ja', bcp47: 'ja-JP', name: 'Japanese' },
  { code: 'ko', bcp47: 'ko-KR', name: 'Korean' },
  { code: 'zh-CN', bcp47: 'zh-CN', name: 'Chinese (Mandarin)' },
  { code: 'ru', bcp47: 'ru-RU', name: 'Russian' },
  { code: 'ar', bcp47: 'ar-SA', name: 'Arabic' },
  { code: 'bn', bcp47: 'bn-IN', name: 'Bengali' },
  { code: 'ta', bcp47: 'ta-IN', name: 'Tamil' },
  { code: 'te', bcp47: 'te-IN', name: 'Telugu' },
  { code: 'mr', bcp47: 'mr-IN', name: 'Marathi' },
  { code: 'gu', bcp47: 'gu-IN', name: 'Gujarati' },
  { code: 'ur', bcp47: 'ur-PK', name: 'Urdu' },
];

const langByCode = (code) => LANGUAGES.find((l) => l.code === code);

// ---------------------------------------------------------------------------
// Translators — each takes (text, srcCode, tgtCode) and returns a Promise<string>.
// ---------------------------------------------------------------------------
const Translators = {
  /** Unofficial Google endpoint; no key. Falls back to MyMemory on failure. */
  async free(text, src, tgt) {
    try {
      const url =
        'https://translate.googleapis.com/translate_a/single?client=gtx&dt=t' +
        `&sl=${encodeURIComponent(src)}&tl=${encodeURIComponent(tgt)}&q=${encodeURIComponent(text)}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`gtx ${res.status}`);
      const data = await res.json();
      return data[0].map((seg) => seg[0]).join('');
    } catch (err) {
      const pair = `${src}|${tgt}`;
      const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${encodeURIComponent(pair)}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`mymemory ${res.status}`);
      const data = await res.json();
      return data.responseData.translatedText;
    }
  },

  async gemini(text, src, tgt) {
    const key = settings.apiKey;
    if (!key) throw new Error('Gemini API key missing — set it in Settings');
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${encodeURIComponent(key)}`;
    const prompt = translationPrompt(text, src, tgt);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    });
    if (!res.ok) throw new Error(`Gemini ${res.status}`);
    const data = await res.json();
    return data.candidates[0].content.parts[0].text.trim();
  },

  async claude(text, src, tgt) {
    const key = settings.apiKey;
    if (!key) throw new Error('Claude API key missing — set it in Settings');
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        messages: [{ role: 'user', content: translationPrompt(text, src, tgt) }],
      }),
    });
    if (!res.ok) throw new Error(`Claude ${res.status}`);
    const data = await res.json();
    return data.content[0].text.trim();
  },
};

function translationPrompt(text, src, tgt) {
  const srcName = langByCode(src)?.name || src;
  const tgtName = langByCode(tgt)?.name || tgt;
  return (
    `Translate the following ${srcName} speech into natural, conversational ${tgtName}. ` +
    `Reply with ONLY the translation, no explanations or quotes.\n\n${text}`
  );
}

// ---------------------------------------------------------------------------
// State & settings
// ---------------------------------------------------------------------------
const settings = {
  provider: localStorage.getItem('l10n.provider') || 'free',
  apiKey: localStorage.getItem('l10n.apiKey') || '',
  voiceURI: localStorage.getItem('l10n.voiceURI') || '',
};

const state = {
  listening: false,      // user intent: mic should be on
  recognizing: false,    // engine actually running
  speaking: false,
  recognition: null,
  interimTimer: null,
  utteranceSeq: 0,       // guards against out-of-order async translations
};

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const el = {
  srcLang: $('srcLang'), tgtLang: $('tgtLang'), swapBtn: $('swapBtn'),
  srcFinal: $('srcFinal'), srcInterim: $('srcInterim'),
  tgtFinal: $('tgtFinal'), tgtInterim: $('tgtInterim'),
  micBtn: $('micBtn'), speakToggle: $('speakToggle'), duckToggle: $('duckToggle'),
  clearBtn: $('clearBtn'), status: $('status'), latency: $('latency'),
  banner: $('unsupportedBanner'),
  settingsBtn: $('settingsBtn'), settingsDialog: $('settingsDialog'),
  providerSelect: $('providerSelect'), apiKeyInput: $('apiKeyInput'),
  voiceSelect: $('voiceSelect'), settingsSave: $('settingsSave'),
  settingsClose: $('settingsClose'), voiceTest: $('voiceTest'),
  sourceTabs: $('sourceTabs'), panelText: $('panelText'), panelMedia: $('panelMedia'),
  textInput: $('textInput'), textTranslateBtn: $('textTranslateBtn'),
  fileInput: $('fileInput'), shareTabBtn: $('shareTabBtn'), engineSelect: $('engineSelect'),
  muteOriginal: $('muteOriginal'), engineProgress: $('engineProgress'),
  engineProgressBar: $('engineProgressBar'), engineProgressText: $('engineProgressText'),
  mediaVideo: $('mediaVideo'), subtitle: $('subtitle'),
};

function setStatus(text) { el.status.textContent = text; }

// ---------------------------------------------------------------------------
// Language selectors
// ---------------------------------------------------------------------------
function populateLangSelect(select, selectedCode) {
  select.innerHTML = '';
  for (const lang of LANGUAGES) {
    const opt = document.createElement('option');
    opt.value = lang.code;
    opt.textContent = lang.name;
    if (lang.code === selectedCode) opt.selected = true;
    select.appendChild(opt);
  }
}

populateLangSelect(el.srcLang, localStorage.getItem('l10n.src') || 'en');
populateLangSelect(el.tgtLang, localStorage.getItem('l10n.tgt') || 'hi');

function onLangChange() {
  localStorage.setItem('l10n.src', el.srcLang.value);
  localStorage.setItem('l10n.tgt', el.tgtLang.value);
  if (state.listening) restartRecognition();
}
el.srcLang.addEventListener('change', onLangChange);
el.tgtLang.addEventListener('change', onLangChange);

el.swapBtn.addEventListener('click', () => {
  const s = el.srcLang.value;
  el.srcLang.value = el.tgtLang.value;
  el.tgtLang.value = s;
  onLangChange();
});

// ---------------------------------------------------------------------------
// Speech recognition (streaming STT)
// ---------------------------------------------------------------------------
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
if (!SpeechRecognition) {
  el.banner.classList.remove('hidden');
  el.micBtn.disabled = true;
}

function createRecognition() {
  const rec = new SpeechRecognition();
  rec.lang = langByCode(el.srcLang.value)?.bcp47 || 'en-US';
  rec.continuous = true;
  rec.interimResults = true;

  rec.onstart = () => { state.recognizing = true; setStatus(`Listening (${rec.lang})…`); };

  rec.onresult = (event) => {
    let interim = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      if (result.isFinal) {
        const text = result[0].transcript.trim();
        if (text) handleFinalUtterance(text);
      } else {
        interim += result[0].transcript;
      }
    }
    el.srcInterim.textContent = interim;
    scheduleInterimTranslation(interim);
  };

  rec.onerror = (event) => {
    if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
      state.listening = false;
      updateMicButton();
      setStatus('Microphone access denied');
    } else if (event.error !== 'no-speech' && event.error !== 'aborted') {
      setStatus(`Recognition error: ${event.error}`);
    }
  };

  // Chrome stops the engine periodically; restart while the user wants it on.
  rec.onend = () => {
    state.recognizing = false;
    if (state.listening && !(state.speaking && el.duckToggle.checked)) {
      setTimeout(() => { if (state.listening && !state.recognizing) startEngine(); }, 250);
    } else if (!state.listening) {
      setStatus('Idle');
    }
  };

  return rec;
}

function startEngine() {
  if (state.recognizing) return;
  state.recognition = createRecognition();
  try { state.recognition.start(); } catch (_) { /* already started */ }
}

function stopEngine() {
  if (state.recognition) { try { state.recognition.abort(); } catch (_) {} }
  state.recognizing = false;
}

function restartRecognition() {
  stopEngine();
  setTimeout(startEngine, 250);
}

function updateMicButton() {
  el.micBtn.textContent = state.listening ? '⏹ Stop listening' : '🎙 Start listening';
  el.micBtn.classList.toggle('active', state.listening);
}

el.micBtn.addEventListener('click', () => {
  unlockTTS(); // user gesture — unlock speech output for later programmatic use
  state.listening = !state.listening;
  updateMicButton();
  if (state.listening) startEngine();
  else { stopEngine(); setStatus('Idle'); }
});

// ---------------------------------------------------------------------------
// Translation
// ---------------------------------------------------------------------------
async function translate(text) {
  const fn = Translators[settings.provider] || Translators.free;
  return fn(text, el.srcLang.value, el.tgtLang.value);
}

async function handleFinalUtterance(text) {
  const seq = ++state.utteranceSeq;
  appendLine(el.srcFinal, text);
  el.srcInterim.textContent = '';
  const t0 = performance.now();
  try {
    const translated = await translate(text);
    if (seq === state.utteranceSeq) el.tgtInterim.textContent = '';
    appendLine(el.tgtFinal, translated);
    el.subtitle.textContent = translated;
    el.latency.textContent = `translate: ${Math.round(performance.now() - t0)} ms`;
    if (el.speakToggle.checked) speak(translated);
  } catch (err) {
    appendLine(el.tgtFinal, `⚠ ${err.message}`, true);
  }
}

/** Live preview: translate interim text, debounced, latest-wins. */
function scheduleInterimTranslation(interim) {
  clearTimeout(state.interimTimer);
  if (!interim.trim()) { el.tgtInterim.textContent = ''; return; }
  state.interimTimer = setTimeout(async () => {
    const seq = state.utteranceSeq;
    try {
      const translated = await translate(interim.trim());
      if (seq === state.utteranceSeq && el.srcInterim.textContent.trim()) {
        el.tgtInterim.textContent = translated;
      }
    } catch (_) { /* preview only — ignore */ }
  }, 350);
}

function appendLine(container, text, isError = false) {
  const div = document.createElement('div');
  div.className = 'line' + (isError ? ' error' : '');
  div.textContent = text;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

el.clearBtn.addEventListener('click', () => {
  el.srcFinal.innerHTML = '';
  el.tgtFinal.innerHTML = '';
  el.srcInterim.textContent = '';
  el.tgtInterim.textContent = '';
  el.subtitle.textContent = '';
  el.latency.textContent = '';
});

// ---------------------------------------------------------------------------
// Input sources: mic (above) | text | video/audio file | browser tab
// ---------------------------------------------------------------------------
state.source = 'mic';
state.media = null;        // active L10nMedia session
state.mediaQueue = [];     // pending audio chunks awaiting transcription
state.transcribing = false;

function setSource(source) {
  if (source === state.source) return;
  if (state.listening) { state.listening = false; stopEngine(); updateMicButton(); }
  closeMediaSession();
  if (el.mediaVideo.srcObject) {
    el.mediaVideo.srcObject.getTracks().forEach((t) => t.stop());
    el.mediaVideo.srcObject = null;
  }
  state.source = source;
  document.body.dataset.source = source;
  for (const tab of el.sourceTabs.querySelectorAll('.tab')) {
    tab.classList.toggle('active', tab.dataset.source === source);
  }
  el.panelText.classList.toggle('hidden', source !== 'text');
  el.panelMedia.classList.toggle('hidden', source !== 'file' && source !== 'tab');
  setStatus('Idle');
  if (source === 'text') el.textInput.focus();
}
document.body.dataset.source = 'mic';

el.sourceTabs.addEventListener('click', (event) => {
  const tab = event.target.closest('.tab');
  if (tab) { unlockTTS(); setSource(tab.dataset.source); }
});

// --- Text -------------------------------------------------------------------
function submitText() {
  const text = el.textInput.value.trim();
  if (!text) return;
  el.textInput.value = '';
  handleFinalUtterance(text);
}
el.textTranslateBtn.addEventListener('click', () => { unlockTTS(); submitText(); });
el.textInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); unlockTTS(); submitText(); }
});

// --- Shared media pipeline: chunk → transcribe → handleFinalUtterance --------
function showEngineProgress(file, pct) {
  el.engineProgress.classList.remove('hidden');
  if (file === 'ready') {
    el.engineProgressText.textContent = 'Speech model ready';
    el.engineProgressBar.style.width = '100%';
    setTimeout(() => el.engineProgress.classList.add('hidden'), 1500);
    return;
  }
  el.engineProgressBar.style.width = `${Math.round(pct)}%`;
  el.engineProgressText.textContent = `Downloading speech model… ${file.split('/').pop()} ${Math.round(pct)}%`;
}

async function loadEngine() {
  const choice = el.engineSelect.value;
  if (choice === 'gemini') {
    return L10nMedia.Engines.gemini({
      apiKey: settings.apiKey,
      langName: langByCode(el.srcLang.value)?.name,
    });
  }
  return L10nMedia.Engines.whisper({ model: choice, onProgress: showEngineProgress });
}

function onAudioChunk(chunk) {
  // Keep the queue short: if transcription can't keep up, skip the oldest
  // chunks rather than drifting ever further behind the live audio.
  if (state.mediaQueue.length >= 3) {
    state.mediaQueue.shift();
    setStatus('Falling behind — try the smaller Whisper model');
  }
  state.mediaQueue.push(chunk);
  drainMediaQueue();
}

async function drainMediaQueue() {
  if (state.transcribing) return;
  state.transcribing = true;
  try {
    while (state.mediaQueue.length) {
      const chunk = state.mediaQueue.shift();
      setStatus('Transcribing…');
      const t0 = performance.now();
      const transcribe = await loadEngine();
      const text = await transcribe(chunk, el.srcLang.value);
      state.lastMediaError = null;
      el.latency.textContent = `stt: ${Math.round(performance.now() - t0)} ms`;
      if (text) handleFinalUtterance(text);
    }
    if (state.media) setStatus('Listening to media…');
  } catch (err) {
    if (err.message !== state.lastMediaError) appendLine(el.tgtFinal, `⚠ ${err.message}`, true);
    state.lastMediaError = err.message;
    setStatus('Transcription error');
  } finally {
    state.transcribing = false;
  }
}

function closeMediaSession() {
  if (state.media) { state.media.close(); state.media = null; }
  state.mediaQueue = [];
  el.subtitle.textContent = '';
}

// --- Video / audio file -------------------------------------------------------
el.fileInput.addEventListener('change', async () => {
  const file = el.fileInput.files[0];
  if (!file) return;
  unlockTTS();
  closeMediaSession();
  el.mediaVideo.srcObject = null;
  el.mediaVideo.src = URL.createObjectURL(file);
  el.mediaVideo.muted = false;
  try {
    state.media = await L10nMedia.openElementSession(el.mediaVideo, { onChunk: onAudioChunk });
    state.media.setOriginalVolume(el.muteOriginal.checked ? 0 : 1);
    setStatus('Press play to start translating');
    loadEngine().catch(() => {}); // warm the model while the user hits play
  } catch (err) {
    appendLine(el.tgtFinal, `⚠ Could not capture audio: ${err.message}`, true);
  }
});

el.muteOriginal.addEventListener('change', () => {
  if (state.media) state.media.setOriginalVolume(el.muteOriginal.checked ? 0 : 1);
});

el.mediaVideo.addEventListener('play', () => {
  if (state.media) { state.media.resume(); setStatus('Listening to media…'); }
});
el.mediaVideo.addEventListener('pause', () => { if (state.media) state.media.chunker.flush(); });
el.mediaVideo.addEventListener('ended', () => { if (state.media) state.media.chunker.flush(); });

// --- Browser tab ---------------------------------------------------------------
el.shareTabBtn.addEventListener('click', async () => {
  unlockTTS();
  if (!navigator.mediaDevices?.getDisplayMedia) {
    appendLine(el.tgtFinal, '⚠ Tab capture is not supported in this browser (use desktop Chrome/Edge).', true);
    return;
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
  } catch (_) {
    return; // user cancelled the picker
  }
  if (stream.getAudioTracks().length === 0) {
    stream.getTracks().forEach((t) => t.stop());
    appendLine(el.tgtFinal, '⚠ No audio in the shared tab — tick "Share tab audio" in the picker and choose a tab, not a window.', true);
    return;
  }
  closeMediaSession();
  el.mediaVideo.src = '';
  el.mediaVideo.srcObject = stream;
  el.mediaVideo.muted = true; // the tab itself is already audible
  el.mediaVideo.play().catch(() => {});
  try {
    state.media = await L10nMedia.openStreamSession(stream, { onChunk: onAudioChunk });
    await state.media.resume();
    setStatus('Listening to tab…');
    loadEngine().catch(() => {});
  } catch (err) {
    appendLine(el.tgtFinal, `⚠ Could not capture tab audio: ${err.message}`, true);
  }
  stream.getVideoTracks()[0]?.addEventListener('ended', () => {
    closeMediaSession();
    el.mediaVideo.srcObject = null;
    setStatus('Tab sharing stopped');
  });
});

// ---------------------------------------------------------------------------
// Speech synthesis (TTS) — plays through the system's active output device.
// ---------------------------------------------------------------------------
let voices = [];

function refreshVoices() {
  voices = speechSynthesis.getVoices();
  const current = settings.voiceURI;
  el.voiceSelect.innerHTML = '<option value="">Auto (match target language)</option>';
  for (const v of voices) {
    const opt = document.createElement('option');
    opt.value = v.voiceURI;
    opt.textContent = `${v.name} (${v.lang})`;
    if (v.voiceURI === current) opt.selected = true;
    el.voiceSelect.appendChild(opt);
  }
  const hint = document.getElementById('voiceCountHint');
  if (hint) {
    hint.textContent = voices.length
      ? `${voices.length} speech voices available in this browser.`
      : '⚠ No speech voices available — this browser/OS cannot speak. On Linux install speech-dispatcher, or use Chrome on Windows/macOS/Android.';
  }
}
refreshVoices();
if ('onvoiceschanged' in speechSynthesis) speechSynthesis.onvoiceschanged = refreshVoices;

function pickVoice(tgtCode) {
  if (settings.voiceURI) {
    const chosen = voices.find((v) => v.voiceURI === settings.voiceURI);
    if (chosen) return chosen;
  }
  const bcp47 = langByCode(tgtCode)?.bcp47 || tgtCode;
  const prefix = bcp47.split('-')[0].toLowerCase();
  return (
    voices.find((v) => v.lang.toLowerCase() === bcp47.toLowerCase()) ||
    voices.find((v) => v.lang.toLowerCase().startsWith(prefix)) ||
    null
  );
}

const IS_ANDROID = /Android/i.test(navigator.userAgent);
let keepaliveTimer = null;
let missingVoiceWarned = false;

/**
 * Desktop Chrome halts long utterances after ~15 s unless nudged with
 * pause()/resume(). The same trick kills audio on Android, so desktop only.
 */
function startKeepalive() {
  if (IS_ANDROID) return;
  clearInterval(keepaliveTimer);
  keepaliveTimer = setInterval(() => {
    if (!speechSynthesis.speaking) { clearInterval(keepaliveTimer); return; }
    speechSynthesis.pause();
    speechSynthesis.resume();
  }, 10000);
}

function finishSpeaking() {
  if (speechSynthesis.speaking || speechSynthesis.pending) return; // queue continues
  state.speaking = false;
  clearInterval(keepaliveTimer);
  if (state.listening && !state.recognizing) {
    setTimeout(() => { if (state.listening && !state.recognizing) startEngine(); }, 200);
  } else if (!state.listening) {
    setStatus('Idle');
  }
}

function speak(text) {
  const tgt = el.tgtLang.value;
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = langByCode(tgt)?.bcp47 || tgt;
  const voice = pickVoice(tgt);
  if (voice) {
    utterance.voice = voice;
  } else if (!missingVoiceWarned) {
    missingVoiceWarned = true;
    const name = langByCode(tgt)?.name || tgt;
    appendLine(el.tgtFinal, `⚠ No ${name} voice installed in this browser — trying the system default. Pick a voice in ⚙ Settings.`, true);
  }

  // Release the mic BEFORE speaking: while recognition holds the audio
  // session (notably Chrome on Android), TTS is silently discarded and
  // onstart never fires. state.speaking is set synchronously so the
  // recognizer's onend handler doesn't immediately restart the mic.
  state.speaking = true;
  if (el.duckToggle.checked && state.recognizing) stopEngine();

  utterance.onstart = () => setStatus('Speaking…');
  utterance.onend = finishSpeaking;
  utterance.onerror = (event) => {
    if (event.error !== 'interrupted' && event.error !== 'canceled') {
      appendLine(el.tgtFinal, `⚠ Speech output failed: ${event.error}`, true);
      setStatus(`TTS error: ${event.error}`);
    }
    finishSpeaking();
  };

  speechSynthesis.resume(); // Chrome can be stuck in a paused state
  speechSynthesis.speak(utterance); // queues if something is already playing
  startKeepalive();
}

/**
 * Browsers require speak() inside a user gesture at least once before
 * allowing programmatic speech. The mic button click is that gesture.
 */
let ttsUnlocked = false;
function unlockTTS() {
  if (ttsUnlocked) return;
  ttsUnlocked = true;
  speechSynthesis.resume();
  speechSynthesis.speak(new SpeechSynthesisUtterance(''));
}

// ---------------------------------------------------------------------------
// Settings dialog
// ---------------------------------------------------------------------------
el.settingsBtn.addEventListener('click', () => {
  el.providerSelect.value = settings.provider;
  el.apiKeyInput.value = settings.apiKey;
  refreshVoices();
  el.settingsDialog.showModal();
});

el.settingsSave.addEventListener('click', () => {
  settings.provider = el.providerSelect.value;
  settings.apiKey = el.apiKeyInput.value.trim();
  settings.voiceURI = el.voiceSelect.value;
  localStorage.setItem('l10n.provider', settings.provider);
  localStorage.setItem('l10n.apiKey', settings.apiKey);
  localStorage.setItem('l10n.voiceURI', settings.voiceURI);
  el.settingsDialog.close();
});

el.settingsClose.addEventListener('click', () => el.settingsDialog.close());

el.voiceTest.addEventListener('click', () => {
  // Use the dialog's current (unsaved) selection so voices can be auditioned.
  const prev = settings.voiceURI;
  settings.voiceURI = el.voiceSelect.value;
  missingVoiceWarned = false;
  ttsUnlocked = true; // this click is itself the unlocking gesture
  speak('Testing, one two three.');
  settings.voiceURI = prev;
});

updateMicButton();
