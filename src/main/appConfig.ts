import fs from "fs"
import path from "path"
import os from "os"
import yaml from "js-yaml"
import { z } from "zod"

const AppConfigSchema = z.object({
    // Directory for process log files. Supports {folder_name} variable.
    logs_dir: z.string().optional(),
    // Directory for the lock file. Supports {folder_name} variable.
    lock_dir: z.string().optional(),
    // Disable UI animations and transitions.
    disable_animations: z.boolean().default(false),
    // Suppress oprocs' own log output to the terminal.
    quiet: z.boolean().default(false),
    // Disable writing process output to log files on disk.
    no_logs: z.boolean().default(false),
})

export type AppConfig = z.infer<typeof AppConfigSchema>

export const DEFAULT_APP_CONFIG: AppConfig = {
    disable_animations: false,
    quiet: false,
    no_logs: false,
}

export function getAppConfigPath(platform = process.platform, homeDir = os.homedir()): string {
    if (platform === "win32") return path.join(homeDir, ".oprocs", "oprocs.yaml")
    return path.join(homeDir, ".config", ".oprocs", "oprocs.yaml")
}

function getLegacyAppConfigPath(): string {
    return path.join(os.homedir(), ".config", "oprocs", "config.yaml")
}

function ensureAppConfigFile(configPath: string): void {
    if (fs.existsSync(configPath)) return
    fs.mkdirSync(path.dirname(configPath), { recursive: true })
    fs.writeFileSync(configPath, INIT_CONFIG_CONTENT, "utf-8")
}

export function loadAppConfig(): AppConfig {
    const configPath = getAppConfigPath()
    const legacyConfigPath = getLegacyAppConfigPath()
    const pathToRead = fs.existsSync(configPath)
        ? configPath
        : fs.existsSync(legacyConfigPath)
          ? legacyConfigPath
          : configPath
    if (!fs.existsSync(pathToRead)) {
        ensureAppConfigFile(configPath)
        return DEFAULT_APP_CONFIG
    }
    try {
        const raw = fs.readFileSync(pathToRead, "utf-8")
        const parsed = yaml.load(raw)
        const result = AppConfigSchema.safeParse(parsed ?? {})
        if (!result.success) {
            console.warn(`[oprocs] Invalid app config at ${pathToRead}:`, result.error.message)
            return DEFAULT_APP_CONFIG
        }
        return result.data
    } catch (err) {
        console.warn(`[oprocs] Failed to read app config at ${pathToRead}:`, err)
        return DEFAULT_APP_CONFIG
    }
}

/**
 * Resolves a path template, expanding ~ to the home directory and
 * substituting {folder_name} with the given folder name.
 */
export function resolvePathTemplate(template: string, folderName: string): string {
    const withHome = template.replace(/^~(?=[\\/]|$)/, os.homedir())
    const substituted = withHome.replace(/\{folder_name\}/g, folderName)
    return path.normalize(substituted)
}

const INIT_CONFIG_CONTENT = `# oprocs global configuration
# This file is read on startup. All values are optional; delete or comment out any line to use the default.

# Directory for process log files.
# Supports {folder_name}: the name of the directory containing your oprocs/mprocs config file.
# If unset, logs are stored at <config-file-dir>/.oprocs/<proc-name>.log
# Example: logs_dir: "~/.oprocs-logs/{folder_name}"
# logs_dir:

# Directory for the oprocs lock file (.oprocs.lock).
# Supports {folder_name}: the name of the directory containing your oprocs/mprocs config file.
# If unset, the lock file is stored at <config-file-dir>/.oprocs/.oprocs.lock
# Example: lock_dir: "~/.oprocs-locks/{folder_name}"
# lock_dir:

# Disable UI animations and transitions.
# Default: false
disable_animations: false

# Quiet mode: suppress oprocs' own log output to the terminal.
# Does not affect what is shown in the UI.
# Default: false
quiet: false

# No-logs mode: disable writing process output to log files on disk.
# Default: false
no_logs: false
`

export function initConfig(): void {
    const configPath = getAppConfigPath()
    const configDir = path.dirname(configPath)
    fs.mkdirSync(configDir, { recursive: true })
    fs.writeFileSync(configPath, INIT_CONFIG_CONTENT, "utf-8")
    console.log(`Config written to: ${configPath}`)
}
