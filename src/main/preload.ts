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
});
