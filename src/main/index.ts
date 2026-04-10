import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  Tray,
  globalShortcut,
  nativeImage,
  screen,
  session,
  shell,
} from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, saveConfig } from "./config";

// DEBUG: Log to file so we can see main process output
const logFile = path.join(os.homedir(), ".meetel-flow", "debug.log");
try { fs.mkdirSync(path.dirname(logFile), { recursive: true }); } catch {}
const logStream = fs.createWriteStream(logFile, { flags: "a" });
const origLog = console.log;
const origErr = console.error;
console.log = (...args: unknown[]) => { const msg = args.map(String).join(" "); origLog(msg); logStream.write(new Date().toISOString().slice(11, 19) + " " + msg + "\n"); };
console.error = (...args: unknown[]) => { const msg = args.map(String).join(" "); origErr(msg); logStream.write(new Date().toISOString().slice(11, 19) + " ERR " + msg + "\n"); };
import { insertText } from "./inserter";
import { transcribe } from "./stt";
import { FlowConfig, ViewMode } from "./types";
import { setupAutoUpdates } from "./updater";
import { addUsage, hasMinutesRemaining, getRemainingMinutes, getUsage } from "./usage";
import { pushTranscript } from "./sync";
import { createRoom, joinRoom, leaveRoom, sendTranscript, isConnected, getRoom } from "./ambiverse";
import * as telemetry from "./telemetry";

let mainWindow: BrowserWindow | null = null;
let firstRunWindow: BrowserWindow | null = null;
let firstRunDictationFired = false;
let tray: Tray | null = null;

/* ── Window ── */

const createWindow = async (): Promise<void> => {
  mainWindow = new BrowserWindow({
    width: 360,
    height: 520,
    alwaysOnTop: true,
    frame: false,
    transparent: true,
    resizable: true,
    focusable: false,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  await mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
};

/* ── First-run window ── */

const createFirstRunWindow = (): BrowserWindow => {
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
      nodeIntegration: false,
    },
  });

  void win.loadFile(path.join(__dirname, "../renderer/firstrun.html"));
  win.once("ready-to-show", () => win.show());

  firstRunWindow = win;
  win.on("closed", () => { firstRunWindow = null; });
  return win;
};

/* ── Tray ── */

const createTray = (): void => {
  tray = new Tray(nativeImage.createEmpty());
  tray.setToolTip("Meetel Flow");
  // On macOS, nativeImage.createEmpty() produces a zero-width menu bar item —
  // effectively invisible. Set a title so the tray is actually discoverable
  // until a proper .icns template icon ships in build-resources.
  if (process.platform === "darwin") {
    tray.setTitle("Meetel");
  }
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Show", click: () => mainWindow?.show() },
      { label: "Quit", click: () => app.quit() },
    ])
  );
};

/* ── Hotkeys ── */

const registerHotkeys = (): void => {
  // Use literal "Control+Space" (not CommandOrControl) so it maps to the actual
  // Ctrl key on BOTH Windows AND macOS. This avoids the Cmd+Space conflict with
  // macOS Spotlight while keeping identical muscle memory across platforms.
  const HOTKEY = "Control+Space";
  const toggle = () => {
    telemetry.track("hotkey_fired", { hotkey: HOTKEY });
    mainWindow?.webContents.send("hotkey:toggle");
    // First-run wizard also listens so it can advance on the hotkey teach screen.
    firstRunWindow?.webContents.send("firstrun:hotkeyFired");
  };
  const ok = globalShortcut.register(HOTKEY, toggle);
  if (!ok) {
    console.warn(`[Meetel Flow] Failed to register ${HOTKEY} hotkey — another app may have claimed it`);
  }
};

/* ── App ready ── */

