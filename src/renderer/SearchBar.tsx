import { useEffect, useRef, useState } from "react"
import {
    ArrowDownToLineIcon,
    CaseSensitiveIcon,
    ChevronDownIcon,
    ChevronUpIcon,
    FilterIcon,
    SearchIcon,
    TrashIcon,
} from "./icons"

export type SearchMode = "substring" | "fuzzy" | "regex"

type SearchBarProps = {
    query: string
    setQuery: (q: string) => void
    mode: SearchMode
    setMode: (m: SearchMode) => void
    caseSensitive: boolean
    setCaseSensitive: (v: boolean) => void
    filterLines: boolean
    setFilterLines: (v: boolean) => void
    matchCount: number
    currentMatchIndex: number
    onNext: () => void
    onPrev: () => void
    onSearch: (q: string) => void
    hasOutput: boolean
    onClearOutput: () => void
    canUndoClear: boolean
    onUndoClear: () => void
}

const DEBOUNCE_MS = 200

export const SearchBar = ({
    query,
    setQuery,
    mode,
    setMode,
    caseSensitive,
    setCaseSensitive,
    filterLines,
    setFilterLines,
    matchCount,
    currentMatchIndex,
    onNext,
    onPrev,
    onSearch,
    hasOutput,
    onClearOutput,
    canUndoClear,
    onUndoClear,
}: SearchBarProps) => {
    const [localQuery, setLocalQuery] = useState(query)
    const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

    useEffect(() => {
        setLocalQuery(query)
    }, [query])

    const handleQueryChange = (value: string) => {
        setLocalQuery(value)
        if (debounceRef.current) clearTimeout(debounceRef.current)
        debounceRef.current = setTimeout(() => {
            setQuery(value)
            onSearch(value)
            debounceRef.current = null
        }, DEBOUNCE_MS)
    }

    return (
        <div className="flex items-center gap-2 border-b border-border bg-card/50 px-4 py-2">
            <div className="relative min-w-[180px] flex-1">
                <SearchIcon className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <input
                    type="text"
                    className="h-8 w-full rounded-md border border-border bg-background pl-8 pr-3 font-mono text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                    placeholder="Search logs..."
                    value={localQuery}
                    onChange={(e) => handleQueryChange(e.currentTarget.value)}
                    onKeyDown={(e) => {
                        if (e.key === "Enter") {
                            if (e.shiftKey) onPrev()
                            else onNext()
                        }
                    }}
                />
            </div>
            <select
                className="h-8 rounded-md border border-border bg-background px-2 text-xs text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                value={mode}
                onChange={(e) => setMode(e.target.value as SearchMode)}
                title="Search mode"
            >
                <option value="substring">Substring</option>
                <option value="fuzzy">Fuzzy</option>
                <option value="regex">Regex</option>
            </select>
            <button
                type="button"
                onClick={() => setCaseSensitive(!caseSensitive)}
                className={`flex h-8 items-center gap-1 rounded-md border px-2 text-xs transition-colors ${
                    caseSensitive
                        ? "border-accent bg-accent/20 text-accent"
                        : "border-border text-muted-foreground hover:bg-surface-hover"
                }`}
                title="Match case"
            >
                <CaseSensitiveIcon className="h-3.5 w-3.5" />
            </button>
            <button
                type="button"
                onClick={() => setFilterLines(!filterLines)}
                className={`flex h-8 items-center gap-1 rounded-md border px-2 text-xs transition-colors ${
                    filterLines
                        ? "border-accent bg-accent/20 text-accent"
                        : "border-border text-muted-foreground hover:bg-surface-hover"
                }`}
                title="Filter lines"
            >
                <FilterIcon className="h-3.5 w-3.5" />
            </button>
            {localQuery ? (
                <span className="font-mono text-xs text-muted-foreground">
                    {matchCount === 0 ? "0 matches" : `${currentMatchIndex + 1} / ${matchCount}`}
                </span>
            ) : null}
            <div className="flex items-center gap-0.5">
                <button
                    type="button"
                    onClick={onPrev}
                    disabled={matchCount === 0}
                    className="rounded p-1 text-muted-foreground transition-colors hover:bg-surface-hover hover:text-foreground disabled:opacity-40"
                    title="Previous"
                >
                    <ChevronUpIcon className="h-3.5 w-3.5" />
                </button>
                <button
                    type="button"
                    onClick={onNext}
                    disabled={matchCount === 0}
                    className="rounded p-1 text-muted-foreground transition-colors hover:bg-surface-hover hover:text-foreground disabled:opacity-40"
                    title="Next"
                >
                    <ChevronDownIcon className="h-3.5 w-3.5" />
                </button>
            </div>
            <div className="mx-1 h-4 w-px bg-border" />
            {canUndoClear ? (
                <button
                    type="button"
                    className="rounded px-2 py-1.5 text-xs text-primary transition-colors hover:bg-primary/10"
                    onClick={onUndoClear}
                >
                    Undo clear
                </button>
            ) : null}
            <button
                type="button"
                className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-surface-hover hover:text-foreground disabled:opacity-40"
                title="Jump to next match"
                onClick={onNext}
                disabled={matchCount === 0}
            >
                <ArrowDownToLineIcon className="h-3.5 w-3.5" />
            </button>
            <button
                type="button"
                className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-destructive/20 hover:text-destructive disabled:opacity-40"
                onClick={onClearOutput}
                disabled={!hasOutput}
                title="Clear output"
            >
                <TrashIcon className="h-3.5 w-3.5" />
            </button>
        </div>
    )
}
