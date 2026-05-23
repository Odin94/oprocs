import { EventEmitter } from "node:events"
import { describe, expect, it } from "vitest"
import { ProcessManager, withWindowsUtf8CmdArgs, withWindowsUtf8Shell } from "../processManager.js"

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
})
