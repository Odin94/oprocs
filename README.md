# oprocs

*oprocs* runs multiple commands in parallel and shows output of each command separately - compatible with [mprocs](https://github.com/pvolok/mprocs) yaml configs.

oprocs is focused on giving you a good searching and filtering experience when looking through your process logs

## Development

```bash
npm install
npm run dev
```

## Config format

Same as mprocs: `procs` map with entries that have either `shell` or `cmd`, plus optional `cwd`, `env`, `add_path`, `autostart`, `autorestart`, `stop`. `<CONFIG_DIR>` in paths is replaced with the config file directory.

