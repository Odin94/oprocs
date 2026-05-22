import React, { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso"
import { CheckIcon, CopyIcon, ExternalLinkIcon, WrapTextIcon } from "./icons"
import { parseAnsiToSegments, withoutAnsiColors, type AnsiSegment } from "./utils/ansi"
import { extractUrls, findUrlMatches } from "./utils/links"

const LINE_HEIGHT = 20
const CHAR_WIDTH = 7.8

export type Match = { lineIndex: number; start: number; end: number }

type OutputPanelProps = {
    procId: string | null
    procName: string
    theme: "tech" | "cozy"
    lines: string[]
    matches: Match[]
    filteredIndices: number[]
    filterLines: boolean
    currentMatchIndex: number
    status?: "running" | "stopped"
    exitCode?: number | null
    openUrl?: string
    toolbar?: React.ReactNode
}

type LogLineRowProps = {
    animationEpoch: number
    lineHeight: number
    rawLine: string
    sourceLineIndex: number
    wrapLines: boolean
    matchRanges: Match[]
    currentMatch: Match | null
    isCurrentLine: boolean
    animatedLineIndicesRef: React.MutableRefObject<Set<number>>
    animationOrderRef: React.MutableRefObject<Map<number, number>>
    nextAnimationOrderRef: React.MutableRefObject<number>
}

type OffsetSegment = AnsiSegment & {
    start: number
    end: number
}

const LogScroller = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
    ({ className, ...props }, ref) => <div ref={ref} className={["log-scrollbar", className].filter(Boolean).join(" ")} {...props} />,
)

const HScrollScroller = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
    ({ style, className, ...props }, ref) => (
        <div
            ref={ref}
            className={["log-scrollbar", className].filter(Boolean).join(" ")}
            style={{ ...style, overflowX: "auto" }}
            {...props}
        />
    ),
)

const MinWidthList = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement> & { context?: { minWidth: number } }>(
    ({ style, context, ...props }, ref) => <div ref={ref} style={{ ...style, minWidth: context?.minWidth }} {...props} />,
)

const wrapComponents = { Scroller: LogScroller }
const hScrollComponents = { Scroller: HScrollScroller, List: MinWidthList }
const MAX_LOG_LINE_ANIMATION_DELAY_MS = 300
const LOG_LINE_ANIMATION_DURATION_MS = 500

const LogLineRow = ({
    animationEpoch,
    lineHeight,
    rawLine,
    sourceLineIndex,
    wrapLines,
    matchRanges,
    currentMatch,
    isCurrentLine,
    animatedLineIndicesRef,
    animationOrderRef,
    nextAnimationOrderRef,
}: LogLineRowProps) => {
    const shouldAnimate = !animatedLineIndicesRef.current.has(sourceLineIndex)
    if (shouldAnimate && !animationOrderRef.current.has(sourceLineIndex)) {
        animationOrderRef.current.set(sourceLineIndex, nextAnimationOrderRef.current)
        nextAnimationOrderRef.current += 1
    }
    const animationOrder = animationOrderRef.current.get(sourceLineIndex) ?? 0
    const animationDelayMs = Math.min(animationOrder * 15, MAX_LOG_LINE_ANIMATION_DELAY_MS)

    useEffect(() => {
        if (!shouldAnimate) return

        const markAnimatedTimer = window.setTimeout(() => {
            animatedLineIndicesRef.current.add(sourceLineIndex)
            animationOrderRef.current.delete(sourceLineIndex)
        }, animationDelayMs + LOG_LINE_ANIMATION_DURATION_MS)

        return () => window.clearTimeout(markAnimatedTimer)
    }, [animatedLineIndicesRef, animationDelayMs, animationEpoch, animationOrderRef, shouldAnimate, sourceLineIndex])

    return (
        <div
            className={`log-line flex gap-3 px-4 ${shouldAnimate ? "log-line-animate" : ""}`}
            style={{
                ...(wrapLines ? { minHeight: lineHeight } : { height: lineHeight }),
                lineHeight: `${lineHeight}px`,
                fontFamily: "var(--font-mono)",
                fontSize: 12,
                whiteSpace: wrapLines ? "pre-wrap" : "pre",
                animationDelay: shouldAnimate ? `${animationDelayMs}ms` : undefined,
            }}
        >
            <span className="shrink-0 select-none text-muted-foreground/40 tabular-nums">
                {String(sourceLineIndex + 1).padStart(3, " ")}
            </span>
            <span className="min-w-0 break-all text-log-text">
                {renderLineWithAnsiAndHighlights(rawLine, matchRanges, currentMatch, isCurrentLine)}
            </span>
        </div>
    )
}

