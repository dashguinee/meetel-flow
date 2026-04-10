# Meetel Flow — Architecture

## What it is

Meetel Flow is an Electron desktop dictation app that turns voice into text in any
application on the user's machine. Press `Ctrl+Space` anywhere in the OS, speak a
sentence, release — the cleaned-up text gets pasted at the cursor position of the
app you were focused on. STT runs through Groq Whisper (cloud, `$0.04/hr`) with a
`whisper.cpp` local fallback. An LLM polish pass (Groq Llama 3.3 70B, then Gemini
2.0 Flash fallback) fixes grammar, punctuation, accents, and strips filler words
before insertion.

- **Version**: v0.2.3 (shipped 2026-04-10)
- **Repo**: https://github.com/dashguinee/meetel-flow
- **Source**: `/home/dash/meetel-flow/`
- **Platforms**: Windows (NSIS, primary), macOS (DMG x64+arm64, unsigned), Linux (AppImage)
- **Electron**: 34.x | **TypeScript**: 5.7 strict | **Supabase**: project `mclbbkmpovnvcfmwsoqt`

---

## High-level architecture

```
              ┌────────────────────────────────────────────────────┐
              │              MAIN PROCESS (Node)                   │
              │                                                    │
              │  src/main/index.ts        — Electron lifecycle,    │
              │  ├─ globalShortcut          windows, IPC routing   │
              │  ├─ BrowserWindow           tray, hotkey register  │
              │  ├─ Tray                                           │
              │  │                                                 │
              │  ├── stt.ts      — Groq Whisper HTTPS + whisper.cpp│
              │  ├── filters.ts  — hallucination + RMS filter      │
              │  ├── inserter.ts — clipboard-paste via SendKeys/   │
              │  │                 osascript                       │
              │  ├── telemetry.ts── Supabase client singleton,     │
              │  ├── sync.ts          queue, backoff, identifyUser │
              │  ├── config.ts   — ~/.meetel-flow/config.json      │
              │  ├── usage.ts    — 100min/mo free cap              │
              │  ├── ambiverse.ts── Supabase Realtime bilingual    │
              │  │                    room (broadcast channel)     │
              │  └── updater.ts  — electron-updater                │
              │                                                    │
              │           preload.ts (contextBridge)               │
              │               ↑                ↑                   │
              │       window.meetelFlow   window.meetelFirstRun    │
              └────────────┬────────────────────┬──────────────────┘
                           │                    │
                      IPC (invoke)          IPC (invoke)
                           │                    │
              ┌────────────▼──────┐   ┌─────────▼─────────────┐
              │  RENDERER:        │   │  RENDERER:            │
              │  main capsule     │   │  first-run wizard     │
              │  (index.html +    │   │  (firstrun.html +     │
              │   renderer.ts)    │   │   firstrun.ts)        │
              │                   │   │                       │
              │  • hot mic ring   │   │  6 screens            │
              │    buffer (30s)   │   │  arm/disarm dance     │
              │  • WAV encoder    │   │  mic probe            │
              │  • 3 view modes:  │   │  in-window dictation  │
              │    panel/compact/ │   │                       │
              │    island         │   │                       │
              │  • localStorage   │   │                       │
              │    transcripts    │   │                       │
              └────────┬──────────┘   └─────────┬─────────────┘
                       │                        │
                       │     audio / text       │
                       └───────┬────────────────┘
                               │
                               ▼
            ┌───────────────────────────────────────┐
            │  CLOUD                                │
            │                                       │
            │  api.groq.com (Whisper + Llama)       │
            │  generativelanguage.googleapis.com    │
            │      (Gemini polish fallback)         │
            │  mclbbkmpovnvcfmwsoqt.supabase.co     │
            │      (users, events, transcripts,     │
            │       Realtime channels)              │
            └───────────────────────────────────────┘
```

**Boundary summary**

- **OS ↔ main**: `globalShortcut` (hotkey capture), tray, NSIS installer state, auto-updater, keystroke/paste scripts (`powershell SendKeys` on Windows, `osascript` on macOS), Electron session permissions.
- **Main ↔ renderer**: all audio bytes flow via IPC as base64 WAV; all config is main-owned (`~/.meetel-flow/config.json`); renderer can only request config through preload channels.
- **Renderer ↔ cloud**: renderer never talks to cloud directly. STT, LLM polish, and Supabase writes all happen in main.
- **Exception**: `ambiverse.ts` (main) creates Supabase Realtime broadcast channels. The live-translation feature is the only bidirectional cloud socket.

---

## Process model

### Main process — `src/main/`

One Electron main process hosts every privileged operation: window management,
global hotkey registration, filesystem config, HTTPS calls to Groq/Gemini, child
process spawns for `whisper-cli.exe` and the paste script, Supabase client, and
the telemetry queue. `src/main/index.ts` is the only file allowed to import from
`electron`. Every other module in `src/main/` is pure Node + `@supabase/supabase-js`
or uses `electron` only for a tiny surface (`clipboard` in `inserter.ts`, `app` in
`telemetry.ts`, `autoUpdater` in `updater.ts`).

Debug log redirection lives at the top of `index.ts`: `console.log` / `console.error`
get wrapped to also append to `~/.meetel-flow/debug.log` with millisecond
timestamps. Every subsequent `console.log` in main lands there — do not add
try/catch that swallows errors back to `null`, it defeats the diagnostic path.

### Renderer processes — 2 separate BrowserWindows

The app boots into **one of two** renderer windows depending on
`config.firstRunComplete`:

| Window | Script | HTML | Preload bridge | BrowserWindow flags |
|---|---|---|---|---|
| Main capsule | `renderer.ts` | `index.html` | `window.meetelFlow` | frameless, transparent, alwaysOnTop, `focusable: false`, `skipTaskbar: true` |
| First-run wizard | `firstrun.ts` | `firstrun.html` | `window.meetelFirstRun` (+ `meetelFlow` subset for STT) | frameless, transparent, `focusable: true`, `show: false` until `ready-to-show` |

