import type { ReactNode, SVGProps } from "react"

type IconProps = SVGProps<SVGSVGElement>

const baseProps = {
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    viewBox: "0 0 24 24",
}

function icon(path: ReactNode) {
    return function Icon(props: IconProps) {
        return (
            <svg aria-hidden="true" {...baseProps} {...props}>
                {path}
            </svg>
        )
    }
}

export const SearchIcon = icon(
    <>
        <circle cx="11" cy="11" r="8" />
        <path d="m21 21-4.35-4.35" />
    </>,
)

export const CaseSensitiveIcon = icon(
    <>
        <path d="M4 19 10 5l6 14" />
        <path d="M6.5 13h7" />
        <path d="M17 12h3" />
        <path d="M18.5 9v6" />
    </>,
)

export const FilterIcon = icon(
    <>
        <path d="M3 5h18" />
        <path d="M6 12h12" />
        <path d="M10 19h4" />
    </>,
)

export const ChevronUpIcon = icon(<path d="m18 15-6-6-6 6" />)

export const ChevronDownIcon = icon(<path d="m6 9 6 6 6-6" />)

export const TrashIcon = icon(
    <>
        <path d="M3 6h18" />
        <path d="M8 6V4h8v2" />
        <path d="m19 6-1 14H6L5 6" />
        <path d="M10 11v6" />
        <path d="M14 11v6" />
    </>,
)

export const ArrowDownToLineIcon = icon(
    <>
        <path d="M12 3v12" />
        <path d="m7 10 5 5 5-5" />
        <path d="M5 21h14" />
    </>,
)

export const ExternalLinkIcon = icon(
    <>
        <path d="M15 3h6v6" />
        <path d="M10 14 21 3" />
        <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    </>,
)

export const SquareIcon = icon(<rect x="6" y="6" width="12" height="12" rx="1" />)

export const RotateCwIcon = icon(
    <>
        <path d="M21 12a9 9 0 1 1-2.64-6.36" />
        <path d="M21 3v6h-6" />
    </>,
)

export const StopCircleIcon = icon(
    <>
        <circle cx="12" cy="12" r="9" />
        <rect x="9" y="9" width="6" height="6" rx="1" />
    </>,
)

export const RefreshCwIcon = icon(
    <>
        <path d="M3 12a9 9 0 0 1 15.55-6.36L21 8" />
        <path d="M21 3v5h-5" />
        <path d="M21 12a9 9 0 0 1-15.55 6.36L3 16" />
        <path d="M8 21H3v-5" />
    </>,
)

export const FlowerIcon = icon(
    <>
        <circle cx="12" cy="12" r="2.5" />
        <path d="M12 4c1.7 0 3 1.3 3 3s-1.3 3-3 3-3-1.3-3-3 1.3-3 3-3Z" />
        <path d="M20 12c0 1.7-1.3 3-3 3s-3-1.3-3-3 1.3-3 3-3 3 1.3 3 3Z" />
        <path d="M12 20c-1.7 0-3-1.3-3-3s1.3-3 3-3 3 1.3 3 3-1.3 3-3 3Z" />
        <path d="M4 12c0-1.7 1.3-3 3-3s3 1.3 3 3-1.3 3-3 3-3-1.3-3-3Z" />
    </>,
)

export const TerminalIcon = icon(
    <>
        <path d="m4 17 6-5-6-5" />
        <path d="M12 19h8" />
    </>,
)

export const PlayIcon = icon(<path d="m8 5 11 7-11 7V5Z" />)

export const WrapTextIcon = icon(
    <>
        <path d="M4 6h12a4 4 0 0 1 0 8H9" />
        <path d="m9 14 3 3-3 3" />
        <path d="M4 10h10" />
        <path d="M4 18h5" />
    </>,
)
