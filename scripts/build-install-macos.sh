#!/usr/bin/env bash

set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
    echo "This installer currently supports macOS only." >&2
    exit 1
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="$(cd "$script_dir/.." && pwd)"
built_app="$repo_dir/src-tauri/target/release/bundle/macos/oprocs.app"
installed_app="/Applications/oprocs.app"
installed_command="/usr/local/bin/oprocs"
staged_app="/Applications/.oprocs.app.installing.$$"
backup_app="/Applications/.oprocs.app.backup.$$"
sudo_command=()

if ! command -v pnpm >/dev/null 2>&1; then
    echo "pnpm is required to build oprocs." >&2
    exit 1
fi

cd "$repo_dir"

echo "Installing locked dependencies..."
pnpm install --frozen-lockfile

echo "Building the macOS application..."
pnpm exec tauri build \
    --bundles app \
    --no-sign \
    --config '{"bundle":{"createUpdaterArtifacts":false}}'

if [[ ! -x "$built_app/Contents/MacOS/oprocs" ]]; then
    echo "The build completed without producing $built_app." >&2
    exit 1
fi

if [[ ! -w /Applications || ! -d /usr/local/bin || ! -w /usr/local/bin || \
    ( -e "$installed_command" && ! -w "$installed_command" ) ]]; then
    echo "Administrator access is required to install in /Applications and /usr/local/bin."
    sudo_command=(sudo)
fi

cleanup() {
    "${sudo_command[@]}" rm -rf "$staged_app"
}
trap cleanup EXIT

echo "Installing $installed_app..."
"${sudo_command[@]}" mkdir -p /usr/local/bin
"${sudo_command[@]}" rm -rf "$staged_app" "$backup_app"
"${sudo_command[@]}" ditto "$built_app" "$staged_app"

if [[ -e "$installed_app" ]]; then
    "${sudo_command[@]}" mv "$installed_app" "$backup_app"
fi

if "${sudo_command[@]}" mv "$staged_app" "$installed_app"; then
    "${sudo_command[@]}" rm -rf "$backup_app"
else
    if [[ -e "$backup_app" ]]; then
        "${sudo_command[@]}" mv "$backup_app" "$installed_app"
    fi
    echo "Failed to install the new application; the previous installation was restored." >&2
    exit 1
fi

echo "Installing the terminal command at $installed_command..."
"${sudo_command[@]}" install -m 0755 "$script_dir/oprocs-macos-launcher" "$installed_command"

trap - EXIT

if [[ ":$PATH:" != *":/usr/local/bin:"* ]]; then
    echo "Installed successfully. Add /usr/local/bin to PATH before running 'oprocs'."
else
    echo "Installed successfully. Run 'oprocs' from any directory."
fi
