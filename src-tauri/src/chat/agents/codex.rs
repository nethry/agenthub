//! OpenAI Codex adapter: drives `codex app-server` (JSON-RPC over stdio, no
//! `"jsonrpc"` field on the wire). One long-lived app-server process hosts a
//! Codex thread per AgentHub conversation; notifications and server requests
//! are routed to the running turn by `threadId` (and filtered by `turnId`).
//!
//! Permissions: Plan and Agent both run with a read-only sandbox
//! (`sandbox: "read-only"` / `sandboxPolicy: {type: "readOnly", networkAccess: false}`),
//! `approvalPolicy: "untrusted"` and `approvalsReviewer: "user"`, set on
//! `thread/start`/`thread/resume` and again on every `turn/start` (turn-level
//! overrides persist on the thread, so a mode change needs no new process:
//! the next turn simply carries the policy again). With `untrusted`, Codex asks
//! before every command that isn't on its built-in "known safe" (read-only)
//! list, and before every patch; each ask becomes an `AgentEvent::Approval`
//! that AgentHub answers by mode and policy (Plan denies them all).
//!
//! Escalation (checked in codex-rs `core/src/tools/{orchestrator,sandboxing}.rs`,
//! not in the protocol schema): an approved command first runs inside the
//! read-only sandbox; if the sandbox blocks it, Codex retries it *outside* the
//! sandbox without asking again (`should_bypass_approval` returns true once
//! approved: "We do not ask one more time"). So approving a command means
//! approving it to run unsandboxed. On Windows the sandbox only exists when
//! Codex's Windows sandbox is set up; without it commands run unsandboxed, and
//! the approval is the only gate.
//!
//! Ask mode isn't offered for Codex (its read-only commands always run); a
//! request in Ask mode fails with `ModeUnsupported`.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Weak};
use std::thread;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde_json::{json, Value};

use super::jsonrpc::{Handler, Incoming, Peer, RpcError};
use super::{AgentEvent, AgentSink, EngineAdapter, Reply, TurnHandle, TurnOutcome, TurnRequest, WriteGuard};
use crate::chat::engines::{EngineProbe, ModelInfo, ProbeState};
use crate::chat::{
    redact, ChatError, Decision, Engine, ErrorKind, ItemBody, ItemStatus, Mode, PermissionKind, PermissionRequest, PlanStep, StepStatus, ToolKind,
    Tone, Usage as TokenUsage,
};

/// The app-server can take a while to start on a cold disk.
const INIT_TIMEOUT: Duration = Duration::from_secs(60);
/// `thread/start` and `thread/resume` wait for MCP servers to start.
const THREAD_TIMEOUT: Duration = Duration::from_secs(120);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);
/// After `turn/interrupt`, how long to wait for `turn/completed` before ending the turn anyway.
const INTERRUPT_GRACE: Duration = Duration::from_secs(20);
const MAX_DETAIL: usize = 32 * 1024;
const MAX_OUTPUT: usize = 256 * 1024;

const SANDBOX: &str = "read-only";
const APPROVAL_POLICY: &str = "untrusted";

/// Starts an app-server and wires its output to `Handler` (tests pass a fake).
type Spawner = Arc<dyn Fn(&Path, Handler) -> Result<Arc<Peer>, RpcError> + Send + Sync>;

pub struct Adapter {
    core: Arc<Core>,
}

impl Adapter {
    pub fn new(usage: Arc<crate::usage::Usage>) -> Self {
        Self::with_spawner(
            usage,
            Arc::new(|exe: &Path, handler: Handler| {
                let mut cmd = super::command(exe);
                cmd.arg("app-server");
                Peer::spawn(cmd, false, handler)
            }),
        )
    }

    fn with_spawner(usage: Arc<crate::usage::Usage>, spawn: Spawner) -> Self {
        Self {
            core: Arc::new(Core {
                usage,
                spawn,
                server: Mutex::new(None),
                convs: Mutex::new(HashMap::new()),
                next_gen: AtomicU64::new(0),
            }),
        }
    }
}

impl EngineAdapter for Adapter {
    fn engine(&self) -> Engine {
        Engine::Codex
    }

    fn probe(&self, executable: Option<&Path>, _api_key: Option<&str>) -> EngineProbe {
        self.core.probe(executable)
    }

    fn start_turn(&self, req: TurnRequest, _guard: Arc<dyn WriteGuard>, sink: AgentSink) -> Result<Box<dyn TurnHandle>, ChatError> {
        // Codex applies edits itself, after an approval (which is where AgentHub checkpoints).
        if req.mode == Mode::Ask {
            return Err(ChatError::new(
                ErrorKind::ModeUnsupported,
                "Codex can't run in Ask mode: its built-in read-only commands always run. Use Plan, or a direct API.",
            ));
        }
        let exe = locate(req.executable.as_deref())?;
        let active = Arc::new(Active::new(&req, sink));
        let core = Arc::clone(&self.core);
        let a = Arc::clone(&active);
        thread::Builder::new()
            .name("codex-turn".into())
            .spawn(move || core.run(req, exe, a))
            .map_err(|e| ChatError::new(ErrorKind::RuntimeExited, format!("Couldn't start the Codex turn: {e}")))?;
        Ok(Box::new(Handle(active)))
    }

    fn close_session(&self, conversation_id: &str) {
        let Some(loaded) = self.core.convs.lock().remove(conversation_id) else { return };
        let server = self.core.server.lock().clone();
        if let Some(s) = server.filter(|s| s.gen == loaded.gen && s.peer.is_alive()) {
            unsubscribe(&s.peer, loaded.thread_id);
        }
    }

    fn shutdown(&self) {
        let server = self.core.server.lock().take();
        if let Some(s) = server {
            s.routes.stopping.store(true, Ordering::SeqCst);
            s.peer.kill();
        }
        self.core.convs.lock().clear();
    }
}

// ---------------------------------------------------------------------------
// Process, threads and turns

struct Core {
    usage: Arc<crate::usage::Usage>,
    spawn: Spawner,
    /// The live app-server; locked while one starts so turns share it.
    server: Mutex<Option<Arc<Server>>>,
    /// Conversation id → the Codex thread loaded for it.
    convs: Mutex<HashMap<String, Loaded>>,
    next_gen: AtomicU64,
}

#[derive(Clone)]
struct Loaded {
    thread_id: String,
    /// Which app-server process has it loaded.
    gen: u64,
}

struct Server {
    gen: u64,
    peer: Arc<Peer>,
    routes: Arc<Routes>,
}

/// How a turn stops before Codex reports it finished.
enum Stop {
    Cancelled,
    Failed(ChatError),
}

impl From<ChatError> for Stop {
    fn from(e: ChatError) -> Self {
        Stop::Failed(e)
    }
}

impl Core {
    fn run(&self, req: TurnRequest, exe: PathBuf, active: Arc<Active>) {
        match self.drive(&req, &exe, &active) {
            Ok(()) => {}
            Err(Stop::Cancelled) => active.finish(TurnOutcome::Cancelled),
            Err(Stop::Failed(e)) => active.finish(TurnOutcome::Failed(e)),
        }
    }

    /// Opens the thread and starts the turn; the reader thread does the rest.
    fn drive(&self, req: &TurnRequest, exe: &Path, active: &Arc<Active>) -> Result<(), Stop> {
        let server = self.server(exe)?;
        *active.peer.lock() = Some(Arc::downgrade(&server.peer));
        *active.routes.lock() = Arc::downgrade(&server.routes);
        if active.is_interrupted() {
            return Err(Stop::Cancelled);
        }
        let (thread_id, handoff) = self.open_thread(&server, req, active)?;
        *active.thread_id.lock() = Some(thread_id.clone());
        server.routes.turns.lock().insert(thread_id.clone(), Arc::clone(active));
        if active.is_interrupted() {
            return Err(Stop::Cancelled);
        }
        // Pasted images go as `data:` URLs, so Codex reads no file outside the project.
        let mut input: Vec<Value> = req.images.iter().map(|i| json!({ "type": "image", "url": i.data_url() })).collect();
        input.push(json!({ "type": "text", "text": compose_prompt(req, handoff) }));
        let mut params = json!({
            "threadId": thread_id,
            "input": input,
            "cwd": req.cwd.to_string_lossy(),
            "approvalPolicy": APPROVAL_POLICY,
            "approvalsReviewer": "user",
            "sandboxPolicy": { "type": "readOnly", "networkAccess": false },
        });
        if let Some(m) = model_override(&req.model) {
            params["model"] = json!(m);
        }
        let started = server
            .peer
            .request("turn/start", params, REQUEST_TIMEOUT)
            .map_err(|e| rpc_error(&server.peer, "start the turn", e))?;
        if let Some(id) = started["turn"]["id"].as_str() {
            active.adopt_turn(id);
        }
        if active.is_interrupted() {
            active.send_interrupt();
        }
        Ok(())
    }

    /// The running app-server, started (and initialized) when there is none.
    fn server(&self, exe: &Path) -> Result<Arc<Server>, ChatError> {
        let mut slot = self.server.lock();
        if let Some(s) = slot.as_ref().filter(|s| s.peer.is_alive()) {
            return Ok(Arc::clone(s));
        }
        if let Some(old) = slot.take() {
            old.peer.kill();
        }
        let routes = Arc::new(Routes::new(Arc::clone(&self.usage)));
        let r = Arc::clone(&routes);
        let handler: Handler = Arc::new(move |peer, msg| r.handle(peer, msg));
        let peer = (self.spawn)(exe, handler)
            .map_err(|e| ChatError::new(ErrorKind::RuntimeExited, format!("Couldn't start Codex: {}", redact(&e.to_string(), None))))?;
        if let Err(e) = handshake(&peer) {
            let err = rpc_error(&peer, "start", e);
            peer.kill();
            return Err(err);
        }
        let server = Arc::new(Server { gen: self.next_gen.fetch_add(1, Ordering::SeqCst) + 1, peer, routes });
        *slot = Some(Arc::clone(&server));
        Ok(server)
    }

