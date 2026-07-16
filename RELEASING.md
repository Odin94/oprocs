# Release Process

Releases are built with Tauri. Each platform build produces its installer, updater archive, and signature under
`src-tauri/target/release/bundle/`.

## Prerequisites

Store the updater private key in a secure secret manager. The matching public key is committed in
`src-tauri/tauri.conf.json`. For a local build, export:

```sh
export TAURI_SIGNING_PRIVATE_KEY=/secure/path/to/oprocs.key
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD='your-key-password'
```

The development key generated during the migration is ignored under `.tauri-local/`; replace the public key before
the first production release if that local private key will not be retained.

## How to cut a release

### 1. Bump the version

Choose the appropriate bump type based on [semver](https://semver.org/):

```sh
pnpm run version:patch  # 0.1.1 -> 0.1.2  (bug fixes)
pnpm run version:minor  # 0.1.1 -> 0.2.0  (new features, backwards-compatible)
pnpm run version:major  # 0.1.1 -> 1.0.0  (breaking changes)
```

These scripts update `package.json`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`, and
`src-tauri/tauri.conf.json` together. Commit the version changes and create the matching `v0.3.2` tag.

### 2. Push the commit and tag

```sh
git push && git push --tags
```

### 3. Build and publish

Run the release build on each target operating system:

```sh
pnpm run build:win
pnpm run build:mac
pnpm run build:linux
```

Upload each installer, updater archive, and `.sig` file to the GitHub release. Create a `latest.json` whose platform
entries contain the release URL and the literal contents of each `.sig` file:

```json
{
    "version": "0.3.2",
    "notes": "Release notes",
    "pub_date": "2026-07-15T00:00:00Z",
    "platforms": {
        "darwin-aarch64": {
            "url": "https://github.com/Odin94/oprocs/releases/download/v0.3.2/oprocs.app.tar.gz",
            "signature": "contents of oprocs.app.tar.gz.sig"
        }
    }
}
```

Add entries for every released `OS-ARCH` pair and upload `latest.json` to the same release. Tauri Action can generate
this static manifest automatically if releases are moved to GitHub Actions later.

### 4. Edit the release notes (optional)

You can add a hand-written summary at the top of the release description at:
https://github.com/Odin94/oprocs/releases (adjust for your repository)

## How auto-update works

When a new release is published, existing installs check GitHub on startup (after a 3-second delay). If a newer version is available, it downloads in the background and prompts the user to restart.

The app checks `latest.json` three seconds after launch, verifies the downloaded artifact with the configured updater
public key, and offers to restart after the update is ready.

## Artifact naming

Tauri's bundle directories contain the native installer names and their updater archives. Keep the generated names
when uploading them because `latest.json` points at those assets.

## macOS code signing (future)

Updater signing does not replace Apple code signing or notarization. Configure the relevant Tauri macOS signing
environment variables before distributing outside local development.
