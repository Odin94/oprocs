import { describe, expect, it } from "vitest"
import { findPortConflict } from "./portConflicts"

describe("port conflict detection", () => {
    it("matches EADDRINUSE with an all interfaces address", () => {
        expect(findPortConflict("EADDRINUSE: address already in use 0.0.0.0:3001")).toEqual({ port: 3001 })
    })

    it("matches EADDRINUSE with a localhost address", () => {
        expect(findPortConflict("EADDRINUSE: address already in use 127.0.0.1:4983")).toEqual({ port: 4983 })
    })

    it("matches vite-style port conflict messages", () => {
        expect(findPortConflict("Port 5173 is already in use")).toEqual({ port: 5173 })
        expect(findPortConflict("Port 3000 is already in use")).toEqual({ port: 3000 })
    })

    it("matches node listen errors with an IPv6 wildcard", () => {
        expect(findPortConflict("Error: listen EADDRINUSE: address already in use :::3000")).toEqual({ port: 3000 })
    })

    it("ignores out-of-range ports", () => {
        expect(findPortConflict("Port 70000 is already in use")).toBeUndefined()
    })
})
