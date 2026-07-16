#[cfg(unix)]
use crate::system::get_process_group_members;
#[cfg(windows)]
use crate::system::get_windows_descendants;
use crate::{
    app_config::resolve_data_dir,
    system::{
        is_process_tree_alive, is_valid_pid, kill_process_tree, process_identity,
        process_started_before,
    },
    types::{AppConfig, CommandResult, ProcConfig, ProcessOutput, ProcessStopped},
    watchdog::Watchdog,
};
use indexmap::IndexMap;
use std::{
    future::Future,
    path::{Path, PathBuf},
    pin::Pin,
    process::Stdio,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWriteExt},
    process::Command,
    sync::Mutex as AsyncMutex,
};

const LOCK_FILE_NAME: &str = ".oprocs.lock";

#[derive(Clone, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
pub struct LockedPid {
    pub pid: u32,
    identity: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    process_group: Option<u32>,
}

struct RunningProcess {
    pid: u32,
    #[cfg(windows)]
    root_pid: u32,
    generation: u64,
    pids_for_lock: Vec<LockedPid>,
    effective_pid: Option<u32>,
}

struct ProcEntry {
    config: ProcConfig,
    config_dir: PathBuf,
    running: Option<RunningProcess>,
    starting_generation: Option<u64>,
    finishing_generation: Option<u64>,
    registration: u64,
    started_at: Instant,
    user_requested_stop: bool,
}

struct ProcessManagerInner {
    entries: Mutex<IndexMap<String, ProcEntry>>,
    config_dir: Mutex<PathBuf>,
    app_config: AppConfig,
    app: AppHandle,
    watchdog: Option<Watchdog>,
    next_generation: AtomicU64,
    reloading: AtomicBool,
    persist_lock_guard: Mutex<()>,
}

#[derive(Clone)]
pub struct ProcessManager {
    inner: Arc<ProcessManagerInner>,
}

impl ProcessManager {
    pub fn new(app: AppHandle, app_config: AppConfig, watchdog: Option<Watchdog>) -> Self {
        Self {
            inner: Arc::new(ProcessManagerInner {
                entries: Mutex::new(IndexMap::new()),
                config_dir: Mutex::new(PathBuf::new()),
                app_config,
                app,
                watchdog,
                next_generation: AtomicU64::new(1),
                reloading: AtomicBool::new(false),
                persist_lock_guard: Mutex::new(()),
            }),
        }
    }

    pub fn set_config_dir(&self, directory: PathBuf) {
        if let Ok(mut config_dir) = self.inner.config_dir.lock() {
            *config_dir = directory;
        }
    }

    pub fn begin_reload(&self) {
        self.inner.reloading.store(true, Ordering::SeqCst);
    }

    pub fn finish_reload(&self) {
        self.inner.reloading.store(false, Ordering::SeqCst);
    }

    pub fn register_all(&self, configs: &IndexMap<String, ProcConfig>, config_dir: &Path) {
        let mut entries = self.inner.entries.lock().unwrap();
        for (id, config) in configs {
            let registration = self.inner.next_generation.fetch_add(1, Ordering::Relaxed);
            entries.insert(
                id.clone(),
                ProcEntry {
                    config: config.clone(),
                    config_dir: config_dir.to_path_buf(),
                    running: None,
                    starting_generation: None,
                    finishing_generation: None,
                    registration,
                    started_at: Instant::now(),
                    user_requested_stop: false,
                },
            );
        }
    }

    pub fn running_ids(&self) -> Vec<String> {
        let entries = self.inner.entries.lock().unwrap();
        entries
            .iter()
            .filter_map(|(id, entry)| {
                let running = entry.running.as_ref()?;
                if process_tree_is_alive(running.pid, &running.pids_for_lock) {
                    Some(id.clone())
                } else {
                    None
                }
            })
            .collect()
    }

    fn resolve_log_path(&self, id: &str, config_dir: &Path) -> Option<PathBuf> {
        if self.inner.app_config.no_logs {
            return None;
        }
        let directory = resolve_data_dir(&self.inner.app_config.logs_dir, config_dir);
        let sanitized = id
            .chars()
            .map(|character| {
                if "/\\:*?\"<>|".contains(character) || character.is_whitespace() {
                    '-'
                } else {
                    character
                }
            })
            .collect::<String>();
        Some(directory.join(format!(
            "{}.log",
            if sanitized.is_empty() {
                "proc"
            } else {
                &sanitized
            }
        )))
    }

