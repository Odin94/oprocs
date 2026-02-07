import { spawn, spawnSync, exec, execSync, type ChildProcess } from "child_process"
import { promisify } from "util"

const execAsync = promisify(exec)
import fs from "fs"
import path from "path"
import treeKill from "tree-kill"
import type { ProcConfig } from "../shared/types.js"
import { log } from "./logger.js"

const MAX_LINES = 10_000

const sanitizeProcName = (name: string): string => name.replace(/[/\\:*?"<>|]/g, "-").replace(/\s+/g, "-") || "proc"

const LOCK_FILE_NAME = ".oprocs.lock"

type AdoptedHandle = { pid: number }
type ProcHandle = ChildProcess | AdoptedHandle

const isSpawnedHandle = (p: ProcHandle): p is ChildProcess => "stdout" in p

type ProcState = {
    proc: ProcHandle | null
    config: ProcConfig
    configDir: string
    lines: string[]
    buffer: string
    logStream: fs.WriteStream | null
    startTime: number
    userRequestedStop?: boolean
    effectivePid?: number
    pidsForLock?: number[]
}

export type ProcessManagerEvents = {
    output: (data: { procId: string; text: string; isStderr: boolean }) => void
    started: (procId: string) => void
    stopped: (data: { procId: string; code: number | null }) => void
}

export class ProcessManager {
    private procs = new Map<string, ProcState>()
    private configDir = ""
    private listeners: ProcessManagerEvents = {
        output: () => {},
        started: () => {},
        stopped: () => {},
    }

    on(events: Partial<ProcessManagerEvents>) {
        this.listeners = { ...this.listeners, ...events }
    }

    setConfigDir(dir: string) {
        this.configDir = dir
    }

    private getLockPath(): string {
        return path.join(this.configDir, LOCK_FILE_NAME)
    }

    isPidAlive(pid: number): boolean {
        try {
            process.kill(pid, 0)
            return true
        } catch (err) {
            const code = err && typeof err === "object" && "code" in err ? (err as NodeJS.ErrnoException).code : undefined
            log.debug("isPidAlive: process.kill(pid, 0) threw pid=%s code=%s", pid, code)
            if (code === "EPERM") return true
            if (process.platform === "win32") return this.isPidAliveWindows(pid)
            return false
        }
    }

    private isPidAliveWindows(pid: number): boolean {
        try {
            const out = execSync(`tasklist /FI "PID eq ${pid}"`, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] })
            const alive = new RegExp("\\b" + pid + "\\b").test(out)
            log.debug("isPidAliveWindows: pid=%s tasklist result=%s", pid, alive)
            return alive
        } catch (err) {
            log.debug("isPidAliveWindows: tasklist failed pid=%s", pid, err)
            return false
        }
    }

    async killPidsFromLock(lock: Record<string, number[] | number> | null): Promise<void> {
        if (!lock || typeof lock !== "object") return
        const allPids = new Set<number>()
        for (const v of Object.values(lock)) {
            if (typeof v === "number" && Number.isInteger(v)) allPids.add(v)
            else if (Array.isArray(v))
                v.filter((p): p is number => typeof p === "number" && Number.isInteger(p)).forEach((p) => allPids.add(p))
        }
        log.debug("killPidsFromLock: platform=%s attempting to kill %s pid(s)", process.platform, allPids.size)
        await Promise.all(
            [...allPids].map((pid) => {
                log.debug("killPidsFromLock: killing pid=%s", pid)
                return this.killPid(pid)
            }),
        )
    }

    private parseChildPidsOutput(trimmed: string): { pid: number; name: string }[] {
        if (!trimmed || trimmed === "null") return []
        const parsed = JSON.parse(trimmed) as unknown
        const one = (p: unknown): { pid: number; name: string } | null => {
            if (p == null || typeof p !== "object") return null
            const o = p as Record<string, unknown>
            const pid = (o.ProcessId ?? o.processId) as number | undefined
            const name = (o.Name ?? o.name) as string | undefined
            if (typeof pid !== "number" || !Number.isInteger(pid)) return null
            return { pid, name: typeof name === "string" ? name : "" }
        }
        if (Array.isArray(parsed)) {
            return parsed.map(one).filter((x): x is { pid: number; name: string } => x != null)
        }
        const single = one(parsed)
        return single ? [single] : []
    }

    private async getChildPidsWindowsAsync(parentPid: number): Promise<{ pid: number; name: string }[]> {
        try {
            const { stdout } = await execAsync(
                `powershell "Get-CimInstance Win32_Process -Filter 'ParentProcessId = ${parentPid}' | Select-Object ProcessId, Name | ConvertTo-Json -Compress"`,
                { encoding: "utf-8", timeout: 5000 },
            )
            return this.parseChildPidsOutput((stdout as string).trim())
        } catch {
            return []
        }
    }

    private isShellProcessName(name: string): boolean {
        const n = name.toLowerCase()
        return n === "cmd.exe" || n === "command.com" || n === "powershell.exe" || n === "pwsh.exe"
    }

    private async collectDescendantsWindowsAsync(rootPid: number): Promise<{ pid: number; name: string; depth: number }[]> {
        const out: { pid: number; name: string; depth: number }[] = []
        const walk = async (pid: number, depth: number) => {
            const children = await this.getChildPidsWindowsAsync(pid)
            for (const c of children) {
                out.push({ pid: c.pid, name: c.name ?? "", depth })
                await walk(c.pid, depth + 1)
            }
        }
        await walk(rootPid, 0)
        return out
    }

    private async logDescendantTreeWindowsAsync(procId: string, rootPid: number) {
        const children = await this.getChildPidsWindowsAsync(rootPid)
        log.debug(
            "start: %s shell pid=%s has %s direct child(ren): %s",
            procId,
            rootPid,
            children.length,
            children.map((c) => `pid=${c.pid} name=${c.name ?? "?"}`).join(", ") || "none",
        )
        const all = await this.collectDescendantsWindowsAsync(rootPid)
        if (all.length > 0) {
            log.debug(
                "start: %s all descendants of pid=%s: %s",
                procId,
                rootPid,
                all.map((d) => `pid=${d.pid} name=${d.name} depth=${d.depth}`).join("; "),
            )
        }
    }

    private async findDescendantPidWindowsAsync(rootPid: number): Promise<number | null> {
        const children = await this.getChildPidsWindowsAsync(rootPid)
        if (children.length === 0) return null
        const nonShell = children.find((c) => !this.isShellProcessName(c.name ?? ""))
        if (nonShell) return nonShell.pid
        const results = await Promise.all(children.map((c) => this.findDescendantPidWindowsAsync(c.pid)))
        return results.find((p) => p != null) ?? null
    }

    private killPid(pid: number, signal: string = "SIGTERM"): Promise<void> {
        return new Promise((resolve) => {
            log.debug("killPid: tree-kill pid=%s signal=%s", pid, signal)
            treeKill(pid, signal, (err) => {
                if (err) {
                    const notFound =
                        err.message?.toLowerCase().includes("not found") || err.message?.toLowerCase().includes("no such process")
                    if (notFound) {
                        log.debug("killPid: pid=%s already gone", pid)
                    } else {
                        log.debug("killPid: tree-kill pid=%s error=%s", pid, err.message)
                    }
                }
                resolve()
            })
        })
    }

    readLock(): Record<string, number[]> | null {
        const lockPath = this.getLockPath()
        log.debug("readLock: path=%s exists=%s", lockPath, fs.existsSync(lockPath))
        if (!fs.existsSync(lockPath)) return null
        try {
            const raw = fs.readFileSync(lockPath, "utf-8")
            const data = JSON.parse(raw) as unknown
            if (data == null || typeof data !== "object" || Array.isArray(data)) {
                log.debug("readLock: invalid shape, returning null")
                return null
            }
            const out: Record<string, number[]> = {}
            for (const [k, v] of Object.entries(data)) {
                if (typeof v === "number" && Number.isInteger(v)) out[k] = [v]
                else if (Array.isArray(v)) out[k] = v.filter((p): p is number => typeof p === "number" && Number.isInteger(p))
            }
            log.debug("readLock: parsed pids", JSON.stringify(out))
            return out
        } catch (err) {
            log.debug("readLock: error", err)
            return null
        }
    }

    persistLock() {
        const running: Record<string, number[]> = {}
        for (const [procId, state] of this.procs.entries()) {
            if (state.proc == null) continue
            const rootPid = state.proc.pid
            if (rootPid == null) continue
            const alive = isSpawnedHandle(state.proc) || this.isPidAlive(rootPid)
            if (alive) running[procId] = state.pidsForLock ?? [rootPid]
        }
        const lockPath = this.getLockPath()
        try {
            if (Object.keys(running).length === 0) {
                if (fs.existsSync(lockPath)) {
                    fs.unlinkSync(lockPath)
                    log.debug("persistLock: removed %s", lockPath)
                }
            } else {
                log.debug(`persistLock: path=${lockPath} content=${JSON.stringify(running)}`)
                fs.writeFileSync(lockPath, JSON.stringify(running, null, 0), "utf-8")
            }
        } catch (err) {
            log.debug("persistLock: failed", err)
        }
    }

    adopt(procId: string, pid: number): { ok: boolean; error?: string } {
        const state = this.procs.get(procId)
        if (!state) {
            log.debug("adopt: %s failed - unknown process", procId)
            return { ok: false, error: "Unknown process" }
        }
        if (state.proc) {
            log.debug("adopt: %s failed - already running", procId)
            return { ok: false, error: "Already running" }
        }
        if (!this.isPidAlive(pid)) {
            log.debug("adopt: %s failed - pid %s not alive", procId, pid)
            return { ok: false, error: "Process no longer running" }
        }
        log.debug("adopt: %s adopting existing pid=%s", procId, pid)
        state.proc = { pid }
        state.startTime = Date.now()
        this.listeners.started(procId)
        return { ok: true }
    }

    register(procId: string, config: ProcConfig, configDir: string) {
        this.procs.set(procId, {
            proc: null,
            config: { ...config, cwd: config.cwd?.replace("<CONFIG_DIR>", configDir) },
            configDir,
            lines: [],
            buffer: "",
            logStream: null,
            startTime: 0,
        })
    }

    start(procId: string): { ok: boolean; error?: string } {
        const state = this.procs.get(procId)
        if (!state) return { ok: false, error: "Unknown process" }
        if (state.proc) {
            if (isSpawnedHandle(state.proc) || this.isPidAlive(state.proc.pid)) {
                return { ok: false, error: "Already running" }
            }
            state.proc = null
        }

        const { config, configDir } = state
        const cwd = config.cwd ? path.resolve(configDir, config.cwd) : configDir
        const env = { ...process.env }
        if (config.env) {
            for (const [k, v] of Object.entries(config.env)) {
                if (v === null) delete env[k]
                else env[k] = v
            }
        }
        if (config.add_path?.length) {
            const add = Array.isArray(config.add_path) ? config.add_path.join(path.delimiter) : config.add_path
            env.PATH = add + path.delimiter + (env.PATH ?? "")
        }

        let child: ChildProcess
        try {
            if (config.shell != null) {
                const shell = process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : "/bin/sh"
                const flag = process.platform === "win32" ? "/c" : "-c"
                const shellCmd = process.platform === "win32" ? config.shell : "exec " + config.shell
                const spawnOpts: Parameters<typeof spawn>[2] = {
                    cwd,
                    env,
                    stdio: ["ignore", "pipe", "pipe"],
                    shell: false,
                }
                if (process.platform === "win32") {
                    ;(spawnOpts as { windowsVerbatimArguments?: boolean }).windowsVerbatimArguments = true
                }
                child = spawn(shell, [flag, shellCmd], spawnOpts)
            } else if (config.cmd?.length) {
                const [cmd, ...args] = config.cmd
                child = spawn(cmd, args, {
                    cwd,
                    env,
                    stdio: ["ignore", "pipe", "pipe"],
                    shell: false,
                })
            } else {
                return { ok: false, error: "Process has neither shell nor cmd" }
            }
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            return { ok: false, error: message }
        }

        const logDir = path.join(configDir, "oprocs")
        try {
            fs.mkdirSync(logDir, { recursive: true })
        } catch {
            // ignore
        }
        const logPath = path.join(logDir, `${sanitizeProcName(procId)}.log`)
        const logStream = fs.createWriteStream(logPath, { flags: "a" })

        state.proc = child
        state.logStream = logStream
        state.startTime = Date.now()

        const isWindowsCmd =
            process.platform === "win32" &&
            child.pid != null &&
            (config.shell != null ||
                (config.cmd?.length && (config.cmd[0] === "cmd" || String(config.cmd[0]).toLowerCase().endsWith("cmd.exe"))))
        if (isWindowsCmd) {
            const rootPid = child.pid!

            // Asynchronously getting the descendant pids because we need all of these to correctly
            // kill the process from the lockfile (only required if we had a hard crash/kill and restart oprocs)
            // this can take a while, so if we hard crash too early we may leave processes orphaned even on restart
            const tryResolve = async () => {
                if (state.proc !== child || state.pidsForLock != null) return
                await this.logDescendantTreeWindowsAsync(procId, rootPid)
                if (state.proc !== child || state.pidsForLock != null) return
                const descendants = await this.collectDescendantsWindowsAsync(rootPid)
                if (state.proc !== child || state.pidsForLock != null) return
                const pids = [rootPid, ...descendants.map((d) => d.pid)]
                if (pids.length > 0) {
                    state.pidsForLock = pids
                    const nonShell = await this.findDescendantPidWindowsAsync(rootPid)
                    if (nonShell != null) state.effectivePid = nonShell
                    log.debug(`start: ${procId} pidsForLock=${JSON.stringify(pids)}`)
                    this.persistLock()
                }
            }
            ;[400, 900, 1400].forEach((ms) =>
                setTimeout(() => {
                    tryResolve().catch((err) => log.debug(`start: ${procId} resolve failed`, err))
                }, ms),
            )
        }

        const push = (text: string, isStderr: boolean) => {
            state.buffer += text
            logStream.write(text)
            const parts = state.buffer.split("\n")
            state.buffer = parts.pop() ?? ""
            for (const line of parts) {
                state.lines.push(line)
                if (state.lines.length > MAX_LINES) state.lines.shift()
            }
            this.listeners.output({ procId, text, isStderr })
        }

        child.stdout?.on("data", (chunk: Buffer) => push(chunk.toString(), false))
        child.stderr?.on("data", (chunk: Buffer) => push(chunk.toString(), true))

        child.on("close", (code, _signal) => {
            if (state.buffer) {
                state.lines.push(state.buffer)
                if (state.lines.length > MAX_LINES) state.lines.shift()
                this.listeners.output({ procId, text: state.buffer, isStderr: false })
                state.buffer = ""
            }
            state.logStream?.end()
            state.logStream = null
            const wasUserStop = state.userRequestedStop
            state.userRequestedStop = false
            if (state.effectivePid != null) {
                state.proc = { pid: state.effectivePid }
            } else {
                state.proc = null
                this.persistLock()
                this.listeners.stopped({ procId, code: code ?? null })
                if (!wasUserStop) {
                    const uptime = (Date.now() - state.startTime) / 1000
                    if (config.autorestart && uptime > 1) {
                        setTimeout(() => this.start(procId), 500)
                    }
                }
            }
            if (state.proc != null) this.persistLock()
        })

        child.on("error", (err) => {
            this.listeners.output({ procId, text: err.message + "\n", isStderr: true })
        })

        log.debug("start: %s spawned new process pid=%s", procId, child.pid)
        this.listeners.started(procId)
        this.persistLock()
        return { ok: true }
    }

    stop(procId: string, options?: { skipPersistLock?: boolean }): { ok: boolean; error?: string } {
        const state = this.procs.get(procId)
        if (!state) return { ok: false, error: "Unknown process" }
        const handle = state.proc
        if (!handle) return { ok: true }

        this.appendSystemLine(procId, "[oprocs] stopped")
        state.userRequestedStop = true
        const rootPid = handle.pid
        if (rootPid == null) {
            if (!options?.skipPersistLock) this.persistLock()
            return { ok: true }
        }

        const stop = state.config.stop ?? "SIGTERM"
        const signal = stop === "hard-kill" ? "SIGKILL" : stop
        if (process.platform === "win32") {
            const taskkillExe = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe")
            spawnSync(taskkillExe, ["/pid", String(rootPid), "/T", "/F"], { stdio: "ignore", windowsHide: true, timeout: 5000 })
        } else {
            try {
                process.kill(rootPid, signal as NodeJS.Signals)
            } catch {
                // process may already be gone
            }
        }

        if (!isSpawnedHandle(handle)) {
            state.proc = null
            state.effectivePid = undefined
            state.pidsForLock = undefined
            this.listeners.stopped({ procId, code: null })
        }
        if (!options?.skipPersistLock) this.persistLock()
        return { ok: true }
    }

    restart(procId: string): Promise<{ ok: boolean; error?: string }> {
        this.stop(procId)
        this.appendSystemLine(procId, "[oprocs] restarted")
        return new Promise((resolve) => {
            setTimeout(() => resolve(this.start(procId)), 300)
        })
    }

    getLines(procId: string): string[] {
        const state = this.procs.get(procId)
        return state ? [...state.lines, ...(state.buffer ? [state.buffer] : [])] : []
    }

    private appendSystemLine(procId: string, text: string) {
        const state = this.procs.get(procId)
        if (!state) return
        const line = text.endsWith("\n") ? text : text + "\n"
        state.lines.push(line.trimEnd())
        if (state.lines.length > MAX_LINES) state.lines.shift()
        if (state.logStream) {
            state.logStream.write(line)
        } else {
            try {
                const logDir = path.join(state.configDir, "oprocs")
                fs.mkdirSync(logDir, { recursive: true })
                const logPath = path.join(logDir, `${sanitizeProcName(procId)}.log`)
                fs.appendFileSync(logPath, line, "utf-8")
            } catch {
                // ignore
            }
        }
        this.listeners.output({ procId, text: line, isStderr: false })
    }

    clear(procId: string) {
        const state = this.procs.get(procId)
        if (state) {
            state.lines = []
            state.buffer = ""
        }
    }

    getAllProcIds(): string[] {
        return Array.from(this.procs.keys())
    }

    isRunning(procId: string): boolean {
        const state = this.procs.get(procId)
        if (!state?.proc) return false
        const pid = state.effectivePid ?? state.proc.pid
        if (pid == null) return false
        if (isSpawnedHandle(state.proc)) return true
        if (this.isPidAlive(pid)) return true
        state.proc = null
        state.effectivePid = undefined
        state.pidsForLock = undefined
        this.persistLock()
        this.listeners.stopped({ procId, code: null })
        return false
    }

    unregister(procId: string) {
        this.stop(procId)
        this.procs.delete(procId)
    }

    unregisterAll() {
        log.debug("unregisterAll: stopping %s procs (skipPersistLock=true)", this.procs.size)
        for (const id of this.procs.keys()) {
            this.stop(id, { skipPersistLock: true })
        }
        this.procs.clear()
    }

    private readonly shutdownWaitMs = 5000

    shutdown(): Promise<void> {
        const running: [string, ProcHandle][] = []
        for (const [id, state] of this.procs.entries()) {
            if (state.proc) running.push([id, state.proc])
        }
        if (running.length === 0) {
            this.procs.clear()
            return Promise.resolve()
        }
        const waitForClose = (handle: ProcHandle) =>
            isSpawnedHandle(handle)
                ? new Promise<void>((resolve) => {
                      handle.once("close", () => resolve())
                      setTimeout(resolve, this.shutdownWaitMs)
                  })
                : Promise.resolve()
        for (const [procId] of running) {
            this.stop(procId)
        }
        return Promise.all(running.map(([, handle]) => waitForClose(handle))).then(() => {
            const lockPath = this.getLockPath()
            this.procs.clear()
            if (fs.existsSync(lockPath)) {
                try {
                    fs.unlinkSync(lockPath)
                    log.debug("shutdown: removed lock file %s", lockPath)
                } catch (err) {
                    log.debug("shutdown: failed to remove lock file %s", err)
                }
            }
        })
    }
}
