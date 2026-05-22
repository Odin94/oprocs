import { withoutAnsiColors } from "./ansi"

export const URL_REGEX = /https?:\/\/[^\s\"',)}\]>]+/g

export type UrlMatch = {
    start: number
    end: number
    url: string
}

export const findUrlMatches = (text: string): UrlMatch[] => {
    const normalized = withoutAnsiColors(text)
    const matches = normalized.matchAll(new RegExp(URL_REGEX.source, "g"))
    return Array.from(matches, (match) => ({
        start: match.index ?? 0,
        end: (match.index ?? 0) + match[0].length,
        url: match[0],
    }))
}

export const canonicalizeUrl = (url: string) => {
    const normalized = withoutAnsiColors(url).trim()
    try {
        const parsed = new URL(normalized)
        const pathname = parsed.pathname === "/" && !parsed.search && !parsed.hash ? "" : parsed.pathname
        return `${parsed.protocol}//${parsed.host}${pathname}${parsed.search}${parsed.hash}`
    } catch {
        return normalized
    }
}

export const extractUrls = (lines: string[], preferredUrl?: string, limit = 3) => {
    const seen = new Set<string>()
    const urls: string[] = []

    const addUrl = (candidate?: string) => {
        if (!candidate) return
        const canonical = canonicalizeUrl(candidate)
        if (!canonical || seen.has(canonical)) return
        seen.add(canonical)
        urls.push(canonical)
    }

    addUrl(preferredUrl)

    for (const line of lines) {
        for (const match of findUrlMatches(line)) {
            addUrl(match.url)
            if (urls.length >= limit) return urls
        }
    }

    return urls
}
