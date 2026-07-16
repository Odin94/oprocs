use crate::types::PortOccupant;
use std::process::Command;
#[cfg(windows)]
use std::process::Stdio;

pub fn is_valid_pid(pid: u32) -> bool {
    pid > 1 && pid <= i32::MAX as u32
}

pub fn process_identity(pid: u32) -> Option<String> {
    if !is_valid_pid(pid) {
        return None;
    }
    #[cfg(target_os = "macos")]
    {
        mac_process_info(pid).map(|info| {
            format!(
                "{:x}:{:x}:{}",
                info.pbi_start_tvsec, info.pbi_start_tvusec, info.pbi_pgid
            )
        })
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let output = Command::new("ps")
            .args(["-p", &pid.to_string(), "-o", "lstart=", "-o", "pgid="])
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        let identity = String::from_utf8_lossy(&output.stdout).trim().to_owned();
        (!identity.is_empty()).then_some(identity)
    }
    #[cfg(windows)]
    {
        windows_process_creation(pid).map(|creation| format!("{creation:016x}"))
    }
}

pub fn process_started_before(pid: u32, timestamp: std::time::SystemTime) -> bool {
    if !is_valid_pid(pid) {
        return false;
    }
    #[cfg(target_os = "macos")]
    {
        let Ok(timestamp) = timestamp.duration_since(std::time::UNIX_EPOCH) else {
            return false;
        };
        mac_process_info(pid).is_some_and(|info| {
            let process_micros =
                u128::from(info.pbi_start_tvsec) * 1_000_000 + u128::from(info.pbi_start_tvusec);
            let lock_micros = timestamp.as_micros().saturating_add(2_000_000);
            process_micros <= lock_micros
        })
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let Ok(lock_age) = std::time::SystemTime::now().duration_since(timestamp) else {
            return false;
        };
        let output = match Command::new("ps")
            .args(["-p", &pid.to_string(), "-o", "etime="])
            .output()
        {
            Ok(output) if output.status.success() => output,
            _ => return false,
        };
        parse_elapsed_time(&String::from_utf8_lossy(&output.stdout))
            .is_some_and(|process_age| process_age + std::time::Duration::from_secs(2) >= lock_age)
    }
    #[cfg(windows)]
    {
        const WINDOWS_TO_UNIX_EPOCH_SECONDS: u64 = 11_644_473_600;
        let Ok(unix_time) = timestamp.duration_since(std::time::UNIX_EPOCH) else {
            return false;
        };
        let lock_filetime = (unix_time.as_secs() + WINDOWS_TO_UNIX_EPOCH_SECONDS)
            .saturating_mul(10_000_000)
            .saturating_add(u64::from(unix_time.subsec_nanos()) / 100);
        windows_process_creation(pid)
            .is_some_and(|creation| creation <= lock_filetime.saturating_add(20_000_000))
    }
}

#[cfg(target_os = "macos")]
#[repr(C)]
struct MacProcBsdInfo {
    pbi_flags: u32,
    pbi_status: u32,
    pbi_xstatus: u32,
    pbi_pid: u32,
    pbi_ppid: u32,
    pbi_uid: u32,
    pbi_gid: u32,
    pbi_ruid: u32,
    pbi_rgid: u32,
    pbi_svuid: u32,
    pbi_svgid: u32,
    rfu_1: u32,
    pbi_comm: [libc::c_char; 16],
    pbi_name: [libc::c_char; 32],
    pbi_nfiles: u32,
    pbi_pgid: u32,
    pbi_pjobc: u32,
    e_tdev: u32,
    e_tpgid: u32,
    pbi_nice: i32,
    pbi_start_tvsec: u64,
    pbi_start_tvusec: u64,
}

