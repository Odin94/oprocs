import { useState, useEffect, useRef, useCallback, useMemo } from "react"
import { toast } from "sonner"
import type { PortOccupant } from "../shared/types"
import { ProcessList } from "./ProcessList"
import { OutputPanel, type Match } from "./OutputPanel"
import { SearchBar, type SearchMode } from "./SearchBar"
import { XIcon } from "./icons"
import { getOpenUrl } from "./utils/openUrl"
import { findPortConflict } from "./utils/portConflicts"

const MAX_LINES = 10_000
const ANIMATION_SETTING_STORAGE_KEY = "oprocs:disable-log-animations"

export type ProcInfo = {
    id: string
    name: string
    status: "running" | "stopped"
    exitCode: number | null
    openUrl?: string
    portConflict?: {
        port: number
        detectedAt: number
    }
}

export type ConfigState = {
    configPath: string
    configDir: string
    procs: ProcInfo[]
} | null

declare global {
    interface Window {
        electronAPI?: {
            getAppConfig: () => Promise<{ disable_animations?: boolean }>
            getDefaultConfigPath: () => Promise<string | null>
            loadConfig: (configPath: string) => Promise<
                | {
                      configPath: string
                      configDir: string
                      procs: { id: string; name: string }[]
                      runningIds?: string[]
                      normalizedProcNames?: string[]
                  }
                | { error: string }
            >
            startProc: (procId: string) => Promise<{ ok: boolean; error?: string }>
            stopProc: (procId: string) => Promise<{ ok: boolean; error?: string }>
            restartProc: (procId: string) => Promise<{ ok: boolean; error?: string }>
            getPortOccupant: (port: number) => Promise<PortOccupant | null>
            killPortOccupant: (port: number) => Promise<{ ok: boolean; occupant?: PortOccupant; error?: string }>
            onProcessOutput: (fn: (data: { procId: string; text: string; isStderr: boolean }) => void) => void
            onProcStarted: (fn: (procId: string) => void) => void
            onProcStopped: (fn: (data: { procId: string; code: number | null }) => void) => void
            checkForUpdates: () => Promise<void>
            quitAndInstall: () => Promise<void>
            onUpdateAvailable: (fn: (version: string) => void) => void
            onUpdateDownloaded: (fn: (version: string) => void) => void
            onUpdateError: (fn: (message: string) => void) => void
            openExternalLink: (url: string) => Promise<void>
        }
    }
}

const api = window.electronAPI

const readStoredDisableAnimations = () => {
    try {
        const stored = window.localStorage.getItem(ANIMATION_SETTING_STORAGE_KEY)
        return stored === null ? null : stored === "true"
    } catch {
        return null
    }
}

const storeDisableAnimations = (value: boolean) => {
    try {
        window.localStorage.setItem(ANIMATION_SETTING_STORAGE_KEY, String(value))
    } catch {
        // Ignore storage failures; the setting still applies for this session.
    }
}

