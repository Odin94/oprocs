import { withoutAnsiColors } from "./ansi"

export type PortConflict = {
    port: number
}

const normalizePort = (value: string): number | null => {
    const port = Number(value)
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null
    return port
}

const matchPortAlreadyInUse = (text: string): number | null => {
    const match = /\bPort\s+(\d{1,5})\s+is\s+already\s+in\s+use\b/i.exec(text)
    return match ? normalizePort(match[1]) : null
}

const matchAddressAlreadyInUse = (text: string): number | null => {
    const conflictIndex = text.search(/\b(?:EADDRINUSE|address\s+already\s+in\s+use)\b/i)
    if (conflictIndex < 0) return null

    const conflictText = text.slice(conflictIndex, conflictIndex + 400)
    const match = /(?::|\])(\d{1,5})(?!\d)/.exec(conflictText)
    return match ? normalizePort(match[1]) : null
}

export const findPortConflict = (text: string): PortConflict | undefined => {
    const normalized = withoutAnsiColors(text)
    const port = matchPortAlreadyInUse(normalized) ?? matchAddressAlreadyInUse(normalized)
    return port == null ? undefined : { port }
}