Isolation: `contextIsolation: true`, `nodeIntegration: false` on both. The
renderer cannot `require()`, cannot touch the filesystem, cannot make arbitrary
HTTPS calls — only the channels explicitly exposed by `preload.ts` exist on
`window.*`. This is also why all audio data flows as base64 strings over IPC
(Electron IPC doesn't cleanly marshal raw Buffers across the context bridge).

### IPC channels

Every channel is `ipcMain.handle` (promise-based) unless noted. Sender → receiver:

| Channel | Direction | Purpose |
|---|---|---|
| `stt:transcribe` | renderer → main | Send base64 WAV for STT + polish; returns `{text, provider, detectedLang}` or `{error}` |
| `stt:insert` | renderer → main | Paste finished text at OS cursor |
| `config:get` | renderer → main | Read full `FlowConfig` |
| `config:save` | renderer → main | Persist partial `FlowConfig`; each changed key emits a `settings_changed` telemetry event |
| `usage:get` | renderer → main | Current month minutes used / remaining |
| `shell:openExternal` | renderer → main | Open an `https://` URL in the OS browser (allowlist: `https://` prefix only) |
| `window:setOpacity` | renderer → main | Idle-fade control (0.05–1.0 clamped) |
| `window:setFocusable` | renderer → main | Toggle click-through behaviour |
| `window:setMode` | renderer → main | Switch between `panel`/`compact`/`island` view; resizes BrowserWindow |
| `window:toggleFullscreen` | renderer → main | Maximize/unmaximize frameless window |
| `telemetry:track` | renderer → main | Allowlisted events only (`first_run_start`, `first_run_complete`, `mic_permission_result`, `error`) |
| `firstrun:createUser` | wizard → main | Onboard user via `telemetry.identifyUser(email, name)` |
| `firstrun:requestMicPermission` | wizard → main | On macOS, `systemPreferences.askForMediaAccess('microphone')`; elsewhere returns optimistic true |
| `firstrun:armHotkeyTeach` | wizard → main | **Unregister** `globalShortcut` so the wizard's in-window `keydown` can see the chord |
| `firstrun:disarmHotkeyTeach` | wizard → main | Re-register `globalShortcut` after the teach screen |
| `firstrun:skipFirstDictation` | wizard → main | Persist the skipped flag |
| `firstrun:markComplete` | wizard → main | Set `firstRunComplete`, spawn the capsule window, close the wizard |
| `ambiverse:create` | renderer → main | Create a 4-digit Supabase Realtime room |
| `ambiverse:join` | renderer → main | Join an existing room |
| `ambiverse:leave` | renderer → main | Leave the room |
| `ambiverse:send` | renderer → main | Broadcast a transcript to the paired peer |
| `ambiverse:status` | renderer → main | `{connected, room}` |
| `hotkey:toggle` | main → renderer | **Event** (`webContents.send`): global hotkey fired, renderer should start/stop recording |
| `firstrun:hotkeyFired` | main → wizard | **Event**: global hotkey fired AND wizard is open — backup path when the teach arm/disarm window of focus is weird |
| `firstrun:dictationSuccess` | main → wizard | **Event**: first successful dictation landed; wizard screen 5 advances |
| `ambiverse:received` | main → renderer | **Event**: remote peer broadcast arrived (text + translation) |

---

## File map

```
/home/dash/meetel-flow/
├── package.json                    — scripts, deps, electron-builder config, build.publish.releaseType=draft
├── tsconfig.main.json              — CommonJS target for Node main process
├── tsconfig.renderer.json          — DOM lib for renderer
├── .github/workflows/release.yml   — on tag v*, builds NSIS installer on windows-latest, publishes draft
├── build-resources/                — macOS entitlements plist, Info.plist notes, README (no icons yet)
├── supabase/
│   ├── meetel-schema.sql           — idempotent: tables, RLS policies, view, first_dictation trigger
│   └── PASTE_THIS_meetel.sql       — condensed copy-paste version of the above for the Supabase SQL editor
├── docs/                           — landing page copy, misc notes
├── FILTERS_INTEGRATION.md          — how filters.ts was wired into stt.ts
├── FIRSTRUN_INTEGRATION.md         — wizard integration notes (the "why arm/disarm" doc)
├── MIGRATION_NOTES.md              — past schema/RLS migrations log
├── SESSION_2026-02-24.md           — early field-notes from first user test
└── src/
    ├── main/
    │   ├── index.ts                — Electron lifecycle, BrowserWindow, Tray, globalShortcut, all ipcMain handlers, boot decision (wizard vs capsule)
    │   ├── preload.ts              — contextBridge: exposes window.meetelFlow and window.meetelFirstRun to both renderer windows
    │   ├── types.ts                — FlowConfig, DictationResult, ViewMode, PanelSide
    │   ├── config.ts               — load/save ~/.meetel-flow/config.json; loads Groq key from env or ~/.meetel-flow/.env
    │   ├── stt.ts                  — Groq Whisper HTTPS client, whisper.cpp local fallback, hallucination filter, regex cleanup, voice commands, LLM polish chain
    │   ├── filters.ts              — pure hallucination-detection + RMS + too-short predicates with per-language phrase dictionary
    │   ├── inserter.ts             — OS-level paste: clipboard + SendKeys (Win) / osascript keystroke (Mac) / clipboard-only (Linux)
    │   ├── telemetry.ts            — Supabase queue with on-disk mirror, exponential backoff, identifyUser select-then-update, session_end bookkeeping
    │   ├── events.ts               — TelemetryEvent discriminated union (10 event types with strict payload shapes)
    │   ├── sync.ts                 — fire-and-forget meetel_transcripts insert after successful dictation
    │   ├── usage.ts                — monthly minutes cap (100 min free, auto-reset on new month), persisted at ~/.meetel-flow/usage.json
    │   ├── updater.ts              — electron-updater bootstrap, DNS-failure silencer for dev builds
    │   └── ambiverse.ts            — Supabase Realtime broadcast channel for live bilingual translation, Groq Llama-powered translate()
    ├── renderer/
    │   ├── index.html              — main capsule markup (mic button, status, settings, transcripts, mode selector, upgrade overlay, ambiverse panel)
    │   ├── styles.css              — capsule CSS (glass morphism, idle fade, three view modes)
    │   ├── renderer.ts             — main capsule logic: hot-mic ring buffer, WAV encoder, view-mode switcher, transcripts list, mic test, ambiverse UI
    │   ├── firstrun.html           — 6-screen wizard markup
    │   ├── firstrun.css            — wizard styling (screens, progress dots, keyboard visual)
    │   └── firstrun.ts             — wizard state machine, createUser submission, mic probe, hotkey teach, in-wizard dictation demo
    └── shared/                     — currently empty (reserved)
```

---

## Dictation pipeline (the hot path)

What happens between `Ctrl+Space` down and text appearing in the user's target
app, in order. Every step names the file that owns it.

### 1. Hotkey detection

**Main process** (`src/main/index.ts`):

```ts
const HOTKEY = "Control+Space";   // LITERAL, not CommandOrControl — see gotchas
globalShortcut.register(HOTKEY, hotkeyToggle);
// hotkeyToggle() → mainWindow.webContents.send("hotkey:toggle")
//                → firstRunWindow.webContents.send("firstrun:hotkeyFired")
```

Electron's `globalShortcut.register()` uses `RegisterHotKey` on Windows and
`CGEventTap` on macOS. The OS intercepts the chord **before** any window's
keydown listener sees it. That's normally what we want — the user can be in
Notion, VS Code, a browser, anything — but it breaks first-run teach mode,
which is why the wizard does an arm/disarm dance (see below).

Renderer (`renderer.ts::boot`) subscribes via
`window.meetelFlow.onHotkeyToggle(() => toggle())`. The IPC event's only
payload is a telemetry `hotkey_fired` track on the main side.

### 2. Audio capture — hot-mic ring buffer with pre/post-roll

**Renderer** (`src/renderer/renderer.ts::armMicrophone` → `startRecording` →
`stopAndTranscribe`):

The mic is opened **once** at app start via `getUserMedia`, attached to an
`AudioContext` + `ScriptProcessorNode`, and kept hot for the lifetime of the
app. Every incoming frame writes into a 30-second circular `Float32Array`
ring buffer (`RING_BUFFER_SECONDS = 30`, roughly 960 KB at 16 kHz mono). A
monotonic sample counter (`ringBufferTotal`) never resets, so the slicer can
map absolute sample positions to ring indices regardless of wrap-around.

On hotkey:

```
captureStartSample = ringBufferTotal - preRoll   // 250ms BEFORE user pressed start
// ...user speaks...
// on stop:
await sleep(POST_ROLL_MS);                        // wait for 350ms trailing audio
captureStopSample = ringBufferTotal;
allSamples = readRing(captureStartSample, stopSample - startSample);
```

Why pre-roll: users start speaking slightly before they hit the key. The old
code called `getUserMedia` + `new AudioContext()` + waited for the first
buffer on every press, costing 300–600ms — which was *the reason the first
word was often missing*. Now the first dictation is sub-millisecond cold
start and every subsequent one is identical.

Why post-roll: users release the key while still finishing the last syllable.
~350ms of trailing audio catches it.

### 3. WAV encode + silence padding

Still in `renderer.ts::stopAndTranscribe`:

1. **Peak normalise** to -1 dB headroom (`normalizePcm`) — research in the
   commit history shows this reduces WER from 68% → 52% on quiet captures.
2. **Bookend with digital silence**: 200 ms pre-pad + 800 ms post-pad of
   zeros. Whisper's architecture treats trailing non-speech as the "stop"
   region and **eats the final word/syllable** if audio ends abruptly. This
   is a known quirk documented across `openai/whisper#29`, `#493`, `#1278`.
   The community fix is to pad with zeros. ~25 KB extra per dictation.
3. **Encode to 16-bit PCM WAV** using the *actual* sample rate captured from
   `audioCtx.sampleRate`, not the requested 16 kHz — Chromium on M-series
   Macs sometimes overrides the requested rate, and encoding at the wrong
   rate causes "chipmunk" playback and a broken transcription.
4. **Base64-encode** and ship via `window.meetelFlow.transcribe(...)`.

### 4. STT call — Groq Whisper primary, whisper.cpp fallback

**Main** (`src/main/stt.ts::transcribe`):

**Primary path — Groq API**:

- `POST https://api.groq.com/openai/v1/audio/transcriptions`
- Multipart form: `model=whisper-large-v3`, `response_format=verbose_json`,
  `timestamp_granularities[]=word,segment`, `temperature=0`
- Language is forced when the user selected `en` or `fr` (otherwise
  auto-detect)
- A language-specific **prompt** primes the transcription style:
  `"Meeting transcript. The team discussed..."` + a glossary of proper nouns
  (`Meetel, DASH, TypeScript, React, Supabase, Vercel`). This works because
  Whisper's `prompt` parameter conditions the decoder.
- 30-second timeout

**Fallback path — whisper.cpp local binary**:

- Located at `~/.meetel-flow/whisper/whisper-cli.exe` + `ggml-base.bin`
- Spawned via `execFile` with `["-m", model, "-f", wav, "-l", lang, "--no-timestamps", "-t", "4"]`
- **Gotcha**: do NOT pass `--print-special false`. It's a boolean flag that
  defaults to false; passing a value made `whisper-cli` treat `"false"` as a
  positional filename arg and broke the entire fallback path. Removed.
- Output post-processed: strip `[BLANK_AUDIO]` and any bracketed tokens.

On the Groq path, the result includes per-segment `avg_logprob`,
`no_speech_prob`, `compression_ratio` which drive the **hallucination
filter**.

### 5. Quality filter + hallucination removal + regex cleanup + voice commands

Still in `stt.ts`, chained in this order:

1. `filters.ts::filterTranscriptionResult` — gate on:
    - Empty text → reject
    - `durationMs < 300` → reject (button bounce)
    - RMS of raw PCM16 < 500 → reject ("too quiet")
    - Known hallucination phrase match (per-language dictionary with
      ~200 entries: "sous-titrage de la Société Radio-Canada", "thanks for
      watching", "ご視聴ありがとうございました", etc.)
2. `stt.ts::filterHallucinations(text, segments)` — uses Groq's per-segment
   quality metrics to drop segments with `no_speech_prob > 0.6`,
   `compression_ratio > 2.4` (repetitive = hallucinated), or
   `avg_logprob < -1.0` (low confidence). Also de-dupes repeated segments
   (Whisper looping).
3. `stt.ts::regexCleanup(text)` — removes YouTube-outro phrases (catch-all
   redundant with filters.ts), English + French filler words, collapses
   whitespace, capitalises sentence starts, capitalises standalone "I".
4. `stt.ts::processVoiceCommands(text)` — bilingual voice-to-punctuation
   mapping:
    - "new line" / "nouvelle ligne" → `\n`
    - "new paragraph" / "nouveau paragraphe" → `\n\n`
    - "period" / "point" → `.`  (French `point` excluded when followed by `de`/`d'`)
    - "comma" / "virgule", "question mark" / "point d'interrogation", etc.

### 6. LLM polish

**Main** (`stt.ts::llmPolish`):

```
llmPolish(text, groqKey, geminiKey, language):
    if groqKey:
        result = groqPolish(text)    // model=llama-3.3-70b-versatile
        if result: return result     // ← success
        // falls through on HTTP !== 200, 429 rate limit, timeout, empty
    if geminiKey:
        return geminiPolish(text)    // model=gemini-2.0-flash
    return text                      // no LLM → pass raw text through
```

Prompts are **language-specific** (`POLISH_PROMPT`) and explicitly say
*"The text IS in French — do NOT translate anything to English"* or vice
versa. Early versions had the model silently translating. The English
prompt lists filler words + hallucination phrases. The French prompt also
enumerates ~15 common French accents to fix (`etais→étais`, `meme→même`,
`deja→déjà`, etc.) because Groq Whisper large-v3 frequently drops them.

Temperature: 0.1, max_tokens: 2048, timeout: 10s.

### 7. Insert at cursor

**Main** (`src/main/inserter.ts::insertText`):

Per-platform branching:

- **Windows** (`typeOnWindows`): save existing clipboard, write new text,
  `powershell -NoProfile -ExecutionPolicy Bypass -Command "Add-Type -AssemblyName System.Windows.Forms; Start-Sleep -Milliseconds 80; [System.Windows.Forms.SendKeys]::SendWait('^v')"`,
  restore old clipboard after 500ms. **Why clipboard+paste instead of
  `SendKeys "text"`**: SendKeys strips Unicode — French accents (`é è ç à`),
  CJK, and emoji get mangled or dropped.
- **macOS** (`typeOnMac`): same pattern but with `osascript -e 'tell application "System Events" to keystroke "v" using command down'`.
  **Why not `keystroke "the text"`**: same Unicode-stripping problem. Also:
  this path does NOT require Accessibility permission — only Automation,
  which most apps grant on first use without a blocking dialog.
- **Linux**: clipboard-only (no reliable paste script, user pastes manually).
- **Clipboard mode** (`config.targetMode === "clipboard"`): skip the paste
  step entirely, just write to clipboard.

Failure on Mac leaves text on clipboard and throws
`"Paste blocked — text copied to clipboard. Press Cmd+V to insert."` — a
graceful failure, not a silent one.

### 8. Telemetry + transcript upload

Back in `src/main/index.ts::ipcMain.handle("stt:transcribe")`:

```ts
addUsage(result.durationSeconds);        // src/main/usage.ts — monthly cap
pushTranscript(result, cfg.userId);      // src/main/sync.ts  — meetel_transcripts
telemetry.track("dictation_success", {   // src/main/telemetry.ts
  duration_ms, word_count, provider, language
});
```

- **`pushTranscript`** is fire-and-forget: wrapped in an IIFE so the caller's
  signature stays `void`. Supabase insert errors are logged but never bubble.
  The trigger `trg_meetel_transcripts_first_dictation` stamps `first_dictation_at`
  on the user row on first insert (SECURITY DEFINER so anon can fire it).
- **`telemetry.track`** pushes into an in-memory queue + atomic-write mirror
  at `userData/telemetry-queue.json`. A 30-second interval flushes in batches
  of 100 to `meetel_events`. Failures trigger exponential backoff (1s, 2s,
  4s, ..., capped at 5 min). On `before-quit`, `shutdown()` fires a
  `session_end` event and forces one last flush bypassing the backoff window.

---

## First-run wizard

`src/renderer/firstrun.ts` is a 6-screen state machine rendered in its own
BrowserWindow. The window is frameless, transparent, shown only after
`ready-to-show`. Progress dots along the top reflect `state.current`.

### Screens

1. **Welcome** — marketing hello, one button → screen 2.
2. **Identity** — name + email form. Validates email with a simple regex,
   then calls `window.meetelFirstRun.createUser({name, email})` which hits
   `firstrun:createUser` → `telemetry.identifyUser()` in main. On success
   stores the `userId` in `state` and in `~/.meetel-flow/config.json`.
3. **Microphone permission** — `window.meetelFirstRun.requestMicPermission()`.
   On macOS this calls `systemPreferences.askForMediaAccess("microphone")`
   directly from main (the only platform where we can programmatically
   trigger the OS prompt). On Windows/Linux the permission is granted on
   first `getUserMedia` in the renderer, so main returns an optimistic
   `{granted: true}` and the wizard does its own probe via `getUserMedia`.
4. **Hotkey teach** — user is asked to press `Ctrl+Space`. A visual
   keyboard shows the two keys light up as they're pressed.
5. **First dictation** — user records their first sentence into a
   textarea inside the wizard. The wizard runs its *own* `getUserMedia` +
   ScriptProcessor capture (it doesn't share `renderer.ts`'s ring buffer),
   calls `meetelFlow.transcribe()` via IPC, and renders the polished text
   in-place.
6. **Finish** — confirmation, one button → `markComplete()` → main closes
   the wizard window, opens the main capsule window, and re-registers the
   hotkey.

### The arm/disarm gotcha (load-bearing — read before touching screens 4–5)

Electron's `globalShortcut.register("Control+Space", ...)` installs an
OS-level hook (`RegisterHotKey` on Windows, `CGEventTap` on Mac) that eats
the chord **before** it reaches any window's keydown listener. During
onboarding, the in-window keydown listener only ever sees `Ctrl` alone —
`Space` chorded with `Ctrl` never arrives.

**The dance** (`firstrun.ts::armHotkeyListener`, `armFirstDictation`):

```ts
// Entering screen 4 or 5:
void window.meetelFirstRun.armHotkeyTeach();
// → main calls globalShortcut.unregister("Control+Space")
// Now window.addEventListener("keydown", ...) sees the full chord.

// Leaving the screen:
void window.meetelFirstRun.disarmHotkeyTeach();
// → main re-registers the global shortcut.
```

There's also a **backup path**: in case the wizard window is not focused
when the user presses the chord, main forwards the IPC event via
`firstrun:hotkeyFired` (the global hotkey, if still registered, still works
on main). Both paths call the same `confirmHotkey()` handler behind an
idempotency check.

Additionally, safety valves:
- Screen 4: after 8s, a manual "I pressed it" button appears so the user is
  never stuck if hotkey detection fails.
- Screen 5: after 20s, a "Skip for now" link appears which calls
  `skipFirstDictation()` and jumps to screen 6.

Why `"Control+Space"` literally and not `"CommandOrControl+Space"`:
- On macOS, `CommandOrControl+Space` maps to **Cmd+Space** = Spotlight.
  That's unwinnable — Spotlight steals the chord at the OS level.
- Using literal `"Control"` gives identical muscle memory across
  Windows + Mac, no Spotlight conflict, and still works for both users.

---

## Telemetry & cloud schema

### Supabase project

- **Project ref**: `mclbbkmpovnvcfmwsoqt`
- **URL**: `https://mclbbkmpovnvcfmwsoqt.supabase.co`
- **Publishable (anon) key**: hardcoded in `src/main/index.ts` and
  `src/main/sync.ts`. Safe to embed in client — RLS enforces per-row
  access. The service-role key NEVER ships with the app.
- **Schema source of truth**: `supabase/meetel-schema.sql` (idempotent, safe
  to re-run).

### Tables

| Table | Purpose | Writer | Reader |
|---|---|---|---|
| `meetel_users` | One row per user. `id`, `email` (UNIQUE), `device_id` (UNIQUE), `platform`, `app_version`, `created_at`, `last_active_at`, `first_dictation_at`, `total_dictations`, `total_words`, `plan`, `status` | anon INSERT (wizard), service_role UPDATE | authenticated SELECT, service_role ALL |
| `meetel_events` | Append-only event log. `user_id`, `event` (text discriminator), `payload` (jsonb), `created_at`, `platform`, `app_version` | anon INSERT (desktop queue flush), service_role INSERT | authenticated SELECT, service_role SELECT |
| `meetel_transcripts` | Cloud history of dictated text per user | anon INSERT (desktop app after success), service_role ALL | authenticated SELECT |
| `meetel_user_metrics` (view) | Aggregates dictation count, words, success rate, dominant provider/language, 7-day rolling count | — | authenticated, service_role |

### RLS model

Anon can **INSERT** into all three tables but **cannot SELECT**. Authenticated
(admin cockpit) can read everything. Service role bypasses RLS.

### Gotcha — `Prefer: return=representation` triggers SELECT permission check

Supabase-js's default `.insert(row)` uses `Prefer: return=minimal` which only
needs INSERT permission. But **any** insert with
`Prefer: return=representation` (curl with that header, OR chained
`.insert(row).select()`) makes PostgREST evaluate the SELECT policy too,
which fails for anon with `42501 new row violates row-level security policy`.
The error message is misleading — the INSERT actually succeeded, the
SELECT-back is what got blocked.

**Rule**: from the desktop app, NEVER chain `.select()` after `.insert()`
for `meetel_events` / `meetel_transcripts`. If you need the inserted id
client-side, generate it with `crypto.randomUUID()`. The Hub admin cockpit
reads via the `authenticated` role and is unaffected.

### Gotcha — `identifyUser` is select-then-update, not upsert

Both `email` and `device_id` are `UNIQUE` in `meetel_users`. A plain
`.upsert(row, { onConflict: "email" })` resolves email conflicts but still
violates the `device_id` UNIQUE when the same device re-onboards with a
different email. Dash hit this on his own machine.

`telemetry.ts::identifyUser` does:

```ts
SELECT id, email, name, device_id
  FROM meetel_users
 WHERE device_id = $1 OR email = $2
 LIMIT 1;

if (existing) {
  UPDATE meetel_users SET ... WHERE id = existing.id RETURNING ...;
} else {
  INSERT INTO meetel_users (...) VALUES (...) RETURNING ...;
}
```

Do not "simplify" this back to a plain upsert. If you change the schema's
unique constraints, this function has to change in lockstep. Errors throw
`IdentifyUserError` with the actual Postgres message + code — the wizard
displays the real message instead of a generic "Could not create user".

### The `first_dictation_at` trigger

```sql
CREATE FUNCTION meetel_stamp_first_dictation() RETURNS TRIGGER
  LANGUAGE plpgsql SECURITY DEFINER
AS $$
BEGIN
  UPDATE meetel_users
     SET first_dictation_at = now()
   WHERE id = NEW.user_id AND first_dictation_at IS NULL;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_meetel_transcripts_first_dictation
AFTER INSERT ON meetel_transcripts FOR EACH ROW
EXECUTE FUNCTION meetel_stamp_first_dictation();
```

`SECURITY DEFINER` lets anon clients trigger an update on `meetel_users` they
otherwise can't touch. The `IS NULL` guard makes it a one-shot stamp.

### Admin cockpit

The Hub cockpit reads all of the above via the authenticated role:

- **Path**: `/home/dash/Hub/src/cockpit/meetel-admin/`
- **Entry**: lazy-loaded from `StreamMode.tsx`, registered in
  `admin/appRegistry.ts` as `MEETEL_ADMIN`
- Uses the `meetel_user_metrics` view for the dashboard, joins against
  `meetel_events` for the event timeline, paginates `meetel_transcripts`
  for the content browser.

---

## Build, ship, hot-patch

### npm scripts (`package.json`)

| Script | Does |
|---|---|
| `build` | `build:main` → `build:renderer` → `copy:assets` |
| `build:main` | `tsc -p tsconfig.main.json` (CommonJS, Node lib) |
| `build:renderer` | `tsc -p tsconfig.renderer.json` (DOM lib) |
| `copy:assets` | `cp src/renderer/{index,firstrun}.{html,css} dist/renderer/` |
| `start` / `dev` | `npm run build && electron .` |
| `dist:win` | `npm run build && electron-builder --win nsis` |
| `dist:mac` | `npm run build && electron-builder --mac dmg` |
| `dist:linux` | `npm run build && electron-builder --linux AppImage` |

### electron-builder configuration

Lives inline in `package.json#build`:

- `appId: com.meetel.flow`
- `productName: Meetel Flow`
- `files: ["dist/**/*", "package.json"]` — everything else is excluded
- **Windows**: NSIS, `oneClick: false`, `allowToChangeInstallationDirectory: true`
- **macOS**: DMG x64 + arm64, also a `.zip` of each arch, hardened runtime
  enabled, `gatekeeperAssess: false`, **NOT notarized** (no Apple Developer
  ID yet). `entitlements.mac.plist` covers mic + AppleEvents + Accessibility.
  `Info.plist` declares `LSUIElement: true` (no dock icon), `NSMicrophoneUsageDescription`,
  `NSAppleEventsUsageDescription`, `NSAccessibilityUsageDescription`.
- **DMG**: custom layout with /Applications shortcut; `sign: false`.
- **publish**: GitHub, owner `dashguinee`, repo `meetel-flow`,
  `releaseType: draft` — the CI pushes a **draft** release, not a public one.

### GitHub Actions — `.github/workflows/release.yml`

```yaml
on:
  push:
    tags: ["v*"]
  workflow_dispatch: {}

jobs:
  build-windows:
    runs-on: windows-latest
    steps:
      - actions/checkout@v4
      - actions/setup-node@v4 (node 20, npm cache)
      - npm ci
      - npm run build
      - npx electron-builder --win nsis --publish always
        env: GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

Single-platform: Windows only in CI. Mac + Linux builds are done locally on
demand. No cross-compile — Windows because that's where 95% of our target
users live.

### Release flow

1. Bump `package.json` `"version"` → commit (don't push yet).
2. `git tag vX.Y.Z` (lightweight tag fine, no `-m`).
3. `git push origin master && git push origin vX.Y.Z`.
4. Actions builds on `windows-latest`, uploads a **draft** release.
5. Test the draft installer locally (drafts are visible only via authenticated API).
6. Flip `draft: false` via `gh` CLI or the GitHub UI:
   ```bash
   curl -sS -X PATCH -H "Authorization: Bearer $GH_PAT" \
     "https://api.github.com/repos/dashguinee/meetel-flow/releases/<id>" \
     -d '{"draft":false,"name":"Meetel Flow vX.Y.Z","body":"..."}'
   ```
7. Auto-updater (`electron-updater` via `updater.ts`) picks up the new
   `latest.yml` from the newest non-draft release on next app launch.

PAT lives in `~/.config/gh/hosts.yml` (`oauth_token` field). Currently
broad-scope — rotating to fine-grained is on the TODO list.

### Hot-patch workflow (30s iteration instead of 10min rebuild)

The installed app at
`C:\Users\User\AppData\Local\Programs\Meetel Flow\resources\app.asar` can be
patched in-place without rebuilding the installer. Only useful on Dash's own
machine — for users you must cut a real release.

```bash
# 1. Build source
cd /home/dash/meetel-flow && npm run build

# 2. Kill running app
powershell.exe -NoProfile -Command "Stop-Process -Name 'Meetel Flow' -Force -ErrorAction SilentlyContinue"

# 3. Extract the installed asar
cd /tmp && rm -rf meetel-asar-new
npx --yes asar extract "/mnt/c/Users/User/AppData/Local/Programs/Meetel Flow/resources/app.asar" meetel-asar-new

# 4. Copy only the changed dist files
cp /home/dash/meetel-flow/dist/main/<file>.js /tmp/meetel-asar-new/dist/main/<file>.js

# 5. Repack into installed location
npx --yes asar pack /tmp/meetel-asar-new "/mnt/c/Users/User/AppData/Local/Programs/Meetel Flow/resources/app.asar"

# 6. Relaunch
powershell.exe -NoProfile -Command "Start-Process 'C:\Users\User\AppData\Local\Programs\Meetel Flow\Meetel Flow.exe'"
```

### Clean-uninstall / fresh first-run recipe

For testing the wizard from scratch on Dash's machine:

```bash
# Stop processes
powershell.exe -NoProfile -Command "Stop-Process -Name 'Meetel Flow' -Force -EA 0"

# NSIS silent uninstall
powershell.exe -NoProfile -Command "& 'C:\Users\User\AppData\Local\Programs\Meetel Flow\Uninstall Meetel Flow.exe' /S"

# Wipe Electron userData (telemetry queue, device id)
rm -rf "/mnt/c/Users/User/AppData/Roaming/meetel-flow"

# Wipe app data BUT preserve .env (Groq key) and whisper/ (large model)
rm "/mnt/c/Users/User/.meetel-flow/{config.json,debug.log,stt.log,transcripts.json,usage.json}"
```

Deleting `whisper/` triggers a multi-hundred-MB redownload. Deleting `.env`
breaks Groq STT until the user re-pastes their key. Both persist across
reinstalls by design. The Supabase user row stays — `identifyUser` finds it
by device_id/email on next onboarding.

---

## Known gotchas

Every one of these was hit during development. None are obvious from just
reading the code.

1. **Whisper truncates the last word unless you pad with silence** — Whisper's
   decoder treats trailing non-speech as the stop region. Fix:
   `PAD_START_MS=200`, `PAD_END_MS=800` of zeros bookending the capture.
   See `renderer.ts::stopAndTranscribe` and `firstrun.ts::stopAndTranscribeWizard`.
   Upstream: `openai/whisper#29`, `#493`, `#1278`.

2. **Cold start stole 300–600ms of audio → missing first word** — old code
   `await getUserMedia()` on every hotkey press. Fixed by hot-mic ring buffer
   (`armMicrophone` runs once at boot, stays hot). `PRE_ROLL_MS=250` means we
   capture audio from **before** the user pressed the key, so even if they
   started speaking early it's in the slice.

3. **`globalShortcut` eats the chord before keydown** — first-run wizard can't
   detect `Ctrl+Space` with a normal `keydown` listener because the OS hook
   intercepts it. Fix: arm/disarm dance (`firstrun:armHotkeyTeach` /
   `disarmHotkeyTeach` IPC) unregisters the global shortcut while the teach
   screen is active, then re-registers on exit. Cost me hours chasing "ctrl
   is detected but space no" before this clicked.

4. **Postgres `UNIQUE` on `device_id` breaks `.upsert()`** — both `email` and
   `device_id` are unique, so `onConflict: "email"` still violates the other
   constraint when a device re-onboards with a fresh email. Fix:
   `identifyUser` does select-then-update/insert. See `telemetry.ts`.

5. **Supabase anon SELECT RLS fires when you chain `.insert().select()`** —
   even though anon only needs INSERT. The SELECT-back triggers a policy
   check anon can't pass. Rule: **never** chain `.select()` after `.insert()`
   on `meetel_events` / `meetel_transcripts` from the desktop app. Error
   message `42501 new row violates row-level security policy` is misleading
   — the INSERT actually worked.

6. **Sample-rate mismatch on M-series Macs → chipmunk effect** — Chromium
   on Apple Silicon sometimes overrides the requested `sampleRate: 16000`
   on the AudioContext. Fix: capture `audioCtx.sampleRate` into
   `actualSampleRate` and use it as the ring buffer size AND the WAV header
   sample rate. See `renderer.ts::armMicrophone`.

7. **`whisper-cli` `--print-special false` flag is broken** — it's a
   boolean flag that defaults to false; passing `"false"` as a value made
   whisper-cli treat it as a positional filename arg and broke the whole
   fallback path. Flag removed. See comment in `stt.ts::transcribeLocal`.

8. **Auto-updater DNS spam on dev builds** — `electron-updater` hits the
   configured update endpoint on boot; if the DNS doesn't resolve (dev
   builds, offline), it logs ERR_NAME_NOT_RESOLVED every time. Fix:
   `updater.ts::isUpdaterEndpointMissing` silences those specific errors
   so real errors still surface.

9. **Groq upload cap = 25 MB ≈ 13 min of PCM16 mono** — any longer and Groq
   returns 413 with no recovery path. Hard-capped at `12 * 60` seconds in
   `renderer.ts::stopAndTranscribe` so the user sees a clean "Too long (max
   12 min)" error instead.

