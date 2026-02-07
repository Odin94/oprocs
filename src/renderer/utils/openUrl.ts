import { withoutAnsiColors } from "./ansi"

export const getOpenUrl = (text: string) => {
    let openUrl = matchViteReact(text)
    if (openUrl) return openUrl
    return
}

const matchViteReact = (text: string) => {
    const regex = /➜\s+Local:\s+(https?:\/\/[^\s]+)/
    const match = regex.exec(withoutAnsiColors(text))

    return match ? match[1] : undefined
}
