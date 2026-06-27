import { EventEmitter } from "node:events"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { ProcessManager, withWindowsUtf8CmdArgs, withWindowsUtf8Shell } from "../processManager.js"

const isPidAlive = (pid: number): boolean => {
    try {
        process.kill(pid, 0)
        return true
    } catch {
        return false
    }
}

const waitFor = async (predicate: () => boolean, timeoutMs = 2000): Promise<boolean> => {
    const started = Date.now()
    while (Date.now() - started < timeoutMs) {
        if (predicate()) return true
        await new Promise((resolve) => setTimeout(resolve, 25))
    }
    return predicate()
}

describe("Windows UTF-8 process wrapping", () => {
    it("prepends chcp for cmd shell commands", () => {
        expect(withWindowsUtf8Shell("echo \u00e4\u00f6\u00fc", "cmd.exe")).toBe(
            "chcp 65001>nul && echo \u00e4\u00f6\u00fc",
        )
    })

    it("prepends encoding setup for powershell shell commands", () => {
        expect(withWindowsUtf8Shell("Write-Output '\u00e4\u00f6\u00fc'", "powershell.exe")).toContain(
            "[Console]::OutputEncoding",
        )
    })

    it("rewrites cmd /c commands to force utf8", () => {
        expect(withWindowsUtf8CmdArgs("cmd.exe", ["/c", "echo \u00e4\u00f6\u00fc"])).toEqual([
            "/c",
            "chcp 65001>nul && echo \u00e4\u00f6\u00fc",
        ])
    })

    it("rewrites powershell -Command to force utf8", () => {
        const out = withWindowsUtf8CmdArgs("powershell.exe", [
            "-NoProfile",
            "-Command",
            "Write-Output '\u00e4\u00f6\u00fc'",
        ])
        expect(out[2]).toContain("[Console]::OutputEncoding")
        expect(out[2]).toContain("Write-Output '\u00e4\u00f6\u00fc'")
    })

    it("leaves unrelated commands unchanged", () => {
        expect(withWindowsUtf8CmdArgs("node", ["server.js"])).toEqual(["server.js"])
    })
})

