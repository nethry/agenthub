//! Terminal session manager. The backend owns every PTY and child process;
//! the frontend only renders output and sends input. Sessions live in memory
//! only and survive project switches and hidden views.

pub mod activity;
pub mod shells;

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Weak};
use std::thread;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;

use crate::error::{now_ms, AppError, AppResult};
use activity::{Activity, ActivitySource, ActivityTracker};
use shells::ShellProfile;

/// Bytes of recent output kept per session so a re-created view can replay it.
const SCROLLBACK_BYTES: usize = 512 * 1024;
/// How often output-tracked sessions are checked for going quiet.
const ACTIVITY_TICK: Duration = Duration::from_millis(250);

/// Wraps the user's prompt (after their profile ran) to emit OSC 133 marks:
/// `D`+`A` before the prompt, `B` after it, `C` once a line is read. A fixed
/// constant with no double quotes, passed as one argv entry.
const PWSH_INTEGRATION: &str = "$global:__ahPrompt = $function:prompt; \
function global:prompt { $ok = $?; if (-not $ok) { Write-Error '' -ErrorAction Ignore }; \
$p = (& $global:__ahPrompt) -join ''; $e = [char]27; $b = [char]7; \
$e + ']133;D' + $b + $e + ']133;A' + $b + $p + $e + ']133;B' + $b }; \
if (Test-Path function:PSConsoleHostReadLine) { $global:__ahReadLine = $function:PSConsoleHostReadLine; \
function global:PSConsoleHostReadLine { $l = & $global:__ahReadLine; [Console]::Write([char]27 + ']133;C' + [char]7); $l } }";

static VERSION: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Serialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SessionStatus {
    Starting,
    Running,
    Exited,
    Failed,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub id: String,
    pub project_id: String,
    pub title: String,
    /// `shell`, `preset` or `custom`.
    pub kind: String,
    /// Human-readable command (display only, never executed).
    pub command_line: String,
    pub shell_label: String,
    pub cwd: String,
    pub status: SessionStatus,
    pub pid: Option<u32>,
    pub exit_code: Option<u32>,
    pub error: Option<String>,
    pub started_at: i64,
    pub exited_at: Option<i64>,
    pub preset_id: Option<String>,
    pub cols: u16,
    pub rows: u16,
    /// Busy/idle while running (`None` otherwise). See `activity.rs`.
    pub activity: Option<Activity>,
    pub activity_source: Option<ActivitySource>,
    /// Monotonic snapshot number; the frontend keeps the highest it has seen,
    /// since events and command replies can arrive out of order.
    pub version: u64,
}

/// What to run. Arguments are always kept as a list.
#[derive(Debug, Clone, Default)]
pub struct LaunchSpec {
    pub kind: String,
    /// Shell profile id for shells; `direct` or a profile id for commands.
    pub shell_id: String,
    pub executable: Option<String>,
    pub args: Vec<String>,
    /// Appended after `args` by AgentHub; not shown in the command line.
    pub extra_args: Vec<String>,
    pub env: Vec<(String, String)>,
    pub cwd: PathBuf,
    pub preset_id: Option<String>,
}

impl LaunchSpec {
    pub fn command_line(&self) -> String {
        match &self.executable {
            Some(exe) => std::iter::once(exe.as_str())
                .chain(self.args.iter().map(String::as_str))
                .collect::<Vec<_>>()
                .join(" "),
            None => self.shell_id.clone(),
        }
    }
}

/// Where session events go. Implemented for `AppHandle`; tests use a recorder.
pub trait EventSink: Send + Sync + 'static {
    fn output(&self, id: &str, data: &str);
    fn status(&self, info: &SessionInfo);
}

struct Session {
    info: SessionInfo,
    spec: LaunchSpec,
    master: Option<Box<dyn MasterPty + Send>>,
    writer: Option<Box<dyn Write + Send>>,
    killer: Option<Box<dyn ChildKiller + Send + Sync>>,
    buffer: Vec<u8>,
    /// Bumped on every (re)start so threads of a previous process are ignored.
    generation: u64,
    seq: u64,
    tracker: ActivityTracker,
}

