import { clipboard } from "electron";
import { execFile } from "node:child_process";

const run = (cmd: string, args: string[]): Promise<void> =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });

const typeOnWindows = async (text: string): Promise<void> => {
  // SendKeys can't handle Unicode/accented chars (é, è, ç, à get stripped)
  // Use clipboard + Ctrl+V instead — works for ALL characters
  const prev = clipboard.readText();
  clipboard.writeText(text);
  const script = `Add-Type -AssemblyName System.Windows.Forms; Start-Sleep -Milliseconds 80; [System.Windows.Forms.SendKeys]::SendWait('^v')`;
  await run("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script]);
  // Restore previous clipboard after a short delay
  setTimeout(() => clipboard.writeText(prev), 500);
};

const typeOnMac = async (text: string): Promise<void> => {
  // Clipboard + Cmd+V is more reliable than System Events keystroke:
  //   1. Handles ALL Unicode (French accents, CJK, emoji) — keystroke corrupts them
  //   2. Does NOT require macOS Accessibility permission (clipboard is unrestricted)
  //   3. Matches the Windows path so cross-platform behavior is consistent
  const prev = clipboard.readText();
  clipboard.writeText(text);
  // System Events Cmd+V still requires a lightweight AppleScript, but this one
  // does NOT require Accessibility — just Automation (standard Apple Events).
  // Most macOS apps grant Automation on first use without a blocking dialog.
  const script = `tell application "System Events" to keystroke "v" using command down`;
  try {
    await run("osascript", ["-e", script]);
  } catch (err) {
    // If Automation is also blocked, leave the text on the clipboard so the
    // user can Cmd+V manually. This is a graceful failure, not a silent one.
    console.error("[INSERT] Mac keystroke failed — text left on clipboard:", err instanceof Error ? err.message : err);
    throw new Error("Paste blocked — text copied to clipboard. Press Cmd+V to insert.");
  }
  // Restore previous clipboard after a short delay
  setTimeout(() => clipboard.writeText(prev), 500);
};

export const insertText = async (text: string, mode: "type" | "clipboard"): Promise<void> => {
  if (!text.trim()) {
    return;
  }

  if (mode === "clipboard") {
    clipboard.writeText(text);
    return;
  }

  if (process.platform === "win32") {
    await typeOnWindows(text);
    return;
  }

  if (process.platform === "darwin") {
    await typeOnMac(text);
    return;
  }

  clipboard.writeText(text);
};
