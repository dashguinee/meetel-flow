# Meetel Flow — First-Run Wizard Integration Guide

This document describes how to wire the standalone onboarding wizard
(`src/renderer/firstrun.html` + `firstrun.ts` + `firstrun.css`) into the
Electron main process. No existing renderer file was modified — everything
lives in new files.

## Files delivered by this task

| Path | Purpose |
|---|---|
| `src/renderer/firstrun.html` | Wizard shell with all 6 screens as `<article class="fr-screen">` |
| `src/renderer/firstrun.ts`   | State machine, validation, IPC calls (compiled to `firstrun.js`) |
| `src/renderer/firstrun.css`  | Theming — matches `styles.css` palette (dark glass, orange accents) |

The wizard expects its script tag to resolve to `./firstrun.js`, matching
how `index.html` loads `./renderer.js`. Add `firstrun.ts` to
`tsconfig.renderer.json`'s `include` (or leave the existing glob if it
already covers `src/renderer/**/*.ts`).

## Flow summary

1. **Welcome**  — "Speak your Mind. Any Language." + CTA
2. **Who are you?** — name (optional) + email (required, regex-validated)
3. **Microphone permission** — triggers OS prompt, shows pending/granted/denied
4. **Your hotkey** — user presses Ctrl+Space, visual flashes green
5. **First dictation** — waits for first successful dictation event, auto-advances; "Skip for now" link appears after 30 s
6. **You're in** — celebratory summary, CTA closes wizard and activates main

Screen transitions are CSS opacity/translate fades driven by `.is-active` / `.is-leaving`
classes on `.fr-screen`. Progress dots light up via `.is-done` / `.is-current`.

## 1. Boot decision in `src/main/index.ts`

Add a config flag `firstRunComplete: boolean` (default `false`) to whatever
`ConfigStore` you already use for `config:get` / `config:save`. On app
`whenReady`, read it and decide which window to open:

```ts
// pseudo-code, inside app.whenReady()
const cfg = await configStore.get();
if (!cfg.firstRunComplete) {
  createFirstRunWindow();
} else {
  createMainWindow(); // existing capsule/panel window
}
```

### `createFirstRunWindow()`

```ts
function createFirstRunWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 480,
    height: 640,
    minWidth: 420,
    minHeight: 580,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    resizable: true,
    alwaysOnTop: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      sandbox: false,
    },
  });

  win.loadFile(path.join(__dirname, "../renderer/firstrun.html"));
  win.once("ready-to-show", () => win.show());

  // Track so the IPC handlers know which window they're talking to.
  firstRunWindow = win;
  win.on("closed", () => { firstRunWindow = null; });
  return win;
}
```

The wizard is `-webkit-app-region: drag` on the shell and `no-drag` on
interactive elements, matching `renderer.ts`'s pattern, so a frameless
transparent window is all you need.

## 2. Preload bridge (`src/main/preload.ts`)

Expose a second namespaced bridge so the wizard never collides with the
existing `window.meetelFlow` API:

```ts
contextBridge.exposeInMainWorld("meetelFirstRun", {
  createUser: (payload: { name: string; email: string }) =>
    ipcRenderer.invoke("firstrun:createUser", payload),

  requestMicPermission: () =>
    ipcRenderer.invoke("firstrun:requestMicPermission"),

  testHotkey: () =>
    ipcRenderer.invoke("firstrun:testHotkey"),

  skipFirstDictation: () =>
    ipcRenderer.invoke("firstrun:skipFirstDictation"),

  markComplete: () =>
    ipcRenderer.invoke("firstrun:markComplete"),

  onDictationSuccess: (cb: () => void) => {
    ipcRenderer.on("firstrun:dictationSuccess", () => cb());
  },
});
```

Because the same `preload.js` can serve both windows, the main window will
also see `window.meetelFirstRun` — harmless since the main window never
calls it. If you prefer strict isolation, make a `preload-firstrun.ts` and
point the wizard's `BrowserWindow.webPreferences.preload` at it.

## 3. IPC handlers the main process must implement

All new channels live under the `firstrun:` namespace so they do not
overlap with existing `stt:`, `config:`, `usage:`, `window:`, `ambiverse:`
handlers.

### `firstrun:createUser`

**Input**: `{ name: string; email: string }`
**Output**: `{ ok: boolean; userId?: string; error?: string }`

Delegate to the telemetry module Agent A is building. Typical shape:

```ts
ipcMain.handle("firstrun:createUser", async (_e, payload) => {
  try {
    const { userId } = await telemetry.createUser({
      name: payload.name || null,
      email: payload.email,
      source: "firstrun",
    });
    await configStore.save({ userId, userName: payload.name, userEmail: payload.email });
    return { ok: true, userId };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "unknown" };
  }
});
```

The wizard validates email format client-side with
`^[^\s@]+@[^\s@]+\.[^\s@]+$`, but you should still reject bad input
server-side.

### `firstrun:requestMicPermission`

**Input**: none
**Output**: `{ granted: boolean }`

