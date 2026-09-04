// @vitest-environment jsdom
/* oxlint-disable vitest/require-mock-type-parameters -- the bridge factory provides the scenario-specific signatures */

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

type OutputListener = (data: { procId: string; text: string; isStderr: boolean }) => void
type StartedListener = (procId: string) => void
type StoppedListener = (data: { procId: string; code: number | null }) => void

const listeners: {
    output?: OutputListener
    started?: StartedListener
    stopped?: StoppedListener
    updateDownloaded?: (version: string) => void
} = {}

class SearchWorker {
    onmessage: ((event: MessageEvent) => void) | null = null

    postMessage(message: { id: number }) {
        queueMicrotask(() =>
            this.onmessage?.({
                data: { id: message.id, matches: [], filteredLineIndices: [] },
            } as MessageEvent),
        )
    }

    terminate() {}
}

const createApi = () => ({
    getAppConfig: vi.fn().mockResolvedValue({ disable_animations: true }),
    getDefaultConfigPath: vi.fn().mockResolvedValue("/workspace/mprocs.yaml"),
    loadConfig: vi.fn().mockImplementation(async (path: string) => ({
        configPath: path || "/workspace/alternate.yaml",
        configDir: path ? "/workspace" : "/alternate",
        procs: [
            { id: "backend", name: "backend" },
            { id: "frontend", name: "frontend" },
        ],
        runningIds: ["backend"],
    })),
    startProc: vi.fn().mockResolvedValue({ ok: true }),
    stopProc: vi.fn().mockResolvedValue({ ok: true }),
    restartProc: vi.fn().mockResolvedValue({ ok: true }),
    getPortOccupant: vi.fn().mockResolvedValue({ pid: 42, command: "node", port: 3000 }),
    killPortOccupant: vi.fn().mockResolvedValue({
        ok: true,
        occupant: { pid: 42, command: "node", port: 3000 },
    }),
    onProcessOutput: vi.fn((listener: OutputListener) => {
        listeners.output = listener
    }),
    onProcStarted: vi.fn((listener: StartedListener) => {
        listeners.started = listener
    }),
    onProcStopped: vi.fn((listener: StoppedListener) => {
        listeners.stopped = listener
    }),
    checkForUpdates: vi.fn().mockResolvedValue(undefined),
    quitAndInstall: vi.fn().mockResolvedValue(undefined),
    onUpdateAvailable: vi.fn(),
    onUpdateDownloaded: vi.fn((listener: (version: string) => void) => {
        listeners.updateDownloaded = listener
    }),
    onUpdateError: vi.fn(),
    openExternalLink: vi.fn().mockResolvedValue(undefined),
})

describe("oprocs GUI with the desktop bridge", () => {
    beforeEach(() => {
        vi.resetModules()
        vi.clearAllMocks()
        localStorage.clear()
        Object.keys(listeners).forEach((key) => delete listeners[key as keyof typeof listeners])
        Object.defineProperty(globalThis, "Worker", { configurable: true, value: SearchWorker })
        Object.defineProperty(navigator, "clipboard", {
            configurable: true,
            value: { writeText: vi.fn().mockResolvedValue(undefined) },
        })
    })

    afterEach(() => {
        cleanup()
        delete window.oprocsAPI
    })

    const renderApp = async () => {
        const api = createApi()
        window.oprocsAPI = api
        const { default: App } = await import("./App")
        render(<App />)
        await screen.findByText("frontend")
        return api
    }

    it("loads the default config and drives start, stop, restart, and bulk controls", async () => {
        const api = await renderApp()
        const user = userEvent.setup()

        expect(api.loadConfig).toHaveBeenCalledWith("/workspace/mprocs.yaml")
        expect(screen.getByTitle("/workspace").textContent).toBe("/workspace")
        expect(screen.getAllByText("running").length).toBeGreaterThan(0)
        expect(screen.getAllByText("stopped").length).toBeGreaterThan(0)

        await user.click(screen.getByLabelText("Start frontend"))
        await user.click(screen.getByLabelText("Stop backend"))
        await user.click(screen.getByLabelText("Restart backend"))
        await user.click(screen.getByLabelText("Restart all processes"))

        expect(api.startProc).toHaveBeenCalledWith("frontend")
        expect(api.stopProc).toHaveBeenCalledWith("backend")
        expect(api.restartProc).toHaveBeenCalledWith("backend")
        expect(api.restartProc).toHaveBeenCalledTimes(2)
        expect(api.startProc).toHaveBeenCalledTimes(2)
    })

    it("reacts to lifecycle/output events and opens detected URLs", async () => {
        const api = await renderApp()
        const user = userEvent.setup()

        act(() => {
            listeners.output?.({
                procId: "backend",
                text: "ready at http://localhost:3000/\n",
                isStderr: false,
            })
        })

        const links = await screen.findAllByTitle("http://localhost:3000")
        await user.click(screen.getByTitle("Copy logs to clipboard"))
        expect(await navigator.clipboard.readText()).toBe("ready at http://localhost:3000/\n")
        await user.click(links[0])
        expect(api.openExternalLink).toHaveBeenCalledWith("http://localhost:3000")

        act(() => listeners.stopped?.({ procId: "backend", code: 7 }))
        expect(await screen.findByText("stopped with exit 7")).toBeTruthy()

        act(() => listeners.started?.("backend"))
        await waitFor(() => expect(screen.queryByText("stopped with exit 7")).toBeNull())
    })

    it("looks up and kills a process reported as occupying a port", async () => {
        const api = await renderApp()
        const user = userEvent.setup()

        act(() => {
            listeners.output?.({ procId: "backend", text: "Error: Port 3000 is already in use\n", isStderr: true })
        })

        const killButton = await screen.findByLabelText("Kill node (pid 42) using port 3000")
        await user.click(killButton)

        expect(api.getPortOccupant).toHaveBeenCalledWith(3000)
        expect(api.killPortOccupant).toHaveBeenCalledWith(3000)
    })

    it("changes config and completes the update prompt", async () => {
        const api = await renderApp()
        const user = userEvent.setup()

        await user.click(screen.getByTitle("Change config"))
        expect(api.loadConfig).toHaveBeenLastCalledWith("")
        expect((await screen.findByTitle("/alternate")).textContent).toBe("/alternate")

        act(() => listeners.updateDownloaded?.("0.3.3"))
        expect(await screen.findByText("Update v0.3.3 ready")).toBeTruthy()
        await user.click(screen.getByText("Restart to update"))
        expect(api.quitAndInstall).toHaveBeenCalledOnce()
    })

    it("opens settings, persists animation preference, and supports Escape", async () => {
        await renderApp()
        const user = userEvent.setup()

        await user.click(screen.getByTitle("Open settings"))
        const toggle = screen.getByRole("switch")
        expect(toggle.getAttribute("aria-checked")).toBe("false")
        await user.click(toggle)
        expect(localStorage.getItem("oprocs:disable-log-animations")).toBe("false")

        fireEvent.keyDown(window, { key: "Escape" })
        expect(screen.queryByRole("dialog")).toBeNull()
    })
})
