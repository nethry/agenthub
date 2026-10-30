//! Agent Client Protocol core (ACP protocol version 1, newline-delimited
//! JSON-RPC 2.0 over stdio), shared by the runtimes that speak it. A
//! `Profile` says how one runtime is found, started, signed in and which of
//! its session modes AgentHub may use; everything else lives here:
//!
//! - One process per conversation. Profiles whose model is fixed per process
//!   restart it on a model or mode change and `session/load` the same session
//!   (when they can be trusted to replay it); others switch model and mode on
//!   the live session. Session history replayed by `session/load` is never
//!   shown as new output: updates are ignored until the load answered and the
//!   stream has been quiet for `REPLAY_QUIET`.
//! - Modes: the session runs in the mode the profile picks, never one that
//!   approves on its own; a switch away from it is undone. Ask and Plan also
//!   get `mode_instructions`.
//! - The runtime routes reads and writes through `fs/read_text_file` /
//!   `fs/write_text_file`, which AgentHub checks with the turn's `WriteGuard`.
//!   `terminal/*` isn't offered.
//! - Every `session/request_permission` becomes an `AgentEvent::Approval`; the
//!   decision is mapped back to the runtime's option by its `kind`, never to a
//!   permanent ("save") option.
//! - Profiles that `verify_routing` have each finished tool call checked: one
//!   that edited, ran or (in Ask) read something without going through
//!   AgentHub ends the turn with an error instead of being trusted.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::thread;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde_json::{json, Value};

use super::jsonrpc::{Handler, Incoming, Peer, RpcError};
use super::{AgentEvent, AgentSink, EngineAdapter, Reply, TurnHandle, TurnOutcome, TurnRequest, WriteGuard};
use crate::chat::engines::{EngineProbe, ModelInfo, ProbeState};
use crate::chat::{
    redact, ChatError, Decision, Engine, ErrorKind, ItemBody, ItemStatus, Mode, PermissionKind, PermissionRequest, PlanStep, StepStatus,
    Tone, ToolKind, Usage,
};

const INIT_TIMEOUT: Duration = Duration::from_secs(90);
const SESSION_TIMEOUT: Duration = Duration::from_secs(180);
const SET_MODE_TIMEOUT: Duration = Duration::from_secs(15);
/// An explicit sign-in waits for the user to finish it in the browser.
const SIGN_IN_TIMEOUT: Duration = Duration::from_secs(5 * 60);
/// A turn can wait for the user's approvals for a long time.
const PROMPT_TIMEOUT: Duration = Duration::from_secs(7 * 24 * 3600);
/// Replayed history counts as finished once no update arrived for this long.
const REPLAY_QUIET: Duration = Duration::from_millis(300);
const REPLAY_MAX: Duration = Duration::from_secs(30);
/// After an interrupt, how long the runtime gets to end the prompt before the process is killed.
const CANCEL_GRACE: Duration = Duration::from_secs(10);
const MAX_READ_BYTES: u64 = 32 * 1024 * 1024;
const MAX_RESULT_CHARS: usize = 4000;

/// Runtimes treat a prompt starting with `/` or `$` (after trimming) as a
/// command. A zero-width space isn't trimmed by JavaScript, so it keeps the
/// text a plain prompt.
pub(super) const COMMAND_GUARD: char = '\u{200B}';

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

/// A session mode the runtime offers.
#[derive(Debug, Clone, PartialEq)]
pub(super) struct ModeInfo {
    pub id: String,
    pub name: String,
}

/// The session mode for an AgentHub mode; `fallback` is tried when the
/// runtime refuses `desired`.
#[derive(Debug, Clone, PartialEq)]
pub(super) struct ModeChoice {
    pub desired: String,
    pub fallback: Option<String>,
}

/// What a connection is started for.
pub(super) struct SpawnSpec<'a> {
    pub executable: Option<&'a Path>,
    pub model: &'a str,
    pub mode: Mode,
    pub cwd: &'a Path,
    /// Goes only to the child's environment.
    pub api_key: Option<&'a str>,
}

/// How one ACP runtime is found, started and signed in.
pub(super) trait Profile: Send + Sync + 'static {
    fn engine(&self) -> Engine;
    fn label(&self) -> &'static str {
        self.engine().label()
    }
    /// The executable that will run; the error says how to install it.
    fn locate(&self, executable: Option<&Path>) -> Result<PathBuf, ChatError>;
    fn version(&self, found: &Path) -> Option<String>;
    /// Starts the runtime for `spec` (argument arrays only, never a shell).
    fn spawn(&self, spec: &SpawnSpec, handler: Handler) -> Result<Arc<Peer>, ChatError>;
    /// The message for "not signed in"; `remote` is the runtime's own (redacted) text.
    fn not_signed_in(&self, remote: &str) -> String;
    /// A probe result that doesn't need the runtime started (e.g. a missing key).
    fn precheck(&self, _api_key: Option<&str>) -> Option<(ProbeState, String)> {
        None
    }
    /// The `authenticate` method to call right after `initialize`, if any.
    fn auth_method(&self, _init: &Value, _api_key: Option<&str>) -> Option<String> {
        None
    }
    /// The method for an explicit sign-in from Settings, if the runtime has one.
    fn sign_in_method(&self) -> Option<&'static str> {
        None
    }
    /// The session mode for `mode`. `Ok(None)`: the runtime offers no modes
    /// and its current one (if any) is fine. `Err`: no safe mode exists.
    fn pick_mode(&self, mode: Mode, modes: &[ModeInfo], current: Option<&str>) -> Result<Option<ModeChoice>, String>;
    /// Whether `session/load` restores the conversation (else a fresh
    /// session gets the recap).
    fn trust_session_load(&self) -> bool {
        true
    }
    /// Shown when a session couldn't be resumed because of `trust_session_load`.
    fn no_load_reason(&self) -> String {
        format!("this {} version can't load saved sessions", self.label())
    }
    /// Model and mode change on the live session (`session/set_model`,
    /// `session/set_mode`) instead of restarting the process.
    fn reconfigure_in_place(&self) -> bool {
        false
    }
    /// Check that finished tool calls went through AgentHub (see the module docs).
    fn verify_routing(&self) -> bool {
        false
    }
}

/// Starts a runtime process wired to `handler` (tests use an in-memory peer).
pub(super) type Connector = Arc<dyn Fn(&SpawnSpec, Handler) -> Result<Arc<Peer>, ChatError> + Send + Sync>;

