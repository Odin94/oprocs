import { app, BrowserWindow, Menu } from "electron"
import path from "path"
import { ProcessManager } from "./processManager.js"
import { setupIpc } from "./ipc.js"
import { setupUpdater } from "./updater.js"

const isDev = process.env.NODE_ENV === "development" || !app.isPackaged

const pm = new ProcessManager()
setupIpc(pm)

const createWindow = () => {
    const win = new BrowserWindow({
        width: 1200,
        height: 800,
        webPreferences: {
            preload: path.join(__dirname, "../preload/index.cjs"),
            contextIsolation: true,
            nodeIntegration: false,
        },
        icon: path.join(__dirname, "../../assets/icon.ico"),
    })

    if (isDev) {
        win.loadURL(process.env.ELECTRON_RENDERER_URL ?? "http://localhost:5173")
        win.webContents.openDevTools()
    } else {
        win.loadFile(path.join(__dirname, "../renderer/index.html"))
    }
    return win
}

app.whenReady().then(() => {
    Menu.setApplicationMenu(null)
    createWindow()
    if (app.isPackaged) setupUpdater()

    pm.on({
        output: (data) => BrowserWindow.getAllWindows().forEach((w) => w.webContents.send("process-output", data)),
        started: (procId) => BrowserWindow.getAllWindows().forEach((w) => w.webContents.send("proc-started", procId)),
        stopped: (data) => BrowserWindow.getAllWindows().forEach((w) => w.webContents.send("proc-stopped", data)),
    })

    app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
})

app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit()
})

app.on("before-quit", () => {
    pm.unregisterAll()
})