10. **Windows SendKeys strips Unicode** — `[System.Windows.Forms.SendKeys]::SendWait("é è ç à")`
    mangles or drops the accented characters. Same on macOS
    `keystroke "text"`. Fix: clipboard-then-paste (`Ctrl+V`/`Cmd+V`) on
    both platforms — preserves all Unicode, all emoji, all CJK. See
    `inserter.ts`.

11. **Telemetry errors were silently swallowed** — earlier `identifyUser`
    returned `null` on any failure and the wizard showed a generic
    "Could not create user" with zero diagnostic info. Hour of debugging.
    Now it throws `IdentifyUserError` with the actual Postgres message +
    code; main logs every step to `~/.meetel-flow/debug.log` via the
    `console.log` override at the top of `index.ts`.

12. **The `console.log` override must be the first statement in `index.ts`** —
    well, first after the imports. If any import logs before it installs, you
    lose those lines. Keep the redirect at the top of the file.

---

## Roadmap notes

### Current state — v0.2.3

- Wizard working end-to-end, shipped 2026-04-10
- Groq Whisper + Llama polish pipeline stable
- Hot-mic ring buffer with pre/post-roll
- Hallucination filter with 7-language phrase dictionary
- 3 view modes (panel / compact / island)
- Bilingual live translation via Supabase Realtime (Ambiverse)
- Telemetry + transcript sync + monthly usage cap
- Hub admin cockpit reading `meetel_user_metrics`

