import { useEffect, useRef, useState } from "react"
import type { ButtonHTMLAttributes, ReactNode } from "react"
import { createPortal } from "react-dom"

type TooltipPosition = {
    top: number
    left: number
}

type TooltipButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "title"> & {
    tooltip: string
    tooltipDelayMs?: number
    children: ReactNode
}

export function TooltipButton({
    tooltip,
    tooltipDelayMs = 300,
    children,
    onMouseEnter,
    onMouseLeave,
    onFocus,
    onBlur,
    ...buttonProps
}: TooltipButtonProps) {
    const [tooltipPosition, setTooltipPosition] = useState<TooltipPosition | null>(null)
    const tooltipTimerRef = useRef<number | null>(null)

    const showTooltip = (button: HTMLButtonElement) => {
        const rect = button.getBoundingClientRect()
        setTooltipPosition({
            top: rect.bottom + 8,
            left: rect.left + rect.width / 2,
        })
    }

    const scheduleTooltip = (button: HTMLButtonElement) => {
        if (button.disabled) return
        if (tooltipTimerRef.current != null) window.clearTimeout(tooltipTimerRef.current)
        tooltipTimerRef.current = window.setTimeout(() => {
            showTooltip(button)
            tooltipTimerRef.current = null
        }, tooltipDelayMs)
    }

    const hideTooltip = () => {
        if (tooltipTimerRef.current != null) {
            window.clearTimeout(tooltipTimerRef.current)
            tooltipTimerRef.current = null
        }
        setTooltipPosition(null)
    }

    useEffect(() => hideTooltip, [])

    return (
        <>
            <button
                {...buttonProps}
                type={buttonProps.type ?? "button"}
                onMouseEnter={(event) => {
                    onMouseEnter?.(event)
                    scheduleTooltip(event.currentTarget)
                }}
                onMouseLeave={(event) => {
                    onMouseLeave?.(event)
                    hideTooltip()
                }}
                onFocus={(event) => {
                    onFocus?.(event)
                    scheduleTooltip(event.currentTarget)
                }}
                onBlur={(event) => {
                    onBlur?.(event)
                    hideTooltip()
                }}
                aria-label={buttonProps["aria-label"] ?? tooltip}
            >
                {children}
            </button>
            {tooltipPosition
                ? createPortal(
                      <div
                          role="tooltip"
                          className="process-card-tooltip"
                          style={{ top: tooltipPosition.top, left: tooltipPosition.left }}
                      >
                          {tooltip}
                      </div>,
                      document.body,
                  )
                : null}
        </>
    )
}
