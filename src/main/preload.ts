import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("meetelFlow", {
  transcribe: (audioBase64: string, mimeType: string, durationSeconds: number, wavBase64?: string) =>
    ipcRenderer.invoke("stt:transcribe", { audioBase64, mimeType, durationSeconds, wavBase64 }),

  insertText: (text: string) =>
    ipcRenderer.invoke("stt:insert", text),

  getConfig: () => ipcRenderer.invoke("config:get"),
  saveConfig: (cfg: Record<string, unknown>) => ipcRenderer.invoke("config:save", cfg),

  getUsage: () => ipcRenderer.invoke("usage:get"),

  setOpacity: (opacity: number) => ipcRenderer.invoke("window:setOpacity", opacity),

  setFocusable: (focusable: boolean) => ipcRenderer.invoke("window:setFocusable", focusable),

  setWindowMode: (mode: string, side?: string) =>
    ipcRenderer.invoke("window:setMode", mode, side),

  toggleFullscreen: () => ipcRenderer.invoke("window:toggleFullscreen"),

  openExternal: (url: string) => ipcRenderer.invoke("shell:openExternal", url),

  onHotkeyToggle: (cb: () => void) => {
    ipcRenderer.on("hotkey:toggle", () => cb());
  },

  // Ambiverse
  ambiverseCreate: (myLang: string) => ipcRenderer.invoke("ambiverse:create", myLang),
  ambiverseJoin: (room: string, myLang: string) => ipcRenderer.invoke("ambiverse:join", room, myLang),
  ambiverseLeave: () => ipcRenderer.invoke("ambiverse:leave"),
  ambiverseSend: (text: string, lang: string) => ipcRenderer.invoke("ambiverse:send", text, lang),
  ambiverseStatus: () => ipcRenderer.invoke("ambiverse:status"),
  onAmbiverseReceived: (cb: (data: { text: string; translated: string; fromLang: string }) => void) => {
    ipcRenderer.on("ambiverse:received", (_e, data) => cb(data));
  },

  // Telemetry (allowlisted events only — main process validates)
  trackEvent: (event: string, payload: Record<string, unknown>) =>
    ipcRenderer.invoke("telemetry:track", event, payload),
});

// First-run wizard bridge — separate namespace so it cannot collide with meetelFlow
contextBridge.exposeInMainWorld("meetelFirstRun", {
  createUser: (payload: { name: string; email: string }) =>
    ipcRenderer.invoke("firstrun:createUser", payload),

  requestMicPermission: () =>
    ipcRenderer.invoke("firstrun:requestMicPermission"),

  // Temporarily releases the global Control+Space shortcut so the wizard's
  // in-window keydown listener can detect the chord directly during screen 4.
  armHotkeyTeach: () => ipcRenderer.invoke("firstrun:armHotkeyTeach"),
  disarmHotkeyTeach: () => ipcRenderer.invoke("firstrun:disarmHotkeyTeach"),

  skipFirstDictation: () =>
    ipcRenderer.invoke("firstrun:skipFirstDictation"),

  markComplete: () =>
    ipcRenderer.invoke("firstrun:markComplete"),

  onDictationSuccess: (cb: () => void) => {
    ipcRenderer.on("firstrun:dictationSuccess", () => cb());
  },

  // Backup path: also fires when the global Control+Space hotkey is detected
  // by the main process. Used when the wizard is NOT focused (so in-window
  // keydown wouldn't catch it anyway).
  onHotkeyFired: (cb: () => void) => {
    ipcRenderer.on("firstrun:hotkeyFired", () => cb());
  },
});