    /// The conversation's thread: the one already loaded, a resumed one, or a
    /// new one. Returns its id and whether the handoff text must be prepended.
    fn open_thread(&self, server: &Server, req: &TurnRequest, active: &Active) -> Result<(String, bool), Stop> {
        let peer = &server.peer;
        let loaded = self.convs.lock().get(&req.conversation_id).cloned().filter(|l| l.gen == server.gen);
        let closed = |id: &str| server.routes.closed_threads.lock().contains(id);
        if let (Some(l), Some(sid)) = (&loaded, &req.runtime_session_id) {
            if &l.thread_id == sid && !closed(sid) {
                active.emit(AgentEvent::Session { id: sid.clone(), resumed: true });
                return Ok((sid.clone(), false));
            }
        }
        // Another thread of this conversation is loaded in this process: let it go.
        if let Some(l) = loaded {
            unsubscribe(peer, l.thread_id);
        }
        let overrides = thread_overrides(req);
        let mut resume_error = None;
        if let Some(sid) = &req.runtime_session_id {
            let mut params = overrides.clone();
            params["threadId"] = json!(sid);
            params["excludeTurns"] = json!(true);
            match peer.request("thread/resume", params, THREAD_TIMEOUT) {
                Ok(v) => {
                    let id = v["thread"]["id"].as_str().unwrap_or(sid).to_string();
                    self.remember(&req.conversation_id, &id, server.gen);
                    active.emit(AgentEvent::Session { id: id.clone(), resumed: true });
                    return Ok((id, false));
                }
                Err(RpcError::Remote { message, .. }) => resume_error = Some(redact(&message, None)),
                Err(e) => return Err(rpc_error(peer, "resume the session", e).into()),
            }
        }
        if active.is_interrupted() {
            return Err(Stop::Cancelled);
        }
        let v = peer.request("thread/start", overrides, THREAD_TIMEOUT).map_err(|e| rpc_error(peer, "start a session", e))?;
        let id = v["thread"]["id"]
            .as_str()
            .ok_or_else(|| ChatError::new(ErrorKind::Malformed, "Codex started a session without an id."))?
            .to_string();
        self.remember(&req.conversation_id, &id, server.gen);
        let handoff = resume_error.is_some();
        if let Some(message) = resume_error {
            active.emit(AgentEvent::ResumeFailed { message });
        }
        active.emit(AgentEvent::Session { id: id.clone(), resumed: false });
        Ok((id, handoff))
    }

    fn remember(&self, conversation_id: &str, thread_id: &str, gen: u64) {
        self.convs.lock().insert(conversation_id.to_string(), Loaded { thread_id: thread_id.to_string(), gen });
    }

    fn probe(&self, executable: Option<&Path>) -> EngineProbe {
        let exe = match locate(executable) {
            Ok(p) => p,
            Err(e) => return EngineProbe::new(Engine::Codex, ProbeState::NotFound, Some(e.message)),
        };
        let mut probe = EngineProbe::new(Engine::Codex, ProbeState::Ready, None);
        probe.path = Some(exe.to_string_lossy().to_string());
        probe.version = super::version_of(&exe, &["--version"]).map(|v| v.trim_start_matches("codex-cli").trim().to_string());
        let usage = Arc::clone(&self.usage);
        let handler: Handler = Arc::new(move |peer, msg| match msg {
            Incoming::Notification { method, params } if method == "account/rateLimits/updated" => usage.update_openai(&params["rateLimits"]),
            Incoming::Request { id, .. } => {
                let _ = peer.respond_error(id, -32601, "AgentHub is only checking Codex's status");
            }
            _ => {}
        });
        let peer = match (self.spawn)(&exe, handler) {
            Ok(p) => p,
            Err(e) => {
                probe.state = ProbeState::Error;
                probe.message = Some(format!("Couldn't start Codex: {}", redact(&e.to_string(), None)));
                return probe;
            }
        };
        let result = probe_session(&peer, &mut probe);
        if let Err(e) = result {
            probe.state = ProbeState::Error;
            probe.message = Some(rpc_error(&peer, "answer", e).message);
        }
        peer.kill();
        probe
    }
}

fn probe_session(peer: &Peer, probe: &mut EngineProbe) -> Result<(), RpcError> {
    handshake(peer)?;
    let account = peer.request("account/read", json!({ "refreshToken": false }), REQUEST_TIMEOUT)?;
    let (label, signed_in) = account_label(&account);
    probe.account = label;
    if !signed_in {
        probe.state = ProbeState::SignInNeeded;
        probe.message = Some("Codex isn't signed in. Run `codex login` in a terminal (or sign in to the Codex app), then recheck.".into());
        return Ok(());
    }
    let mut cursor: Option<String> = None;
    for _ in 0..5 {
        let mut params = json!({ "limit": 100, "includeHidden": false });
        if let Some(c) = &cursor {
            params["cursor"] = json!(c);
        }
        let page = peer.request("model/list", params, REQUEST_TIMEOUT)?;
        probe.models.extend(models(&page));
        cursor = page["nextCursor"].as_str().map(str::to_string);
        if cursor.is_none() {
            break;
        }
    }
    Ok(())
}

/// "ChatGPT · pro", "API key", …; never the email. Second value: signed in.
fn account_label(result: &Value) -> (Option<String>, bool) {
    let account = &result["account"];
    if account.is_null() {
        return (None, !result["requiresOpenaiAuth"].as_bool().unwrap_or(true));
    }
    let label = match account["type"].as_str() {
        Some("chatgpt") => Some(match account["planType"].as_str().filter(|p| !p.is_empty() && *p != "unknown") {
            Some(plan) => format!("ChatGPT · {plan}"),
            None => "ChatGPT account".to_string(),
        }),
        Some("apiKey") => Some("API key".to_string()),
        Some("amazonBedrock") => Some("Amazon Bedrock".to_string()),
        _ => None,
    };
    (label, true)
}

fn models(page: &Value) -> Vec<ModelInfo> {
    page["data"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|m| !m["hidden"].as_bool().unwrap_or(false))
        .filter_map(|m| {
            let id = m["model"].as_str().or_else(|| m["id"].as_str())?.to_string();
            Some(ModelInfo {
                label: m["displayName"].as_str().filter(|s| !s.is_empty()).unwrap_or(&id).to_string(),
                is_default: m["isDefault"].as_bool().unwrap_or(false),
                id,
            })
        })
        .collect()
}

fn handshake(peer: &Peer) -> Result<Value, RpcError> {
    let result = peer.request(
        "initialize",
        json!({
            "clientInfo": { "name": "agenthub", "title": "AgentHub", "version": env!("CARGO_PKG_VERSION") },
            "capabilities": { "experimentalApi": false },
        }),
        INIT_TIMEOUT,
    )?;
    peer.notify("initialized", json!({}))?;
    Ok(result)
}

fn unsubscribe(peer: &Arc<Peer>, thread_id: String) {
    let peer = Arc::clone(peer);
    thread::spawn(move || {
        let _ = peer.request("thread/unsubscribe", json!({ "threadId": thread_id }), REQUEST_TIMEOUT);
    });
}

fn model_override(model: &str) -> Option<&str> {
    let m = model.trim();
    (!m.is_empty() && m != "default").then_some(m)
}

fn thread_overrides(req: &TurnRequest) -> Value {
    let mut v = json!({
        "cwd": req.cwd.to_string_lossy(),
        "approvalPolicy": APPROVAL_POLICY,
        "approvalsReviewer": "user",
        "sandbox": SANDBOX,
    });
    if let Some(m) = model_override(&req.model) {
        v["model"] = json!(m);
    }
    v
}

fn compose_prompt(req: &TurnRequest, handoff: bool) -> String {
    let mut text = String::new();
    if req.mode == Mode::Plan {
        if let Some(i) = super::mode_instructions(Mode::Plan) {
            text.push_str(i);
            text.push_str("\n\n");
        }
    }
    if handoff {
        if let Some(h) = &req.handoff {
            text.push_str(h);
        }
    }
    text.push_str(&req.prompt);
    text
}

/// Settings override, then `codex` on PATH, then the Codex app's bundled CLI.
/// `.cmd`/`.bat` shims are skipped (they only run through cmd.exe); for an npm
/// shim the package's native `codex.exe` is used when present.
fn locate(override_path: Option<&Path>) -> Result<PathBuf, ChatError> {
    let candidates = [super::locate("codex", override_path), crate::usage::codex::locate(None)];
    let mut shim = None;
    for c in candidates.into_iter().flatten() {
        if !super::is_shell_shim(&c) {
            return Ok(c);
        }
        if let Some(native) = npm_native(&c) {
            return Ok(native);
        }
        shim.get_or_insert(c);
    }
    Err(ChatError::new(
        ErrorKind::EngineNotFound,
        match shim {
            Some(s) => format!(
                "Codex was found only as a script shim ({}), which AgentHub doesn't run through cmd.exe. Set the path to codex.exe in Settings › AI integrations.",
                s.display()
            ),
            None => "Codex CLI wasn't found. Install Codex (or the Codex app), or set its path in Settings › AI integrations.".into(),
        },
    ))
}

