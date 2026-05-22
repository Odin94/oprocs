import { describe, expect, it } from "vitest"
import { extractUrls, findUrlMatches } from "./links"

describe("links", () => {
    it("finds urls after stripping ansi codes", () => {
        const line = "  ?  Local:   http://localhost:\u001b[1m3000\u001b[22m/\u001b[39m"

        expect(findUrlMatches(line)).toEqual([
            {
                start: 13,
                end: 35,
                url: "http://localhost:3000/",
            },
        ])
    })

    it("deduplicates preferred and detected urls", () => {
        const lines = ["  ?  Local:   http://localhost:\u001b[1m3000\u001b[22m/\u001b[39m"]

        expect(extractUrls(lines, "http://localhost:3000")).toEqual(["http://localhost:3000"])
    })
})
