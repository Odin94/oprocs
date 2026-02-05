import { autoUpdater } from "electron-updater";
import { BrowserWindow } from "electron";

const notifyAll = (channel: string, ...args: unknown[]) => {
  BrowserWindow.getAllWindows().forEach((w) => {
    if (!w.isDestroyed() && w.webContents) w.webContents.send(channel, ...args);
  });
};

export const setupUpdater = () => {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("checking-for-update", () => notifyAll("update-checking"));
  autoUpdater.on("update-available", (info) => notifyAll("update-available", info.version));
  autoUpdater.on("update-not-available", () => notifyAll("update-not-available"));
  autoUpdater.on("update-downloaded", (info) => notifyAll("update-downloaded", info.version));
  autoUpdater.on("error", (err) => notifyAll("update-error", err.message));

  setTimeout(() => autoUpdater.checkForUpdates(), 3000);
};

export const checkForUpdates = () => autoUpdater.checkForUpdates();
export const quitAndInstall = () => autoUpdater.quitAndInstall(false, true);
