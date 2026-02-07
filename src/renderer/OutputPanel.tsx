import { useCallback, useRef, useEffect } from "react"
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso"
import { parseAnsiToSegments } from "./utils/ansi"

const MAX_LINES = 10_000
const LINE_HEIGHT = 20

export type Match = { lineIndex: number; start: number; end: number }

type OutputPanelProps = {
    procId: string | null
    procName: string
    lines: string[]
    matches: Match[]
    filteredIndices: number[]
    filterLines: boolean
    currentMatchIndex: number
    onScrollToMatch?: (lineIndex: number) => void
}

export const OutputPanel = ({ procId, procName, lines, matches, filteredIndices, filterLines, currentMatchIndex }: OutputPanelProps) => {
    const virtuosoRef = useRef<VirtuosoHandle>(null)
    const currentMatch = matches[currentMatchIndex] ?? null

    const displayLength = filterLines ? filteredIndices.length : lines.length
    const getSourceLineIndex = useCallback(
        (displayIndex: number) => (filterLines ? filteredIndices[displayIndex] : displayIndex),
        [filterLines, filteredIndices],
    )

    const scrollToLine = useCallback(
        (lineIndex: number) => {
            const displayIndex = filterLines ? filteredIndices.indexOf(lineIndex) : lineIndex
            if (displayIndex >= 0 && virtuosoRef.current) {
                virtuosoRef.current.scrollToIndex({
                    index: displayIndex,
                    behavior: "smooth",
                    align: "center",
                })
            }
        },
        [filterLines, filteredIndices],
    )

    const lastScrolledMatchIndexRef = useRef(-1)
    useEffect(() => {
        lastScrolledMatchIndexRef.current = -1
    }, [procId])
    useEffect(() => {
        if (currentMatchIndex !== lastScrolledMatchIndexRef.current && matches[currentMatchIndex]) {
            lastScrolledMatchIndexRef.current = currentMatchIndex
            scrollToLine(matches[currentMatchIndex].lineIndex)
        }
    }, [currentMatchIndex, matches, scrollToLine])

    if (!procId) {
        return (
            <div className="flex-1 overflow-auto py-3 px-4 font-mono text-[13px] leading-relaxed whitespace-pre-wrap break-all text-slate-500">
                Select a process to view output.
            </div>
        )
    }

    const itemContent = (displayIndex: number) => {
        const sourceLineIndex = getSourceLineIndex(displayIndex)
        const rawLine = lines[sourceLineIndex] ?? ""
        const lineMatches = matches.filter((m) => m.lineIndex === sourceLineIndex)
        const isCurrentLine = currentMatch != null && currentMatch.lineIndex === sourceLineIndex

        return (
            <div
                style={{
                    height: LINE_HEIGHT,
                    lineHeight: `${LINE_HEIGHT}px`,
                    paddingLeft: 4,
                    fontFamily: "ui-monospace, monospace",
                    fontSize: 13,
                    whiteSpace: "pre",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                }}
            >
                {renderLineWithAnsiAndHighlights(rawLine, lineMatches, currentMatch, isCurrentLine)}
            </div>
        )
    }

    return (
        <div className="flex flex-col flex-1 min-w-0 min-h-0">
            <div className="py-2 px-4 border-b border-slate-700 flex gap-2 flex-wrap items-center">
                <span className="self-center mr-2">{procName}</span>
            </div>
            {displayLength === 0 ? (
                <div className="flex-1 overflow-auto py-3 px-4 font-mono text-[13px] text-slate-500">No output yet.</div>
            ) : (
                <div className="flex-1 min-h-0 p-0">
                    <Virtuoso
                        ref={virtuosoRef}
                        style={{ height: "100%" }}
                        totalCount={displayLength}
                        itemContent={itemContent}
                        fixedItemHeight={LINE_HEIGHT}
                        followOutput="smooth"
                    />
                </div>
            )}
        </div>
    )
}

const renderLineWithAnsiAndHighlights = (
    rawLine: string,
    matchRanges: Match[],
    currentMatch: Match | null,
    isCurrentLine: boolean,
): React.ReactNode => {
    const segments = parseAnsiToSegments(rawLine)
    let plainOffset = 0
    const parts: React.ReactNode[] = []

    for (const seg of segments) {
        const segStart = plainOffset
        const segEnd = plainOffset + seg.text.length
        plainOffset = segEnd

        const overlapping = matchRanges.filter((m) => m.end > segStart && m.start < segEnd)
        if (overlapping.length === 0) {
            parts.push(
                <span
                    key={parts.length}
                    style={{
                        color: seg.fg,
                        backgroundColor: seg.bg,
                        fontWeight: seg.bold ? "bold" : undefined,
                        opacity: seg.dim ? 0.7 : undefined,
                        fontStyle: seg.italic ? "italic" : undefined,
                    }}
                >
                    {seg.text}
                </span>,
            )
            continue
        }

        let pos = segStart
        const sorted = [...overlapping].sort((a, b) => a.start - b.start)
        for (const m of sorted) {
            const mStart = Math.max(m.start, pos)
            const mEnd = Math.min(m.end, segEnd)
            if (mStart >= mEnd) continue
            if (mStart > pos) {
                parts.push(
                    <span
                        key={parts.length}
                        style={{
                            color: seg.fg,
                            backgroundColor: seg.bg,
                            fontWeight: seg.bold ? "bold" : undefined,
                            opacity: seg.dim ? 0.7 : undefined,
                            fontStyle: seg.italic ? "italic" : undefined,
                        }}
                    >
                        {seg.text.slice(pos - segStart, mStart - segStart)}
                    </span>,
                )
            }
            const isCurrent = isCurrentLine && currentMatch && currentMatch.start === m.start && currentMatch.end === m.end
            parts.push(
                <mark key={parts.length} className={isCurrent ? "bg-amber-500 text-slate-900 px-0.5" : "bg-slate-600 px-0.5"}>
                    {seg.text.slice(mStart - segStart, mEnd - segStart)}
                </mark>,
            )
            pos = mEnd
        }
        if (pos < segEnd) {
            parts.push(
                <span
                    key={parts.length}
                    style={{
                        color: seg.fg,
                        backgroundColor: seg.bg,
                        fontWeight: seg.bold ? "bold" : undefined,
                        opacity: seg.dim ? 0.7 : undefined,
                        fontStyle: seg.italic ? "italic" : undefined,
                    }}
                >
                    {seg.text.slice(pos - segStart, segEnd - segStart)}
                </span>,
            )
        }
    }

    return <>{parts}</>
}
