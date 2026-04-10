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
  ┌─────────────────────── MAIN PROCESS (Node) ──────────────────────┐
  │  index.ts    — Electron lifecycle, windows, tray, IPC routing    │
  │  stt.ts      — Groq Whisper HTTPS + whisper.cpp fallback + polish│
  │  filters.ts  — hallucination + RMS + duration predicates         │
  │  inserter.ts — SendKeys / osascript clipboard-paste              │
  │  telemetry.ts + events.ts — Supabase queue, backoff, identifyUser│
  │  sync.ts     — fire-and-forget meetel_transcripts insert         │
  │  config.ts + usage.ts — ~/.meetel-flow/{config,usage}.json       │
  │  ambiverse.ts — Supabase Realtime bilingual room                 │
  │  updater.ts  — electron-updater                                  │
  │  preload.ts  — contextBridge: meetelFlow + meetelFirstRun        │
  └──────────────┬─────────────────────────┬─────────────────────────┘
                 │ IPC invoke              │ IPC invoke
  ┌──────────────▼────────┐  ┌─────────────▼────────────────┐
  │  RENDERER: capsule    │  │  RENDERER: first-run wizard  │
  │  index.html +         │  │  firstrun.html +             │
  │  renderer.ts          │  │  firstrun.ts                 │
  │                       │  │                              │
  │  • hot mic ring buf   │  │  • 6 screens                 │
  │  • WAV encoder        │  │  • arm/disarm dance          │
  │  • 3 view modes       │  │  • own dictation demo        │
  │  • localStorage txs   │  │                              │
  └───────────┬───────────┘  └─────────────┬────────────────┘
              │         audio / text       │
              └─────────────┬──────────────┘
                            ▼
              ┌─────────────────────────────────┐
              │  CLOUD                          │
              │  api.groq.com (Whisper + Llama) │
              │  generativelanguage (Gemini)    │
              │  mclbbkmpovnvcfmwsoqt.supabase  │
              └─────────────────────────────────┘