#[cfg(target_os = "macos")]
fn mac_process_info(pid: u32) -> Option<MacProcBsdInfo> {
    const PROC_PIDTBSDINFO: libc::c_int = 3;

    #[link(name = "proc")]
    unsafe extern "C" {
        fn proc_pidinfo(
            pid: libc::c_int,
            flavor: libc::c_int,
            arg: u64,
            buffer: *mut libc::c_void,
            buffer_size: libc::c_int,
        ) -> libc::c_int;
    }

    let mut info = std::mem::MaybeUninit::<MacProcBsdInfo>::uninit();
    let expected_size = std::mem::size_of::<MacProcBsdInfo>();
    let written = unsafe {
        proc_pidinfo(
            pid as libc::c_int,
            PROC_PIDTBSDINFO,
            0,
            info.as_mut_ptr().cast(),
            expected_size as libc::c_int,
        )
    };
    (written == expected_size as libc::c_int).then(|| unsafe { info.assume_init() })
}

#[cfg(any(all(unix, not(target_os = "macos")), test))]
fn parse_elapsed_time(text: &str) -> Option<std::time::Duration> {
    let text = text.trim();
    let (days, clock) = if let Some((days, clock)) = text.split_once('-') {
        (days.parse::<u64>().ok()?, clock)
    } else {
        (0, text)
    };
    let fields = clock
        .split(':')
        .map(str::parse::<u64>)
        .collect::<Result<Vec<_>, _>>()
        .ok()?;
    let seconds = match fields.as_slice() {
        [minutes, seconds] => minutes.checked_mul(60)?.checked_add(*seconds)?,
        [hours, minutes, seconds] => hours
            .checked_mul(3600)?
            .checked_add(minutes.checked_mul(60)?)?
            .checked_add(*seconds)?,
        _ => return None,
    };
    Some(std::time::Duration::from_secs(
        days.checked_mul(86_400)?.checked_add(seconds)?,
    ))
}

#[cfg(windows)]
fn windows_process_creation(pid: u32) -> Option<u64> {
    use windows_sys::Win32::{
        Foundation::{CloseHandle, FILETIME},
        System::Threading::{GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION},
    };

    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if handle.is_null() {
        return None;
    }
    let mut creation = FILETIME::default();
    let mut exit = FILETIME::default();
    let mut kernel = FILETIME::default();
    let mut user = FILETIME::default();
    let succeeded =
        unsafe { GetProcessTimes(handle, &mut creation, &mut exit, &mut kernel, &mut user) != 0 };
    unsafe {
        CloseHandle(handle);
    }
    succeeded
        .then(|| (u64::from(creation.dwHighDateTime) << 32) | u64::from(creation.dwLowDateTime))
}

pub fn is_pid_alive(pid: u32) -> bool {
    if !is_valid_pid(pid) {
        return false;
    }
    #[cfg(unix)]
    {
        let result = unsafe { libc::kill(pid as i32, 0) };
        result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
    }
    #[cfg(windows)]
    {
        Command::new("tasklist.exe")
            .args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"])
            .output()
            .map(|output| String::from_utf8_lossy(&output.stdout).contains(&pid.to_string()))
            .unwrap_or(false)
    }
}

pub fn is_process_tree_alive(pid: u32) -> bool {
    if !is_valid_pid(pid) {
        return false;
    }
    #[cfg(unix)]
    {
        let result = unsafe { libc::kill(-(pid as i32), 0) };
        result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
    }
    #[cfg(windows)]
    is_pid_alive(pid)
}