On macOS use `systemPreferences.askForMediaAccess("microphone")`. On
Windows 10+/Linux the OS-level gate is opened the first time the renderer
calls `navigator.mediaDevices.getUserMedia({ audio: true })`, so you can
implement this handler by asking the wizard's WebContents to run that
probe and report back, or by using a hidden `getUserMedia` call on the
renderer side. Minimum macOS implementation:

```ts
ipcMain.handle("firstrun:requestMicPermission", async () => {
  if (process.platform === "darwin") {
    const granted = await systemPreferences.askForMediaAccess("microphone");
    return { granted };
  }
  // Win/Linux: defer to renderer probe — see note above
  const granted = await probeMicViaRenderer(firstRunWindow);
  return { granted };
});
```

If denied, the wizard shows an inline help card explaining how to re-open
System Settings. The "Check again" button simply re-invokes this handler.

### `firstrun:testHotkey`

**Input**: none
**Output**: `{ detected: boolean }`

Subscribe once to the next global hotkey fire (you already register
`Ctrl+Space` somewhere — it emits `hotkey:toggle` in the main window per
`preload.ts` line 26). Return a promise that resolves when that event
next fires:

```ts
ipcMain.handle("firstrun:testHotkey", () =>
  new Promise<{ detected: boolean }>((resolve) => {
    const onFire = () => {
      globalShortcut.unregisterAll(); // or your existing hotkey module's off()
      hotkeyBus.off("fire", onFire);
      resolve({ detected: true });
    };
    hotkeyBus.once("fire", onFire);
    // Optional safety timeout:
    setTimeout(() => {
      hotkeyBus.off("fire", onFire);
      resolve({ detected: false });
    }, 120_000);
  })
);
```

The wizard also listens in-window for Ctrl+Space as a visual fallback, so
even if this handler never resolves, the user can still advance by
pressing the hotkey while the wizard is focused.

### `firstrun:dictationSuccess` (push event)

The wizard subscribes via `onDictationSuccess(cb)`. Main should emit this
**exactly once** on the first successful transcription after onboarding
step 5 begins. Hook into wherever `stt:transcribe` currently succeeds and
writes text into the target app:

```ts
// After a successful insertText in your existing flow:
if (firstRunWindow && !firstRunDictationFired) {
  firstRunDictationFired = true;
  firstRunWindow.webContents.send("firstrun:dictationSuccess");
}
```

### `firstrun:skipFirstDictation`

**Input**: none
**Output**: `void`

User clicked "Skip for now". Mark any telemetry flag, don't treat this as
a failure — just advance. The wizard still goes to screen 6 after this
resolves.

```ts
ipcMain.handle("firstrun:skipFirstDictation", async () => {
  await configStore.save({ firstDictationSkipped: true });
});
```

### `firstrun:markComplete`

**Input**: none
**Output**: `void`

This is the handoff. Persist the flag, destroy the wizard window, and
spin up the main capsule window:

```ts
ipcMain.handle("firstrun:markComplete", async () => {
  await configStore.save({ firstRunComplete: true });
  const toClose = firstRunWindow;
  firstRunWindow = null;
  createMainWindow();
  if (toClose && !toClose.isDestroyed()) toClose.close();
});
```

The wizard's "Start Using" button awaits this handler, so the main window
should be ready to show before the wizard closes (avoids a blank frame).

## 4. Build pipeline

The wizard compiles to `firstrun.js` next to `renderer.js` if your
existing `tsconfig.renderer.json` uses an `include: ["src/renderer/**/*.ts"]`
glob — no changes needed. Verify by running the current renderer build
and checking that `dist/renderer/firstrun.js` appears.

If `tsconfig.renderer.json` pins to `renderer.ts` explicitly, add
`firstrun.ts` to its `files` / `include` array.

The HTML loads the script as `<script type="module" src="./firstrun.js">`,
matching how `index.html` loads `./renderer.js` — same relative-path
convention, same module loading.

## 5. Testing checklist

- [ ] Fresh config (no `firstRunComplete` key) boots into the wizard, not the main capsule.
- [ ] Welcome → Continue animates to the identity screen.
- [ ] Identity: empty email shows inline error; invalid email ("foo") shows inline error; valid email submits.
- [ ] `firstrun:createUser` error path surfaces the error string inline.
- [ ] Mic: grant flow transitions to green state; denial shows the help card + "Check again" button.
- [ ] Hotkey: pressing Ctrl+Space flashes the keycaps green and enables "Got it".
- [ ] First dictation: performing a real dictation auto-advances to screen 6 within ~1 s.
- [ ] "Skip for now" link appears after 30 s if no dictation succeeded.
- [ ] "Start Using" persists `firstRunComplete: true`, closes wizard, opens main window.
- [ ] Next app launch goes straight to the main capsule (wizard not shown).

## 6. Design assumptions

- Wizard window default size: **480x640**, resizable, transparent, frameless.
- Palette, fonts, and radii mirror `src/renderer/styles.css` via locally-prefixed `--fr-*` CSS variables (no global leakage).
- Orange (`#FF8228`) is used sparingly as the "active/breath" accent to match Ambi mode; violet (`#7C3AED`) is the primary CTA.
- No emojis anywhere — consistent with the main UI's minimal tone.
- All animations are subtle (<16 px of motion, 0.3–3.5 s durations) to match the capsule's breathing rhythm.