```

**Boundaries**: OS ↔ main for `globalShortcut`, tray, NSIS installer state,
auto-updater, keystroke/paste scripts, Electron session permissions. Main ↔
renderer for everything — all audio flows as base64 WAV over IPC, all config
lives in main. Renderer ↔ cloud never happens directly (STT, LLM polish,
Supabase writes all go through main). **Exception**: `ambiverse.ts` opens a
Supabase Realtime broadcast channel in main for live translation — the only
bidirectional cloud socket.

---

## Process model

### Main process — `src/main/`

One Electron main process hosts every privileged operation: window management,
global hotkey, filesystem config, HTTPS to Groq/Gemini, `execFile` for whisper.cpp
and the paste scripts, Supabase client, telemetry queue. `src/main/index.ts` is
the only file that imports `electron` broadly; every other module uses pure Node
or a tiny `electron` surface (`clipboard` in `inserter.ts`, `app` in `telemetry.ts`,
`autoUpdater` in `updater.ts`).

Debug redirection lives at the top of `index.ts`: `console.log`/`console.error`
are wrapped to also append to `~/.meetel-flow/debug.log` with timestamps. Every
main-side log lands there — don't add try/catch that swallows errors back to
`null`, it defeats the diagnostic path.

### Renderer processes — 2 separate BrowserWindows

The app boots into one of two renderer windows depending on
`config.firstRunComplete`:

| Window | Script | HTML | Preload bridge | Flags |
|---|---|---|---|---|
| Capsule | `renderer.ts` | `index.html` | `window.meetelFlow` | frameless, transparent, alwaysOnTop, `focusable: false`, `skipTaskbar: true` |
| Wizard | `firstrun.ts` | `firstrun.html` | `window.meetelFirstRun` (+ `meetelFlow` subset) | frameless, transparent, `focusable: true`, `show: false` until `ready-to-show` |

Both: `contextIsolation: true`, `nodeIntegration: false`. Renderer cannot
`require()`, cannot touch the filesystem, cannot make arbitrary HTTPS calls —
only the channels explicitly exposed by `preload.ts` exist on `window.*`.
Audio flows as base64 strings over IPC because raw Buffers don't marshal
cleanly across the context bridge.

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
app. Every step names the load-bearing file.

### 1. Hotkey detection — `src/main/index.ts`

```ts
const HOTKEY = "Control+Space";   // LITERAL, not CommandOrControl
globalShortcut.register(HOTKEY, hotkeyToggle);
// hotkeyToggle sends "hotkey:toggle" to the capsule, "firstrun:hotkeyFired" to the wizard
```

Electron's `globalShortcut.register()` uses `RegisterHotKey` on Windows and
`CGEventTap` on macOS. The OS intercepts the chord **before** any window's
keydown listener sees it — great for normal use (user can be in any app),
fatal for the first-run teach mode (hence the arm/disarm dance, see wizard
section). Renderer subscribes via `window.meetelFlow.onHotkeyToggle()`.

### 2. Audio capture — `src/renderer/renderer.ts::armMicrophone` → `startRecording` → `stopAndTranscribe`

The mic is opened **once** at app boot via `getUserMedia`, attached to an
`AudioContext` + `ScriptProcessorNode`, and kept hot for the lifetime of the
app. Every incoming frame writes into a 30-second circular `Float32Array`
ring buffer (~960 KB at 16 kHz mono). A monotonic sample counter
(`ringBufferTotal`) never resets, so slicing survives wrap-around.

On hotkey: `captureStartSample = ringBufferTotal - preRoll` (250ms before
press). On stop: `sleep(POST_ROLL_MS=350)` to let trailing audio land, then
`readRing(startSample, stopSample - startSample)`.

**Why pre-roll**: old code called `getUserMedia` + new `AudioContext` on
every press, costing 300–600ms — which was *the reason the first word was
often missing*. **Why post-roll**: users release the key while still
finishing the last syllable.

### 3. WAV encode + silence padding (same file)

1. **Peak-normalise** to -1 dB headroom (`normalizePcm`) — cuts WER from
   68% → 52% on quiet captures.
2. **Pad with zero samples**: 200 ms pre + 800 ms post. Whisper's decoder
   treats trailing non-speech as the stop region and **eats the final
   syllable** if audio ends abruptly (see `openai/whisper#29`, `#493`,
   `#1278`). ~25 KB overhead per dictation.
3. **Encode to 16-bit PCM WAV** using `actualSampleRate` from the live
   AudioContext (NOT the requested 16 kHz — Chromium on M-series Macs
   overrides it; encoding at the wrong rate causes chipmunk playback).
4. Base64-encode and ship via IPC `stt:transcribe`.

### 4. STT — `src/main/stt.ts::transcribe`

**Primary (Groq)**: `POST api.groq.com/openai/v1/audio/transcriptions`,
multipart with `model=whisper-large-v3`, `response_format=verbose_json`,
`timestamp_granularities[]=word,segment`, `temperature=0`, 30s timeout.
Language is forced when user selected `en`/`fr`. A language-specific
**prompt** (`"Meeting transcript..."` + glossary `Meetel, DASH, TypeScript,
React, Supabase, Vercel`) primes the decoder — removing it hurts proper
noun accuracy.

**Fallback (whisper.cpp)**: `execFile` on `~/.meetel-flow/whisper/whisper-cli.exe`
with `-m ggml-base.bin -f tmp.wav -l auto --no-timestamps -t 4`. Do NOT
pass `--print-special false` — see gotcha 7.

Groq returns per-segment `avg_logprob`, `no_speech_prob`, `compression_ratio`
which drive the hallucination filter in step 5.

### 5. Quality filter + cleanup + voice commands (still `stt.ts`)

Chained in order:

