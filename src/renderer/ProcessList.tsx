import type { ProcInfo } from "./App";
import {
  ExternalLinkIcon,
  FlowerIcon,
  PlayIcon,
  RotateCwIcon,
  SquareIcon,
  TerminalIcon,
} from "./icons";
import { ProcessListActions } from "./ProcessListActions";

type ProcessListProps = {
  procs: ProcInfo[];
  selectedProcId: string | null;
  onSelect: (id: string) => void;
  onStart: (id: string) => Promise<unknown>;
  onStop: (id: string) => Promise<unknown>;
  onRestart: (id: string) => Promise<unknown>;
  theme: "tech" | "cozy";
  onToggleTheme: () => void;
  onOpenConfig: () => void;
};

const api = window.electronAPI;

const chipButtonCls =
  "flex items-center gap-1 rounded-md border border-accent/30 bg-accent/10 px-1.5 py-0.5 text-[10px] font-medium text-accent transition-colors hover:bg-accent/20";

function StatusDot({ proc }: { proc: ProcInfo }) {
  const className =
    proc.status === "running"
      ? "bg-status-running animate-pulse-dot"
      : proc.exitCode != null && proc.exitCode !== 0
        ? "bg-status-stopped"
        : "bg-status-idle";

  return <span className={`inline-block h-2 w-2 rounded-full ${className}`} />;
}

export const ProcessList = ({
  procs,
  selectedProcId,
  onSelect,
  onStart,
  onStop,
  onRestart,
  theme,
  onToggleTheme,
  onOpenConfig,
}: ProcessListProps) => {
  const runningProcs = procs.filter((proc) => proc.status === "running");
  const stoppedProcs = procs.filter((proc) => proc.status === "stopped");
  const hasRunningProcs = runningProcs.length > 0;
  const hasProcs = procs.length > 0;

  const handleStopAll = () => {
    runningProcs.forEach((proc) => {
      void onStop(proc.id);
    });
  };

  const handleRestartAll = () => {
    runningProcs.forEach((proc) => {
      void onRestart(proc.id);
    });
    stoppedProcs.forEach((proc) => {
      void onStart(proc.id);
    });
  };

  return (
    <aside className="cozy-sidebar-shell flex h-full w-64 flex-col border-r border-border bg-card">
      <div className="cozy-sidebar-section flex items-center justify-between border-b border-border px-4 py-3">
        <h1 className="text-sm font-semibold tracking-wide text-foreground">
          oprocs
        </h1>
        <button
          type="button"
          onClick={onToggleTheme}
          className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-surface-hover hover:text-foreground"
          title={`Switch to ${theme === "tech" ? "cozy" : "tech"} theme`}
        >
          {theme === "tech" ? (
            <>
              <FlowerIcon className="h-3.5 w-3.5" />
              cozy
            </>
          ) : (
            <>
              <TerminalIcon className="h-3.5 w-3.5" />
              tech
            </>
          )}
        </button>
      </div>
      <div className="cozy-sidebar-section border-b border-border p-3">
        <button
          type="button"
          onClick={onOpenConfig}
          className="cozy-sidebar-button flex w-full items-center justify-center rounded-md bg-surface px-3 py-2 text-xs font-medium text-secondary-foreground transition-colors hover:bg-surface-hover"
        >
          Change config
        </button>
      </div>
      <nav className="cozy-sidebar-nav flex-1 overflow-y-auto p-2 scrollbar-thin">
        <div className="space-y-1">
          {procs.map((proc) => (
            <div
              key={proc.id}
              role="button"
              tabIndex={0}
              className={`cozy-sidebar-card group cursor-pointer rounded-lg px-3 py-2.5 transition-all ${
                selectedProcId === proc.id
                  ? "bg-surface-active"
                  : "hover:bg-surface-hover"
              }`}
              onClick={() => onSelect(proc.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onSelect(proc.id);
                }
              }}
            >
              <div className="flex items-center gap-2.5 min-w-0">
                <StatusDot proc={proc} />
                <span className="flex-1 min-w-0 overflow-hidden text-ellipsis text-sm font-medium text-foreground">
                  {proc.name}
                </span>
                {proc.openUrl ? (
                  <button
                    type="button"
                    className={`${chipButtonCls} cozy-sidebar-chip`}
                    onClick={(e) => {
                      e.stopPropagation();
                      void api?.openExternalLink(proc.openUrl!);
                    }}
                    title={proc.openUrl}
                  >
                    <ExternalLinkIcon className="h-2.5 w-2.5" />
                    Open
                  </button>
                ) : null}
              </div>
              <div className="mt-1.5 flex items-center gap-1 pl-[18px]">
                <span className="flex-1 truncate font-mono text-xs text-muted-foreground">
                  {proc.status === "running"
                    ? "running"
                    : proc.exitCode != null
                      ? `stopped with exit ${proc.exitCode}`
                      : "stopped"}
                </span>
                <div
                  className={`flex gap-0.5 transition-opacity ${
                    selectedProcId === proc.id
                      ? "opacity-100"
                      : "opacity-0 group-hover:opacity-100"
                  }`}
                >
                  {proc.status === "stopped" ? (
                    <button
                      type="button"
                      className="rounded p-1 text-muted-foreground transition-colors hover:bg-primary/20 hover:text-primary"
                      onClick={(e) => {
                        e.stopPropagation();
                        void onStart(proc.id);
                      }}
                      title="Start"
                    >
                      <PlayIcon className="h-3 w-3" />
                    </button>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="rounded p-1 text-muted-foreground transition-colors hover:bg-destructive/20 hover:text-destructive"
                        onClick={(e) => {
                          e.stopPropagation();
                          void onStop(proc.id);
                        }}
                        title="Stop"
                      >
                        <SquareIcon className="h-3 w-3" />
                      </button>
                      <button
                        type="button"
                        className="rounded p-1 text-muted-foreground transition-colors hover:bg-primary/20 hover:text-primary"
                        onClick={(e) => {
                          e.stopPropagation();
                          void onRestart(proc.id);
                        }}
                        title="Restart"
                      >
                        <RotateCwIcon className="h-3 w-3" />
                      </button>
                    </>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      </nav>
      <ProcessListActions
        onStopAll={handleStopAll}
        onRestartAll={handleRestartAll}
        stopAllDisabled={!hasRunningProcs}
        restartAllDisabled={!hasProcs}
      />
    </aside>
  );
};
