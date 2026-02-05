import { ipcMain, dialog, BrowserWindow } from "electron";
import fs from "fs";
import path from "path";
import { loadConfig } from "./config.js";
import { checkForUpdates, quitAndInstall } from "./updater.js";
import type { ProcessManager } from "./processManager.js";

export const setupIpc = (pm: ProcessManager) => {
  let currentConfigPath: string | null = null;
  let currentConfigDir: string | null = null;

  ipcMain.handle("get-default-config-path", async () => {
    const candidate = path.join(process.cwd(), "mprocs.yaml");
    return fs.existsSync(candidate) ? candidate : null;
  });

  ipcMain.handle("load-config", async (event, configPath: string) => {
    let pathToLoad = configPath;
    if (!pathToLoad) {
      const win = BrowserWindow.fromWebContents(event.sender) ?? undefined;
      const result = await dialog.showOpenDialog(win, {
        properties: ["openFile"],
        filters: [{ name: "YAML", extensions: ["yaml", "yml"] }, { name: "All", extensions: ["*"] }],
        title: "Open mprocs.yaml",
      });
      if (result.canceled || !result.filePaths[0]) {
        return { error: "No file selected" };
      }
      pathToLoad = result.filePaths[0];
    }

    const resolved = path.resolve(pathToLoad);
    const loaded = loadConfig(resolved);
    if ("error" in loaded) return loaded;

    currentConfigPath = resolved;
    currentConfigDir = loaded.configDir;
    pm.setConfigDir(loaded.configDir);
    pm.unregisterAll();

    const procs = Object.entries(loaded.config.procs).map(([id, procConfig]) => ({
      id,
      name: id,
      autostart: procConfig.autostart ?? true,
    }));

    for (const [id, procConfig] of Object.entries(loaded.config.procs)) {
      pm.register(id, procConfig, loaded.configDir);
    }

    for (const { id, autostart } of procs) {
      if (autostart) pm.start(id);
    }

    const runningIds = pm.getAllProcIds().filter((id) => pm.isRunning(id));

    return {
      configPath: currentConfigPath,
      configDir: currentConfigDir ?? "",
      procs: Object.keys(loaded.config.procs).map((id) => ({ id, name: id })),
      runningIds,
    };
  });

  ipcMain.handle("start-proc", async (_event, procId: string) => pm.start(procId));
  ipcMain.handle("stop-proc", async (_event, procId: string) => pm.stop(procId));
  ipcMain.handle("restart-proc", async (_event, procId: string) => pm.restart(procId));

  ipcMain.handle("updater-check", () => {
    checkForUpdates();
  });
  ipcMain.handle("updater-quit-and-install", () => {
    quitAndInstall();
  });
};
