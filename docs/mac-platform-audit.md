# Meetel Flow — macOS Cross-Platform Readiness Audit

**Date**: 2026-04-10
**Auditor**: ZION SYNAPSE
**Scope**: `/home/dash/meetel-flow` at HEAD
**Goal**: Ship a clean macOS build for the first user cohort

---

## Executive Summary — Top 5 Mac Blockers (Prioritized)

| # | Severity | Blocker | Impact |
|---|---|---|---|
| 1 | **CRITICAL** | `package.json` has **no `build.mac` block** and no `entitlements.mac.plist` was referenced. `dist:mac` will produce an unsigned, unnotarized DMG missing `Info.plist` usage descriptions. On Catalina+ the app cannot access the mic, cannot keystroke, and launches to a "damaged" Gatekeeper error. | Hard-block: app is unusable on macOS. |
| 2 | **CRITICAL** | `inserter.ts:28` uses `osascript ... System Events keystroke` to type text. This requires **Accessibility permission** + **Apple Events permission**. Neither is requested in code, neither is declared in Info.plist, and there is no `systemPreferences.isTrustedAccessibilityClient()` probe to detect/explain the missing permission. First-run users will experience "it records but nothing gets typed." | Silent failure: the app appears broken. |
| 3 | **HIGH** | Default hotkey is `CommandOrControl+Space` (`index.ts:76`) which on macOS resolves to **`Cmd+Space`** — the system-wide Spotlight shortcut. `globalShortcut.register()` will return `false`, the hotkey silently fails, and `registerHotkeys()` only emits a `console.warn` (`index.ts:78`) with no user-visible surfacing. | User cannot toggle dictation at all. |
| 4 | **HIGH** | `BrowserWindow` is created with `frame: false` + `transparent: true` + `focusable: false` + `skipTaskbar: true` (`index.ts:43–48`). On macOS, the combination of `transparent: true` with `alwaysOnTop: true` behaves differently: the window can get stuck behind fullscreen apps unless `setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })` is called. `skipTaskbar` is a Windows-only concept; the Mac equivalent is `LSUIElement = true` in Info.plist, which is currently absent. | Window visibility bugs; dock icon appears when it shouldn't. |
| 5 | **HIGH** | **No icon assets exist.** `build-resources/` contains only `README.md`. There is no `icon.icns`, no `icon.ico`, no `icon.png`, no `@2x`/`@3x` Retina variants. `tray = new Tray(nativeImage.createEmpty())` (`index.ts:62`) creates an **empty** tray icon, which on macOS renders as a tiny invisible square in the menu bar — users won't know the app is running. | Tray/menu-bar entry point is effectively invisible. |

---

## Per-File Findings

### `src/main/index.ts`

