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
import path from "node:path";
import { loadConfig, saveConfig } from "./config";
import { insertText } from "./inserter";
import { transcribe } from "./stt";
import { FlowConfig, ViewMode } from "./types";
import { setupAutoUpdates } from "./updater";
import { addUsage, hasMinutesRemaining, getRemainingMinutes, getUsage } from "./usage";
import { pushTranscript } from "./sync";

let mainWindow: BrowserWindow | null = null;
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

/* ── Tray ── */

const createTray = (): void => {
  tray = new Tray(nativeImage.createEmpty());
  tray.setToolTip("Meetel Flow");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Show", click: () => mainWindow?.show() },
      { label: "Quit", click: () => app.quit() },
    ])
  );
};

/* ── Hotkeys ── */

const registerHotkeys = (): void => {
  const toggle = () => mainWindow?.webContents.send("hotkey:toggle");
  globalShortcut.register("Control+Space", toggle);
  globalShortcut.register("Shift+Space", toggle);
};

/* ── App ready ── */

app.whenReady().then(async () => {
  // Grant ALL permissions — this is a desktop dictation app
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(true));
  session.defaultSession.setPermissionCheckHandler(() => true);
  try { session.defaultSession.setDevicePermissionHandler(() => true); } catch { /* Electron <17 */ }

  // IPC: Transcribe audio
  ipcMain.handle("stt:transcribe", async (_e, payload: { audioBase64: string; mimeType: string; durationSeconds: number; wavBase64?: string }) => {
    console.log("[STT] Received audio:", payload.mimeType, payload.durationSeconds + "s", "wav?", !!payload.wavBase64);
    if (!hasMinutesRemaining()) {
      return { error: "Free limit reached. Subscribe to Meetel for unlimited." };
    }
    try {
      const cfg = loadConfig();
      const result = await transcribe(cfg, payload.audioBase64, payload.mimeType, payload.durationSeconds, payload.wavBase64);
      console.log("[STT] Result:", result.provider, result.latencyMs + "ms", result.text?.slice(0, 50));
      addUsage(result.durationSeconds);
      pushTranscript(result, cfg.userId);
      return { text: result.text, provider: result.provider };
    } catch (err) {
      console.error("[STT] FAILED:", err);
      return { error: err instanceof Error ? err.message : "Transcription failed" };
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
    saveConfig(cfg);
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
        const islandW = 260;
        const islandH = 52;
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

  await createWindow();
  createTray();
  registerHotkeys();
  setupAutoUpdates();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
});