export default function App() {
    const [theme, setTheme] = useState<"tech" | "cozy">("tech")
    const [disableAnimations, setDisableAnimations] = useState(() => readStoredDisableAnimations() ?? false)
    const [settingsOpen, setSettingsOpen] = useState(false)
    const [config, setConfig] = useState<ConfigState>(null)
    const [selectedProcId, setSelectedProcId] = useState<string | null>(null)
    const [outputByProc, setOutputByProc] = useState<Record<string, string>>({})

    const [searchQuery, setSearchQuery] = useState("")
    const [searchMode, setSearchMode] = useState<SearchMode>("substring")
    const [caseSensitive, setCaseSensitive] = useState(false)
    const [filterLines, setFilterLines] = useState(false)
    const [matches, setMatches] = useState<Match[]>([])
    const [filteredIndices, setFilteredIndices] = useState<number[]>([])
    const [currentMatchIndex, setCurrentMatchIndex] = useState(0)
    const [updateReadyVersion, setUpdateReadyVersion] = useState<string | null>(null)
    const [clearedOutputSnapshot, setClearedOutputSnapshot] = useState<{ procId: string; content: string } | null>(null)
    const searchIdRef = useRef(0)
    const workerRef = useRef<Worker | null>(null)

    const lines = useMemo(() => {
        if (!selectedProcId) return []
        const raw = outputByProc[selectedProcId] ?? ""
        return raw ? raw.split("\n").slice(-MAX_LINES) : []
    }, [selectedProcId, outputByProc])

    const runSearch = useCallback(
        (queryOverride?: string) => {
            const q = queryOverride ?? searchQuery
            if (!workerRef.current) return
            const id = ++searchIdRef.current
            workerRef.current.postMessage({
                id,
                lines,
                query: q,
                mode: searchMode,
                caseSensitive,
            })
        },
        [lines, searchQuery, searchMode, caseSensitive],
    )

    useEffect(() => {
        workerRef.current = new Worker(new URL("./workers/search.worker.ts", import.meta.url), { type: "module" })
        const w = workerRef.current
        w.onmessage = (e: MessageEvent<{ id: number; matches: Match[]; filteredLineIndices: number[] }>) => {
            if (e.data.id !== searchIdRef.current) return
            setMatches(e.data.matches)
            setFilteredIndices(e.data.filteredLineIndices)
            setCurrentMatchIndex((prev) =>
                e.data.matches.length === 0 ? 0 : Math.min(prev, e.data.matches.length - 1),
            )
        }
        return () => {
            w.terminate()
            workerRef.current = null
        }
    }, [])

    useEffect(() => {
        runSearch()
    }, [lines, searchMode, caseSensitive, runSearch])

    const handleNextMatch = useCallback(() => {
        setCurrentMatchIndex((i) => (i + 1) % Math.max(1, matches.length))
    }, [matches.length])

    const handlePrevMatch = useCallback(() => {
        setCurrentMatchIndex((i) => (i <= 0 ? Math.max(0, matches.length - 1) : i - 1))
    }, [matches.length])

    useEffect(() => {
        setClearedOutputSnapshot(null)
    }, [selectedProcId])

    const clearOutputForCurrentProc = useCallback(() => {
        if (!selectedProcId) return
        const current = outputByProc[selectedProcId] ?? ""
        setClearedOutputSnapshot({ procId: selectedProcId, content: current })
        setOutputByProc((prev) => ({ ...prev, [selectedProcId]: "" }))
    }, [selectedProcId, outputByProc])

    const undoClearOutput = useCallback(() => {
        if (!clearedOutputSnapshot || clearedOutputSnapshot.procId !== selectedProcId) return
        setOutputByProc((prev) => {
            const current = prev[clearedOutputSnapshot.procId] ?? ""
            return { ...prev, [clearedOutputSnapshot.procId]: clearedOutputSnapshot.content + current }
        })
        setClearedOutputSnapshot(null)
    }, [clearedOutputSnapshot, selectedProcId])

    const applyLoadedConfig = useCallback(
        (result: {
            configPath: string
            configDir: string
            procs: { id: string; name: string }[]
            runningIds?: string[]
            normalizedProcNames?: string[]
        }) => {
            const runningSet = new Set(result.runningIds ?? [])
            setConfig({
                configPath: result.configPath,
                configDir: result.configDir,
                procs: result.procs.map((p) => ({
                    ...p,
                    status: runningSet.has(p.id) ? ("running" as const) : ("stopped" as const),
                    exitCode: null,
                })),
            })
            setSelectedProcId(result.procs[0]?.id ?? null)
            if (result.normalizedProcNames && result.normalizedProcNames.length > 0) {
                toast.warning("Command compatibility rewrite applied", {
                    description: `Adjusted command arrays in ${result.normalizedProcNames.join(", ")} for this platform. Use --no-cmd-rewrite to disable.`,
                    duration: 6000,
                })
            }
        },
        [],
    )

    useEffect(() => {
        if (!api) return
        api.getAppConfig().then((appConfig) => {
            setDisableAnimations(readStoredDisableAnimations() ?? appConfig.disable_animations ?? false)
        })
    }, [])

    useEffect(() => {
        document.documentElement.dataset.animations = disableAnimations ? "off" : "on"
    }, [disableAnimations])

    useEffect(() => {
        if (!settingsOpen) return

        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") setSettingsOpen(false)
        }

        window.addEventListener("keydown", handleKeyDown)
        return () => window.removeEventListener("keydown", handleKeyDown)
    }, [settingsOpen])

    const setLogAnimationsEnabled = useCallback((enabled: boolean) => {
        const nextDisableAnimations = !enabled
        setDisableAnimations(nextDisableAnimations)
        storeDisableAnimations(nextDisableAnimations)
    }, [])

    useEffect(() => {
        if (!api || config !== null) return
        api.getDefaultConfigPath().then((defaultPath) => {
            if (!defaultPath) return
            api.loadConfig(defaultPath).then((result) => {
                if ("error" in result) return
                applyLoadedConfig(result)
            })
        })
    }, [config, applyLoadedConfig])

    const ipcListenersRegistered = useRef(false)
    useEffect(() => {
        if (!api || ipcListenersRegistered.current) return
        ipcListenersRegistered.current = true
        api.onProcessOutput(({ procId, text }) => {
            const openUrl = getOpenUrl(text)
            const portConflict = findPortConflict(text)
            if (openUrl)
                setConfig((c) =>
                    c
                        ? {
                              ...c,
                              procs: c.procs.map((p) => (p.id === procId && p.openUrl == null ? { ...p, openUrl } : p)),
                          }
                        : c,
                )
            if (portConflict)
                setConfig((c) =>
                    c
                        ? {
                              ...c,
                              procs: c.procs.map((p) =>
                                  p.id === procId
                                      ? { ...p, portConflict: { port: portConflict.port, detectedAt: Date.now() } }
                                      : p,
                              ),
                          }
                        : c,
                )
            setOutputByProc((prev) => ({ ...prev, [procId]: (prev[procId] ?? "") + text }))
        })
        api.onProcStarted((procId) => {
            setConfig((c) =>
                c
                    ? {
                          ...c,
                          procs: c.procs.map((p) =>
                              p.id === procId
                                  ? {
                                        ...p,
                                        status: "running" as const,
                                        exitCode: null,
                                        openUrl: undefined,
                                        portConflict: undefined,
                                    }
                                  : p,
                          ),
                      }
                    : c,
            )
        })
        api.onProcStopped(({ procId, code }) => {
            setConfig((c) =>
                c
                    ? {
                          ...c,
                          procs: c.procs.map((p) =>
                              p.id === procId
                                  ? { ...p, status: "stopped" as const, exitCode: code, openUrl: undefined }
                                  : p,
                          ),
                      }
                    : c,
            )
        })
        api.onUpdateDownloaded((version: string) => setUpdateReadyVersion(version))
    }, [])

    const openConfig = async () => {
        if (!api) return
        const result = await api.loadConfig("")
        if ("error" in result) {
            console.error(result.error)
            return
        }
        applyLoadedConfig(result)
    }

    if (!config) {
        return (
            <div
                data-theme={theme}
                data-animations={disableAnimations ? "off" : "on"}
                className={`flex h-screen min-h-0 w-full flex-1 ${theme === "cozy" ? "cozy-bg" : ""}`}
            >
                <div className="flex flex-1 items-center justify-center text-muted-foreground">
                    <button
                        onClick={openConfig}
                        className="rounded-md border border-border bg-card px-4 py-2 text-[13px] text-foreground transition-colors hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-50"
                    >
                        Open mprocs.yaml
                    </button>
                </div>
            </div>
        )
    }

    return (
        <div
            data-theme={theme}
            data-animations={disableAnimations ? "off" : "on"}
            className={`flex h-screen min-h-0 w-full flex-1 flex-col ${theme === "cozy" ? "cozy-bg" : ""}`}
        >
            {updateReadyVersion ? (
                <div className="relative z-10 flex shrink-0 items-center justify-between gap-4 border-b border-primary/40 bg-primary/20 px-4 py-2 text-sm text-foreground">
                    <span>Update v{updateReadyVersion} ready</span>
                    <div className="flex gap-2">
                        <button
                            type="button"
                            onClick={() => api?.quitAndInstall()}
                            className="rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90"
                        >
                            Restart to update
                        </button>
                        <button
                            type="button"
                            onClick={() => setUpdateReadyVersion(null)}
                            className="rounded-md bg-surface px-3 py-1 text-xs text-secondary-foreground transition-colors hover:bg-surface-hover"
                        >
                            Later
                        </button>
                    </div>
                </div>
            ) : null}
            <div className="relative z-10 flex min-h-0 flex-1 overflow-hidden">
                <ProcessList
                    procs={config.procs}
                    selectedProcId={selectedProcId}
                    onSelect={setSelectedProcId}
                    onStart={(id: string) => api?.startProc(id) ?? Promise.resolve()}
                    onStop={(id: string) => api?.stopProc(id) ?? Promise.resolve()}
                    onRestart={(id: string) => api?.restartProc(id) ?? Promise.resolve()}
                    theme={theme}
                    onToggleTheme={() => setTheme((current) => (current === "tech" ? "cozy" : "tech"))}
                    onOpenSettings={() => setSettingsOpen(true)}
                    onOpenConfig={openConfig}
                />
                <main className="flex min-w-0 flex-1 flex-col">
                    <OutputPanel
                        procId={selectedProcId}
                        procName={config.procs.find((p) => p.id === selectedProcId)?.name ?? ""}
                        disableAnimations={disableAnimations}
                        status={config.procs.find((p) => p.id === selectedProcId)?.status}
                        exitCode={config.procs.find((p) => p.id === selectedProcId)?.exitCode}
                        openUrl={config.procs.find((p) => p.id === selectedProcId)?.openUrl}
                        lines={lines}
                        matches={matches}
                        filteredIndices={filteredIndices}
                        filterLines={filterLines}
                        currentMatchIndex={currentMatchIndex}
                        toolbar={
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
                                hasOutput={!!selectedProcId && !!(outputByProc[selectedProcId] ?? "").trim()}
                                onClearOutput={clearOutputForCurrentProc}
                                canUndoClear={
                                    clearedOutputSnapshot !== null && clearedOutputSnapshot.procId === selectedProcId
                                }
                                onUndoClear={undoClearOutput}
                            />
                        }
                    />
                </main>
            </div>
            {settingsOpen ? (
                <SettingsDialog
                    theme={theme}
                    logAnimationsEnabled={!disableAnimations}
                    onLogAnimationsChange={setLogAnimationsEnabled}
                    onClose={() => setSettingsOpen(false)}
                />
            ) : null}
        </div>
    )
}