/// `-m`/`session/set_model` value, if the conversation picked a model (and it can't be read as a flag).
pub(super) fn model_arg(model: &str) -> Option<&str> {
    let m = model.trim();
    (!m.is_empty() && m != "default" && !m.starts_with('-')).then_some(m)
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

pub(super) fn is_auth_error(code: i64, message: &str) -> bool {
    let m = message.to_ascii_lowercase();
    code == -32000
        || m.contains("authentication required")
        || m.contains("api key is missing")
        || m.contains("not authenticated")
        || m.contains("login required")
        || m.contains("no longer supported")
}

fn exited(p: &dyn Profile, peer: &Peer, when: &str) -> ChatError {
    let tail = redact(&peer.stderr_tail(8), None);
    let code = peer.exit_code().map(|c| format!(" (exit code {c})")).unwrap_or_default();
    let mut msg = format!("{} exited {when}{code}.", p.label());
    if !tail.trim().is_empty() {
        msg.push_str("\n\n");
        msg.push_str(tail.trim());
    }
    ChatError::new(ErrorKind::RuntimeExited, msg)
}

/// `prefix` starts the message of a runtime error; `secret` is the API key
/// the runtime was given, never shown.
fn rpc_failure(p: &dyn Profile, e: RpcError, peer: &Peer, when: &str, prefix: &str, secret: Option<&str>) -> ChatError {
    match e {
        RpcError::Closed | RpcError::Io(_) => exited(p, peer, when),
        RpcError::Timeout => ChatError::new(ErrorKind::Timeout, format!("{} didn't answer in time.", p.label())),
        RpcError::Remote { code, message, .. } => {
            let msg = redact(&message, secret);
            if is_auth_error(code, &msg) || code == 401 {
                return ChatError::new(ErrorKind::NotSignedIn, p.not_signed_in(&msg));
            }
            let lower = msg.to_ascii_lowercase();
            let kind = match code {
                429 => ErrorKind::RateLimited,
                _ if lower.contains("quota") || lower.contains("rate limit") => ErrorKind::RateLimited,
                403 => ErrorKind::PermissionDenied,
                400 => ErrorKind::InvalidRequest,
                404 => ErrorKind::ModelUnavailable,
                503 => ErrorKind::Overloaded,
                _ => ErrorKind::ProviderError,
            };
            let text = if kind == ErrorKind::RateLimited {
                format!("{} hit a rate limit or quota: {msg}", p.label())
            } else {
                format!("{prefix}: {msg}")
            };
            let err = ChatError::new(kind, text);
            match u16::try_from(code) {
                Ok(status) if (400..600).contains(&status) => err.with_status(status),
                _ => err,
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Protocol translation (pure)
// ---------------------------------------------------------------------------

fn block_text(block: &Value) -> Option<&str> {
    (block["type"] == "text").then(|| block["text"].as_str()).flatten()
}

/// Text of a tool call's `content` list (`{type:"content", content:{type:"text"}}` entries).
fn tool_texts(content: &Value) -> String {
    content
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter(|c| c["type"] == "content")
                .filter_map(|c| block_text(&c["content"]))
                .filter(|t| !t.trim().is_empty())
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
}

fn absolute(p: &str, cwd: &Path) -> String {
    let path = Path::new(p);
    if path.is_absolute() {
        p.to_string()
    } else {
        cwd.join(path).to_string_lossy().to_string()
    }
}

/// Every path a tool call names: `locations[].path` and diff `path`s, absolute.
fn tool_paths(tool: &Value, cwd: &Path) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let locs = tool["locations"].as_array().into_iter().flatten().filter_map(|l| l["path"].as_str());
    let diffs = tool["content"].as_array().into_iter().flatten().filter(|c| c["type"] == "diff").filter_map(|c| c["path"].as_str());
    for p in locs.chain(diffs) {
        let abs = absolute(p, cwd);
        if !out.contains(&abs) {
            out.push(abs);
        }
    }
    out
}

fn display_path(p: &str, cwd: &Path) -> String {
    Path::new(p).strip_prefix(cwd).map(|r| r.to_string_lossy().replace('\\', "/")).unwrap_or_else(|_| p.to_string())
}

/// The MCP details a runtime attaches under its own `_meta` key
/// (`_meta["gemini-cli"].mcp` for Gemini CLI).
fn mcp_meta(tool: &Value) -> Option<&Value> {
    tool["_meta"].as_object()?.values().find_map(|v| v.get("mcp").filter(|m| m.is_object()))
}

fn is_mcp(tool: &Value) -> bool {
    mcp_meta(tool).is_some()
}

fn tool_kind(kind: &str, mcp: bool) -> ToolKind {
    if mcp {
        return ToolKind::Mcp;
    }
    match kind {
        "read" => ToolKind::Read,
        "edit" => ToolKind::Edit,
        "delete" => ToolKind::Delete,
        "move" => ToolKind::Move,
        "search" => ToolKind::Search,
        "execute" => ToolKind::Run,
        "think" => ToolKind::Think,
        "fetch" => ToolKind::Fetch,
        _ => ToolKind::Other,
    }
}

fn truncate(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let mut s: String = text.chars().take(max).collect();
    s.push('…');
    s
}

/// Removes ANSI escape sequences (CSI, OSC and two-byte escapes).
fn strip_ansi(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\u{1b}' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('[') => {
                for n in chars.by_ref() {
                    if ('\u{40}'..='\u{7e}').contains(&n) {
                        break;
                    }
                }
            }
            Some(']') => {
                while let Some(n) = chars.next() {
                    if n == '\u{7}' {
                        break;
                    }
                    if n == '\u{1b}' {
                        chars.next();
                        break;
                    }
                }
            }
            _ => {}
        }
    }
    out
}

#[derive(Debug, Clone, PartialEq)]
struct PermOption {
    id: String,
    name: String,
    kind: String,
}

fn parse_options(v: &Value) -> Vec<PermOption> {
    v.as_array()
        .into_iter()
        .flatten()
        .filter_map(|o| {
            Some(PermOption {
                id: o["optionId"].as_str()?.to_string(),
                name: o["name"].as_str().unwrap_or("").to_string(),
                kind: o["kind"].as_str().unwrap_or("").to_string(),
            })
        })
        .collect()
}

/// The plain "allow for this session" option: never a permanent ("save",
/// "future sessions") one, nor a server- or tool-wide MCP grant.
fn session_option(options: &[PermOption]) -> Option<&PermOption> {
    options.iter().find(|o| {
        let text = format!("{} {}", o.id, o.name).to_ascii_lowercase();
        o.kind == "allow_always" && !["save", "future", "permanent", "server", "tool"].iter().any(|w| text.contains(w))
    })
}

/// The runtime's option for an AgentHub decision; `None` answers "cancelled".
fn choose_option(options: &[PermOption], decision: Decision) -> Option<String> {
    let by_kind = |k: &str| options.iter().find(|o| o.kind == k).map(|o| o.id.clone());
    match decision {
        Decision::AllowOnce => by_kind("allow_once"),
        Decision::AllowSession => session_option(options).map(|o| o.id.clone()).or_else(|| by_kind("allow_once")),
        Decision::Deny => by_kind("reject_once"),
        Decision::Cancel => None,
    }
}

fn permission_request(tool: &Value, options: &[PermOption], cwd: &Path) -> PermissionRequest {
    let kind_str = tool["kind"].as_str().unwrap_or("other");
    let mcp = is_mcp(tool);
    let kind = if mcp {
        PermissionKind::Mcp
    } else {
        match kind_str {
            "read" => PermissionKind::Read,
            "edit" | "move" => PermissionKind::Write,
            "delete" => PermissionKind::Delete,
            "execute" => PermissionKind::Command,
            "fetch" => PermissionKind::Network,
            _ => PermissionKind::Other,
        }
    };
    let text = tool_texts(&tool["content"]);
    let title = tool["title"].as_str().map(str::trim).filter(|t| !t.is_empty()).map(str::to_string);
    let title = title.unwrap_or_else(|| {
        match kind {
            PermissionKind::Read => "Read a file",
            PermissionKind::Write => "Edit a file",
            PermissionKind::Delete => "Delete a file",
            PermissionKind::Command => "Run a command",
            PermissionKind::Network => "Fetch a URL",
            PermissionKind::Mcp => "Use an MCP tool",
            PermissionKind::Other => "Use a tool",
        }
        .to_string()
    });
    // Shell tools title the call with the command itself; its content is context.
    let command = (kind == PermissionKind::Command).then(|| {
        let t = tool["title"].as_str().map(str::trim).unwrap_or("");
        if t.is_empty() { text.clone() } else { t.to_string() }
    });
    let mut detail = (!text.is_empty()).then(|| truncate(&text, MAX_RESULT_CHARS));
    if let Some(m) = mcp_meta(tool) {
        let server = m["server_name"].as_str().unwrap_or("?");
        let name = m["tool_name"].as_str().unwrap_or("?");
        let line = format!("MCP server \"{server}\", tool \"{name}\"");
        detail = Some(match detail {
            Some(d) => format!("{line}\n{d}"),
            None => line,
        });
    }
    let paths = tool_paths(tool, cwd);
    PermissionRequest {
        kind,
        title,
        command,
        path: paths.first().cloned(),
        paths,
        detail,
        can_allow_session: session_option(options).is_some(),
    }
}

fn usage_of(v: &Value) -> Option<Usage> {
    let input = v["inputTokens"].as_u64();
    let output = v["outputTokens"].as_u64();
    if input.unwrap_or(0) == 0 && output.unwrap_or(0) == 0 {
        return None;
    }
    Some(Usage { input_tokens: input, output_tokens: output, cost_usd: None })
}

/// A mode switch reported by the runtime: `current_mode_update`, or Gemini
/// CLI's `[MODE_UPDATE] <mode>` message chunk.
fn mode_change(update: &Value) -> Option<String> {
    match update["sessionUpdate"].as_str()? {
        "current_mode_update" => update["currentModeId"].as_str().map(str::to_string),
        "agent_message_chunk" => block_text(&update["content"])?.strip_prefix("[MODE_UPDATE]").map(|m| m.trim().to_string()),
        _ => None,
    }
}

struct ToolState {
    kind: String,
    title: String,
    paths: Vec<String>,
    mcp: bool,
    declined: bool,
}

/// Turns `session/update`s of one turn into `AgentEvent`s.
#[derive(Default)]
struct Stream {
    text_open: bool,
    thinking_open: bool,
    tools: HashMap<String, ToolState>,
}

impl Stream {
    fn translate(&mut self, update: &Value, cwd: &Path) -> Vec<AgentEvent> {
        match update["sessionUpdate"].as_str().unwrap_or("") {
            "agent_message_chunk" => {
                let Some(text) = block_text(&update["content"]).filter(|t| !t.is_empty()) else { return vec![] };
                if text.starts_with("[MODE_UPDATE]") {
                    return vec![];
                }
                self.thinking_open = false;
                self.text_open = true;
                vec![AgentEvent::Text { text: text.to_string() }]
            }
            "agent_thought_chunk" => {
                let Some(text) = block_text(&update["content"]).filter(|t| !t.is_empty()) else { return vec![] };
                // Each chunk is a whole thought; keep them apart.
                let text = if self.thinking_open { format!("\n\n{text}") } else { text.to_string() };
                self.thinking_open = true;
                vec![AgentEvent::Thinking { text }]
            }
            "tool_call" | "tool_call_update" => self.tool(update, cwd),
            "plan" => {
                let steps = update["entries"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|e| {
                        Some(PlanStep {
                            text: e["content"].as_str()?.to_string(),
                            status: match e["status"].as_str() {
                                Some("completed") => StepStatus::Completed,
                                Some("in_progress") => StepStatus::InProgress,
                                _ => StepStatus::Pending,
                            },
                        })
                    })
                    .collect();
                vec![AgentEvent::Plan { steps, explanation: None }]
            }
            // user_message_chunk (replay), available_commands_update, usage_update, ...
            _ => vec![],
        }
    }

    /// Makes sure a tool call has an item (a permission request may come first).
    fn ensure_tool(&mut self, tool: &Value, cwd: &Path) -> Vec<AgentEvent> {
        match tool["toolCallId"].as_str() {
            Some(id) if !self.tools.contains_key(id) => self.tool(tool, cwd),
            _ => vec![],
        }
    }

    fn decline(&mut self, key: &str) {
        if let Some(t) = self.tools.get_mut(key) {
            t.declined = true;
        }
    }

    fn tool(&mut self, update: &Value, cwd: &Path) -> Vec<AgentEvent> {
        let Some(id) = update["toolCallId"].as_str() else { return vec![] };
        let is_new = !self.tools.contains_key(id);
        let st = self.tools.entry(id.to_string()).or_insert_with(|| ToolState {
            kind: "other".into(),
            title: String::new(),
            paths: vec![],
            mcp: false,
            declined: false,
        });
        if let Some(k) = update["kind"].as_str() {
            st.kind = k.to_string();
        }
        if let Some(t) = update["title"].as_str().map(str::trim).filter(|t| !t.is_empty()) {
            st.title = t.to_string();
        }
        for p in tool_paths(update, cwd) {
            if !st.paths.contains(&p) {
                st.paths.push(p);
            }
        }
        st.mcp |= is_mcp(update);
        let status = match update["status"].as_str() {
            Some("completed") => ItemStatus::Completed,
            Some("failed") if st.declined => ItemStatus::Declined,
            Some("failed") => ItemStatus::Failed,
            _ => ItemStatus::Running,
        };
        let finished = matches!(status, ItemStatus::Completed | ItemStatus::Failed | ItemStatus::Declined);
        let text = tool_texts(&update["content"]);
        let body = if st.kind == "execute" {
            ItemBody::Command {
                command: if st.title.is_empty() { "command".into() } else { st.title.clone() },
                cwd: Some(cwd.to_string_lossy().to_string()),
                output: if finished { strip_ansi(&text) } else { String::new() },
                exit_code: None,
                duration_ms: None,
            }
        } else {
            let detail = st.paths.iter().map(|p| display_path(p, cwd)).collect::<Vec<_>>().join("\n");
            ItemBody::Tool {
                tool: tool_kind(&st.kind, st.mcp),
                title: if st.title.is_empty() { "Tool call".into() } else { st.title.clone() },
                detail: (!detail.is_empty()).then_some(detail),
                result: (finished && !text.is_empty()).then(|| truncate(&strip_ansi(&text), MAX_RESULT_CHARS)),
            }
        };
        let key = id.to_string();
        if is_new {
            let mut out = Vec::new();
            if self.text_open {
                out.push(AgentEvent::TextBreak);
                self.text_open = false;
            }
            self.thinking_open = false;
            out.push(AgentEvent::ItemStarted { key, status, body });
            out
        } else {
            vec![AgentEvent::ItemUpdated { key, status, body }]
        }
    }
}

/// The text sent as the prompt: mode rules, the recap when the session was
/// lost, then the user's message; never parsed as a runtime command.
fn prompt_text(req: &TurnRequest, with_handoff: bool) -> String {
    let mut body = String::new();
    if with_handoff {
        if let Some(h) = &req.handoff {
            body.push_str(h);
        }
    }
    body.push_str(&req.prompt);
    let text = match super::mode_instructions(req.mode) {
        Some(i) => format!("{i}\n\n{body}"),
        None => body,
    };
    let trimmed = text.trim_start();
    if trimmed.starts_with('/') || trimmed.starts_with('$') {
        format!("{COMMAND_GUARD}{trimmed}")
    } else {
        text
    }
}

fn read_text(path: &Path, line: Option<u64>, limit: Option<u64>) -> Result<String, (i64, String)> {
    let meta = match std::fs::metadata(path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err((-32002, format!("ENOENT: no such file or directory, open '{}'", path.display())));
        }
        Err(e) => return Err((-32603, format!("Couldn't read {}: {e}", path.display()))),
    };
    if meta.is_dir() {
        return Err((-32603, format!("EISDIR: illegal operation on a directory, read '{}'", path.display())));
    }
    if meta.len() > MAX_READ_BYTES {
        return Err((-32603, format!("{} is too large to read ({} bytes)", path.display(), meta.len())));
    }
    let bytes = std::fs::read(path).map_err(|e| (-32603, format!("Couldn't read {}: {e}", path.display())))?;
    let text = String::from_utf8_lossy(&bytes).into_owned();
    if line.is_none() && limit.is_none() {
        return Ok(text);
    }
    let skip = line.unwrap_or(1).max(1) - 1;
    let lines = text.split_inclusive('\n').skip(usize::try_from(skip).unwrap_or(usize::MAX));
    Ok(match limit {
        Some(n) => lines.take(usize::try_from(n).unwrap_or(usize::MAX)).collect(),
        None => lines.collect(),
    })
}

fn read_denied(mode: Mode, path: &Path) -> String {
    let why = match mode {
        Mode::Ask => "Ask mode has no file access",
        Mode::Plan => "Plan mode only reads files inside the project",
        Mode::Agent => "it's outside the project folder",
    };
    format!("Reading {} was denied by AgentHub ({why}).", path.display())
}

fn cancelled_outcome() -> Value {
    json!({ "outcome": { "outcome": "cancelled" } })
}

/// What went through AgentHub in one turn, to check finished tool calls against.
#[derive(Default)]
struct Routing {
    /// Tool calls whose permission request was allowed (by the user or the policy).
    allowed: HashSet<String>,
    /// Files written through `fs/write_text_file`, and how many writes there were.
    written: HashSet<String>,
    writes: usize,
    /// The write count when each tool call was first seen.
    seen_at: HashMap<String, usize>,
    /// Tool calls already warned about.
    warned: HashSet<String>,
}

enum Check {
    Violation(&'static str),
    /// An allowed change that didn't go through `fs/write_text_file`; the tool's title.
    Unchecked(String),
}

/// Compares paths from tool calls and `fs/*` requests regardless of separators
/// (and case on Windows).
fn path_key(p: &str) -> String {
    let s = p.replace('\\', "/");
    if cfg!(windows) {
        s.to_lowercase()
    } else {
        s
    }
}

fn outside(paths: &[String], cwd: &Path) -> bool {
    paths.iter().any(|p| !Path::new(p).starts_with(cwd))
}

/// What a finished tool call did without AgentHub that the turn's mode
/// doesn't allow, if anything. `allowed`: its permission request was
/// allowed; `routed`: it wrote through `fs/write_text_file`.
fn routing_violation(mode: Mode, tool: &ToolState, allowed: bool, routed: bool, cwd: &Path) -> Option<&'static str> {
    if tool.mcp {
        return (!allowed).then_some("used an MCP tool");
    }
    let read_like = match tool.kind.as_str() {
        "read" => Some("read files"),
        "search" => Some("searched files"),
        "fetch" => Some("fetched a URL"),
        _ => None,
    };
    if let Some(what) = read_like {
        if allowed {
            return None;
        }
        if mode == Mode::Ask {
            return Some(what);
        }
        return (tool.kind != "fetch" && outside(&tool.paths, cwd)).then_some("read files outside the project");
    }
    match tool.kind.as_str() {
        "edit" if !allowed && !routed => Some("edited files"),
        "move" if !allowed && !routed => Some("moved files"),
        "delete" if !allowed => Some("deleted files"),
        "execute" if !allowed => Some("ran a command"),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Live state
// ---------------------------------------------------------------------------

/// One turn's state, shared by the turn thread, the reader thread and the handle.
struct TurnCtx {
    label: &'static str,
    mode: Mode,
    cwd: PathBuf,
    verify_routing: bool,
    routing: Mutex<Routing>,
    /// Set when a tool call bypassed AgentHub; the turn fails with it.
    violation: Mutex<Option<ChatError>>,
    guard: Arc<dyn WriteGuard>,
    sink: AgentSink,
    peer: Mutex<Option<Arc<Peer>>>,
    session_id: Mutex<Option<String>>,
    /// Updates are forwarded (false while a loaded session replays history).
    live: AtomicBool,
    prompting: AtomicBool,
    cancelled: AtomicBool,
    cancel_sent: AtomicBool,
    cancelled_at: Mutex<Option<Instant>>,
    done: AtomicBool,
    stream: Mutex<Stream>,
    /// Permission requests not answered yet, by JSON-RPC id.
    pending: Mutex<HashMap<String, Value>>,
}

impl TurnCtx {
    fn new(p: &dyn Profile, req: &TurnRequest, guard: Arc<dyn WriteGuard>, sink: AgentSink) -> Self {
        Self {
            label: p.label(),
            mode: req.mode,
            cwd: req.cwd.clone(),
            verify_routing: p.verify_routing(),
            routing: Mutex::new(Routing::default()),
            violation: Mutex::new(None),
            guard,
            sink,
            peer: Mutex::new(None),
            session_id: Mutex::new(None),
            live: AtomicBool::new(false),
            prompting: AtomicBool::new(false),
            cancelled: AtomicBool::new(false),
            cancel_sent: AtomicBool::new(false),
            cancelled_at: Mutex::new(None),
            done: AtomicBool::new(false),
            stream: Mutex::new(Stream::default()),
            pending: Mutex::new(HashMap::new()),
        }
    }

    fn emit(&self, ev: AgentEvent) {
        if !self.done.load(Ordering::SeqCst) {
            (self.sink)(ev);
        }
    }

    fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }

    fn mark_cancelled(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
        self.cancelled_at.lock().get_or_insert_with(Instant::now);
    }

    fn cancel_expired(&self) -> bool {
        self.cancelled_at.lock().is_some_and(|t| t.elapsed() >= CANCEL_GRACE)
    }

    fn send_cancel(&self, peer: &Peer) {
        let sid = self.session_id.lock().clone();
        if let Some(sid) = sid {
            if !self.cancel_sent.swap(true, Ordering::SeqCst) {
                let _ = peer.notify("session/cancel", json!({ "sessionId": sid }));
            }
        }
    }

    fn answer_pending_cancelled(&self, peer: &Peer) {
        let ids: Vec<Value> = self.pending.lock().drain().map(|(_, v)| v).collect();
        for id in ids {
            let _ = peer.respond(id, cancelled_outcome());
        }
    }

    fn interrupt(&self) {
        self.mark_cancelled();
        let peer = self.peer.lock().clone();
        let Some(peer) = peer else { return };
        self.answer_pending_cancelled(&peer);
        if self.prompting.load(Ordering::SeqCst) {
            self.send_cancel(&peer);
        } else {
            // Still starting: nothing to keep, so stop the process.
            peer.kill();
        }
    }

    fn finish(&self, outcome: TurnOutcome) {
        if self.done.swap(true, Ordering::SeqCst) {
            return;
        }
        self.live.store(false, Ordering::SeqCst);
        if let Some(peer) = self.peer.lock().clone() {
            self.answer_pending_cancelled(&peer);
        }
        (self.sink)(AgentEvent::Done(outcome));
    }

    fn on_update(&self, update: &Value) {
        let (events, check) = {
            let mut stream = self.stream.lock();
            let events = stream.translate(update, &self.cwd);
            let check = self.verify_routing.then(|| self.check_routing(&stream, update)).flatten();
            (events, check)
        };
        for e in events {
            self.emit(e);
        }
        match check {
            Some(Check::Violation(what)) => self.stop_for(what),
            Some(Check::Unchecked(title)) => self.emit(AgentEvent::Notice {
                text: format!(
                    "{} changed files itself for \"{title}\" instead of through AgentHub, so there's no checkpoint and AgentHub can't revert that change.",
                    self.label
                ),
                tone: Tone::Warn,
            }),
            None => {}
        }
    }

    /// Records a tool call's first sighting and judges it once it finished.
    fn check_routing(&self, stream: &Stream, update: &Value) -> Option<Check> {
        if !matches!(update["sessionUpdate"].as_str(), Some("tool_call" | "tool_call_update")) {
            return None;
        }
        let id = update["toolCallId"].as_str()?;
        let tool = stream.tools.get(id)?;
        let mut r = self.routing.lock();
        let writes = r.writes;
        let seen_at = *r.seen_at.entry(id.to_string()).or_insert(writes);
        if update["status"].as_str() != Some("completed") {
            return None;
        }
        let allowed = r.allowed.contains(id);
        let routed = if tool.paths.is_empty() { r.writes > seen_at } else { tool.paths.iter().any(|p| r.written.contains(&path_key(p))) };
        if let Some(what) = routing_violation(self.mode, tool, allowed, routed, &self.cwd) {
            return Some(Check::Violation(what));
        }
        let changes = matches!(tool.kind.as_str(), "edit" | "move");
        (changes && !routed && r.warned.insert(id.to_string())).then(|| Check::Unchecked(tool.title.clone()))
    }

    /// Ends the turn because the runtime acted on its own.
    fn stop_for(&self, what: &str) {
        let label = self.label;
        let err = ChatError::new(
            ErrorKind::PermissionDenied,
            format!(
                "{label} {what} without asking AgentHub, so AgentHub stopped this turn. {label}'s own permission settings allowed it; AgentHub can't enforce this chat's mode while they do."
            ),
        );
        self.violation.lock().get_or_insert(err);
        self.mark_cancelled();
        if let Some(peer) = self.peer.lock().clone() {
            self.answer_pending_cancelled(&peer);
            self.send_cancel(&peer);
        }
    }

    fn on_permission(self: &Arc<Self>, peer: &Arc<Peer>, id: Value, params: &Value) {
        if self.done.load(Ordering::SeqCst) || self.is_cancelled() {
            let _ = peer.respond(id, cancelled_outcome());
            return;
        }
        let tool = &params["toolCall"];
        let key = tool["toolCallId"].as_str().unwrap_or("permission").to_string();
        let options = parse_options(&params["options"]);
        let request = permission_request(tool, &options, &self.cwd);
        let pre = self.stream.lock().ensure_tool(tool, &self.cwd);
        {
            let mut r = self.routing.lock();
            let writes = r.writes;
            r.seen_at.entry(key.clone()).or_insert(writes);
        }
        for e in pre {
            self.emit(e);
        }
        self.pending.lock().insert(id.to_string(), id.clone());
        let ctx = Arc::clone(self);
        let p = Arc::clone(peer);
        let k = key.clone();
        let reply: Reply = Box::new(move |decision| ctx.answer(&p, &id, &k, &options, decision));
        (self.sink)(AgentEvent::Approval { key, request, reply });
    }

    fn answer(&self, peer: &Peer, id: &Value, key: &str, options: &[PermOption], decision: Decision) {
        if self.pending.lock().remove(&id.to_string()).is_none() {
            return; // already answered (interrupt or turn end)
        }
        let outcome = match choose_option(options, decision) {
            Some(option) => json!({ "outcome": { "outcome": "selected", "optionId": option } }),
            None => cancelled_outcome(),
        };
        if decision.allows() {
            self.routing.lock().allowed.insert(key.to_string());
        } else {
            self.stream.lock().decline(key);
        }
        let _ = peer.respond(id.clone(), outcome);
        if decision == Decision::Cancel {
            self.mark_cancelled();
            self.send_cancel(peer);
        }
    }

    fn fs(&self, method: &str, params: &Value) -> Result<Value, (i64, String)> {
        let raw = params["path"].as_str().ok_or((-32602, "Missing path".to_string()))?;
        let path = PathBuf::from(raw);
        if !path.is_absolute() {
            return Err((-32602, format!("AgentHub only accepts absolute paths ({raw})")));
        }
        if method == "fs/read_text_file" {
            if !self.guard.may_read(&path) {
                return Err((-32000, read_denied(self.mode, &path)));
            }
            return read_text(&path, params["line"].as_u64(), params["limit"].as_u64()).map(|c| json!({ "content": c }));
        }
        let content = params["content"].as_str().ok_or((-32602, "Missing content".to_string()))?;
        self.guard.before_write(&path).map_err(|m| (-32000, format!("Writing {} was denied by AgentHub: {m}", path.display())))?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| (-32603, format!("Couldn't create {}: {e}", parent.display())))?;
        }
        std::fs::write(&path, content).map_err(|e| (-32603, format!("Couldn't write {}: {e}", path.display())))?;
        let mut r = self.routing.lock();
        r.written.insert(path_key(raw));
        r.writes += 1;
        Ok(json!({}))
    }
}