pub fn kill_process_tree(pid: u32, signal: &str) {
    if !is_valid_pid(pid) {
        return;
    }
    #[cfg(unix)]
    {
        let signal = unix_signal(signal);
        unsafe {
            libc::kill(-(pid as i32), signal);
            libc::kill(pid as i32, signal);
        }
    }
    #[cfg(windows)]
    {
        let _ = signal;
        let _ = Command::new("taskkill.exe")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

#[cfg(unix)]
fn unix_signal(signal: &str) -> i32 {
    match signal {
        "SIGINT" => libc::SIGINT,
        "SIGKILL" | "hard-kill" => libc::SIGKILL,
        _ => libc::SIGTERM,
    }
}

#[cfg(unix)]
fn parse_process_tree(text: &str, root_pid: u32) -> Vec<u32> {
    use std::collections::{HashMap, HashSet};

    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    for line in text.lines() {
        let mut fields = line.split_whitespace();
        let Some(pid) = fields.next().and_then(|value| value.parse::<u32>().ok()) else {
            continue;
        };
        let Some(parent_pid) = fields.next().and_then(|value| value.parse::<u32>().ok()) else {
            continue;
        };
        children.entry(parent_pid).or_default().push(pid);
    }

    fn visit(
        parent: u32,
        children: &HashMap<u32, Vec<u32>>,
        visited: &mut HashSet<u32>,
        descendants: &mut Vec<u32>,
    ) {
        for child in children.get(&parent).into_iter().flatten() {
            if visited.insert(*child) {
                visit(*child, children, visited, descendants);
                descendants.push(*child);
            }
        }
    }

    let mut descendants = Vec::new();
    visit(root_pid, &children, &mut HashSet::new(), &mut descendants);
    descendants
}

#[cfg(unix)]
pub fn get_process_group_members(group_id: u32) -> Vec<u32> {
    Command::new("ps")
        .args(["-axo", "pid=,pgid="])
        .output()
        .ok()
        .map(|output| parse_process_group(&String::from_utf8_lossy(&output.stdout), group_id))
        .unwrap_or_default()
}

#[cfg(any(unix, test))]
fn parse_process_group(text: &str, group_id: u32) -> Vec<u32> {
    text.lines()
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            let pid = fields.next()?.parse::<u32>().ok()?;
            let process_group = fields.next()?.parse::<u32>().ok()?;
            (process_group == group_id && is_valid_pid(pid)).then_some(pid)
        })
        .collect()
}

pub fn kill_pid_tree(pid: u32, signal: &str) {
    if !is_valid_pid(pid) {
        return;
    }
    #[cfg(unix)]
    {
        let descendants = Command::new("ps")
            .args(["-axo", "pid=,ppid="])
            .output()
            .ok()
            .map(|output| parse_process_tree(&String::from_utf8_lossy(&output.stdout), pid))
            .unwrap_or_default();
        let signal = unix_signal(signal);
        for descendant in descendants {
            unsafe {
                libc::kill(descendant as i32, signal);
            }
        }
        unsafe {
            libc::kill(pid as i32, signal);
        }
    }
    #[cfg(windows)]
    kill_process_tree(pid, signal);
}

#[cfg(any(windows, test))]
#[derive(Clone, Debug, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "PascalCase")]
pub struct WindowsProcessInfo {
    pub process_id: u32,
    pub parent_process_id: u32,
    #[serde(default)]
    pub name: String,
}

#[cfg(any(windows, test))]
fn parse_windows_processes(text: &str) -> Vec<WindowsProcessInfo> {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(text) else {
        return Vec::new();
    };
    match value {
        serde_json::Value::Array(values) => values
            .into_iter()
            .filter_map(|value| serde_json::from_value(value).ok())
            .collect(),
        value => serde_json::from_value(value).into_iter().collect(),
    }
}

#[cfg(windows)]
pub async fn get_windows_descendants(root_pids: &[u32]) -> Vec<(u32, String, u32)> {
    use std::collections::{HashMap, HashSet};

    let script = "Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name | ConvertTo-Json -Compress";
    let Ok(output) = tokio::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-Command", script])
        .output()
        .await
    else {
        return Vec::new();
    };
    let processes = parse_windows_processes(&String::from_utf8_lossy(&output.stdout));
    let mut children: HashMap<u32, Vec<WindowsProcessInfo>> = HashMap::new();
    for process in processes {
        children
            .entry(process.parent_process_id)
            .or_default()
            .push(process);
    }

    fn visit(
        parent: u32,
        depth: u32,
        children: &HashMap<u32, Vec<WindowsProcessInfo>>,
        visited: &mut HashSet<u32>,
        descendants: &mut Vec<(u32, String, u32)>,
    ) {
        for child in children.get(&parent).into_iter().flatten() {
            if visited.insert(child.process_id) {
                descendants.push((child.process_id, child.name.clone(), depth));
                visit(child.process_id, depth + 1, children, visited, descendants);
            }
        }
    }

    let mut descendants = Vec::new();
    let mut visited = HashSet::new();
    for root_pid in root_pids {
        visit(*root_pid, 0, &children, &mut visited, &mut descendants);
    }
    descendants
}

