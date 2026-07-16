mod app_config;
mod config;
mod process_manager;
mod system;
mod types;
mod watchdog;

use crate::{
    app_config::{init_config, load_app_config},
    config::load_config as parse_config,
    process_manager::ProcessManager,
    types::{
        AppConfig, CommandResult, KillPortResult, LoadConfigResult, LoadConfigSuccess,
        PortOccupant, ProcSummary, ProcessOutput,
    },
    watchdog::Watchdog,
};
use std::{
    path::{Path, PathBuf},
    time::Duration,
};
use tauri::{Emitter, Manager};

struct AppState {
    manager: ProcessManager,
    app_config: AppConfig,
    start_dir: Option<PathBuf>,
    no_cmd_rewrite: bool,
    lifecycle_lock: tokio::sync::Mutex<()>,
}

#[tauri::command]
fn get_app_config(state: tauri::State<'_, AppState>) -> AppConfig {
    state.app_config.clone()
}

#[tauri::command]
fn get_default_config_path(state: tauri::State<'_, AppState>) -> Option<String> {
    let directory = state
        .start_dir
        .clone()
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_default());
    ["oprocs.yaml", "oprocs.yml", "mprocs.yaml", "mprocs.yml"]
        .iter()
        .map(|name| directory.join(name))
        .find(|path| path.exists())
        .map(|path| path.to_string_lossy().into_owned())
}

#[tauri::command]
async fn load_config(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    config_path: String,
) -> Result<LoadConfigResult, String> {
    let _lifecycle_guard = state.lifecycle_lock.lock().await;
    let path = PathBuf::from(&config_path);
    let loaded = match parse_config(&path, state.no_cmd_rewrite) {
        Ok(loaded) => loaded,
        Err(error) => return Ok(LoadConfigResult::Error { error }),
    };
    state.manager.begin_reload();
    state.manager.unregister_all().await;
    state.manager.set_config_dir(loaded.config_dir.clone());
    let lock = state.manager.read_lock();
    if let Some(lock) = &lock {
        state.manager.kill_pids_from_lock(lock).await;
        tokio::time::sleep(Duration::from_millis(300)).await;
        let red = "\u{1b}[31m";
        let reset = "\u{1b}[0m";
        for (proc_id, locked_pids) in lock {
            let pids = locked_pids
                .iter()
                .map(|locked| locked.pid)
                .collect::<Vec<_>>();
            if pids.is_empty() {
                continue;
            }
            let pid_label = if pids.len() == 1 {
                format!("pid {}", pids[0])
            } else {
                format!(
                    "pids {}",
                    pids.iter()
                        .map(u32::to_string)
                        .collect::<Vec<_>>()
                        .join(", ")
                )
            };
            let _ = app.emit(
                "process-output",
                ProcessOutput {
                    proc_id: proc_id.clone(),
                    text: format!("{red}[Killed previous processes from the oprocs lock file ({pid_label}) before starting - this happens if oprocs crashes or is force killed.]{reset}\n"),
                    is_stderr: false,
                },
            );
        }
    }
    state.manager.clear_lock();
    state
        .manager
        .register_all(&loaded.procs, &loaded.config_dir);
    state.manager.finish_reload();

    let autostart_ids = loaded
        .procs
        .iter()
        .filter(|(_, process)| process.autostart)
        .map(|(id, _)| id.clone())
        .collect::<Vec<_>>();
    state.manager.start_initial(&autostart_ids).await;

    let procs = loaded
        .procs
        .keys()
        .map(|id| ProcSummary {
            id: id.clone(),
            name: id.clone(),
        })
        .collect();
    Ok(LoadConfigResult::Success(LoadConfigSuccess {
        config_path: path
            .canonicalize()
            .unwrap_or(path)
            .to_string_lossy()
            .into_owned(),
        config_dir: loaded.config_dir.to_string_lossy().into_owned(),
        procs,
        running_ids: state.manager.running_ids(),
        normalized_proc_names: loaded.normalized_proc_names,
    }))
}

#[tauri::command]
async fn start_proc(
    state: tauri::State<'_, AppState>,
    proc_id: String,
) -> Result<CommandResult, String> {
    let _lifecycle_guard = state.lifecycle_lock.lock().await;
    Ok(state.manager.start(&proc_id).await)
}

