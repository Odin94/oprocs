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
    // Suppress oprocs' own log output to the terminal.
    quiet: z.boolean().default(false),
    // Disable writing process output to log files on disk.
    no_logs: z.boolean().default(false),
})

export type AppConfig = z.infer<typeof AppConfigSchema>

export const DEFAULT_APP_CONFIG: AppConfig = {
    quiet: false,
    no_logs: false,
}

export function getAppConfigPath(): string {
    return path.join(os.homedir(), ".config", "oprocs", "config.yaml")
}

export function loadAppConfig(): AppConfig {
    const configPath = getAppConfigPath()
    if (!fs.existsSync(configPath)) {
        return DEFAULT_APP_CONFIG
    }
    try {
        const raw = fs.readFileSync(configPath, "utf-8")
        const parsed = yaml.load(raw)
        const result = AppConfigSchema.safeParse(parsed ?? {})
        if (!result.success) {
            console.warn(`[oprocs] Invalid app config at ${configPath}:`, result.error.message)
            return DEFAULT_APP_CONFIG
        }
        return result.data
    } catch (err) {
        console.warn(`[oprocs] Failed to read app config at ${configPath}:`, err)
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