### v0.3.0 candidates

- **Multi-layer AI** — real-time polish with backtrack correction
  (Whisper can revise tokens after more context arrives), "command mode"
  for issuing app control by voice (`"open Safari"`, `"new tab"`),
  app-aware tone (casual in Slack, formal in Gmail).
- **STT provider migration** — `gpt-4o-mini-transcribe` (cheaper + better
  WER) or Deepgram Nova-3 (streaming + word-level confidence + real
  hallucination filter). Groq stays as the fast tier.
- **Code signing**:
  - Windows: OV cert (~$400/yr) to drop SmartScreen warning.
  - macOS: Apple Developer ID ($99/yr) + notarization to drop Gatekeeper
    warning.
- **Mac DMG icon** — currently `build-resources/icon.icns` is missing, so
  the tray uses `nativeImage.createEmpty()` + a `tray.setTitle("Meetel")`
  text fallback on Darwin.
- **Better whisper.cpp model** — currently `ggml-base.bin` (~140 MB). A
  `ggml-small.en` or `ggml-medium` would improve fallback quality at the
  cost of more disk and slower local transcription.
- **Clean up legacy releases** — old `v0.1.0` GitHub release should be
  marked pre-release or deleted.
- **Rotate GitHub PAT** — currently broad-scope, move to fine-grained
  `repo:dashguinee/meetel-flow` only.