/// `…\npm\codex.cmd` → `…\npm\node_modules\@openai\codex\vendor\<target>\codex\codex.exe`.
fn npm_native(shim: &Path) -> Option<PathBuf> {
    let vendor = shim.parent()?.join("node_modules").join("@openai").join("codex").join("vendor");
    std::fs::read_dir(vendor)
        .ok()?
        .flatten()
        .map(|e| e.path().join("codex").join("codex.exe"))
        .find(|p| p.is_file())
}

// ---------------------------------------------------------------------------
// Routing (runs on the peer's reader thread)

struct Routes {
    usage: Arc<crate::usage::Usage>,
    /// Thread id → its running turn.
    turns: Mutex<HashMap<String, Arc<Active>>>,
    /// Threads Codex closed (`thread/closed`); resumed again on the next turn.
    closed_threads: Mutex<HashSet<String>>,
    /// `shutdown` killed the process on purpose.
    stopping: AtomicBool,
}

impl Routes {
    fn new(usage: Arc<crate::usage::Usage>) -> Self {
        Self {
            usage,
            turns: Mutex::new(HashMap::new()),
            closed_threads: Mutex::new(HashSet::new()),
            stopping: AtomicBool::new(false),
        }
    }

    fn handle(&self, peer: &Arc<Peer>, msg: Incoming) {
        match msg {
            Incoming::Notification { method, params } => self.notification(&method, &params),
            Incoming::Request { id, method, params } => self.request(peer, id, &method, &params),
            Incoming::Closed => self.closed(peer),
        }
    }

    /// The running turn a message belongs to; `None` for unknown threads and
    /// for late messages of an earlier turn.
    fn active(&self, params: &Value) -> Option<Arc<Active>> {
        let thread = params["threadId"].as_str()?;
        let active = self.turns.lock().get(thread).cloned()?;
        let turn = params["turnId"].as_str().or_else(|| params["turn"]["id"].as_str());
        if let (Some(t), Some(ours)) = (turn, active.turn_id.lock().as_deref()) {
            if t != ours {
                return None;
            }
        }
        Some(active)
    }

    fn notification(&self, method: &str, params: &Value) {
        match method {
            "account/rateLimits/updated" => self.usage.update_openai(&params["rateLimits"]),
            "thread/closed" => {
                let Some(thread) = params["threadId"].as_str() else { return };
                self.closed_threads.lock().insert(thread.to_string());
                let active = self.turns.lock().get(thread).cloned();
                if let Some(a) = active {
                    a.finish(TurnOutcome::Failed(ChatError::new(ErrorKind::RuntimeExited, "Codex closed this conversation's session.")));
                }
            }
            _ => {
                if let Some(a) = self.active(params) {
                    a.notification(method, params);
                }
            }
        }
    }

    fn request(&self, peer: &Arc<Peer>, id: Value, method: &str, params: &Value) {
        let active = self.active(params);
        let notice = |what: &str| {
            if let Some(a) = &active {
                a.emit(AgentEvent::Notice { text: format!("Codex asked for {what}; AgentHub declined (not supported)."), tone: Tone::Info });
            }
        };
        let answer = match method {
            "item/commandExecution/requestApproval" | "item/fileChange/requestApproval" => match &active {
                Some(a) => return a.approval(peer, id, method, params),
                None => json!({ "decision": "decline" }),
            },
            "item/permissions/requestApproval" => {
                notice("extra permissions");
                json!({ "permissions": {}, "scope": "turn" })
            }
            "item/tool/requestUserInput" => {
                notice("input");
                decline_user_input(params)
            }
            "mcpServer/elicitation/request" => {
                notice("input for an MCP server");
                json!({ "action": "decline", "content": null })
            }
            "item/tool/call" => json!({
                "contentItems": [{ "type": "inputText", "text": "AgentHub doesn't provide this tool." }],
                "success": false,
            }),
            "execCommandApproval" | "applyPatchApproval" => {
                json!({ "decision": { "denied": { "rejection": "AgentHub only answers v2 approval requests." } } })
            }
            _ => {
                let _ = peer.respond_error(id, -32601, "AgentHub doesn't handle this request");
                return;
            }
        };
        let _ = peer.respond(id, answer);
    }

    fn closed(&self, peer: &Arc<Peer>) {
        let turns: Vec<Arc<Active>> = self.turns.lock().drain().map(|(_, a)| a).collect();
        if turns.is_empty() {
            return;
        }
        if self.stopping.load(Ordering::SeqCst) {
            for a in turns {
                a.finish(TurnOutcome::Cancelled);
            }
            return;
        }
        // Give the process a moment to exit, so its code and last stderr lines are known.
        let deadline = Instant::now() + Duration::from_millis(300);
        while peer.exit_code().is_none() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(30));
        }
        let err = exited_error(peer);
        for a in turns {
            a.finish(TurnOutcome::Failed(err.clone()));
        }
    }
}

/// Answers `item/tool/requestUserInput` with each question's decline option
/// (MCP tool approvals arrive this way), or nothing.
fn decline_user_input(params: &Value) -> Value {
    let mut answers = serde_json::Map::new();
    for q in params["questions"].as_array().into_iter().flatten() {
        let Some(id) = q["id"].as_str() else { continue };
        let decline = q["options"].as_array().into_iter().flatten().filter_map(|o| o["label"].as_str()).find(|l| {
            let l = l.to_ascii_lowercase();
            ["decline", "deny", "cancel", "reject", "no"].iter().any(|w| l.starts_with(w))
        });
        answers.insert(id.to_string(), json!({ "answers": decline.into_iter().collect::<Vec<_>>() }));
    }
    json!({ "answers": answers })
}

// ---------------------------------------------------------------------------
// One running turn

struct Active {
    cwd: PathBuf,
    sink: AgentSink,
    thread_id: Mutex<Option<String>>,
    turn_id: Mutex<Option<String>>,
    peer: Mutex<Option<Weak<Peer>>>,
    routes: Mutex<Weak<Routes>>,
    done: AtomicBool,
    interrupted: AtomicBool,
    st: Mutex<ActiveState>,
}

#[derive(Default)]
struct ActiveState {
    /// fileChange item id → its `changes` (from `item/started` / `patchUpdated`).
    changes: HashMap<String, Vec<Value>>,
    /// Items whose text arrived as deltas (their completed text isn't repeated).
    streamed: HashSet<String>,
    /// Approval requests sent to AgentHub, with "already answered" flags.
    pending: Vec<(Value, Arc<AtomicBool>)>,
    /// Thread token totals before this turn (input, output).
    usage_base: Option<(i64, i64)>,
    last_error: Option<ChatError>,
}

impl Active {
    fn new(req: &TurnRequest, sink: AgentSink) -> Self {
        Self {
            cwd: req.cwd.clone(),
            sink,
            thread_id: Mutex::new(None),
            turn_id: Mutex::new(None),
            peer: Mutex::new(None),
            routes: Mutex::new(Weak::new()),
            done: AtomicBool::new(false),
            interrupted: AtomicBool::new(false),
            st: Mutex::new(ActiveState::default()),
        }
    }

    fn emit(&self, ev: AgentEvent) {
        if !self.done.load(Ordering::SeqCst) {
            (self.sink)(ev);
        }
    }

    fn is_interrupted(&self) -> bool {
        self.interrupted.load(Ordering::SeqCst)
    }

    fn peer(&self) -> Option<Arc<Peer>> {
        self.peer.lock().as_ref().and_then(Weak::upgrade)
    }

    fn adopt_turn(&self, id: &str) {
        let mut t = self.turn_id.lock();
        if t.is_none() {
            *t = Some(id.to_string());
        }
    }

    /// Ends the turn once: unregisters it, cancels unanswered approvals, emits `Done`.
    fn finish(&self, outcome: TurnOutcome) {
        if self.done.swap(true, Ordering::SeqCst) {
            return;
        }
        let routes = self.routes.lock().upgrade();
        let thread = self.thread_id.lock().clone();
        if let (Some(r), Some(t)) = (routes, thread) {
            let mut turns = r.turns.lock();
            if turns.get(&t).is_some_and(|a| std::ptr::eq(Arc::as_ptr(a), self)) {
                turns.remove(&t);
            }
        }
        self.cancel_pending();
        (self.sink)(AgentEvent::Done(outcome));
    }

    /// Answers every approval AgentHub hasn't answered yet with "cancel".
    fn cancel_pending(&self) {
        let pending = std::mem::take(&mut self.st.lock().pending);
        let peer = self.peer();
        for (id, answered) in pending {
            if !answered.swap(true, Ordering::SeqCst) {
                if let Some(p) = &peer {
                    let _ = p.respond(id, json!({ "decision": "cancel" }));
                }
            }
        }
    }

    /// `turn/interrupt`, once the turn id is known (blocking).
    fn send_interrupt(&self) {
        let Some(peer) = self.peer() else { return };
        let thread = self.thread_id.lock().clone();
        let turn = self.turn_id.lock().clone();
        if let (Some(thread), Some(turn)) = (thread, turn) {
            let _ = peer.request("turn/interrupt", json!({ "threadId": thread, "turnId": turn }), REQUEST_TIMEOUT);
        }
    }

