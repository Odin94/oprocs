use std::{ffi::OsString, path::Path};

#[cfg(target_os = "macos")]
use std::{
    collections::HashSet,
    ffi::CStr,
    ffi::OsStr,
    io::Read,
    path::PathBuf,
    process::{Command, Stdio},
    time::{Duration, Instant},
};

#[cfg(target_os = "macos")]
const PATH_KEY: &str = "PATH=";

pub fn resolve_path(directory: Option<&Path>) -> Option<OsString> {
    #[cfg(target_os = "macos")]
    {
        let shell_path = query_login_shell_path(directory)?;
        merge_paths(&shell_path, std::env::var_os("PATH").as_deref())
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = directory;
        None
    }
}

#[cfg(target_os = "macos")]
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

#[cfg(target_os = "macos")]
fn extract_path(output: &[u8]) -> Option<OsString> {
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

#[cfg(target_os = "macos")]
fn query_login_shell_path(directory: Option<&Path>) -> Option<OsString> {
    let shell = account_login_shell().or_else(|| std::env::var_os("SHELL").map(PathBuf::from))?;
    let mut command = Command::new(shell);
    command
        .args(["-l", "-i", "-c", "/usr/bin/env -0"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    if let Some(directory) = directory.filter(|path| path.is_dir()) {
        command.current_dir(directory);
    }

    let mut child = command.spawn().ok()?;
    let deadline = Instant::now() + Duration::from_secs(3);
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
    extract_path(&output)
}

#[cfg(target_os = "macos")]
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

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

    #[test]
    fn extracts_path_from_a_null_delimited_environment() {
        assert_eq!(
            extract_path(b"HOME=/tmp\0PATH=/one:/two\0SHELL=/bin/sh\0"),
            Some(OsString::from("/one:/two"))
        );
    }

    #[test]
    fn extracts_path_after_shell_startup_output() {
        assert_eq!(
            extract_path(b"startup message\nPATH=/one:/two\0HOME=/tmp\0"),
            Some(OsString::from("/one:/two"))
        );
    }

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
