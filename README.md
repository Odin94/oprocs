# oprocs

_oprocs_ runs multiple commands in parallel and shows output of each command separately - compatible with [mprocs](https://github.com/pvolok/mprocs) yaml configs.

oprocs is focused on giving you a good searching and filtering experience when looking through your process logs

## Development

```bash
pnpm install
pnpm run dev
```

The desktop shell is built with Tauri 2 and Rust. Install the platform prerequisites from the
[Tauri prerequisites guide](https://v2.tauri.app/start/prerequisites/) before starting development.

To run only the Vite frontend in a browser, use `pnpm run dev:web`. Native process controls are available only inside
the Tauri app.

## Build

```bash
pnpm run build:app
```

Tauri writes installers to `src-tauri/target/release/bundle/`. Builds are platform-native; use `pnpm run build:win`,
`pnpm run build:mac`, or `pnpm run build:linux` on the corresponding operating system when you only want that
platform's installer. The app auto-updates from [GitHub Releases](https://github.com/Odin94/oprocs/releases).

For publishing a release, see [RELEASING.md](./RELEASING.md).

On macOS, build and install the app plus its terminal command with:

```bash
pnpm run install:mac
```

The script installs the app at `/Applications/oprocs.app` and a launcher at `/usr/local/bin/oprocs`; it may ask for
an administrator password. Run `oprocs` from a project directory to open that directory's config, or pass another
directory explicitly with `oprocs /path/to/project`.

## Config format

Same as mprocs: `procs` map with entries that have either `shell` or `cmd`, plus optional `cwd`, `env`, `add_path`, `autostart`, `autorestart`, `stop`. `<CONFIG_DIR>` in paths is replaced with the config file directory.

## Global config

oprocs creates and reads a global config file at `~/.config/.oprocs/oprocs.yaml` on Unix-like systems and `~/.oprocs/oprocs.yaml` on Windows. Set `disable_animations: true` there to disable UI animations and transitions.

## Credits

- Plant icon: [Growing-plant icons created by Good Ware - Flaticon](https://www.flaticon.com/free-icons/growing-plant)

<!-- TODOdin: -->
<!--
* automatically add to path on install
* run in background like "code" does when opening from terminal
* auto-recognize certain host-y things and add open button (eg. vite logging `➜  Local: http://localhost:3000/` - open browser button; same for eg. drizzle-studio)
* Remove the top bar dropdowns
* Configurable hotkeys for everything
 -->