impl Session {
    /// Copy the tracker's view into `info` while running; clear it otherwise.
    fn sync_activity(&mut self) {
        let running = self.info.status == SessionStatus::Running;
        self.info.activity = running.then(|| self.tracker.state());
        self.info.activity_source = running.then(|| self.tracker.source());
    }
}

struct Inner {
    sessions: Mutex<HashMap<String, Session>>,
    shells: Mutex<Vec<ShellProfile>>,
    sink: Box<dyn EventSink>,
    seq: Mutex<u64>,
}

#[derive(Clone)]
pub struct TerminalManager {
    inner: Arc<Inner>,
}

const DIM: &str = "\x1b[38;2;138;160;184m";
const ACCENT: &str = "\x1b[38;2;77;163;255m";
const DANGER: &str = "\x1b[38;2;255;84;112m";
const RESET: &str = "\x1b[0m";

impl TerminalManager {
    pub fn new(sink: impl EventSink, shells: Vec<ShellProfile>) -> Self {
        let inner = Arc::new(Inner {
            sessions: Mutex::new(HashMap::new()),
            shells: Mutex::new(shells),
            sink: Box::new(sink),
            seq: Mutex::new(0),
        });
        // One ticker for all sessions; stops once the manager is dropped.
        let weak: Weak<Inner> = Arc::downgrade(&inner);
        thread::spawn(move || loop {
            thread::sleep(ACTIVITY_TICK);
            let Some(inner) = weak.upgrade() else { break };
            let mgr = TerminalManager { inner };
            mgr.tick_activity();
        });
        Self { inner }
    }

    fn tick_activity(&self) {
        let now = Instant::now();
        let changed: Vec<String> = self
            .inner
            .sessions
            .lock()
            .values_mut()
            .filter(|s| s.info.status == SessionStatus::Running)
            .filter_map(|s| {
                s.tracker.tick(now)?;
                s.sync_activity();
                Some(s.info.id.clone())
            })
            .collect();
        for id in changed {
            self.emit_status(&id);
        }
    }

    pub fn shells(&self) -> Vec<ShellProfile> {
        self.inner.shells.lock().clone()
    }

    pub fn redetect_shells(&self) -> Vec<ShellProfile> {
        let detected = shells::detect();
        *self.inner.shells.lock() = detected.clone();
        detected
    }

    fn shell_label(&self, id: &str) -> String {
        if id == "direct" {
            return "DIRECT".into();
        }
        shells::find(&self.inner.shells.lock(), id)
            .map(|p| p.label.clone())
            .unwrap_or_else(|| id.to_uppercase())
    }

    pub fn spawn(
        &self,
        project_id: &str,
        title: String,
        spec: LaunchSpec,
        cols: u16,
        rows: u16,
    ) -> SessionInfo {
        let id = uuid::Uuid::new_v4().to_string();
        let seq = {
            let mut s = self.inner.seq.lock();
            *s += 1;
            *s
        };
        let info = SessionInfo {
            id: id.clone(),
            project_id: project_id.into(),
            title,
            kind: spec.kind.clone(),
            command_line: spec.command_line(),
            shell_label: self.shell_label(&spec.shell_id),
            cwd: spec.cwd.to_string_lossy().to_string(),
            status: SessionStatus::Starting,
            pid: None,
            exit_code: None,
            error: None,
            started_at: now_ms(),
            exited_at: None,
            preset_id: spec.preset_id.clone(),
            cols: cols.max(2),
            rows: rows.max(2),
            activity: None,
            activity_source: None,
            version: 0,
        };
        self.inner.sessions.lock().insert(
            id.clone(),
            Session {
                info,
                spec,
                master: None,
                writer: None,
                killer: None,
                buffer: Vec::new(),
                generation: 0,
                seq,
                tracker: ActivityTracker::default(),
            },
        );
        self.start(&id);
        self.info(&id).expect("session just inserted")
    }

