import { RefreshCwIcon, StopCircleIcon } from "./icons"

type ProcessListActionsProps = {
    onStopAll: () => void
    onRestartAll: () => void
    stopAllDisabled: boolean
    restartAllDisabled: boolean
}

const buttonCls =
    "flex flex-1 items-center justify-center gap-1.5 rounded-md bg-surface px-3 py-2 text-xs font-medium text-secondary-foreground transition-colors hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-50"

export const ProcessListActions = ({
    onStopAll,
    onRestartAll,
    stopAllDisabled,
    restartAllDisabled,
}: ProcessListActionsProps) => (
    <div className="cozy-sidebar-section shrink-0 flex gap-2 border-t border-border p-3">
        <button type="button" onClick={onStopAll} disabled={stopAllDisabled} className={buttonCls}>
            <StopCircleIcon className="h-3.5 w-3.5" />
            Stop All
        </button>
        <button type="button" onClick={onRestartAll} disabled={restartAllDisabled} className={buttonCls}>
            <RefreshCwIcon className="h-3.5 w-3.5" />
            Restart All
        </button>
    </div>
)
