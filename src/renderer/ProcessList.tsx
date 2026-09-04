import { useCallback, useEffect, useMemo, useState } from "react"
import type { ProcInfo } from "./App"
import type { PortOccupant } from "../shared/types"
import { ExternalLinkIcon, FlowerIcon, PlayIcon, PlugZapIcon, RotateCwIcon, SquareIcon, TerminalIcon } from "./icons"
import { ProcessListActions } from "./ProcessListActions"
import { TooltipButton } from "./TooltipButton"
import { openExternalLink } from "./utils/externalLinks"
import { toast } from "sonner"

type ProcessListProps = {
    procs: ProcInfo[]
    configDir: string
    selectedProcId: string | null
    onSelect: (id: string) => void
    onStart: (id: string) => Promise<unknown>
    onStop: (id: string) => Promise<unknown>
    onRestart: (id: string) => Promise<unknown>
    theme: "tech" | "cozy"
    onToggleTheme: () => void
    onOpenSettings: () => void
    onOpenConfig: () => void
}

const api = window.oprocsAPI

const chipButtonCls =
    "flex items-center gap-1 rounded-md border border-accent/30 bg-accent/10 px-1.5 py-0.5 text-[10px] font-medium text-accent transition-colors hover:bg-accent/20"

type PortOccupantState = {
    loading: boolean
    occupant: PortOccupant | null
    error?: string
}

function StatusDot({ proc }: { proc: ProcInfo }) {
    const className =
        proc.status === "running"
            ? "bg-status-running animate-pulse-dot"
            : proc.exitCode != null && proc.exitCode !== 0
              ? "bg-status-stopped"
              : "bg-status-idle"

    return <span className={`inline-block h-2 w-2 rounded-full ${className}`} />
}

