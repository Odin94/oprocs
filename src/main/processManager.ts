import { spawn, spawnSync, exec, execFile, execSync, type ChildProcess } from "child_process"
import { promisify } from "util"

const execAsync = promisify(exec)
const execFileAsync = promisify(execFile)
import fs from "fs"
import path from "path"
import treeKill from "tree-kill"
import type { PortOccupant, ProcConfig } from "../shared/types.js"
import { log } from "./logger.js"
import { type AppConfig, DEFAULT_APP_CONFIG, resolvePathTemplate } from "./appConfig.js"
import type { ProcessWatchdog } from "./processWatchdog.js"

const MAX_LINES = 10_000

const sanitizeProcName = (name: string): string => name.replace(/[/\\:*?"<>|]/g, "-").replace(/\s+/g, "-") || "proc"

const LOCK_FILE_NAME = ".oprocs.lock"

const normalizePort = (port: number): number | null => {
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null
    return port
}

const isCmdExe = (value: string): boolean => {
    const lower = value.toLowerCase()
    return lower === "cmd" || lower.endsWith("\\cmd.exe") || lower === "cmd.exe"
}

const isPowerShellExe = (value: string): boolean => {
    const lower = value.toLowerCase()
    return lower === "powershell" || lower === "powershell.exe" || lower.endsWith("\\powershell.exe")
}

const isPwshExe = (value: string): boolean => {
    const lower = value.toLowerCase()
    return lower === "pwsh" || lower === "pwsh.exe" || lower.endsWith("\\pwsh.exe")
}

export const withWindowsUtf8Shell = (command: string, shellExe: string): string => {
    if (isCmdExe(shellExe)) {
        return `chcp 65001>nul && ${command}`
    }
    if (isPowerShellExe(shellExe) || isPwshExe(shellExe)) {
        return `[Console]::InputEncoding=[Text.UTF8Encoding]::new($false); [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); ${command}`
    }
    return command
}

export const withWindowsUtf8CmdArgs = (cmd: string, args: string[]): string[] => {
    if (isCmdExe(cmd) && args.length >= 2 && args[0].toLowerCase() === "/c") {
        return [args[0], withWindowsUtf8Shell(args.slice(1).join(" "), cmd)]
    }

    const commandFlagIndex = args.findIndex((arg) => /^-(command|c)$/i.test(arg))
    if ((isPowerShellExe(cmd) || isPwshExe(cmd)) && commandFlagIndex >= 0 && commandFlagIndex + 1 < args.length) {
        const next = [...args]
        next[commandFlagIndex + 1] = withWindowsUtf8Shell(next[commandFlagIndex + 1], cmd)
        return next
    }

    return args
}

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

type StopOptions = {
    skipPersistLock?: boolean
    waitMs?: number
    escalateAfterWait?: boolean
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

    constructor(
        private appConfig: AppConfig = DEFAULT_APP_CONFIG,
        private watchdog?: ProcessWatchdog,
    ) {}

    on(events: Partial<ProcessManagerEvents>) {
        this.listeners = { ...this.listeners, ...events }
    }

    setConfigDir(dir: string) {
        this.configDir = dir
    }

    private finalizeStoppedProc(state: ProcState, procId: string, code: number | null) {
        state.proc = null
        state.effectivePid = undefined
        state.pidsForLock = undefined
        state.userRequestedStop = false
        this.persistLock()
        this.listeners.stopped({ procId, code })
    }

    private reconcileClosedProc(state: ProcState, procId: string, code: number | null, config: ProcConfig) {
        const wasUserStop = state.userRequestedStop
        if (state.effectivePid != null && !wasUserStop && this.isPidAlive(state.effectivePid)) {
            state.proc = { pid: state.effectivePid }
        } else {
            this.finalizeStoppedProc(state, procId, code)
            if (!wasUserStop) {
                const uptime = (Date.now() - state.startTime) / 1000
                if (config.autorestart && uptime > 1) {
                    setTimeout(() => this.start(procId), 500)
                }
            }
        }
        if (state.proc != null) this.persistLock()
    }

    private resolveLogDir(configDir: string): string {
        if (this.appConfig.logs_dir) {
            return resolvePathTemplate(this.appConfig.logs_dir, path.basename(configDir))
        }
        return path.join(configDir, ".oprocs")
    }

    private resolveLockDir(configDir: string): string {
        if (this.appConfig.lock_dir) {
            return resolvePathTemplate(this.appConfig.lock_dir, path.basename(configDir))
        }
        return path.join(configDir, ".oprocs")
    }

    private getLockPath(): string {
        return path.join(this.resolveLockDir(this.configDir), LOCK_FILE_NAME)
    }

    isPidAlive(pid: number): boolean {
        try {
            process.kill(pid, 0)
            return true
        } catch (err) {
            const code =
                err && typeof err === "object" && "code" in err ? (err as NodeJS.ErrnoException).code : undefined
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
                v.filter((p): p is number => typeof p === "number" && Number.isInteger(p)).forEach((p) =>
                    allPids.add(p),
                )
        }
        log.debug("killPidsFromLock: platform=%s attempting to kill %s pid(s)", process.platform, allPids.size)
        await Promise.all(
            [...allPids].map((pid) => {
                log.debug("killPidsFromLock: killing pid=%s", pid)
                return this.killProcessTree(pid)
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

    private async collectDescendantsWindowsAsync(
        rootPid: number,
    ): Promise<{ pid: number; name: string; depth: number }[]> {
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
                        err.message?.toLowerCase().includes("not found") ||
                        err.message?.toLowerCase().includes("no such process")
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

    private killProcessGroup(pid: number, signal: string): void {
        if (process.platform === "win32") return
        try {
            log.debug("killProcessGroup: pid=%s signal=%s", pid, signal)
            process.kill(-pid, signal as NodeJS.Signals)
        } catch (err) {
            const code =
                err && typeof err === "object" && "code" in err ? (err as NodeJS.ErrnoException).code : undefined
            if (code !== "ESRCH") log.debug("killProcessGroup: pid=%s error=%s", pid, code ?? err)
        }
    }

    private killProcessGroupSync(pid: number, signal: string): void {
        if (process.platform === "win32") return
        try {
            process.kill(-pid, signal as NodeJS.Signals)
        } catch (err) {
            const code =
                err && typeof err === "object" && "code" in err ? (err as NodeJS.ErrnoException).code : undefined
            if (code !== "ESRCH") log.debug("killProcessGroupSync: pid=%s error=%s", pid, code ?? err)
        }
    }

    private killWindowsProcessTreeSync(pid: number): void {
        const taskkillExe = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe")
        spawnSync(taskkillExe, ["/pid", String(pid), "/T", "/F"], {
            stdio: "ignore",
            windowsHide: true,
            timeout: 5000,
        })
    }

    private async killProcessTree(pid: number, signal: string = "SIGTERM"): Promise<void> {
        if (process.platform === "win32") {
            this.killWindowsProcessTreeSync(pid)
            return
        }

        this.killProcessGroup(pid, signal)
        await this.killPid(pid, signal)
    }

    private killProcessTreeSync(pid: number, signal: string = "SIGKILL"): void {
        if (process.platform === "win32") {
            this.killWindowsProcessTreeSync(pid)
            return
        }

        this.killProcessGroupSync(pid, signal)
        try {
            process.kill(pid, signal as NodeJS.Signals)
        } catch (err) {
            const code =
                err && typeof err === "object" && "code" in err ? (err as NodeJS.ErrnoException).code : undefined
            if (code !== "ESRCH") log.debug("killProcessTreeSync: pid=%s error=%s", pid, code ?? err)
        }
    }

    private parseLsofPortOccupants(port: number, stdout: string): PortOccupant[] {
        const occupants: PortOccupant[] = []
        let current: Partial<PortOccupant> = {}
        const flush = () => {
            if (current.pid != null) {
                occupants.push({
                    port,
                    pid: current.pid,
                    command: current.command || `pid ${current.pid}`,
                    detail: current.detail,
                })
            }
            current = {}
        }

        for (const rawLine of stdout.split(/\r?\n/)) {
            const line = rawLine.trim()
            if (!line) continue
            const field = line[0]
            const value = line.slice(1)
            if (field === "p") {
                flush()
                const pid = Number(value)
                if (Number.isInteger(pid)) current.pid = pid
            } else if (field === "c") {
                current.command = value
            } else if (field === "n") {
                current.detail = value
            }
        }
        flush()
        return occupants
    }

    private async getPortOccupantUnix(port: number): Promise<PortOccupant | null> {
        try {
            const { stdout } = await execFileAsync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpcn"], {
                encoding: "utf-8",
                timeout: 5000,
            })
            const occupants = this.parseLsofPortOccupants(port, String(stdout))
            return occupants[0] ?? null
        } catch (err) {
            log.debug("getPortOccupantUnix: lsof failed port=%s", port, err)
            if (process.platform !== "linux") return null
        }

        try {
            const { stdout } = await execFileAsync("ss", ["-ltnp", `sport = :${port}`], {
                encoding: "utf-8",
                timeout: 5000,
            })
            const match = /users:\(\("([^"]+)",pid=(\d+),/.exec(String(stdout))
            if (!match) return null
            return { port, pid: Number(match[2]), command: match[1], detail: `TCP *:${port}` }
        } catch (err) {
            log.debug("getPortOccupantUnix: ss failed port=%s", port, err)
            return null
        }
    }

    private parseNetstatPortOccupant(port: number, stdout: string): number | null {
        for (const rawLine of stdout.split(/\r?\n/)) {
            const line = rawLine.trim()
            if (!line.toUpperCase().startsWith("TCP")) continue
            const parts = line.split(/\s+/)
            if (parts.length < 5) continue
            const localAddress = parts[1]
            const state = parts[3]
            const pid = Number(parts[4])
            if (!Number.isInteger(pid) || state.toUpperCase() !== "LISTENING") continue
            if (localAddress.endsWith(`:${port}`)) return pid
        }
        return null
    }

    private parseTasklistCommand(stdout: string, pid: number): string {
        const firstLine = stdout
            .split(/\r?\n/)
            .map((line) => line.trim())
            .find(Boolean)
        if (!firstLine || firstLine.toUpperCase().includes("INFO:")) return `pid ${pid}`
        const csvMatch = /^"((?:[^"]|"")*)"/.exec(firstLine)
        if (!csvMatch) return firstLine.split(/\s+/)[0] || `pid ${pid}`
        return csvMatch[1].replace(/""/g, '"') || `pid ${pid}`
    }

    private async getPortOccupantWindows(port: number): Promise<PortOccupant | null> {
        try {
            const { stdout } = await execFileAsync("netstat.exe", ["-ano", "-p", "tcp"], {
                encoding: "utf-8",
                timeout: 5000,
            })
            const pid = this.parseNetstatPortOccupant(port, String(stdout))
            if (pid == null) return null
            let command = `pid ${pid}`
            try {
                const tasklist = await execFileAsync("tasklist.exe", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], {
                    encoding: "utf-8",
                    timeout: 5000,
                })
                command = this.parseTasklistCommand(String(tasklist.stdout), pid)
            } catch (err) {
                log.debug("getPortOccupantWindows: tasklist failed pid=%s", pid, err)
            }
            return { port, pid, command, detail: `TCP *:${port}` }
        } catch (err) {
            log.debug("getPortOccupantWindows: netstat failed port=%s", port, err)
            return null
        }
    }

    async getPortOccupant(port: number): Promise<PortOccupant | null> {
        const normalized = normalizePort(port)
        if (normalized == null) return null
        return process.platform === "win32"
            ? this.getPortOccupantWindows(normalized)
            : this.getPortOccupantUnix(normalized)
    }

    async killPortOccupant(port: number): Promise<{ ok: boolean; occupant?: PortOccupant; error?: string }> {
        const normalized = normalizePort(port)
        if (normalized == null) return { ok: false, error: "Invalid port" }

        const occupant = await this.getPortOccupant(normalized)
        if (!occupant) return { ok: false, error: "No listening process found for that port" }

        await this.killPid(occupant.pid, "SIGTERM")
        await new Promise((resolve) => setTimeout(resolve, 500))

        const stillOccupant = await this.getPortOccupant(normalized)
        if (stillOccupant?.pid === occupant.pid) {
            await this.killPid(occupant.pid, "SIGKILL")
            await new Promise((resolve) => setTimeout(resolve, 300))
            const remainingOccupant = await this.getPortOccupant(normalized)
            if (remainingOccupant?.pid === occupant.pid) {
                return { ok: false, occupant, error: `Could not kill pid ${occupant.pid}` }
            }
        }

        return { ok: true, occupant }
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
                else if (Array.isArray(v))
                    out[k] = v.filter((p): p is number => typeof p === "number" && Number.isInteger(p))
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
                const shellCmd =
                    process.platform === "win32" ? withWindowsUtf8Shell(config.shell, shell) : "exec " + config.shell
                const spawnOpts: Parameters<typeof spawn>[2] = {
                    cwd,
                    env,
                    stdio: ["ignore", "pipe", "pipe"],
                    shell: false,
                    detached: process.platform !== "win32",
                }
                if (process.platform === "win32") {
                    ;(spawnOpts as { windowsVerbatimArguments?: boolean }).windowsVerbatimArguments = true
                }
                child = spawn(shell, [flag, shellCmd], spawnOpts)
            } else if (config.cmd?.length) {
                const [cmd, ...args] = config.cmd
                const effectiveArgs = process.platform === "win32" ? withWindowsUtf8CmdArgs(cmd, args) : args
                child = spawn(cmd, effectiveArgs, {
                    cwd,
                    env,
                    stdio: ["ignore", "pipe", "pipe"],
                    shell: false,
                    detached: process.platform !== "win32",
                })
            } else {
                return { ok: false, error: "Process has neither shell nor cmd" }
            }
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            return { ok: false, error: message }
        }
        if (child.pid != null) this.watchdog?.track(child.pid)

        const logDir = this.resolveLogDir(configDir)
        let logStream: fs.WriteStream | null = null
        if (!this.appConfig.no_logs) {
            try {
                fs.mkdirSync(logDir, { recursive: true })
            } catch {
                // ignore
            }
            const logPath = path.join(logDir, `${sanitizeProcName(procId)}.log`)
            logStream = fs.createWriteStream(logPath, { flags: "a" })
        }

        state.proc = child
        state.logStream = logStream
        state.startTime = Date.now()

        const isWindowsCmd =
            process.platform === "win32" &&
            child.pid != null &&
            (config.shell != null ||
                (config.cmd?.length &&
                    (config.cmd[0] === "cmd" || String(config.cmd[0]).toLowerCase().endsWith("cmd.exe"))))
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
            logStream?.write(text)
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
            this.reconcileClosedProc(state, procId, code ?? null, config)
        })

        child.on("error", (err) => {
            this.listeners.output({ procId, text: err.message + "\n", isStderr: true })
        })

        log.debug("start: %s spawned new process pid=%s", procId, child.pid)
        this.listeners.started(procId)
        this.persistLock()
        return { ok: true }
    }

    private waitForClose(handle: ChildProcess, timeoutMs: number): Promise<boolean> {
        return new Promise((resolve) => {
            let settled = false
            let timeout: NodeJS.Timeout | undefined
            const finish = (closed: boolean) => {
                if (settled) return
                settled = true
                if (timeout) clearTimeout(timeout)
                handle.off("close", onClose)
                resolve(closed)
            }
            const onClose = () => finish(true)
            handle.once("close", onClose)
            timeout = setTimeout(() => finish(false), timeoutMs)
        })
    }

    async stop(procId: string, options?: StopOptions): Promise<{ ok: boolean; error?: string }> {
        const state = this.procs.get(procId)
        if (!state) return { ok: false, error: "Unknown process" }
        const handle = state.proc
        if (!handle) return { ok: true }

        this.appendSystemLine(procId, "[oprocs] stopped")
        state.userRequestedStop = true
        const rootPid = handle.pid
        if (rootPid == null) {
            this.finalizeStoppedProc(state, procId, null)
            return { ok: true }
        }

        const stop = state.config.stop ?? "SIGTERM"
        const signal = stop === "hard-kill" ? "SIGKILL" : stop
        const waitForClose =
            isSpawnedHandle(handle) && options?.waitMs != null ? this.waitForClose(handle, options.waitMs) : null
        await this.killProcessTree(rootPid, signal)

        if (!isSpawnedHandle(handle)) {
            this.finalizeStoppedProc(state, procId, null)
            return { ok: true }
        }
        if (!options?.skipPersistLock) this.persistLock()
        const closed = waitForClose ? await waitForClose : true
        if (!closed && options?.escalateAfterWait && signal !== "SIGKILL") {
            const hardKillClose = this.waitForClose(handle, this.shutdownKillWaitMs)
            await this.killProcessTree(rootPid, "SIGKILL")
            await hardKillClose
        }
        return { ok: true }
    }

    async restart(procId: string): Promise<{ ok: boolean; error?: string }> {
        await this.stop(procId, { waitMs: 300 })
        this.appendSystemLine(procId, "[oprocs] restarted")
        return this.start(procId)
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
        } else if (!this.appConfig.no_logs) {
            try {
                const logDir = this.resolveLogDir(state.configDir)
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
        this.finalizeStoppedProc(state, procId, null)
        return false
    }

    async unregister(procId: string) {
        await this.stop(procId)
        this.procs.delete(procId)
    }

    async unregisterAll() {
        log.debug("unregisterAll: stopping %s procs (skipPersistLock=true)", this.procs.size)
        await Promise.all([...this.procs.keys()].map((id) => this.stop(id, { skipPersistLock: true })))
        this.procs.clear()
    }

    private readonly shutdownWaitMs = 5000
    private readonly shutdownKillWaitMs = 1000

    async shutdown(): Promise<void> {
        const running: [string, ProcHandle][] = []
        for (const [id, state] of this.procs.entries()) {
            if (state.proc) running.push([id, state.proc])
        }
        if (running.length === 0) {
            this.procs.clear()
            this.watchdog?.shutdown()
            return
        }
        await Promise.all(
            running.map(([procId]) =>
                this.stop(procId, {
                    waitMs: this.shutdownWaitMs,
                    escalateAfterWait: true,
                }),
            ),
        )
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
        this.watchdog?.shutdown()
    }

    shutdownSync() {
        const rootPids: number[] = []
        for (const state of this.procs.values()) {
            const pid = state.proc?.pid
            if (pid != null) rootPids.push(pid)
        }
        for (const pid of rootPids) {
            this.killProcessTreeSync(pid)
        }
        const lockPath = this.getLockPath()
        this.procs.clear()
        try {
            if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath)
        } catch (err) {
            log.debug("shutdownSync: failed to remove lock file %s", err)
        }
        this.watchdog?.shutdown()
    }
}