- **Real testimonials on landing pages** — get from first 3 real users.

---

## File-by-file reference

### `src/main/index.ts` (471 lines)

**Description**: Electron app entrypoint. Creates BrowserWindows (main
capsule OR first-run wizard, mutually exclusive on boot), registers all
`ipcMain.handle` channels, manages the global hotkey registration, wires
up the tray, bootstraps telemetry, wires the auto-updater. Also installs
the `console.log`/`console.error` → `~/.meetel-flow/debug.log` redirect
at the top of the file.

**Key exports**: none (side-effect entrypoint).

**Gotchas before editing**:
- The `console.log` override must stay at the very top. Moving it below
  other imports means those imports' logs never reach `debug.log`.
- `HOTKEY` must be literal `"Control+Space"`, NOT `"CommandOrControl+Space"`.
  See gotcha 3.
- `firstRunDictationFired` is a one-shot flag that drives the wizard's
  advance-on-success event. Don't reset it.
- The boot decision is `if (!initialCfg.firstRunComplete) { wizard } else { capsule }`.
  Tray and hotkey register in BOTH branches so the wizard can teach the
  hotkey on screen 4.
- `ipcMain.handle("telemetry:track")` uses an allowlist — adding new events
  requires updating the `allowed` Set.
- `firstrun:markComplete` atomically closes the wizard and opens the
  capsule. The order is: saveConfig → create capsule window → re-register
  hotkey → close old wizard. Don't flip that order.