| Line | Finding | Mac Behavior | Fix |
|---|---|---|---|
| 43–54 | `BrowserWindow` options: `alwaysOnTop: true`, `frame: false`, `transparent: true`, `focusable: false`, `skipTaskbar: true` | `skipTaskbar` is a no-op on macOS. `transparent: true` + `alwaysOnTop: true` can cause the window to disappear when another app enters fullscreen. Frameless transparent windows on Mac sometimes need `vibrancy: 'under-window'` or `visualEffectState: 'active'` to look correct against the blurred wallpaper. | Add `setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })` and `setAlwaysOnTop(true, 'floating')` in a Mac-only branch. Add `LSUIElement = true` in Info.plist (see `Info.plist.additions.md`) to replicate `skipTaskbar`. (Not done in this audit — no main-process edits allowed.) |
| 62 | `tray = new Tray(nativeImage.createEmpty())` | On macOS, empty `nativeImage` renders as a 0-pixel menu bar icon. User sees nothing. macOS menu bar icons must be **template images** (`setTemplateImage(true)`) so they invert correctly in dark/light mode. Required resolutions: 16×16, 32×32 (`@2x`). | Create `build-resources/iconTemplate.png` (16×16) and `iconTemplate@2x.png` (32×32). In a Mac branch, `Tray(path.join(__dirname, '../../build-resources/iconTemplate.png'))` then `tray.setTemplateImage(true)`. |
| 76 | `globalShortcut.register("CommandOrControl+Space", toggle)` | Resolves to `Cmd+Space` on macOS which is **claimed by Spotlight**. `register()` returns `false`. | Either (a) change default to `CommandOrControl+Shift+Space` cross-platform, or (b) detect `process.platform === 'darwin'` and register `Option+Space`. Probe `globalShortcut.isRegistered()` before/after and surface failure to the renderer via IPC, not just `console.warn`. |
| 78 | `console.warn(... "Failed to register ... hotkey")` | On Mac this will hit **every** first launch because of the Spotlight conflict. Users will never see it — it only lands in `~/.meetel-flow/debug.log`. | Expose hotkey registration state via IPC so the renderer can show an in-app error. |
| 84–88 | `session.defaultSession.setPermissionRequestHandler(... cb(true))` + `setDevicePermissionHandler(() => true)` | These handlers grant the **Chromium-level** permission. They do **not** grant the **OS-level** macOS TCC permission. On macOS, even with these handlers, `getUserMedia` will still trigger the system mic permission dialog on first call, AND will fail silently if `NSMicrophoneUsageDescription` is missing from Info.plist. | `NSMicrophoneUsageDescription` must be set (see `Info.plist.additions.md`). Optionally, add `systemPreferences.askForMediaAccess('microphone')` on app-ready to proactively trigger the prompt. |
| 91–113 | `ipcMain.handle("stt:transcribe", ...)` | Platform-agnostic (HTTP). ✓ | None. |
| 116–126 | `ipcMain.handle("stt:insert", ...)` → `insertText` | Downstream call delegates to `inserter.ts`, which is where the Mac-specific issue lives. | See `inserter.ts` findings below. |
| 147–149 | `mainWindow?.setOpacity(...)` | Works on macOS but **ignored** when `transparent: true` is set on some macOS versions. The idle-fade behavior may not visually work on Mac. | Test manually; if broken, use CSS `opacity` on `body` instead. |
| 152–155 | `setFocusable(false)` | On macOS, `setFocusable(false)` is implemented but behaves differently from Windows: the window still appears in the Cmd+Tab list and can receive clicks. The "clicking doesn't steal focus" guarantee only holds on Windows. | Consider `mainWindow.setIgnoreMouseEvents(true, { forward: true })` on Mac for true click-through. |
| 197–205 | `mainWindow?.maximize()` for fullscreen toggle | On macOS, frameless windows don't have the native "maximize" concept. `maximize()` may not fill the screen properly and won't use the native fullscreen animation. | Use `setFullScreen(true)` on Mac instead of `maximize()`. |
| 245 | `if (process.platform !== "darwin") app.quit()` | ✓ Correct Mac behavior (apps stay alive when windows close on Mac). | None. |

### `src/main/inserter.ts`

| Line | Finding | Fix |
|---|---|---|
| 26–30 | `typeOnMac` uses `osascript -e 'tell application "System Events" to keystroke "..."` | This **requires Accessibility permission granted to Meetel Flow in System Settings → Privacy & Security → Accessibility**. The code does not check for it, does not request it, and does not surface a "please enable Accessibility" error. If the permission is missing, `osascript` exits with `-1743` and the error surfaces as `{ok: false, error: "..."}` via IPC — but the renderer shows a generic "Insert failed" message. |
| 27 | Escaping only handles `\` and `"` | AppleScript `keystroke` drops accented characters **with dead-key composition issues**. Emojis, multi-byte characters, and newlines (`\n`) break. Newlines in particular trigger the Return key, which in most apps submits the form instead of adding a newline. |
| 26 | No fallback for clipboard-mode paste on Mac | On Windows, `typeOnWindows` uses clipboard + `Ctrl+V` — this is actually the **better** strategy for Unicode. The Mac branch does NOT use this clipboard+paste strategy even though AppleScript has the same Unicode limitations. |
| All | No robotjs / nut.js / @nut-tree dependency | Good — avoids native module build pain. Pure `osascript` is the right call. But the implementation needs the clipboard+Cmd+V strategy on Mac for parity with Windows. |

**Recommended Mac insertion strategy** (when main-process edits are allowed):

```typescript
const typeOnMac = async (text: string): Promise<void> => {
  const prev = clipboard.readText();
  clipboard.writeText(text);
  // Use keystroke "v" using command down — handles all Unicode
  const script = `delay 0.08
tell application "System Events" to keystroke "v" using command down`;
  await run("osascript", ["-e", script]);
  setTimeout(() => clipboard.writeText(prev), 500);
};
```

