import { withoutAnsiColors } from "./ansi"

export const getOpenUrl = (text: string) => {
    const normalized = withoutAnsiColors(text)
    return matchViteReact(normalized) ?? matchFastify(normalized)
}

const matchViteReact = (text: string) => {
    const regex = /➜\s+Local:\s+(https?:\/\/[^\s]+)/
    const match = regex.exec(text)
    return match ? match[1] : undefined
}

const matchFastify = (text: string) => {
    const regex = /Server listening (?:at|on) (https?:\/\/[^\s]+)/
    const match = regex.exec(text)
    return match ? match[1] : undefined
}
