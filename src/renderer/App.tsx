import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { ProcessList } from "./ProcessList";
import { OutputPanel, type Match } from "./OutputPanel";
import { SearchBar, type SearchMode } from "./SearchBar";

const MAX_LINES = 10_000;

export type ProcInfo = {
  id: string;
  name: string;
  status: "running" | "stopped";
  exitCode: number | null;
};

export type ConfigState = {
  configPath: string;
  configDir: string;
  procs: ProcInfo[];
} | null;

declare global {
  interface Window {
    electronAPI?: {
      getDefaultConfigPath: () => Promise<string | null>;
      loadConfig: (configPath: string) => Promise<{ configPath: string; configDir: string; procs: { id: string; name: string }[]; runningIds?: string[] } | { error: string }>;
      startProc: (procId: string) => Promise<{ ok: boolean; error?: string }>;
      stopProc: (procId: string) => Promise<{ ok: boolean; error?: string }>;
      restartProc: (procId: string) => Promise<{ ok: boolean; error?: string }>;
      onProcessOutput: (fn: (data: { procId: string; text: string; isStderr: boolean }) => void) => void;
      onProcStarted: (fn: (procId: string) => void) => void;
      onProcStopped: (fn: (data: { procId: string; code: number | null }) => void) => void;
    };
  }
}

const api = window.electronAPI;