This matches the Windows strategy, supports all Unicode, and only requires the one "Accessibility" permission (still no Apple Events needed if you avoid `tell application "XYZ"`).

### `src/main/stt.ts`

| Line | Finding | Status |
|---|---|
| 1–122 | Groq HTTPS call, `multipart/form-data` built by hand with `Buffer`, `https.request` | Platform-agnostic. ✓ |
| 126–168 | Local whisper.cpp fallback at `~/.meetel-flow/whisper/whisper-cli.exe` | **BROKEN on Mac**: the binary name is hardcoded to `whisper-cli.exe`. On macOS the binary is typically `whisper-cli` (no extension) or `main`. `isWhisperInstalled()` will always return `false` on Mac, so the local fallback is silently unavailable. |
| 133 | `transcribeLocal` spawns `execFile(WHISPER_EXE, ...)` | Even if the path were correct, the CPU flag `-t 4` is fine on Mac. No other Mac-specific issues. |
| 419–462 | Gemini HTTPS call | Platform-agnostic. ✓ |

**Recommendation**: In the Mac audit report note that local whisper fallback is effectively disabled on Mac. For the first cohort, Groq-only is acceptable. Fix with a platform branch later:

```typescript
const WHISPER_EXE = path.join(
  WHISPER_DIR,
  process.platform === "win32" ? "whisper-cli.exe" : "whisper-cli"
);
```

### `src/main/preload.ts`

Pure `contextBridge.exposeInMainWorld` + `ipcRenderer.invoke` wiring. **No Node APIs used directly, no filesystem, no platform-specific calls.** ✓ Platform-agnostic.

### `src/renderer/renderer.ts`

| Line | Finding | Mac Behavior |
|---|---|---|
| 31 | `let audioCtx: AudioContext | null = null;` | Standard Web Audio. Works identically on Mac. ✓ |
| 336–344 | `navigator.mediaDevices.getUserMedia` with `echoCancellation`, `noiseSuppression`, `sampleRate: 16000` | Works on Mac, but: (1) the `sampleRate` constraint is **ignored by Chromium on macOS** — the AudioContext will be created at the device's native sample rate (usually 48000) and the code at line 346 will silently downsample. The WAV writer at line 287+ assumes 16000. This is a **real bug on Mac**: the emitted WAV file will have a 16000 header but 48000 samples, producing chipmunk voice at 3x speed in Groq. |
| 346 | `audioCtx = new AudioContext({ sampleRate: SAMPLE_RATE })` | Modern Chromium DOES honor this hint. ✓ But browsers may refuse if the hardware can't resample — needs testing on M1/M2 hardware. |
| 350 | `audioCtx.createScriptProcessor(4096, 1, 1)` | **Deprecated API**. Works on Mac but will emit a deprecation warning in the DevTools console. Not a blocker for shipping. Modern replacement: `AudioWorkletNode`. |
| 545–555 | `testStream = navigator.mediaDevices.getUserMedia({audio: true})` + `testCtx = new AudioContext()` | Same Mac considerations as above. ✓ |
| 647 | Mic enumeration via `getUserMedia` then `enumerateDevices()` | Works on Mac but **requires mic permission first** (Mac hides device labels until permission is granted). ✓ — the code already gets permission before enumeration. |
| 806 | `navigator.clipboard.writeText(text)` | Works on Mac but requires the window to have focus. Given `focusable: false`, this may fail silently on Mac. Test carefully. |
| 1026 | `widget.addEventListener("pointerdown", ...)` with double-tap fullscreen | **Conflict on Mac**: double-clicking a frameless window's drag region is a system gesture to minimize/zoom the window. Electron intercepts this, so should work, but test on macOS 14+. |

**Critical bug to verify**: Sample rate mismatch at `renderer.ts:346` + `renderer.ts:287` (WAV writer). If Mac records at 48kHz while the WAV header declares 16kHz, Groq transcription will be garbage. **Must test first.**

### `src/renderer/styles.css`