    fn lock_path(&self) -> PathBuf {
        let config_dir = self.inner.config_dir.lock().unwrap().clone();
        resolve_data_dir(&self.inner.app_config.lock_dir, &config_dir).join(LOCK_FILE_NAME)
    }

    pub fn read_lock(&self) -> Option<IndexMap<String, Vec<LockedPid>>> {
        let path = self.lock_path();
        let modified = std::fs::metadata(&path).ok()?.modified().ok()?;
        let raw = std::fs::read_to_string(path).ok()?;
        let value = serde_json::from_str::<serde_json::Value>(&raw).ok()?;
        let object = value.as_object()?;
        let mut result = IndexMap::new();
        for (id, pids) in object {
            let normalized = match pids {
                serde_json::Value::Array(values) => values
                    .iter()
                    .filter_map(|value| locked_pid_from_value(value, modified))
                    .collect(),
                value => locked_pid_from_value(value, modified).into_iter().collect(),
            };
            result.insert(id.clone(), normalized);
        }
        Some(result)
    }

    pub fn clear_lock(&self) {
        let _persist_guard = self.inner.persist_lock_guard.lock().unwrap();
        let _ = std::fs::remove_file(self.lock_path());
    }

    pub async fn kill_pids_from_lock(&self, lock: &IndexMap<String, Vec<LockedPid>>) {
        let pids: Vec<_> = lock
            .values()
            .flatten()
            .map(|locked| (locked.pid, locked.identity.clone(), locked.process_group))
            .collect();
        let _ = tokio::task::spawn_blocking(move || {
            let mut killed_groups = std::collections::HashSet::new();
            for (pid, identity, process_group) in pids {
                if process_identity(pid).as_deref() == Some(identity.as_str()) {
                    if let Some(group_id) = process_group.filter(|group| is_valid_pid(*group)) {
                        if killed_groups.insert(group_id) {
                            kill_process_tree(group_id, "SIGKILL");
                        }
                    } else {
                        kill_process_tree(pid, "SIGKILL");
                    }
                }
            }
        })
        .await;
    }

    fn persist_lock(&self) {
        let _persist_guard = self.inner.persist_lock_guard.lock().unwrap();
        let running: IndexMap<String, Vec<LockedPid>> = self
            .inner
            .entries
            .lock()
            .unwrap()
            .iter()
            .filter_map(|(id, entry)| {
                entry
                    .running
                    .as_ref()
                    .map(|running| (id.clone(), running.pids_for_lock.clone()))
            })
            .collect();
        let path = self.lock_path();
        if running.is_empty() {
            let _ = std::fs::remove_file(path);
            return;
        }
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(json) = serde_json::to_vec(&running) {
            let write = || -> std::io::Result<()> {
                use std::io::Write;

                let parent = path.parent().unwrap_or_else(|| Path::new("."));
                let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
                temporary.write_all(&json)?;
                temporary.as_file_mut().sync_all()?;
                temporary.persist(&path).map_err(|error| error.error)?;
                Ok(())
            };
            let _ = write();
        }
    }

