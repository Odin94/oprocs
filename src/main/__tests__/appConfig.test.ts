import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "fs"
import path from "path"
import os from "os"
import { loadAppConfig, resolvePathTemplate, getAppConfigPath, DEFAULT_APP_CONFIG } from "../appConfig.js"

describe("resolvePathTemplate", () => {
    it("substitutes {folder_name}", () => {
        expect(resolvePathTemplate("/some/path/{folder_name}/logs", "myapp")).toBe(
            path.normalize("/some/path/myapp/logs"),
        )
    })

    it("substitutes multiple occurrences of {folder_name}", () => {
        expect(resolvePathTemplate("{folder_name}/{folder_name}.log", "proj")).toBe(path.normalize("proj/proj.log"))
    })

    it("expands leading ~ to home directory", () => {
        const result = resolvePathTemplate("~/.oprocs/{folder_name}", "myapp")
        expect(result).toBe(path.join(os.homedir(), ".oprocs", "myapp"))
    })

    it("does not expand ~ in the middle of a path", () => {
        expect(resolvePathTemplate("/some/~/path", "x")).toBe(path.normalize("/some/~/path"))
    })

    it("leaves paths without variables unchanged", () => {
        expect(resolvePathTemplate("/fixed/path", "anything")).toBe(path.normalize("/fixed/path"))
    })
})

describe("getAppConfigPath", () => {
    it("uses ~/.oprocs/oprocs.yaml on Windows", () => {
        expect(getAppConfigPath("win32", "C:\\Users\\me")).toBe(path.join("C:\\Users\\me", ".oprocs", "oprocs.yaml"))
    })

    it("uses ~/.config/.oprocs/oprocs.yaml on Unix-like platforms", () => {
        expect(getAppConfigPath("linux", "/home/me")).toBe(path.join("/home/me", ".config", ".oprocs", "oprocs.yaml"))
    })
})

describe("loadAppConfig", () => {
    let tmpDir: string
    let originalHome: string | undefined

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oprocs-test-"))
        originalHome = process.env.HOME
        // Point HOME to tmpDir so getAppConfigPath resolves under tmpDir
        process.env.HOME = tmpDir
        if (process.platform === "win32") {
            process.env.USERPROFILE = tmpDir
        }
    })

    afterEach(() => {
        process.env.HOME = originalHome
        if (process.platform === "win32") {
            process.env.USERPROFILE = originalHome
        }
        fs.rmSync(tmpDir, { recursive: true, force: true })
    })

    it("creates the default config and returns defaults when config file does not exist", () => {
        const configPath = getAppConfigPath()
        const config = loadAppConfig()
        expect(config).toEqual(DEFAULT_APP_CONFIG)
        expect(fs.existsSync(configPath)).toBe(true)
        expect(fs.readFileSync(configPath, "utf-8")).toContain("disable_animations: false")
    })

    it("parses valid config file", () => {
        const configPath = getAppConfigPath()
        fs.mkdirSync(path.dirname(configPath), { recursive: true })
        fs.writeFileSync(
            configPath,
            `logs_dir: "~/.oprocs-logs/{folder_name}"\nlock_dir: "/tmp/locks"\ndisable_animations: true\nquiet: true\nno_logs: true\n`,
            "utf-8",
        )

        const config = loadAppConfig()
        expect(config.logs_dir).toBe("~/.oprocs-logs/{folder_name}")
        expect(config.lock_dir).toBe("/tmp/locks")
        expect(config.disable_animations).toBe(true)
        expect(config.quiet).toBe(true)
        expect(config.no_logs).toBe(true)
    })

    it("uses defaults for unset fields", () => {
        const configPath = getAppConfigPath()
        fs.mkdirSync(path.dirname(configPath), { recursive: true })
        fs.writeFileSync(configPath, `quiet: true\n`, "utf-8")

        const config = loadAppConfig()
        expect(config.quiet).toBe(true)
        expect(config.disable_animations).toBe(false)
        expect(config.no_logs).toBe(false)
        expect(config.logs_dir).toBeUndefined()
        expect(config.lock_dir).toBeUndefined()
    })

    it("returns defaults on invalid YAML types", () => {
        const configPath = getAppConfigPath()
        fs.mkdirSync(path.dirname(configPath), { recursive: true })
        fs.writeFileSync(configPath, `quiet: "not-a-boolean"\n`, "utf-8")

        const config = loadAppConfig()
        expect(config).toEqual(DEFAULT_APP_CONFIG)
    })

    it("returns defaults when file is empty", () => {
        const configPath = getAppConfigPath()
        fs.mkdirSync(path.dirname(configPath), { recursive: true })
        fs.writeFileSync(configPath, "", "utf-8")

        const config = loadAppConfig()
        expect(config).toEqual(DEFAULT_APP_CONFIG)
    })
})
