type ProcessListActionsProps = {
    onStopAll: () => void
    onRestartAll: () => void
    stopAllDisabled: boolean
    restartAllDisabled: boolean
}

const buttonCls =
    "flex-1 px-3 py-2 border border-slate-600 rounded-md bg-slate-800 text-slate-200 cursor-pointer text-[13px] hover:bg-slate-700 disabled:opacity-50 disabled:cursor-not-allowed"

export const ProcessListActions = ({
    onStopAll,
    onRestartAll,
    stopAllDisabled,
    restartAllDisabled,
}: ProcessListActionsProps) => (
    <div className="shrink-0 border-t border-slate-700 p-3 flex gap-2">
        <button
            type="button"
            onClick={onStopAll}
            disabled={stopAllDisabled}
            className={buttonCls}
        >
            Stop All
        </button>
        <button
            type="button"
            onClick={onRestartAll}
            disabled={restartAllDisabled}
            className={buttonCls}
        >
            Restart All
        </button>
    </div>
)