    pub fn start<'a>(
        &'a self,
        id: &'a str,
    ) -> Pin<Box<dyn Future<Output = CommandResult> + Send + 'a>> {
        self.start_with_options(id, None, true)
    }

    fn start_with_options<'a>(
        &'a self,
        id: &'a str,
        expected_registration: Option<u64>,
        persist_immediately: bool,
    ) -> Pin<Box<dyn Future<Output = CommandResult> + Send + 'a>> {
        Box::pin(async move {
            if self.inner.reloading.load(Ordering::SeqCst) {
                return CommandResult::error("Configuration reload is in progress");
            }
            let (config, config_dir, generation) = {
                let mut entries = self.inner.entries.lock().unwrap();
                let Some(entry) = entries.get_mut(id) else {
                    return CommandResult::error("Unknown process");
                };
                if expected_registration.is_some_and(|expected| entry.registration != expected) {
                    return CommandResult::error("Process registration has changed");
                }
                if entry.starting_generation.is_some() {
                    return CommandResult::error("Process is already starting");
                }
                if entry.finishing_generation.is_some() {
                    return CommandResult::error("Process is stopping");
                }
                if entry.running.is_some() {
                    return CommandResult::error("Already running");
                }
                let generation = self.inner.next_generation.fetch_add(1, Ordering::Relaxed);
                entry.starting_generation = Some(generation);
                entry.user_requested_stop = false;
                (entry.config.clone(), entry.config_dir.clone(), generation)
            };

            let cwd = config
                .cwd
                .as_deref()
                .map(PathBuf::from)
                .map(|path| {
                    if path.is_absolute() {
                        path
                    } else {
                        config_dir.join(path)
                    }
                })
                .unwrap_or_else(|| config_dir.clone());
            let mut command = match build_command(&config) {
                Ok(command) => command,
                Err(error) => {
                    self.clear_start_reservation(id, generation);
                    return CommandResult::error(error);
                }
            };
            command
                .current_dir(cwd)
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            apply_environment(&mut command, &config);
            configure_process_group(&mut command);

            let mut child = match command.spawn() {
                Ok(child) => child,
                Err(error) => {
                    self.clear_start_reservation(id, generation);
                    return CommandResult::error(error.to_string());
                }
            };
            let Some(pid) = child.id() else {
                self.clear_start_reservation(id, generation);
                return CommandResult::error("The process did not expose a process ID");
            };
            let stdout = child.stdout.take();
            let stderr = child.stderr.take();
            let locked_pid = capture_locked_pid(pid, if cfg!(unix) { Some(pid) } else { None });
            {
                let mut entries = self.inner.entries.lock().unwrap();
                let Some(entry) = entries.get_mut(id) else {
                    kill_process_tree(pid, "SIGKILL");
                    return CommandResult::error("Unknown process");
                };
                if entry.starting_generation != Some(generation)
                    || self.inner.reloading.load(Ordering::SeqCst)
                {
                    if entry.starting_generation == Some(generation) {
                        entry.starting_generation = None;
                    }
                    kill_process_tree(pid, "SIGKILL");
                    return CommandResult::error("Start was cancelled");
                }
                entry.starting_generation = None;
                entry.started_at = Instant::now();
                entry.running = Some(RunningProcess {
                    pid,
                    #[cfg(windows)]
                    root_pid: pid,
                    generation,
                    pids_for_lock: locked_pid.clone().into_iter().collect(),
                    effective_pid: None,
                });
            }
            if let (Some(watchdog), Some(locked)) = (&self.inner.watchdog, &locked_pid) {
                watchdog.track(locked.pid, &locked.identity);
            }

            let log = match self.resolve_log_path(id, &config_dir) {
                Some(path) => {
                    if let Some(parent) = path.parent() {
                        let _ = tokio::fs::create_dir_all(parent).await;
                    }
                    tokio::fs::OpenOptions::new()
                        .create(true)
                        .append(true)
                        .open(path)
                        .await
                        .ok()
                        .map(|file| Arc::new(AsyncMutex::new(file)))
                }
                None => None,
            };

            let _ = self.inner.app.emit("proc-started", id);
            if persist_immediately {
                self.persist_lock();
            }

            let mut output_readers = Vec::new();
            if let Some(stdout) = stdout {
                output_readers.push(spawn_output_reader(
                    self.inner.app.clone(),
                    id.to_owned(),
                    stdout,
                    false,
                    log.clone(),
                ));
            }
            if let Some(stderr) = stderr {
                output_readers.push(spawn_output_reader(
                    self.inner.app.clone(),
                    id.to_owned(),
                    stderr,
                    true,
                    log,
                ));
            }

            #[cfg(windows)]
            let track_windows_descendants = should_track_windows_descendants(&config);
            #[cfg(windows)]
            if track_windows_descendants {
                self.resolve_windows_descendants(id.to_owned(), generation, pid);
            }

            let manager = self.clone();
            let proc_id = id.to_owned();
            tauri::async_runtime::spawn(async move {
                let mut exit_code = match child.wait().await {
                    Ok(status) => status.code(),
                    Err(error) => {
                        let _ = manager.inner.app.emit(
                            "process-output",
                            ProcessOutput {
                                proc_id: proc_id.clone(),
                                text: format!("{error}\n"),
                                is_stderr: true,
                            },
                        );
                        None
                    }
                };
                #[cfg(unix)]
                while is_process_tree_alive(pid) {
                    manager.refresh_unix_group_members(&proc_id, generation, pid);
                    tokio::time::sleep(Duration::from_millis(500)).await;
                }
                let mut closed_pid = pid;
                if let Some(adopted) = manager.adopt_effective_process(&proc_id, generation, pid) {
                    closed_pid = adopted.pid;
                    exit_code = None;
                }
                #[cfg(windows)]
                if track_windows_descendants {
                    let mut had_descendants = false;
                    loop {
                        manager
                            .refresh_windows_descendants(&proc_id, generation, pid)
                            .await;
                        if !manager.has_current_tracked_process(&proc_id, generation) {
                            break;
                        }
                        had_descendants = true;
                        tokio::time::sleep(Duration::from_millis(500)).await;
                    }
                    if had_descendants {
                        exit_code = None;
                    }
                }
                for reader in output_readers {
                    let _ = reader.await;
                }
                manager.handle_exit(&proc_id, generation, closed_pid, exit_code);
            });

            CommandResult::ok()
        })
    }

    pub async fn start_initial(&self, ids: &[String]) {
        let mut starts = tokio::task::JoinSet::new();
        for id in ids {
            let manager = self.clone();
            let id = id.clone();
            starts.spawn(async move {
                let _ = manager.start_with_options(&id, None, false).await;
            });
        }
        while starts.join_next().await.is_some() {
            // Wait for every process to be tracked before committing the batch lock.
        }
        self.persist_lock();
    }

    fn clear_start_reservation(&self, id: &str, generation: u64) {
        if let Some(entry) = self.inner.entries.lock().unwrap().get_mut(id) {
            if entry.starting_generation == Some(generation) {
                entry.starting_generation = None;
            }
        }
    }

    #[cfg(unix)]
    fn refresh_unix_group_members(&self, id: &str, generation: u64, group_id: u32) {
        let tracked = get_process_group_members(group_id)
            .into_iter()
            .filter_map(|pid| capture_locked_pid(pid, Some(group_id)))
            .collect::<Vec<_>>();
        let changed = {
            let mut entries = self.inner.entries.lock().unwrap();
            let Some(entry) = entries.get_mut(id) else {
                return;
            };
            let Some(running) = entry.running.as_mut() else {
                return;
            };
            if running.generation != generation || running.pid != group_id {
                return;
            }
            if running.pids_for_lock == tracked {
                false
            } else {
                running.pids_for_lock = tracked;
                true
            }
        };
        if changed {
            self.persist_lock();
        }
    }

    #[cfg(windows)]
    fn has_current_tracked_process(&self, id: &str, generation: u64) -> bool {
        let tracked = self
            .inner
            .entries
            .lock()
            .unwrap()
            .get(id)
            .and_then(|entry| entry.running.as_ref())
            .filter(|running| running.generation == generation)
            .map(|running| running.pids_for_lock.clone())
            .unwrap_or_default();
        tracked.iter().any(locked_pid_is_current)
    }

    fn adopt_effective_process(
        &self,
        id: &str,
        generation: u64,
        closed_pid: u32,
    ) -> Option<LockedPid> {
        let adopted = {
            let mut entries = self.inner.entries.lock().unwrap();
            let entry = entries.get_mut(id)?;
            if entry.running.as_ref().map(|running| running.generation) != Some(generation) {
                return None;
            }
            let running = entry.running.as_ref().unwrap();
            if running.pid != closed_pid {
                return None;
            }
            let effective_pid = running.effective_pid.filter(|pid| *pid != closed_pid)?;
            let adopted = running
                .pids_for_lock
                .iter()
                .find(|locked| locked.pid == effective_pid && locked_pid_is_current(locked))?
                .clone();
            let running = entry.running.as_mut().unwrap();
            running.pid = effective_pid;
            adopted
        };
        if let Some(watchdog) = &self.inner.watchdog {
            watchdog.untrack(closed_pid);
        }
        self.persist_lock();
        Some(adopted)
    }

    fn handle_exit(&self, id: &str, generation: u64, closed_pid: u32, code: Option<i32>) {
        let (should_restart, registration, tracked_pids) = {
            let mut entries = self.inner.entries.lock().unwrap();
            let Some(entry) = entries.get_mut(id) else {
                return;
            };
            if entry.running.as_ref().map(|running| running.generation) != Some(generation) {
                return;
            }
            let running = entry.running.as_ref().unwrap();
            if running.pid != closed_pid {
                return;
            }
            let tracked_pids = running.pids_for_lock.clone();
            let should_restart = !entry.user_requested_stop
                && entry.config.autorestart
                && entry.started_at.elapsed() > Duration::from_secs(1);
            entry.running = None;
            entry.finishing_generation = Some(generation);
            entry.user_requested_stop = false;
            (should_restart, entry.registration, tracked_pids)
        };
        if let Some(watchdog) = &self.inner.watchdog {
            for locked in tracked_pids {
                watchdog.untrack(locked.pid);
            }
        }
        self.persist_lock();
        let _ = self.inner.app.emit(
            "proc-stopped",
            ProcessStopped {
                proc_id: id.to_owned(),
                code,
            },
        );
        if let Some(entry) = self.inner.entries.lock().unwrap().get_mut(id) {
            if entry.finishing_generation == Some(generation) {
                entry.finishing_generation = None;
            }
        }
        if should_restart {
            let manager = self.clone();
            let id = id.to_owned();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_millis(500)).await;
                let _ = manager
                    .start_with_options(&id, Some(registration), true)
                    .await;
            });
        }
    }

    #[cfg(windows)]
    fn resolve_windows_descendants(&self, id: String, generation: u64, root_pid: u32) {
        let manager = self.clone();
        tauri::async_runtime::spawn(async move {
            for delay in [0_u64, 100, 400, 900] {
                tokio::time::sleep(Duration::from_millis(delay)).await;
                manager
                    .refresh_windows_descendants(&id, generation, root_pid)
                    .await;
            }
        });
    }

    #[cfg(windows)]
    async fn refresh_windows_descendants(&self, id: &str, generation: u64, root_pid: u32) {
        let (roots, stale_pids) = {
            let entries = self.inner.entries.lock().unwrap();
            let Some(running) = entries.get(id).and_then(|entry| entry.running.as_ref()) else {
                return;
            };
            if running.generation != generation || running.root_pid != root_pid {
                return;
            }
            let mut stale_pids = Vec::new();
            let roots = running
                .pids_for_lock
                .iter()
                .filter_map(|locked| match process_identity(locked.pid) {
                    Some(identity) if identity == locked.identity => Some(locked.pid),
                    Some(_) => {
                        stale_pids.push(locked.pid);
                        None
                    }
                    None => {
                        stale_pids.push(locked.pid);
                        Some(locked.pid)
                    }
                })
                .collect::<Vec<_>>();
            (roots, stale_pids)
        };
        if let Some(watchdog) = &self.inner.watchdog {
            for pid in stale_pids {
                watchdog.untrack(pid);
            }
        }
        if roots.is_empty() {
            return;
        }
        let descendants = get_windows_descendants(&roots).await;
        if descendants.is_empty() {
            return;
        }
        let pids = descendants
            .iter()
            .map(|(pid, _, _)| *pid)
            .filter(|pid| is_valid_pid(*pid))
            .collect::<Vec<_>>();
        let effective_pid = descendants
            .iter()
            .filter(|(pid, name, _)| is_valid_pid(*pid) && !is_windows_shell_name(name))
            .min_by_key(|(_, _, depth)| *depth)
            .map(|(pid, _, _)| *pid);
        let captured = pids
            .iter()
            .filter_map(|pid| capture_locked_pid(*pid, None))
            .collect::<Vec<_>>();
        let changed = {
            let mut entries = self.inner.entries.lock().unwrap();
            let Some(entry) = entries.get_mut(id) else {
                return;
            };
            let Some(running) = entry.running.as_mut() else {
                return;
            };
            if running.generation != generation || running.root_pid != root_pid {
                return;
            }
            let previous = running.pids_for_lock.clone();
            for locked in &captured {
                if let Some(existing) = running
                    .pids_for_lock
                    .iter_mut()
                    .find(|existing| existing.pid == locked.pid)
                {
                    *existing = locked.clone();
                } else {
                    running.pids_for_lock.push(locked.clone());
                }
            }
            running.effective_pid = effective_pid;
            previous != running.pids_for_lock
        };
        if let Some(watchdog) = &self.inner.watchdog {
            for locked in &captured {
                watchdog.track(locked.pid, &locked.identity);
            }
        }
        if changed {
            self.persist_lock();
        }
    }

    pub async fn stop(&self, id: &str) -> CommandResult {
        let (pid, tracked_pids, signal) = {
            let mut entries = self.inner.entries.lock().unwrap();
            let Some(entry) = entries.get_mut(id) else {
                return CommandResult::error("Unknown process");
            };
            let Some(running) = &entry.running else {
                entry.starting_generation = None;
                return CommandResult::ok();
            };
            entry.user_requested_stop = true;
            (
                running.pid,
                running.pids_for_lock.clone(),
                entry
                    .config
                    .stop
                    .clone()
                    .unwrap_or_else(|| "SIGTERM".into()),
            )
        };
        self.append_system_line(id, "[oprocs] stopped").await;
        let _ = tokio::task::spawn_blocking(move || {
            kill_tracked_process_tree(pid, &tracked_pids, &signal)
        })
        .await;
        self.persist_lock();
        CommandResult::ok()
    }

    pub async fn restart(&self, id: &str) -> CommandResult {
        let stopped = self.stop(id).await;
        if !stopped.ok {
            return stopped;
        }
        for _ in 0..20 {
            if self.can_start(id) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        if !self.can_start(id) {
            if let Some((pid, tracked_pids)) = self.process_tree(id) {
                let _ = tokio::task::spawn_blocking(move || {
                    kill_tracked_process_tree(pid, &tracked_pids, "SIGKILL")
                })
                .await;
            }
        }
        for _ in 0..40 {
            if self.can_start(id) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        if !self.can_start(id) {
            return CommandResult::error("Process did not finish stopping");
        }
        self.append_system_line(id, "[oprocs] restarted").await;
        self.start(id).await
    }

    fn can_start(&self, id: &str) -> bool {
        self.inner
            .entries
            .lock()
            .unwrap()
            .get(id)
            .is_some_and(|entry| {
                entry.running.is_none()
                    && entry.starting_generation.is_none()
                    && entry.finishing_generation.is_none()
            })
    }

    fn process_tree(&self, id: &str) -> Option<(u32, Vec<LockedPid>)> {
        self.inner
            .entries
            .lock()
            .unwrap()
            .get(id)
            .and_then(|entry| {
                entry
                    .running
                    .as_ref()
                    .map(|running| (running.pid, running.pids_for_lock.clone()))
            })
    }

    async fn append_system_line(&self, id: &str, text: &str) {
        let line = format!("{}\n", text.trim_end());
        let config_dir = self
            .inner
            .entries
            .lock()
            .unwrap()
            .get(id)
            .map(|entry| entry.config_dir.clone());
        if let Some(path) = config_dir.and_then(|directory| self.resolve_log_path(id, &directory)) {
            if let Some(parent) = path.parent() {
                let _ = tokio::fs::create_dir_all(parent).await;
            }
            if let Ok(mut file) = tokio::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(path)
                .await
            {
                let _ = file.write_all(line.as_bytes()).await;
            }
        }
        let _ = self.inner.app.emit(
            "process-output",
            ProcessOutput {
                proc_id: id.to_owned(),
                text: line,
                is_stderr: false,
            },
        );
    }

    pub async fn unregister_all(&self) {
        let ids: Vec<_> = {
            let mut entries = self.inner.entries.lock().unwrap();
            if entries.values().all(|entry| {
                entry.running.is_none()
                    && entry.starting_generation.is_none()
                    && entry.finishing_generation.is_none()
            }) {
                entries.clear();
                drop(entries);
                self.persist_lock();
                return;
            }
            entries
                .iter_mut()
                .map(|(id, entry)| {
                    entry.registration = self.inner.next_generation.fetch_add(1, Ordering::Relaxed);
                    id.clone()
                })
                .collect()
        };
        for id in ids {
            let _ = self.stop(&id).await;
        }
        for _ in 0..20 {
            let processes: Vec<_> = self
                .inner
                .entries
                .lock()
                .unwrap()
                .values()
                .filter_map(|entry| {
                    entry
                        .running
                        .as_ref()
                        .map(|running| (running.pid, running.pids_for_lock.clone()))
                })
                .collect();
            if processes
                .iter()
                .all(|(pid, tracked)| !process_tree_is_alive(*pid, tracked))
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        let remaining: Vec<_> = self
            .inner
            .entries
            .lock()
            .unwrap()
            .values()
            .filter_map(|entry| {
                entry
                    .running
                    .as_ref()
                    .map(|running| (running.pid, running.pids_for_lock.clone()))
            })
            .filter(|(pid, tracked)| process_tree_is_alive(*pid, tracked))
            .collect();
        if !remaining.is_empty() {
            let _ = tokio::task::spawn_blocking(move || {
                for (pid, tracked) in remaining {
                    kill_tracked_process_tree(pid, &tracked, "SIGKILL");
                }
            })
            .await;
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
        self.inner.entries.lock().unwrap().clear();
        self.persist_lock();
    }

    pub fn shutdown_sync(&self) {
        let processes: Vec<_> = self
            .inner
            .entries
            .lock()
            .unwrap()
            .values()
            .filter_map(|entry| {
                entry.running.as_ref().map(|running| {
                    (
                        running.pid,
                        running.pids_for_lock.clone(),
                        entry
                            .config
                            .stop
                            .clone()
                            .unwrap_or_else(|| "SIGTERM".into()),
                    )
                })
            })
            .collect();
        for (pid, tracked, signal) in &processes {
            kill_tracked_process_tree(*pid, tracked, signal);
        }
        for _ in 0..50 {
            if processes
                .iter()
                .all(|(pid, tracked, _)| !process_tree_is_alive(*pid, tracked))
            {
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        for (pid, tracked, _) in processes {
            if process_tree_is_alive(pid, &tracked) {
                kill_tracked_process_tree(pid, &tracked, "SIGKILL");
            }
        }
        self.inner.entries.lock().unwrap().clear();
        self.clear_lock();
        if let Some(watchdog) = &self.inner.watchdog {
            watchdog.shutdown();
        }
    }
}

fn locked_pid_from_value(
    value: &serde_json::Value,
    legacy_lock_modified: std::time::SystemTime,
) -> Option<LockedPid> {
    if let Ok(locked) = serde_json::from_value::<LockedPid>(value.clone()) {
        return (is_valid_pid(locked.pid)
            && process_identity(locked.pid).as_deref() == Some(locked.identity.as_str()))
        .then_some(locked);
    }

    let pid = value
        .as_u64()
        .and_then(|pid| u32::try_from(pid).ok())
        .filter(|pid| process_started_before(*pid, legacy_lock_modified))?;
    capture_locked_pid(pid, None)
}

fn capture_locked_pid(pid: u32, process_group: Option<u32>) -> Option<LockedPid> {
    process_identity(pid).map(|identity| LockedPid {
        pid,
        identity,
        process_group,
    })
}

fn process_tree_is_alive(root_pid: u32, tracked_pids: &[LockedPid]) -> bool {
    #[cfg(unix)]
    {
        let _ = tracked_pids;
        is_process_tree_alive(root_pid)
    }
    #[cfg(windows)]
    {
        let _ = root_pid;
        tracked_pids.iter().any(locked_pid_is_current)
    }
}

fn kill_tracked_process_tree(root_pid: u32, tracked_pids: &[LockedPid], signal: &str) {
    #[cfg(unix)]
    kill_process_tree(root_pid, signal);
    #[cfg(windows)]
    for locked in tracked_pids {
        if locked_pid_is_current(locked) {
            kill_process_tree(locked.pid, signal);
        }
    }
    #[cfg(unix)]
    let _ = tracked_pids;
}

fn locked_pid_is_current(locked: &LockedPid) -> bool {
    process_identity(locked.pid).as_deref() == Some(locked.identity.as_str())
}

fn build_command(config: &ProcConfig) -> Result<Command, String> {
    if let Some(shell_command) = &config.shell {
        #[cfg(windows)]
        {
            let shell = std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".into());
            let mut command = Command::new(shell);
            command.args(["/c", &format!("chcp 65001>nul && {shell_command}")]);
            return Ok(command);
        }
        #[cfg(unix)]
        {
            let mut command = Command::new("/bin/sh");
            command.args(["-c", &format!("exec {shell_command}")]);
            return Ok(command);
        }
    }
    if let Some(command_line) = &config.cmd {
        let Some((program, arguments)) = command_line.split_first() else {
            return Err("Process has an empty cmd array".into());
        };
        let mut command = Command::new(program);
        #[cfg(windows)]
        let arguments = windows_utf8_arguments(program, arguments);
        command.args(arguments);
        return Ok(command);
    }
    Err("Process has neither shell nor cmd".into())
}

#[cfg(windows)]
fn should_track_windows_descendants(config: &ProcConfig) -> bool {
    config.shell.is_some()
        || config
            .cmd
            .as_ref()
            .and_then(|command| command.first())
            .is_some_and(|program| is_cmd_executable(program))
}

#[cfg(windows)]
fn is_windows_shell_name(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "cmd.exe" | "command.com" | "powershell.exe" | "pwsh.exe"
    )
}

#[cfg(any(windows, test))]
fn is_cmd_executable(program: &str) -> bool {
    let program = program.to_ascii_lowercase();
    program == "cmd"
        || program == "cmd.exe"
        || program.ends_with("\\cmd.exe")
        || program.ends_with("/cmd.exe")
}

#[cfg(any(windows, test))]
fn windows_utf8_arguments(program: &str, arguments: &[String]) -> Vec<String> {
    let lower = program.to_ascii_lowercase();
    if is_cmd_executable(program) && arguments.len() >= 2 && arguments[0].eq_ignore_ascii_case("/c")
    {
        return vec![
            arguments[0].clone(),
            format!("chcp 65001>nul && {}", arguments[1..].join(" ")),
        ];
    }
    if lower.ends_with("powershell.exe")
        || lower.ends_with("pwsh.exe")
        || lower == "powershell"
        || lower == "pwsh"
    {
        if let Some(index) = arguments.iter().position(|argument| {
            argument.eq_ignore_ascii_case("-command") || argument.eq_ignore_ascii_case("-c")
        }) {
            let mut rewritten = arguments.to_vec();
            if let Some(command) = rewritten.get_mut(index + 1) {
                *command = format!("[Console]::InputEncoding=[Text.UTF8Encoding]::new($false); [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); {command}");
            }
            return rewritten;
        }
    }
    arguments.to_vec()
}

fn apply_environment(command: &mut Command, config: &ProcConfig) {
    if let Some(environment) = &config.env {
        for (name, value) in environment {
            match value {
                Some(value) => {
                    command.env(name, value);
                }
                None => {
                    command.env_remove(name);
                }
            }
        }
    }
    if !config.add_path.is_empty() {
        let mut paths: Vec<_> = config.add_path.iter().map(PathBuf::from).collect();
        if let Some(existing) = std::env::var_os("PATH") {
            paths.extend(std::env::split_paths(&existing));
        }
        if let Ok(path) = std::env::join_paths(paths) {
            command.env("PATH", path);
        }
    }
}

fn configure_process_group(command: &mut Command) {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.as_std_mut().process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command
            .as_std_mut()
            .creation_flags(windows_sys::Win32::System::Threading::CREATE_NEW_PROCESS_GROUP);
    }
}

fn spawn_output_reader<R>(
    app: AppHandle,
    proc_id: String,
    mut reader: R,
    is_stderr: bool,
    log: Option<Arc<AsyncMutex<tokio::fs::File>>>,
) -> tauri::async_runtime::JoinHandle<()>
where
    R: AsyncRead + Unpin + Send + 'static,
{
    tauri::async_runtime::spawn(async move {
        let mut buffer = vec![0_u8; 8192];
        loop {
            let count = match reader.read(&mut buffer).await {
                Ok(0) | Err(_) => break,
                Ok(count) => count,
            };
            if let Some(log) = &log {
                let _ = log.lock().await.write_all(&buffer[..count]).await;
            }
            let _ = app.emit(
                "process-output",
                ProcessOutput {
                    proc_id: proc_id.clone(),
                    text: String::from_utf8_lossy(&buffer[..count]).into_owned(),
                    is_stderr,
                },
            );
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_requires_shell_or_argv() {
        assert!(build_command(&ProcConfig::default()).is_err());
    }

    #[test]
    fn builds_argv_command() {
        let config = ProcConfig {
            cmd: Some(vec!["echo".into(), "hello".into()]),
            ..ProcConfig::default()
        };
        assert!(build_command(&config).is_ok());
    }

    #[test]
    fn wraps_cmd_commands_for_utf8() {
        assert_eq!(
            windows_utf8_arguments("cmd.exe", &["/c".into(), "echo äöü".into()]),
            vec!["/c", "chcp 65001>nul && echo äöü"]
        );
    }

    #[test]
    fn recognizes_cmd_paths_with_both_separator_styles() {
        assert!(is_cmd_executable(r"C:\Windows\System32\cmd.exe"));
        assert!(is_cmd_executable("C:/Windows/System32/cmd.exe"));
        assert!(!is_cmd_executable("notcmd.exe"));
    }

    #[test]
    fn wraps_powershell_commands_for_utf8() {
        let arguments = windows_utf8_arguments(
            "powershell.exe",
            &[
                "-NoProfile".into(),
                "-Command".into(),
                "Write-Output 'äöü'".into(),
            ],
        );
        assert!(arguments[2].contains("[Console]::OutputEncoding"));
        assert!(arguments[2].contains("Write-Output 'äöü'"));
    }

    #[test]
    fn reads_identity_locks_and_safely_migrates_legacy_pids() {
        let pid = std::process::id();
        let identity = process_identity(pid).unwrap();
        let detailed = serde_json::json!({ "pid": pid, "identity": identity });
        assert_eq!(
            locked_pid_from_value(&detailed, std::time::SystemTime::now()).map(|locked| locked.pid),
            Some(pid)
        );
        assert_eq!(
            locked_pid_from_value(&serde_json::json!(pid), std::time::SystemTime::now())
                .map(|locked| locked.pid),
            Some(pid)
        );
        assert!(
            locked_pid_from_value(&serde_json::json!(1), std::time::SystemTime::now()).is_none()
        );
    }
}