export default function App() {
  const [config, setConfig] = useState<ConfigState>(null);
  const [selectedProcId, setSelectedProcId] = useState<string | null>(null);
  const [outputByProc, setOutputByProc] = useState<Record<string, string>>({});

  const [searchQuery, setSearchQuery] = useState("");
  const [searchMode, setSearchMode] = useState<SearchMode>("substring");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [filterLines, setFilterLines] = useState(false);
  const [matches, setMatches] = useState<Match[]>([]);
  const [filteredIndices, setFilteredIndices] = useState<number[]>([]);
  const [currentMatchIndex, setCurrentMatchIndex] = useState(0);
  const searchIdRef = useRef(0);
  const workerRef = useRef<Worker | null>(null);

  const lines = useMemo(() => {
    if (!selectedProcId) return [];
    const raw = outputByProc[selectedProcId] ?? "";
    return raw ? raw.split("\n").slice(-MAX_LINES) : [];
  }, [selectedProcId, outputByProc]);

  const runSearch = useCallback(
    (queryOverride?: string) => {
      const q = queryOverride ?? searchQuery;
      if (!workerRef.current) return;
      const id = ++searchIdRef.current;
      workerRef.current.postMessage({
        id,
        lines,
        query: q,
        mode: searchMode,
        caseSensitive,
      });
    },
    [lines, searchQuery, searchMode, caseSensitive]
  );

  useEffect(() => {
    workerRef.current = new Worker(
      new URL("./workers/search.worker.ts", import.meta.url),
      { type: "module" }
    );
    const w = workerRef.current;
    w.onmessage = (e: MessageEvent<{ id: number; matches: Match[]; filteredLineIndices: number[] }>) => {
      if (e.data.id !== searchIdRef.current) return;
      setMatches(e.data.matches);
      setFilteredIndices(e.data.filteredLineIndices);
      setCurrentMatchIndex((prev) =>
        e.data.matches.length === 0 ? 0 : Math.min(prev, e.data.matches.length - 1)
      );
    };
    return () => {
      w.terminate();
      workerRef.current = null;
    };
  }, []);

  useEffect(() => {
    runSearch();
  }, [lines, searchMode, caseSensitive, runSearch]);

  const handleNextMatch = useCallback(() => {
    setCurrentMatchIndex((i) => (i + 1) % Math.max(1, matches.length));
  }, [matches.length]);

  const handlePrevMatch = useCallback(() => {
    setCurrentMatchIndex((i) =>
      i <= 0 ? Math.max(0, matches.length - 1) : i - 1
    );
  }, [matches.length]);

  useEffect(() => {
    if (!api || config !== null) return;
    api.getDefaultConfigPath().then((defaultPath) => {
      if (!defaultPath) return;
      api.loadConfig(defaultPath).then((result) => {
        if ("error" in result) return;
        const runningSet = new Set("runningIds" in result ? result.runningIds ?? [] : []);
        setConfig({
          configPath: result.configPath,
          configDir: result.configDir,
          procs: result.procs.map((p) => ({
            ...p,
            status: runningSet.has(p.id) ? ("running" as const) : ("stopped" as const),
            exitCode: null,
          })),
        });
        setSelectedProcId(result.procs[0]?.id ?? null);
      });
    });
  }, [api, config]);

  const ipcListenersRegistered = useRef(false);
  useEffect(() => {
    if (!api || ipcListenersRegistered.current) return;
    ipcListenersRegistered.current = true;
    api.onProcessOutput(({ procId, text }) => {
      setOutputByProc((prev) => ({ ...prev, [procId]: (prev[procId] ?? "") + text }));
    });
    api.onProcStarted((procId) => {
      setConfig((c) =>
        c
          ? {
            ...c,
            procs: c.procs.map((p) =>
              p.id === procId ? { ...p, status: "running" as const, exitCode: null } : p
            ),
          }
          : c
      );
    });
    api.onProcStopped(({ procId, code }) => {
      setConfig((c) =>
        c
          ? {
            ...c,
            procs: c.procs.map((p) =>
              p.id === procId ? { ...p, status: "stopped" as const, exitCode: code } : p
            ),
          }
          : c
      );
    });
  }, []);

  const openConfig = async () => {
    if (!api) return;
    const result = await api.loadConfig("");
    if ("error" in result) {
      console.error(result.error);
      return;
    }
    const runningSet = new Set("runningIds" in result ? result.runningIds ?? [] : []);
    setConfig({
      configPath: result.configPath,
      configDir: result.configDir,
      procs: result.procs.map((p) => ({
        ...p,
        status: runningSet.has(p.id) ? ("running" as const) : ("stopped" as const),
        exitCode: null,
      })),
    });
    setSelectedProcId(result.procs[0]?.id ?? null);
  };

  if (!config) {
    return (
      <div className="flex flex-1 min-h-0">
        <div className="flex-1 flex items-center justify-center text-slate-500">
          <button
            onClick={openConfig}
            className="px-4 py-2 border border-slate-600 rounded-md bg-slate-800 text-slate-200 cursor-pointer text-[13px] hover:bg-slate-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Open mprocs.yaml
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-1 min-h-0">
      <aside className="w-60 shrink-0 bg-slate-800 border-r border-slate-700 flex flex-col overflow-hidden">
        <div className="py-3 px-4 font-semibold border-b border-slate-700">oprocs</div>
        <div className="py-3 px-4 border-b border-slate-700">
          <button
            onClick={openConfig}
            type="button"
            className="px-4 py-2 border border-slate-600 rounded-md bg-slate-800 text-slate-200 cursor-pointer text-[13px] hover:bg-slate-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Change config
          </button>
        </div>
        <ProcessList
          procs={config.procs}
          selectedProcId={selectedProcId}
          onSelect={setSelectedProcId}
          onStart={(id: string) => api?.startProc(id)}
          onStop={(id: string) => api?.stopProc(id)}
          onRestart={(id: string) => api?.restartProc(id)}
        />
      </aside>
      <main className="flex-1 flex flex-col min-w-0">
        <SearchBar
          query={searchQuery}
          setQuery={setSearchQuery}
          mode={searchMode}
          setMode={setSearchMode}
          caseSensitive={caseSensitive}
          setCaseSensitive={setCaseSensitive}
          filterLines={filterLines}
          setFilterLines={setFilterLines}
          matchCount={matches.length}
          currentMatchIndex={currentMatchIndex}
          onNext={handleNextMatch}
          onPrev={handlePrevMatch}
          onSearch={(q) => runSearch(q)}
        />
        <OutputPanel
          procId={selectedProcId}
          procName={config.procs.find((p) => p.id === selectedProcId)?.name ?? ""}
          lines={lines}
          matches={matches}
          filteredIndices={filteredIndices}
          filterLines={filterLines}
          currentMatchIndex={currentMatchIndex}
        />
      </main>
    </div>
  );
}