app.whenReady().then(async () => {
  // Initialise telemetry first so every subsequent event is captured.
  const pkg = require("../../package.json") as { version: string };
  // Publishable (anon) key — same one embedded in sync.ts. Safe in client.
  // Service role key must NEVER be placed here.
  const MEETEL_SUPABASE_URL = "https://mclbbkmpovnvcfmwsoqt.supabase.co";
  const MEETEL_SUPABASE_ANON_KEY = "sb_publishable_9L0m_MUyzJsh9gDXZod6MQ_r0UJBWiu";
  telemetry.init({
    appVersion: pkg.version,
    supabaseUrl: MEETEL_SUPABASE_URL,
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY ?? MEETEL_SUPABASE_ANON_KEY,
    debug: !app.isPackaged,
  });
  telemetry.track("app_start", {
    version: pkg.version,
    platform: process.platform,
    os_version: `${os.type()} ${os.release()}`,
  });

  // Grant ALL permissions — this is a desktop dictation app
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(true));
  session.defaultSession.setPermissionCheckHandler(() => true);
  try { session.defaultSession.setDevicePermissionHandler(() => true); } catch { /* Electron <17 */ }

  // IPC: Transcribe audio
  ipcMain.handle("stt:transcribe", async (_e, payload: { audioBase64: string; mimeType: string; durationSeconds: number; wavBase64?: string }) => {
    const t0 = Date.now();
    console.log("[STT] Received audio:", payload.mimeType, payload.durationSeconds + "s", "wav?", !!payload.wavBase64);
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
      const result = await transcribe(cfg, payload.audioBase64, payload.mimeType, payload.durationSeconds, payload.wavBase64);
      console.log("[STT] Result:", result.provider, result.latencyMs + "ms", result.text?.slice(0, 50));
      addUsage(result.durationSeconds);
      pushTranscript(result, cfg.userId);

      // Auto-send to Ambiverse if connected
      if (isConnected() && result.text) {
        sendTranscript(result.text, result.detectedLang || cfg.language);
      }

      telemetry.track("dictation_success", {
        duration_ms: Date.now() - t0,
        word_count: result.text.trim().split(/\s+/).filter(Boolean).length,
        provider: result.provider,
        language: result.detectedLang ?? cfg.language,
      });

      // Fire the first-run "first successful dictation" event exactly once.
      if (firstRunWindow && !firstRunDictationFired) {
        firstRunDictationFired = true;
        firstRunWindow.webContents.send("firstrun:dictationSuccess");
      }

      return { text: result.text, provider: result.provider, detectedLang: result.detectedLang };
    } catch (err) {
      console.error("[STT] FAILED:", err);
      const msg = err instanceof Error ? err.message : "Transcription failed";
      telemetry.track("dictation_failure", {
        duration_ms: Date.now() - t0,
        error_code: "stt_exception",
        error_message: msg,
      });
      return { error: msg };
    }
  });

  // IPC: Insert text at cursor
  ipcMain.handle("stt:insert", async (_e, text: string) => {
    try {
      const cfg = loadConfig();
      console.log("[INSERT] mode:", cfg.targetMode, "text:", text.slice(0, 50));
      await insertText(text, cfg.targetMode);
      return { ok: true };
    } catch (err) {
      console.error("[INSERT] FAILED:", err);
      return { ok: false, error: err instanceof Error ? err.message : "Insert failed" };
    }
  });

  // IPC: Config
  ipcMain.handle("config:get", () => loadConfig());
  ipcMain.handle("config:save", (_e, cfg: Partial<FlowConfig>) => {
    const before = loadConfig();
    saveConfig(cfg);
    for (const key of Object.keys(cfg) as (keyof FlowConfig)[]) {
      const fromVal = before[key];
      const toVal = cfg[key];
      telemetry.track("settings_changed", {
        key: String(key),
        from: (fromVal === undefined ? null : (fromVal as string | number | boolean | null)),
        to: (toVal === undefined ? null : (toVal as string | number | boolean | null)),
      });
    }
    return { ok: true };
  });

  // IPC: Telemetry passthrough (renderer can emit allowlisted events)
  ipcMain.handle(
    "telemetry:track",
    (_e, event: string, payload: Record<string, unknown>) => {
      const allowed = new Set([
        "first_run_start",
        "first_run_complete",
        "mic_permission_result",
        "error",
      ]);
      if (!allowed.has(event)) return { ok: false, error: "disallowed" };
      telemetry.track(
        event as "first_run_start" | "first_run_complete" | "mic_permission_result" | "error",
        payload as never,
      );
      return { ok: true };
    },
  );

  // IPC: First-run wizard
  ipcMain.handle("firstrun:createUser", async (_e, payload: { name: string; email: string }) => {
    try {
      const user = await telemetry.identifyUser(payload.email, payload.name || "");
      if (!user) return { ok: false, error: "Could not create user" };
      saveConfig({
        userId: user.id,
        userEmail: payload.email,
        userName: payload.name || undefined,
        analyticsConsentAt: new Date().toISOString(),
      });
      return { ok: true, userId: user.id };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "unknown" };
    }
  });

  ipcMain.handle("firstrun:requestMicPermission", async () => {
    try {
      if (process.platform === "darwin") {
        const { systemPreferences } = require("electron") as typeof import("electron");
        const granted = await systemPreferences.askForMediaAccess("microphone");
        telemetry.track("mic_permission_result", { granted });
        return { granted };
      }
      // Windows/Linux: permission is granted on first getUserMedia in the renderer.
      // The wizard will do its own probe; we just report optimistic true here.
      telemetry.track("mic_permission_result", { granted: true });
      return { granted: true };
    } catch (err) {
      telemetry.track("mic_permission_result", { granted: false });
      return { granted: false, error: err instanceof Error ? err.message : "unknown" };
    }
  });

  ipcMain.handle("firstrun:testHotkey", () =>
    new Promise<{ detected: boolean }>((resolve) => {
      const listener = () => {
        firstRunWindow?.webContents.off("ipc-message", listener);
        resolve({ detected: true });
      };
      // Resolve the first time the hotkey fires (the hotkey toggle closure
      // already sends "firstrun:hotkeyFired" to the wizard window).
      const timeout = setTimeout(() => resolve({ detected: false }), 120_000);
      const bridge = () => {
        clearTimeout(timeout);
        resolve({ detected: true });
      };
      // Register a one-shot listener on ipcMain.
      const channel = "firstrun:hotkeyFiredAck";
      ipcMain.once(channel, bridge);
      // Also resolve on a direct renderer-side ping if the wizard forwards it.
      firstRunWindow?.webContents.once("did-finish-load", () => {
        // no-op; just ensures the window is alive while we wait.
      });
    }),
  );

  ipcMain.handle("firstrun:skipFirstDictation", () => {
    saveConfig({ firstDictationSkipped: true });
    return { ok: true };
  });

  ipcMain.handle("firstrun:markComplete", async () => {
    saveConfig({ firstRunComplete: true });
    telemetry.track("first_run_complete", { duration_ms: 0 });
    const toClose = firstRunWindow;
    firstRunWindow = null;
    await createWindow();
    createTray();
    registerHotkeys();
    if (toClose && !toClose.isDestroyed()) toClose.close();
    return { ok: true };
  });

  // IPC: Usage
  ipcMain.handle("usage:get", () => {
    const u = getUsage();
    return { minutesUsed: u.minutesUsed, minutesRemaining: getRemainingMinutes(), limit: u.limit };
  });

  // IPC: Open external URL (for upgrade links)
  ipcMain.handle("shell:openExternal", (_e, url: string) => {
    if (url.startsWith("https://")) shell.openExternal(url);
  });

  // IPC: Window opacity (for idle fade)
  ipcMain.handle("window:setOpacity", (_e, opacity: number) => {
    mainWindow?.setOpacity(Math.max(0.05, Math.min(1, opacity)));
  });

  // IPC: Toggle focusable (unfocusable = clicking doesn't steal focus from other apps)
  ipcMain.handle("window:setFocusable", (_e, focusable: boolean) => {
    mainWindow?.setFocusable(focusable);
    if (!focusable) mainWindow?.blur();
  });

  // IPC: View mode switching
  ipcMain.handle("window:setMode", (_e, mode: string, side?: string) => {
    if (!mainWindow) return;
    const display = screen.getPrimaryDisplay();
    const { width: screenW, height: screenH } = display.workAreaSize;
    const { x: workX, y: workY } = display.workArea;

    switch (mode) {
      case "panel": {
        const panelW = 360;
        const x = side === "left" ? workX : (workX + screenW - panelW);
        mainWindow.setResizable(true);
        mainWindow.setBounds({ x, y: workY, width: panelW, height: screenH });
        break;
      }
      case "island": {
        const islandW = 300;
        const islandH = 64;
        const x = workX + Math.round((screenW - islandW) / 2);
        mainWindow.setBounds({ x, y: workY + 8, width: islandW, height: islandH });
        mainWindow.setResizable(false);
        break;
      }
      case "compact": {
        const compactW = 360;
        const compactH = 520;
        const cx = workX + screenW - compactW - 40;
        const cy = workY + Math.round((screenH - compactH) / 2);
        mainWindow.setResizable(true);
        mainWindow.setBounds({ x: cx, y: cy, width: compactW, height: compactH });
        break;
      }
      // default = no-op
    }

    saveConfig({ viewMode: mode as ViewMode, panelSide: (side || "right") as any });
    return { ok: true };
  });

  // IPC: Toggle fullscreen (maximize for frameless windows)
  ipcMain.handle("window:toggleFullscreen", () => {
    if (!mainWindow) return;
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow.maximize();
    }
    return { fullscreen: mainWindow.isMaximized() };
  });

  // IPC: Ambiverse
  ipcMain.handle("ambiverse:create", (_e, myLang: string) => {
    const cfg = loadConfig();
    const room = createRoom(myLang, cfg.groqApiKey, (data) => {
      mainWindow?.webContents.send("ambiverse:received", data);
    });
    return { room };
  });

  ipcMain.handle("ambiverse:join", (_e, room: string, myLang: string) => {
    const cfg = loadConfig();
    joinRoom(room, myLang, cfg.groqApiKey, (data) => {
      mainWindow?.webContents.send("ambiverse:received", data);
    });
    return { ok: true };
  });

  ipcMain.handle("ambiverse:leave", () => {
    leaveRoom();
    return { ok: true };
  });

  ipcMain.handle("ambiverse:send", (_e, text: string, lang: string) => {
    sendTranscript(text, lang);
    return { ok: true };
  });

  ipcMain.handle("ambiverse:status", () => {
    return { connected: isConnected(), room: getRoom() };
  });

  // Boot decision: first-run wizard OR main capsule
  const initialCfg = loadConfig();
  if (!initialCfg.firstRunComplete) {
    telemetry.track("first_run_start", {});
    createFirstRunWindow();
    // Tray and hotkey still register so the wizard can teach the hotkey.
    createTray();
    registerHotkeys();
  } else {
    await createWindow();
    createTray();
    registerHotkeys();
  }
  setupAutoUpdates();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", (e) => {
  if (!telemetry.__internal.isInitialised()) return;
  e.preventDefault();
  telemetry
    .shutdown()
    .catch(() => { /* best effort */ })
    .finally(() => setImmediate(() => app.exit(0)));
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  void telemetry.flush();
});