| Line | Finding | Status |
|---|---|
| 31 | `font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif` | ✓ Mac-first font stack. Will pick up San Francisco on Mac. |
| 36, 48, 63, etc. | `-webkit-app-region: drag` / `no-drag` | ✓ Works on Mac (Electron uses Chromium's WebKit fork). |
| 386, 793, 800, 1105 | `backdrop-filter: blur(...)` + `-webkit-backdrop-filter` | ✓ Works on Mac. Actually renders **better** on Mac than Windows (macOS has hardware-accelerated background blur). |
| 911, 943 | `font-family: monospace` | ✓ Portable. |

No Mac CSS issues. ✓

### `build-resources/`

**Current state**:
```
build-resources/
└── README.md
```

**Missing**:
- `icon.ico` (Windows — placeholder for `dist:win`)
- `icon.icns` (Mac — required for DMG app icon)
- `icon.png` 512×512 (Linux AppImage + source for other formats)
- `iconTemplate.png` 16×16 (Mac menu bar, template image)
- `iconTemplate@2x.png` 32×32 (Mac Retina menu bar)
- `background.png` 540×380 (DMG background — optional but professional)
- `entitlements.mac.plist` ← **created by this audit**

### `README.md`

Current notes on Mac are a single line (`insertion mode type (Windows/macOS)`). No mention of permissions, notarization, Apple Developer ID, or Gatekeeper workarounds. Needs an update, but not in this audit pass.

---

## Permission Model (macOS)

Meetel Flow needs **three** distinct TCC (Transparency, Consent, Control) permissions on macOS. All three must be granted by the user — macOS does not allow apps to grant them programmatically.

| Permission | Why Meetel Flow needs it | How user grants it | System Settings path |
|---|---|---|---|
| **Microphone** | `navigator.mediaDevices.getUserMedia` in `renderer.ts:336` | macOS shows a system dialog on first call. User clicks "Allow". | System Settings → Privacy & Security → Microphone → toggle "Meetel Flow" on |
| **Accessibility** | `osascript` keystroke in `inserter.ts:28`. Without this, AppleScript `keystroke` silently no-ops. | macOS shows a dialog the first time `osascript` runs keystroke. User must click "Open System Settings" and toggle Meetel Flow on. | System Settings → Privacy & Security → Accessibility → toggle "Meetel Flow" on |
| **Automation (Apple Events)** | `tell application "System Events"` in `inserter.ts:28` | macOS shows a dialog on first call: "Meetel Flow wants to control System Events". User clicks "OK". | System Settings → Privacy & Security → Automation → expand "Meetel Flow" → enable "System Events" |

**Important**: These prompts ONLY appear if the corresponding Info.plist usage description is set. Without `NSMicrophoneUsageDescription`, `NSAccessibilityUsageDescription`, and `NSAppleEventsUsageDescription`, macOS **silently denies** the permission. This is the #1 cause of "the Mac build doesn't work" bugs.

---

## Build Config Changes Needed

See `/home/dash/meetel-flow/build-resources/Info.plist.additions.md` for the exact JSON block to add to `package.json` → `build`.

Summary of required additions:

1. **`build.mac.target`**: `[{target: "dmg", arch: ["x64", "arm64"]}, {target: "zip", ["x64", "arm64"]}]` — dual-arch for M-series + Intel.
2. **`build.mac.hardenedRuntime`**: `true` — required for notarization.
3. **`build.mac.entitlements`**: `"build-resources/entitlements.mac.plist"` — points at the file created by this audit.
4. **`build.mac.entitlementsInherit`**: same file — child helper processes (GPU, renderer, utility) inherit the same entitlements.
5. **`build.mac.extendInfo`**: merges usage descriptions, `LSUIElement`, `NSHighResolutionCapable`, `LSMinimumSystemVersion` into the generated `Info.plist`.
6. **`build.mac.icon`**: `"build-resources/icon.icns"` — must be created.
7. **`build.mac.category`**: `"public.app-category.productivity"` — required for Mac App Store (irrelevant for direct DMG distribution, but good hygiene).
8. **`build.dmg`**: optional DMG layout and background.
9. **`build.afterSign`**: `"build-resources/notarize.js"` — hooks in `@electron/notarize` when Apple Developer ID is available.

---

## Retina Asset Gaps

| Asset | Required Sizes | Status |
|---|---|---|
| App icon (`.icns`) | Multi-resolution: 16, 32, 64, 128, 256, 512, 1024 + @2x variants. Generate with `iconutil` or `electron-icon-maker`. | **MISSING** |
| Menu bar tray icon | `iconTemplate.png` 16×16 + `iconTemplate@2x.png` 32×32. **Must be a template image** (monochrome with alpha). | **MISSING** |
| DMG background (optional) | `background.png` 540×380 + `background@2x.png` 1080×760 | **MISSING** |
| Windows `.ico` | Multi-res 16/32/48/64/128/256 | **MISSING** (also blocks Windows release quality) |
| Linux `.png` | 512×512 | **MISSING** |

**Recommendation**: Start with a 1024×1024 square PNG source. Use:
```
npx electron-icon-maker --input=source.png --output=build-resources
```
Then manually create `iconTemplate.png` + `iconTemplate@2x.png` from a monochrome version of the logo.

---

## Hotkey Compatibility

`index.ts:76` registers `CommandOrControl+Space`.

| Platform | Resolves to | Conflict |
|---|---|---|
| Windows | `Ctrl+Space` | IME toggle in some languages; otherwise free |
| macOS | `Cmd+Space` | **Spotlight — system-wide conflict** |

On macOS, `globalShortcut.register("CommandOrControl+Space", ...)` returns `false` because Spotlight has a stronger claim. The app falls through to `console.warn` (`index.ts:78`) and the hotkey simply doesn't work — there is no user-visible notification.

**Options** (choose one):

1. **Change the default cross-platform** to `CommandOrControl+Shift+Space`. This conflicts with nothing on either OS and is only one extra key. *Recommended for first cohort.*
2. **Platform branch**: use `Ctrl+Space` on Windows and `Option+Space` (`Alt+Space`) on Mac. `Alt+Space` on Windows opens the window menu, so this needs to be platform-specific.
3. **Keep default + document Spotlight remap**: tell users to change Spotlight to `Cmd+Option+Space` in System Settings → Keyboard → Keyboard Shortcuts → Spotlight. Documented in `docs/mac-user-permissions-guide.md`, but this asks the user to change a system shortcut they use daily — high friction.

**Additional requirement**: Whatever the default is, surface `globalShortcut.register()` failure via IPC so the renderer can show an in-app banner: "Hotkey Cmd+Space is taken — change it in settings." Currently failures only reach `console.warn`.

---

## Code Signing & Notarization Path

To ship a DMG that opens cleanly on macOS (no "damaged" dialog, no Gatekeeper warning), the following is required:

| Step | Cost | Time |
|---|---|---|
| 1. Enroll in Apple Developer Program | **$99/year** | 24–48 hours for enrollment approval. Requires Apple ID + credit card + (for organizations) DUNS number. |
| 2. Create "Developer ID Application" certificate in Apple Developer portal | $0 | 10 minutes |
| 3. Download cert, install in macOS Keychain **on a real Mac** (cannot be done from WSL/Linux) | $0 | 10 minutes |
| 4. Generate app-specific password at appleid.apple.com | $0 | 2 minutes |
| 5. Wire `@electron/notarize` via `afterSign` hook | $0 | 30 minutes |
| 6. Set env vars: `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | $0 | 1 minute |
| 7. Run `npm run dist:mac` — electron-builder signs, then `afterSign` uploads to Apple for notarization (5–15 min wait) | $0 | 5–15 min per build |
| 8. Staple the notarization ticket: `xcrun stapler staple "dist/Meetel Flow-0.1.0.dmg"` | $0 | 30 seconds |

**Blocker for Dash**: Steps 1–3 require:
- A **credit card** for Apple Developer enrollment ($99 USD/year)
- A **real Mac** to install the signing certificate (WSL/Linux cannot hold signing keys in Keychain)

**Recommended path for first cohort**:
1. Ship an **unsigned** DMG for the first 5 users.
2. Document the Gatekeeper workaround (`xattr -d com.apple.quarantine "/Applications/Meetel Flow.app"` — see user guide).
3. Enroll in Apple Developer Program in parallel.
4. Ship a signed + notarized DMG for users 6+.

---

## Testing Checklist (Manual, on a Mac)

Ordered. Stop at the first failure, fix, restart.

### Phase 1: Build & Launch
- [ ] `npm install` completes without native-module compile errors.
- [ ] `npm run build` produces `dist/main/index.js` and `dist/renderer/index.html`.
- [ ] `npm run dist:mac` produces a DMG in `dist/`.
- [ ] DMG opens. App is draggable to `/Applications`.
- [ ] Launch app from `/Applications`. If "damaged" error: `xattr -d com.apple.quarantine /Applications/Meetel\ Flow.app`.

### Phase 2: Permissions & Visibility
- [ ] On first launch, macOS shows mic permission dialog. Click Allow.
- [ ] Verify System Settings → Privacy & Security → Microphone shows "Meetel Flow" enabled.
- [ ] Menu bar tray icon is visible (should be the Meetel template icon, not an empty box).
- [ ] Tray right-click → "Show" opens the widget.
- [ ] Tray right-click → "Quit" quits the app.
- [ ] Dock does NOT show Meetel Flow (confirms `LSUIElement` is working).

### Phase 3: Window Behavior
- [ ] Widget appears on the right edge of the screen (default `panelSide: "right"`).
- [ ] Widget is always on top, even when another app is frontmost.
- [ ] Clicking the widget does NOT steal focus from the other app (test: open TextEdit, click widget, verify TextEdit is still frontmost).
- [ ] Dragging the widget title bar moves it.
- [ ] Double-click toggles fullscreen. (If broken, fall back to maximize.)
- [ ] Long-press panel toggle switches to island mode.
- [ ] Switch to a fullscreen app (e.g., Safari fullscreen). Verify widget is still visible (requires `setVisibleOnAllWorkspaces(true, {visibleOnFullScreen: true})`).

### Phase 4: Hotkey
- [ ] Press the default hotkey. **Expected failure** on Mac unless hotkey was changed (see §"Hotkey Compatibility"). Open `~/.meetel-flow/debug.log` and verify the `Failed to register` warning fires.
- [ ] Change hotkey in settings (if renderer supports it) to `CommandOrControl+Shift+Space`. Verify toggle works.

### Phase 5: Dictation
- [ ] Press hotkey → widget enters listening state → speak for 5 seconds → press hotkey again.
- [ ] Check `~/.meetel-flow/stt.log` for `[STT] START` + `[GROQ] Status: 200` + detected language.
- [ ] Verify the transcribed text **matches what was said** (NOT chipmunked). If voice sounds sped up or text is scrambled, the sample-rate bug at `renderer.ts:346` is real on Mac — needs fix.
- [ ] Test with French speech + French language setting. Verify accents are correct.

### Phase 6: Insertion
- [ ] Open TextEdit. Place cursor in a document.
- [ ] Click widget (should not steal focus), then speak, then press hotkey.
- [ ] **Expected first-time behavior**: macOS shows "Meetel Flow wants to control System Events" + "Meetel Flow wants to control your computer using accessibility features" dialogs. Click OK / Open System Settings → enable.
- [ ] Retry dictation. Verify text appears in TextEdit.
- [ ] Test with accented characters (type "café, naïve, résumé"). Verify they render correctly.
- [ ] Test with newline voice command ("new line"). Verify newline is inserted, not Return-submit.
- [ ] Test in Chrome address bar. Verify insertion works across apps.
- [ ] Test in Slack / Discord / ChatGPT web. Verify insertion works.

### Phase 7: Idle / Background
- [ ] Leave widget idle for 30 seconds. Verify opacity fades (if idle fade is working on Mac).
- [ ] Click the widget. Verify it wakes up.
- [ ] Put Mac to sleep for 2 minutes. Wake. Verify the hotkey still works and the widget is still visible.

### Phase 8: Polish
- [ ] Verify Retina rendering: UI should be crisp on M-series / Retina display (no blurry text).
- [ ] Verify dark mode: widget looks good against dark wallpaper.
- [ ] Verify light mode: widget looks good against light wallpaper.
- [ ] Run the app for 10 minutes of real dictation work. Note any glitches in a file and report.

---

## Open Questions / Unknowns

1. **Sample rate on Mac**: does Chromium honor `AudioContext({ sampleRate: 16000 })` on M-series hardware, or does it fall back to 48000? Needs empirical test — it's the single biggest hidden-bug risk.
2. **`transparent: true` + `alwaysOnTop: true` in fullscreen**: needs testing on macOS 14+ to confirm the widget stays visible over fullscreen apps.
3. **`setOpacity` with `transparent: true`**: some Electron versions ignore opacity changes when the window is already transparent. Needs test.
4. **Local whisper.cpp fallback**: Mac binary path is hardcoded to `.exe` in `stt.ts:127`. This audit flags it but doesn't fix it (no main-process edits allowed). For the first cohort, Groq-only is acceptable.
5. **Apple Developer enrollment lead time**: typically 24–48 hours but can be longer if Apple's fraud review flags the application.
