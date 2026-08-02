# l10n — live speech-to-speech translation

Inspired by [Gemini's speech-to-speech translation demo](https://youtu.be/xdPIwgDriTg):
you speak in one language, the listener hears it in another, in near real time.

The strategy is **software first**: prove the experience with a plain web app and
ordinary Bluetooth earbuds, then decide what (if anything) needs custom hardware.

## Roadmap

| Phase | Goal | Status |
|-------|------|--------|
| 1. Software | Browser app: mic → live STT → translation → TTS out | ✅ this repo |
| 2. Earbuds testing | Use phase 1 with regular Bluetooth earbuds, measure latency/UX | next |
| 3. Native speech-to-speech | Swap the STT→text→TTS chain for a realtime audio model (Gemini Live / OpenAI Realtime) to cut latency and preserve voice tone | later |
| 4. Hardware | Only if software on commodity earbuds isn't enough | later |

## Phase 1: the web app (`web/`)

A zero-build, zero-backend static page:

- **Streaming speech recognition** via the Web Speech API (Chrome/Edge; also
  Chrome on Android — recognition quality is Google's own engine).
- **Live translation preview** while you're mid-sentence, plus a final
  translation per utterance, with per-utterance latency shown in the footer.
- **Spoken output** via browser TTS, played through whatever audio output is
  active — i.e. your earbuds when they're connected.
- **Pluggable translation providers**:
  - *Free* (default): unofficial Google Translate endpoint with MyMemory as
    fallback. No key, fine for prototyping.
  - *Gemini* or *Claude*: bring your own API key (⚙ Settings) for noticeably
    better conversational translations. Keys live only in your browser's
    localStorage and go straight to the provider.
- 18 languages including Hindi, Bengali, Tamil, Telugu, Marathi, Gujarati, Urdu.

### Run it

```bash
cd web
python3 -m http.server 8000
# open http://localhost:8000 in Chrome or Edge
```

Any static file server works. The Web Speech API requires a secure context:
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
mic ──► STT (streaming) ──► Translator (pluggable) ──► TTS ──► audio out
        Web Speech API       free / Gemini / Claude     speechSynthesis
```

Each stage is isolated in `web/app.js` behind a small interface, so phase 3 can
replace the middle of the chain (or the whole chain) with a realtime
speech-to-speech model over WebSocket without touching the UI, and phase 4 can
reuse the same pipeline on embedded hardware.

## License

Apache-2.0 — see [LICENSE](LICENSE).
