import { spawn, type ChildProcess } from "node:child_process"

export interface ProcessWatchdog {
    track(pid: number): void
    shutdown(): void
}

type WatchdogMessage = { type: "track"; pid: number } | { type: "shutdown" }

export class ProcessWatchdogClient implements ProcessWatchdog {
    private child: ChildProcess | null = null

    constructor(private readonly helperPath: string) {}

    start(): void {
        this.ensureStarted()
    }

    track(pid: number): void {
        if (!Number.isInteger(pid) || pid <= 0) return
        const child = this.ensureStarted()
        this.send(child, { type: "track", pid })
    }

    shutdown(): void {
        const child = this.child
        this.child = null
        if (!child?.stdin || child.stdin.destroyed) return

        child.stdin.end(JSON.stringify({ type: "shutdown" } satisfies WatchdogMessage) + "\n")
    }

    private ensureStarted(): ChildProcess {
        if (this.child && this.child.exitCode == null && !this.child.killed) return this.child

        const child = spawn(process.execPath, [this.helperPath, String(process.pid)], {
            detached: true,
            env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
            stdio: ["pipe", "ignore", "ignore"],
            windowsHide: true,
        })
        this.child = child

        child.stdin?.on("error", () => {
            // A closed pipe means the helper is already gone.
        })
        child.on("error", () => {
            if (this.child === child) this.child = null
        })
        child.on("exit", () => {
            if (this.child === child) this.child = null
        })

        child.unref()
        const stdin = child.stdin as (NodeJS.WritableStream & { unref?: () => void }) | null
        stdin?.unref?.()
        return child
    }

    private send(child: ChildProcess, message: WatchdogMessage): void {
        if (!child.stdin || child.stdin.destroyed) return
        child.stdin.write(JSON.stringify(message) + "\n")
    }
}