### `src/main/preload.ts` (74 lines)

**Description**: `contextBridge.exposeInMainWorld` for both renderer
windows. Exposes `window.meetelFlow` (main capsule API) and
`window.meetelFirstRun` (wizard API) as separate namespaces so they can't
collide. Same preload file is loaded into both windows — both globals
exist in both windows, wizard uses `meetelFlow.transcribe` for the
in-wizard dictation demo.

**Key exports**: none (contextBridge is a side effect).

**Gotchas**: any new IPC channel must be added here AND in the main
process handler. The renderer cannot invoke channels that don't exist on
the preload. Types are enforced in the renderer side (`renderer.ts` has
a `MeetelApi` type, `firstrun.ts` has `MeetelFirstRunAPI`) — keep them in
sync manually.

### `src/main/stt.ts` (584 lines)

**Description**: The STT engine. Implements the Groq Whisper HTTPS client
(raw multipart body assembly via `Buffer.concat`, no `form-data`
dependency), the whisper.cpp local fallback (`execFile`), the
hallucination filter with per-segment quality metrics, the regex cleanup,
the bilingual voice-command mapping, and the LLM polish chain (Groq Llama
3.3 70B → Gemini 2.0 Flash → raw text). Also maintains `lastTranscript`
session memory for prompt continuity.

**Key exports**: `transcribe(config, audioBase64, mimeType, durationSeconds, wavBase64)`

**Gotchas**:
- The Groq multipart body is assembled by hand. Order matters: fields must
  come BEFORE the file for Groq's parser. Adding a new field? Append it
  before the closing boundary.
- The `prompt` parameter is load-bearing. Removing it drops transcription
  quality on proper nouns (`DASH`, `TypeScript`) and punctuation style.
  Don't strip it.
- `temperature: 0` is correct. Whisper auto-adjusts on unclear audio when
  temp is 0; higher values make it hallucinate more.
- `groqPolish()` returns `""` on rate limit / timeout / empty — `llmPolish()`
  falls through to Gemini on empty string. Do NOT throw on Groq polish
  failure; fallback is the whole point.
- `filterHallucinations` runs BEFORE `regexCleanup` because it relies on
  the raw segments from the Groq response. Don't reorder.
- `fixFrench()` exists but is currently unused in the main path — LLM
  polish handles accents better. Kept for future offline-only mode.
- Writes to `~/.meetel-flow/stt.log` bypass the main-process console
  redirect — this is intentional so the STT path has its own log channel
  for debugging without scrolling through event noise.

### `src/main/filters.ts` (487 lines)

**Description**: Pure side-effect-free predicates for rejecting bad
transcriptions before they hit the cursor. Per-language hallucination
phrase dictionary (7 languages, ~200 entries), PCM16 RMS amplitude
calculation with automatic WAV header skipping, duration floor check, and
an orchestrator that runs all checks in cost order.

**Key exports**:
- `filterTranscriptionResult({text, language?, durationMs, audioBuffer?})`
- `isKnownHallucination(text, language?)`
- `isAudioTooQuiet(buffer, threshold=500)`
- `isAudioTooShort(durationMs, minMs=300)`
- `computeRmsPcm16(buffer)`
- `normaliseForMatch(text)`
- `HALLUCINATION_PHRASES` (exported for tests)

**Gotchas**:
- The hallucination dictionary has inline comments for every entry
  explaining its origin (CBC subtitles, Amara volunteer credits, ZDF,
  etc.). Keep those — they document WHY the phrase is there so nobody
  removes it thinking it's paranoid.
- `computeRmsPcm16` auto-detects WAV headers by scanning for the `"data"`
  chunk marker. Passing a non-PCM16 buffer (e.g. WebM) silently returns
  garbage. The docstring says PCM16 LE only.
- RMS threshold of 500 is conservative. Real speech at 6 inches reads
  1500+. Loud use cases can drop to 300, whisper-to-mic use cases should
  raise to 800.
