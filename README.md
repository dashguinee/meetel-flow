# Meetel Flow (Windows-first core)

Meetel Flow is a desktop dictation shell with local-first transcription and cloud fallback.

## Implemented now

- Floating desktop widget
- Global hotkey toggle: `Ctrl/Cmd + Space`
- Microphone capture and push-to-transcribe cycle
- STT routing chain:
  - Local Whisper-compatible endpoint (primary)
  - Gladia fallback
  - Google Speech-to-Text fallback
- Cross-app insertion mode:
  - `type` (Windows/macOS)
  - `clipboard`
- Config persisted at `~/.meetel-flow/config.json`
- Windows packaging scaffold + updater channel integration
- Android IME scaffold

## Local-first STT (host your own)

Start local faster-whisper server:

```bash
npm run stt:local
```

Health check:

```bash
curl http://127.0.0.1:8000/health
```

Default desktop local endpoint:

- `http://127.0.0.1:8000/v1/audio/transcriptions`

## Run desktop app

```bash
npm install
npm start
```

## Packaging

```bash
npm run dist:win
```

Artifacts land in `dist/`.

## Update channel

`electron-updater` is enabled in packaged builds and reads `publish.url` from `package.json`:

- `https://updates.meetel.com/flow`

You should host generated update metadata and binaries on that endpoint.

## Android IME

Scaffold location:

- `android-ime/`

Shared auth/session contract:

- `contracts/session-contract.json`
