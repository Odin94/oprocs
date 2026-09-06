import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import type { PortOccupant } from "../shared/types"

type ProcessOutput = { procId: string; text: string; isStderr: boolean }
type ProcessStopped = { procId: string; code: number | null }
type PendingUpdate = {
    version: string
    download: () => Promise<void>
    install: () => Promise<void>
}

const processOutputListeners = new Set<(data: ProcessOutput) => void>()
const procStartedListeners = new Set<(procId: string) => void>()
const procStoppedListeners = new Set<(data: ProcessStopped) => void>()

const nativeListenersReady = Promise.all([
    listen<ProcessOutput>("process-output", (event) => {
        processOutputListeners.forEach((listener) => listener(event.payload))
    }),
    listen<string>("proc-started", (event) => {
        procStartedListeners.forEach((listener) => listener(event.payload))
    }),
    listen<ProcessStopped>("proc-stopped", (event) => {
        procStoppedListeners.forEach((listener) => listener(event.payload))
    }),
]).then(() => undefined)

let pendingUpdate: PendingUpdate | null = null
const updateAvailableListeners = new Set<(version: string) => void>()
const updateDownloadedListeners = new Set<(version: string) => void>()
const updateErrorListeners = new Set<(message: string) => void>()

const reportUpdateError = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    updateErrorListeners.forEach((listener) => listener(message))
}

const checkForUpdates = async () => {
    try {
        const { check } = await import("@tauri-apps/plugin-updater")
        const update = await check()
        if (!update) return
        updateAvailableListeners.forEach((listener) => listener(update.version))
        await update.download()
        pendingUpdate = update
        updateDownloadedListeners.forEach((listener) => listener(update.version))
    } catch (error) {
        reportUpdateError(error)
    }
}

window.oprocsAPI = {
    getAppConfig: () => invoke("get_app_config"),
    getDefaultConfigPath: () => invoke("get_default_config_path"),
    setWindowAppearance: async (theme, backgroundColor) => {
        const { getCurrentWindow } = await import("@tauri-apps/api/window")
        const currentWindow = getCurrentWindow()
        // oprocs owns a single native window, so its title bar and native dialogs follow the selected UI theme.
        await Promise.all([
            currentWindow.setBackgroundColor(backgroundColor),
            currentWindow.setTheme(theme === "cozy" ? "light" : "dark"),
        ])
    },
    loadConfig: async (configPath: string) => {
        await nativeListenersReady
        let path = configPath
        if (!path) {
            const { open } = await import("@tauri-apps/plugin-dialog")
            const selected = await open({
                title: "Open mprocs.yaml",
                multiple: false,
                directory: false,
                filters: [
                    { name: "YAML", extensions: ["yaml", "yml"] },
                    { name: "All", extensions: ["*"] },
                ],
            })
            if (!selected) return { error: "No file selected" }
            path = selected
        }
        return invoke("load_config", { configPath: path })
    },
    startProc: (procId: string) => invoke("start_proc", { procId }),
    stopProc: (procId: string) => invoke("stop_proc", { procId }),
    restartProc: (procId: string) => invoke("restart_proc", { procId }),
    getPortOccupant: (port: number) => invoke<PortOccupant | null>("get_port_occupant", { port }),
    killPortOccupant: (port: number) => invoke("kill_port_occupant", { port }),
    onProcessOutput: (listener: (data: ProcessOutput) => void) => {
        processOutputListeners.add(listener)
    },
    onProcStarted: (listener: (procId: string) => void) => {
        procStartedListeners.add(listener)
    },
    onProcStopped: (listener: (data: ProcessStopped) => void) => {
        procStoppedListeners.add(listener)
    },
    checkForUpdates,
    quitAndInstall: async () => {
        if (!pendingUpdate) return
        await pendingUpdate.install()
        const { relaunch } = await import("@tauri-apps/plugin-process")
        await relaunch()
    },
    onUpdateAvailable: (listener: (version: string) => void) => {
        updateAvailableListeners.add(listener)
    },
    onUpdateDownloaded: (listener: (version: string) => void) => {
        updateDownloadedListeners.add(listener)
        if (pendingUpdate) listener(pendingUpdate.version)
    },
    onUpdateError: (listener: (message: string) => void) => {
        updateErrorListeners.add(listener)
    },
    openExternalLink: async (url: string) => {
        const { openUrl } = await import("@tauri-apps/plugin-opener")
        await openUrl(url)
    },
}

if (!import.meta.env.DEV) {
    window.setTimeout(() => void checkForUpdates(), 3000)
}