export const OutputPanel = ({
    procId,
    procName,
    theme,
    lines,
    matches,
    filteredIndices,
    filterLines,
    currentMatchIndex,
    status,
    exitCode,
    openUrl,
    toolbar,
}: OutputPanelProps) => {
    const virtuosoRef = useRef<VirtuosoHandle>(null)
    const [wrapLines, setWrapLines] = useState(false)
    const [copied, setCopied] = useState(false)

    const copyLogs = useCallback(() => {
        const displayedLines = filterLines ? filteredIndices.map((i) => lines[i] ?? "") : lines
        const text = displayedLines.map((l) => withoutAnsiColors(l)).join("\n")
        void navigator.clipboard.writeText(text).then(() => {
            setCopied(true)
            window.setTimeout(() => setCopied(false), 1500)
        })
    }, [filterLines, filteredIndices, lines])
    const currentMatch = matches[currentMatchIndex] ?? null
    const detectedUrls = useMemo(() => extractUrls(lines, openUrl), [lines, openUrl])
    const animatedLineIndicesRef = useRef<Set<number>>(new Set())
    const animationOrderRef = useRef<Map<number, number>>(new Map())
    const nextAnimationOrderRef = useRef(0)
    const prevLineCountRef = useRef(0)
    const [animationEpoch, setAnimationEpoch] = useState(0)

    const displayLength = filterLines ? filteredIndices.length : lines.length
    const initialTopMostItemIndex = Math.max(displayLength - 1, 0)
    const getSourceLineIndex = useCallback(
        (displayIndex: number) => (filterLines ? filteredIndices[displayIndex] : displayIndex),
        [filterLines, filteredIndices],
    )

    useEffect(() => {
        setWrapLines(false)
        animatedLineIndicesRef.current = new Set()
        animationOrderRef.current = new Map()
        nextAnimationOrderRef.current = 0
        prevLineCountRef.current = 0
        setAnimationEpoch((value) => value + 1)
    }, [procId])

    useEffect(() => {
        if (theme === "cozy") {
            animatedLineIndicesRef.current = new Set()
            animationOrderRef.current = new Map()
            nextAnimationOrderRef.current = 0
            setAnimationEpoch((value) => value + 1)
        }
    }, [theme])

    useEffect(() => {
        if (lines.length < prevLineCountRef.current) {
            animatedLineIndicesRef.current = new Set()
            animationOrderRef.current = new Map()
            nextAnimationOrderRef.current = 0
            setAnimationEpoch((value) => value + 1)
        }
        prevLineCountRef.current = lines.length
    }, [lines.length])

    const maxLineWidth = useMemo(() => {
        if (wrapLines) return 0
        const maxChars = lines.reduce((max, line) => Math.max(max, withoutAnsiColors(line).length), 0)
        return maxChars * CHAR_WIDTH + 8
    }, [lines, wrapLines])

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
            <div className="flex flex-1 items-center justify-center bg-log-bg px-4 py-8 text-sm text-muted-foreground">
                Select a process to view output.
            </div>
        )
    }

    const itemContent = (displayIndex: number) => {
        const sourceLineIndex = getSourceLineIndex(displayIndex)
        const rawLine = lines[sourceLineIndex] ?? ""
        const lineMatches = matches.filter((match) => match.lineIndex === sourceLineIndex)
        const isCurrentLine = currentMatch != null && currentMatch.lineIndex === sourceLineIndex
        return (
            <LogLineRow
                key={`${animationEpoch}-${sourceLineIndex}`}
                animationEpoch={animationEpoch}
                lineHeight={LINE_HEIGHT}
                rawLine={rawLine}
                sourceLineIndex={sourceLineIndex}
                wrapLines={wrapLines}
                matchRanges={lineMatches}
                currentMatch={currentMatch}
                isCurrentLine={isCurrentLine}
                animatedLineIndicesRef={animatedLineIndicesRef}
                animationOrderRef={animationOrderRef}
                nextAnimationOrderRef={nextAnimationOrderRef}
            />
        )
    }

    return (
        <div className="flex flex-1 min-h-0 min-w-0 flex-col">
            <div className="flex items-center gap-2 border-b border-border bg-card px-4 py-2">
                <div className="flex min-w-0 items-center gap-1.5">
                    <span
                        className={`inline-block h-2 w-2 rounded-full ${
                            status === "running"
                                ? "bg-status-running animate-pulse-dot"
                                : exitCode != null && exitCode !== 0
                                  ? "bg-status-stopped"
                                  : "bg-status-idle"
                        }`}
                    />
                    <h2 className="truncate text-sm font-semibold text-foreground">{procName}</h2>
                    <span className="rounded bg-surface px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                        {status === "running" ? "running" : exitCode != null ? `exit ${exitCode}` : "stopped"}
                    </span>
                </div>
                {detectedUrls.length > 0 ? (
                    <div className="flex min-w-0 items-center gap-1.5 overflow-hidden">
                        {detectedUrls.map((url) => (
                            <button
                                key={url}
                                type="button"
                                onClick={() => void window.electronAPI?.openExternalLink(url)}
                                className="flex max-w-[220px] items-center gap-1 rounded-md border border-accent/30 bg-accent/10 px-2 py-1 text-[11px] font-medium text-accent transition-colors hover:bg-accent/20"
                                title={url}
                            >
                                <ExternalLinkIcon className="h-3 w-3 shrink-0" />
                                <span className="truncate">{url.replace(/^https?:\/\//, "")}</span>
                            </button>
                        ))}
                    </div>
                ) : null}
                <div className="flex-1" />
                <button
                    type="button"
                    onClick={copyLogs}
                    className={`flex items-center gap-1 rounded-md border px-2 py-1 text-xs transition-colors ${
                        copied
                            ? "border-accent bg-accent/20 text-accent"
                            : "border-border text-muted-foreground hover:bg-surface-hover hover:text-foreground"
                    }`}
                    title="Copy logs to clipboard"
                >
                    {copied ? <CheckIcon className="h-3.5 w-3.5" /> : <CopyIcon className="h-3.5 w-3.5" />}
                    {copied ? "Copied!" : "Copy"}
                </button>
                <button
                    type="button"
                    onClick={() => setWrapLines((value) => !value)}
                    className={`flex items-center gap-1 rounded-md border px-2 py-1 text-xs transition-colors ${
                        wrapLines
                            ? "border-accent bg-accent/20 text-accent"
                            : "border-border text-muted-foreground hover:bg-surface-hover hover:text-foreground"
                    }`}
                    title="Wrap lines"
                >
                    <WrapTextIcon className="h-3.5 w-3.5" />
                    Wrap
                </button>
            </div>
            {toolbar}
            {displayLength === 0 ? (
                <div className="flex-1 overflow-auto bg-log-bg py-8 px-4 text-center font-mono text-[13px] text-muted-foreground">
                    No output yet.
                </div>
            ) : (
                <div className="flex-1 min-h-0 bg-log-bg py-4">
                    {wrapLines ? (
                        <Virtuoso
                            key={`wrap-${procId ?? "none"}-${theme}`}
                            ref={virtuosoRef}
                            style={{ height: "100%" }}
                            totalCount={displayLength}
                            initialTopMostItemIndex={initialTopMostItemIndex}
                            itemContent={itemContent}
                            followOutput="auto"
                            components={wrapComponents}
                        />
                    ) : (
                        <Virtuoso
                            key={`nowrap-${procId ?? "none"}-${theme}`}
                            ref={virtuosoRef}
                            style={{ height: "100%" }}
                            totalCount={displayLength}
                            initialTopMostItemIndex={initialTopMostItemIndex}
                            itemContent={itemContent}
                            fixedItemHeight={LINE_HEIGHT}
                            followOutput="auto"
                            components={hScrollComponents}
                            context={{ minWidth: maxLineWidth }}
                        />
                    )}
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
    const segments = withSegmentOffsets(parseAnsiToSegments(rawLine))
    const urlMatches = findUrlMatches(rawLine)
    const plainLength = withoutAnsiColors(rawLine).length
    const boundaries = new Set<number>([0, plainLength])

    for (const match of matchRanges) {
        boundaries.add(match.start)
        boundaries.add(match.end)
    }

    for (const match of urlMatches) {
        boundaries.add(match.start)
        boundaries.add(match.end)
    }

    const sortedBoundaries = Array.from(boundaries).sort((a, b) => a - b)

    return (
        <>
            {sortedBoundaries.slice(0, -1).map((start, index) => {
                const end = sortedBoundaries[index + 1]
                if (start === end) return null

                const content = renderStyledSlice(segments, start, end)
                const matchedRange = matchRanges.find((match) => match.start <= start && match.end >= end)
                const urlMatch = urlMatches.find((match) => match.start <= start && match.end >= end)

                const highlightedContent =
                    matchedRange != null ? (
                        <mark
                            className={
                                isCurrentLine &&
                                currentMatch &&
                                currentMatch.start === matchedRange.start &&
                                currentMatch.end === matchedRange.end
                                    ? "rounded-sm bg-log-highlight/30 px-0.5 text-accent-foreground"
                                    : "rounded-sm bg-surface-active px-0.5 text-foreground"
                            }
                        >
                            {content}
                        </mark>
                    ) : (
                        content
                    )

                if (!urlMatch) return <React.Fragment key={index}>{highlightedContent}</React.Fragment>

                return (
                    <button
                        key={index}
                        type="button"
                        onClick={() => void window.electronAPI?.openExternalLink(urlMatch.url)}
                        className="inline cursor-pointer rounded-sm underline decoration-accent/40 underline-offset-2 transition-colors hover:text-accent hover:decoration-accent"
                        title={urlMatch.url}
                    >
                        {highlightedContent}
                    </button>
                )
            })}
        </>
    )
}

const withSegmentOffsets = (segments: AnsiSegment[]): OffsetSegment[] => {
    let plainOffset = 0
    return segments.map((segment) => {
        const withOffsets = {
            ...segment,
            start: plainOffset,
            end: plainOffset + segment.text.length,
        }
        plainOffset = withOffsets.end
        return withOffsets
    })
}

const renderStyledSlice = (segments: OffsetSegment[], start: number, end: number): React.ReactNode => {
    const parts: React.ReactNode[] = []

    for (const seg of segments) {
        const sliceStart = Math.max(start, seg.start)
        const sliceEnd = Math.min(end, seg.end)
        if (sliceStart >= sliceEnd) continue

        parts.push(
            <span key={parts.length} style={getAnsiSegmentStyle(seg)}>
                {seg.text.slice(sliceStart - seg.start, sliceEnd - seg.start)}
            </span>,
        )
    }

    return <>{parts}</>
}

const getAnsiSegmentStyle = (seg: AnsiSegment): React.CSSProperties => ({
    color: seg.fg,
    backgroundColor: seg.bg,
    fontWeight: seg.bold ? "bold" : undefined,
    opacity: seg.dim ? 0.7 : undefined,
    fontStyle: seg.italic ? "italic" : undefined,
})
