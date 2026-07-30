use std::{ffi::OsString, path::Path};

#[cfg(any(target_os = "macos", target_os = "linux", windows))]
use std::{
    collections::HashSet,
    ffi::OsStr,
    io::Read,
    path::PathBuf,
    process::{Command, Stdio},
    time::{Duration, Instant},
};

#[cfg(any(target_os = "macos", target_os = "linux"))]
use std::ffi::CStr;

#[cfg(any(target_os = "macos", target_os = "linux"))]
const PATH_KEY: &str = "PATH=";

#[cfg(windows)]
const WINDOWS_PATH_COMMAND: &str = r#"[Console]::OutputEncoding=[Text.Encoding]::UTF8; $paths=@($env:Path,[Environment]::GetEnvironmentVariable('Path','User'),[Environment]::GetEnvironmentVariable('Path','Machine')) | Where-Object { $_ }; [Console]::Out.Write('__OPROCS_PATH_BEGIN__'); [Console]::Out.Write(($paths -join ';')); [Console]::Out.Write('__OPROCS_PATH_END__')"#;

#[cfg(any(windows, test))]
const WINDOWS_PATH_BEGIN: &str = "__OPROCS_PATH_BEGIN__";
#[cfg(any(windows, test))]
const WINDOWS_PATH_END: &str = "__OPROCS_PATH_END__";

pub fn resolve_path(directory: Option<&Path>) -> Option<OsString> {
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        let shell_path = query_login_shell_path(directory)?;
        merge_paths(&shell_path, std::env::var_os("PATH").as_deref())
    }

    #[cfg(windows)]
    {
        let shell_path = query_windows_shell_path(directory)?;
        merge_paths(&shell_path, std::env::var_os("PATH").as_deref())
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
    {
        let _ = directory;
        None
    }
}

#[cfg(any(target_os = "macos", target_os = "linux", windows))]
fn merge_paths(shell_path: &OsStr, inherited_path: Option<&OsStr>) -> Option<OsString> {
    let mut seen = HashSet::new();
    let mut paths = Vec::new();
    for path in std::env::split_paths(shell_path)
        .chain(inherited_path.into_iter().flat_map(std::env::split_paths))
    {
        if seen.insert(path.clone()) {
            paths.push(path);
        }
    }
    std::env::join_paths(paths).ok()
}

