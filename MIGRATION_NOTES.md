# Meetel Flow — Telemetry Integration Notes

This document describes the **exact edits** needed in three existing files
to wire the new telemetry emitter into the Electron main process. These
edits are **not applied automatically** — review them, then apply by hand.

The new files landed in this drop are:

- `src/main/events.ts` — discriminated-union event types
- `src/main/telemetry.ts` — singleton emitter
- `supabase/meetel-schema.sql` — run this in the Supabase SQL editor (project `mclbbkmpovnvcfmwsoqt`) before deploying the next app build

---

## 0. Prerequisites

### Run the SQL migration

Open the Supabase SQL editor for project `mclbbkmpovnvcfmwsoqt` and paste
the contents of `supabase/meetel-schema.sql`. It is idempotent — safe to
re-run. It creates:

- `meetel_users` — one row per email (device id is unique)
- `meetel_events` — append-only event log
- `meetel_user_metrics` — aggregated view for dashboards
- RLS policies: `anon` can insert events and upsert its own user row;
  `authenticated` and `service_role` can read; `service_role` has full access.

### Supabase credentials

The emitter reads `SUPABASE_URL` and `SUPABASE_ANON_KEY` from `process.env`
at init time. If you already bake credentials into `sync.ts` you can pass
them to `telemetry.init()` explicitly — see the `index.ts` edit below.

---

## 1. `src/main/config.ts`

Add telemetry toggle and app-version helpers to the config surface. The
emitter itself does not require config changes to function, but exposing
these lets the user opt out and lets us attach the version to every event.

### Add to the `FlowConfig` type (in `src/main/types.ts` — DO NOT edit if
the instructions forbid it; instead, extend it at runtime by adding these
fields as optional properties). If you choose to touch `types.ts` later:

```ts
telemetryEnabled?: boolean;   // default true
analyticsConsentAt?: string;  // ISO timestamp of opt-in
```

### Add to `defaults` in `config.ts`:

```ts
const defaults: FlowConfig = {
  // ...existing fields...
  telemetryEnabled: true,
};
```

No other changes needed in `config.ts`. The emitter does not read config
directly — the main process is responsible for checking `telemetryEnabled`
before calling `track()`.

---

## 2. `src/main/index.ts`

Four hook points: **imports**, **app.whenReady**, **dictation IPC handler**,
**before-quit handler**.

### 2a. Imports — add to the top of the file, after the existing imports

```ts
import * as telemetry from "./telemetry";
```

### 2b. Initialise inside `app.whenReady().then(async () => { ... })`

Add **as the very first statements** of the callback (before
`setPermissionRequestHandler`):

```ts
const pkg = require("../../package.json") as { version: string };

telemetry.init({
  appVersion: pkg.version,
  // Optionally hard-code — otherwise reads SUPABASE_URL / SUPABASE_ANON_KEY from env.
  supabaseUrl: "https://mclbbkmpovnvcfmwsoqt.supabase.co",
  supabaseAnonKey: process.env.SUPABASE_ANON_KEY,
  debug: !app.isPackaged,
});

telemetry.track("app_start", {
  version: pkg.version,
  platform: process.platform,
  os_version: `${os.type()} ${os.release()}`,
});
```

> `os` is already imported at the top of the file, so no extra import.

### 2c. Fire a hotkey event — edit `registerHotkeys()`

Replace the `toggle` closure with:

```ts
const toggle = () => {
  telemetry.track("hotkey_fired", { hotkey: "CommandOrControl+Space" });
  mainWindow?.webContents.send("hotkey:toggle");
};
```

### 2d. Instrument the STT handler — edit `ipcMain.handle("stt:transcribe", ...)`

Inside the handler, add timing + success/failure events. The handler
currently looks like:

```ts
ipcMain.handle("stt:transcribe", async (_e, payload) => {
  // ...existing logic...
});
```

Wrap the body as follows:

```ts
ipcMain.handle("stt:transcribe", async (_e, payload) => {
  const t0 = Date.now();
  if (!hasMinutesRemaining()) {
    telemetry.track("dictation_failure", {
      duration_ms: Date.now() - t0,
      error_code: "limit_reached",
      error_message: "Free limit reached",
    });
    return { error: "Free limit reached. Subscribe to Meetel for unlimited." };
  }
  try {
    const cfg = loadConfig();
    const result = await transcribe(
      cfg,
      payload.audioBase64,
      payload.mimeType,
      payload.durationSeconds,
      payload.wavBase64,
    );
    addUsage(result.durationSeconds);
    pushTranscript(result, cfg.userId);

    if (isConnected() && result.text) {
      sendTranscript(result.text, result.detectedLang || cfg.language);
    }

    telemetry.track("dictation_success", {
      duration_ms: Date.now() - t0,
      word_count: result.text.trim().split(/\s+/).filter(Boolean).length,
      provider: result.provider,
      language: result.detectedLang ?? cfg.language,
    });

    return {
      text: result.text,
      provider: result.provider,
      detectedLang: result.detectedLang,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Transcription failed";
    telemetry.track("dictation_failure", {
      duration_ms: Date.now() - t0,
      error_code: "stt_exception",
      error_message: msg,
    });
    return { error: msg };
  }
});
```

### 2e. Instrument the config save handler — edit `ipcMain.handle("config:save", ...)`

```ts
ipcMain.handle("config:save", (_e, cfg: Partial<FlowConfig>) => {
  const before = loadConfig();
  saveConfig(cfg);
  for (const key of Object.keys(cfg) as (keyof FlowConfig)[]) {
    telemetry.track("settings_changed", {
      key,
      from: (before[key] ?? null) as string | number | boolean | null,
      to: (cfg[key] ?? null) as string | number | boolean | null,
    });
  }
  return { ok: true };
});
```

### 2f. Flush and shut down cleanly — add above `app.on("will-quit", ...)`

```ts
app.on("before-quit", async (e) => {
  if (!telemetry.__internal.isInitialised()) return;
  e.preventDefault();
  try {
    await telemetry.shutdown();
  } finally {
    // Give Electron one tick to release the beforeQuit handler.
    setImmediate(() => app.exit(0));
  }
});
```

Also add a safety flush before the existing `globalShortcut.unregisterAll`:

```ts
app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  void telemetry.flush();
});
```

---

## 3. `src/main/preload.ts`

If you want the **renderer** to be able to fire telemetry events (for
first-run wizard completion, mic permission results, renderer errors, etc.),
expose a minimal IPC bridge. This requires **two** edits:

### 3a. In `src/main/index.ts`, add an IPC handler

Put this next to the other `ipcMain.handle(...)` blocks:

```ts
ipcMain.handle(
  "telemetry:track",
  (_e, event: string, payload: Record<string, unknown>) => {
    // Allowlist — renderer should not be able to emit arbitrary event names.
    const allowed = new Set([
      "first_run_start",
      "first_run_complete",
      "mic_permission_result",
      "error",
    ]);
    if (!allowed.has(event)) return { ok: false, error: "disallowed" };
    // Cast is safe because we just validated the name against the allowlist.
    telemetry.track(
      event as "first_run_start" | "first_run_complete" | "mic_permission_result" | "error",
      payload as never,
    );
    return { ok: true };
  },
);
```

### 3b. In `src/main/preload.ts`, add to `contextBridge.exposeInMainWorld("meetelFlow", { ... })`

```ts
trackEvent: (event: string, payload: Record<string, unknown>) =>
  ipcRenderer.invoke("telemetry:track", event, payload),
```

The renderer can then do:

```ts
window.meetelFlow.trackEvent("first_run_complete", { duration_ms: 12345 });
```

---

## 4. Smoke test

1. Run the SQL migration in Supabase.
2. Set `SUPABASE_ANON_KEY` in your environment (or hard-code the URL+key
   in the `telemetry.init()` call above — the same key already embedded
   in `src/main/sync.ts` will work).
3. `npm run dev`.
4. Watch `~/.meetel-flow/debug.log` for lines prefixed `[telemetry]`.
5. In the Supabase table editor, open `meetel_events` — you should see
   an `app_start` row within ~30 seconds (or immediately after a clean
   shutdown).
6. Kill the app with `SIGKILL` (not quit). Restart. The queued events
   from the previous session should flush on the next `app_start`.

---

## 5. Rollback

To disable telemetry without removing the code, set
`cfg.telemetryEnabled = false` and gate the `telemetry.track(...)` calls
behind `if (cfg.telemetryEnabled)`. The emitter itself is inert if
`init()` is never called.

To remove entirely: delete `src/main/telemetry.ts` and `src/main/events.ts`,
revert the five edits above, drop the three Supabase objects with:

```sql
DROP VIEW  IF EXISTS meetel_user_metrics;
DROP TABLE IF EXISTS meetel_events;
DROP TABLE IF EXISTS meetel_users;
```
