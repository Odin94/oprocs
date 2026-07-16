import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso"
import { CheckIcon, CopyIcon, ExternalLinkIcon, RotateCwIcon, WrapTextIcon } from "./icons"
import { parseAnsiToSegments, withoutAnsiColors, type AnsiSegment } from "./utils/ansi"
import { extractUrls, findUrlMatches } from "./utils/links"

const LINE_HEIGHT = 20
const CHAR_WIDTH = 7.8
const LOG_FONT_SIZE = 12
const MIN_LOG_FONT_SIZE = 9
const MAX_LOG_FONT_SIZE = 24
const LOG_FONT_SIZE_STEP = 1

export type Match = { lineIndex: number; start: number; end: number }

type OutputPanelProps = {
    procId: string | null
    procName: string
    disableAnimations: boolean
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
    fontSize: number
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
    disableAnimations: boolean
}

type OffsetSegment = AnsiSegment & {
    start: number
    end: number
}

const LogScroller = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
    ({ className, ...props }, ref) => (
        <div ref={ref} className={["log-scrollbar", className].filter(Boolean).join(" ")} {...props} />
    ),
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

const MinWidthList = React.forwardRef<
    HTMLDivElement,
    React.HTMLAttributes<HTMLDivElement> & { context?: { minWidth: number } }
>(({ style, context, ...props }, ref) => <div ref={ref} style={{ ...style, minWidth: context?.minWidth }} {...props} />)

const WrapList = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>((props, ref) => (
    <div ref={ref} {...props} />
))

const wrapComponents = { Scroller: LogScroller, List: WrapList }
const hScrollComponents = { Scroller: HScrollScroller, List: MinWidthList }
const MAX_LOG_LINE_ANIMATION_DELAY_MS = 300
const LOG_LINE_ANIMATION_DURATION_MS = 500
const isMacOS = () => navigator.platform.toLowerCase().includes("mac")
const isEditableTarget = (target: EventTarget | null) =>
    target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement
const getBoundedLogFontSize = (fontSize: number) => Math.max(MIN_LOG_FONT_SIZE, Math.min(MAX_LOG_FONT_SIZE, fontSize))
const getLineIndicesOutsideViewport = ({
    displayLength,
    filterLines,
    filteredIndices,
    lineHeight,
    lineCount,
    viewportHeight,
}: {
    displayLength: number
    filterLines: boolean
    filteredIndices: number[]
    lineHeight: number
    lineCount: number
    viewportHeight: number
}) => {
    const animatedLineIndices = new Set(Array.from({ length: lineCount }, (_, index) => index))
    if (displayLength === 0) return animatedLineIndices

    const visibleLineCount = Math.max(1, Math.ceil(viewportHeight / lineHeight))
    const firstVisibleDisplayIndex = Math.max(0, displayLength - visibleLineCount)

    for (let displayIndex = firstVisibleDisplayIndex; displayIndex < displayLength; displayIndex += 1) {
        animatedLineIndices.delete(filterLines ? filteredIndices[displayIndex] : displayIndex)
    }

    return animatedLineIndices
}