    fn notification(&self, method: &str, p: &Value) {
        let item_id = || p["itemId"].as_str().unwrap_or_default().to_string();
        match method {
            "turn/started" => {
                if let Some(id) = p["turn"]["id"].as_str() {
                    self.adopt_turn(id);
                }
            }
            "item/agentMessage/delta" => {
                let delta = p["delta"].as_str().unwrap_or_default();
                if !delta.is_empty() {
                    self.st.lock().streamed.insert(item_id());
                    self.emit(AgentEvent::Text { text: delta.to_string() });
                }
            }
            "item/reasoning/summaryTextDelta" => {
                let delta = p["delta"].as_str().unwrap_or_default();
                if !delta.is_empty() {
                    self.st.lock().streamed.insert(item_id());
                    self.emit(AgentEvent::Thinking { text: delta.to_string() });
                }
            }
            "item/reasoning/summaryPartAdded" => {
                if p["summaryIndex"].as_i64().unwrap_or(0) > 0 {
                    self.emit(AgentEvent::Thinking { text: "\n\n".into() });
                }
            }
            "item/commandExecution/outputDelta" => {
                let text = strip_ansi(p["delta"].as_str().unwrap_or_default());
                if !text.is_empty() {
                    self.emit(AgentEvent::Output { key: item_id(), text });
                }
            }
            "item/fileChange/patchUpdated" => {
                if let Some(changes) = p["changes"].as_array() {
                    self.st.lock().changes.insert(item_id(), changes.clone());
                }
            }
            "item/started" => self.item_started(&p["item"]),
            "item/completed" => self.item_completed(&p["item"]),
            "turn/plan/updated" => {
                let steps = p["plan"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(|s| PlanStep {
                        text: s["step"].as_str().unwrap_or_default().to_string(),
                        status: match s["status"].as_str() {
                            Some("completed") => StepStatus::Completed,
                            Some("inProgress") => StepStatus::InProgress,
                            _ => StepStatus::Pending,
                        },
                    })
                    .collect();
                let explanation = p["explanation"].as_str().filter(|s| !s.trim().is_empty()).map(str::to_string);
                self.emit(AgentEvent::Plan { steps, explanation });
            }
            "thread/tokenUsage/updated" => self.token_usage(&p["tokenUsage"]),
            "error" => {
                let err = turn_error(&p["error"]);
                if p["willRetry"].as_bool().unwrap_or(false) {
                    self.emit(AgentEvent::Notice { text: format!("{} Codex is retrying.", err.message), tone: Tone::Warn });
                } else {
                    self.st.lock().last_error = Some(err);
                }
            }
            "warning" => {
                if let Some(m) = p["message"].as_str() {
                    self.emit(AgentEvent::Notice { text: format!("Codex: {}", redact(m, None)), tone: Tone::Warn });
                }
            }
            "model/rerouted" => {
                let (from, to) = (p["fromModel"].as_str().unwrap_or("?"), p["toModel"].as_str().unwrap_or("?"));
                self.emit(AgentEvent::Notice { text: format!("Codex switched this turn from {from} to {to}."), tone: Tone::Info });
            }
            "turn/completed" => self.completed(&p["turn"]),
            _ => {}
        }
    }

    fn item_started(&self, item: &Value) {
        let Some(id) = item["id"].as_str().map(str::to_string) else { return };
        let body = match item["type"].as_str().unwrap_or_default() {
            "commandExecution" => command_body(item),
            "fileChange" => {
                let changes = item["changes"].as_array().cloned().unwrap_or_default();
                let body = file_body(&self.cwd, &changes);
                self.st.lock().changes.insert(id.clone(), changes);
                body
            }
            "mcpToolCall" | "webSearch" | "imageView" | "dynamicToolCall" => tool_body(item, &self.cwd),
            _ => return,
        };
        self.emit(AgentEvent::ItemStarted { key: id, status: ItemStatus::Running, body });
    }

    fn item_completed(&self, item: &Value) {
        let Some(id) = item["id"].as_str().map(str::to_string) else { return };
        let status = item_status(item);
        match item["type"].as_str().unwrap_or_default() {
            "agentMessage" => {
                let streamed = self.st.lock().streamed.remove(&id);
                if let Some(text) = item["text"].as_str().filter(|t| !streamed && !t.is_empty()) {
                    self.emit(AgentEvent::Text { text: text.to_string() });
                }
                self.emit(AgentEvent::TextBreak);
            }
            "reasoning" => {
                let streamed = self.st.lock().streamed.remove(&id);
                let summary: Vec<&str> = item["summary"].as_array().into_iter().flatten().filter_map(Value::as_str).collect();
                if !streamed && !summary.is_empty() {
                    self.emit(AgentEvent::Thinking { text: summary.join("\n\n") });
                }
            }
            "commandExecution" => self.emit(AgentEvent::ItemUpdated { key: id, status, body: command_body(item) }),
            "fileChange" => {
                let changes = item["changes"].as_array().cloned().unwrap_or_default();
                self.emit(AgentEvent::ItemUpdated { key: id, status, body: file_body(&self.cwd, &changes) });
            }
            "mcpToolCall" | "webSearch" | "imageView" | "dynamicToolCall" => {
                self.emit(AgentEvent::ItemUpdated { key: id, status, body: tool_body(item, &self.cwd) })
            }
            "contextCompaction" => self.emit(AgentEvent::Notice {
                text: "Codex compacted this conversation to fit its context window.".into(),
                tone: Tone::Info,
            }),
            _ => {}
        }
    }

    /// Usage for this turn: the thread's running totals minus the totals before
    /// the turn's first model request (robust to repeated readings).
    fn token_usage(&self, u: &Value) {
        let n = |v: &Value, k: &str| v[k].as_i64().unwrap_or(0);
        let (ti, to) = (n(&u["total"], "inputTokens"), n(&u["total"], "outputTokens"));
        let (li, lo) = (n(&u["last"], "inputTokens"), n(&u["last"], "outputTokens"));
        let base = *self.st.lock().usage_base.get_or_insert((ti - li, to - lo));
        self.emit(AgentEvent::Usage(TokenUsage {
            input_tokens: Some((ti - base.0).max(0) as u64),
            output_tokens: Some((to - base.1).max(0) as u64),
            cost_usd: None,
        }));
    }

    fn completed(&self, turn: &Value) {
        let status = turn["status"].as_str().unwrap_or("completed");
        let outcome = if self.is_interrupted() && status != "completed" {
            TurnOutcome::Cancelled
        } else {
            match status {
                "interrupted" => TurnOutcome::Cancelled,
                "failed" => {
                    let last = self.st.lock().last_error.take();
                    let err = match &turn["error"] {
                        e if e.is_object() => turn_error(e),
                        _ => last.unwrap_or_else(|| ChatError::new(ErrorKind::ProviderError, "Codex couldn't finish this turn.")),
                    };
                    TurnOutcome::Failed(err)
                }
                _ => TurnOutcome::Completed,
            }
        };
        self.finish(outcome);
    }

    fn approval(&self, peer: &Arc<Peer>, id: Value, method: &str, p: &Value) {
        let item_id = p["itemId"].as_str().unwrap_or_default().to_string();
        let is_file = method == "item/fileChange/requestApproval";
        let request = if is_file { self.file_request(&item_id, p) } else { command_request(p) };
        let key = p["approvalId"].as_str().map(str::to_string).unwrap_or(item_id);
        let answered = Arc::new(AtomicBool::new(false));
        self.st.lock().pending.push((id.clone(), Arc::clone(&answered)));
        if self.is_interrupted() || self.done.load(Ordering::SeqCst) {
            answered.store(true, Ordering::SeqCst);
            let _ = peer.respond(id, json!({ "decision": "cancel" }));
            return;
        }
        let weak = Arc::downgrade(peer);
        let reply: Reply = Box::new(move |d| {
            if answered.swap(true, Ordering::SeqCst) {
                return;
            }
            if let Some(p) = weak.upgrade() {
                let _ = p.respond(id, json!({ "decision": decision_word(d, is_file) }));
            }
        });
        self.emit(AgentEvent::Approval { key, request, reply });
    }

    fn file_request(&self, item_id: &str, p: &Value) -> PermissionRequest {
        let changes = self.st.lock().changes.get(item_id).cloned().unwrap_or_default();
        let mut paths = change_paths(&self.cwd, &changes);
        let mut detail: Vec<String> = p["reason"].as_str().filter(|r| !r.trim().is_empty()).map(|r| redact(r, None)).into_iter().collect();
        if let Some(root) = p["grantRoot"].as_str() {
            paths.push(absolute(&self.cwd, root).to_string_lossy().to_string());
            detail.push(format!("Codex also asks to write anywhere under {root} for this session."));
        }
        let detail = (!detail.is_empty()).then(|| detail.join("\n"));
        if changes.is_empty() {
            // Unknown files: never let a policy auto-approve this as an in-project edit.
            return PermissionRequest {
                kind: PermissionKind::Other,
                title: "Apply a patch (files not reported)".into(),
                command: None,
                path: paths.first().cloned(),
                paths,
                detail,
                can_allow_session: false,
            };
        }
        let all_deletes = changes.iter().all(|c| c["kind"]["type"] == "delete");
        let verb = if all_deletes {
            "Delete"
        } else if changes.iter().all(|c| c["kind"]["type"] == "add") {
            "Create"
        } else {
            "Edit"
        };
        let title = match changes.len() {
            1 => format!("{verb} {}", display_path(&self.cwd, Path::new(&paths[0]))),
            n => format!("{verb} {n} files"),
        };
        PermissionRequest {
            kind: if all_deletes { PermissionKind::Delete } else { PermissionKind::Write },
            title,
            command: None,
            path: paths.first().cloned(),
            paths,
            detail,
            // "acceptForSession" would let Codex skip later approvals for these
            // files, so AgentHub couldn't checkpoint them: offer only once.
            can_allow_session: false,
        }
    }
}

struct Handle(Arc<Active>);

impl TurnHandle for Handle {
    fn interrupt(&self) {
        let a = Arc::clone(&self.0);
        if a.interrupted.swap(true, Ordering::SeqCst) || a.done.load(Ordering::SeqCst) {
            return;
        }
        a.cancel_pending();
        thread::spawn(move || {
            match a.peer() {
                Some(p) if !p.is_alive() => return a.finish(TurnOutcome::Cancelled),
                // Not started yet: `drive` sees the flag (and interrupts once the turn id is known).
                None => {}
                Some(_) => a.send_interrupt(),
            }
            let deadline = Instant::now() + INTERRUPT_GRACE;
            while !a.done.load(Ordering::SeqCst) && Instant::now() < deadline {
                thread::sleep(Duration::from_millis(50));
            }
            a.finish(TurnOutcome::Cancelled);
        });
    }
}

// ---------------------------------------------------------------------------
// Mapping helpers

fn command_request(p: &Value) -> PermissionRequest {
    let command = p["command"].as_str().filter(|c| !c.trim().is_empty()).map(str::to_string);
    let reason = p["reason"].as_str().filter(|r| !r.trim().is_empty()).map(|r| redact(r, None));
    let net = &p["networkApprovalContext"];
    if net.is_object() {
        let host = net["host"].as_str().unwrap_or("an unknown host");
        let protocol = net["protocol"].as_str().unwrap_or_default();
        let target = if protocol.is_empty() { host.to_string() } else { format!("{host} ({protocol})") };
        return PermissionRequest {
            kind: PermissionKind::Network,
            title: format!("Allow network access to {target}"),
            command,
            path: None,
            paths: vec![],
            detail: reason,
            can_allow_session: true,
        };
    }
    let title = if p["kind"] == "writeStdin" { "Send input to a running command" } else { "Run a command" };
    let cwd = p["cwd"].as_str().map(|c| format!("In {c}"));
    let detail = [reason, cwd].into_iter().flatten().collect::<Vec<_>>().join("\n");
    PermissionRequest {
        kind: PermissionKind::Command,
        title: title.into(),
        command,
        path: None,
        paths: vec![],
        detail: (!detail.is_empty()).then_some(detail),
        can_allow_session: true,
    }
}

fn decision_word(d: Decision, is_file: bool) -> &'static str {
    match d {
        Decision::AllowOnce => "accept",
        // See `file_request`: file changes are approved one at a time.
        Decision::AllowSession if is_file => "accept",
        Decision::AllowSession => "acceptForSession",
        Decision::Deny => "decline",
        Decision::Cancel => "cancel",
    }
}