- Substring containment only triggers when
  `transcription.length <= phrase.length * 2` to avoid rejecting real
  speech that happens to quote "thanks for watching" as a fragment.
  Don't remove that guard.

### `src/main/inserter.ts` (70 lines)

**Description**: OS-level cursor insertion. Clipboard-save + clipboard-set
+ paste-script + clipboard-restore on Windows (PowerShell SendKeys `^v`)
and macOS (osascript `keystroke "v" using command down`). Clipboard-only
on Linux.

**Key exports**: `insertText(text, mode: "type" | "clipboard")`

**Gotchas**:
- Do NOT use `SendKeys::SendWait(text)` directly — it strips Unicode.
  Same for macOS `keystroke "text"`. Clipboard+paste is the only Unicode-safe
  path. Documented in comments.
- The 500ms `setTimeout` to restore previous clipboard is long enough
  that the paste completes first. Dropping it below ~200ms causes
  clipboard to restore before the target app reads it.
- macOS path does NOT require Accessibility permission, only Automation.
  Keep it that way — Accessibility requires a system-dialog click from
  the user and many don't grant it.
- On macOS, if Automation is blocked, the function throws with a
  user-actionable message ("text left on clipboard, press Cmd+V") rather
  than failing silently.

### `src/main/telemetry.ts` (515 lines)

**Description**: Main-process singleton telemetry emitter. Initialises a
Supabase client, derives a stable `device_id` (OS machine-id on Linux,
persisted UUIDv4 elsewhere), maintains an in-memory event queue with an
atomic-write disk mirror at `userData/telemetry-queue.json`, flushes on a
30-second timer + on explicit `flush()` + on `shutdown()`, implements
exponential backoff on failure (1s → 5min cap), caps runaway queues at
10K events (drops oldest). Implements `identifyUser` as select-then-update.

**Key exports**:
- `init(config)`, `track(event, payload)`, `identifyUser(email, name)`,
  `flush()`, `shutdown()`, `IdentifyUserError`, `__internal` (for tests)

**Gotchas**:
- `init()` MUST be called after `app.whenReady()` — it reads
  `app.getPath('userData')` to place the queue file.
- `identifyUser` is NOT a plain upsert. See gotcha 4. Do not simplify.
- Every `identifyUser` step logs to console (which main redirects to
  `debug.log`). Don't add try/catch that swallows errors back to null —
  the error messages are the debugging path.
- `shutdown()` bypasses the backoff window to force one last flush on
  `before-quit`. Main's `before-quit` handler calls this then
  `app.exit(0)` — DO NOT remove the `e.preventDefault()` in main, it
  gives the flush time to complete.
- `flush()` uses `.insert(rows)` WITHOUT `.select()`. Changing that to
  `.insert(rows).select()` will break anon writes (see gotcha 5).
- The on-disk mirror uses atomic write (tmp file + rename) so a crash
  mid-write can never corrupt the queue.
- `MAX_QUEUE_SIZE = 10_000` — when exceeded, OLDEST events are dropped.
  Freshest diagnostics win.

### `src/main/events.ts` (109 lines)

**Description**: TelemetryEvent discriminated union + helper types.
Defines 10 event types with strict payload shapes (AppStart,
FirstRunStart/Complete, MicPermissionResult, HotkeyFired,
DictationSuccess/Failure, SettingsChanged, Error, SessionEnd) and the
`QueuedTelemetryEvent` wrapper used for persistence.

**Key exports**: `TelemetryEvent`, `TelemetryEventName`, `PayloadFor<N>`,
`QueuedTelemetryEvent`, all individual payload interfaces.

**Gotchas**:
- No `any` types anywhere — that's intentional. Adding a new event
  requires adding both the payload interface and a branch of the
  discriminated union. `track<N>` is typed so the wrong payload for a
  given event name is a compile error.
- `DictationSuccessPayload.provider` is a `TelemetryProvider` union
  that includes `"gemini"` — polishing via Gemini counts as a provider
  for telemetry purposes even though STT was Groq.

### `src/main/sync.ts` (67 lines)

**Description**: Fire-and-forget `meetel_transcripts` insert after every
successful dictation. Wrapped in an async IIFE so the public signature
stays `void`. Reads `APP_VERSION` from `package.json` at module load.

**Key exports**: `pushTranscript(result, userId?)`

