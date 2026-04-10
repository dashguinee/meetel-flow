import { app } from "electron";
import { autoUpdater } from "electron-updater";

// Silently absorb DNS resolution failures on the update endpoint so dev builds
// and builds without a live updates.meetel.com don't spam the error log.
const isUpdaterEndpointMissing = (error: unknown): boolean => {
  const msg = error instanceof Error ? error.message : String(error ?? "");
  return (
    msg.includes("ERR_NAME_NOT_RESOLVED") ||
    msg.includes("ENOTFOUND") ||
    msg.includes("getaddrinfo")
  );
};

export const setupAutoUpdates = (): void => {
  if (!app.isPackaged) {
    return;
  }

  // Explicit opt-out for builds that haven't wired up an update feed yet.
  if (process.env.MEETEL_DISABLE_UPDATES === "1") {
    return;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("error", (error) => {
    if (isUpdaterEndpointMissing(error)) {
      // Update endpoint not live yet — silent no-op.
      return;
    }
    console.error("auto_update_error", error);
  });

  autoUpdater.checkForUpdatesAndNotify().catch((error) => {
    if (isUpdaterEndpointMissing(error)) {
      return;
    }
    console.error("auto_update_check_error", error);
  });
};
