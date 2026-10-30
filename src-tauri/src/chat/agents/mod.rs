//! Native coding-agent runtimes. Each `EngineAdapter` speaks its runtime's
//! structured protocol (no terminal output is ever parsed) and reports a turn
//! as a stream of `AgentEvent`s; `turn` turns those into stored items and
//! `ChatEvent`s and answers approvals through `policy`.
//!
//! - `codex`: `codex app-server` (JSON-RPC over stdio), driven from Rust.
//! - `acp`: the Agent Client Protocol core, with one profile per runtime:
//!   `gemini` (`gemini --acp`, Gemini API key) and `antigravity` (Google's
//!   `agy_acp_server`, Google account), driven from Rust.
//! - `sidecar`: Claude Agent SDK and GitHub Copilot SDK, which need Node.js,
//!   run in one supervised Node child process (`sidecar/` in the repo).
//!
//! Runtimes are spawned with argument arrays, never shell strings, in the
//! project folder. Live processes are owned here, separate from terminals.

pub mod acp;
pub mod antigravity;
pub mod codex;
pub mod gemini;
pub mod jsonrpc;
pub mod sidecar;
pub mod turn;

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;

use super::engines::EngineProbe;
pub use super::images::ImageInput;
use super::{ChatError, Decision, Engine, ItemBody, ItemStatus, Mode, PermissionRequest, PlanStep, Policy, Tone, Usage};

/// Everything a runtime needs for one turn.
#[derive(Clone)]
pub struct TurnRequest {
    pub conversation_id: String,
    /// Unique per turn; correlates every event.
    pub turn_id: String,
    pub engine: Engine,
    /// `default` means the runtime's own default.
    pub model: String,
    pub mode: Mode,
    pub policy: Policy,
    /// Project root (agents never run in General).
    pub cwd: PathBuf,
    /// The user's message, with attached files already inlined.
    pub prompt: String,
    /// Images pasted into that message, as bytes (no runtime reads AgentHub's files).
    pub images: Vec<ImageInput>,
    /// Resume this runtime session if possible.
    pub runtime_session_id: Option<String>,
    /// Earlier turns as plain text. Prepended to the prompt only when the
    /// adapter has to start a fresh session although `runtime_session_id` was
    /// set (resume failed), so the agent isn't left without the conversation.
    pub handoff: Option<String>,
    /// The mode changed since the live session started: recreate it with the
    /// new permissions (resuming `runtime_session_id` when supported).
    pub reconfigure: bool,
    /// API key for runtimes that run on one (Anthropic for the Claude Agent
    /// SDK, Gemini for Gemini CLI). Goes only to the runtime's environment;
    /// never logged or sent to the frontend.
    pub api_key: Option<String>,
    /// Executable override from Settings › AI integrations.
    pub executable: Option<PathBuf>,
}

/// Normalized runtime events. `key` is the runtime's own id for an item, so
/// updates find the item they belong to.
pub enum AgentEvent {
    /// The runtime session id for this conversation (new or resumed).
    Session { id: String, resumed: bool },
    /// The stored session couldn't be resumed; a fresh one was started.
    ResumeFailed { message: String },
    Text { text: String },
    /// The current text block ended (tools follow); the next text starts a new block.
    TextBreak,
    Thinking { text: String },
    ItemStarted { key: String, status: ItemStatus, body: ItemBody },
    ItemUpdated { key: String, status: ItemStatus, body: ItemBody },
    Output { key: String, text: String },
    Plan { steps: Vec<PlanStep>, explanation: Option<String> },
    /// The runtime waits for an answer; `reply` must be called exactly once.
    Approval { key: String, request: PermissionRequest, reply: Reply },
    Usage(Usage),
    Notice { text: String, tone: Tone },
    /// Last event of every turn.
    Done(TurnOutcome),
}

pub type Reply = Box<dyn FnOnce(Decision) + Send>;

#[derive(Debug, Clone, PartialEq)]
pub enum TurnOutcome {
    Completed,
    Cancelled,
    Failed(ChatError),
}

pub type AgentSink = Arc<dyn Fn(AgentEvent) + Send + Sync>;

/// Lets adapters that perform writes themselves (ACP's `fs/write_text_file`)
/// take a checkpoint and check the policy first.
pub trait WriteGuard: Send + Sync {
    /// Called before a write to `path` (absolute). Returns once a checkpoint
    /// exists, or an error message when the write must not happen.
    fn before_write(&self, path: &Path) -> Result<(), String>;
    /// Whether a read of `path` is allowed in this turn's mode.
    fn may_read(&self, path: &Path) -> bool;
}

pub trait TurnHandle: Send + Sync {
    /// Stops the turn; the adapter still ends it with `Done(Cancelled)`.
    fn interrupt(&self);
}

pub trait EngineAdapter: Send + Sync {
    fn engine(&self) -> Engine;
    /// Detects executable, version, sign-in and models. Blocking; may spawn
    /// the runtime briefly. `api_key` is the stored key for runtimes that run
    /// on one. Never returns a secret.
    fn probe(&self, executable: Option<&Path>, api_key: Option<&str>) -> EngineProbe;
    /// Runs the runtime's own sign-in (e.g. Google in the browser) because the
    /// user asked for it. Blocking until it finished, failed or was cancelled.
    fn sign_in(&self, _executable: Option<&Path>) -> Result<(), ChatError> {
        Err(ChatError::new(super::ErrorKind::InvalidRequest, format!("{} doesn't sign in from AgentHub.", self.engine().label())))
    }
    /// Stops a running `sign_in`.
    fn cancel_sign_in(&self) {}
    /// Starts a turn and returns at once; events (ending with `Done`) follow on `sink`.
    fn start_turn(&self, req: TurnRequest, guard: Arc<dyn WriteGuard>, sink: AgentSink) -> Result<Box<dyn TurnHandle>, ChatError>;
    /// Ends the live runtime session of a conversation, if any.
    fn close_session(&self, conversation_id: &str);
    /// Ends every live process (app exit).
    fn shutdown(&self);
}

/// `Command` that never opens a console window on Windows.
pub fn command(program: &Path) -> Command {
    #[allow(unused_mut)]
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// Finds an executable on PATH (or the override). Windows `.cmd`/`.bat`
/// shims are rejected: they only run through cmd.exe, which isn't shell-free.
pub fn locate(name: &str, override_path: Option<&Path>) -> Option<PathBuf> {
    if let Some(p) = override_path.filter(|p| p.is_file()) {
        return Some(p.to_path_buf());
    }
    crate::terminals::shells::resolve_executable(name)
}

pub fn is_shell_shim(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("cmd") || e.eq_ignore_ascii_case("bat") || e.eq_ignore_ascii_case("ps1"))
}

/// The first line of `--version` output, if the program answers in time.
pub fn version_of(program: &Path, args: &[&str]) -> Option<String> {
    let out = command(program).args(args).stdin(std::process::Stdio::null()).output().ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    text.lines().map(str::trim).find(|l| !l.is_empty()).map(|l| l.chars().take(80).collect())
}

/// Prompt prefix for modes the runtime has no native switch for.
pub fn mode_instructions(mode: Mode) -> Option<&'static str> {
    match mode {
        Mode::Ask => Some(
            "AgentHub Ask mode: answer from the conversation and any attached files only. Don't read, search, edit or run anything; those requests will be denied.",
        ),
        Mode::Plan => Some(
            "AgentHub Plan mode: you may read and search files in this project to analyze it, but don't edit files or run commands (they will be denied). End with a numbered plan of milestones, then risks.",
        ),
        Mode::Agent => None,
    }
}