fn item_status(item: &Value) -> ItemStatus {
    match item["status"].as_str() {
        Some("inProgress") => ItemStatus::Running,
        Some("failed") => ItemStatus::Failed,
        Some("declined") => ItemStatus::Declined,
        _ => ItemStatus::Completed,
    }
}

fn command_body(item: &Value) -> ItemBody {
    ItemBody::Command {
        command: item["command"].as_str().unwrap_or_default().to_string(),
        cwd: item["cwd"].as_str().map(str::to_string),
        output: clip(&strip_ansi(item["aggregatedOutput"].as_str().unwrap_or_default()), MAX_OUTPUT),
        exit_code: item["exitCode"].as_i64().map(|c| c as i32),
        duration_ms: item["durationMs"].as_u64(),
    }
}

fn file_body(cwd: &Path, changes: &[Value]) -> ItemBody {
    let paths = change_paths(cwd, changes);
    let title = paths.iter().map(|p| display_path(cwd, Path::new(p))).collect::<Vec<_>>().join(", ");
    let diff = changes.iter().filter_map(|c| c["diff"].as_str()).filter(|d| !d.is_empty()).collect::<Vec<_>>().join("\n");
    let all_deletes = !changes.is_empty() && changes.iter().all(|c| c["kind"]["type"] == "delete");
    ItemBody::Tool {
        tool: if all_deletes { ToolKind::Delete } else { ToolKind::Edit },
        title: if title.is_empty() { "Apply a patch".into() } else { title },
        detail: (!diff.is_empty()).then(|| clip(&diff, MAX_DETAIL)),
        result: None,
    }
}

fn tool_body(item: &Value, cwd: &Path) -> ItemBody {
    let s = |k: &str| item[k].as_str().unwrap_or_default().to_string();
    let (tool, title, detail, result) = match item["type"].as_str().unwrap_or_default() {
        "mcpToolCall" => {
            let args = (!item["arguments"].is_null()).then(|| clip(&item["arguments"].to_string(), MAX_DETAIL));
            let result = match &item["error"] {
                e if e.is_object() => e["message"].as_str().map(|m| redact(m, None)),
                _ => item["result"]["content"].as_array().map(|c| {
                    clip(&c.iter().filter_map(|x| x["text"].as_str()).collect::<Vec<_>>().join("\n"), MAX_DETAIL)
                }),
            };
            (ToolKind::Mcp, format!("{} · {}", s("server"), s("tool")), args, result.filter(|r| !r.is_empty()))
        }
        "webSearch" => (ToolKind::Fetch, format!("Web search: {}", s("query")).trim_end_matches([':', ' ']).to_string(), None, None),
        "imageView" => (ToolKind::Read, display_path(cwd, Path::new(&s("path"))), None, None),
        _ => (ToolKind::Other, s("tool"), None, None),
    };
    ItemBody::Tool { tool, title, detail, result }
}

/// Absolute paths a patch touches (move destinations included).
fn change_paths(cwd: &Path, changes: &[Value]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for c in changes {
        let targets = [c["path"].as_str(), c["kind"]["move_path"].as_str()];
        for p in targets.into_iter().flatten().filter(|p| !p.is_empty()) {
            let abs = absolute(cwd, p).to_string_lossy().to_string();
            if !out.contains(&abs) {
                out.push(abs);
            }
        }
    }
    out
}

/// `p` resolved against `cwd`, with separators normalized.
fn absolute(cwd: &Path, p: &str) -> PathBuf {
    let path = Path::new(p);
    let joined = if path.is_absolute() { path.to_path_buf() } else { cwd.join(path) };
    joined.components().collect()
}

fn display_path(cwd: &Path, p: &Path) -> String {
    p.strip_prefix(cwd)
        .map(|r| r.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| p.to_string_lossy().to_string())
}

/// A failed turn's `TurnError`, normalized.
fn turn_error(err: &Value) -> ChatError {
    let message = redact(err["message"].as_str().unwrap_or("Codex couldn't finish this turn."), None);
    let info = &err["codexErrorInfo"];
    let kind = match info {
        Value::String(s) => match s.as_str() {
            "unauthorized" => ErrorKind::NotSignedIn,
            "usageLimitExceeded" | "rateLimitExceeded" => ErrorKind::RateLimited,
            "contextWindowExceeded" => ErrorKind::ContextTooLong,
            "serverOverloaded" => ErrorKind::Overloaded,
            _ => ErrorKind::ProviderError,
        },
        Value::Object(o) if ["httpConnectionFailed", "responseStreamConnectionFailed", "responseStreamDisconnected"].iter().any(|k| o.contains_key(*k)) => {
            ErrorKind::Network
        }
        _ => ErrorKind::ProviderError,
    };
    let text = match kind {
        ErrorKind::NotSignedIn => "Codex isn't signed in, or its sign-in expired. Run `codex login` in a terminal, then try again.".to_string(),
        ErrorKind::RateLimited => format!("Codex usage limit reached: {message}"),
        ErrorKind::ContextTooLong => "This conversation no longer fits Codex's context window. Start a new conversation.".to_string(),
        ErrorKind::Network => format!("Codex couldn't reach OpenAI: {message}"),
        _ => format!("Codex: {message}"),
    };
    let status = info.as_object().and_then(|o| o.values().find_map(|v| v["httpStatusCode"].as_u64())).map(|s| s as u16);
    let e = ChatError::new(kind, text);
    match status {
        Some(s) => e.with_status(s),
        None => e,
    }
}

fn rpc_error(peer: &Peer, what: &str, e: RpcError) -> ChatError {
    match e {
        RpcError::Closed => exited_error(peer),
        RpcError::Timeout => ChatError::new(ErrorKind::Timeout, format!("Codex didn't {what} in time.")),
        RpcError::Remote { message, .. } => ChatError::new(ErrorKind::ProviderError, format!("Codex couldn't {what}: {}", redact(&message, None))),
        RpcError::Io(m) => ChatError::new(ErrorKind::RuntimeExited, format!("Couldn't talk to Codex: {}", redact(&m, None))),
    }
}

fn exited_error(peer: &Peer) -> ChatError {
    let mut msg = match peer.exit_code() {
        Some(c) => format!("Codex stopped unexpectedly (exit code {c}). It restarts with your next message."),
        None => "Codex stopped unexpectedly. It restarts with your next message.".to_string(),
    };
    let tail = redact(&peer.stderr_tail(8), None);
    if !tail.trim().is_empty() {
        msg.push_str("\n\nLast output:\n");
        msg.push_str(tail.trim());
    }
    ChatError::new(ErrorKind::RuntimeExited, msg)
}

/// Removes ANSI escape sequences (CSI, OSC and two-byte escapes).
fn strip_ansi(s: &str) -> String {
    if !s.contains('\u{1b}') {
        return s.to_string();
    }
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\u{1b}' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('[') => {
                for c in chars.by_ref() {
                    if ('@'..='~').contains(&c) {
                        break;
                    }
                }
            }
            Some(']') => loop {
                match chars.next() {
                    None | Some('\u{7}') => break,
                    Some('\u{1b}') => {
                        if chars.peek() == Some(&'\\') {
                            chars.next();
                        }
                        break;
                    }
                    Some(_) => {}
                }
            },
            _ => {}
        }
    }
    out
}

fn clip(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let mut end = max;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &s[..end])
}

