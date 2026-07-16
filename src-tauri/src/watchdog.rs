#[cfg(unix)]
use crate::system::{is_pid_alive, is_process_tree_alive};
use crate::system::{is_valid_pid, kill_process_tree, process_identity};
use serde::Deserialize;
use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Write},
    process::{Child, ChildStdin, Command, Stdio},
    sync::mpsc::{self, RecvTimeoutError},
    sync::{Arc, Mutex},
    time::Duration,
};

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum WatchdogMessage {
    Track { pid: u32, identity: String },
    Untrack { pid: u32 },
    Shutdown,
}

struct WatchdogInner {
    child: Option<Child>,
    stdin: Option<ChildStdin>,
}

#[derive(Clone)]
pub struct Watchdog {
    inner: Arc<Mutex<WatchdogInner>>,
}

impl Watchdog {
    pub fn start() -> Result<Self, String> {
        let executable = std::env::current_exe().map_err(|error| error.to_string())?;
        let mut command = Command::new(executable);
        command
            .args(["--watchdog", &std::process::id().to_string()])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        configure_watchdog_process(&mut command);
        let mut child = command.spawn().map_err(|error| error.to_string())?;
        let stdin = child.stdin.take();
        Ok(Self {
            inner: Arc::new(Mutex::new(WatchdogInner {
                child: Some(child),
                stdin,
            })),
        })
    }

    pub fn track(&self, pid: u32, identity: &str) {
        if is_valid_pid(pid) {
            self.send(
                &serde_json::json!({ "type": "track", "pid": pid, "identity": identity })
                    .to_string(),
            );
        }
    }

    pub fn untrack(&self, pid: u32) {
        self.send(&format!("{{\"type\":\"untrack\",\"pid\":{pid}}}"));
    }

    fn send(&self, message: &str) {
        if let Ok(mut inner) = self.inner.lock() {
            if let Some(stdin) = &mut inner.stdin {
                let _ = writeln!(stdin, "{message}");
                let _ = stdin.flush();
            }
        }
    }

    pub fn shutdown(&self) {
        if let Ok(mut inner) = self.inner.lock() {
            if let Some(mut stdin) = inner.stdin.take() {
                let _ = writeln!(stdin, "{{\"type\":\"shutdown\"}}");
                let _ = stdin.flush();
            }
            let _ = inner.child.take();
        }
    }
}

fn configure_watchdog_process(command: &mut Command) {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(windows_sys::Win32::System::Threading::CREATE_NEW_PROCESS_GROUP);
    }
}

pub fn run_watchdog() {
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || {
        for line in BufReader::new(std::io::stdin().lock())
            .lines()
            .map_while(Result::ok)
        {
            if let Ok(message) = serde_json::from_str::<WatchdogMessage>(&line) {
                if sender.send(message).is_err() {
                    return;
                }
            }
        }
    });

    let mut tracked = HashMap::new();
    loop {
        match receiver.recv_timeout(Duration::from_secs(1)) {
            Ok(WatchdogMessage::Track { pid, identity }) if is_valid_pid(pid) => {
                tracked.insert(pid, identity);
            }
            Ok(WatchdogMessage::Untrack { pid }) => {
                tracked.remove(&pid);
            }
            Ok(WatchdogMessage::Shutdown) => break,
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => break,
            _ => {}
        }
        tracked.retain(|pid, identity| tracked_process_is_current(*pid, identity));
    }
    for (pid, identity) in &tracked {
        if tracked_process_is_current(*pid, identity) {
            kill_process_tree(*pid, "SIGTERM");
        }
    }
    std::thread::sleep(std::time::Duration::from_secs(1));
    for (pid, identity) in tracked {
        if tracked_process_is_current(pid, &identity) {
            kill_process_tree(pid, "SIGKILL");
        }
    }
}

fn tracked_process_is_current(pid: u32, identity: &str) -> bool {
    #[cfg(unix)]
    {
        if is_pid_alive(pid) {
            process_identity(pid).as_deref() == Some(identity)
        } else {
            is_process_tree_alive(pid)
        }
    }
    #[cfg(windows)]
    {
        process_identity(pid).as_deref() == Some(identity)
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn validates_tracked_process_identity() {
        let pid = std::process::id();
        let identity = crate::system::process_identity(pid).unwrap();
        assert!(super::tracked_process_is_current(pid, &identity));
        assert!(!super::tracked_process_is_current(pid, "wrong-identity"));
    }
}
