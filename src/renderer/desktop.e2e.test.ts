// @vitest-environment jsdom
/* oxlint-disable vitest/require-mock-type-parameters -- mock implementations infer their signatures from each scenario */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks"
import { emit } from "@tauri-apps/api/event"

const plugins = vi.hoisted(() => ({
    openDialog: vi.fn(),
    openUrl: vi.fn(),
    checkForUpdate: vi.fn(),
    relaunch: vi.fn(),
    setBackgroundColor: vi.fn(),
    setTheme: vi.fn(),
}))

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: plugins.openDialog }))
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: plugins.openUrl }))
vi.mock("@tauri-apps/plugin-updater", () => ({ check: plugins.checkForUpdate }))
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: plugins.relaunch }))
vi.mock("@tauri-apps/api/window", () => ({
    getCurrentWindow: () => ({
        setBackgroundColor: plugins.setBackgroundColor,
        setTheme: plugins.setTheme,
    }),
}))

const importDesktopApi = async (handler: Parameters<typeof mockIPC>[0]) => {
    mockIPC(handler, { shouldMockEvents: true })
    await import("./desktop")
    return window.oprocsAPI!
}

describe("Tauri desktop IPC bridge", () => {
    beforeEach(() => {
        vi.resetModules()
        vi.clearAllMocks()
        delete window.oprocsAPI
    })

    afterEach(() => {
        clearMocks()
        delete window.oprocsAPI
    })

    it("maps every process command and forwards native lifecycle events", async () => {
        const invocations: Array<{ command: string; payload: unknown }> = []
        const api = await importDesktopApi((command, payload) => {
            invocations.push({ command, payload })
            switch (command) {
                case "get_app_config":
                    return { disable_animations: true }
                case "get_default_config_path":
                    return "/workspace/mprocs.yaml"
                case "load_config":
                    return {
                        configPath: "/workspace/mprocs.yaml",
                        configDir: "/workspace",
                        procs: [{ id: "web", name: "web" }],
                        runningIds: ["web"],
                    }
                case "get_port_occupant":
                    return { pid: 42, command: "node", port: 3000 }
                case "kill_port_occupant":
                    return { ok: true, occupant: { pid: 42, command: "node", port: 3000 } }
                default:
                    return { ok: true }
            }
        })

        expect(await api.getAppConfig()).toEqual({ disable_animations: true })
        expect(await api.getDefaultConfigPath()).toBe("/workspace/mprocs.yaml")
        await api.setWindowAppearance("cozy", "#f7e6ec")
        await expect(api.loadConfig("/workspace/mprocs.yaml")).resolves.toMatchObject({ runningIds: ["web"] })
        await expect(api.startProc("web")).resolves.toEqual({ ok: true })
        await expect(api.stopProc("web")).resolves.toEqual({ ok: true })
        await expect(api.restartProc("web")).resolves.toEqual({ ok: true })
        await expect(api.getPortOccupant(3000)).resolves.toMatchObject({ pid: 42, command: "node" })
        await expect(api.killPortOccupant(3000)).resolves.toMatchObject({ ok: true })
        expect(plugins.setBackgroundColor).toHaveBeenCalledWith("#f7e6ec")
        expect(plugins.setTheme).toHaveBeenCalledWith("light")

        await api.setWindowAppearance("tech", "#121318")
        expect(plugins.setBackgroundColor).toHaveBeenLastCalledWith("#121318")
        expect(plugins.setTheme).toHaveBeenLastCalledWith("dark")

        expect(invocations).toEqual(
            expect.arrayContaining([
                { command: "load_config", payload: { configPath: "/workspace/mprocs.yaml" } },
                { command: "start_proc", payload: { procId: "web" } },
                { command: "stop_proc", payload: { procId: "web" } },
                { command: "restart_proc", payload: { procId: "web" } },
                { command: "get_port_occupant", payload: { port: 3000 } },
                { command: "kill_port_occupant", payload: { port: 3000 } },
            ]),
        )

        const onOutput = vi.fn()
        const onStarted = vi.fn()
        const onStopped = vi.fn()
        api.onProcessOutput(onOutput)
        api.onProcStarted(onStarted)
        api.onProcStopped(onStopped)

        await emit("process-output", { procId: "web", text: "ready\n", isStderr: false })
        await emit("proc-started", "web")
        await emit("proc-stopped", { procId: "web", code: 0 })

        expect(onOutput).toHaveBeenCalledWith({ procId: "web", text: "ready\n", isStderr: false })
        expect(onStarted).toHaveBeenCalledWith("web")
        expect(onStopped).toHaveBeenCalledWith({ procId: "web", code: 0 })
    })

    it("uses the native file chooser and reports cancellation", async () => {
        const api = await importDesktopApi((command, payload) => {
            if (command === "load_config")
                return {
                    configPath: (payload as Record<string, unknown>)?.configPath,
                    configDir: "/tmp",
                    procs: [],
                }
        })

        plugins.openDialog.mockResolvedValueOnce(null)
        await expect(api.loadConfig("")).resolves.toEqual({ error: "No file selected" })

        plugins.openDialog.mockResolvedValueOnce("/tmp/selected.yaml")
        await expect(api.loadConfig("")).resolves.toMatchObject({ configPath: "/tmp/selected.yaml" })
        expect(plugins.openDialog).toHaveBeenCalledWith(
            expect.objectContaining({ title: "Open mprocs.yaml", multiple: false, directory: false }),
        )
    })

    it("opens external URLs and completes the update/relaunch flow", async () => {
        const download = vi.fn().mockResolvedValue(undefined)
        const install = vi.fn().mockResolvedValue(undefined)
        plugins.checkForUpdate.mockResolvedValue({ version: "0.3.3", download, install })
        plugins.openUrl.mockResolvedValue(undefined)
        plugins.relaunch.mockResolvedValue(undefined)
        const api = await importDesktopApi(() => undefined)
        const onAvailable = vi.fn()
        const onDownloaded = vi.fn()
        const onError = vi.fn()
        api.onUpdateAvailable(onAvailable)
        api.onUpdateDownloaded(onDownloaded)
        api.onUpdateError(onError)

        await api.openExternalLink("http://localhost:3000")
        await api.checkForUpdates()
        await api.quitAndInstall()

        expect(plugins.openUrl).toHaveBeenCalledWith("http://localhost:3000")
        expect(onAvailable).toHaveBeenCalledWith("0.3.3")
        expect(download).toHaveBeenCalledOnce()
        expect(onDownloaded).toHaveBeenCalledWith("0.3.3")
        expect(install).toHaveBeenCalledOnce()
        expect(plugins.relaunch).toHaveBeenCalledOnce()
        expect(onError).not.toHaveBeenCalled()
    })

    it("surfaces updater failures to the GUI", async () => {
        plugins.checkForUpdate.mockRejectedValue(new Error("offline"))
        const api = await importDesktopApi(() => undefined)
        const onError = vi.fn()
        api.onUpdateError(onError)

        await api.checkForUpdates()

        expect(onError).toHaveBeenCalledWith("offline")
    })
})