#[cfg(unix)]
fn parse_lsof(port: u16, text: &str) -> Option<PortOccupant> {
    let mut pid = None;
    let mut command = None;
    let mut detail = None;
    for line in text.lines().map(str::trim).filter(|line| !line.is_empty()) {
        match line.as_bytes().first().copied() {
            Some(b'p') if pid.is_none() => pid = line[1..].parse::<u32>().ok(),
            Some(b'c') if command.is_none() => command = Some(line[1..].to_owned()),
            Some(b'n') if detail.is_none() => detail = Some(line[1..].to_owned()),
            Some(b'p') => break,
            _ => {}
        }
    }
    pid.map(|pid| PortOccupant {
        port,
        pid,
        command: command.unwrap_or_else(|| format!("pid {pid}")),
        detail,
    })
}

pub async fn get_port_occupant(port: u16) -> Option<PortOccupant> {
    #[cfg(unix)]
    {
        if let Ok(output) = tokio::process::Command::new("lsof")
            .args(["-nP", &format!("-iTCP:{port}"), "-sTCP:LISTEN", "-Fpcn"])
            .output()
            .await
        {
            if let Some(occupant) = parse_lsof(port, &String::from_utf8_lossy(&output.stdout)) {
                return Some(occupant);
            }
        }

        #[cfg(target_os = "linux")]
        if let Ok(output) = tokio::process::Command::new("ss")
            .args(["-ltnp", &format!("sport = :{port}")])
            .output()
            .await
        {
            let text = String::from_utf8_lossy(&output.stdout);
            if let Some(users) = text.find("users:((\"") {
                let rest = &text[users + 9..];
                let command = rest.split('"').next().unwrap_or("unknown").to_owned();
                if let Some(pid_start) = rest.find("pid=") {
                    let pid_text = &rest[pid_start + 4..];
                    if let Some(pid) = pid_text
                        .split(|character: char| !character.is_ascii_digit())
                        .next()
                        .and_then(|value| value.parse().ok())
                    {
                        return Some(PortOccupant {
                            port,
                            pid,
                            command,
                            detail: Some(format!("TCP *:{port}")),
                        });
                    }
                }
            }
        }
        None
    }

    #[cfg(windows)]
    {
        let output = tokio::process::Command::new("netstat.exe")
            .args(["-ano", "-p", "tcp"])
            .output()
            .await
            .ok()?;
        let text = String::from_utf8_lossy(&output.stdout);
        let pid = text.lines().find_map(|line| {
            let fields: Vec<_> = line.split_whitespace().collect();
            if fields.len() >= 5
                && fields[0].eq_ignore_ascii_case("TCP")
                && fields[1].ends_with(&format!(":{port}"))
                && fields[3].eq_ignore_ascii_case("LISTENING")
            {
                fields[4].parse::<u32>().ok()
            } else {
                None
            }
        })?;
        let command = tokio::process::Command::new("tasklist.exe")
            .args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"])
            .output()
            .await
            .ok()
            .and_then(|output| {
                String::from_utf8_lossy(&output.stdout)
                    .split(',')
                    .next()
                    .map(|value| value.trim_matches('"').replace("\"\"", "\""))
            })
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| format!("pid {pid}"));
        Some(PortOccupant {
            port,
            pid,
            command,
            detail: Some(format!("TCP *:{port}")),
        })
    }
}

pub async fn kill_port_occupant(port: u16) -> Result<PortOccupant, String> {
    let occupant = get_port_occupant(port)
        .await
        .ok_or_else(|| "No listening process found for that port".to_owned())?;
    kill_pid_tree(occupant.pid, "SIGTERM");
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    if get_port_occupant(port)
        .await
        .is_some_and(|current| current.pid == occupant.pid)
    {
        kill_pid_tree(occupant.pid, "SIGKILL");
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        if get_port_occupant(port)
            .await
            .is_some_and(|current| current.pid == occupant.pid)
        {
            return Err(format!("Could not kill pid {}", occupant.pid));
        }
    }
    Ok(occupant)
}