    /// Snapshot a session's info, stamping the version while the lock is held
    /// so later snapshots always carry higher numbers.
    fn info(&self, id: &str) -> Option<SessionInfo> {
        let sessions = self.inner.sessions.lock();
        sessions.get(id).map(|s| {
            let mut info = s.info.clone();
            info.version = VERSION.fetch_add(1, Ordering::Relaxed) + 1;
            info
        })
    }

    /// (Re)start the process for an existing session record.
    fn start(&self, id: &str) {
        let Some((spec, size, generation)) = self.with_session(id, |s| {
            s.generation += 1;
            s.info.status = SessionStatus::Starting;
            s.info.exit_code = None;
            s.info.error = None;
            s.info.exited_at = None;
            s.info.pid = None;
            s.info.started_at = now_ms();
            s.tracker = ActivityTracker::default();
            s.sync_activity();
            let size = PtySize {
                rows: s.info.rows,
                cols: s.info.cols,
                pixel_width: 0,
                pixel_height: 0,
            };
            (s.spec.clone(), size, s.generation)
        }) else {
            return;
        };
        self.emit_status(id);

        let shells = self.shells();
        let result = build_command(&spec, &shells).and_then(|cmd| {
            let pair = native_pty_system()
                .openpty(size)
                .map_err(|e| format!("Could not create a terminal: {e}"))?;
            let child = pair
                .slave
                .spawn_command(cmd)
                .map_err(|e| format!("Could not start process: {e}"))?;
            drop(pair.slave);
            let reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
            let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
            Ok((pair.master, child, reader, writer))
        });

        let (master, mut child, reader, writer) = match result {
            Ok(parts) => parts,
            Err(message) => {
                self.with_session(id, |s| {
                    s.info.status = SessionStatus::Failed;
                    s.info.error = Some(message.clone());
                    s.info.exited_at = Some(now_ms());
                    s.sync_activity();
                });
                self.append(id, generation, &format!("{DANGER}✕ {message}{RESET}\r\n"));
                self.emit_status(id);
                return;
            }
        };

        let killer = child.clone_killer();
        let pid = child.process_id();
        let banner = self
            .with_session(id, |s| {
                s.master = Some(master);
                s.writer = Some(writer);
                s.killer = Some(killer);
                s.info.pid = pid;
                format!(
                    "{ACCENT}▸{RESET} {DIM}{} · {}{RESET}\r\n",
                    s.info.command_line, s.info.cwd
                )
            })
            .unwrap_or_default();
        self.append(id, generation, &banner);
        self.emit_status(id);

        // Reader: stream output to the frontend, decoding UTF-8 across chunk boundaries.
        let mgr = self.clone();
        let rid = id.to_string();
        thread::spawn(move || {
            let mut reader = reader;
            let mut buf = [0u8; 16 * 1024];
            let mut pending: Vec<u8> = Vec::new();
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        pending.extend_from_slice(&buf[..n]);
                        let text = take_utf8(&mut pending);
                        if !text.is_empty() {
                            mgr.on_output(&rid, generation, &text);
                        }
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(_) => break,
                }
            }
        });

        // Waiter: record the exit, then close the PTY so the reader finishes.
        let mgr = self.clone();
        let wid = id.to_string();
        thread::spawn(move || {
            let code = child.wait().ok().map(|s| s.exit_code());
            thread::sleep(Duration::from_millis(150));
            let parts = mgr.with_session(&wid, |s| {
                if s.generation != generation {
                    return None;
                }
                s.info.status = SessionStatus::Exited;
                s.info.exit_code = code;
                s.info.exited_at = Some(now_ms());
                s.info.pid = None;
                s.sync_activity();
                Some((s.master.take(), s.writer.take(), s.killer.take()))
            });
            if let Some(Some(parts)) = parts {
                drop(parts);
                let code = code.map(|c| c.to_string()).unwrap_or_else(|| "?".into());
                mgr.append(
                    &wid,
                    generation,
                    &format!("\r\n{DIM}▸ process exited · code {code}{RESET}\r\n"),
                );
                mgr.emit_status(&wid);
            }
        });

        // A process that stays quiet is still running; don't show STARTING forever.
        let mgr = self.clone();
        let tid = id.to_string();
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(1200));
            mgr.mark_running(&tid, generation);
        });
    }

    fn with_session<T>(&self, id: &str, f: impl FnOnce(&mut Session) -> T) -> Option<T> {
        self.inner.sessions.lock().get_mut(id).map(f)
    }

    fn emit_status(&self, id: &str) {
        if let Some(info) = self.info(id) {
            self.inner.sink.status(&info);
        }
    }

    fn mark_running(&self, id: &str, generation: u64) {
        let changed = self
            .with_session(id, |s| {
                if s.generation == generation && s.info.status == SessionStatus::Starting {
                    s.info.status = SessionStatus::Running;
                    s.sync_activity();
                    true
                } else {
                    false
                }
            })
            .unwrap_or(false);
        if changed {
            self.emit_status(id);
        }
    }

    /// Record output in the scrollback buffer and forward it.
    fn append(&self, id: &str, generation: u64, text: &str) {
        let ok = self
            .with_session(id, |s| {
                if s.generation != generation {
                    return false;
                }
                s.buffer.extend_from_slice(text.as_bytes());
                if s.buffer.len() > SCROLLBACK_BYTES {
                    let cut = s.buffer.len() - SCROLLBACK_BYTES;
                    s.buffer.drain(..cut);
                }
                true
            })
            .unwrap_or(false);
        if ok {
            self.inner.sink.output(id, text);
        }
    }

    fn on_output(&self, id: &str, generation: u64, text: &str) {
        self.mark_running(id, generation);
        let now = Instant::now();
        let changed = self
            .with_session(id, |s| {
                if s.generation != generation || s.info.status != SessionStatus::Running {
                    return false;
                }
                let changed = s.tracker.on_output(now, text).is_some();
                if changed {
                    s.sync_activity();
                }
                changed
            })
            .unwrap_or(false);
        self.append(id, generation, text);
        if changed {
            self.emit_status(id);
        }
    }

    pub fn list(&self) -> Vec<SessionInfo> {
        let sessions = self.inner.sessions.lock();
        let mut all: Vec<_> = sessions
            .values()
            .map(|s| {
                let mut info = s.info.clone();
                info.version = VERSION.fetch_add(1, Ordering::Relaxed) + 1;
                (s.seq, info)
            })
            .collect();
        all.sort_by_key(|(seq, _)| *seq);
        all.into_iter().map(|(_, i)| i).collect()
    }

    pub fn snapshot(&self, id: &str) -> AppResult<String> {
        self.with_session(id, |s| String::from_utf8_lossy(&s.buffer).to_string())
            .ok_or_else(not_found)
    }

    pub fn write(&self, id: &str, data: &str) -> AppResult<()> {
        let now = Instant::now();
        let (result, changed) = self
            .with_session(id, |s| {
                let result = match s.writer.as_mut() {
                    Some(w) => w
                        .write_all(data.as_bytes())
                        .and_then(|_| w.flush())
                        .map_err(AppError::from),
                    None => return (Ok(()), false),
                };
                let changed = s.info.status == SessionStatus::Running
                    && s.tracker.on_input(now, data).is_some();
                if changed {
                    s.sync_activity();
                }
                (result, changed)
            })
            .ok_or_else(not_found)?;
        if changed {
            self.emit_status(id);
        }
        result
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> AppResult<()> {
        if cols < 2 || rows < 2 {
            return Ok(());
        }
        self.with_session(id, |s| {
            s.info.cols = cols;
            s.info.rows = rows;
            s.tracker.on_resize(Instant::now());
            if let Some(m) = s.master.as_ref() {
                m.resize(PtySize {
                    rows,
                    cols,
                    pixel_width: 0,
                    pixel_height: 0,
                })
                .map_err(|e| AppError::Pty(e.to_string()))?;
            }
            Ok(())
        })
        .ok_or_else(not_found)?
    }

    pub fn rename(&self, id: &str, title: &str) -> AppResult<SessionInfo> {
        let title = title.trim();
        if title.is_empty() || title.chars().count() > 60 {
            return Err(AppError::Invalid("Session name must be 1–60 characters".into()));
        }
        self.with_session(id, |s| s.info.title = title.to_string())
            .ok_or_else(not_found)?;
        self.emit_status(id);
        self.info(id).ok_or_else(not_found)
    }

    pub fn restart(&self, id: &str, cols: u16, rows: u16) -> AppResult<SessionInfo> {
        let running = self
            .with_session(id, |s| {
                s.info.cols = cols.max(2);
                s.info.rows = rows.max(2);
                matches!(s.info.status, SessionStatus::Running | SessionStatus::Starting)
                    && s.killer.is_some()
            })
            .ok_or_else(not_found)?;
        if running {
            return Err(AppError::Invalid("Session is still running".into()));
        }
        let generation = self.with_session(id, |s| s.generation).unwrap_or(0);
        self.append(id, generation, &format!("\r\n{DIM}▸ restarting…{RESET}\r\n"));
        self.start(id);
        self.info(id).ok_or_else(not_found)
    }

    /// Terminate the process tree but keep the session record (status → exited).
    pub fn kill(&self, id: &str) -> AppResult<()> {
        let parts = self
            .with_session(id, |s| (s.info.pid, s.killer.take()))
            .ok_or_else(not_found)?;
        terminate(parts.0, parts.1);
        Ok(())
    }

    /// Terminate (if needed) and forget the session.
    pub fn close(&self, id: &str) -> AppResult<()> {
        let session = self.inner.sessions.lock().remove(id).ok_or_else(not_found)?;
        let Session {
            info,
            master,
            writer,
            killer,
            ..
        } = session;
        terminate(info.pid, killer);
        drop(writer);
        drop(master);
        Ok(())
    }

    pub fn close_project(&self, project_id: &str) {
        let ids: Vec<String> = self
            .inner
            .sessions
            .lock()
            .values()
            .filter(|s| s.info.project_id == project_id)
            .map(|s| s.info.id.clone())
            .collect();
        for id in ids {
            let _ = self.close(&id);
        }
    }

    pub fn close_all(&self) {
        let ids: Vec<String> = self.inner.sessions.lock().keys().cloned().collect();
        for id in ids {
            let _ = self.close(&id);
        }
    }
}