#[cfg(test)]
mod tests {
    use super::super::jsonrpc::testing::{fake_peer, FakeRuntime};
    use super::*;
    use std::sync::mpsc;

    struct NoGuard;
    impl WriteGuard for NoGuard {
        fn before_write(&self, _: &Path) -> Result<(), String> {
            Err("not used by Codex".into())
        }
        fn may_read(&self, _: &Path) -> bool {
            false
        }
    }

    struct H {
        adapter: Adapter,
        runtimes: mpsc::Receiver<FakeRuntime>,
        _dir: tempfile::TempDir,
        exe: PathBuf,
        root: PathBuf,
        usage: Arc<crate::usage::Usage>,
    }

    fn harness() -> H {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("proj");
        std::fs::create_dir_all(&root).unwrap();
        let root = dunce::canonicalize(&root).unwrap();
        let exe = dir.path().join("codex.exe");
        std::fs::write(&exe, b"").unwrap();
        let usage = crate::usage::Usage::new(Box::new(|_| {}));
        let (tx, runtimes) = mpsc::channel();
        let tx = Mutex::new(tx);
        let spawner: Spawner = Arc::new(move |_exe: &Path, handler: Handler| {
            let (peer, rt) = fake_peer(false, handler);
            let _ = tx.lock().send(rt);
            Ok(peer)
        });
        H { adapter: Adapter::with_spawner(Arc::clone(&usage), spawner), runtimes, _dir: dir, exe, root, usage }
    }

    impl H {
        fn req(&self, mode: Mode, session: Option<&str>) -> TurnRequest {
            TurnRequest {
                conversation_id: "conv-1".into(),
                turn_id: "t".into(),
                engine: Engine::Codex,
                model: "default".into(),
                mode,
                policy: crate::chat::Policy::Ask,
                cwd: self.root.clone(),
                prompt: "Do it".into(),
                images: vec![],
                runtime_session_id: session.map(str::to_string),
                handoff: None,
                reconfigure: false,
                api_key: None,
                executable: Some(self.exe.clone()),
            }
        }

        fn start(&self, req: TurnRequest) -> (Box<dyn TurnHandle>, mpsc::Receiver<AgentEvent>) {
            let (tx, rx) = mpsc::channel();
            let tx = Mutex::new(tx);
            let sink: AgentSink = Arc::new(move |ev| drop(tx.lock().send(ev)));
            (self.adapter.start_turn(req, Arc::new(NoGuard), sink).unwrap(), rx)
        }

        fn runtime(&self) -> FakeRuntime {
            self.runtimes.recv_timeout(Duration::from_secs(5)).expect("no app-server started")
        }
    }

    fn next(rx: &mpsc::Receiver<AgentEvent>) -> AgentEvent {
        rx.recv_timeout(Duration::from_secs(5)).expect("no event")
    }

    fn name(ev: &AgentEvent) -> String {
        match ev {
            AgentEvent::Session { id, resumed } => format!("session {id} {resumed}"),
            AgentEvent::ResumeFailed { message } => format!("resume failed: {message}"),
            AgentEvent::Text { text } => format!("text {text}"),
            AgentEvent::TextBreak => "break".into(),
            AgentEvent::Thinking { text } => format!("thinking {text}"),
            AgentEvent::ItemStarted { key, .. } => format!("started {key}"),
            AgentEvent::ItemUpdated { key, status, .. } => format!("updated {key} {status:?}"),
            AgentEvent::Output { key, text } => format!("output {key} {text:?}"),
            AgentEvent::Plan { steps, .. } => format!("plan {}", steps.len()),
            AgentEvent::Approval { key, .. } => format!("approval {key}"),
            AgentEvent::Usage(u) => format!("usage {:?} {:?}", u.input_tokens, u.output_tokens),
            AgentEvent::Notice { text, .. } => format!("notice {text}"),
            AgentEvent::Done(o) => format!("done {o:?}"),
        }
    }

    fn expect_name(rx: &mpsc::Receiver<AgentEvent>, want: &str) {
        let ev = next(rx);
        assert_eq!(name(&ev), want);
    }

    fn approval(rx: &mpsc::Receiver<AgentEvent>) -> (String, PermissionRequest, Reply) {
        match next(rx) {
            AgentEvent::Approval { key, request, reply } => (key, request, reply),
            other => panic!("expected an approval, got {}", name(&other)),
        }
    }

    fn done(rx: &mpsc::Receiver<AgentEvent>) -> TurnOutcome {
        loop {
            if let AgentEvent::Done(o) = next(rx) {
                return o;
            }
        }
    }

    fn handshake(rt: &mut FakeRuntime) {
        let init = rt.recv();
        assert_eq!(init["method"], "initialize");
        assert_eq!(init["params"]["clientInfo"]["name"], "agenthub");
        assert!(init.get("jsonrpc").is_none());
        rt.send(json!({ "id": init["id"], "result": { "userAgent": "codex", "codexHome": "C:/c", "platformFamily": "windows", "platformOs": "windows" } }));
        assert_eq!(rt.expect("initialized")["method"], "initialized");
    }

    fn answer(rt: &mut FakeRuntime, method: &str, result: Value) -> Value {
        let m = rt.recv();
        assert_eq!(m["method"], method, "{m}");
        rt.send(json!({ "id": m["id"], "result": result }));
        m["params"].clone()
    }

    fn n(method: &str, params: Value) -> Value {
        json!({ "method": method, "params": params })
    }

    /// Handshake, `thread/start` → `thr`, `turn/start` → `turn`.
    fn open(rt: &mut FakeRuntime, thr: &str, turn: &str) -> (Value, Value) {
        handshake(rt);
        let thread = answer(rt, "thread/start", json!({ "thread": { "id": thr } }));
        let t = answer(rt, "turn/start", json!({ "turn": { "id": turn, "status": "inProgress", "items": [] } }));
        (thread, t)
    }

    fn completed(rt: &mut FakeRuntime, thr: &str, turn: &str, status: &str, error: Value) {
        rt.send(n("turn/completed", json!({ "threadId": thr, "turn": { "id": turn, "status": status, "items": [], "error": error } })));
    }

    #[test]
    fn pasted_images_go_as_data_urls_before_the_text() {
        let h = harness();
        let mut req = h.req(Mode::Plan, None);
        req.images = vec![super::super::ImageInput { mime: "image/png".into(), data: "iVBORw0K".into() }];
        let (_handle, _rx) = h.start(req);
        let mut rt = h.runtime();
        handshake(&mut rt);
        answer(&mut rt, "thread/start", json!({ "thread": { "id": "thr_1" } }));
        let turn = answer(&mut rt, "turn/start", json!({ "turn": { "id": "turn_1", "status": "inProgress", "items": [] } }));
        assert_eq!(turn["input"][0], json!({ "type": "image", "url": "data:image/png;base64,iVBORw0K" }));
        assert_eq!(turn["input"][1]["type"], "text");
    }

