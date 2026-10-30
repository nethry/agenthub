//! Runs the system `git` with argv arrays (never a shell string), a fixed
//! environment, bounded output, timeouts and cancellation. On Windows every
//! git process goes into a Job Object, so cancelling (or AgentHub ending) also
//! ends the helpers git started (git-remote-https, ssh, hooks).

use std::ffi::OsString;
use std::io::{Read, Write};
use std::path::Path;
use std::process::{Child, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

/// What a call does, which decides its environment.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Access {
    /// Never writes `.git/index` (no watcher feedback loop).
    Read,
    Write,
    /// Talks to a remote. `interactive` lets Git Credential Manager show its
    /// sign-in window; background calls fail fast instead.
    Network { interactive: bool },
}

pub type Cancel = Arc<AtomicBool>;

pub struct Output {
    pub code: i32,
    pub stdout: Vec<u8>,
    /// Last 64 KB of stderr (not yet redacted).
    pub stderr: String,
    pub cancelled: bool,
}

impl Output {
    pub fn ok(&self) -> bool {
        self.code == 0 && !self.cancelled
    }
    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.stdout).into_owned()
    }
}

const STDERR_KEEP: usize = 64 * 1024;
const DEFAULT_MAX_STDOUT: usize = 32 * 1024 * 1024;

/// One git invocation. Build it with [`Call::new`], then [`Call::run`].
pub struct Call<'a> {
    exe: &'a Path,
    cwd: &'a Path,
    access: Access,
    args: Vec<OsString>,
    stdin: Option<Vec<u8>>,
    timeout: Option<Duration>,
    max_stdout: usize,
    env: Vec<(OsString, OsString)>,
    fsmonitor_off: bool,
    on_line: Option<&'a (dyn Fn(&str) + Sync)>,
    cancel: Option<Cancel>,
}

impl<'a> Call<'a> {
    pub fn new(exe: &'a Path, cwd: &'a Path, access: Access) -> Self {
        Self {
            exe,
            cwd,
            access,
            args: Vec::new(),
            stdin: None,
            timeout: Some(Duration::from_secs(60)),
            max_stdout: DEFAULT_MAX_STDOUT,
            env: Vec::new(),
            fsmonitor_off: false,
            on_line: None,
            cancel: None,
        }
    }

    pub fn args<I, S>(mut self, args: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<OsString>,
    {
        self.args.extend(args.into_iter().map(Into::into));
        self
    }

    pub fn arg(mut self, a: impl Into<OsString>) -> Self {
        self.args.push(a.into());
        self
    }

    pub fn stdin(mut self, bytes: Vec<u8>) -> Self {
        self.stdin = Some(bytes);
        self
    }

    /// `None` waits until git ends (network calls, commits with hooks).
    pub fn timeout(mut self, t: Option<Duration>) -> Self {
        self.timeout = t;
        self
    }

    pub fn envs(mut self, env: &[(OsString, OsString)]) -> Self {
        self.env.extend(env.iter().cloned());
        self
    }

    pub fn fsmonitor_off(mut self, off: bool) -> Self {
        self.fsmonitor_off = off;
        self
    }

    /// Called with each stderr line (progress is split on `\r` too).
    pub fn on_line(mut self, f: &'a (dyn Fn(&str) + Sync)) -> Self {
        self.on_line = Some(f);
        self
    }

    pub fn cancel(mut self, c: Cancel) -> Self {
        self.cancel = Some(c);
        self
    }

    pub fn run(self) -> std::io::Result<Output> {
        let mut cmd = crate::chat::agents::command(self.exe);
        cmd.current_dir(self.cwd);
        cmd.args(["--no-pager", "--literal-pathspecs", "-c", "core.quotepath=off", "-c", "color.ui=never", "-c", "core.pager=cat"]);
        if self.fsmonitor_off {
            cmd.args(["-c", "core.fsmonitor=false"]);
        }
        cmd.args(&self.args);
        // A shell or hook that started AgentHub may have set these; they would
        // point git at another repository.
        for k in [
            "GIT_DIR",
            "GIT_WORK_TREE",
            "GIT_INDEX_FILE",
            "GIT_OBJECT_DIRECTORY",
            "GIT_ALTERNATE_OBJECT_DIRECTORIES",
            "GIT_COMMON_DIR",
            "GIT_NAMESPACE",
            "GIT_PREFIX",
        ] {
            cmd.env_remove(k);
        }
        cmd.env("LC_ALL", "C")
            .env("LANG", "C")
            .env("LANGUAGE", "")
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GIT_PAGER", "cat")
            .env("PAGER", "cat")
            // No TTY: git keeps messages as they are instead of opening an editor.
            .env("GIT_EDITOR", ":")
            .env("GIT_SEQUENCE_EDITOR", ":")
            .env("GIT_MERGE_AUTOEDIT", "no")
            .env("GIT_LITERAL_PATHSPECS", "1");
        match self.access {
            Access::Read => {
                cmd.env("GIT_OPTIONAL_LOCKS", "0");
            }
            Access::Network { interactive: false } => {
                cmd.env("GCM_INTERACTIVE", "never");
            }
            _ => {}
        }
        for (k, v) in &self.env {
            cmd.env(k, v);
        }
        cmd.stdin(if self.stdin.is_some() { Stdio::piped() } else { Stdio::null() })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let mut child = cmd.spawn()?;
        let job = job::Job::attach(&child);

        if let (Some(bytes), Some(mut pipe)) = (self.stdin, child.stdin.take()) {
            thread::spawn(move || {
                let _ = pipe.write_all(&bytes);
            });
        }
        let max = self.max_stdout;
        let mut out_pipe = child.stdout.take().expect("piped stdout");
        let stdout = thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = out_pipe.by_ref().take(max as u64 + 1).read_to_end(&mut buf);
            buf.truncate(max);
            // Keep draining so git never blocks on a full pipe.
            let _ = std::io::copy(&mut out_pipe, &mut std::io::sink());
            buf
        });
        let mut err_pipe = child.stderr.take().expect("piped stderr");
        let stderr = thread::scope(|scope| {
            let on_line = self.on_line;
            let reader = scope.spawn(move || read_stderr(&mut err_pipe, on_line));
            let cancelled = wait(&mut child, self.timeout, self.cancel.as_ref(), job.as_ref());
            (reader.join().unwrap_or_default(), cancelled)
        });
        let (err_text, cancelled) = stderr;
        let status = child.wait()?;
        let out = stdout.join().unwrap_or_default();
        Ok(Output { code: status.code().unwrap_or(-1), stdout: out, stderr: err_text, cancelled })
    }
}