describe("stop state reconciliation", () => {
    it("marks a user-stopped process as stopped after the shell closes", () => {
        const pm = new ProcessManager()
        const stopped: Array<{ procId: string; code: number | null }> = []
        pm.on({ stopped: (data) => stopped.push(data) })

        const handle = new EventEmitter() as EventEmitter & {
            pid: number
            stdout?: EventEmitter
            stderr?: EventEmitter
        }
        handle.pid = 321
        handle.stdout = new EventEmitter()
        handle.stderr = new EventEmitter()

        const state = {
            proc: handle,
            config: { shell: "echo hi", autorestart: false },
            configDir: process.cwd(),
            lines: [] as string[],
            buffer: "",
            logStream: null,
            startTime: Date.now(),
            userRequestedStop: true,
            effectivePid: 654,
            pidsForLock: [321, 654],
        }

        ;(pm as unknown as { procs: Map<string, unknown> }).procs.set("api", state)
        ;(pm as unknown as { persistLock: () => void }).persistLock = () => {}
        ;(pm as unknown as { isPidAlive: (pid: number) => boolean }).isPidAlive = () => false

        type TestProcState = typeof state
        ;(
            pm as unknown as {
                reconcileClosedProc: (
                    state: TestProcState,
                    procId: string,
                    code: number | null,
                    config: TestProcState["config"],
                ) => void
            }
        ).reconcileClosedProc(state, "api", 0, state.config)

        expect((pm as unknown as { procs: Map<string, typeof state> }).procs.get("api")?.proc).toBeNull()
        expect(stopped).toEqual([{ procId: "api", code: 0 }])
    })

    it("stops the whole process tree with the configured signal", async () => {
        const pm = new ProcessManager({ disable_animations: false, quiet: false, no_logs: true })
        const calls: Array<{ pid: number; signal: string }> = []

        const handle = new EventEmitter() as EventEmitter & {
            pid: number
            stdout?: EventEmitter
            stderr?: EventEmitter
        }
        handle.pid = 321
        handle.stdout = new EventEmitter()
        handle.stderr = new EventEmitter()

        const state = {
            proc: handle,
            config: { shell: "echo hi", stop: "SIGINT" as const },
            configDir: process.cwd(),
            lines: [] as string[],
            buffer: "",
            logStream: null,
            startTime: Date.now(),
        }

        ;(pm as unknown as { procs: Map<string, unknown> }).procs.set("api", state)
        ;(pm as unknown as { persistLock: () => void }).persistLock = () => {}
        ;(
            pm as unknown as {
                killProcessTree: (pid: number, signal?: string) => Promise<void>
            }
        ).killProcessTree = async (pid: number, signal = "SIGTERM") => {
            calls.push({ pid, signal })
        }

        await pm.stop("api")

        expect(calls).toEqual([{ pid: 321, signal: "SIGINT" }])
    })

    it("escalates shutdown when a spawned process does not close", async () => {
        const pm = new ProcessManager({ disable_animations: false, quiet: false, no_logs: true })
        const calls: Array<{ pid: number; signal: string }> = []

        const handle = new EventEmitter() as EventEmitter & {
            pid: number
            stdout?: EventEmitter
            stderr?: EventEmitter
        }
        handle.pid = 321
        handle.stdout = new EventEmitter()
        handle.stderr = new EventEmitter()

        const state = {
            proc: handle,
            config: { shell: "sleep 100" },
            configDir: process.cwd(),
            lines: [] as string[],
            buffer: "",
            logStream: null,
            startTime: Date.now(),
        }

        ;(pm as unknown as { procs: Map<string, unknown> }).procs.set("api", state)
        ;(pm as unknown as { persistLock: () => void }).persistLock = () => {}
        ;(pm as unknown as { shutdownWaitMs: number }).shutdownWaitMs = 1
        ;(pm as unknown as { shutdownKillWaitMs: number }).shutdownKillWaitMs = 1
        ;(
            pm as unknown as {
                killProcessTree: (pid: number, signal?: string) => Promise<void>
            }
        ).killProcessTree = async (pid: number, signal = "SIGTERM") => {
            calls.push({ pid, signal })
        }

        await pm.shutdown()

        expect(calls).toEqual([
            { pid: 321, signal: "SIGTERM" },
            { pid: 321, signal: "SIGKILL" },
        ])
        expect((pm as unknown as { procs: Map<string, unknown> }).procs.size).toBe(0)
    })

    it("kills child processes spawned by a managed command during shutdown", async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oprocs-process-tree-"))
        const childPidPath = path.join(tmpDir, "child.pid")
        const trackedPids: number[] = []
        let watchdogShutdowns = 0
        const pm = new ProcessManager(
            { disable_animations: false, quiet: false, no_logs: true },
            {
                track: (pid) => trackedPids.push(pid),
                shutdown: () => {
                    watchdogShutdowns += 1
                },
            },
        )
        let childPid: number | null = null

        const childCode = "setInterval(() => {}, 1000)"
        const parentCode = `
            const { spawn } = require("node:child_process");
            const fs = require("node:fs");
            const child = spawn(process.execPath, ["-e", ${JSON.stringify(childCode)}], { stdio: "ignore" });
            fs.writeFileSync(${JSON.stringify(childPidPath)}, String(child.pid));
            setInterval(() => {}, 1000);
        `

        try {
            pm.setConfigDir(tmpDir)
            pm.register("tree", { cmd: [process.execPath, "-e", parentCode] }, tmpDir)
            expect(pm.start("tree")).toEqual({ ok: true })
            expect(trackedPids).toHaveLength(1)
            expect(await waitFor(() => fs.existsSync(childPidPath))).toBe(true)

            childPid = Number(fs.readFileSync(childPidPath, "utf-8"))
            expect(Number.isInteger(childPid)).toBe(true)
            expect(isPidAlive(childPid)).toBe(true)

            await pm.shutdown()

            expect(await waitFor(() => childPid != null && !isPidAlive(childPid))).toBe(true)
            expect(watchdogShutdowns).toBe(1)
        } finally {
            await pm.shutdown()
            if (childPid != null && isPidAlive(childPid)) {
                try {
                    process.kill(childPid, "SIGKILL")
                } catch {
                    // ignore
                }
            }
            fs.rmSync(tmpDir, { recursive: true, force: true })
        }
    })
})
