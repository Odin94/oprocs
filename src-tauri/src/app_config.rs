use crate::types::AppConfig;
use std::{
    fs,
    path::{Path, PathBuf},
};

pub const INIT_CONFIG_CONTENT: &str = r#"# oprocs global configuration
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
"#;

pub fn app_config_path() -> PathBuf {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    if cfg!(windows) {
        home.join(".oprocs").join("oprocs.yaml")
    } else {
        home.join(".config").join(".oprocs").join("oprocs.yaml")
    }
}

fn legacy_app_config_path() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".config")
        .join("oprocs")
        .join("config.yaml")
}

pub fn init_config() -> Result<PathBuf, String> {
    let path = app_config_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::write(&path, INIT_CONFIG_CONTENT).map_err(|error| error.to_string())?;
    Ok(path)
}

pub fn load_app_config() -> AppConfig {
    let current = app_config_path();
    let legacy = legacy_app_config_path();
    let path = if current.exists() {
        current.clone()
    } else if legacy.exists() {
        legacy
    } else {
        if let Err(error) = init_config() {
            eprintln!("[oprocs] Failed to create app config: {error}");
        }
        return AppConfig::default();
    };

    let result = fs::read_to_string(&path)
        .map_err(|error| error.to_string())
        .and_then(|raw| serde_yaml::from_str::<AppConfig>(&raw).map_err(|error| error.to_string()));

    match result {
        Ok(config) => config,
        Err(error) => {
            eprintln!("[oprocs] Invalid app config at {}: {error}", path.display());
            AppConfig::default()
        }
    }
}

pub fn resolve_path_template(template: &str, folder_name: &str) -> PathBuf {
    let expanded = if template == "~" || template.starts_with("~/") || template.starts_with("~\\") {
        let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
        home.join(
            template
                .trim_start_matches('~')
                .trim_start_matches(['/', '\\']),
        )
    } else {
        PathBuf::from(template)
    };

    PathBuf::from(
        expanded
            .to_string_lossy()
            .replace("{folder_name}", folder_name),
    )
}

pub fn resolve_data_dir(configured: &Option<String>, config_dir: &Path) -> PathBuf {
    match configured {
        Some(template) => resolve_path_template(
            template,
            config_dir
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or_default(),
        ),
        None => config_dir.join(".oprocs"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn substitutes_folder_name() {
        let path = resolve_path_template("/tmp/{folder_name}/logs", "project");
        assert_eq!(path, PathBuf::from("/tmp/project/logs"));
    }

    #[test]
    fn app_config_defaults_match_the_frontend_contract() {
        let config = AppConfig::default();
        assert!(!config.disable_animations);
        assert!(!config.quiet);
        assert!(!config.no_logs);
    }
}