const LogLineRow = ({
    animationEpoch,
    fontSize,
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
    disableAnimations,
}: LogLineRowProps) => {
    const shouldAnimate = !disableAnimations && !animatedLineIndicesRef.current.has(sourceLineIndex)
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
                fontSize,
                whiteSpace: wrapLines ? "pre-wrap" : "pre",
                animationDelay: shouldAnimate ? `${animationDelayMs}ms` : undefined,
            }}
        >
            <span className="shrink-0 select-none tabular-nums text-muted-foreground/40">
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
    disableAnimations,
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
    const logViewportRef = useRef<HTMLDivElement>(null)
    const [wrapLines, setWrapLines] = useState(false)
    const [copied, setCopied] = useState(false)
    const [logFontSize, setLogFontSize] = useState(LOG_FONT_SIZE)
    const logLineHeight = Math.round((LINE_HEIGHT / LOG_FONT_SIZE) * logFontSize)
    const logCharWidth = (CHAR_WIDTH / LOG_FONT_SIZE) * logFontSize
    const isLogZoomed = logFontSize !== LOG_FONT_SIZE
    const zoomLabel = `${Math.round((logFontSize / LOG_FONT_SIZE) * 100)}%`

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
    const lastAnimationResetProcIdRef = useRef<string | null>(null)
    const pendingBottomScrollProcIdRef = useRef<string | null>(null)
    const [animationEpoch, setAnimationEpoch] = useState(0)
    const adjustLogFontSize = useCallback((delta: number) => {
        setLogFontSize((value) => getBoundedLogFontSize(value + delta))
    }, [])
    const resetLogFontSize = useCallback(() => setLogFontSize(LOG_FONT_SIZE), [])

    const displayLength = filterLines ? filteredIndices.length : lines.length
    const initialTopMostItemIndex = Math.max(displayLength - 1, 0)
    const getSourceLineIndex = useCallback(
        (displayIndex: number) => (filterLines ? filteredIndices[displayIndex] : displayIndex),
        [filterLines, filteredIndices],
    )

    useLayoutEffect(() => {
        if (lastAnimationResetProcIdRef.current === procId) return

        lastAnimationResetProcIdRef.current = procId
        setWrapLines(false)
        animatedLineIndicesRef.current = getLineIndicesOutsideViewport({
            displayLength,
            filterLines,
            filteredIndices,
            lineCount: lines.length,
            lineHeight: logLineHeight,
            viewportHeight: Math.max(0, (logViewportRef.current?.clientHeight ?? 0) - 32),
        })
        animationOrderRef.current = new Map()
        nextAnimationOrderRef.current = 0
        prevLineCountRef.current = lines.length
        pendingBottomScrollProcIdRef.current = procId
        setAnimationEpoch((value) => value + 1)
    }, [displayLength, filterLines, filteredIndices, lines.length, logLineHeight, procId])

    useLayoutEffect(() => {
        if (!procId || pendingBottomScrollProcIdRef.current !== procId || displayLength === 0) return

        virtuosoRef.current?.scrollToIndex({
            index: displayLength - 1,
            align: "end",
            behavior: "auto",
        })
        pendingBottomScrollProcIdRef.current = null
    }, [displayLength, procId])

    useEffect(() => {
        if (lines.length < prevLineCountRef.current) {
            animatedLineIndicesRef.current = new Set()
            animationOrderRef.current = new Map()
            nextAnimationOrderRef.current = 0
            setAnimationEpoch((value) => value + 1)
        }
        prevLineCountRef.current = lines.length
    }, [lines.length])

    useEffect(() => {
        if (!procId) return

        const handleZoomShortcut = (event: KeyboardEvent) => {
            if (isEditableTarget(event.target)) return

            const modifierPressed = isMacOS() ? event.metaKey : event.ctrlKey
            if (!modifierPressed || event.altKey) return

            if (event.key === "0") {
                event.preventDefault()
                resetLogFontSize()
                return
            }

            if (event.key === "+" || event.key === "=") {
                event.preventDefault()
                adjustLogFontSize(LOG_FONT_SIZE_STEP)
                return
            }

            if (event.key === "-" || event.key === "_") {
                event.preventDefault()
                adjustLogFontSize(-LOG_FONT_SIZE_STEP)
            }
        }

        window.addEventListener("keydown", handleZoomShortcut)
        return () => window.removeEventListener("keydown", handleZoomShortcut)
    }, [adjustLogFontSize, procId, resetLogFontSize])

    const handleLogWheel = useCallback(
        (event: React.WheelEvent<HTMLDivElement>) => {
            const modifierPressed = isMacOS() ? event.metaKey : event.ctrlKey
            if (!modifierPressed) return

            event.preventDefault()
            adjustLogFontSize(event.deltaY < 0 ? LOG_FONT_SIZE_STEP : -LOG_FONT_SIZE_STEP)
        },
        [adjustLogFontSize],
    )

    const maxLineWidth = useMemo(() => {
        if (wrapLines) return 0
        const maxChars = lines.reduce((max, line) => Math.max(max, withoutAnsiColors(line).length), 0)
        return maxChars * logCharWidth + 8
    }, [lines, logCharWidth, wrapLines])

    const scrollToLine = useCallback(
        (lineIndex: number) => {
            const displayIndex = filterLines ? filteredIndices.indexOf(lineIndex) : lineIndex
            if (displayIndex >= 0 && virtuosoRef.current) {
                virtuosoRef.current.scrollToIndex({
                    index: displayIndex,
                    behavior: disableAnimations ? "auto" : "smooth",
                    align: "center",
                })
            }
        },
        [disableAnimations, filterLines, filteredIndices],
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
                fontSize={logFontSize}
                lineHeight={logLineHeight}
                rawLine={rawLine}
                sourceLineIndex={sourceLineIndex}
                wrapLines={wrapLines}
                matchRanges={lineMatches}
                currentMatch={currentMatch}
                isCurrentLine={isCurrentLine}
                animatedLineIndicesRef={animatedLineIndicesRef}
                animationOrderRef={animationOrderRef}
                nextAnimationOrderRef={nextAnimationOrderRef}
                disableAnimations={disableAnimations}
            />
        )
    }

    return (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <div className="flex items-center gap-2 border-b border-border bg-card px-4 py-2">
                <div className="flex min-w-0 items-center gap-1.5">
                    <span
                        className={`inline-block h-2 w-2 rounded-full ${
                            status === "running"
                                ? "animate-pulse-dot bg-status-running"
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
                                onClick={() => void window.oprocsAPI?.openExternalLink(url)}
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
                <div
                    className="relative flex-1 overflow-auto bg-log-bg px-4 py-8 text-center font-mono text-muted-foreground"
                    style={{ fontSize: logFontSize }}
                    onWheel={handleLogWheel}
                >
                    {isLogZoomed ? <LogZoomResetButton label={zoomLabel} onReset={resetLogFontSize} /> : null}
                    No output yet.
                </div>
            ) : (
                <div ref={logViewportRef} className="relative min-h-0 flex-1 bg-log-bg py-4" onWheel={handleLogWheel}>
                    {isLogZoomed ? <LogZoomResetButton label={zoomLabel} onReset={resetLogFontSize} /> : null}
                    {wrapLines ? (
                        <Virtuoso
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
                            ref={virtuosoRef}
                            style={{ height: "100%" }}
                            totalCount={displayLength}
                            initialTopMostItemIndex={initialTopMostItemIndex}
                            itemContent={itemContent}
                            fixedItemHeight={logLineHeight}
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

const LogZoomResetButton = ({ label, onReset }: { label: string; onReset: () => void }) => (
    <button
        type="button"
        onClick={onReset}
        className="absolute right-4 top-3 z-10 flex items-center gap-1 rounded-md border border-accent/30 bg-card/95 px-2 py-1 font-mono text-[11px] text-accent shadow-lg backdrop-blur transition-colors hover:bg-surface-hover"
        title="Reset log zoom"
    >
        <RotateCwIcon className="h-3.5 w-3.5" />
        {label}
    </button>
)

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
                        onClick={() => void window.oprocsAPI?.openExternalLink(urlMatch.url)}
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