/// Routes one process's incoming messages to the turn that is running on it.
struct Router {
    turn: Mutex<Option<Arc<TurnCtx>>>,
    last_update: Mutex<Instant>,
    session_id: Mutex<Option<String>>,
    desired_mode: Mutex<String>,
    current_mode: Mutex<Option<String>>,
}

impl Router {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            turn: Mutex::new(None),
            last_update: Mutex::new(Instant::now()),
            session_id: Mutex::new(None),
            desired_mode: Mutex::new(String::new()),
            current_mode: Mutex::new(None),
        })
    }

    fn handler(self: &Arc<Self>) -> Handler {
        let r = Arc::clone(self);
        Arc::new(move |peer, msg| r.handle(peer, msg))
    }

    fn current(&self) -> Option<Arc<TurnCtx>> {
        self.turn.lock().clone()
    }

    fn detach(&self, ctx: &Arc<TurnCtx>) {
        let mut t = self.turn.lock();
        if t.as_ref().is_some_and(|c| Arc::ptr_eq(c, ctx)) {
            *t = None;
        }
    }

    fn handle(&self, peer: &Arc<Peer>, msg: Incoming) {
        match msg {
            Incoming::Notification { method, params } if method == "session/update" => {
                *self.last_update.lock() = Instant::now();
                if params["sessionId"].as_str() != self.session_id.lock().as_deref() {
                    return;
                }
                let update = &params["update"];
                if let Some(mode) = mode_change(update) {
                    self.mode_changed(peer, mode);
                    return;
                }
                if let Some(ctx) = self.current().filter(|c| c.live.load(Ordering::SeqCst)) {
                    ctx.on_update(update);
                }
            }
            Incoming::Notification { .. } | Incoming::Closed => {}
            Incoming::Request { id, method, params } => match method.as_str() {
                "session/request_permission" => match self.current() {
                    Some(ctx) => ctx.on_permission(peer, id, &params),
                    None => {
                        let _ = peer.respond(id, cancelled_outcome());
                    }
                },
                "fs/read_text_file" | "fs/write_text_file" => {
                    let ctx = self.current();
                    let peer = Arc::clone(peer);
                    // File access and checkpoints can take a moment; keep the reader free.
                    thread::spawn(move || {
                        let result = match ctx {
                            Some(c) => c.fs(&method, &params),
                            None => Err((-32000, "No AgentHub turn is running".to_string())),
                        };
                        let _ = match result {
                            Ok(v) => peer.respond(id, v),
                            Err((code, m)) => peer.respond_error(id, code, &m),
                        };
                    });
                }
                // terminal/* (not advertised) and anything else.
                _ => {
                    let _ = peer.respond_error(id, -32601, &format!("Method not found: {method}"));
                }
            },
        }
    }

    /// The runtime switched modes (e.g. after leaving plan mode): undo any
    /// switch away from the mode AgentHub chose.
    fn mode_changed(&self, peer: &Arc<Peer>, mode: String) {
        *self.current_mode.lock() = Some(mode.clone());
        let desired = self.desired_mode.lock().clone();
        let sid = self.session_id.lock().clone();
        if let Some(sid) = sid.filter(|_| !desired.is_empty() && mode != desired) {
            let peer = Arc::clone(peer);
            thread::spawn(move || {
                let _ = peer.request("session/set_mode", json!({ "sessionId": sid, "modeId": desired }), SET_MODE_TIMEOUT);
            });
        }
    }
}

/// A running runtime process with its session.
struct Live {
    peer: Arc<Peer>,
    router: Arc<Router>,
    session_id: String,
    /// What the session runs with now (in-place profiles update them).
    model: Mutex<String>,
    mode: Mutex<Mode>,
    cwd: PathBuf,
    /// The session's modes, models and initial model, for in-place changes.
    modes: Vec<ModeInfo>,
    models: Option<Vec<String>>,
    default_model: Option<String>,
    /// The agent accepts image prompt blocks (`promptCapabilities.image`).
    images: bool,
}

struct Inner {
    profile: Arc<dyn Profile>,
    sessions: Mutex<HashMap<String, Arc<Live>>>,
    connect: Connector,
    /// The process of a running sign-in, so it can be cancelled.
    signing_in: Mutex<Option<Arc<Peer>>>,
}

fn init_params() -> Value {
    json!({
        "protocolVersion": 1,
        "clientCapabilities": { "fs": { "readTextFile": true, "writeTextFile": true }, "terminal": false },
        "clientInfo": { "name": "agenthub", "title": "AgentHub", "version": env!("CARGO_PKG_VERSION") },
    })
}

fn new_session(p: &dyn Profile, peer: &Peer, cwd: &Path, secret: Option<&str>) -> Result<(String, Value), ChatError> {
    let r = peer
        .request("session/new", json!({ "cwd": cwd.to_string_lossy(), "mcpServers": [] }), SESSION_TIMEOUT)
        .map_err(|e| rpc_failure(p, e, peer, "while starting a session", &format!("{} couldn't start a session", p.label()), secret))?;
    let id = r["sessionId"]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| ChatError::new(ErrorKind::Malformed, format!("{} started a session without an id.", p.label())))?
        .to_string();
    Ok((id, r))
}

fn check_protocol(p: &dyn Profile, init: &Value) -> Result<(), ChatError> {
    let label = p.label();
    match init["protocolVersion"].as_u64() {
        Some(v) if v != 1 => Err(ChatError::new(
            ErrorKind::ProviderError,
            format!("This {label} speaks Agent Client Protocol version {v}; AgentHub supports version 1. Update AgentHub or {label}."),
        )),
        _ => Ok(()),
    }
}

/// `initialize`, the protocol check and the profile's `authenticate`.
fn handshake(p: &dyn Profile, peer: &Peer, api_key: Option<&str>) -> Result<Value, ChatError> {
    let label = p.label();
    let init = peer
        .request("initialize", init_params(), INIT_TIMEOUT)
        .map_err(|e| rpc_failure(p, e, peer, "while starting", &format!("{label} couldn't start"), api_key))?;
    check_protocol(p, &init)?;
    if let Some(method) = p.auth_method(&init, api_key) {
        peer.request("authenticate", json!({ "methodId": method }), SESSION_TIMEOUT)
            .map_err(|e| rpc_failure(p, e, peer, "while signing in", &format!("{label} couldn't sign in"), api_key))?;
    }
    Ok(init)
}

fn set_mode(peer: &Peer, session_id: &str, mode: &str) -> Result<(), RpcError> {
    peer.request("session/set_mode", json!({ "sessionId": session_id, "modeId": mode }), SET_MODE_TIMEOUT).map(|_| ())
}

fn session_modes(result: &Value) -> Vec<ModeInfo> {
    result["modes"]["availableModes"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|m| Some(ModeInfo { id: m["id"].as_str()?.to_string(), name: m["name"].as_str().unwrap_or("").to_string() }))
        .collect()
}

fn session_models(result: &Value) -> Option<Vec<String>> {
    result["models"]["availableModels"].as_array().map(|a| a.iter().filter_map(|m| m["modelId"].as_str().map(str::to_string)).collect())
}

/// Switches a live session to `model` (`session/set_model`).
fn apply_model(p: &dyn Profile, peer: &Peer, session_id: &str, model: &str, offered: Option<&[String]>) -> Result<(), ChatError> {
    let label = p.label();
    if offered.is_some_and(|list| !list.iter().any(|m| m == model)) {
        return Err(ChatError::new(
            ErrorKind::ModelUnavailable,
            format!("{label} doesn't offer the model {model}. Recheck it in Settings › AI integrations to see its models."),
        ));
    }
    match peer.request("session/set_model", json!({ "sessionId": session_id, "modelId": model }), SET_MODE_TIMEOUT) {
        Ok(_) => Ok(()),
        Err(e @ (RpcError::Closed | RpcError::Io(_))) => Err(rpc_failure(p, e, peer, "while switching models", "", None)),
        Err(e) => Err(ChatError::new(
            ErrorKind::ModelUnavailable,
            format!("{label} couldn't switch to the model {model}: {}", redact(&e.to_string(), None)),
        )),
    }
}

/// How a session was started.
struct Started {
    session_id: String,
    /// The recap must be sent (the stored session couldn't be resumed).
    handoff: bool,
    modes: Vec<ModeInfo>,
    models: Option<Vec<String>>,
    default_model: Option<String>,
    images: bool,
}

impl Inner {
    fn p(&self) -> &dyn Profile {
        self.profile.as_ref()
    }

    fn drop_live(&self, conversation_id: &str, live: &Arc<Live>) {
        let mut s = self.sessions.lock();
        if s.get(conversation_id).is_some_and(|l| Arc::ptr_eq(l, live)) {
            s.remove(conversation_id);
        }
        drop(s);
        live.peer.kill();
    }

