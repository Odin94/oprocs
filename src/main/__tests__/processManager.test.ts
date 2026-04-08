import { describe, expect, it } from "vitest"
import { withWindowsUtf8CmdArgs, withWindowsUtf8Shell } from "../processManager.js"

describe("Windows UTF-8 process wrapping", () => {
    it("prepends chcp for cmd shell commands", () => {
        expect(withWindowsUtf8Shell("echo \u00e4\u00f6\u00fc", "cmd.exe")).toBe("chcp 65001>nul && echo \u00e4\u00f6\u00fc")
    })

    it("prepends encoding setup for powershell shell commands", () => {
        expect(withWindowsUtf8Shell("Write-Output '\u00e4\u00f6\u00fc'", "powershell.exe")).toContain("[Console]::OutputEncoding")
    })

    it("rewrites cmd /c commands to force utf8", () => {
        expect(withWindowsUtf8CmdArgs("cmd.exe", ["/c", "echo \u00e4\u00f6\u00fc"])).toEqual([
            "/c",
            "chcp 65001>nul && echo \u00e4\u00f6\u00fc",
        ])
    })

    it("rewrites powershell -Command to force utf8", () => {
        const out = withWindowsUtf8CmdArgs("powershell.exe", ["-NoProfile", "-Command", "Write-Output '\u00e4\u00f6\u00fc'"])
        expect(out[2]).toContain("[Console]::OutputEncoding")
        expect(out[2]).toContain("Write-Output '\u00e4\u00f6\u00fc'")
    })

    it("leaves unrelated commands unchanged", () => {
        expect(withWindowsUtf8CmdArgs("node", ["server.js"])).toEqual(["server.js"])
    })
})
