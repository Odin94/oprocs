# Release Process

Releases are built and published from your local machine using electron-builder, which uploads artifacts directly to GitHub Releases via the GitHub API.

## Prerequisites

Copy `.env.sample` to `.env` and set `GH_TOKEN` to a GitHub personal access token with `repo` scope.

## How to cut a release

### 1. Bump the version

Choose the appropriate bump type based on [semver](https://semver.org/):

```sh
npm run version:patch   # 0.1.1 → 0.1.2  (bug fixes)
npm run version:minor   # 0.1.1 → 0.2.0  (new features, backwards-compatible)
npm run version:major   # 0.1.1 → 1.0.0  (breaking changes)
```

This command:
- Updates `version` in `package.json`
- Creates a commit and git tag: `v0.1.2`

### 2. Push the commit and tag

```sh
git push && git push --tags
```

### 3. Build and publish

Run the release script for each platform you want to publish. Each command builds the app and uploads the artifact directly to the GitHub Release for the current version tag:

```sh
npm run release:win
npm run release:mac
npm run release:linux
```

> **Note:** macOS and Linux builds must be run on their respective platforms. Windows builds can be cross-compiled from any platform.

### 4. Edit the release notes (optional)

You can add a hand-written summary at the top of the release description at:
https://github.com/Odin94/oprocs/releases  (adjust for your repository)

## How auto-update works

When a new release is published, existing installs check GitHub on startup (after a 3-second delay). If a newer version is available, it downloads in the background and prompts the user to restart.

The update metadata files (`latest.yml`, `latest-mac.yml`, `latest-linux.yml`) are uploaded automatically by electron-builder as part of each release.

## Artifact naming

| Platform | Artifact |
|----------|----------|
| Windows  | `oprocs-Windows-{version}-Setup.exe` |
| macOS    | `oprocs-Mac-{version}.dmg` |
| Linux    | `oprocs-Linux-{version}.AppImage` |

## macOS code signing (future)

macOS builds are currently unsigned. Users must right-click → Open the first time to bypass Gatekeeper. To fix this, add `CSC_LINK` (p12 certificate) and `CSC_KEY_PASSWORD` to your `.env` and configure the `mac.identity` field in `package.json`.
