import { ipcMain, dialog, BrowserWindow, shell, type OpenDialogOptions } from "electron"
import fs from "fs"
import path from "path"
import { loadConfig } from "./config.js"
import { checkForUpdates, quitAndInstall } from "./updater.js"
import type { ProcessManager } from "./processManager.js"

const lockLog = (msg: string, ...args: unknown[]) => console.log("[oprocs lock]", msg, ...args)

export const setupIpc = (pm: ProcessManager) => {
    let currentConfigPath: string | null = null
    let currentConfigDir: string | null = null

    ipcMain.handle("get-default-config-path", async () => {
        const candidate = path.join(process.cwd(), "mprocs.yaml")
        return fs.existsSync(candidate) ? candidate : null
    })

    ipcMain.handle("load-config", async (event, configPath: string) => {
        let pathToLoad = configPath
        if (!pathToLoad) {
            const win = BrowserWindow.fromWebContents(event.sender)
            const opts: OpenDialogOptions = {
                properties: ["openFile"],
                filters: [
                    { name: "YAML", extensions: ["yaml", "yml"] },
                    { name: "All", extensions: ["*"] },
                ],
                title: "Open mprocs.yaml",
            }
            const result = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
            if (result.canceled || !result.filePaths[0]) {
                return { error: "No file selected" }
            }
            pathToLoad = result.filePaths[0]
        }

        const resolved = path.resolve(pathToLoad)
        const loaded = loadConfig(resolved)
        if ("error" in loaded) return loaded

        currentConfigPath = resolved
        currentConfigDir = loaded.configDir
        lockLog("load-config: configDir=%s", loaded.configDir)
        pm.setConfigDir(loaded.configDir)
        const lock = pm.readLock()
        lockLog("load-config: lock file result: %s", lock == null ? "null" : JSON.stringify(lock))
        await pm.killPidsFromLock(lock)
        await new Promise((r) => setTimeout(r, 300))
        if (lock) {
            const red = "\x1b[31m"
            const reset = "\x1b[0m"
            for (const [procId, pids] of Object.entries(lock)) {
                const list = Array.isArray(pids) ? pids : [pids]
                if (list.length === 0) continue
                const pidStr = list.length === 1 ? `pid ${list[0]}` : `pids ${list.join(", ")}`
                event.sender.send("process-output", {
                    procId,
                    text: `${red}[Killed previous processes from .oprocs.lock (${pidStr}) before starting - this happens if oprocs crashes or is force killed.]${reset}\n`,
                    isStderr: false,
                })
            }
        }
        pm.unregisterAll()

        const procs = Object.entries(loaded.config.procs).map(([id, procConfig]) => ({
            id,
            name: id,
            autostart: procConfig.autostart ?? true,
        }))

        for (const [id, procConfig] of Object.entries(loaded.config.procs)) {
            pm.register(id, procConfig, loaded.configDir)
        }
        for (const { id, autostart } of procs) {
            if (!autostart) {
                lockLog("load-config: %s autostart=false, skipping", id)
                continue
            }
            lockLog("load-config: %s starting new process", id)
            const result = pm.start(id)
            if (!result.ok) lockLog("load-config: %s start failed: %s", id, result.error)
        }
        pm.persistLock()

        const runningIds = pm.getAllProcIds().filter((id) => pm.isRunning(id))

        return {
            configPath: currentConfigPath,
            configDir: currentConfigDir ?? "",
            procs: Object.keys(loaded.config.procs).map((id) => ({ id, name: id })),
            runningIds,
        }
    })

    ipcMain.handle("start-proc", async (_event, procId: string) => pm.start(procId))
    ipcMain.handle("stop-proc", async (_event, procId: string) => pm.stop(procId))
    ipcMain.handle("restart-proc", async (_event, procId: string) => pm.restart(procId))

    ipcMain.handle("updater-check", () => {
        checkForUpdates()
    })
    ipcMain.handle("updater-quit-and-install", () => {
        quitAndInstall()
    })
    ipcMain.handle("open-external-link", (_event, url) => {
        shell.openExternal(url)
    })
}