/// Waits for git; kills it (and its job) on timeout or cancel. Returns whether it was stopped.
fn wait(child: &mut Child, timeout: Option<Duration>, cancel: Option<&Cancel>, job: Option<&job::Job>) -> bool {
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return false,
            Ok(None) => {}
            Err(_) => return false,
        }
        let cancelled = cancel.is_some_and(|c| c.load(Ordering::SeqCst));
        let timed_out = timeout.is_some_and(|t| start.elapsed() >= t);
        if cancelled || timed_out {
            if let Some(j) = job {
                j.terminate();
            }
            let _ = child.kill();
            return true;
        }
        thread::sleep(Duration::from_millis(20));
    }
}

fn read_stderr(pipe: &mut impl Read, on_line: Option<&(dyn Fn(&str) + Sync)>) -> String {
    let mut kept: Vec<u8> = Vec::new();
    let mut line: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        let n = match pipe.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        kept.extend_from_slice(&chunk[..n]);
        if kept.len() > STDERR_KEEP * 2 {
            kept.drain(..kept.len() - STDERR_KEEP);
        }
        if let Some(f) = on_line {
            for &b in &chunk[..n] {
                if b == b'\n' || b == b'\r' {
                    if !line.is_empty() {
                        f(String::from_utf8_lossy(&line).trim_end());
                        line.clear();
                    }
                } else {
                    line.push(b);
                }
            }
        }
    }
    if let (Some(f), false) = (on_line, line.is_empty()) {
        f(String::from_utf8_lossy(&line).trim_end());
    }
    if kept.len() > STDERR_KEEP {
        kept.drain(..kept.len() - STDERR_KEEP);
    }
    String::from_utf8_lossy(&kept).into_owned()
}

/// Paths given on the command line after `--`; long lists go through stdin
/// (`--pathspec-from-file`) to stay under Windows' command-line limit.
pub fn with_paths<'a>(call: Call<'a>, paths: &[String]) -> Call<'a> {
    if paths.len() > 100 {
        let mut stdin = Vec::new();
        for p in paths {
            stdin.extend_from_slice(p.as_bytes());
            stdin.push(0);
        }
        call.args(["--pathspec-from-file=-", "--pathspec-file-nul"]).stdin(stdin)
    } else {
        call.arg("--").args(paths.iter().map(OsString::from))
    }
}

/// A git object id or a ref name the user gave; never an option.
pub fn safe_rev(rev: &str) -> bool {
    !rev.is_empty() && !rev.starts_with('-') && rev.len() <= 255 && !rev.chars().any(|c| c.is_control() || c.is_whitespace())
}

#[cfg(windows)]
mod job {
    use std::os::windows::io::AsRawHandle;
    use std::process::Child;

    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject, TerminateJobObject,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    /// Owns a Job Object holding one git process tree.
    pub struct Job(HANDLE);

    // The handle is only used through the Win32 job APIs, which are thread-safe.
    unsafe impl Send for Job {}
    unsafe impl Sync for Job {}

    impl Job {
        pub fn attach(child: &Child) -> Option<Self> {
            // SAFETY: plain Win32 calls with valid arguments; the handle is
            // closed in Drop. A failure just means no tree kill.
            unsafe {
                let h = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if h.is_null() {
                    return None;
                }
                let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                SetInformationJobObject(
                    h,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const core::ffi::c_void,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                );
                if AssignProcessToJobObject(h, child.as_raw_handle() as HANDLE) == 0 {
                    CloseHandle(h);
                    return None;
                }
                Some(Job(h))
            }
        }

        pub fn terminate(&self) {
            // SAFETY: the handle is valid until Drop.
            unsafe {
                TerminateJobObject(self.0, 1);
            }
        }
    }

    impl Drop for Job {
        fn drop(&mut self) {
            // SAFETY: closing our own handle once.
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}

#[cfg(not(windows))]
mod job {
    use std::process::Child;

    pub struct Job;

    impl Job {
        pub fn attach(_child: &Child) -> Option<Self> {
            None
        }
        pub fn terminate(&self) {}
    }
}
