import type { ProcInfo } from "./App";

type ProcessListProps = {
  procs: ProcInfo[];
  selectedProcId: string | null;
  onSelect: (id: string) => void;
  onStart: (id: string) => Promise<unknown>;
  onStop: (id: string) => Promise<unknown>;
  onRestart: (id: string) => Promise<unknown>;
};

export const ProcessList = ({
  procs,
  selectedProcId,
  onSelect,
  onStart,
  onStop,
  onRestart,
}: ProcessListProps) => (
  <div className="flex-1 overflow-y-auto py-2">
    {procs.map((proc) => (
      <div
        key={proc.id}
        role="button"
        tabIndex={0}
        className={`flex flex-col gap-1.5 py-2.5 px-4 cursor-pointer rounded-md mx-2 hover:bg-slate-700 ${
          selectedProcId === proc.id ? "bg-slate-600" : ""
        }`}
        onClick={() => onSelect(proc.id)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onSelect(proc.id);
          }
        }}
      >
        <div className="flex items-center gap-2 min-w-0">
          <span
            className={`shrink-0 w-2 h-2 rounded-full ${
              proc.status === "running" ? "bg-green-500" : "bg-slate-500"
            }`}
            title={proc.status === "running" ? "Running" : proc.exitCode != null ? `Exit ${proc.exitCode}` : "Stopped"}
          />
          <span className="flex-1 min-w-0 overflow-hidden text-ellipsis">{proc.name}</span>
        </div>
        <div className="flex gap-1.5 pl-4">
          {proc.status === "stopped" ? (
            <button
              type="button"
              className="py-0.5 px-1.5 text-[11px] border border-slate-600 rounded-md bg-slate-800 text-slate-200 cursor-pointer hover:bg-slate-700 disabled:opacity-50 disabled:cursor-not-allowed"
              onClick={(e) => {
                e.stopPropagation();
                onStart(proc.id);
              }}
            >
              Start
            </button>
          ) : (
            <>
              <button
                type="button"
                className="py-0.5 px-1.5 text-[11px] border border-slate-600 rounded-md bg-slate-800 text-slate-200 cursor-pointer hover:bg-slate-700 disabled:opacity-50 disabled:cursor-not-allowed"
                onClick={(e) => {
                  e.stopPropagation();
                  onStop(proc.id);
                }}
              >
                Stop
              </button>
              <button
                type="button"
                className="py-0.5 px-1.5 text-[11px] border border-slate-600 rounded-md bg-slate-800 text-slate-200 cursor-pointer hover:bg-slate-700 disabled:opacity-50 disabled:cursor-not-allowed"
                onClick={(e) => {
                  e.stopPropagation();
                  onRestart(proc.id);
                }}
              >
                Restart
              </button>
            </>
          )}
        </div>
      </div>
    ))}
  </div>
);
