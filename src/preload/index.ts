import { contextBridge, ipcRenderer } from "electron"

contextBridge.exposeInMainWorld("electronAPI", {
    getDefaultConfigPath: () => ipcRenderer.invoke("get-default-config-path"),
    loadConfig: (configPath: string) => ipcRenderer.invoke("load-config", configPath),
    startProc: (procId: string) => ipcRenderer.invoke("start-proc", procId),
    stopProc: (procId: string) => ipcRenderer.invoke("stop-proc", procId),
    restartProc: (procId: string) => ipcRenderer.invoke("restart-proc", procId),
    onProcessOutput: (fn: (data: { procId: string; text: string; isStderr: boolean }) => void) => {
        ipcRenderer.on("process-output", (_e, data) => fn(data))
    },
    onProcStarted: (fn: (procId: string) => void) => {
        ipcRenderer.on("proc-started", (_e, procId) => fn(procId))
    },
    onProcStopped: (fn: (data: { procId: string; code: number | null }) => void) => {
        ipcRenderer.on("proc-stopped", (_e, data) => fn(data))
    },
    checkForUpdates: () => ipcRenderer.invoke("updater-check"),
    quitAndInstall: () => ipcRenderer.invoke("updater-quit-and-install"),
    onUpdateAvailable: (fn: (version: string) => void) => {
        ipcRenderer.on("update-available", (_e, version: string) => fn(version))
    },
    onUpdateDownloaded: (fn: (version: string) => void) => {
        ipcRenderer.on("update-downloaded", (_e, version: string) => fn(version))
    },
    onUpdateError: (fn: (message: string) => void) => {
        ipcRenderer.on("update-error", (_e, message: string) => fn(message))
    },
    openExternalLink: (url: string) => ipcRenderer.invoke("open-external-link", url),
})