#[cfg(test)]
mod tests {
    #[cfg(unix)]
    use std::{
        os::unix::process::CommandExt,
        process::Command,
        thread,
        time::{Duration, Instant},
    };

    #[test]
    fn rejects_dangerous_process_ids() {
        assert!(!super::is_valid_pid(0));
        assert!(!super::is_valid_pid(1));
        assert!(super::is_valid_pid(2));
        assert!(super::is_valid_pid(i32::MAX as u32));
        assert!(!super::is_valid_pid(i32::MAX as u32 + 1));
    }

    #[test]
    fn identifies_the_current_process() {
        let pid = std::process::id();
        let identity = super::process_identity(pid).expect("current process should have identity");
        assert!(!identity.is_empty());
        assert_eq!(
            super::process_identity(pid).as_deref(),
            Some(identity.as_str())
        );
    }

    #[test]
    fn parses_process_elapsed_time_formats() {
        assert_eq!(super::parse_elapsed_time("01:02").unwrap().as_secs(), 62);
        assert_eq!(
            super::parse_elapsed_time("02:03:04").unwrap().as_secs(),
            7_384
        );
        assert_eq!(
            super::parse_elapsed_time("3-02:03:04").unwrap().as_secs(),
            266_584
        );
        assert!(super::parse_elapsed_time("not-a-time").is_none());
    }

    #[cfg(unix)]
    #[test]
    fn parses_lsof_machine_output() {
        let occupant = super::parse_lsof(5173, "p42\ncnode\nn*:5173\n").unwrap();
        assert_eq!(occupant.pid, 42);
        assert_eq!(occupant.command, "node");
    }

    #[cfg(unix)]
    #[test]
    fn returns_descendants_deepest_first() {
        let tree = "10 1\n11 10\n12 10\n13 11\n99 1\n";
        assert_eq!(super::parse_process_tree(tree, 10), vec![13, 11, 12]);
    }

    #[test]
    fn parses_process_group_members() {
        assert_eq!(
            super::parse_process_group("10 10\n11 10\n12 12\n", 10),
            vec![10, 11]
        );
    }

    #[test]
    fn parses_single_and_multiple_windows_processes() {
        let single = r#"{"ProcessId":42,"ParentProcessId":7,"Name":"node.exe"}"#;
        assert_eq!(super::parse_windows_processes(single)[0].process_id, 42);
        let multiple = r#"[{"ProcessId":42,"ParentProcessId":7,"Name":"node.exe"},{"ProcessId":43,"ParentProcessId":42,"Name":"worker.exe"}]"#;
        assert_eq!(super::parse_windows_processes(multiple).len(), 2);
    }

    #[cfg(unix)]
    #[test]
    fn terminates_a_process_group() {
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "sleep 30 & wait"]).process_group(0);
        let mut child = command.spawn().unwrap();
        let pid = child.id();

        super::kill_process_tree(pid, "SIGTERM");
        let started = Instant::now();
        let stopped = loop {
            if child.try_wait().unwrap().is_some() {
                break true;
            }
            if started.elapsed() > Duration::from_secs(2) {
                break false;
            }
            thread::sleep(Duration::from_millis(25));
        };
        if !stopped {
            super::kill_process_tree(pid, "SIGKILL");
            let _ = child.wait();
        }
        assert!(stopped);
    }

    #[cfg(unix)]
    #[test]
    fn detects_a_process_group_after_its_leader_exits() {
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "sleep 30 &"]).process_group(0);
        let mut child = command.spawn().unwrap();
        let pid = child.id();
        child.wait().unwrap();

        assert!(super::is_process_tree_alive(pid));
        super::kill_process_tree(pid, "SIGKILL");
        let started = Instant::now();
        while super::is_process_tree_alive(pid) && started.elapsed() < Duration::from_secs(2) {
            thread::sleep(Duration::from_millis(25));
        }
        assert!(!super::is_process_tree_alive(pid));
    }
}
