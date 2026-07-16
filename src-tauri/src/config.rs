use crate::types::{LoadedConfig, ProcConfig};
use indexmap::IndexMap;
use serde_yaml::{Mapping, Value};
use std::{fs, path::Path};

fn platform_name(platform: &str) -> &str {
    match platform {
        "windows" | "win32" => "windows",
        "macos" | "darwin" => "macos",
        other => other,
    }
}

fn current_platform() -> &'static str {
    if cfg!(windows) {
        "win32"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else if cfg!(target_os = "freebsd") {
        "freebsd"
    } else if cfg!(target_os = "openbsd") {
        "openbsd"
    } else if cfg!(target_os = "netbsd") {
        "netbsd"
    } else {
        std::env::consts::OS
    }
}

fn is_likely_windows_executable_path(value: &str) -> bool {
    let trimmed = value.trim().trim_matches('"');
    let bytes = trimmed.as_bytes();
    let drive_path = bytes.len() > 2 && bytes[1] == b':' && matches!(bytes[2], b'/' | b'\\');
    let network_path = trimmed.starts_with("\\\\");
    let lower = trimmed.to_ascii_lowercase();
    (drive_path || network_path)
        && [".bat", ".cmd", ".com", ".exe", ".ps1"]
            .iter()
            .any(|extension| lower.ends_with(extension))
}

pub fn normalize_cmd_for_platform(cmd: &[String], platform: &str) -> Option<Vec<String>> {
    if platform == "win32" || platform == "windows" {
        if cmd.len() == 1
            && cmd[0].chars().any(char::is_whitespace)
            && !is_likely_windows_executable_path(&cmd[0])
        {
            return Some(vec!["cmd".into(), "/c".into(), cmd[0].clone()]);
        }
        return None;
    }

    if cmd.len() >= 2 && cmd[0].eq_ignore_ascii_case("cmd") && cmd[1].eq_ignore_ascii_case("/c") {
        return Some(vec!["sh".into(), "-c".into(), cmd[2..].join(" ")]);
    }
    None
}

fn resolve_value(value: Value, platform: &str) -> Value {
    match value {
        Value::Mapping(mapping) => {
            let select_key = Value::String("$select".into());
            if mapping.get(&select_key).and_then(Value::as_str) == Some("os") {
                let os_key = Value::String(platform_name(platform).into());
                let else_key = Value::String("$else".into());
                return mapping
                    .get(&os_key)
                    .or_else(|| mapping.get(&else_key))
                    .cloned()
                    .map(|selected| resolve_value(selected, platform))
                    .unwrap_or(Value::Null);
            }

            let mut resolved = Mapping::new();
            for (key, child) in mapping {
                resolved.insert(key, resolve_value(child, platform));
            }
            Value::Mapping(resolved)
        }
        Value::Sequence(values) => Value::Sequence(
            values
                .into_iter()
                .map(|child| resolve_value(child, platform))
                .collect(),
        ),
        other => other,
    }
}

#[derive(serde::Deserialize)]
struct ConfigFile {
    procs: IndexMap<String, Option<ProcConfig>>,
}

