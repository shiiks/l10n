/**
 * l10n — live speech translator (software-first prototype)
 *
 * Pipeline: mic → SpeechRecognition (streaming STT) → Translator (pluggable)
 *           → speechSynthesis (TTS) → active audio output (e.g. earbuds).
 *
 * The three stages are deliberately decoupled so any of them can later be
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
  el.latency.textContent = '';
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