const SettingsDialog = ({
    theme,
    logAnimationsEnabled,
    onLogAnimationsChange,
    onClose,
}: {
    theme: "tech" | "cozy"
    logAnimationsEnabled: boolean
    onLogAnimationsChange: (enabled: boolean) => void
    onClose: () => void
}) => (
    <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-background/70 px-4 backdrop-blur-sm"
        onMouseDown={(event) => {
            if (event.target === event.currentTarget) onClose()
        }}
    >
        <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="settings-title"
            className={`w-full max-w-md rounded-lg border border-border bg-card p-4 text-foreground shadow-2xl ${
                theme === "cozy" ? "shadow-primary/15" : "shadow-black/40"
            }`}
        >
            <div className="mb-4 flex items-center justify-between gap-3 border-b border-border pb-3">
                <div>
                    <h2 id="settings-title" className="text-sm font-semibold tracking-wide">
                        Settings
                    </h2>
                    <p className="mt-1 text-xs text-muted-foreground">
                        {theme === "cozy" ? "✨ oprocs" : "oprocs"} preferences
                    </p>
                </div>
                <button
                    type="button"
                    onClick={onClose}
                    className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-surface-hover hover:text-foreground"
                    title="Close settings"
                >
                    <XIcon className="h-4 w-4" />
                </button>
            </div>

            <div className="flex items-center justify-between gap-4 rounded-lg border border-border bg-surface/70 px-3 py-3">
                <div className="min-w-0">
                    <div className="text-sm font-medium text-foreground">Log fade-in animations</div>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                        New output lines {logAnimationsEnabled ? "fade into view" : "appear immediately"}.
                    </div>
                </div>
                <button
                    type="button"
                    role="switch"
                    aria-checked={logAnimationsEnabled}
                    onClick={() => onLogAnimationsChange(!logAnimationsEnabled)}
                    className={`relative h-6 w-11 shrink-0 rounded-full border transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:ring-offset-card ${
                        logAnimationsEnabled ? "border-primary bg-primary" : "border-border bg-muted"
                    }`}
                    title={`${logAnimationsEnabled ? "Disable" : "Enable"} log fade-in animations`}
                >
                    <span
                        className={`pointer-events-none absolute left-px top-px h-5 w-5 rounded-full bg-card shadow transition-transform ${
                            logAnimationsEnabled ? "translate-x-5" : "translate-x-0"
                        }`}
                    />
                </button>
            </div>
        </section>
    </div>
)