1. **`filters.ts::filterTranscriptionResult`** — gate on empty text,
   `durationMs < 300`, RMS < 500, or known hallucination phrase
   (per-language dict, ~200 entries: "sous-titrage de la Société
   Radio-Canada", "thanks for watching", "ご視聴ありがとうございました", ...).
2. **`filterHallucinations(text, segments)`** — drops segments with
   `no_speech_prob > 0.6`, `compression_ratio > 2.4` (repetitive),
   `avg_logprob < -1.0` (low confidence), or duplicates (Whisper looping).
3. **`regexCleanup`** — strips YouTube-outro boilerplate, EN/FR filler
   words, collapses whitespace, capitalises sentence starts and standalone `I`.
4. **`processVoiceCommands`** — bilingual voice-to-punctuation:
   "new line"/"nouvelle ligne" → `\n`, "period"/"point" → `.` (FR `point`
   excluded before `de`/`d'`), "comma"/"virgule", "question mark"/
   "point d'interrogation", etc.

### 6. LLM polish — `stt.ts::llmPolish`

```
llmPolish(text, groqKey, geminiKey, language):
    if groqKey:
        result = groqPolish(text, "llama-3.3-70b-versatile", temp=0.1, 10s)
        if result: return result
        // falls through on HTTP !== 200, 429 rate limit, timeout, empty
    if geminiKey:
        return geminiPolish(text, "gemini-2.0-flash", temp=0.1, 10s)
    return text  // no LLM available → raw text through
```

`POLISH_PROMPT` is **language-specific** and explicitly says
*"The text IS in French — do NOT translate anything to English"* (and vice
versa). Early versions had the model silently translating. The FR prompt
also enumerates ~15 common accent fixes (`etais→étais`, `meme→même`,
`deja→déjà`, etc.) because Whisper large-v3 drops them frequently.

### 7. Insert at cursor — `src/main/inserter.ts`

Per-platform, clipboard+paste pattern (save prev clipboard → set text →
invoke native paste → restore prev clipboard after 500ms):

- **Windows**: `powershell ... [System.Windows.Forms.SendKeys]::SendWait('^v')`
- **macOS**: `osascript -e 'tell application "System Events" to keystroke "v" using command down'`
- **Linux**: clipboard-only, user pastes manually
- `targetMode="clipboard"` skips the paste step

Never use `SendKeys::SendWait(text)` or `keystroke "text"` directly — both
strip Unicode (accents, CJK, emoji). Mac's `osascript` path does not
require Accessibility, only Automation (auto-granted by most apps). On
Mac failure, text stays on clipboard and the function throws a
user-actionable "press Cmd+V" error — graceful, not silent.

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

Electron app entrypoint. Creates BrowserWindows (capsule OR wizard, mutually
exclusive on boot), registers every `ipcMain.handle` channel, owns the global
hotkey, wires the tray + auto-updater, bootstraps telemetry. Installs a
`console.log`/`console.error` → `~/.meetel-flow/debug.log` redirect at the top
of the file.

**Gotchas before editing**:
- The `console.log` override must stay at the very top. Moving it below other
  imports means those imports' logs never reach `debug.log`.
- `HOTKEY` must be literal `"Control+Space"`, NOT `"CommandOrControl+Space"`.
- Boot decision: `if (!initialCfg.firstRunComplete) wizard else capsule`. Tray
  and hotkey register in BOTH branches (wizard needs the hotkey on screen 4).
- `ipcMain.handle("telemetry:track")` uses an allowlist — add new renderer-
  originated events to the `allowed` Set.
- `firstrun:markComplete` order is load-bearing: saveConfig → create capsule
  window → re-register hotkey → close old wizard. Don't flip.
- `before-quit` calls `telemetry.shutdown()` with `e.preventDefault()` to give
  the final flush time before `app.exit(0)`. Don't remove the preventDefault.

### `src/main/preload.ts` (74 lines)

`contextBridge.exposeInMainWorld` for both renderer windows. Exposes
`window.meetelFlow` (capsule API) and `window.meetelFirstRun` (wizard API) as
separate namespaces. Same preload runs on both windows — the wizard gets
`meetelFlow.transcribe` access for its in-window dictation demo.

**Gotcha**: any new IPC channel must be added here AND to the main-side
handler AND to the TypeScript API type (`MeetelApi` in `renderer.ts`,
`MeetelFirstRunAPI` in `firstrun.ts`). Types are manually kept in sync.

### `src/main/stt.ts` (584 lines)

The STT engine: Groq Whisper HTTPS client (raw multipart body assembled by
hand, no `form-data` dep), `whisper.cpp` local fallback (`execFile`),
per-segment hallucination filter, regex cleanup, bilingual voice-command
mapping, LLM polish chain (Groq Llama 3.3 70B → Gemini 2.0 Flash → raw text).
Maintains `lastTranscript` session memory.

**Key export**: `transcribe(config, audioBase64, mimeType, durationSeconds, wavBase64)`

**Gotchas**:
- Groq multipart fields must come BEFORE the file for their parser. Append
  new fields before the closing boundary.
- The Whisper `prompt` parameter is load-bearing — removing it hurts proper
  noun accuracy and punctuation style.
- `temperature: 0` is correct; higher values make Whisper hallucinate more.
- `groqPolish()` returns `""` on rate-limit/timeout/empty so `llmPolish()`
  can fall through to Gemini. Do NOT throw there — fallback is the point.
- `filterHallucinations` must run BEFORE `regexCleanup` because it needs the
  raw segments from Groq's response.
- `fixFrench()` is dead code in the main path (LLM polish handles accents).
  Kept for a future offline-only mode.
- Writes directly to `~/.meetel-flow/stt.log`, bypassing the main-process
  console redirect. Intentional — STT gets its own log channel.
- `--print-special false` is NOT a valid whisper-cli arg. See gotcha 7.

### `src/main/filters.ts` (487 lines)

Pure, side-effect-free predicates for rejecting bad transcriptions.
Per-language hallucination phrase dictionary (7 languages, ~200 entries with
inline origin comments), PCM16 RMS with WAV header auto-skip, duration floor,
orchestrator that runs checks in cost order.

**Key exports**: `filterTranscriptionResult`, `isKnownHallucination`,
`isAudioTooQuiet`, `isAudioTooShort`, `computeRmsPcm16`, `normaliseForMatch`,
`HALLUCINATION_PHRASES`.

**Gotchas**:
- Every hallucination entry has a comment explaining its origin (CBC
  subtitles, Amara credits, ZDF, etc.). Keep them so nobody deletes phrases
  thinking they're paranoid.
- `computeRmsPcm16` is PCM16 LE only. Passing WebM/Ogg returns garbage.
- RMS threshold 500 is conservative (real speech at 6in reads 1500+).
- Substring match only fires when `text.length ≤ phrase.length * 2` to avoid
  rejecting real speech that quotes "thanks for watching" as a fragment.

### `src/main/inserter.ts` (70 lines)

OS-level cursor insertion. Clipboard-save + set + paste-script + restore on
Windows (PowerShell `SendKeys '^v'`) and macOS (osascript `keystroke "v"
using command down`). Clipboard-only on Linux.

**Key export**: `insertText(text, mode: "type" | "clipboard")`

**Gotchas**:
- Never use `SendKeys::SendWait(text)` or `keystroke "text"` — both strip
  Unicode. Clipboard+paste is the only Unicode-safe path.
- The 500ms clipboard-restore delay is the minimum; below ~200ms the restore
  races the paste.
- Mac path does NOT require Accessibility — only Automation, which most apps
  grant without a blocking dialog. Keep it that way.
- If mac Automation is blocked the function throws a user-actionable
  "text copied to clipboard, press Cmd+V" message instead of failing silently.

### `src/main/telemetry.ts` (515 lines)

Main-process singleton telemetry emitter. Derives a stable `device_id`
(Linux: hashed machine-id; else persisted UUIDv4). In-memory queue + atomic-
write disk mirror at `userData/telemetry-queue.json`. Flushes every 30s / on
explicit `flush()` / on `shutdown()`. Exponential backoff 1s → 5min cap.
Queue cap 10K events, drops oldest. Implements `identifyUser` as
select-then-update.

**Key exports**: `init`, `track`, `identifyUser`, `flush`, `shutdown`,
`IdentifyUserError`, `__internal`.

**Gotchas**:
- `init()` MUST run after `app.whenReady()` — needs `app.getPath('userData')`.
- `identifyUser` is NOT an upsert. See gotcha 4 — do not simplify.
- Every step logs to console (→ `debug.log`). Don't swallow errors back to
  null; the error messages are the debugging path.
- `flush()` uses `.insert()` without `.select()`. Adding `.select()` breaks
  anon writes (gotcha 5).
- Disk mirror uses tmp-file + rename so a crash mid-write can't corrupt the
  queue.

### `src/main/events.ts` (109 lines)

`TelemetryEvent` discriminated union + helper types. 10 event types with
strict payload shapes; `QueuedTelemetryEvent` wrapper for persistence. No
`any` types — `track<N>` enforces event/payload pairing at compile time.

**Gotcha**: adding a new event requires both a new payload interface and a
new branch of the union. `DictationSuccessPayload.provider` union includes
`"gemini"` — polishing via Gemini counts as a provider for telemetry.

### `src/main/sync.ts` (67 lines)

Fire-and-forget `meetel_transcripts` insert after every successful dictation.
IIFE wrapper so the public signature stays `void`. Reads `APP_VERSION` from
`package.json` at module load.

**Key export**: `pushTranscript(result, userId?)`

**Gotchas**: no-op when `userId` is undefined (local-only mode). Uses
`.insert()` without `.select()`. The
`trg_meetel_transcripts_first_dictation` trigger fires on every insert — if
you remove the trigger, the admin cockpit's time-to-first-dictation metric
stops working.

### `src/main/config.ts` (61 lines)

`~/.meetel-flow/config.json` load/save + API-key resolution. Keys come from
`process.env.MEETEL_GROQ_KEY` → `~/.meetel-flow/.env` (regex-parsed) →
empty. `loadConfig()` returns `defaults ⊕ disk ⊕ baked-keys` — baked keys
always win so updating the env file doesn't require clearing config.json.

**Gotchas**: `saveConfig` is read-merge-write, not atomic (fine in practice;
only main writes). `.env` parsing is a regex, not real dotenv — no quoted
values or comments.

### `src/main/usage.ts` (65 lines)

Monthly free-tier cap. 100 min/month default, auto-reset on `YYYY-MM`
change, persisted at `~/.meetel-flow/usage.json`. 0.01 min precision.

**Gotcha**: month comparison uses local time, so timezone-hopping users
might lose/gain minutes at month boundaries. Not worth fixing yet.

### `src/main/updater.ts` (42 lines)

`electron-updater` bootstrap. Checks on boot (packaged builds only),
downloads in background, installs on quit. Silences
`ERR_NAME_NOT_RESOLVED`/`ENOTFOUND` so dev builds don't spam logs.

**Gotchas**: skipped when `!app.isPackaged`. `MEETEL_DISABLE_UPDATES=1`
fully disables. DNS silencer uses substring matching — if you change it,
make sure `"getaddrinfo"` still catches the common case.

### `src/main/ambiverse.ts` (137 lines)

Supabase Realtime broadcast-channel layer for live bilingual translation.
Creates 4-digit room codes, joins rooms, receives peer transcripts, runs
them through `translate()` (Groq Llama), fires a callback to the renderer.

**Gotchas**:
- `channel.send(broadcast)` is best-effort, not guaranteed delivery.
- Room codes are 4 digits → 9000 rooms, no collision handling.
- The anon key here (`eyJ...` JWT format) is NOT the same as the
  `sb_publishable_9L0m_...` key in `sync.ts`/`index.ts`. Both are anon —
  JWT works with Realtime, publishable works with PostgREST. Historical
  artifact; safe to leave.

### `src/main/types.ts` (31 lines)

Shared type aliases: `FlowConfig`, `DictationResult`, `DictationState`,
`ViewMode`, `PanelSide`.

**Gotcha**: adding a field to `FlowConfig` requires: (1) default in
`config.ts`, (2) wizard write path if onboarding-relevant, (3) renderer read
path, (4) telemetry diff in the `settings_changed` event.

### `src/renderer/renderer.ts` (1337 lines)

Main capsule renderer. Three view modes (`panel`/`compact`/`island`), hot-
mic ring buffer + WAV encoding, transcript history in localStorage (cap 50),
settings panel with mic picker and in-capsule mic test (AnalyserNode + RAF
VU meter), upgrade overlay when usage hits zero, idle-fade via
`window:setOpacity` + wake overlay, synthesised haptic sounds per state
transition (`OscillatorNode` + gain ramps, no sample library), Ambiverse
panel with TTS playback of incoming translations.

**Gotchas**:
- `RING_BUFFER_SECONDS=30`, `PRE_ROLL_MS=250`, `POST_ROLL_MS=350`,
  `PAD_START_MS=200`, `PAD_END_MS=800`, 12-min cap — all tuned values, don't
  change without re-testing the hot path.
- Always use `actualSampleRate` (captured from `audioCtx.sampleRate`), never
  the `SAMPLE_RATE` constant, for ring buffer sizing and WAV headers — M-series
  Macs may have overridden the requested rate.
- `ScriptProcessorNode` is deprecated but works reliably in Electron 34.
  Migration to `AudioWorklet` is a future problem.
- Idle fade uses `window:setOpacity` IPC, not CSS — the window is transparent
  and CSS opacity would fade the content too.
- `window:setFocusable(false)` makes the capsule click-through. Flipped to
  focusable when settings opens so the user can click inputs.
- `toggle()` has a 400ms debounce + a `toggling` re-entry flag.
- `hasAudioInput` drives the "No voice detected" warning at 1.5s; any sample
  above 0.01 amplitude trips it.

### `src/renderer/firstrun.ts` (661 lines)

First-run wizard state machine. 6 screens with CSS transitions, progress
dots, per-screen enter hooks. Email regex validation, mic permission probe,
hotkey teach with in-window `keydown` + IPC backup path + 8s safety-valve
button, in-wizard dictation demo that runs its OWN `getUserMedia` capture
(doesn't share the main capsule's ring buffer), 20s skip link on screen 5,
finish button that calls `markComplete` and lets main close the wizard.

**Gotchas**:
- Wizard has its own capture pipeline because it's a separate BrowserWindow.
  Padding logic (`PAD_START_MS=200`, `PAD_END_MS=800`) must stay in sync with
  `renderer.ts`.
- `armHotkeyListener` / `armFirstDictation` MUST call `armHotkeyTeach()` on
  entry and `disarmHotkeyTeach()` on exit. Forgetting to re-arm leaves the
  hotkey unregistered and the capsule can never trigger dictation.
- `confirmHotkey` is idempotent (two code paths can call it — in-window
  keydown and the IPC backup).
- Manual "I pressed it" button at 8s on screen 4, skip link at 20s on screen
  5 — exist because hotkey detection has failed for real users before. The
  wizard must never trap the user.
- `meetelFlow` is available in the wizard because the same preload runs on
  both windows. Wizard uses only `meetelFlow.transcribe`.

### `src/renderer/{index,firstrun}.{html,css}`

Static markup + CSS copied into `dist/renderer/` by `npm run copy:assets`.
The capsule HTML contains all three view modes' DOM so `renderer.ts` can
switch between them without reloading. Dropping `transparent: true` in
`createWindow` shows a black background.

### `supabase/meetel-schema.sql`

Idempotent schema: tables, indexes, RLS policies, the `meetel_user_metrics`
view, the `meetel_stamp_first_dictation` trigger. Assumes `pgcrypto` (ships
with Supabase). Safe to re-run.

**Gotchas**:
- Every policy is dropped-if-exists then recreated. Keep that pattern.
- `CREATE OR REPLACE` on the view works for body changes but adding/removing
  columns requires a prior `DROP VIEW`.
- The trigger is `SECURITY DEFINER` with `SET search_path = public` so anon
  inserts into `meetel_transcripts` can fire an UPDATE on `meetel_users`
  they otherwise can't touch. Don't remove `SECURITY DEFINER`.
- Changing `UNIQUE` constraints on `meetel_users.email` / `device_id`
  requires updating `telemetry.ts::identifyUser` in lockstep.

### `supabase/PASTE_THIS_meetel.sql`

Condensed copy-paste version of the schema for the Supabase SQL editor when
spinning up a fresh project. Non-authoritative — source of truth is
`meetel-schema.sql`.

---

*Document version: 1.0 — 2026-04-10 — matches Meetel Flow v0.2.3*