**Gotchas**:
- If `userId` is undefined (user hasn't onboarded) the function is a no-op.
  Local-only mode is a first-class state.
- Uses `.insert()` WITHOUT `.select()` — same gotcha 5.
- The trigger `trg_meetel_transcripts_first_dictation` fires on the insert
  to stamp `first_dictation_at` on the user row. If you remove the trigger,
  the admin cockpit's "time-to-first-dictation" metric stops working.

### `src/main/config.ts` (61 lines)

**Description**: `~/.meetel-flow/config.json` load/save + API-key loading.
Reads Groq + Gemini keys from three sources in priority order:
`process.env.MEETEL_GROQ_KEY`, then `~/.meetel-flow/.env` (parsed with
plain regex), then empty. `loadConfig()` returns a merged object
`defaults ⊕ disk ⊕ baked-keys` so the user can override the language/mode
in the JSON file but the keys always come from env.

**Key exports**: `loadConfig()`, `saveConfig(partial)`

**Gotchas**:
- `saveConfig` reads+merges+writes — not atomic. Two simultaneous saves
  race. In practice only main writes, so it's fine.
- `.env` parsing is a quick regex, not a real dotenv parser. No support
  for quoted values, line continuations, or comments. Keep it that way
  unless there's a reason to pull in `dotenv`.
- The baked Groq key overrides the disk-config Groq key. This is
  intentional: if the env file is updated the user doesn't have to clear
  their config.json to pick up the new key.

### `src/main/usage.ts` (65 lines)

**Description**: Monthly free-tier minutes cap. 100 minutes/month default,
auto-reset on new month (compares `YYYY-MM`), persisted at
`~/.meetel-flow/usage.json`. Tracked to 0.01 min precision.

**Key exports**: `getUsage()`, `addUsage(seconds)`, `hasMinutesRemaining()`,
`getRemainingMinutes()`

**Gotchas**:
- `addUsage` is called with `result.durationSeconds` from `stt.ts`, which
  is the client-reported capture duration, NOT the Groq processing time.
  A 1-second sentence counts 1 second against the cap.
- Month comparison is string-based (`YYYY-MM`) which means timezone
  matters. Using `new Date().getMonth()` → local time. Users travelling
  across timezones might lose or gain minutes at month boundaries. Not
  worth fixing until it bites someone.

### `src/main/updater.ts` (42 lines)

**Description**: `electron-updater` bootstrap. Checks for updates on boot
(packaged builds only), downloads in background, installs on quit.
Silences `ERR_NAME_NOT_RESOLVED` / `ENOTFOUND` errors so dev builds don't
spam logs.

**Key exports**: `setupAutoUpdates()`

**Gotchas**:
- Skipped when `!app.isPackaged` — `npm run dev` never checks updates.
- `MEETEL_DISABLE_UPDATES=1` env var fully disables (for builds without
  a live update feed).
- The DNS-error silencer is per-error-message substring matching. If you
  change it, make sure `"getaddrinfo"` still catches the common case.
- Reads `latest.yml` from the `github` publish config in `package.json` —
  tied to release flow, not `updates.meetel.com` (which doesn't exist yet).

### `src/main/ambiverse.ts` (137 lines)

**Description**: Supabase Realtime broadcast-channel layer for live
bilingual translation. Creates 4-digit room codes, joins rooms, receives
transcripts from peers, translates them through Groq Llama, and fires
a callback to the renderer. Uses the OLD-format JWT anon key (distinct
from the new `sb_publishable_*` key used elsewhere) because the
Realtime channel auth was configured with it first. TODO: unify.

**Key exports**: `createRoom`, `joinRoom`, `leaveRoom`, `sendTranscript`,
`isConnected`, `getRoom`, `translate`

**Gotchas**:
- `channel.send({type: "broadcast", event: "transcript", payload})` is
  fire-and-forget. Broadcast is best-effort, not guaranteed delivery.
- The language-name map hardcodes 20 ISO codes to full names. Adding a
  new language means adding to `langNames` AND making sure Groq Whisper
  can actually detect it (it handles 100 natively).
- `joinRoom` auto-leaves any existing room before joining a new one.
- Room codes are 4 digits → 9000 possible rooms. Collision is unlikely in
  practice but not impossible. No collision handling.
- The anon key here (`eyJ...`) is NOT the same as the
  `sb_publishable_9L0m_...` key in `sync.ts`/`index.ts`. Both are anon.
  The JWT-format key works with Realtime; the publishable key works with
  PostgREST. Historical artifact from before Supabase unified their key
  story. Safe to leave, cleanup is low priority.

### `src/main/types.ts` (31 lines)

**Description**: Shared type aliases used across main and renderer.
`FlowConfig`, `DictationResult`, `DictationState`, `ViewMode`, `PanelSide`.

**Key exports**: the types above.

**Gotchas**: `FlowConfig` is the canonical config shape. Adding a field
requires: (1) default in `config.ts`, (2) wizard write path (if it's an
onboarding value), (3) renderer read path, (4) telemetry diff in the
`settings_changed` event.

### `src/renderer/renderer.ts` (1337 lines)

**Description**: Main capsule renderer. Three view modes (`panel` full-
height sidebar, `compact` fixed box, `island` top-of-screen pill),
hot-mic ring buffer + WAV encoding, transcript history in localStorage
(capped at 50 entries), settings panel with mic picker + target mode +
language toggle, in-capsule mic test (uses an `AnalyserNode` + RAF for
a visual VU meter), upgrade overlay when the monthly cap hits zero,
idle-fade with opacity + wake overlay, premium haptic sounds synthesised
via `OscillatorNode` for every state transition, Ambiverse panel with
join-room UX + TTS playback of incoming translations.

**Key exports**: none (side-effect entrypoint, exports `{}` for module mode).

**Gotchas**:
- `RING_BUFFER_SECONDS=30`, `PRE_ROLL_MS=250`, `POST_ROLL_MS=350`,
  `PAD_START_MS=200`, `PAD_END_MS=800`, `SAMPLE_RATE=16000`, and the
  12-minute cap are all tuned values. Don't change without re-testing
  the whole hot path.
- `actualSampleRate` is captured from `audioCtx.sampleRate` after the
  AudioContext is created — don't use the `SAMPLE_RATE` constant for
  anything downstream (ring buffer size, WAV header). Chromium on M1+
  may have overridden it.
- `ScriptProcessorNode` is deprecated in favour of `AudioWorklet` but
  still works reliably in Electron 34. Migration is a future problem.
- The idle-fade uses `window:setOpacity` IPC, not CSS — the window is
  frameless + transparent and CSS opacity would also fade the content.
- `window:setFocusable(false)` makes the window click-through: clicking
  the capsule doesn't steal focus from the app you're dictating into.
  We flip to focusable when settings opens so the user can click inputs.
- `toggle()` has a 400ms debounce + a `toggling` re-entry flag.
- `hasAudioInput` tracks whether the ring buffer saw any sample above
  0.01 amplitude during the current recording session — this drives
  the "No voice detected" warning at 1.5s.
- `saveTranscript` caps at 50 entries. Long-press-to-delete gesture is
  implemented inline in `setupTranscriptGestures`.
- The `playSound` function synthesises waveform envelopes with
  `OscillatorNode` + `GainNode` exponential ramps. Each sound is ~100–200ms.
  Don't pull in a sample library, that's what makes it feel premium.

### `src/renderer/firstrun.ts` (661 lines)

**Description**: First-run wizard state machine. 6 screens with CSS
transitions (`.is-active`, `.is-leaving`), progress dots, per-screen
enter hooks. Identity form with email regex validation, mic permission
probe with pending/granted/denied visual states, hotkey teach with
in-window keydown listener + backup IPC path + 8s safety-valve button,
in-wizard dictation demo that runs its OWN `getUserMedia` capture
(doesn't share `renderer.ts`'s ring buffer) with WAV encoding and zero
padding, 20s safety-valve skip link on screen 5, finish button that
calls `markComplete` and closes.

**Key exports**: none.

**Gotchas**:
- The wizard has its own capture pipeline (not the ring buffer) because
  it runs in a separate BrowserWindow and doesn't have access to
  `renderer.ts`'s state. Padding logic must stay in sync between the
  two — same `PAD_START_MS=200`, `PAD_END_MS=800`.
- `armHotkeyListener` and `armFirstDictation` MUST call
  `armHotkeyTeach()` IPC on entry, MUST call `disarmHotkeyTeach()` IPC
  on exit (or the manual next button). Forgetting to re-arm leaves the
  hotkey unregistered and the capsule can never trigger dictation.
- `confirmHotkey` is idempotent (bails if `state.hotkeyDetected`).
  There are TWO code paths that call it (in-window keydown AND the IPC
  backup) so idempotency is required.
- The "I pressed it" safety button on screen 4 appears at 8s, the skip
  link on screen 5 appears at 20s. These exist because hotkey detection
  has failed for real users before and the wizard must never trap them.
- `markComplete` asks main to swap windows — main closes the wizard for
  us, so the finish button shows "Opening..." and waits. If markComplete
  throws, the button re-enables so the user can retry.
- `meetelFlow` (the main-capsule API) is available to the wizard because
  the same `preload.ts` runs on both windows. The wizard only uses
  `meetelFlow.transcribe` for the dictation demo.

### `src/renderer/index.html`, `styles.css`, `firstrun.html`, `firstrun.css`

**Description**: Static markup + CSS for both renderer windows. Copied
as-is into `dist/renderer/` by `npm run copy:assets`. The capsule HTML
includes all three view modes' DOM so `renderer.ts` can switch between
them without reloading.

**Gotchas**:
- Any new DOM id or class used by `renderer.ts` / `firstrun.ts` must
  also be added to the corresponding HTML file, AND the copy:assets
  step will need to pick it up (already globs `.html` + `.css` files).
- The capsule markup has `transparent` background and relies on a
  frameless window — dropping `transparent: true` in `createWindow`
  shows a black background.

### `supabase/meetel-schema.sql`

**Description**: Idempotent schema definition for the Supabase backend.
Creates `meetel_users`, `meetel_events`, `meetel_transcripts` tables,
their indexes, RLS policies, the `meetel_user_metrics` view, and the
`meetel_stamp_first_dictation` trigger. Safe to re-run. Assumes
`pgcrypto` extension (ships with Supabase by default).

**Gotchas**:
- Every policy is dropped-if-exists then recreated, so re-running the
  script is safe. Keep that pattern for any new policy.
- The view `meetel_user_metrics` is `CREATE OR REPLACE` but changing
  its column list requires a `DROP VIEW` first (Postgres won't let you
  add/remove columns via REPLACE).
- The trigger function is `SECURITY DEFINER` with `SET search_path = public`
  — this lets anon-role inserts into `meetel_transcripts` fire an UPDATE
  on `meetel_users` they don't otherwise have permission to touch.
  Don't remove `SECURITY DEFINER`.
- Changing the `UNIQUE` constraints on `meetel_users.email` /
  `device_id` requires updating `telemetry.ts::identifyUser` in lockstep.

### `supabase/PASTE_THIS_meetel.sql`

**Description**: A condensed version of the schema designed for
copy-pasting into the Supabase SQL editor when setting up a fresh
project. Non-authoritative — the source of truth is `meetel-schema.sql`.

---

*Document version: 1.0 — 2026-04-10 — matches Meetel Flow v0.2.3*