fn not_found() -> AppError {
    AppError::NotFound("Session not found".into())
}

/// Windows build number (e.g. 22631). xterm.js needs it to match ConPTY's
/// resize and reflow behavior, which changed in build 21376.
#[cfg(windows)]
pub fn windows_build() -> Option<u32> {
    #[repr(C)]
    struct OsVersionInfoW {
        size: u32,
        major: u32,
        minor: u32,
        build: u32,
        platform_id: u32,
        csd_version: [u16; 128],
    }
    #[link(name = "ntdll")]
    extern "system" {
        fn RtlGetVersion(info: *mut OsVersionInfoW) -> i32;
    }
    let mut info = OsVersionInfoW {
        size: std::mem::size_of::<OsVersionInfoW>() as u32,
        major: 0,
        minor: 0,
        build: 0,
        platform_id: 0,
        csd_version: [0; 128],
    };
    // SAFETY: `info` is a correctly sized OSVERSIONINFOW with `size` set.
    let status = unsafe { RtlGetVersion(&mut info) };
    (status == 0 && info.build > 0).then_some(info.build)
}

#[cfg(not(windows))]
pub fn windows_build() -> Option<u32> {
    None
}

fn terminate(pid: Option<u32>, killer: Option<Box<dyn ChildKiller + Send + Sync>>) {
    #[cfg(windows)]
    if let Some(pid) = pid {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        // Ends the whole tree (agents often spawn node/git children).
        let _ = std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .creation_flags(CREATE_NO_WINDOW)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
    }
    #[cfg(not(windows))]
    let _ = pid;
    if let Some(mut k) = killer {
        let _ = k.kill();
    }
}