    /// The live process for this turn: reused when nothing changed (or the
    /// profile changes model and mode in place), else (re)started and the
    /// stored session loaded. Returns whether the handoff recap must be sent
    /// (the session couldn't be resumed).
    fn session_for(&self, req: &TurnRequest, ctx: &Arc<TurnCtx>) -> Result<(Arc<Live>, bool), ChatError> {
        let existing = self.sessions.lock().get(&req.conversation_id).cloned();
        if let Some(l) = &existing {
            let alive = l.peer.is_alive() && l.cwd == req.cwd && req.runtime_session_id.as_deref().map_or(true, |id| id == l.session_id);
            let same = !req.reconfigure && *l.model.lock() == req.model && *l.mode.lock() == req.mode;
            if alive && (same || self.profile.reconfigure_in_place()) {
                *l.router.turn.lock() = Some(Arc::clone(ctx));
                *ctx.peer.lock() = Some(Arc::clone(&l.peer));
                *ctx.session_id.lock() = Some(l.session_id.clone());
                ctx.emit(AgentEvent::Session { id: l.session_id.clone(), resumed: true });
                if !same {
                    self.reconfigure(l, req)?;
                }
                let desired = l.router.desired_mode.lock().clone();
                let current = l.router.current_mode.lock().clone();
                if !desired.is_empty() && current.is_some_and(|c| c != desired) {
                    set_mode(&l.peer, &l.session_id, &desired).map_err(|e| self.mode_error(e))?;
                }
                return Ok((Arc::clone(l), false));
            }
        }
        if let Some(old) = &existing {
            self.drop_live(&req.conversation_id, old);
        }
        let resume = req.runtime_session_id.clone().or_else(|| existing.map(|l| l.session_id.clone()));

        let router = Router::new();
        *router.turn.lock() = Some(Arc::clone(ctx));
        let spec = SpawnSpec {
            executable: req.executable.as_deref(),
            model: &req.model,
            mode: req.mode,
            cwd: &req.cwd,
            api_key: req.api_key.as_deref(),
        };
        let peer = (self.connect)(&spec, router.handler())?;
        *ctx.peer.lock() = Some(Arc::clone(&peer));
        match self.start_session(req, ctx, &router, &peer, resume) {
            Ok(s) => {
                let live = Arc::new(Live {
                    peer,
                    router,
                    session_id: s.session_id,
                    model: Mutex::new(req.model.clone()),
                    mode: Mutex::new(req.mode),
                    cwd: req.cwd.clone(),
                    modes: s.modes,
                    models: s.models,
                    default_model: s.default_model,
                    images: s.images,
                });
                self.sessions.lock().insert(req.conversation_id.clone(), Arc::clone(&live));
                Ok((live, s.handoff))
            }
            Err(e) => {
                peer.kill();
                Err(e)
            }
        }
    }

    /// Applies a new model or mode to a live session (in-place profiles).
    fn reconfigure(&self, l: &Live, req: &TurnRequest) -> Result<(), ChatError> {
        if *l.model.lock() != req.model {
            let target = model_arg(&req.model).map(str::to_string).or_else(|| l.default_model.clone());
            if let Some(m) = target {
                apply_model(self.p(), &l.peer, &l.session_id, &m, l.models.as_deref())?;
            }
            *l.model.lock() = req.model.clone();
        }
        let current = l.router.current_mode.lock().clone();
        self.apply_mode(&l.peer, &l.router, &l.session_id, req.mode, &l.modes, current)?;
        *l.mode.lock() = req.mode;
        Ok(())
    }

    fn mode_error(&self, e: RpcError) -> ChatError {
        ChatError::new(
            ErrorKind::ModeUnsupported,
            format!("Couldn't switch {} to a mode that asks before edits and commands: {}", self.p().label(), redact(&e.to_string(), None)),
        )
    }

    /// Puts the session in the profile's mode for `mode`.
    fn apply_mode(&self, peer: &Arc<Peer>, router: &Router, session_id: &str, mode: Mode, modes: &[ModeInfo], current: Option<String>) -> Result<(), ChatError> {
        let choice =
            self.profile.pick_mode(mode, modes, current.as_deref()).map_err(|m| ChatError::new(ErrorKind::ModeUnsupported, m))?;
        let Some(choice) = choice else {
            router.desired_mode.lock().clear();
            return Ok(());
        };
        let base = choice.fallback.clone().unwrap_or_else(|| choice.desired.clone());
        *router.desired_mode.lock() = choice.desired.clone();
        let applied = match set_mode(peer, session_id, &choice.desired) {
            Ok(()) => Ok(choice.desired.clone()),
            Err(e @ (RpcError::Closed | RpcError::Io(_))) => {
                return Err(rpc_failure(self.p(), e, peer, "while setting up the session", "", None))
            }
            Err(_) if choice.fallback.is_some() => set_mode(peer, session_id, &base).map(|_| base.clone()),
            Err(e) => Err(e),
        };
        match applied {
            Ok(m) => {
                *router.desired_mode.lock() = m.clone();
                *router.current_mode.lock() = Some(m);
            }
            // A runtime without modes that already runs in the base mode is fine.
            Err(_) if current.as_deref().map_or(true, |c| c == base) => {
                *router.desired_mode.lock() = base;
            }
            Err(e) => return Err(self.mode_error(e)),
        }
        Ok(())
    }

    fn start_session(&self, req: &TurnRequest, ctx: &Arc<TurnCtx>, router: &Router, peer: &Arc<Peer>, resume: Option<String>) -> Result<Started, ChatError> {
        let p = self.p();
        let key = req.api_key.as_deref();
        let init = handshake(p, peer, key)?;
        let can_load = p.trust_session_load() && init["agentCapabilities"]["loadSession"].as_bool() == Some(true);
        let mut resume_error: Option<String> = None;
        let (session_id, result, resumed) = match resume {
            Some(id) if can_load => {
                match peer.request("session/load", json!({ "sessionId": id, "cwd": req.cwd.to_string_lossy(), "mcpServers": [] }), SESSION_TIMEOUT) {
                    Ok(r) => (id, r, true),
                    Err(e @ (RpcError::Closed | RpcError::Io(_))) => return Err(rpc_failure(p, e, peer, "while loading the session", "", key)),
                    Err(e) => {
                        resume_error = Some(redact(&e.to_string(), key));
                        let (id, r) = new_session(p, peer, &req.cwd, key)?;
                        (id, r, false)
                    }
                }
            }
            Some(_) => {
                resume_error = Some(p.no_load_reason());
                let (id, r) = new_session(p, peer, &req.cwd, key)?;
                (id, r, false)
            }
            None => {
                let (id, r) = new_session(p, peer, &req.cwd, key)?;
                (id, r, false)
            }
        };
        *router.session_id.lock() = Some(session_id.clone());
        *ctx.session_id.lock() = Some(session_id.clone());
        if resumed {
            // The replay may still be arriving; the quiet window starts now.
            *router.last_update.lock() = Instant::now();
        }
        ctx.emit(AgentEvent::Session { id: session_id.clone(), resumed });
        if let Some(message) = &resume_error {
            ctx.emit(AgentEvent::ResumeFailed { message: message.clone() });
        }

        let modes = session_modes(&result);
        let current = result["modes"]["currentModeId"].as_str().map(str::to_string);
        self.apply_mode(peer, router, &session_id, req.mode, &modes, current)?;

        let models = session_models(&result);
        let default_model = result["models"]["currentModelId"].as_str().map(str::to_string);
        if p.reconfigure_in_place() {
            if let Some(m) = model_arg(&req.model).filter(|m| default_model.as_deref() != Some(*m)) {
                apply_model(p, peer, &session_id, m, models.as_deref())?;
            }
        }

        if resumed {
            let start = Instant::now();
            loop {
                let since = router.last_update.lock().elapsed();
                if since >= REPLAY_QUIET || start.elapsed() >= REPLAY_MAX || !peer.is_alive() {
                    break;
                }
                thread::sleep((REPLAY_QUIET - since).min(Duration::from_millis(50)));
            }
        }
        let images = init["agentCapabilities"]["promptCapabilities"]["image"].as_bool() == Some(true);
        Ok(Started { session_id, handoff: resume_error.is_some(), modes, models, default_model, images })
    }

    fn drive(&self, req: &TurnRequest, ctx: &Arc<TurnCtx>) -> TurnOutcome {
        let label = self.p().label();
        let (live, handoff) = match self.session_for(req, ctx) {
            Ok(x) => x,
            Err(_) if ctx.is_cancelled() => return TurnOutcome::Cancelled,
            Err(e) => return TurnOutcome::Failed(e),
        };
        if ctx.is_cancelled() {
            return TurnOutcome::Cancelled;
        }
        if !req.images.is_empty() && !live.images {
            return TurnOutcome::Failed(ChatError::new(
                ErrorKind::InvalidRequest,
                format!("This {label} doesn't accept images. Remove them, or use another coding agent."),
            ));
        }
        let mut prompt: Vec<Value> = req.images.iter().map(|i| json!({ "type": "image", "mimeType": i.mime, "data": i.data })).collect();
        prompt.push(json!({ "type": "text", "text": prompt_text(req, handoff) }));
        let params = json!({ "sessionId": live.session_id, "prompt": prompt });
        ctx.live.store(true, Ordering::SeqCst);
        ctx.prompting.store(true, Ordering::SeqCst);
        let (tx, rx) = mpsc::channel();
        let peer = Arc::clone(&live.peer);
        thread::spawn(move || {
            let _ = tx.send(peer.request("session/prompt", params, PROMPT_TIMEOUT));
        });
        if ctx.is_cancelled() {
            ctx.send_cancel(&live.peer);
        }
        let violation = || ctx.violation.lock().clone();
        let result = loop {
            match rx.recv_timeout(Duration::from_millis(100)) {
                Ok(r) => break r,
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    if ctx.cancel_expired() {
                        // The runtime didn't stop in time; the session can be loaded again next turn.
                        self.drop_live(&req.conversation_id, &live);
                        return violation().map_or(TurnOutcome::Cancelled, TurnOutcome::Failed);
                    }
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => break Err(RpcError::Closed),
            }
        };
        if let Some(v) = violation() {
            return TurnOutcome::Failed(v);
        }
        match result {
            Ok(v) => {
                if let Some(u) = usage_of(&v["usage"]) {
                    ctx.emit(AgentEvent::Usage(u));
                }
                if ctx.is_cancelled() {
                    return TurnOutcome::Cancelled;
                }
                match v["stopReason"].as_str() {
                    Some("cancelled") => TurnOutcome::Cancelled,
                    Some("max_tokens") => {
                        ctx.emit(AgentEvent::Notice { text: format!("{label} stopped early: the reply hit the model's token limit."), tone: Tone::Warn });
                        TurnOutcome::Completed
                    }
                    Some("max_turn_requests") => {
                        ctx.emit(AgentEvent::Notice {
                            text: format!("{label} stopped early: it reached its limit of model requests for one message (or detected a loop)."),
                            tone: Tone::Warn,
                        });
                        TurnOutcome::Completed
                    }
                    Some("refusal") => TurnOutcome::Failed(ChatError::new(ErrorKind::Refused, format!("{label} declined to continue this request."))),
                    _ => TurnOutcome::Completed,
                }
            }
            Err(_) if ctx.is_cancelled() => TurnOutcome::Cancelled,
            Err(e) => {
                let err = rpc_failure(self.p(), e, &live.peer, "during the turn", label, req.api_key.as_deref());
                if err.kind == ErrorKind::RuntimeExited {
                    self.drop_live(&req.conversation_id, &live);
                }
                TurnOutcome::Failed(err)
            }
        }
    }
}

struct Handle(Arc<TurnCtx>);

impl TurnHandle for Handle {
    fn interrupt(&self) {
        self.0.interrupt();
    }
}

/// The models a fresh session offers and the version `initialize` reports
/// (`agentInfo`), or why there is no session.
fn probe_handshake(p: &dyn Profile, peer: &Peer, cwd: &Path, api_key: Option<&str>) -> Result<(Vec<ModelInfo>, Option<String>), ChatError> {
    let init = handshake(p, peer, api_key)?;
    let version = init["agentInfo"]["version"].as_str().map(|v| v.chars().take(80).collect());
    let (_, result) = new_session(p, peer, cwd, api_key)?;
    let current = result["models"]["currentModelId"].as_str().unwrap_or("");
    let models = result["models"]["availableModels"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|m| {
            let id = m["modelId"].as_str()?.to_string();
            Some(ModelInfo { label: m["name"].as_str().unwrap_or(&id).to_string(), is_default: id == current, id })
        })
        .collect();
    Ok((models, version))
}

/// Answers whatever the runtime asks during a probe or sign-in without allowing anything.
fn probe_handler(label: &'static str) -> Handler {
    Arc::new(move |peer, msg| {
        if let Incoming::Request { id, method, .. } = msg {
            let _ = if method == "session/request_permission" {
                peer.respond(id, cancelled_outcome())
            } else {
                peer.respond_error(id, -32601, &format!("Not available while AgentHub checks {label}"))
            };
        }
    })
}

