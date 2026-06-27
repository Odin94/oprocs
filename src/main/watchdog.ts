import { spawnSync } from "node:child_process"
import path from "node:path"

type WatchdogMessage = { type: "track"; pid: number } | { type: "shutdown" }

const expectedParentPid = Number(process.argv[2])
const trackedPids = new Set<number>()
let inputBuffer = ""
let cleaningUp = false

const isAlive = (pid: number): boolean => {
    try {
        process.kill(process.platform === "win32" ? pid : -pid, 0)
        return true
    } catch (err) {
        return (
            err != null && typeof err === "object" && "code" in err && (err as NodeJS.ErrnoException).code === "EPERM"
        )
    }
}

const signalGroup = (pid: number, signal: NodeJS.Signals): void => {
    try {
        process.kill(-pid, signal)
    } catch {
        // The process group may already be gone.
    }
}

const killWindowsTree = (pid: number): void => {
    const taskkillExe = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe")
    spawnSync(taskkillExe, ["/pid", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
        timeout: 5000,
    })
}

const cleanup = (): void => {
    if (cleaningUp) return
    cleaningUp = true
    clearInterval(parentCheck)
    clearInterval(pruneCheck)

    if (process.platform === "win32") {
        for (const pid of trackedPids) killWindowsTree(pid)
        process.exit(0)
    }

    for (const pid of trackedPids) signalGroup(pid, "SIGTERM")
    setTimeout(() => {
        for (const pid of trackedPids) {
            if (isAlive(pid)) signalGroup(pid, "SIGKILL")
        }
        process.exit(0)
    }, 1000)
}

const handleMessage = (line: string): void => {
    try {
        const message = JSON.parse(line) as WatchdogMessage
        if (message.type === "shutdown") {
            cleanup()
        } else if (message.type === "track" && Number.isInteger(message.pid) && message.pid > 0) {
            trackedPids.add(message.pid)
        }
    } catch {
        // Ignore malformed or partial messages.
    }
}

process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk: string) => {
    inputBuffer += chunk
    const lines = inputBuffer.split("\n")
    inputBuffer = lines.pop() ?? ""
    for (const line of lines) {
        if (line) handleMessage(line)
    }
})
process.stdin.on("end", cleanup)
process.stdin.on("error", cleanup)
process.on("SIGTERM", cleanup)
process.on("SIGINT", cleanup)

const parentCheck = setInterval(() => {
    if (Number.isInteger(expectedParentPid) && expectedParentPid > 0 && process.ppid !== expectedParentPid) cleanup()
}, 250)

const pruneCheck = setInterval(() => {
    for (const pid of trackedPids) {
        if (!isAlive(pid)) trackedPids.delete(pid)
    }
}, 1000)