pub fn load_config(path: &Path, no_cmd_rewrite: bool) -> Result<LoadedConfig, String> {
    let resolved = path
        .canonicalize()
        .map_err(|_| format!("Config file not found: {}", path.display()))?;
    let raw =
        fs::read_to_string(&resolved).map_err(|error| format!("Failed to load config: {error}"))?;
    let value = serde_yaml::from_str::<Value>(&raw)
        .map_err(|error| format!("Failed to load config: {error}"))?;
    let resolved_value = resolve_value(value, current_platform());
    let parsed = serde_yaml::from_value::<ConfigFile>(resolved_value)
        .map_err(|error| format!("Invalid config: {error}"))?;
    let mut procs: IndexMap<String, ProcConfig> = parsed
        .procs
        .into_iter()
        .filter_map(|(name, process)| process.map(|process| (name, process)))
        .collect();
    let config_dir = resolved
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .to_path_buf();
    let mut normalized_proc_names = Vec::new();

    for (name, process) in &mut procs {
        if let Some(cwd) = &process.cwd {
            process.cwd = Some(cwd.replace("<CONFIG_DIR>", &config_dir.to_string_lossy()));
        }
        if !no_cmd_rewrite {
            if let Some(cmd) = &process.cmd {
                if let Some(normalized) = normalize_cmd_for_platform(cmd, current_platform()) {
                    process.cmd = Some(normalized);
                    normalized_proc_names.push(name.clone());
                }
            }
        }
    }

    Ok(LoadedConfig {
        procs,
        config_dir,
        normalized_proc_names,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        time::{SystemTime, UNIX_EPOCH},
    };

    fn strings(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).into()).collect()
    }

    #[test]
    fn rewrites_windows_shell_arrays_on_unix() {
        assert_eq!(
            normalize_cmd_for_platform(&strings(&["cmd", "/c", "pnpm run dev"]), "linux"),
            Some(strings(&["sh", "-c", "pnpm run dev"]))
        );
    }

    #[test]
    fn rewrites_shell_like_single_entries_on_windows() {
        assert_eq!(
            normalize_cmd_for_platform(&strings(&["pnpm run dev"]), "win32"),
            Some(strings(&["cmd", "/c", "pnpm run dev"]))
        );
    }

    #[test]
    fn preserves_windows_executable_paths_with_spaces() {
        assert_eq!(
            normalize_cmd_for_platform(&strings(&[r#"C:\Program Files\nodejs\node.exe"#]), "win32"),
            None
        );
    }

    #[test]
    fn resolves_os_select_values() {
        let value: Value =
            serde_yaml::from_str("$select: os\nlinux: one\nwindows: two\n$else: other\n").unwrap();
        assert_eq!(resolve_value(value, "linux"), Value::String("one".into()));
    }

    #[test]
    fn loads_mprocs_config_and_applies_defaults() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = std::env::temp_dir().join(format!("oprocs-config-{unique}"));
        fs::create_dir_all(&directory).unwrap();
        let path = directory.join("mprocs.yaml");
        fs::write(
            &path,
            "procs:\n  api:\n    shell:\n      $select: os\n      macos: pnpm dev:mac\n      linux: pnpm dev:linux\n      $else: pnpm dev\n    cwd: <CONFIG_DIR>/backend\n    env:\n      DEBUG: '1'\n      INHERITED: null\n    add_path: bin\n  worker:\n    cmd: [node, --port, 3000]\n    env:\n      PORT: 3000\n      ENABLED: true\n    autostart: false\n  windows-only:\n    $select: os\n    windows:\n      shell: windows-command\n",
        )
        .unwrap();

        let loaded = load_config(&path, false).unwrap();
        let api = &loaded.procs["api"];
        assert!(api.autostart);
        assert_eq!(
            api.cwd.as_deref(),
            Some(loaded.config_dir.join("backend").to_string_lossy().as_ref())
        );
        assert_eq!(api.add_path, vec!["bin"]);
        assert_eq!(api.env.as_ref().unwrap()["INHERITED"], None);
        let worker = &loaded.procs["worker"];
        assert!(!worker.autostart);
        assert_eq!(worker.cmd.as_ref().unwrap()[2], "3000");
        assert_eq!(
            worker.env.as_ref().unwrap()["PORT"].as_deref(),
            Some("3000")
        );
        assert_eq!(
            worker.env.as_ref().unwrap()["ENABLED"].as_deref(),
            Some("true")
        );
        assert_eq!(
            loaded.procs.contains_key("windows-only"),
            current_platform() == "win32"
        );

        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn rejects_non_scalar_command_values() {
        let result = serde_yaml::from_str::<ProcConfig>("cmd: [node, { nested: value }]");
        assert!(result.is_err());
    }
}