fn temp_dir(purpose: &str) -> Result<PathBuf, ChatError> {
    let dir = std::env::temp_dir().join(format!("agenthub-acp-{purpose}-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).map_err(|e| ChatError::new(ErrorKind::ProviderError, format!("Couldn't create a temporary folder: {e}")))?;
    Ok(dir)
}

pub struct Adapter {
    inner: Arc<Inner>,
}

impl Adapter {
    pub(super) fn new(profile: Arc<dyn Profile>) -> Self {
        let p = Arc::clone(&profile);
        let connect: Connector = Arc::new(move |spec: &SpawnSpec, handler| p.spawn(spec, handler));
        Self::with_connector(profile, connect)
    }

    pub(super) fn with_connector(profile: Arc<dyn Profile>, connect: Connector) -> Self {
        Self { inner: Arc::new(Inner { profile, sessions: Mutex::new(HashMap::new()), connect, signing_in: Mutex::new(None) }) }
    }

    /// `initialize` and `authenticate` with the profile's sign-in method on a
    /// throwaway process; the runtime runs the sign-in (e.g. in the browser).
    fn run_sign_in(&self, peer: &Arc<Peer>, method: &str) -> Result<(), ChatError> {
        let p = self.inner.p();
        let label = p.label();
        let init = peer
            .request("initialize", init_params(), INIT_TIMEOUT)
            .map_err(|e| rpc_failure(p, e, peer, "while starting", &format!("{label} couldn't start"), None))?;
        check_protocol(p, &init)?;
        let offered = init["authMethods"].as_array().into_iter().flatten().any(|m| m["id"].as_str() == Some(method));
        if !offered {
            return Err(ChatError::new(
                ErrorKind::ProviderError,
                format!("This {label} doesn't offer the sign-in AgentHub uses ({method}). Update {label}, then try again."),
            ));
        }
        match peer.request("authenticate", json!({ "methodId": method }), SIGN_IN_TIMEOUT) {
            Ok(_) => Ok(()),
            Err(RpcError::Timeout) => Err(ChatError::new(ErrorKind::Timeout, "Sign-in wasn't finished within 5 minutes.")),
            Err(RpcError::Remote { message, .. }) => {
                Err(ChatError::new(ErrorKind::NotSignedIn, format!("{label} couldn't sign you in: {}", redact(&message, None))))
            }
            Err(e) => Err(rpc_failure(p, e, peer, "during sign-in", "", None)),
        }
    }
}

impl EngineAdapter for Adapter {
    fn engine(&self) -> Engine {
        self.inner.profile.engine()
    }

    fn probe(&self, executable: Option<&Path>, api_key: Option<&str>) -> EngineProbe {
        let p = self.inner.p();
        let engine = p.engine();
        let found = match p.locate(executable) {
            Ok(f) => f,
            Err(e) => return EngineProbe::new(engine, ProbeState::NotFound, Some(e.message)),
        };
        let mut probe = EngineProbe::new(engine, ProbeState::Ready, None);
        probe.path = Some(found.to_string_lossy().to_string());
        probe.version = p.version(&found);
        if let Some((state, message)) = p.precheck(api_key) {
            probe.state = state;
            probe.message = Some(message);
            return probe;
        }
        let dir = match temp_dir("probe") {
            Ok(d) => d,
            Err(e) => {
                probe.state = ProbeState::Error;
                probe.message = Some(e.message);
                return probe;
            }
        };
        let spec = SpawnSpec { executable, model: "default", mode: Mode::Agent, cwd: &dir, api_key };
        let result = (self.inner.connect)(&spec, probe_handler(p.label())).and_then(|peer| {
            let r = probe_handshake(p, &peer, &dir, api_key);
            peer.kill();
            r
        });
        let _ = std::fs::remove_dir_all(&dir);
        match result {
            Ok((models, version)) => {
                probe.models = models;
                if probe.version.is_none() {
                    probe.version = version;
                }
            }
            Err(e) if e.kind == ErrorKind::NotSignedIn => {
                probe.state = ProbeState::SignInNeeded;
                probe.message = Some(e.message);
            }
            Err(e) => {
                probe.state = ProbeState::Error;
                probe.message = Some(e.message);
            }
        }
        probe
    }

    fn sign_in(&self, executable: Option<&Path>) -> Result<(), ChatError> {
        let p = self.inner.p();
        let Some(method) = p.sign_in_method() else {
            return Err(ChatError::new(ErrorKind::InvalidRequest, format!("{} doesn't sign in from AgentHub.", p.label())));
        };
        let dir = temp_dir("sign-in")?;
        let spec = SpawnSpec { executable, model: "default", mode: Mode::Agent, cwd: &dir, api_key: None };
        let peer = match (self.inner.connect)(&spec, probe_handler(p.label())) {
            Ok(peer) => peer,
            Err(e) => {
                let _ = std::fs::remove_dir_all(&dir);
                return Err(e);
            }
        };
        if let Some(old) = self.inner.signing_in.lock().replace(Arc::clone(&peer)) {
            old.kill();
        }
        let result = self.run_sign_in(&peer, method);
        let cancelled = {
            let mut s = self.inner.signing_in.lock();
            let mine = s.as_ref().is_some_and(|x| Arc::ptr_eq(x, &peer));
            if mine {
                *s = None;
            }
            !mine
        };
        peer.kill();
        let _ = std::fs::remove_dir_all(&dir);
        if cancelled {
            return Err(ChatError::new(ErrorKind::Interrupted, "Sign-in was cancelled."));
        }
        result
    }

    fn cancel_sign_in(&self) {
        if let Some(peer) = self.inner.signing_in.lock().take() {
            peer.kill();
        }
    }

    fn start_turn(&self, req: TurnRequest, guard: Arc<dyn WriteGuard>, sink: AgentSink) -> Result<Box<dyn TurnHandle>, ChatError> {
        let ctx = Arc::new(TurnCtx::new(self.inner.p(), &req, guard, sink));
        let inner = Arc::clone(&self.inner);
        let c = Arc::clone(&ctx);
        thread::spawn(move || {
            let outcome = inner.drive(&req, &c);
            if let Some(live) = inner.sessions.lock().get(&req.conversation_id).cloned() {
                live.router.detach(&c);
            }
            c.finish(outcome);
        });
        Ok(Box::new(Handle(ctx)))
    }

    fn close_session(&self, conversation_id: &str) {
        let live = self.inner.sessions.lock().remove(conversation_id);
        if let Some(l) = live {
            l.peer.kill();
        }
    }

    fn shutdown(&self) {
        self.cancel_sign_in();
        let all: Vec<Arc<Live>> = self.inner.sessions.lock().drain().map(|(_, l)| l).collect();
        for l in all {
            l.peer.kill();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat::agents::antigravity::Antigravity;
    use crate::chat::agents::gemini::Gemini;
    use crate::chat::agents::jsonrpc::testing::{fake_peer, FakeRuntime};
    use crate::chat::Policy;

    struct FakeGuard {
        readable: bool,
        deny_write: Option<String>,
        writes: Mutex<Vec<PathBuf>>,
    }

    impl WriteGuard for FakeGuard {
        fn before_write(&self, path: &Path) -> Result<(), String> {
            if let Some(m) = &self.deny_write {
                return Err(m.clone());
            }
            self.writes.lock().push(path.to_path_buf());
            Ok(())
        }
        fn may_read(&self, _path: &Path) -> bool {
            self.readable
        }
    }

    fn guard(readable: bool, deny_write: Option<&str>) -> Arc<FakeGuard> {
        Arc::new(FakeGuard { readable, deny_write: deny_write.map(Into::into), writes: Mutex::new(vec![]) })
    }

    struct Harness {
        adapter: Adapter,
        runtimes: mpsc::Receiver<FakeRuntime>,
        specs: Arc<Mutex<Vec<(String, Mode)>>>,
        keys: Arc<Mutex<Vec<Option<String>>>>,
    }

    /// The core with the Gemini CLI profile (its messages say "Gemini CLI").
    fn harness() -> Harness {
        harness_with(Arc::new(Gemini::default()))
    }

    fn harness_with(profile: Arc<dyn Profile>) -> Harness {
        let (tx, rx) = mpsc::channel();
        let tx = Mutex::new(tx);
        let specs: Arc<Mutex<Vec<(String, Mode)>>> = Arc::default();
        let keys: Arc<Mutex<Vec<Option<String>>>> = Arc::default();
        let (s, k) = (Arc::clone(&specs), Arc::clone(&keys));
        let connect: Connector = Arc::new(move |spec: &SpawnSpec, handler| {
            s.lock().push((spec.model.to_string(), spec.mode));
            k.lock().push(spec.api_key.map(str::to_string));
            let (peer, rt) = fake_peer(true, handler);
            tx.lock().send(rt).unwrap();
            Ok(peer)
        });
        Harness { adapter: Adapter::with_connector(profile, connect), runtimes: rx, specs, keys }
    }

    impl Harness {
        fn runtime(&self) -> FakeRuntime {
            self.runtimes.recv_timeout(Duration::from_secs(5)).expect("a Gemini process was started")
        }
    }

    struct Events(mpsc::Receiver<AgentEvent>);

    impl Events {
        fn next(&self) -> AgentEvent {
            self.0.recv_timeout(Duration::from_secs(10)).expect("an event")
        }
        /// Events up to and including `Done`.
        fn until_done(&self) -> Vec<AgentEvent> {
            let mut out = Vec::new();
            loop {
                let e = self.next();
                let done = matches!(e, AgentEvent::Done(_));
                out.push(e);
                if done {
                    return out;
                }
            }
        }
    }

    fn sink() -> (AgentSink, Events) {
        let (tx, rx) = mpsc::channel();
        let tx = Mutex::new(tx);
        (
            Arc::new(move |e| {
                let _ = tx.lock().send(e);
            }),
            Events(rx),
        )
    }

    fn name(e: &AgentEvent) -> String {
        match e {
            AgentEvent::Session { id, resumed } => format!("session {id} {resumed}"),
            AgentEvent::ResumeFailed { message } => format!("resume_failed {message}"),
            AgentEvent::Text { text } => format!("text {text}"),
            AgentEvent::TextBreak => "break".into(),
            AgentEvent::Thinking { text } => format!("thinking {text}"),
            AgentEvent::ItemStarted { key, status, .. } => format!("started {key} {status:?}"),
            AgentEvent::ItemUpdated { key, status, .. } => format!("updated {key} {status:?}"),
            AgentEvent::Output { key, .. } => format!("output {key}"),
            AgentEvent::Plan { steps, .. } => format!("plan {}", steps.len()),
            AgentEvent::Approval { key, .. } => format!("approval {key}"),
            AgentEvent::Usage(u) => format!("usage {:?} {:?}", u.input_tokens, u.output_tokens),
            AgentEvent::Notice { text, .. } => format!("notice {text}"),
            AgentEvent::Done(o) => format!("done {o:?}"),
        }
    }

    fn names(events: &[AgentEvent]) -> Vec<String> {
        events.iter().map(name).collect()
    }

    fn request(cwd: &Path, mode: Mode, session: Option<&str>) -> TurnRequest {
        TurnRequest {
            conversation_id: "conv".into(),
            turn_id: "turn".into(),
            engine: Engine::GeminiCli,
            model: "gemini-test".into(),
            mode,
            policy: Policy::Ask,
            cwd: cwd.to_path_buf(),
            prompt: "Explain main.rs".into(),
            images: vec![],
            runtime_session_id: session.map(Into::into),
            handoff: session.map(|_| "RECAP\n\n---\n\n".to_string()),
            reconfigure: false,
            api_key: None,
            executable: None,
        }
    }

    fn reply(rt: &mut FakeRuntime, msg: &Value, result: Value) {
        rt.send(json!({ "jsonrpc": "2.0", "id": msg["id"].clone(), "result": result }));
    }

    fn reply_err(rt: &mut FakeRuntime, msg: &Value, code: i64, message: &str) {
        rt.send(json!({ "jsonrpc": "2.0", "id": msg["id"].clone(), "error": { "code": code, "message": message } }));
    }

    fn update(sid: &str, u: Value) -> Value {
        json!({ "jsonrpc": "2.0", "method": "session/update", "params": { "sessionId": sid, "update": u } })
    }

    fn chunk(kind: &str, text: &str) -> Value {
        json!({ "sessionUpdate": kind, "content": { "type": "text", "text": text } })
    }

    fn session_result(id: Option<&str>, plan: bool) -> Value {
        let mut modes = vec![json!({ "id": "default" }), json!({ "id": "autoEdit" }), json!({ "id": "yolo" })];
        if plan {
            modes.push(json!({ "id": "plan" }));
        }
        let mut r = json!({
            "modes": { "currentModeId": "default", "availableModes": modes },
            "models": { "currentModelId": "auto", "availableModels": [
                { "modelId": "auto", "name": "Auto" }, { "modelId": "gemini-test", "name": "Gemini Test" }
            ] },
        });
        if let Some(id) = id {
            r["sessionId"] = json!(id);
        }
        r
    }

    fn init(rt: &mut FakeRuntime) {
        let init = rt.expect("initialize");
        reply(rt, &init, json!({ "protocolVersion": 1, "agentCapabilities": { "loadSession": true }, "authMethods": [] }));
    }

    /// initialize, session/new and set_mode; returns the prompt request.
    fn start_new(rt: &mut FakeRuntime, sid: &str) -> Value {
        init(rt);
        let new = rt.expect("session/new");
        reply(rt, &new, session_result(Some(sid), false));
        let m = rt.expect("session/set_mode");
        assert_eq!(m["params"]["modeId"], "default");
        reply(rt, &m, json!({}));
        rt.expect("session/prompt")
    }

    fn prompt_of(p: &Value) -> String {
        p["params"]["prompt"][0]["text"].as_str().unwrap().to_string()
    }

    fn permission(id: u64, sid: &str, tool: Value, options: Value) -> Value {
        json!({ "jsonrpc": "2.0", "id": id, "method": "session/request_permission", "params": { "sessionId": sid, "toolCall": tool, "options": options } })
    }

    fn take_approval(ev: &Events) -> (String, PermissionRequest, Reply) {
        loop {
            match ev.next() {
                AgentEvent::Approval { key, request, reply } => return (key, request, reply),
                AgentEvent::Done(o) => panic!("turn ended: {o:?}"),
                _ => {}
            }
        }
    }

    fn once_options() -> Value {
        json!([{ "optionId": "proceed_once", "name": "Allow", "kind": "allow_once" }, { "optionId": "cancel", "name": "Reject", "kind": "reject_once" }])
    }

    #[test]
    fn new_session_streams_text_and_reuses_the_process() {
        let h = harness();
        let dir = tempfile::tempdir().unwrap();
        let (sink1, ev) = sink();
        h.adapter.start_turn(request(dir.path(), Mode::Agent, None), guard(true, None), sink1).unwrap();
        let mut rt = h.runtime();
        let initialize = rt.expect("initialize");
        assert_eq!(initialize["jsonrpc"], "2.0");
        assert_eq!(initialize["params"]["protocolVersion"], 1);
        assert_eq!(initialize["params"]["clientCapabilities"]["fs"], json!({ "readTextFile": true, "writeTextFile": true }));
        assert_eq!(initialize["params"]["clientCapabilities"]["terminal"], false);
        reply(&mut rt, &initialize, json!({ "protocolVersion": 1, "agentCapabilities": { "loadSession": true } }));
        let new = rt.expect("session/new");
        assert_eq!(new["params"]["cwd"], dir.path().to_string_lossy().as_ref());
        assert_eq!(new["params"]["mcpServers"], json!([]));
        reply(&mut rt, &new, session_result(Some("s1"), false));
        let m = rt.expect("session/set_mode");
        assert_eq!(m["params"], json!({ "sessionId": "s1", "modeId": "default" }));
        reply(&mut rt, &m, json!({}));
        let p = rt.expect("session/prompt");
        assert_eq!(p["params"]["sessionId"], "s1");
        assert_eq!(prompt_of(&p), "Explain main.rs");
        rt.send(update("s1", chunk("agent_thought_chunk", "**Looking**\nat main")));
        rt.send(update("s1", chunk("agent_message_chunk", "[MODE_UPDATE] default")));
        rt.send(update("s1", chunk("agent_message_chunk", "Hel")));
        rt.send(update("other", chunk("agent_message_chunk", "not mine")));
        rt.send(update("s1", chunk("agent_message_chunk", "lo")));
        rt.send(update("s1", json!({ "sessionUpdate": "usage_update", "used": 10, "size": 100 })));
        reply(&mut rt, &p, json!({ "stopReason": "end_turn", "usage": { "inputTokens": 10, "outputTokens": 2, "totalTokens": 12 } }));
        let events = ev.until_done();
        assert_eq!(
            names(&events),
            vec!["session s1 false", "thinking **Looking**\nat main", "text Hel", "text lo", "usage Some(10) Some(2)", "done Completed"]
        );

        // The next turn reuses the live process and session.
        let (sink2, ev) = sink();
        h.adapter.start_turn(request(dir.path(), Mode::Agent, Some("s1")), guard(true, None), sink2).unwrap();
        let p = rt.expect("session/prompt");
        assert_eq!(prompt_of(&p), "Explain main.rs", "no recap when the session is alive");
        reply(&mut rt, &p, json!({ "stopReason": "end_turn" }));
        assert_eq!(names(&ev.until_done()), vec!["session s1 true", "done Completed"]);
        assert!(h.runtimes.try_recv().is_err(), "no second process");

        // A different model needs a new process that loads the same session.
        let (sink3, ev) = sink();
        let mut req = request(dir.path(), Mode::Agent, Some("s1"));
        req.model = "gemini-other".into();
        h.adapter.start_turn(req, guard(true, None), sink3).unwrap();
        let mut rt2 = h.runtime();
        init(&mut rt2);
        let load = rt2.expect("session/load");
        assert_eq!(load["params"]["sessionId"], "s1");
        reply(&mut rt2, &load, session_result(None, false));
        let m = rt2.expect("session/set_mode");
        reply(&mut rt2, &m, json!({}));
        let p = rt2.expect("session/prompt");
        reply(&mut rt2, &p, json!({ "stopReason": "max_tokens" }));
        let events = ev.until_done();
        assert_eq!(events.len(), 3, "{:?}", names(&events));
        assert_eq!(name(&events[0]), "session s1 true");
        assert!(name(&events[1]).starts_with("notice Gemini CLI stopped early"));
        assert_eq!(name(&events[2]), "done Completed");
        assert_eq!(h.specs.lock()[1].0, "gemini-other");
    }

    #[test]
    fn permissions_round_trip_by_option_kind() {
        let h = harness();
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("a.txt").to_string_lossy().to_string();
        let (sink, ev) = sink();
        h.adapter.start_turn(request(dir.path(), Mode::Agent, None), guard(true, None), sink).unwrap();
        let mut rt = h.runtime();
        let p = start_new(&mut rt, "s1");
        assert_eq!(name(&ev.next()), "session s1 false");

        rt.send(update("s1", chunk("agent_message_chunk", "I'll edit it.")));
        let edit = json!({
            "toolCallId": "t1", "status": "pending", "title": "Edit a.txt", "kind": "edit",
            "locations": [{ "path": file }],
            "content": [{ "type": "diff", "path": file, "oldText": "a", "newText": "b" }],
        });
        let mut announce = edit.clone();
        announce["sessionUpdate"] = json!("tool_call");
        rt.send(update("s1", announce));
        rt.send(permission(
            50,
            "s1",
            edit,
            json!([
                { "optionId": "proceed_always", "name": "Allow for this session", "kind": "allow_always" },
                { "optionId": "proceed_always_and_save", "name": "Allow for this file in all future sessions", "kind": "allow_always" },
                { "optionId": "proceed_once", "name": "Allow", "kind": "allow_once" },
                { "optionId": "cancel", "name": "Reject", "kind": "reject_once" },
            ]),
        ));
        assert_eq!(name(&ev.next()), "text I'll edit it.");
        assert_eq!(name(&ev.next()), "break");
        match ev.next() {
            AgentEvent::ItemStarted { key, status, body: ItemBody::Tool { tool, title, detail, .. } } => {
                assert_eq!((key.as_str(), status, tool, title.as_str()), ("t1", ItemStatus::Running, ToolKind::Edit, "Edit a.txt"));
                assert_eq!(detail.as_deref(), Some("a.txt"));
            }
            e => panic!("unexpected {}", name(&e)),
        }
        let (key, req, answer) = take_approval(&ev);
        assert_eq!(key, "t1");
        assert_eq!(req.kind, PermissionKind::Write);
        assert_eq!(req.path.as_deref(), Some(file.as_str()));
        assert_eq!(req.paths, vec![file.clone()]);
        assert!(req.can_allow_session);
        answer(Decision::AllowSession);
        assert_eq!(rt.recv(), json!({ "jsonrpc": "2.0", "id": 50, "result": { "outcome": { "outcome": "selected", "optionId": "proceed_always" } } }));
        rt.send(update("s1", json!({ "sessionUpdate": "tool_call_update", "toolCallId": "t1", "status": "completed", "content": [] })));
        assert_eq!(name(&ev.next()), "updated t1 Completed");

        // A command, denied.
        let run = json!({
            "toolCallId": "t2", "status": "pending", "title": "cargo test", "kind": "execute",
            "content": [{ "type": "content", "content": { "type": "text", "text": "Runs the tests" } }],
        });
        rt.send(permission(
            51,
            "s1",
            run,
            json!([
                { "optionId": "proceed_always", "name": "Allow for this session", "kind": "allow_always" },
                { "optionId": "proceed_once", "name": "Allow", "kind": "allow_once" },
                { "optionId": "cancel", "name": "Reject", "kind": "reject_once" },
            ]),
        ));
        match ev.next() {
            AgentEvent::ItemStarted { key, body: ItemBody::Command { command, output, .. }, .. } => {
                assert_eq!((key.as_str(), command.as_str(), output.as_str()), ("t2", "cargo test", ""));
            }
            e => panic!("unexpected {}", name(&e)),
        }
        let (_, req, answer) = take_approval(&ev);
        assert_eq!(req.kind, PermissionKind::Command);
        assert_eq!(req.command.as_deref(), Some("cargo test"));
        assert_eq!(req.detail.as_deref(), Some("Runs the tests"));
        answer(Decision::Deny);
        assert_eq!(rt.recv()["result"]["outcome"], json!({ "outcome": "selected", "optionId": "cancel" }));
        rt.send(update(
            "s1",
            json!({ "sessionUpdate": "tool_call_update", "toolCallId": "t2", "status": "failed",
                    "content": [{ "type": "content", "content": { "type": "text", "text": "Tool \"run_shell_command\" was canceled by the user." } }] }),
        ));
        match ev.next() {
            AgentEvent::ItemUpdated { status, body: ItemBody::Command { output, .. }, .. } => {
                assert_eq!(status, ItemStatus::Declined);
                assert!(output.contains("canceled"));
            }
            e => panic!("unexpected {}", name(&e)),
        }

        // An MCP tool: no plain session option, so no "allow for session".
        let mcp = json!({
            "toolCallId": "t3", "status": "pending", "title": "search (jira MCP Server)", "kind": "other",
            "_meta": { "gemini-cli": { "mcp": { "server_name": "jira", "tool_name": "search" } } },
        });
        rt.send(permission(
            52,
            "s1",
            mcp,
            json!([
                { "optionId": "proceed_always_server", "name": "Allow all \"jira\" server tools for this session", "kind": "allow_always" },
                { "optionId": "proceed_always_tool", "name": "Allow tool \"search\" for this session", "kind": "allow_always" },
                { "optionId": "proceed_once", "name": "Allow", "kind": "allow_once" },
                { "optionId": "cancel", "name": "Reject", "kind": "reject_once" },
            ]),
        ));
        let (_, req, answer) = take_approval(&ev);
        assert_eq!(req.kind, PermissionKind::Mcp);
        assert!(!req.can_allow_session);
        assert!(req.detail.unwrap().contains("jira"));
        answer(Decision::AllowOnce);
        assert_eq!(rt.recv()["result"]["outcome"]["optionId"], "proceed_once");

        reply(&mut rt, &p, json!({ "stopReason": "end_turn" }));
        let rest = names(&ev.until_done());
        assert_eq!(rest.last().unwrap(), "done Completed");
    }

    fn call(rt: &mut FakeRuntime, id: u64, method: &str, params: Value) -> Value {
        rt.send(json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }));
        rt.recv()
    }

    #[test]
    fn fs_reads_and_writes_go_through_the_guard() {
        let h = harness();
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("a.txt");
        std::fs::write(&file, "a\nb\nc\n").unwrap();
        let g = guard(true, None);
        let (sink, ev) = sink();
        h.adapter.start_turn(request(dir.path(), Mode::Agent, None), g.clone(), sink).unwrap();
        let mut rt = h.runtime();
        let p = start_new(&mut rt, "s1");

        let r = call(&mut rt, 60, "fs/read_text_file", json!({ "sessionId": "s1", "path": file, "line": 2, "limit": 1 }));
        assert_eq!(r["result"]["content"], "b\n");
        let r = call(&mut rt, 61, "fs/read_text_file", json!({ "sessionId": "s1", "path": file }));
        assert_eq!(r["result"]["content"], "a\nb\nc\n");
        let missing = dir.path().join("missing.txt");
        let r = call(&mut rt, 62, "fs/read_text_file", json!({ "sessionId": "s1", "path": missing }));
        assert!(r["error"]["message"].as_str().unwrap().contains("ENOENT"), "{r}");
        let r = call(&mut rt, 63, "fs/read_text_file", json!({ "sessionId": "s1", "path": "relative.txt" }));
        assert!(r["error"].is_object());

        let target = dir.path().join("new").join("sub").join("x.txt");
        let r = call(&mut rt, 64, "fs/write_text_file", json!({ "sessionId": "s1", "path": target, "content": "hi" }));
        assert_eq!(r["result"], json!({}));
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "hi");
        assert_eq!(*g.writes.lock(), vec![target.clone()]);

        let r = call(&mut rt, 65, "terminal/create", json!({ "sessionId": "s1", "command": "ls" }));
        assert_eq!(r["error"]["code"], -32601);

        reply(&mut rt, &p, json!({ "stopReason": "end_turn" }));
        assert_eq!(names(&ev.until_done()).last().unwrap(), "done Completed");
    }

    #[test]
    fn fs_access_denied_by_mode_and_guard() {
        let h = harness();
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("a.txt");
        std::fs::write(&file, "secret").unwrap();
        let (sink, ev) = sink();
        h.adapter.start_turn(request(dir.path(), Mode::Ask, None), guard(false, Some("This mode doesn't allow edits")), sink).unwrap();
        let mut rt = h.runtime();
        let p = start_new(&mut rt, "s1");
        assert!(prompt_of(&p).starts_with("AgentHub Ask mode"), "{}", prompt_of(&p));
        assert!(prompt_of(&p).ends_with("Explain main.rs"));

        let r = call(&mut rt, 70, "fs/read_text_file", json!({ "sessionId": "s1", "path": file }));
        let msg = r["error"]["message"].as_str().unwrap();
        assert!(msg.contains("denied by AgentHub (Ask mode"), "{msg}");
        assert!(!r.to_string().contains("secret"));

        let target = dir.path().join("b.txt");
        let r = call(&mut rt, 71, "fs/write_text_file", json!({ "sessionId": "s1", "path": target, "content": "x" }));
        assert!(r["error"]["message"].as_str().unwrap().contains("This mode doesn't allow edits"), "{r}");
        assert!(!target.exists());

        reply(&mut rt, &p, json!({ "stopReason": "end_turn" }));
        ev.until_done();
    }

    #[test]
    fn plan_mode_uses_geminis_plan_mode_when_offered() {
        let h = harness();
        let dir = tempfile::tempdir().unwrap();
        let (sink, ev) = sink();
        h.adapter.start_turn(request(dir.path(), Mode::Plan, None), guard(true, None), sink).unwrap();
        let mut rt = h.runtime();
        init(&mut rt);
        let new = rt.expect("session/new");
        reply(&mut rt, &new, session_result(Some("s1"), true));
        let m = rt.expect("session/set_mode");
        assert_eq!(m["params"]["modeId"], "plan");
        reply(&mut rt, &m, json!({}));
        let p = rt.expect("session/prompt");
        assert!(prompt_of(&p).starts_with("AgentHub Plan mode"));
        // Gemini switching itself to auto-edit is undone at once.
        rt.send(update("s1", chunk("agent_message_chunk", "[MODE_UPDATE] autoEdit")));
        let back = rt.expect("session/set_mode");
        assert_eq!(back["params"]["modeId"], "plan");
        reply(&mut rt, &back, json!({}));
        rt.send(update(
            "s1",
            json!({ "sessionUpdate": "plan", "entries": [
                { "content": "Read main.rs", "priority": "high", "status": "completed" },
                { "content": "Write the plan", "priority": "high", "status": "in_progress" },
            ] }),
        ));
        reply(&mut rt, &p, json!({ "stopReason": "end_turn" }));
        let events = ev.until_done();
        assert_eq!(names(&events), vec!["session s1 false", "plan 2", "done Completed"]);
        assert_eq!(h.specs.lock()[0].1, Mode::Plan);
    }

    #[test]
    fn session_load_replay_is_not_shown_as_new_output() {
        let h = harness();
        let dir = tempfile::tempdir().unwrap();
        let (sink, ev) = sink();
        h.adapter.start_turn(request(dir.path(), Mode::Agent, Some("s-old")), guard(true, None), sink).unwrap();
        let mut rt = h.runtime();
        init(&mut rt);
        let load = rt.expect("session/load");
        assert_eq!(load["params"]["sessionId"], "s-old");
        assert_eq!(load["params"]["cwd"], dir.path().to_string_lossy().as_ref());
        rt.send(update("s-old", chunk("user_message_chunk", "old question")));
        rt.send(update("s-old", chunk("agent_message_chunk", "OLD ANSWER")));
        reply(&mut rt, &load, session_result(None, false));
        // Gemini doesn't await the replay: it continues after the response.
        rt.send(update("s-old", chunk("agent_message_chunk", "OLD TAIL")));
        rt.send(update("s-old", json!({ "sessionUpdate": "tool_call", "toolCallId": "old-1", "status": "completed", "title": "ls", "kind": "execute" })));
        let m = rt.expect("session/set_mode");
        reply(&mut rt, &m, json!({}));
        let p = rt.expect("session/prompt");
        assert_eq!(prompt_of(&p), "Explain main.rs", "a resumed session gets no recap");
        rt.send(update("s-old", chunk("agent_message_chunk", "NEW")));
        reply(&mut rt, &p, json!({ "stopReason": "end_turn" }));
        assert_eq!(names(&ev.until_done()), vec!["session s-old true", "text NEW", "done Completed"]);
    }

    #[test]
    fn load_failure_starts_fresh_with_the_recap() {
        let h = harness();
        let dir = tempfile::tempdir().unwrap();
        let (sink, ev) = sink();
        h.adapter.start_turn(request(dir.path(), Mode::Agent, Some("s-old")), guard(true, None), sink).unwrap();
        let mut rt = h.runtime();
        init(&mut rt);
        let load = rt.expect("session/load");
        reply_err(&mut rt, &load, -32603, "Session not found: s-old");
        let new = rt.expect("session/new");
        reply(&mut rt, &new, session_result(Some("s-new"), false));
        let m = rt.expect("session/set_mode");
        reply(&mut rt, &m, json!({}));
        let p = rt.expect("session/prompt");
        assert_eq!(p["params"]["sessionId"], "s-new");
        assert_eq!(prompt_of(&p), "RECAP\n\n---\n\nExplain main.rs");
        reply(&mut rt, &p, json!({ "stopReason": "end_turn" }));
        assert_eq!(names(&ev.until_done()), vec!["session s-new false", "resume_failed Session not found: s-old", "done Completed"]);
    }

    #[test]
    fn images_go_as_prompt_blocks_only_when_the_agent_takes_them() {
        let png = || vec![super::super::ImageInput { mime: "image/png".into(), data: "iVBORw0K".into() }];
        // Advertised: the image block comes before the text.
        let h = harness();
        let dir = tempfile::tempdir().unwrap();
        let (out, ev) = sink();
        let mut req = request(dir.path(), Mode::Agent, None);
        req.images = png();
        h.adapter.start_turn(req, guard(true, None), out).unwrap();
        let mut rt = h.runtime();
        let hello = rt.expect("initialize");
        reply(&mut rt, &hello, json!({ "protocolVersion": 1, "agentCapabilities": { "promptCapabilities": { "image": true } }, "authMethods": [] }));
        let new = rt.expect("session/new");
        reply(&mut rt, &new, session_result(Some("s1"), false));
        let m = rt.expect("session/set_mode");
        reply(&mut rt, &m, json!({}));
        let p = rt.expect("session/prompt");
        assert_eq!(p["params"]["prompt"][0], json!({ "type": "image", "mimeType": "image/png", "data": "iVBORw0K" }));
        assert_eq!(p["params"]["prompt"][1]["type"], "text");
        reply(&mut rt, &p, json!({ "stopReason": "end_turn" }));
        assert_eq!(names(&ev.until_done()).last().unwrap(), "done Completed");

        // Not advertised: the turn fails before anything is sent.
        let h = harness();
        let (out, ev) = sink();
        let mut req = request(dir.path(), Mode::Agent, None);
        req.images = png();
        h.adapter.start_turn(req, guard(true, None), out).unwrap();
        let mut rt = h.runtime();
        init(&mut rt);
        let new = rt.expect("session/new");
        reply(&mut rt, &new, session_result(Some("s2"), false));
        let m = rt.expect("session/set_mode");
        reply(&mut rt, &m, json!({}));
        match ev.until_done().pop() {
            Some(AgentEvent::Done(TurnOutcome::Failed(e))) => assert!(e.message.contains("doesn't accept images"), "{}", e.message),
            _ => panic!("expected a failed turn"),
        }
    }

    #[test]
    fn missing_sign_in_fails_with_not_signed_in() {
        let h = harness();
        let dir = tempfile::tempdir().unwrap();
        let (sink, ev) = sink();
        h.adapter.start_turn(request(dir.path(), Mode::Agent, None), guard(true, None), sink).unwrap();
        let mut rt = h.runtime();
        init(&mut rt);
        let new = rt.expect("session/new");
        reply_err(&mut rt, &new, -32000, "Authentication required.");
        match ev.next() {
            AgentEvent::Done(TurnOutcome::Failed(e)) => {
                assert_eq!(e.kind, ErrorKind::NotSignedIn);
                assert!(e.message.contains("Gemini API key"), "{}", e.message);
            }
            e => panic!("unexpected {}", name(&e)),
        }
        assert!(h.adapter.inner.sessions.lock().is_empty(), "a failed start isn't kept");
    }

    #[test]
    fn interrupt_answers_pending_permissions_and_cancels() {
        let h = harness();
        let dir = tempfile::tempdir().unwrap();
        let (sink, ev) = sink();
        let handle = h.adapter.start_turn(request(dir.path(), Mode::Agent, None), guard(true, None), sink).unwrap();
        let mut rt = h.runtime();
        let p = start_new(&mut rt, "s1");
        let tool = json!({ "toolCallId": "t1", "status": "pending", "title": "rm -rf build", "kind": "execute" });
        rt.send(permission(80, "s1", tool, once_options()));
        let (_, _, late_reply) = take_approval(&ev);
        handle.interrupt();
        assert_eq!(rt.recv(), json!({ "jsonrpc": "2.0", "id": 80, "result": { "outcome": { "outcome": "cancelled" } } }));
        let cancel = rt.recv();
        assert_eq!(cancel["method"], "session/cancel");
        assert_eq!(cancel["params"]["sessionId"], "s1");
        assert!(cancel.get("id").is_none(), "a notification");
        late_reply(Decision::AllowOnce); // already answered: ignored
        reply(&mut rt, &p, json!({ "stopReason": "cancelled" }));
        assert_eq!(names(&ev.until_done()).last().unwrap(), "done Cancelled");
    }

    #[test]
    fn cancel_decision_stops_the_turn() {
        let h = harness();
        let dir = tempfile::tempdir().unwrap();
        let (sink, ev) = sink();
        h.adapter.start_turn(request(dir.path(), Mode::Agent, None), guard(true, None), sink).unwrap();
        let mut rt = h.runtime();
        let p = start_new(&mut rt, "s1");
        let tool = json!({ "toolCallId": "t1", "status": "pending", "title": "Write x", "kind": "edit" });
        rt.send(permission(81, "s1", tool, once_options()));
        let (_, _, answer) = take_approval(&ev);
        answer(Decision::Cancel);
        assert_eq!(rt.recv()["result"]["outcome"], json!({ "outcome": "cancelled" }));
        assert_eq!(rt.recv()["method"], "session/cancel");
        // Even if Gemini reports a normal end, the user stopped the turn.
        reply(&mut rt, &p, json!({ "stopReason": "end_turn" }));
        assert_eq!(names(&ev.until_done()).last().unwrap(), "done Cancelled");
    }

    #[test]
    fn process_exit_mid_turn_is_runtime_exited() {
        let h = harness();
        let dir = tempfile::tempdir().unwrap();
        let (sink, ev) = sink();
        h.adapter.start_turn(request(dir.path(), Mode::Agent, None), guard(true, None), sink).unwrap();
        let mut rt = h.runtime();
        start_new(&mut rt, "s1");
        rt.send(update("s1", chunk("agent_message_chunk", "Working")));
        rt.close();
        let events = ev.until_done();
        match events.last().unwrap() {
            AgentEvent::Done(TurnOutcome::Failed(e)) => {
                assert_eq!(e.kind, ErrorKind::RuntimeExited);
                assert!(e.message.starts_with("Gemini CLI exited during the turn"), "{}", e.message);
            }
            e => panic!("unexpected {}", name(e)),
        }
        assert!(h.adapter.inner.sessions.lock().is_empty(), "a dead process isn't reused");
    }

    #[test]
    fn rate_limits_map_to_rate_limited() {
        let h = harness();
        let dir = tempfile::tempdir().unwrap();
        let (sink, ev) = sink();
        h.adapter.start_turn(request(dir.path(), Mode::Agent, None), guard(true, None), sink).unwrap();
        let mut rt = h.runtime();
        let p = start_new(&mut rt, "s1");
        reply_err(&mut rt, &p, 429, "Rate limit exceeded. Try again later.");
        match ev.until_done().last().unwrap() {
            AgentEvent::Done(TurnOutcome::Failed(e)) => assert_eq!((e.kind, e.status), (ErrorKind::RateLimited, Some(429))),
            e => panic!("unexpected {}", name(e)),
        }
    }

    #[test]
    fn prompts_are_never_parsed_as_commands() {
        let dir = tempfile::tempdir().unwrap();
        let mut req = request(dir.path(), Mode::Agent, None);
        for p in ["/memory show", "  $skill run", "/init"] {
            req.prompt = p.into();
            let text = prompt_text(&req, false);
            assert!(text.starts_with(COMMAND_GUARD), "{text:?}");
            assert_eq!(text.trim_start_matches(COMMAND_GUARD), p.trim_start());
        }
        req.prompt = "path a/b".into();
        assert_eq!(prompt_text(&req, false), "path a/b");
    }

    #[test]
    fn tool_updates_translate_to_items() {
        let cwd = Path::new("C:/proj");
        let mut s = Stream::default();
        let run = json!({ "sessionUpdate": "tool_call", "toolCallId": "r", "status": "in_progress", "title": "ls", "kind": "execute" });
        assert_eq!(names(&s.translate(&run, cwd)), vec!["started r Running"]);
        let done = json!({ "sessionUpdate": "tool_call_update", "toolCallId": "r", "status": "completed",
            "content": [{ "type": "content", "content": { "type": "text", "text": "\u{1b}[32ma.txt\u{1b}[0m\n\u{1b}]0;title\u{7}b.txt" } }] });
        match s.translate(&done, cwd).remove(0) {
            AgentEvent::ItemUpdated { status, body: ItemBody::Command { command, output, .. }, .. } => {
                assert_eq!((status, command.as_str(), output.as_str()), (ItemStatus::Completed, "ls", "a.txt\nb.txt"));
            }
            e => panic!("unexpected {}", name(&e)),
        }
        let read = json!({ "sessionUpdate": "tool_call", "toolCallId": "f", "status": "completed", "title": "src/main.rs", "kind": "read",
            "locations": [{ "path": "C:/proj/src/main.rs" }], "content": [{ "type": "content", "content": { "type": "text", "text": "Read 10 lines" } }] });
        match s.translate(&read, cwd).remove(0) {
            AgentEvent::ItemStarted { body: ItemBody::Tool { tool, detail, result, .. }, .. } => {
                assert_eq!(tool, ToolKind::Read);
                assert_eq!(detail.as_deref(), Some("src/main.rs"));
                assert_eq!(result.as_deref(), Some("Read 10 lines"));
            }
            e => panic!("unexpected {}", name(&e)),
        }
        assert_eq!(names(&s.translate(&chunk("agent_thought_chunk", "A"), cwd)), vec!["thinking A"]);
        assert_eq!(names(&s.translate(&chunk("agent_thought_chunk", "B"), cwd)), vec!["thinking \n\nB"]);
        assert!(s.translate(&chunk("user_message_chunk", "replayed"), cwd).is_empty());
    }

    #[test]
    fn session_decisions_never_pick_permanent_options() {
        let opts = parse_options(&json!([
            { "optionId": "proceed_always_and_save", "name": "Allow for all future sessions", "kind": "allow_always" },
            { "optionId": "proceed_always", "name": "Allow for this session", "kind": "allow_always" },
            { "optionId": "proceed_once", "name": "Allow", "kind": "allow_once" },
            { "optionId": "cancel", "name": "Reject", "kind": "reject_once" },
        ]));
        assert_eq!(choose_option(&opts, Decision::AllowSession).as_deref(), Some("proceed_always"));
        assert_eq!(choose_option(&opts, Decision::AllowOnce).as_deref(), Some("proceed_once"));
        assert_eq!(choose_option(&opts, Decision::Deny).as_deref(), Some("cancel"));
        assert_eq!(choose_option(&opts, Decision::Cancel), None);
        let only_save = parse_options(&json!([
            { "optionId": "proceed_always_and_save", "name": "Allow for all future sessions", "kind": "allow_always" },
            { "optionId": "proceed_once", "name": "Allow", "kind": "allow_once" },
        ]));
        assert_eq!(choose_option(&only_save, Decision::AllowSession).as_deref(), Some("proceed_once"));
    }

    #[test]
    fn model_flag_only_for_a_chosen_model() {
        assert_eq!(model_arg("default"), None);
        assert_eq!(model_arg(" "), None);
        assert_eq!(model_arg("--yolo"), None);
        assert_eq!(model_arg("gemini-3.8-flash"), Some("gemini-3.8-flash"));
    }

    #[test]
    fn probe_handshake_lists_models_or_reports_sign_in() {
        let (peer, mut rt) = fake_peer(true, probe_handler("Gemini CLI"));
        let p = Arc::clone(&peer);
        let t = thread::spawn(move || probe_handshake(&Gemini::default(), &p, Path::new("C:/tmp/probe"), None));
        init(&mut rt);
        let new = rt.expect("session/new");
        reply(&mut rt, &new, session_result(Some("s"), false));
        let (models, _) = t.join().unwrap().unwrap();
        assert_eq!(models.len(), 2);
        assert!(models[0].is_default && models[0].id == "auto" && models[0].label == "Auto");
        assert!(!models[1].is_default);

        let (peer, mut rt) = fake_peer(true, probe_handler("Gemini CLI"));
        let p = Arc::clone(&peer);
        let t = thread::spawn(move || probe_handshake(&Gemini::default(), &p, Path::new("C:/tmp/probe"), None));
        init(&mut rt);
        let new = rt.expect("session/new");
        reply_err(&mut rt, &new, -32000, "Gemini API key is missing or not configured.");
        assert_eq!(t.join().unwrap().unwrap_err().kind, ErrorKind::NotSignedIn);
    }

    #[test]
    fn reads_honor_line_and_limit() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("x.txt");
        std::fs::write(&f, "1\n2\n3\n4").unwrap();
        assert_eq!(read_text(&f, Some(3), None).unwrap(), "3\n4");
        assert_eq!(read_text(&f, None, Some(2)).unwrap(), "1\n2\n");
        assert_eq!(read_text(&f, Some(9), Some(2)).unwrap(), "");
        assert!(read_text(dir.path(), None, None).is_err());
    }

    const KEY: &str = "AIzaSyTestKey0123456789abcdef";

    #[test]
    fn gemini_signs_in_with_the_api_key_and_never_shows_it() {
        let h = harness();
        let dir = tempfile::tempdir().unwrap();
        let mut req = request(dir.path(), Mode::Agent, None);
        req.api_key = Some(KEY.into());
        let (sink, ev) = sink();
        h.adapter.start_turn(req, guard(true, None), sink).unwrap();
        let mut rt = h.runtime();
        let init = rt.expect("initialize");
        reply(&mut rt, &init, json!({ "protocolVersion": 1, "authMethods": [{ "id": "oauth-personal" }, { "id": "gemini-api-key" }] }));
        let auth = rt.expect("authenticate");
        assert_eq!(auth["params"], json!({ "methodId": "gemini-api-key" }));
        assert!(!auth.to_string().contains(KEY), "the key goes only to the environment");
        reply(&mut rt, &auth, json!({}));
        let new = rt.expect("session/new");
        reply(&mut rt, &new, session_result(Some("s1"), false));
        let m = rt.expect("session/set_mode");
        reply(&mut rt, &m, json!({}));
        let p = rt.expect("session/prompt");
        reply_err(&mut rt, &p, 400, &format!("API key not valid. Please pass a valid API key. ({KEY})"));
        match ev.until_done().last().unwrap() {
            AgentEvent::Done(TurnOutcome::Failed(e)) => assert!(!e.message.contains(KEY), "{}", e.message),
            e => panic!("unexpected {}", name(e)),
        }
        assert_eq!(*h.keys.lock(), vec![Some(KEY.to_string())]);
    }

    #[test]
    fn gemini_legacy_google_sign_in_points_to_antigravity() {
        let h = harness();
        let dir = tempfile::tempdir().unwrap();
        let (sink, ev) = sink();
        h.adapter.start_turn(request(dir.path(), Mode::Agent, None), guard(true, None), sink).unwrap();
        let mut rt = h.runtime();
        init(&mut rt);
        let new = rt.expect("session/new");
        reply_err(&mut rt, &new, -32603, "Failed to sign in. Message: This client is no longer supported for Gemini Code Assist for individuals.");
        match ev.next() {
            AgentEvent::Done(TurnOutcome::Failed(e)) => {
                assert_eq!(e.kind, ErrorKind::NotSignedIn);
                assert!(e.message.contains("Antigravity"), "{}", e.message);
            }
            e => panic!("unexpected {}", name(&e)),
        }
    }

    fn antigravity() -> Harness {
        harness_with(Arc::new(Antigravity))
    }

    /// initialize, session/new, set_mode and set_model for Antigravity; returns the prompt.
    fn start_antigravity(rt: &mut FakeRuntime, sid: &str, mode: &str) -> Value {
        init(rt);
        let new = rt.expect("session/new");
        reply(rt, &new, session_result(Some(sid), false));
        let m = rt.expect("session/set_mode");
        assert_eq!(m["params"]["modeId"], mode);
        reply(rt, &m, json!({}));
        let model = rt.expect("session/set_model");
        assert_eq!(model["params"], json!({ "sessionId": sid, "modelId": "gemini-test" }));
        reply(rt, &model, json!({}));
        rt.expect("session/prompt")
    }

    #[test]
    fn antigravity_switches_model_and_mode_on_the_live_session() {
        let h = antigravity();
        let dir = tempfile::tempdir().unwrap();
        let (sink1, ev) = sink();
        h.adapter.start_turn(request(dir.path(), Mode::Agent, None), guard(true, None), sink1).unwrap();
        let mut rt = h.runtime();
        // `autoEdit` and `yolo` approve on their own; `default` is the safe one.
        let p = start_antigravity(&mut rt, "s1", "default");
        reply(&mut rt, &p, json!({ "stopReason": "end_turn" }));
        assert_eq!(names(&ev.until_done()), vec!["session s1 false", "done Completed"]);

        // Another model and mode: the same process, switched in place.
        let (sink2, ev) = sink();
        let mut req = request(dir.path(), Mode::Plan, Some("s1"));
        req.model = "auto".into();
        req.reconfigure = true;
        h.adapter.start_turn(req, guard(true, None), sink2).unwrap();
        let model = rt.expect("session/set_model");
        assert_eq!(model["params"]["modelId"], "auto");
        reply(&mut rt, &model, json!({}));
        let m = rt.expect("session/set_mode");
        assert_eq!(m["params"]["modeId"], "default", "no plan mode offered: the safe mode");
        reply(&mut rt, &m, json!({}));
        let p = rt.expect("session/prompt");
        assert!(prompt_of(&p).starts_with("AgentHub Plan mode"));
        reply(&mut rt, &p, json!({ "stopReason": "end_turn" }));
        assert_eq!(names(&ev.until_done()), vec!["session s1 true", "done Completed"]);
        assert!(h.runtimes.try_recv().is_err(), "no restart");

        // A model the session doesn't offer fails clearly.
        let (sink3, ev) = sink();
        let mut req = request(dir.path(), Mode::Agent, Some("s1"));
        req.model = "gemini-unknown".into();
        h.adapter.start_turn(req, guard(true, None), sink3).unwrap();
        match ev.until_done().last().unwrap() {
            AgentEvent::Done(TurnOutcome::Failed(e)) => assert_eq!(e.kind, ErrorKind::ModelUnavailable),
            e => panic!("unexpected {}", name(e)),
        }
    }

    #[test]
    fn antigravity_restarts_with_the_recap_instead_of_loading() {
        let h = antigravity();
        let dir = tempfile::tempdir().unwrap();
        let (sink, ev) = sink();
        h.adapter.start_turn(request(dir.path(), Mode::Agent, Some("s-old")), guard(true, None), sink).unwrap();
        let mut rt = h.runtime();
        // Advertises loadSession, but its replay is empty: a new session is started.
        let p = start_antigravity(&mut rt, "s-new", "default");
        assert_eq!(prompt_of(&p), "RECAP\n\n---\n\nExplain main.rs");
        reply(&mut rt, &p, json!({ "stopReason": "end_turn" }));
        let events = names(&ev.until_done());
        assert_eq!(events[0], "session s-new false");
        assert!(events[1].starts_with("resume_failed Antigravity doesn't reload"), "{events:?}");
    }

    #[test]
    fn antigravity_refuses_sessions_with_only_auto_approving_modes() {
        let h = antigravity();
        let dir = tempfile::tempdir().unwrap();
        let (sink, ev) = sink();
        h.adapter.start_turn(request(dir.path(), Mode::Agent, None), guard(true, None), sink).unwrap();
        let mut rt = h.runtime();
        init(&mut rt);
        let new = rt.expect("session/new");
        reply(
            &mut rt,
            &new,
            json!({ "sessionId": "s1", "modes": { "currentModeId": "yolo", "availableModes": [{ "id": "yolo", "name": "YOLO" }] } }),
        );
        match ev.until_done().last().unwrap() {
            AgentEvent::Done(TurnOutcome::Failed(e)) => {
                assert_eq!(e.kind, ErrorKind::ModeUnsupported);
                assert!(e.message.contains("YOLO"), "{}", e.message);
            }
            e => panic!("unexpected {}", name(e)),
        }
    }

    fn tool_done(id: &str, kind: &str, title: &str, path: Option<&Path>) -> Value {
        let mut t = json!({ "sessionUpdate": "tool_call", "toolCallId": id, "status": "completed", "title": title, "kind": kind });
        if let Some(p) = path {
            t["locations"] = json!([{ "path": p }]);
        }
        t
    }

    fn failed_with(events: &[AgentEvent], kind: ErrorKind, text: &str) {
        match events.last().unwrap() {
            AgentEvent::Done(TurnOutcome::Failed(e)) => {
                assert_eq!(e.kind, kind);
                assert!(e.message.contains(text), "{}", e.message);
            }
            e => panic!("unexpected {}", name(e)),
        }
    }

    #[test]
    fn antigravity_stops_a_turn_when_a_tool_bypasses_agenthub() {
        let h = antigravity();
        let dir = tempfile::tempdir().unwrap();
        let (sink, ev) = sink();
        h.adapter.start_turn(request(dir.path(), Mode::Plan, None), guard(true, None), sink).unwrap();
        let mut rt = h.runtime();
        let p = start_antigravity(&mut rt, "s1", "default");
        // A read inside the project is fine in Plan.
        rt.send(update("s1", tool_done("r1", "read", "main.rs", Some(&dir.path().join("main.rs")))));
        // A command that ran without a permission request is not.
        rt.send(update("s1", tool_done("c1", "execute", "cargo clean", None)));
        let cancel = rt.recv();
        assert_eq!(cancel["method"], "session/cancel");
        reply(&mut rt, &p, json!({ "stopReason": "cancelled" }));
        failed_with(&ev.until_done(), ErrorKind::PermissionDenied, "Antigravity ran a command without asking AgentHub");
    }

    #[test]
    fn antigravity_ask_mode_stops_on_any_read() {
        let h = antigravity();
        let dir = tempfile::tempdir().unwrap();
        let (sink, ev) = sink();
        h.adapter.start_turn(request(dir.path(), Mode::Ask, None), guard(false, None), sink).unwrap();
        let mut rt = h.runtime();
        let p = start_antigravity(&mut rt, "s1", "default");
        rt.send(update("s1", tool_done("r1", "search", "grep TODO", Some(dir.path()))));
        assert_eq!(rt.recv()["method"], "session/cancel");
        reply(&mut rt, &p, json!({ "stopReason": "end_turn" }));
        failed_with(&ev.until_done(), ErrorKind::PermissionDenied, "searched files");
    }

    #[test]
    fn antigravity_edits_through_agenthub_pass_and_others_are_flagged() {
        let h = antigravity();
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("a.txt");
        let (sink, ev) = sink();
        h.adapter.start_turn(request(dir.path(), Mode::Agent, None), guard(true, None), sink).unwrap();
        let mut rt = h.runtime();
        let p = start_antigravity(&mut rt, "s1", "default");
        assert_eq!(name(&ev.next()), "session s1 false");

        // Allowed and written through fs/write_text_file: fine.
        let edit = json!({ "toolCallId": "e1", "status": "pending", "title": "Edit a.txt", "kind": "edit", "locations": [{ "path": file }] });
        rt.send(permission(90, "s1", edit, once_options()));
        let (_, _, answer) = take_approval(&ev);
        answer(Decision::AllowOnce);
        assert_eq!(rt.recv()["result"]["outcome"]["optionId"], "proceed_once");
        let r = call(&mut rt, 91, "fs/write_text_file", json!({ "sessionId": "s1", "path": file, "content": "b" }));
        assert_eq!(r["result"], json!({}));
        rt.send(update("s1", json!({ "sessionUpdate": "tool_call_update", "toolCallId": "e1", "status": "completed" })));
        assert_eq!(name(&ev.next()), "updated e1 Completed");

        // Allowed but written by Antigravity itself: a warning (no checkpoint).
        let other = dir.path().join("b.txt");
        let edit = json!({ "toolCallId": "e2", "status": "pending", "title": "Edit b.txt", "kind": "edit", "locations": [{ "path": other }] });
        rt.send(permission(92, "s1", edit, once_options()));
        let (_, _, answer) = take_approval(&ev);
        answer(Decision::AllowOnce);
        rt.recv();
        rt.send(update("s1", json!({ "sessionUpdate": "tool_call_update", "toolCallId": "e2", "status": "completed" })));
        assert_eq!(name(&ev.next()), "updated e2 Completed");
        assert!(name(&ev.next()).starts_with("notice Antigravity changed files itself for \"Edit b.txt\""));

        // Neither asked nor routed: the turn stops.
        rt.send(update("s1", tool_done("e3", "edit", "Edit c.txt", Some(&dir.path().join("c.txt")))));
        assert_eq!(rt.recv()["method"], "session/cancel");
        reply(&mut rt, &p, json!({ "stopReason": "cancelled" }));
        failed_with(&ev.until_done(), ErrorKind::PermissionDenied, "edited files");
    }

    #[test]
    fn antigravity_sign_in_runs_only_when_asked() {
        let h = antigravity();
        let a = Arc::new(h.adapter);
        let t = {
            let a = Arc::clone(&a);
            thread::spawn(move || a.sign_in(None))
        };
        let mut rt = h.runtimes.recv_timeout(Duration::from_secs(5)).unwrap();
        let init = rt.expect("initialize");
        reply(&mut rt, &init, json!({ "protocolVersion": 1, "authMethods": [{ "id": "oauth-personal" }, { "id": "gemini-api-key" }] }));
        let auth = rt.expect("authenticate");
        assert_eq!(auth["params"], json!({ "methodId": "oauth-personal" }));
        reply(&mut rt, &auth, json!({}));
        t.join().unwrap().unwrap();

        // Cancelled while waiting for the browser.
        let t = {
            let a = Arc::clone(&a);
            thread::spawn(move || a.sign_in(None))
        };
        let mut rt = h.runtimes.recv_timeout(Duration::from_secs(5)).unwrap();
        let init = rt.expect("initialize");
        reply(&mut rt, &init, json!({ "protocolVersion": 1, "authMethods": [{ "id": "oauth-personal" }] }));
        rt.expect("authenticate");
        a.cancel_sign_in();
        assert_eq!(t.join().unwrap().unwrap_err().kind, ErrorKind::Interrupted);

        // A server without Google sign-in says so.
        let t = {
            let a = Arc::clone(&a);
            thread::spawn(move || a.sign_in(None))
        };
        let mut rt = h.runtimes.recv_timeout(Duration::from_secs(5)).unwrap();
        let init = rt.expect("initialize");
        reply(&mut rt, &init, json!({ "protocolVersion": 1, "authMethods": [{ "id": "gemini-api-key" }] }));
        assert!(t.join().unwrap().unwrap_err().message.contains("oauth-personal"));
    }

    #[test]
    fn antigravity_turns_never_start_a_sign_in() {
        let h = antigravity();
        let dir = tempfile::tempdir().unwrap();
        let (sink, ev) = sink();
        h.adapter.start_turn(request(dir.path(), Mode::Agent, None), guard(true, None), sink).unwrap();
        let mut rt = h.runtime();
        let init = rt.expect("initialize");
        reply(&mut rt, &init, json!({ "protocolVersion": 1, "authMethods": [{ "id": "oauth-personal" }] }));
        let new = rt.expect("session/new");
        reply_err(&mut rt, &new, -32000, "Authentication required.");
        match ev.next() {
            AgentEvent::Done(TurnOutcome::Failed(e)) => {
                assert_eq!(e.kind, ErrorKind::NotSignedIn);
                assert!(e.message.contains("Sign in with Google"), "{}", e.message);
            }
            e => panic!("unexpected {}", name(&e)),
        }
    }

    #[test]
    fn routing_rules_by_mode() {
        let cwd = Path::new("C:/proj");
        let t = |kind: &str, paths: &[&str], mcp: bool| ToolState {
            kind: kind.into(),
            title: String::new(),
            paths: paths.iter().map(|p| p.to_string()).collect(),
            mcp,
            declined: false,
        };
        let inside = ["C:/proj/src/a.rs"];
        let elsewhere = ["C:/Users/me/.ssh/id_rsa"];
        assert_eq!(routing_violation(Mode::Ask, &t("read", &inside, false), false, false, cwd), Some("read files"));
        assert_eq!(routing_violation(Mode::Plan, &t("read", &inside, false), false, false, cwd), None);
        assert_eq!(routing_violation(Mode::Agent, &t("read", &elsewhere, false), false, false, cwd), Some("read files outside the project"));
        assert_eq!(routing_violation(Mode::Agent, &t("edit", &inside, false), false, true, cwd), None, "written through AgentHub");
        assert_eq!(routing_violation(Mode::Agent, &t("edit", &inside, false), false, false, cwd), Some("edited files"));
        assert_eq!(routing_violation(Mode::Agent, &t("execute", &[], false), true, false, cwd), None);
        assert_eq!(routing_violation(Mode::Agent, &t("delete", &inside, false), false, false, cwd), Some("deleted files"));
        assert_eq!(routing_violation(Mode::Plan, &t("other", &[], true), false, false, cwd), Some("used an MCP tool"));
        assert_eq!(routing_violation(Mode::Ask, &t("think", &[], false), false, false, cwd), None);
        assert_eq!(routing_violation(Mode::Plan, &t("fetch", &[], false), false, false, cwd), None);
    }
}