export const ProcessList = ({
    procs,
    configDir,
    selectedProcId,
    onSelect,
    onStart,
    onStop,
    onRestart,
    theme,
    onToggleTheme,
    onOpenSettings,
    onOpenConfig,
}: ProcessListProps) => {
    const runningProcs = procs.filter((proc) => proc.status === "running")
    const stoppedProcs = procs.filter((proc) => proc.status === "stopped")
    const hasRunningProcs = runningProcs.length > 0
    const hasProcs = procs.length > 0
    const [portOccupants, setPortOccupants] = useState<Record<number, PortOccupantState>>({})

    const portConflictChecks = useMemo(
        () =>
            procs
                .map((proc) =>
                    proc.portConflict
                        ? { procId: proc.id, port: proc.portConflict.port, detectedAt: proc.portConflict.detectedAt }
                        : null,
                )
                .filter(
                    (conflict): conflict is { procId: string; port: number; detectedAt: number } => conflict != null,
                ),
        [procs],
    )

    const fetchPortOccupant = useCallback(async (port: number) => {
        if (!api) return
        setPortOccupants((prev) => ({
            ...prev,
            [port]: { loading: true, occupant: prev[port]?.occupant ?? null },
        }))
        try {
            const occupant = await api.getPortOccupant(port)
            setPortOccupants((prev) => ({ ...prev, [port]: { loading: false, occupant } }))
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            setPortOccupants((prev) => ({
                ...prev,
                [port]: { loading: false, occupant: null, error: message },
            }))
        }
    }, [])

    useEffect(() => {
        for (const conflict of portConflictChecks) {
            void fetchPortOccupant(conflict.port)
        }
    }, [portConflictChecks, fetchPortOccupant])

    const portConflictTitle = (port: number) => {
        const state = portOccupants[port]
        if (state?.loading) return `Looking up process using port ${port}...`
        if (state?.occupant) {
            const { command, pid, detail } = state.occupant
            return `Kill ${command} (pid ${pid}) using port ${port}${detail ? ` - ${detail}` : ""}`
        }
        if (state?.error) return `Could not inspect port ${port}: ${state.error}`
        return `Find and kill process using port ${port}`
    }

    const handleKillPortOccupant = async (port: number) => {
        if (!api) return
        setPortOccupants((prev) => ({
            ...prev,
            [port]: { loading: true, occupant: prev[port]?.occupant ?? null },
        }))
        try {
            const result = await api.killPortOccupant(port)
            if (!result.ok) {
                const message = result.error ?? `No listening process found for port ${port}`
                setPortOccupants((prev) => ({
                    ...prev,
                    [port]: { loading: false, occupant: result.occupant ?? null, error: message },
                }))
                toast.error(message)
                return
            }

            const occupant = result.occupant
            toast.success(
                occupant
                    ? `Killed ${occupant.command} (pid ${occupant.pid}) on port ${port}`
                    : `Killed process using port ${port}`,
            )
            await fetchPortOccupant(port)
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            setPortOccupants((prev) => ({
                ...prev,
                [port]: { loading: false, occupant: null, error: message },
            }))
            toast.error(`Could not kill process using port ${port}`)
        }
    }

    const handleStopAll = () => {
        runningProcs.forEach((proc) => {
            void onStop(proc.id)
        })
    }

    const handleRestartAll = () => {
        runningProcs.forEach((proc) => {
            void onRestart(proc.id)
        })
        stoppedProcs.forEach((proc) => {
            void onStart(proc.id)
        })
    }

    return (
        <aside className="cozy-sidebar-shell flex h-full w-64 flex-col border-r border-border bg-card">
            <div className="cozy-sidebar-section flex items-center gap-2 border-b border-border px-4 py-3">
                <div className="min-w-0 flex-1">
                    <button
                        type="button"
                        onClick={onOpenSettings}
                        className="-ml-1 rounded-md px-1 py-0.5 text-left text-sm font-semibold tracking-wide text-foreground transition-colors hover:bg-surface-hover focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:ring-offset-card"
                        title="Open settings"
                    >
                        {theme === "cozy" ? "✨ oprocs" : "oprocs"}
                    </button>
                    <p className="mt-0.5 truncate text-[11px] text-muted-foreground" title={configDir}>
                        {configDir}
                    </p>
                </div>
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
                    title="Change config"
                >
                    Change config
                </button>
            </div>
            <nav className="cozy-sidebar-nav scrollbar-thin flex-1 overflow-y-auto p-2">
                <div className="space-y-1">
                    {procs.map((proc) => (
                        <div
                            key={proc.id}
                            role="button"
                            tabIndex={0}
                            className={`cozy-sidebar-card group cursor-pointer rounded-lg px-3 py-2.5 transition-all ${
                                selectedProcId === proc.id ? "bg-surface-active" : "hover:bg-surface-hover"
                            }`}
                            onClick={() => onSelect(proc.id)}
                            onKeyDown={(e) => {
                                if (e.key === "Enter" || e.key === " ") {
                                    e.preventDefault()
                                    onSelect(proc.id)
                                }
                            }}
                        >
                            <div className="flex min-w-0 items-center gap-2.5">
                                <StatusDot proc={proc} />
                                <span className="min-w-0 flex-1 overflow-hidden text-ellipsis text-sm font-medium text-foreground">
                                    {proc.name}
                                </span>
                                {proc.openUrl ? (
                                    <button
                                        type="button"
                                        className={`${chipButtonCls} cozy-sidebar-chip`}
                                        onClick={(e) => {
                                            e.stopPropagation()
                                            openExternalLink(proc.openUrl!)
                                        }}
                                        title={`Open ${proc.openUrl}`}
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
                                        selectedProcId === proc.id ? "opacity-100" : "opacity-0 group-hover:opacity-100"
                                    }`}
                                >
                                    {proc.status === "stopped" ? (
                                        <TooltipButton
                                            className="rounded p-1 text-muted-foreground transition-colors hover:bg-primary/20 hover:text-primary"
                                            onClick={(e) => {
                                                e.stopPropagation()
                                                void onStart(proc.id)
                                            }}
                                            tooltip={`Start ${proc.name}`}
                                        >
                                            <PlayIcon className="h-3 w-3" />
                                        </TooltipButton>
                                    ) : (
                                        <>
                                            <TooltipButton
                                                className="rounded p-1 text-muted-foreground transition-colors hover:bg-destructive/20 hover:text-destructive"
                                                onClick={(e) => {
                                                    e.stopPropagation()
                                                    void onStop(proc.id)
                                                }}
                                                tooltip={`Stop ${proc.name}`}
                                            >
                                                <SquareIcon className="h-3 w-3" />
                                            </TooltipButton>
                                            <TooltipButton
                                                className="rounded p-1 text-muted-foreground transition-colors hover:bg-primary/20 hover:text-primary"
                                                onClick={(e) => {
                                                    e.stopPropagation()
                                                    void onRestart(proc.id)
                                                }}
                                                tooltip={`Restart ${proc.name}`}
                                            >
                                                <RotateCwIcon className="h-3 w-3" />
                                            </TooltipButton>
                                        </>
                                    )}
                                    {proc.portConflict
                                        ? (() => {
                                              const port = proc.portConflict.port
                                              const portState = portOccupants[port]
                                              if (!portState?.loading && !portState?.occupant) return null
                                              return (
                                                  <TooltipButton
                                                      className="rounded p-1 text-muted-foreground transition-colors hover:bg-warning/20 hover:text-warning"
                                                      onMouseEnter={() => void fetchPortOccupant(port)}
                                                      onClick={(e) => {
                                                          e.stopPropagation()
                                                          void handleKillPortOccupant(port)
                                                      }}
                                                      tooltip={portConflictTitle(port)}
                                                  >
                                                      <PlugZapIcon className="h-3 w-3" />
                                                  </TooltipButton>
                                              )
                                          })()
                                        : null}
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
    )
}
