import { spawn, execSync, type ChildProcess } from "child_process";
import fs from "fs";
import path from "path";
import type { ProcConfig } from "../shared/types.js";

const MAX_LINES = 10_000;

const sanitizeProcName = (name: string): string =>
  name.replace(/[/\\:*?"<>|]/g, "-").replace(/\s+/g, "-") || "proc";

type ProcState = {
  proc: ChildProcess | null;
  config: ProcConfig;
  configDir: string;
  lines: string[];
  buffer: string;
  logStream: fs.WriteStream | null;
  startTime: number;
  userRequestedStop?: boolean;
};

export type ProcessManagerEvents = {
  output: (data: { procId: string; text: string; isStderr: boolean }) => void;
  started: (procId: string) => void;
  stopped: (data: { procId: string; code: number | null }) => void;
};

export class ProcessManager {
  private procs = new Map<string, ProcState>();
  private configDir = "";
  private listeners: ProcessManagerEvents = {
    output: () => {},
    started: () => {},
    stopped: () => {},
  };

  on(events: Partial<ProcessManagerEvents>) {
    this.listeners = { ...this.listeners, ...events };
  }

  setConfigDir(dir: string) {
    this.configDir = dir;
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
    });
  }

  start(procId: string): { ok: boolean; error?: string } {
    const state = this.procs.get(procId);
    if (!state) return { ok: false, error: "Unknown process" };
    if (state.proc) return { ok: false, error: "Already running" };

    const { config, configDir } = state;
    const cwd = config.cwd ? path.resolve(configDir, config.cwd) : configDir;
    const env = { ...process.env };
    if (config.env) {
      for (const [k, v] of Object.entries(config.env)) {
        if (v === null) delete env[k];
        else env[k] = v;
      }
    }
    if (config.add_path?.length) {
      const add = Array.isArray(config.add_path) ? config.add_path.join(path.delimiter) : config.add_path;
      env.PATH = add + path.delimiter + (env.PATH ?? "");
    }

    let child: ChildProcess;
    try {
      if (config.shell != null) {
        const shell = process.platform === "win32" ? process.env.ComSpec ?? "cmd.exe" : "/bin/sh";
        const flag = process.platform === "win32" ? "/c" : "-c";
        const spawnOpts: Parameters<typeof spawn>[2] = {
          cwd,
          env,
          stdio: ["ignore", "pipe", "pipe"],
          shell: false,
        };
        if (process.platform === "win32") {
          (spawnOpts as { windowsVerbatimArguments?: boolean }).windowsVerbatimArguments = true;
        }
        child = spawn(shell, [flag, config.shell], spawnOpts);
      } else if (config.cmd?.length) {
        const [cmd, ...args] = config.cmd;
        child = spawn(cmd, args, {
          cwd,
          env,
          stdio: ["ignore", "pipe", "pipe"],
          shell: false,
        });
      } else {
        return { ok: false, error: "Process has neither shell nor cmd" };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: message };
    }

    const logDir = path.join(configDir, "oprocs");
    try {
      fs.mkdirSync(logDir, { recursive: true });
    } catch {
      // ignore
    }
    const logPath = path.join(logDir, `${sanitizeProcName(procId)}.log`);
    const logStream = fs.createWriteStream(logPath, { flags: "a" });

    state.proc = child;
    state.logStream = logStream;
    state.startTime = Date.now();

    const push = (text: string, isStderr: boolean) => {
      state.buffer += text;
      logStream.write(text);
      const parts = state.buffer.split("\n");
      state.buffer = parts.pop() ?? "";
      for (const line of parts) {
        state.lines.push(line);
        if (state.lines.length > MAX_LINES) state.lines.shift();
      }
      this.listeners.output({ procId, text, isStderr });
    };

    child.stdout?.on("data", (chunk: Buffer) => push(chunk.toString(), false));
    child.stderr?.on("data", (chunk: Buffer) => push(chunk.toString(), true));

    child.on("close", (code, signal) => {
      if (state.buffer) {
        state.lines.push(state.buffer);
        if (state.lines.length > MAX_LINES) state.lines.shift();
        this.listeners.output({ procId, text: state.buffer, isStderr: false });
        state.buffer = "";
      }
      state.proc = null;
      state.logStream?.end();
      state.logStream = null;
      const wasUserStop = state.userRequestedStop;
      state.userRequestedStop = false;
      this.listeners.stopped({ procId, code: code ?? null });

      if (!wasUserStop) {
        const uptime = (Date.now() - state.startTime) / 1000;
        if (config.autorestart && uptime > 1) {
          setTimeout(() => this.start(procId), 500);
        }
      }
    });

    child.on("error", (err) => {
      this.listeners.output({ procId, text: err.message + "\n", isStderr: true });
    });

    this.listeners.started(procId);
    return { ok: true };
  }

  stop(procId: string): { ok: boolean; error?: string } {
    const state = this.procs.get(procId);
    if (!state) return { ok: false, error: "Unknown process" };
    if (!state.proc) return { ok: true };

    state.userRequestedStop = true;
    const proc = state.proc;

    if (process.platform === "win32") {
      try {
        execSync(`taskkill /pid ${proc.pid} /T /F`, { stdio: "ignore" });
      } catch {
        proc.kill("SIGKILL");
      }
    } else {
      const stop = state.config.stop ?? "SIGTERM";
      if (stop === "SIGKILL" || stop === "hard-kill") {
        proc.kill("SIGKILL");
      } else {
        proc.kill(stop as NodeJS.Signals);
      }
    }
    return { ok: true };
  }

  restart(procId: string): Promise<{ ok: boolean; error?: string }> {
    this.stop(procId);
    return new Promise((resolve) => {
      setTimeout(() => resolve(this.start(procId)), 300);
    });
  }

  getLines(procId: string): string[] {
    const state = this.procs.get(procId);
    return state ? [...state.lines, ...(state.buffer ? [state.buffer] : [])] : [];
  }

  clear(procId: string) {
    const state = this.procs.get(procId);
    if (state) {
      state.lines = [];
      state.buffer = "";
    }
  }

  getAllProcIds(): string[] {
    return Array.from(this.procs.keys());
  }

  isRunning(procId: string): boolean {
    return this.procs.get(procId)?.proc != null;
  }

  unregister(procId: string) {
    this.stop(procId);
    this.procs.delete(procId);
  }

  unregisterAll() {
    for (const id of this.procs.keys()) {
      this.stop(id);
    }
    this.procs.clear();
  }
}
