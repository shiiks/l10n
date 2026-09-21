# l10n — live speech-to-speech translation

Inspired by [Gemini's speech-to-speech translation demo](https://youtu.be/xdPIwgDriTg):
you speak in one language, the listener hears it in another, in near real time.

The strategy is **software first**: prove the experience with a plain web app and
ordinary Bluetooth earbuds, then decide what (if anything) needs custom hardware.

## Quick start

```bash
./run.sh              # → open http://localhost:8000 in Chrome/Edge
```

Testing **on your phone with earbuds** (the mic needs HTTPS, so localhost
isn't enough from another device):

```bash
./run.sh --tunnel     # → open the https://…trycloudflare.com URL from the log
```

Then: connect earbuds → pick languages → **Start listening** → speak.
The translation appears live and is spoken into your ears. Use
⚙ Settings → **🔊 Test voice** first to confirm audio output works.

`run.sh` uses Docker if available and falls back to `python3 -m http.server`
otherwise. On Windows without WSL, run `docker compose up` directly.
Once merged to `main`, the app also auto-deploys to GitHub Pages
(enable Pages → Source: *GitHub Actions* in repo settings once), so it's
permanently testable at `https://shiiks.github.io/l10n/` with zero setup.

## Roadmap

| Phase | Goal | Status |
|-------|------|--------|
| 1. Software | Browser app: mic → live STT → translation → TTS out | ✅ this repo |
| 2. Earbuds testing | Use phase 1 with regular Bluetooth earbuds, measure latency/UX | next |
| 3. Native speech-to-speech | Swap the STT→text→TTS chain for a realtime audio model (Gemini Live) to cut latency and preserve voice tone | ✅ Realtime mode (Gemini API key) |
| 4. Hardware | Only if software on commodity earbuds isn't enough | later |

## Phase 1: the web app (`web/`)

A zero-build, zero-backend static page. Four input sources feed one pipeline
(speech → text → translation → spoken audio + on-screen text):

| Source | How it's transcribed | Typical use |
|--------|----------------------|-------------|
| 🎙 **Microphone** | Web Speech API (Chrome/Edge, Google's engine) — streaming, with live interim text | Face-to-face conversation, earbuds |
| ⌨ **Text** | — (typed/pasted, Enter to translate) | Quick phrases, chat |
| 🎬 **Video / audio file** | Whisper in-browser *or* Gemini audio | Watch a foreign-language video with live subtitles, or dub it |
| 🖥 **Browser tab** | Whisper in-browser *or* Gemini audio | Live subtitles for YouTube, a meeting, a stream — anything playing in another tab |

- **Streaming speech recognition** for the mic, with a live translation preview
  while you're mid-sentence and per-utterance latency shown in the footer.
- **File and tab audio** is cut into chunks at natural pauses (simple energy
  VAD, 1–8 s) and transcribed by a speech-to-text engine that accepts raw
  audio — the Web Speech API can't, it only listens to the microphone:
  - *Whisper tiny / base / small* run **entirely in your browser** via
    transformers.js (no API key, nothing leaves your machine). The model
    downloads once (~40 / 75 / 250 MB) and is cached. Uses WebGPU when
    available, otherwise WASM — pick a smaller model if the status bar says
    it's falling behind.
  - *Gemini audio* sends each chunk to the Gemini API (key required) for
    better accuracy on hard audio and low-resource languages.
- **Live subtitles** overlay the video; **"Mute original audio (dub)"** replaces
  the original soundtrack with the spoken translation.
- **Spoken output** via browser TTS, played through whatever audio output is
  active — i.e. your earbuds when they're connected.
- **Pluggable translation providers**:
  - *Free* (default): unofficial Google Translate endpoint with MyMemory as
    fallback. No key, fine for prototyping.
  - *Bhashini*: India's national language platform (see below).
  - *Gemini* or *Claude*: bring your own API key (⚙ Settings) for noticeably
    better conversational translations. Keys live only in your browser's
    localStorage and go straight to the provider.
- 23 languages including Hindi, Bengali, Tamil, Telugu, Marathi, Gujarati,
  Urdu, Kannada, Malayalam, Punjabi, Odia and Assamese.

### 🇮🇳 Bhashini for Indian languages

[Bhashini](https://bhashini.gov.in/) is MeitY's open platform — the same
stack that live-translated the 2026 Independence Day address into 22
languages: **IndicConformer** speech recognition, **IndicTrans2** translation
and Indic TTS, all built by AI4Bharat (IIT Madras) and served free through the
ULCA/Dhruva APIs. It's generally far better than Whisper or generic MT on
Indian languages, and it plugs into all three stages here:

| Stage | Where to pick it |
|-------|------------------|
| Speech-to-text | *Speech-to-text engine* → **Bhashini**. For the mic, also set *Recognizer* → "Speech-to-text engine above" (the browser's own recognizer can't be swapped). |
| Translation | ⚙ Settings → *Translation provider* → **Bhashini** |
| Speech output | ⚙ Settings → *Speech output* → **Bhashini voices** (natural Indic voices instead of whatever your OS has installed) |

Credentials: register at bhashini.gov.in → ULCA → **My Profile** gives you a
`userID` and `ulcaApiKey`; paste both into ⚙ Settings. The browser calls the
Bhashini endpoints directly (they allow it), so there's still no backend.
Supported here: en, hi, bn, ta, te, mr, gu, ur, kn, ml, pa, or, as. Bhashini
is chunk-based (it transcribes each pause-delimited chunk), so it belongs to
the chunked pipeline; Realtime mode stays Gemini Live.

**Tab capture tips:** in the share picker choose a *Chrome Tab* (not a window
or screen) and tick **"Share tab audio"** — otherwise there's no audio to
translate. Desktop Chrome/Edge only.

### Phase 3: ⚡ Realtime speech-to-speech mode

The **mode switch** under the source tabs picks the pipeline:

- **Chunked (free)** — the pipeline above. No key, a few seconds behind,
  generic TTS voice.
- **Realtime (Gemini Live)** — one model (`gemini-3.5-live-translate-preview`)
  hears the audio and *speaks* the translation, streaming both ways over a
  WebSocket (`web/realtime.js`). Roughly a second behind, keeps the speaker's
  pacing and intonation, and the source language is detected automatically.
  Works with every audio source — mic, file, tab — and needs a Gemini API key
  in ⚙ Settings. Typed text still goes through the chunked path (the translate
  model accepts audio only).

What the client handles for you: 16 kHz PCM up / 24 kHz PCM down with
gapless scheduled playback, live input/output transcripts, subtitles,
interruption, and the Live API's connection recycling — the server sends
`goAway` roughly every 10 minutes; the client reconnects with the session's
resume handle so nothing is lost, and context-window compression lifts the
15-minute audio cap.

### Automated tests

- `test/e2e.js` — chunked mode: drives headless Chromium through the file
  source with a speech recording and asserts a translation appears (needs
  `playwright`; see the file header).
- `test/mock-live.js` + `test/e2e-realtime.js` — realtime mode without an API
  key: a mock Live API server that speaks the real protocol (setup, audio
  chunks, transcripts, audio replies, `goAway` + resume), and a test that
  streams a file and the fake microphone through it and asserts reconnection.
- `test/mock-bhashini.js` + `test/e2e-bhashini.js` — Bhashini without
  credentials: a mock of the ULCA config + Dhruva inference endpoints that
  validates request shapes, and a test that runs speech-to-text, translation
  and speech output through it for both the file source and the microphone.

### Run it

**With Docker (recommended — platform independent, no dependencies):**

```bash
docker compose up
# or without compose:
docker build -t l10n . && docker run -p 8000:80 l10n
# open http://localhost:8000 in Chrome or Edge
```

The image is based on `nginx:alpine` and builds for amd64 and arm64, so it runs
the same on Linux servers, Windows/macOS (Docker Desktop), Apple Silicon, and
Raspberry Pi class devices. Once CI publishes to GitHub Container Registry
(on pushes to `main`), anyone can run it without cloning:

```bash
docker run -p 8000:80 ghcr.io/shiiks/l10n:latest
```

**Without Docker** — it's a static page, any file server works:

```bash
cd web
python3 -m http.server 8000
# open http://localhost:8000 in Chrome or Edge
```

The Web Speech API requires a secure context:
`localhost` counts, but to test **on your phone** you need HTTPS — easiest
options are GitHub Pages, `npx serve` behind a tunnel (e.g. `cloudflared`,
`ngrok`), or Tailscale HTTPS.

### Testing with earbuds (phase 2 notes)

- Connect your earbuds, open the app, press **Start listening**, and speak.
  The translation is spoken into your ears automatically.
- **Bluetooth caveat**: when the browser uses your earbuds' *microphone*, most
  earbuds drop to the low-bandwidth headset profile (HFP), which degrades both
  what the recognizer hears and the TTS audio quality. For best results use the
  **phone/laptop microphone for input** and earbuds for output only (pick the
  mic in the browser's site permissions or OS sound settings).
- "Pause mic while speaking" (on by default) stops the app from translating its
  own TTS output — needed on open speakers, optional when output is earbuds.
- Watch the `translate: N ms` readout in the footer; total perceived latency is
  roughly end-of-phrase detection (~0.5–1 s) + translation + TTS start.

## Architecture

```
mic ─────────► Web Speech API ──┐
text ───────────────────────────┤
video/audio file ─► chunker ─► Whisper (in-browser) or Gemini audio ─┤
browser tab ──────► chunker ─►            (media.js)                 ─┤
                                                                      ▼
                              Translator (free / Gemini / Claude) ─► TTS + subtitles
```

Each stage is isolated behind a small interface (`Translators`, `L10nMedia.Engines`,
`speak()`), so phase 3 can replace the middle of the chain with a realtime
speech-to-speech model over WebSocket without touching the UI, and phase 4 can
reuse the same pipeline on embedded hardware.

## License

Apache-2.0 — see [LICENSE](LICENSE).
