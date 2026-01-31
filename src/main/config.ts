import fs from "fs";
import path from "path";
import yaml from "js-yaml";
import type { MprocsConfig, ProcConfig } from "../shared/types.js";

const PLATFORM_MAP: Record<string, string> = {
  win32: "windows",
  darwin: "macos",
  linux: "linux",
  freebsd: "freebsd",
  openbsd: "openbsd",
  netbsd: "netbsd",
};

const resolveSelect = (value: unknown): unknown => {
  if (value == null || typeof value !== "object") return value;
  const obj = value as Record<string, unknown>;
  if (obj["$select"] === "os") {
    const platform = PLATFORM_MAP[process.platform] ?? process.platform;
    const osValue = obj[platform];
    if (osValue !== undefined) return osValue;
    return obj["$else"];
  }
  return value;
};

const resolveValue = (value: unknown): unknown => {
  const resolved = resolveSelect(value);
  if (resolved != null && typeof resolved === "object" && !Array.isArray(resolved)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(resolved)) {
      out[k] = resolveValue(v);
    }
    return out;
  }
  return resolved;
};

export const loadConfig = (configPath: string): { config: MprocsConfig; configDir: string } | { error: string } => {
  try {
    const resolved = path.resolve(configPath);
    if (!fs.existsSync(resolved)) {
      return { error: `Config file not found: ${resolved}` };
    }
    const raw = fs.readFileSync(resolved, "utf-8");
    const parsed = yaml.load(raw) as unknown;
    const resolvedParsed = resolveValue(parsed) as MprocsConfig;
    if (!resolvedParsed?.procs || typeof resolvedParsed.procs !== "object") {
      return { error: "Invalid config: missing or invalid 'procs' object" };
    }
    const configDir = path.dirname(resolved);
    const procs: Record<string, ProcConfig> = {};
    for (const [name, proc] of Object.entries(resolvedParsed.procs)) {
      if (proc && typeof proc === "object") {
        procs[name] = {
          shell: proc.shell != null ? String(resolveValue(proc.shell) ?? proc.shell) : undefined,
          cmd: Array.isArray(proc.cmd) ? proc.cmd.map((c) => String(c)) : undefined,
          cwd: proc.cwd != null ? String(proc.cwd).replace("<CONFIG_DIR>", configDir) : undefined,
          env: proc.env && typeof proc.env === "object" ? (resolveValue(proc.env) as Record<string, string | null>) : undefined,
          add_path: proc.add_path != null ? (Array.isArray(proc.add_path) ? proc.add_path : [proc.add_path]) : undefined,
          autostart: proc.autostart ?? true,
          autorestart: proc.autorestart ?? false,
          stop: proc.stop,
        };
      }
    }
    return { config: { procs }, configDir };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: `Failed to load config: ${message}` };
  }
};
