import { app } from "electron";
import { autoUpdater } from "electron-updater";

export const setupAutoUpdates = (): void => {
  if (!app.isPackaged) {
    return;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("error", (error) => {
    console.error("auto_update_error", error);
  });

  autoUpdater.checkForUpdatesAndNotify().catch((error) => {
    console.error("auto_update_check_error", error);
  });
};