    #[test]
    fn streams_text_commands_plan_and_usage_then_reuses_the_thread() {
        let h = harness();
        let (_handle, rx) = h.start(h.req(Mode::Agent, None));
        let mut rt = h.runtime();
        handshake(&mut rt);
        let start = answer(&mut rt, "thread/start", json!({ "thread": { "id": "thr_1" } }));
        assert_eq!(start["sandbox"], "read-only");
        assert_eq!(start["approvalPolicy"], "untrusted");
        assert_eq!(start["approvalsReviewer"], "user");
        assert_eq!(start["cwd"], h.root.to_string_lossy().as_ref());
        assert!(start.get("model").is_none(), "default model isn't sent");
        expect_name(&rx, "session thr_1 false");
        let turn = answer(&mut rt, "turn/start", json!({ "turn": { "id": "turn_1", "status": "inProgress", "items": [] } }));
        assert_eq!(turn["threadId"], "thr_1");
        assert_eq!(turn["sandboxPolicy"], json!({ "type": "readOnly", "networkAccess": false }));
        assert_eq!(turn["approvalPolicy"], "untrusted");
        assert_eq!(turn["input"][0], json!({ "type": "text", "text": "Do it" }));

        let ids = json!({ "threadId": "thr_1", "turnId": "turn_1" });
        let with = |extra: Value| {
            let mut v = ids.clone();
            v.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
            v
        };
        rt.send(n("turn/started", json!({ "threadId": "thr_1", "turn": { "id": "turn_1", "status": "inProgress", "items": [] } })));
        rt.send(n("item/started", with(json!({ "item": { "type": "agentMessage", "id": "m1", "text": "" }, "startedAtMs": 1 }))));
        rt.send(n("item/agentMessage/delta", with(json!({ "itemId": "m1", "delta": "Hel" }))));
        rt.send(n("item/agentMessage/delta", with(json!({ "itemId": "m1", "delta": "lo" }))));
        rt.send(n("item/completed", with(json!({ "item": { "type": "agentMessage", "id": "m1", "text": "Hello" }, "completedAtMs": 2 }))));
        rt.send(n("item/reasoning/summaryTextDelta", with(json!({ "itemId": "r1", "delta": "Checking tests", "summaryIndex": 0 }))));
        rt.send(n("item/completed", with(json!({ "item": { "type": "reasoning", "id": "r1", "summary": ["Checking tests"] }, "completedAtMs": 3 }))));
        let cmd = json!({ "type": "commandExecution", "id": "c1", "command": "cargo test", "cwd": h.root.to_string_lossy(), "status": "inProgress", "commandActions": [] });
        rt.send(n("item/started", with(json!({ "item": cmd, "startedAtMs": 4 }))));
        rt.send(n("item/commandExecution/outputDelta", with(json!({ "itemId": "c1", "delta": "\u{1b}[32mok\u{1b}[0m\n" }))));
        let mut done_cmd = cmd.clone();
        done_cmd["status"] = json!("completed");
        done_cmd["exitCode"] = json!(0);
        done_cmd["durationMs"] = json!(12);
        done_cmd["aggregatedOutput"] = json!("ok\n");
        rt.send(n("item/completed", with(json!({ "item": done_cmd, "completedAtMs": 5 }))));
        rt.send(n(
            "turn/plan/updated",
            with(json!({ "explanation": "Two steps", "plan": [{ "step": "Read", "status": "completed" }, { "step": "Edit", "status": "inProgress" }] })),
        ));
        let usage = |ti: i64, to: i64, li: i64, lo: i64| {
            let b = |i: i64, o: i64| json!({ "inputTokens": i, "cachedInputTokens": 0, "outputTokens": o, "reasoningOutputTokens": 0, "totalTokens": i + o });
            with(json!({ "tokenUsage": { "total": b(ti, to), "last": b(li, lo) } }))
        };
        rt.send(n("thread/tokenUsage/updated", usage(1100, 60, 1000, 50)));
        rt.send(n("thread/tokenUsage/updated", usage(2300, 90, 1200, 30)));
        rt.send(n("account/rateLimits/updated", json!({ "rateLimits": { "primary": { "usedPercent": 40, "windowDurationMins": 300 } } })));
        // A late message from another turn is ignored.
        rt.send(n("item/agentMessage/delta", json!({ "threadId": "thr_1", "turnId": "old", "itemId": "x", "delta": "stale" })));
        completed(&mut rt, "thr_1", "turn_1", "completed", Value::Null);

        for want in ["text Hel", "text lo", "break", "thinking Checking tests"] {
            expect_name(&rx, want);
        }
        match next(&rx) {
            AgentEvent::ItemStarted { key, status, body: ItemBody::Command { command, .. } } => {
                assert_eq!((key.as_str(), status, command.as_str()), ("c1", ItemStatus::Running, "cargo test"))
            }
            other => panic!("{}", name(&other)),
        }
        expect_name(&rx, "output c1 \"ok\\n\"");
        match next(&rx) {
            AgentEvent::ItemUpdated { status, body: ItemBody::Command { output, exit_code, duration_ms, .. }, .. } => {
                assert_eq!((status, output.as_str(), exit_code, duration_ms), (ItemStatus::Completed, "ok\n", Some(0), Some(12)))
            }
            other => panic!("{}", name(&other)),
        }
        match next(&rx) {
            AgentEvent::Plan { steps, explanation } => {
                assert_eq!(steps[1], PlanStep { text: "Edit".into(), status: StepStatus::InProgress });
                assert_eq!(explanation.as_deref(), Some("Two steps"));
            }
            other => panic!("{}", name(&other)),
        }
        expect_name(&rx, "usage Some(1000) Some(50)");
        expect_name(&rx, "usage Some(2200) Some(80)");
        expect_name(&rx, "done Completed");
        assert_eq!(h.usage.snapshot().openai.session.unwrap().used_percent, 40.0);

        // The next turn of the conversation goes straight to the loaded thread.
        let (_h2, rx2) = h.start(h.req(Mode::Agent, Some("thr_1")));
        let t2 = answer(&mut rt, "turn/start", json!({ "turn": { "id": "turn_2", "status": "inProgress", "items": [] } }));
        assert_eq!(t2["threadId"], "thr_1");
        expect_name(&rx2, "session thr_1 true");
        completed(&mut rt, "thr_1", "turn_2", "completed", Value::Null);
        expect_name(&rx2, "done Completed");
    }

    #[test]
    fn approvals_round_trip_and_other_requests_are_refused() {
        let h = harness();
        let (_handle, rx) = h.start(h.req(Mode::Agent, None));
        let mut rt = h.runtime();
        open(&mut rt, "thr", "t1");
        expect_name(&rx, "session thr false");
        let ids = |extra: Value| {
            let mut v = json!({ "threadId": "thr", "turnId": "t1" });
            v.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
            v
        };

        // A command: allowed for the session.
        rt.send(json!({ "id": 50, "method": "item/commandExecution/requestApproval",
            "params": ids(json!({ "itemId": "c1", "command": "cargo build", "cwd": h.root.to_string_lossy(), "reason": "needs to write target/" })) }));
        let (key, req, reply) = approval(&rx);
        assert_eq!((key.as_str(), req.kind, req.command.as_deref()), ("c1", PermissionKind::Command, Some("cargo build")));
        assert!(req.can_allow_session);
        assert!(req.detail.unwrap().contains("needs to write target/"));
        reply(Decision::AllowSession);
        assert_eq!(rt.recv(), json!({ "id": 50, "result": { "decision": "acceptForSession" } }));

        // Network access: declined.
        rt.send(json!({ "id": 51, "method": "item/commandExecution/requestApproval",
            "params": ids(json!({ "itemId": "c2", "command": "curl https://example.com", "networkApprovalContext": { "host": "example.com", "protocol": "https" } })) }));
        let (_, req, reply) = approval(&rx);
        assert_eq!(req.kind, PermissionKind::Network);
        assert!(req.title.contains("example.com"));
        reply(Decision::Deny);
        assert_eq!(rt.recv(), json!({ "id": 51, "result": { "decision": "decline" } }));

        // A patch: absolute paths for every file it touches, relative ones resolved.
        let a = h.root.join("a.rs").to_string_lossy().to_string();
        let changes = json!([
            { "path": a, "kind": { "type": "update", "move_path": null }, "diff": "@@ -1 +1 @@\n-one\n+ONE" },
            { "path": "src/new.rs", "kind": { "type": "add" }, "diff": "+fn main() {}" },
        ]);
        rt.send(n("item/started", ids(json!({ "item": { "type": "fileChange", "id": "f1", "changes": changes, "status": "inProgress" }, "startedAtMs": 1 }))));
        match next(&rx) {
            AgentEvent::ItemStarted { key, body: ItemBody::Tool { tool, title, detail, .. }, .. } => {
                assert_eq!((key.as_str(), tool, title.as_str()), ("f1", ToolKind::Edit, "a.rs, src/new.rs"));
                assert!(detail.unwrap().contains("+ONE"));
            }
            other => panic!("{}", name(&other)),
        }
        rt.send(json!({ "id": 52, "method": "item/fileChange/requestApproval", "params": ids(json!({ "itemId": "f1", "reason": "apply" })) }));
        let (_, req, reply) = approval(&rx);
        let new_rs = h.root.join("src").join("new.rs").to_string_lossy().to_string();
        assert_eq!(req.kind, PermissionKind::Write);
        assert_eq!(req.path.as_deref(), Some(a.as_str()));
        assert_eq!(req.paths, vec![a.clone(), new_rs]);
        assert!(!req.can_allow_session);
        assert_eq!(req.title, "Edit 2 files");
        reply(Decision::AllowOnce);
        assert_eq!(rt.recv(), json!({ "id": 52, "result": { "decision": "accept" } }));

        // A delete-only patch, cancelled.
        rt.send(n("item/started", ids(json!({ "item": { "type": "fileChange", "id": "f2", "changes": [{ "path": "old.rs", "kind": { "type": "delete" }, "diff": "" }], "status": "inProgress" }, "startedAtMs": 1 }))));
        expect_name(&rx, "started f2");
        rt.send(json!({ "id": 53, "method": "item/fileChange/requestApproval", "params": ids(json!({ "itemId": "f2" })) }));
        let (_, req, reply) = approval(&rx);
        assert_eq!((req.kind, req.title.as_str()), (PermissionKind::Delete, "Delete old.rs"));
        assert_eq!(req.paths, vec![h.root.join("old.rs").to_string_lossy().to_string()]);
        reply(Decision::Cancel);
        assert_eq!(rt.recv(), json!({ "id": 53, "result": { "decision": "cancel" } }));

        // A patch whose files were never reported can't pass as an in-project edit.
        rt.send(json!({ "id": 54, "method": "item/fileChange/requestApproval", "params": ids(json!({ "itemId": "unknown" })) }));
        let (_, req, reply) = approval(&rx);
        assert_eq!(req.kind, PermissionKind::Other);
        reply(Decision::Deny);
        assert_eq!(rt.recv()["result"]["decision"], "decline");

        // Requests AgentHub doesn't support get safe refusals.
        rt.send(json!({ "id": 55, "method": "item/permissions/requestApproval", "params": ids(json!({ "itemId": "p", "permissions": {} })) }));
        assert_eq!(rt.recv(), json!({ "id": 55, "result": { "permissions": {}, "scope": "turn" } }));
        assert!(name(&next(&rx)).starts_with("notice"));
        rt.send(json!({ "id": 56, "method": "item/tool/requestUserInput", "params": ids(json!({ "itemId": "q", "isBlocking": true,
            "questions": [{ "id": "q1", "header": "Run tool?", "question": "Allow?", "options": [{ "label": "Accept", "description": "" }, { "label": "Decline", "description": "" }] }] })) }));
        assert_eq!(rt.recv(), json!({ "id": 56, "result": { "answers": { "q1": { "answers": ["Decline"] } } } }));
        assert!(name(&next(&rx)).starts_with("notice"));
        rt.send(json!({ "id": 57, "method": "item/tool/call", "params": ids(json!({ "callId": "x", "tool": "t", "arguments": {} })) }));
        assert_eq!(rt.recv()["result"]["success"], false);
        rt.send(json!({ "id": 58, "method": "account/chatgptAuthTokens/refresh", "params": {} }));
        assert_eq!(rt.recv()["error"]["code"], -32601);
        // An approval for a thread without a running turn is declined.
        rt.send(json!({ "id": 59, "method": "item/commandExecution/requestApproval", "params": { "threadId": "other", "turnId": "x", "itemId": "c" } }));
        assert_eq!(rt.recv(), json!({ "id": 59, "result": { "decision": "decline" } }));

        completed(&mut rt, "thr", "t1", "interrupted", Value::Null);
        assert_eq!(done(&rx), TurnOutcome::Cancelled);
    }