/// Decode as much valid UTF-8 as possible, keeping an incomplete trailing
/// sequence in `pending` for the next chunk.
fn take_utf8(pending: &mut Vec<u8>) -> String {
    let mut out = String::new();
    loop {
        match std::str::from_utf8(pending) {
            Ok(s) => {
                out.push_str(s);
                pending.clear();
                return out;
            }
            Err(e) => {
                let valid = e.valid_up_to();
                out.push_str(std::str::from_utf8(&pending[..valid]).unwrap_or_default());
                match e.error_len() {
                    // Incomplete sequence at the end: wait for more bytes.
                    None => {
                        pending.drain(..valid);
                        return out;
                    }
                    Some(len) => {
                        out.push('\u{FFFD}');
                        pending.drain(..valid + len);
                    }
                }
            }
        }
    }
}

/// `cmd.exe` prompt with OSC 133 marks around the user's own `PROMPT`.
fn cmd_prompt(user: Option<String>) -> String {
    let base = user.filter(|p| !p.trim().is_empty()).unwrap_or_else(|| "$P$G".into());
    format!("$e]133;D$e\\$e]133;A$e\\{base}$e]133;B$e\\")
}

/// Turn a launch spec into a PTY command without ever building a shell string
/// from untrusted pieces. PowerShell gets single-quoted literals; `cmd.exe`
/// only accepts plain tokens.
fn build_command(spec: &LaunchSpec, profiles: &[ShellProfile]) -> Result<CommandBuilder, String> {
    let profile_path = |id: &str| -> Result<String, String> {
        shells::find(profiles, id)
            .and_then(|p| p.path.clone())
            .ok_or_else(|| format!("Shell profile \"{id}\" is not installed"))
    };

    // User args first, then AgentHub's own (e.g. Claude's --settings).
    let args: Vec<String> = spec.args.iter().chain(&spec.extra_args).cloned().collect();
    let mut cmd = match &spec.executable {
        None => {
            let path = profile_path(&spec.shell_id)?;
            let mut c = CommandBuilder::new(path);
            // Prompt markers for busy/idle; the user's profile file is untouched.
            if spec.shell_id == "pwsh" || spec.shell_id == "powershell" {
                c.args(["-NoLogo", "-NoExit", "-Command", PWSH_INTEGRATION]);
            } else if spec.shell_id == "cmd" {
                c.env("PROMPT", cmd_prompt(std::env::var("PROMPT").ok()));
            }
            c
        }
        Some(exe) if spec.shell_id == "wsl" => {
            let mut c = CommandBuilder::new(profile_path("wsl")?);
            c.arg("-e");
            c.arg(exe);
            c.args(&args);
            c
        }
        Some(exe) => {
            let resolved = shells::resolve_executable(exe)
                .ok_or_else(|| "Executable not found on PATH".to_string())?;
            let resolved_str = resolved.to_string_lossy().to_string();
            let via_shell = match spec.shell_id.as_str() {
                // npm-style .cmd shims can't be started directly with safe argv.
                "direct" if shells::is_batch_file(&resolved) => Some(
                    ["pwsh", "powershell"]
                        .into_iter()
                        .find(|id| profile_path(id).is_ok())
                        .unwrap_or("cmd"),
                ),
                "direct" => None,
                other => Some(other),
            };
            match via_shell {
                None => {
                    let mut c = CommandBuilder::new(resolved_str);
                    c.args(&args);
                    c
                }
                Some(ps @ ("pwsh" | "powershell")) => {
                    let mut script = format!("& {}", shells::ps_quote(&resolved_str));
                    for a in &args {
                        script.push(' ');
                        script.push_str(&shells::ps_quote(a));
                    }
                    script.push_str("; exit $LASTEXITCODE");
                    let mut c = CommandBuilder::new(profile_path(ps)?);
                    c.args(["-NoLogo", "-Command", &script]);
                    c
                }
                Some("cmd") => {
                    if !shells::cmd_safe(&resolved_str) || !args.iter().all(|a| shells::cmd_safe(a)) {
                        return Err("Command Prompt can't safely pass spaces or special characters. Use PowerShell or Direct.".into());
                    }
                    let mut c = CommandBuilder::new(profile_path("cmd")?);
                    c.args(["/d", "/c", &resolved_str]);
                    c.args(&args);
                    c
                }
                Some(sh) => {
                    // Unix shells: pass argv through `exec "$0" "$@"`, never interpolated.
                    let mut c = CommandBuilder::new(profile_path(sh)?);
                    c.args(["-lc", "exec \"$0\" \"$@\"", &resolved_str]);
                    c.args(&args);
                    c
                }
            }
        }
    };
    cmd.cwd(&spec.cwd);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TERM_PROGRAM", "AgentHub");
    for (k, v) in &spec.env {
        cmd.env(k, v);
    }
    Ok(cmd)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf8_split_across_chunks() {
        let bytes = "é✓".as_bytes();
        let mut pending = bytes[..1].to_vec();
        assert_eq!(take_utf8(&mut pending), "");
        pending.extend_from_slice(&bytes[1..3]);
        assert_eq!(take_utf8(&mut pending), "é");
        pending.extend_from_slice(&bytes[3..]);
        assert_eq!(take_utf8(&mut pending), "✓");
        assert!(pending.is_empty());
    }

    #[test]
    fn invalid_bytes_are_replaced() {
        let mut pending = vec![b'a', 0xFF, b'b'];
        assert_eq!(take_utf8(&mut pending), "a\u{FFFD}b");
    }

    #[cfg(windows)]
    #[test]
    fn reports_a_windows_10_or_later_build() {
        assert!(windows_build().is_some_and(|b| b >= 10240));
    }

    #[test]
    fn command_line_is_display_only() {
        let spec = LaunchSpec {
            kind: "preset".into(),
            shell_id: "direct".into(),
            executable: Some("pnpm".into()),
            args: vec!["test".into(), "--watch".into()],
            cwd: PathBuf::from("."),
            preset_id: None,
            ..Default::default()
        };
        assert_eq!(spec.command_line(), "pnpm test --watch");
    }

    #[derive(Default, Clone)]
    struct Recorder(Arc<Mutex<(String, Vec<SessionStatus>)>>);
    impl EventSink for Recorder {
        fn output(&self, _id: &str, data: &str) {
            self.0.lock().0.push_str(data);
        }
        fn status(&self, info: &SessionInfo) {
            self.0.lock().1.push(info.status);
        }
    }

    #[test]
    fn missing_executable_fails_cleanly() {
        let rec = Recorder::default();
        let mgr = TerminalManager::new(rec.clone(), shells::detect());
        let info = mgr.spawn(
            "p1",
            "Ghost".into(),
            LaunchSpec {
                kind: "custom".into(),
                shell_id: "direct".into(),
                executable: Some("definitely-not-a-real-agenthub-binary".into()),
                args: vec![],
                cwd: std::env::temp_dir(),
                preset_id: None,
                ..Default::default()
            },
            80,
            24,
        );
        assert_eq!(info.status, SessionStatus::Failed);
        assert_eq!(info.error.as_deref(), Some("Executable not found on PATH"));
        assert!(rec.0.lock().0.contains("not found"));
        mgr.close(&info.id).unwrap();
        assert!(mgr.list().is_empty());
    }

    #[test]
    fn runs_a_real_process_and_reports_exit() {
        let rec = Recorder::default();
        let profiles = shells::detect();
        let shell = shells::fallback_id(&profiles);
        let mgr = TerminalManager::new(rec.clone(), profiles);
        #[cfg(windows)]
        let (exe, args) = ("cmd.exe", vec!["/d".to_string(), "/c".into(), "echo".into(), "agenthub-ok".into()]);
        #[cfg(not(windows))]
        let (exe, args) = ("echo", vec!["agenthub-ok".to_string()]);
        let _ = shell;
        let info = mgr.spawn(
            "p1",
            "Echo".into(),
            LaunchSpec {
                kind: "custom".into(),
                shell_id: "direct".into(),
                executable: Some(exe.into()),
                args,
                cwd: std::env::temp_dir(),
                preset_id: None,
                ..Default::default()
            },
            80,
            24,
        );
        let mut answered = false;
        for _ in 0..100 {
            if mgr.list()[0].status == SessionStatus::Exited {
                break;
            }
            // ConPTY asks for the cursor position on start; xterm.js answers in the app.
            if !answered && mgr.snapshot(&info.id).unwrap().contains("\x1b[6n") {
                mgr.write(&info.id, "\x1b[1;1R").unwrap();
                answered = true;
            }
            thread::sleep(Duration::from_millis(50));
        }
        let done = mgr.list()[0].clone();
        assert_eq!(done.status, SessionStatus::Exited, "output: {}", rec.0.lock().0);
        assert_eq!(done.exit_code, Some(0));
        assert!(mgr.snapshot(&info.id).unwrap().contains("agenthub-ok"));
        mgr.close_all();
    }

    #[test]
    fn cmd_prompt_wraps_the_users_prompt() {
        assert_eq!(cmd_prompt(None), "$e]133;D$e\\$e]133;A$e\\$P$G$e]133;B$e\\");
        assert!(cmd_prompt(Some("$T $P$G".into())).contains("$e\\$T $P$G$e]"));
        assert!(cmd_prompt(Some("  ".into())).contains("$P$G"));
    }

    /// Poll a session until `done` holds, answering ConPTY's cursor-position query.
    fn wait_for(mgr: &TerminalManager, id: &str, secs: u64, done: impl Fn(&SessionInfo) -> bool) -> bool {
        let deadline = Instant::now() + Duration::from_secs(secs);
        let mut answered = 0;
        while Instant::now() < deadline {
            if mgr.list().iter().any(|s| s.id == id && done(s)) {
                return true;
            }
            let asks = mgr.snapshot(id).unwrap().matches("\x1b[6n").count();
            while answered < asks {
                mgr.write(id, "\x1b[1;1R").unwrap();
                answered += 1;
            }
            thread::sleep(Duration::from_millis(25));
        }
        false
    }

    #[cfg(windows)]
    #[test]
    fn plain_shell_reports_busy_then_idle_from_prompt_marks() {
        let profiles = shells::detect();
        let installed: Vec<&str> = ["pwsh", "powershell", "cmd"]
            .into_iter()
            .filter(|id| shells::find(&profiles, id).is_some_and(|p| p.path.is_some()))
            .collect();
        let mgr = TerminalManager::new(Recorder::default(), profiles);
        for shell in installed {
            check_prompt_marks(&mgr, shell);
        }
        mgr.close_all();
    }

    #[cfg(windows)]
    fn check_prompt_marks(mgr: &TerminalManager, shell: &str) {
        let info = mgr.spawn(
            "p1",
            "Shell".into(),
            LaunchSpec {
                kind: "shell".into(),
                shell_id: shell.into(),
                executable: None,
                args: vec![],
                cwd: std::env::temp_dir(),
                preset_id: None,
                ..Default::default()
            },
            120,
            30,
        );
        let at_prompt = |s: &SessionInfo| {
            s.activity_source == Some(ActivitySource::Shell) && s.activity == Some(Activity::Idle)
        };
        assert!(
            wait_for(mgr, &info.id, 30, at_prompt),
            "{shell}: no prompt marks; output: {:?}",
            mgr.snapshot(&info.id).unwrap()
        );
        let command = if shell == "cmd" {
            "ping -n 3 127.0.0.1 >nul\r"
        } else {
            "Start-Sleep -Milliseconds 1500\r"
        };
        mgr.write(&info.id, command).unwrap();
        assert!(
            wait_for(mgr, &info.id, 5, |s| s.activity == Some(Activity::Busy)),
            "{shell}: never busy"
        );
        assert!(wait_for(mgr, &info.id, 15, at_prompt), "{shell}: never idle again");
        mgr.close(&info.id).unwrap();
    }
}
