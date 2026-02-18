# oprocs

*oprocs* runs multiple commands in parallel and shows output of each command separately - compatible with [mprocs](https://github.com/pvolok/mprocs) yaml configs.

oprocs is focused on giving you a good searching and filtering experience when looking through your process logs

## Development

```bash
npm install
npm run dev
```

## Build

```bash
npm run build:win
npm run build:mac
npm run build:linux
```

Built installers go to `release/<version>/`. The app auto-updates from [GitHub Releases](https://github.com/Odin94/oprocs/releases). To build and publish in one step, copy `.env.sample` to `.env`, set `GH_TOKEN` to a GitHub personal access token (with `repo` scope), then run:

```bash
npm run release:win
npm run release:mac
npm run release:linux
```

Note that this only creates draft-releases on github that must be manually published.

## Config format

Same as mprocs: `procs` map with entries that have either `shell` or `cmd`, plus optional `cwd`, `env`, `add_path`, `autostart`, `autorestart`, `stop`. `<CONFIG_DIR>` in paths is replaced with the config file directory.


## Credits

* Plant icon: [Growing-plant icons created by Good Ware - Flaticon](https://www.flaticon.com/free-icons/growing-plant)

<!-- TODOdin: -->
<!-- 
* automatically add to path on install
* run in background like "code" does when opening from terminal
* auto-recognize certain host-y things and add open button (eg. vite logging `➜  Local: http://localhost:3000/` - open browser button; same for eg. drizzle-studio)
* Remove the top bar dropdowns
* Configurable hotkeys for everything
 -->