    #[test]
    fn interrupt_cancels_pending_approvals_and_stops_the_turn() {
        let h = harness();
        let (handle, rx) = h.start(h.req(Mode::Agent, None));
        let mut rt = h.runtime();
        open(&mut rt, "thr", "t1");
        expect_name(&rx, "session thr false");
        rt.send(json!({ "id": 60, "method": "item/commandExecution/requestApproval", "params": { "threadId": "thr", "turnId": "t1", "itemId": "c1", "command": "make" } }));
        let (_, _, reply) = approval(&rx);
        handle.interrupt();
        assert_eq!(rt.recv(), json!({ "id": 60, "result": { "decision": "cancel" } }));
        let int = answer(&mut rt, "turn/interrupt", json!({}));
        assert_eq!(int, json!({ "threadId": "thr", "turnId": "t1" }));
        completed(&mut rt, "thr", "t1", "interrupted", Value::Null);
        assert_eq!(done(&rx), TurnOutcome::Cancelled);
        // AgentHub's own late cancel doesn't answer the request twice: the next message is the next turn.
        reply(Decision::Cancel);
        let (_h2, rx2) = h.start(h.req(Mode::Agent, Some("thr")));
        answer(&mut rt, "turn/start", json!({ "turn": { "id": "t2", "status": "inProgress", "items": [] } }));
        expect_name(&rx2, "session thr true");
        completed(&mut rt, "thr", "t2", "completed", Value::Null);
        assert_eq!(done(&rx2), TurnOutcome::Completed);
    }

    #[test]
    fn a_crash_fails_the_turn_and_the_next_turn_restarts_and_resumes() {
        let h = harness();
        let (_handle, rx) = h.start(h.req(Mode::Agent, None));
        let mut rt = h.runtime();
        open(&mut rt, "thr_1", "t1");
        expect_name(&rx, "session thr_1 false");
        rt.send(n("item/agentMessage/delta", json!({ "threadId": "thr_1", "turnId": "t1", "itemId": "m", "delta": "Half" })));
        expect_name(&rx, "text Half");
        rt.close();
        match done(&rx) {
            TurnOutcome::Failed(e) => {
                assert_eq!(e.kind, ErrorKind::RuntimeExited);
                assert!(e.message.contains("stopped unexpectedly"), "{}", e.message);
            }
            other => panic!("{other:?}"),
        }

        let (_h2, rx2) = h.start(h.req(Mode::Agent, Some("thr_1")));
        let mut rt2 = h.runtime();
        handshake(&mut rt2);
        let resume = answer(&mut rt2, "thread/resume", json!({ "thread": { "id": "thr_1" } }));
        assert_eq!((resume["threadId"].as_str(), resume["excludeTurns"].as_bool()), (Some("thr_1"), Some(true)));
        assert_eq!(resume["sandbox"], "read-only");
        expect_name(&rx2, "session thr_1 true");
        let t = answer(&mut rt2, "turn/start", json!({ "turn": { "id": "t2", "status": "inProgress", "items": [] } }));
        assert_eq!(t["input"][0]["text"], "Do it", "no handoff after a successful resume");
        completed(&mut rt2, "thr_1", "t2", "completed", Value::Null);
        assert_eq!(done(&rx2), TurnOutcome::Completed);
    }

    #[test]
    fn a_failed_resume_starts_fresh_with_the_handoff_and_plan_instructions() {
        let h = harness();
        let mut req = h.req(Mode::Plan, Some("gone"));
        req.model = "gpt-6.1-sol".into();
        req.handoff = Some("Earlier in this AgentHub conversation:\n\nUser: hi\n\n---\n\n".into());
        let (_handle, rx) = h.start(req);
        let mut rt = h.runtime();
        handshake(&mut rt);
        let resume = rt.recv();
        assert_eq!(resume["method"], "thread/resume");
        rt.send(json!({ "id": resume["id"], "error": { "code": -32600, "message": "no rollout found for thread id gone" } }));
        let start = answer(&mut rt, "thread/start", json!({ "thread": { "id": "thr_new" } }));
        assert_eq!((start["model"].as_str(), start["sandbox"].as_str()), (Some("gpt-6.1-sol"), Some("read-only")));
        assert!(name(&next(&rx)).contains("no rollout found"));
        expect_name(&rx, "session thr_new false");
        let turn = answer(&mut rt, "turn/start", json!({ "turn": { "id": "t1", "status": "inProgress", "items": [] } }));
        let text = turn["input"][0]["text"].as_str().unwrap();
        assert!(text.starts_with(super::super::mode_instructions(Mode::Plan).unwrap()));
        assert!(text.contains("User: hi\n\n---\n\nDo it"));
        assert_eq!(turn["model"], "gpt-6.1-sol");
        rt.send(n("error", json!({ "threadId": "thr_new", "turnId": "t1", "willRetry": false, "error": { "message": "limit", "codexErrorInfo": "usageLimitExceeded" } })));
        completed(&mut rt, "thr_new", "t1", "failed", json!({ "message": "You've hit your usage limit.", "codexErrorInfo": "usageLimitExceeded" }));
        match done(&rx) {
            TurnOutcome::Failed(e) => assert_eq!(e.kind, ErrorKind::RateLimited),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn ask_mode_is_refused_and_errors_map_to_kinds() {
        let h = harness();
        let err = h.adapter.start_turn(h.req(Mode::Ask, None), Arc::new(NoGuard), Arc::new(|_| {})).err().unwrap();
        assert_eq!(err.kind, ErrorKind::ModeUnsupported);

        let kind = |info: Value| turn_error(&json!({ "message": "m", "codexErrorInfo": info })).kind;
        assert_eq!(kind(json!("unauthorized")), ErrorKind::NotSignedIn);
        assert_eq!(kind(json!("usageLimitExceeded")), ErrorKind::RateLimited);
        assert_eq!(kind(json!("contextWindowExceeded")), ErrorKind::ContextTooLong);
        assert_eq!(kind(json!({ "httpConnectionFailed": { "httpStatusCode": 502 } })), ErrorKind::Network);
        assert_eq!(turn_error(&json!({ "message": "m", "codexErrorInfo": { "httpConnectionFailed": { "httpStatusCode": 502 } } })).status, Some(502));
        assert_eq!(kind(json!("badRequest")), ErrorKind::ProviderError);
        assert_eq!(kind(Value::Null), ErrorKind::ProviderError);
        assert!(!turn_error(&json!({ "message": "bad key sk-abcdefghijklmnop" })).message.contains("sk-abcdefghijklmnop"));

        assert_eq!(strip_ansi("\u{1b}[1;31mred\u{1b}[0m \u{1b}]0;title\u{7}ok"), "red ok");
        assert_eq!(decision_word(Decision::AllowSession, false), "acceptForSession");
        assert_eq!(decision_word(Decision::AllowSession, true), "accept");
    }

    #[test]
    fn probe_reports_account_and_models_or_sign_in() {
        let h = harness();
        thread::scope(|s| {
            let t = s.spawn(|| h.adapter.probe(Some(&h.exe), None));
            let mut rt = h.runtime();
            handshake(&mut rt);
            assert_eq!(answer(&mut rt, "account/read", json!({ "account": { "type": "chatgpt", "email": "me@example.com", "planType": "pro" }, "requiresOpenaiAuth": true })), json!({ "refreshToken": false }));
            answer(&mut rt, "model/list", json!({ "data": [
                { "id": "gpt-6.1-sol", "model": "gpt-6.1-sol", "displayName": "GPT-6.1-Sol", "isDefault": true, "hidden": false },
                { "id": "secret", "model": "secret", "displayName": "Hidden", "isDefault": false, "hidden": true },
            ], "nextCursor": null }));
            let p = t.join().unwrap();
            assert_eq!(p.state, ProbeState::Ready);
            assert_eq!(p.account.as_deref(), Some("ChatGPT · pro"));
            assert_eq!(p.models, vec![ModelInfo { id: "gpt-6.1-sol".into(), label: "GPT-6.1-Sol".into(), is_default: true }]);
            assert!(!serde_json::to_string(&p).unwrap().contains("example.com"));
        });
        thread::scope(|s| {
            let t = s.spawn(|| h.adapter.probe(Some(&h.exe), None));
            let mut rt = h.runtime();
            handshake(&mut rt);
            answer(&mut rt, "account/read", json!({ "account": null, "requiresOpenaiAuth": true }));
            let p = t.join().unwrap();
            assert_eq!(p.state, ProbeState::SignInNeeded);
        });
        assert_eq!(account_label(&json!({ "account": { "type": "apiKey" }, "requiresOpenaiAuth": true })), (Some("API key".into()), true));
    }

    /// Real Codex, probe only (no model turn): `cargo test -- --ignored codex_live_probe`.
    #[test]
    #[ignore]
    fn codex_live_probe() {
        let adapter = Adapter::new(crate::usage::Usage::new(Box::new(|_| {})));
        let p = adapter.probe(None, None);
        println!("{p:?}");
        assert!(matches!(p.state, ProbeState::Ready | ProbeState::SignInNeeded), "{p:?}");
        assert!(p.version.is_some());
        if p.state == ProbeState::Ready {
            assert!(!p.models.is_empty());
        }
    }
}