#[tauri::command]
async fn stop_proc(
    state: tauri::State<'_, AppState>,
    proc_id: String,
) -> Result<CommandResult, String> {
    let _lifecycle_guard = state.lifecycle_lock.lock().await;
    Ok(state.manager.stop(&proc_id).await)
}

#[tauri::command]
async fn restart_proc(
    state: tauri::State<'_, AppState>,
    proc_id: String,
) -> Result<CommandResult, String> {
    let _lifecycle_guard = state.lifecycle_lock.lock().await;
    Ok(state.manager.restart(&proc_id).await)
}

#[tauri::command]
async fn get_port_occupant(port: u16) -> Option<PortOccupant> {
    system::get_port_occupant(port).await
}

#[tauri::command]
async fn kill_port_occupant(port: u16) -> KillPortResult {
    match system::kill_port_occupant(port).await {
        Ok(occupant) => KillPortResult {
            ok: true,
            occupant: Some(occupant),
            error: None,
        },
        Err(error) => KillPortResult {
            ok: false,
            occupant: None,
            error: Some(error),
        },
    }
}

fn parse_start_directory() -> Option<PathBuf> {
    std::env::args_os().skip(1).find_map(|argument| {
        let path = Path::new(&argument);
        let text = path.to_string_lossy();
        if text.starts_with('-')
            || text == "init-config"
            || text.ends_with(".js")
            || text.ends_with(".cjs")
            || text.ends_with(".mjs")
        {
            return None;
        }
        let expanded = if text == "~" || text.starts_with("~/") || text.starts_with("~\\") {
            dirs::home_dir().map(|home| {
                home.join(text.trim_start_matches('~').trim_start_matches(['/', '\\']))
            })?
        } else {
            path.to_path_buf()
        };
        Some(if expanded.is_absolute() {
            expanded
        } else {
            std::env::current_dir().ok()?.join(expanded)
        })
    })
}

fn install_signal_handlers(app: tauri::AppHandle, manager: ProcessManager) {
    #[cfg(unix)]
    tauri::async_runtime::spawn(async move {
        let mut interrupt =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt())
                .expect("failed to install SIGINT handler");
        let mut terminate =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                .expect("failed to install SIGTERM handler");
        tokio::select! {
            _ = interrupt.recv() => {},
            _ = terminate.recv() => {},
        }
        manager.shutdown_sync();
        app.exit(0);
    });

    #[cfg(windows)]
    tauri::async_runtime::spawn(async move {
        if tokio::signal::ctrl_c().await.is_ok() {
            manager.shutdown_sync();
            app.exit(0);
        }
    });
}

pub fn run() {
    let arguments: Vec<String> = std::env::args().collect();
    if arguments.iter().any(|argument| argument == "--watchdog") {
        watchdog::run_watchdog();
        return;
    }
    if arguments.iter().any(|argument| argument == "init-config") {
        match init_config() {
            Ok(path) => println!("Config written to: {}", path.display()),
            Err(error) => {
                eprintln!("Failed to write config: {error}");
                std::process::exit(1);
            }
        }
        return;
    }

    let app_config = load_app_config();
    let start_dir = parse_start_directory();
    let no_cmd_rewrite = arguments
        .iter()
        .any(|argument| argument == "--no-cmd-rewrite");
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(move |app| {
            let watchdog = Watchdog::start().map_err(std::io::Error::other)?;
            let manager =
                ProcessManager::new(app.handle().clone(), app_config.clone(), Some(watchdog));
            install_signal_handlers(app.handle().clone(), manager.clone());
            app.manage(AppState {
                manager,
                app_config: app_config.clone(),
                start_dir,
                no_cmd_rewrite,
                lifecycle_lock: tokio::sync::Mutex::new(()),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_app_config,
            get_default_config_path,
            load_config,
            start_proc,
            stop_proc,
            restart_proc,
            get_port_occupant,
            kill_port_occupant,
        ])
        .build(tauri::generate_context!())
        .expect("error while building the oprocs application");

    app.run(|app, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            app.state::<AppState>().manager.shutdown_sync();
        }
    });
}
