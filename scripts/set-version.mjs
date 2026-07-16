import fs from "node:fs"

const bump = process.argv[2]
if (!new Set(["patch", "minor", "major"]).has(bump)) {
    throw new Error("Expected one of: patch, minor, major")
}

const packageJson = JSON.parse(fs.readFileSync("package.json", "utf8"))
const current = String(packageJson.version).match(/^(\d+)\.(\d+)\.(\d+)$/)
if (!current) throw new Error(`Unsupported current version: ${packageJson.version}`)

let [, major, minor, patch] = current.map(Number)
if (bump === "major") {
    major += 1
    minor = 0
    patch = 0
} else if (bump === "minor") {
    minor += 1
    patch = 0
} else {
    patch += 1
}
const next = `${major}.${minor}.${patch}`

packageJson.version = next
fs.writeFileSync("package.json", `${JSON.stringify(packageJson, null, 4)}\n`)

const cargoToml = fs.readFileSync("src-tauri/Cargo.toml", "utf8")
fs.writeFileSync("src-tauri/Cargo.toml", cargoToml.replace(/^version = "[^"]+"/m, `version = "${next}"`))

const cargoLock = fs.readFileSync("src-tauri/Cargo.lock", "utf8")
fs.writeFileSync(
    "src-tauri/Cargo.lock",
    cargoLock.replace(/(\[\[package\]\]\nname = "oprocs"\nversion = ")[^"]+"/, `$1${next}"`),
)

const tauriConfig = JSON.parse(fs.readFileSync("src-tauri/tauri.conf.json", "utf8"))
tauriConfig.version = next
fs.writeFileSync("src-tauri/tauri.conf.json", `${JSON.stringify(tauriConfig, null, 4)}\n`)

console.log(`Version updated to ${next}`)
