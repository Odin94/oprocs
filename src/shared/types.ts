export type ProcConfig = {
  shell?: string;
  cmd?: string[];
  cwd?: string;
  env?: Record<string, string | null>;
  add_path?: string | string[];
  autostart?: boolean;
  autorestart?: boolean;
  stop?: "SIGINT" | "SIGTERM" | "SIGKILL" | "hard-kill";
};

export type MprocsConfig = {
  procs: Record<string, ProcConfig>;
};