#[cfg(any(target_os = "macos", target_os = "linux", windows))]
fn capture_stdout(mut command: Command, timeout: Duration) -> Option<Vec<u8>> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = command.spawn().ok()?;
    let deadline = Instant::now() + timeout;
    let status = loop {
        if let Some(status) = child.try_wait().ok()? {
            break status;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return None;
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    if !status.success() {
        return None;
    }

    let mut output = Vec::new();
    child.stdout.take()?.read_to_end(&mut output).ok()?;
    Some(output)
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn extract_null_delimited_path(output: &[u8]) -> Option<OsString> {
    output.split(|byte| *byte == 0).find_map(|entry| {
        let entry = String::from_utf8_lossy(entry);
        let value = entry.strip_prefix(PATH_KEY).or_else(|| {
            entry
                .rsplit_once(&format!("\n{PATH_KEY}"))
                .map(|(_, value)| value)
        })?;
        (!value.is_empty()).then(|| OsString::from(value))
    })
}

#[cfg(any(windows, test))]
fn extract_marked_windows_path(output: &[u8]) -> Option<OsString> {
    let output = String::from_utf8_lossy(output);
    let (_, remainder) = output.rsplit_once(WINDOWS_PATH_BEGIN)?;
    let (path, _) = remainder.split_once(WINDOWS_PATH_END)?;
    (!path.is_empty()).then(|| OsString::from(path))
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn query_login_shell_path(directory: Option<&Path>) -> Option<OsString> {
    let shell = account_login_shell().or_else(|| std::env::var_os("SHELL").map(PathBuf::from))?;
    let login_path = query_unix_shell_path(&shell, ["-l", "-i"], directory);

    // Bash does not read .bashrc for an interactive login shell. Tool managers commonly add
    // themselves there, while other PATH entries may live in .profile/.bash_profile, so retain
    // the result from both startup modes.
    if shell.file_name() == Some(OsStr::new("bash")) {
        let interactive_path = query_unix_shell_path(&shell, ["-i"], directory);
        return match (interactive_path, login_path) {
            (Some(interactive), Some(login)) => merge_paths(&interactive, Some(&login)),
            (Some(interactive), None) => Some(interactive),
            (None, login) => login,
        };
    }

    login_path
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn query_unix_shell_path<const N: usize>(
    shell: &Path,
    startup_arguments: [&str; N],
    directory: Option<&Path>,
) -> Option<OsString> {
    let mut command = Command::new(shell);
    command
        .args(startup_arguments)
        .args(["-c", "/usr/bin/env -0"]);
    if let Some(directory) = directory.filter(|path| path.is_dir()) {
        command.current_dir(directory);
    }
    extract_null_delimited_path(&capture_stdout(command, Duration::from_secs(3))?)
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn account_login_shell() -> Option<PathBuf> {
    let buffer_size = unsafe { libc::sysconf(libc::_SC_GETPW_R_SIZE_MAX) };
    let mut buffer = vec![0_u8; usize::try_from(buffer_size).unwrap_or(16_384).max(1_024)];
    let mut passwd = std::mem::MaybeUninit::<libc::passwd>::uninit();
    let mut result = std::ptr::null_mut();

    // SAFETY: getpwuid_r writes into the provided passwd and buffer for the current process user.
    let status = unsafe {
        libc::getpwuid_r(
            libc::geteuid(),
            passwd.as_mut_ptr(),
            buffer.as_mut_ptr().cast(),
            buffer.len(),
            &mut result,
        )
    };
    if status != 0 || result.is_null() {
        return None;
    }

    // SAFETY: a successful getpwuid_r call initialized passwd, which remains backed by buffer.
    let passwd = unsafe { passwd.assume_init() };
    if passwd.pw_shell.is_null() {
        return None;
    }
    // SAFETY: pw_shell is non-null and points into the live getpwuid_r buffer.
    let shell = unsafe { CStr::from_ptr(passwd.pw_shell) };
    let shell = PathBuf::from(OsString::from(shell.to_string_lossy().into_owned()));
    shell.is_absolute().then_some(shell)
}

#[cfg(windows)]
fn query_windows_shell_path(directory: Option<&Path>) -> Option<OsString> {
    for shell in windows_powershell_candidates() {
        let mut command = Command::new(shell);
        command.args([
            "-NoLogo",
            "-NonInteractive",
            "-Command",
            WINDOWS_PATH_COMMAND,
        ]);
        if let Some(directory) = directory.filter(|path| path.is_dir()) {
            command.current_dir(directory);
        }
        if let Some(path) = capture_stdout(command, Duration::from_secs(3))
            .and_then(|output| extract_marked_windows_path(&output))
        {
            return Some(path);
        }
    }
    None
}

#[cfg(windows)]
fn windows_powershell_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(program_files) = std::env::var_os("ProgramFiles") {
        candidates.push(PathBuf::from(program_files).join("PowerShell/7/pwsh.exe"));
    }
    if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
        candidates.push(PathBuf::from(local_app_data).join("Microsoft/WindowsApps/pwsh.exe"));
    }
    if let Some(system_root) = std::env::var_os("SystemRoot") {
        candidates.push(
            PathBuf::from(system_root).join("System32/WindowsPowerShell/v1.0/powershell.exe"),
        );
    }
    candidates.retain(|path| path.is_file());
    if candidates.is_empty() {
        candidates.push(PathBuf::from("powershell.exe"));
    }
    candidates
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn extracts_path_from_a_null_delimited_environment() {
        assert_eq!(
            extract_null_delimited_path(b"HOME=/tmp\0PATH=/one:/two\0SHELL=/bin/sh\0"),
            Some(OsString::from("/one:/two"))
        );
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn extracts_path_after_shell_startup_output() {
        assert_eq!(
            extract_null_delimited_path(b"startup message\nPATH=/one:/two\0HOME=/tmp\0"),
            Some(OsString::from("/one:/two"))
        );
    }

    #[test]
    fn extracts_the_last_marked_windows_path() {
        assert_eq!(
            extract_marked_windows_path(
                b"profile output\n__OPROCS_PATH_BEGIN__C:\\one;C:\\two__OPROCS_PATH_END__"
            ),
            Some(OsString::from(r"C:\one;C:\two"))
        );
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn merges_shell_and_inherited_paths_without_duplicates() {
        assert_eq!(
            merge_paths(
                OsStr::new("/shell:/shared"),
                Some(OsStr::new("/shared:/inherited"))
            ),
            Some(OsString::from("/shell:/shared:/inherited"))
        );
    }
}
