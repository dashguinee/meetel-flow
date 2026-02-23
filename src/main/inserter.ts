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
  const escaped = text
    .replaceAll("'", "''")
    .replaceAll("{", "{{}")
    .replaceAll("}", "{}}");
  const script = `$wshell = New-Object -ComObject WScript.Shell; Start-Sleep -Milliseconds 80; $wshell.SendKeys('${escaped}')`;
  await run("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script]);
};

const typeOnMac = async (text: string): Promise<void> => {
  const escaped = text.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  const script = `tell application \"System Events\" to keystroke \"${escaped}\"`;
  await run("osascript", ["-e", script]);
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
