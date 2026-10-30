//! Claude Agent SDK and GitHub Copilot SDK, run in one supervised Node.js
//! sidecar (`sidecar/` in the repo, `node <script>`). JSON-RPC 2.0 over
//! stdio: AgentHub sends `initialize`, `probe`, `turn/start`,
//! `turn/interrupt`, `session/close` and `shutdown`; the sidecar sends
//! `turn/event` notifications and `turn/approval` requests, which wait for
//! AgentHub's policy or the user.
//!
//! The process starts lazily on first use and again after a crash (turns that
//! were running end with `RuntimeExited`). Each spawn has a generation so a
//! dead process can only end its own turns.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Weak};
use std::time::Duration;

use parking_lot::Mutex;
use serde::Deserialize;
use serde_json::{json, Value};

use super::jsonrpc::{Handler, Incoming, Peer, RpcError};
use super::{AgentEvent, AgentSink, EngineAdapter, Reply, TurnHandle, TurnOutcome, TurnRequest, WriteGuard};
use crate::chat::engines::{EngineProbe, ModelInfo, ProbeState};
use crate::chat::{ChatError, Decision, Engine, ErrorKind, ItemBody, ItemStatus, PermissionRequest, PlanStep, Tone, Usage};

const INIT_TIMEOUT: Duration = Duration::from_secs(20);
/// Copilot's probe starts its runtime and lists models.
const PROBE_TIMEOUT: Duration = Duration::from_secs(120);
const START_TIMEOUT: Duration = Duration::from_secs(30);
const CONTROL_TIMEOUT: Duration = Duration::from_secs(10);
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(4);

const NODE_MISSING: &str = "Install Node.js 20.19 or newer (or 22.12+) and make sure `node` is on PATH, then recheck. AgentHub runs the Claude Agent SDK and the Copilot SDK with it.";
const NOT_BUILT: &str = "The agent sidecar isn't built (run `pnpm --filter agenthub-sidecar build`).";

/// Starts the sidecar process and returns the connected peer.
type Connector = Box<dyn Fn(Handler) -> Result<Arc<Peer>, ChatError> + Send + Sync>;

struct Live {
    peer: Arc<Peer>,
    generation: u64,
}

struct Route {
    generation: u64,
    sink: AgentSink,
}

pub struct Sidecar {
    connector: Connector,
    live: Mutex<Option<Live>>,
    /// Serializes (re)starts.
    starting: Mutex<()>,
    generation: AtomicU64,
    routes: Arc<Mutex<HashMap<String, Route>>>,
}

impl Sidecar {
    pub fn new(script: Option<PathBuf>) -> Arc<Self> {
        Self::with_connector(Box::new(move |handler| spawn_node(script.as_deref(), handler)))
    }

    fn with_connector(connector: Connector) -> Arc<Self> {
        Arc::new(Self {
            connector,
            live: Mutex::new(None),
            starting: Mutex::new(()),
            generation: AtomicU64::new(0),
            routes: Arc::new(Mutex::new(HashMap::new())),
        })
    }

    /// The running sidecar, started (and initialized) if needed.
    fn peer(&self) -> Result<(Arc<Peer>, u64), ChatError> {
        let _guard = self.starting.lock();
        if let Some(l) = self.live.lock().as_ref().filter(|l| l.peer.is_alive()) {
            return Ok((Arc::clone(&l.peer), l.generation));
        }
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let handler = make_handler(Arc::downgrade(&self.routes), generation);
        let peer = (self.connector)(handler)?;
        match peer.request("initialize", json!({}), INIT_TIMEOUT) {
            Ok(_) => {}
            Err(e) => {
                let tail = peer.stderr_tail(5);
                peer.kill();
                let mut msg = format!("The agent sidecar didn't start: {e}.");
                if !tail.trim().is_empty() {
                    msg.push(' ');
                    msg.push_str(&crate::chat::redact(tail.trim(), None));
                }
                return Err(ChatError::new(ErrorKind::RuntimeExited, msg));
            }
        }
        *self.live.lock() = Some(Live { peer: Arc::clone(&peer), generation });
        Ok((peer, generation))
    }

    /// The running sidecar, if any (never starts one).
    fn running(&self) -> Option<Arc<Peer>> {
        self.live.lock().as_ref().filter(|l| l.peer.is_alive()).map(|l| Arc::clone(&l.peer))
    }

    /// Sends `shutdown`, then ends the process.
    pub fn shutdown(&self) {
        let live = self.live.lock().take();
        if let Some(l) = live {
            let _ = l.peer.request("shutdown", json!({}), SHUTDOWN_TIMEOUT);
            l.peer.kill();
        }
    }
}

/// Finds `node`, checks its version and starts `node <script>`.
fn spawn_node(script: Option<&Path>, handler: Handler) -> Result<Arc<Peer>, ChatError> {
    let script = script.filter(|p| p.is_file()).ok_or_else(|| ChatError::new(ErrorKind::EngineNotFound, NOT_BUILT))?;
    let node = super::locate("node", None).ok_or_else(|| ChatError::new(ErrorKind::EngineNotFound, NODE_MISSING))?;
    let version = super::version_of(&node, &["--version"]).unwrap_or_default();
    if !node_supported(&version) {
        let shown = if version.is_empty() { "of unknown version".to_string() } else { version.clone() };
        return Err(ChatError::new(ErrorKind::EngineNotFound, format!("Node.js {shown} is too old. {NODE_MISSING}")));
    }
    let mut cmd = super::command(&node);
    cmd.arg(script);
    if let Some(dir) = script.parent() {
        cmd.current_dir(dir);
    }
    Peer::spawn(cmd, true, handler).map_err(|e| ChatError::new(ErrorKind::EngineNotFound, format!("Couldn't start Node.js for the agent sidecar: {e}")))
}

/// Node `^20.19.0 || >=22.12.0` (the Copilot SDK's range; the Claude SDK needs less).
fn node_supported(version: &str) -> bool {
    let v = version.trim().trim_start_matches('v');
    let mut parts = v.split('.').map(|p| p.parse::<u32>().unwrap_or(0));
    let (major, minor) = (parts.next().unwrap_or(0), parts.next().unwrap_or(0));
    major > 22 || (major == 22 && minor >= 12) || (major == 20 && minor >= 19)
}

// ---------- incoming messages ----------

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
enum WireEvent {
    Session { id: String, resumed: bool },
    ResumeFailed { message: String },
    Text { text: String },
    TextBreak,
    Thinking { text: String },
    ItemStarted { key: String, status: ItemStatus, body: ItemBody },
    ItemUpdated { key: String, status: ItemStatus, body: ItemBody },
    Output { key: String, text: String },
    Plan { steps: Vec<PlanStep>, #[serde(default)] explanation: Option<String> },
    Usage { usage: Usage },
    Notice { text: String, tone: Tone },
    Done { outcome: Value },
}

/// A failure the sidecar reported; unknown error kinds become `ProviderError`.
fn outcome_from(v: &Value) -> TurnOutcome {
    match v.get("type").and_then(Value::as_str) {
        Some("completed") => TurnOutcome::Completed,
        Some("cancelled") => TurnOutcome::Cancelled,
        _ => {
            let err = v.get("error");
            let kind = err
                .and_then(|e| e.get("kind"))
                .and_then(|k| serde_json::from_value::<ErrorKind>(k.clone()).ok())
                .unwrap_or(ErrorKind::ProviderError);
            let message = err
                .and_then(|e| e.get("message"))
                .and_then(Value::as_str)
                .filter(|m| !m.trim().is_empty())
                .unwrap_or("The agent stopped with an error.");
            TurnOutcome::Failed(ChatError::new(kind, crate::chat::redact(message, None)))
        }
    }
}

fn to_agent_event(ev: WireEvent) -> AgentEvent {
    match ev {
        WireEvent::Session { id, resumed } => AgentEvent::Session { id, resumed },
        WireEvent::ResumeFailed { message } => AgentEvent::ResumeFailed { message: crate::chat::redact(&message, None) },
        WireEvent::Text { text } => AgentEvent::Text { text },
        WireEvent::TextBreak => AgentEvent::TextBreak,
        WireEvent::Thinking { text } => AgentEvent::Thinking { text },
        WireEvent::ItemStarted { key, status, body } => AgentEvent::ItemStarted { key, status, body },
        WireEvent::ItemUpdated { key, status, body } => AgentEvent::ItemUpdated { key, status, body },
        WireEvent::Output { key, text } => AgentEvent::Output { key, text },
        WireEvent::Plan { steps, explanation } => AgentEvent::Plan { steps, explanation },
        WireEvent::Usage { usage } => AgentEvent::Usage(usage),
        WireEvent::Notice { text, tone } => AgentEvent::Notice { text: crate::chat::redact(&text, None), tone },
        WireEvent::Done { outcome } => AgentEvent::Done(outcome_from(&outcome)),
    }
}

fn decision_str(d: Decision) -> &'static str {
    match d {
        Decision::AllowOnce => "allow_once",
        Decision::AllowSession => "allow_session",
        Decision::Deny => "deny",
        Decision::Cancel => "cancel",
    }
}

fn make_handler(routes: Weak<Mutex<HashMap<String, Route>>>, generation: u64) -> Handler {
    Arc::new(move |peer: &Arc<Peer>, msg: Incoming| {
        let Some(routes) = routes.upgrade() else { return };
        match msg {
            Incoming::Notification { method, params } if method == "turn/event" => {
                let Some(turn_id) = params.get("turnId").and_then(Value::as_str) else { return };
                let Some(raw) = params.get("event") else { return };
                // Unknown or malformed events are dropped (never logged: they may hold prompt text).
                let Ok(wire) = serde_json::from_value::<WireEvent>(raw.clone()) else { return };
                let is_done = matches!(wire, WireEvent::Done { .. });
                let sink = {
                    let mut r = routes.lock();
                    if is_done {
                        r.remove(turn_id).map(|route| route.sink)
                    } else {
                        r.get(turn_id).map(|route| Arc::clone(&route.sink))
                    }
                };
                if let Some(sink) = sink {
                    sink(to_agent_event(wire));
                }
            }
            Incoming::Notification { .. } => {}
            Incoming::Request { id, method, params } if method == "turn/approval" => {
                let turn_id = params.get("turnId").and_then(Value::as_str).unwrap_or_default();
                let sink = routes.lock().get(turn_id).map(|r| Arc::clone(&r.sink));
                let request = params.get("request").cloned().and_then(|r| serde_json::from_value::<PermissionRequest>(r).ok());
                let (Some(sink), Some(request)) = (sink, request) else {
                    // No such turn (it ended) or an unreadable request: never allow.
                    let decision = if routes.lock().contains_key(turn_id) { "deny" } else { "cancel" };
                    let _ = peer.respond(id, json!({ "decision": decision }));
                    return;
                };
                let key = params.get("key").and_then(Value::as_str).unwrap_or_default().to_string();
                let p = Arc::clone(peer);
                let reply: Reply = Box::new(move |d: Decision| {
                    let _ = p.respond(id, json!({ "decision": decision_str(d) }));
                });
                sink(AgentEvent::Approval { key, request, reply });
            }
            Incoming::Request { id, .. } => {
                let _ = peer.respond_error(id, -32601, "Unknown method");
            }
            Incoming::Closed => {
                let ended: Vec<AgentSink> = {
                    let mut r = routes.lock();
                    let ids: Vec<String> = r.iter().filter(|(_, route)| route.generation == generation).map(|(k, _)| k.clone()).collect();
                    ids.into_iter().filter_map(|k| r.remove(&k)).map(|route| route.sink).collect()
                };
                if !ended.is_empty() {
                    let tail = crate::chat::redact(peer.stderr_tail(3).trim(), None);
                    let mut msg = "The agent sidecar stopped unexpectedly; it restarts on the next message.".to_string();
                    if !tail.is_empty() {
                        msg.push(' ');
                        msg.push_str(&tail.chars().take(400).collect::<String>());
                    }
                    for sink in ended {
                        sink(AgentEvent::Done(TurnOutcome::Failed(ChatError::new(ErrorKind::RuntimeExited, msg.clone()))));
                    }
                }
            }
        }
    })
}

// ---------- adapter ----------

pub struct SdkAdapter {
    engine: Engine,
    sidecar: Arc<Sidecar>,
}

impl SdkAdapter {
    pub fn new(engine: Engine, sidecar: Arc<Sidecar>) -> Self {
        Self { engine, sidecar }
    }
}

struct Handle {
    sidecar: Weak<Sidecar>,
    generation: u64,
    turn_id: String,
}

impl TurnHandle for Handle {
    fn interrupt(&self) {
        // Never block here: the caller may hold the turn's lock while the
        // reader thread delivers `done`.
        let Some(sidecar) = self.sidecar.upgrade() else { return };
        let turn_id = self.turn_id.clone();
        let generation = self.generation;
        std::thread::spawn(move || {
            let live = sidecar.live.lock().as_ref().filter(|l| l.generation == generation).map(|l| Arc::clone(&l.peer));
            if let Some(peer) = live {
                let _ = peer.request("turn/interrupt", json!({ "turnId": turn_id }), CONTROL_TIMEOUT);
            }
        });
    }
}

fn rpc_error(e: RpcError) -> ChatError {
    match e {
        RpcError::Remote { message, .. } => ChatError::new(ErrorKind::InvalidRequest, crate::chat::redact(&message, None)),
        RpcError::Timeout => ChatError::new(ErrorKind::Timeout, "The agent sidecar didn't answer in time."),
        RpcError::Closed => ChatError::new(ErrorKind::RuntimeExited, "The agent sidecar stopped; it restarts on the next message."),
        RpcError::Io(m) => ChatError::new(ErrorKind::RuntimeExited, m),
    }
}

impl EngineAdapter for SdkAdapter {
    fn engine(&self) -> Engine {
        self.engine
    }

    fn probe(&self, executable: Option<&Path>, _api_key: Option<&str>) -> EngineProbe {
        let (peer, _) = match self.sidecar.peer() {
            Ok(p) => p,
            Err(e) => {
                let state = if e.kind == ErrorKind::EngineNotFound { ProbeState::NotFound } else { ProbeState::Error };
                return EngineProbe::new(self.engine, state, Some(e.message));
            }
        };
        let mut params = json!({ "engine": self.engine.as_str() });
        if let Some(exe) = executable {
            params["executable"] = json!(exe.to_string_lossy());
        }
        let result = match peer.request("probe", params, PROBE_TIMEOUT) {
            Ok(r) => r,
            Err(e) => return EngineProbe::new(self.engine, ProbeState::Error, Some(rpc_error(e).message)),
        };
        probe_from(self.engine, &result)
    }

    fn start_turn(&self, req: TurnRequest, _guard: Arc<dyn WriteGuard>, sink: AgentSink) -> Result<Box<dyn TurnHandle>, ChatError> {
        let (peer, generation) = self.sidecar.peer()?;
        let turn_id = req.turn_id.clone();
        // Route first: events may follow the response immediately.
        self.sidecar.routes.lock().insert(turn_id.clone(), Route { generation, sink });
        let mut params = json!({
            "turnId": req.turn_id,
            "conversationId": req.conversation_id,
            "engine": self.engine.as_str(),
            "model": req.model,
            "mode": req.mode.as_str(),
            "cwd": req.cwd.to_string_lossy(),
            "prompt": req.prompt,
            "reconfigure": req.reconfigure,
        });
        if let Some(s) = &req.runtime_session_id {
            params["sessionId"] = json!(s);
        }
        if let Some(h) = &req.handoff {
            params["handoff"] = json!(h);
        }
        if !req.images.is_empty() {
            params["images"] = json!(req.images.iter().map(|i| json!({ "mimeType": i.mime, "data": i.data })).collect::<Vec<_>>());
        }
        if let Some(e) = &req.executable {
            params["executable"] = json!(e.to_string_lossy());
        }
        if self.engine == Engine::ClaudeCode {
            if let Some(k) = &req.api_key {
                params["apiKey"] = json!(k);
            }
        }
        let handle = Box::new(Handle { sidecar: Arc::downgrade(&self.sidecar), generation, turn_id: turn_id.clone() });
        match peer.request("turn/start", params, START_TIMEOUT) {
            Ok(_) => Ok(handle),
            Err(e) => {
                // If the route is already gone, the turn got its `Done` (e.g. a crash): report that instead.
                if self.sidecar.routes.lock().remove(&turn_id).is_none() {
                    return Ok(handle);
                }
                Err(rpc_error(e))
            }
        }
    }

    fn close_session(&self, conversation_id: &str) {
        if let Some(peer) = self.sidecar.running() {
            let _ = peer.request("session/close", json!({ "conversationId": conversation_id }), CONTROL_TIMEOUT);
        }
    }

    fn shutdown(&self) {
        self.sidecar.shutdown();
    }
}

fn probe_from(engine: Engine, v: &Value) -> EngineProbe {
    let state = v.get("state").cloned().and_then(|s| serde_json::from_value::<ProbeState>(s).ok()).unwrap_or(ProbeState::Error);
    let text = |k: &str| v.get(k).and_then(Value::as_str).filter(|s| !s.is_empty()).map(|s| crate::chat::redact(s, None));
    let mut probe = EngineProbe::new(engine, state, text("message"));
    probe.path = text("path");
    probe.version = text("version");
    probe.account = text("account");
    probe.models = v.get("models").cloned().and_then(|m| serde_json::from_value::<Vec<ModelInfo>>(m).ok()).unwrap_or_default();
    probe
}

#[cfg(test)]
mod tests {
    use super::super::jsonrpc::testing::{fake_peer, FakeRuntime};
    use super::*;
    use crate::chat::{Mode, PermissionKind, Policy};
    use std::sync::mpsc;
    use std::thread;

    struct NoGuard;
    impl WriteGuard for NoGuard {
        fn before_write(&self, _: &Path) -> Result<(), String> {
            Ok(())
        }
        fn may_read(&self, _: &Path) -> bool {
            true
        }
    }

    /// A sidecar whose "processes" are fake runtimes handed to the test.
    fn fake_sidecar() -> (Arc<Sidecar>, mpsc::Receiver<FakeRuntime>) {
        let (tx, rx) = mpsc::channel();
        let tx = Mutex::new(tx);
        let sidecar = Sidecar::with_connector(
            Box::new(move |handler| {
                let (peer, rt) = fake_peer(true, handler);
                tx.lock().send(rt).unwrap();
                Ok(peer)
            }),
        );
        (sidecar, rx)
    }

    /// Answers `initialize` on a freshly started fake runtime.
    fn accept(rx: &mpsc::Receiver<FakeRuntime>) -> FakeRuntime {
        let mut rt = rx.recv_timeout(Duration::from_secs(5)).expect("sidecar started");
        let init = rt.expect("initialize");
        assert_eq!(init["jsonrpc"], "2.0");
        rt.send(json!({ "jsonrpc": "2.0", "id": init["id"], "result": { "version": "0.1.0", "node": "24.0.0" } }));
        rt
    }

    fn request(turn: &str, conv: &str, engine: Engine) -> TurnRequest {
        TurnRequest {
            conversation_id: conv.into(),
            turn_id: turn.into(),
            engine,
            model: "default".into(),
            mode: Mode::Agent,
            policy: Policy::Ask,
            cwd: PathBuf::from("C:/proj"),
            prompt: "Do it".into(),
            images: vec![],
            runtime_session_id: Some("sess-0".into()),
            handoff: None,
            reconfigure: false,
            api_key: Some("sk-ant-api03-secret-key".into()),
            executable: None,
        }
    }

    type Events = Arc<Mutex<Vec<AgentEvent>>>;

    fn collecting() -> (AgentSink, Events) {
        let events: Events = Arc::new(Mutex::new(Vec::new()));
        let e = Arc::clone(&events);
        (Arc::new(move |ev| e.lock().push(ev)), events)
    }

    fn wait_for(events: &Events, n: usize) {
        for _ in 0..500 {
            if events.lock().len() >= n {
                return;
            }
            thread::sleep(Duration::from_millis(10));
        }
        panic!("expected {n} events, got {}", events.lock().len());
    }

    /// Starts a turn on a background thread and answers its `turn/start`.
    fn start(adapter: &Arc<SdkAdapter>, rt: &mut FakeRuntime, req: TurnRequest, sink: AgentSink) -> (Box<dyn TurnHandle>, Value) {
        let a = Arc::clone(adapter);
        let t = thread::spawn(move || a.start_turn(req, Arc::new(NoGuard), sink));
        let msg = rt.expect("turn/start");
        rt.send(json!({ "jsonrpc": "2.0", "id": msg["id"], "result": {} }));
        (t.join().unwrap().map_err(|e| e.message).expect("turn accepted"), msg["params"].clone())
    }

    fn event(rt: &mut FakeRuntime, turn: &str, ev: Value) {
        rt.send(json!({ "jsonrpc": "2.0", "method": "turn/event", "params": { "turnId": turn, "event": ev } }));
    }

    #[test]
    fn routes_events_of_two_concurrent_turns() {
        let (sidecar, rx) = fake_sidecar();
        let claude = Arc::new(SdkAdapter::new(Engine::ClaudeCode, Arc::clone(&sidecar)));
        let copilot = Arc::new(SdkAdapter::new(Engine::CopilotCli, Arc::clone(&sidecar)));
        let c = Arc::clone(&claude);
        let starter = thread::spawn(move || {
            let (sink, events) = collecting();
            (c.start_turn(request("a", "c1", Engine::ClaudeCode), Arc::new(NoGuard), sink).map(|_| ()), events)
        });
        let mut rt = accept(&rx);
        let msg = rt.expect("turn/start");
        assert_eq!(msg["params"]["engine"], "claude-code");
        assert_eq!(msg["params"]["mode"], "agent");
        assert_eq!(msg["params"]["sessionId"], "sess-0");
        assert_eq!(msg["params"]["apiKey"], "sk-ant-api03-secret-key");
        rt.send(json!({ "jsonrpc": "2.0", "id": msg["id"], "result": {} }));
        let (res, a_events) = starter.join().unwrap();
        assert!(res.is_ok());

        assert!(msg["params"].get("images").is_none(), "no images, no field");

        let (b_sink, b_events) = collecting();
        let mut with_image = request("b", "c2", Engine::CopilotCli);
        with_image.images = vec![super::super::ImageInput { mime: "image/png".into(), data: "iVBORw0K".into() }];
        let (_h, params) = start(&copilot, &mut rt, with_image, b_sink);
        assert_eq!(params["images"], json!([{ "mimeType": "image/png", "data": "iVBORw0K" }]));
        assert_eq!(params["engine"], "copilot-cli");
        assert!(params.get("apiKey").is_none(), "the Anthropic key only goes to Claude");

        event(&mut rt, "a", json!({ "type": "session", "id": "s-a", "resumed": true }));
        event(&mut rt, "b", json!({ "type": "text", "text": "from b" }));
        event(&mut rt, "a", json!({ "type": "itemStarted", "key": "tu1", "status": "running", "body": { "kind": "command", "command": "ls", "output": "" } }));
        event(&mut rt, "b", json!({ "type": "usage", "usage": { "inputTokens": 3, "outputTokens": 4 } }));
        event(&mut rt, "a", json!({ "type": "done", "outcome": { "type": "completed" } }));
        event(&mut rt, "b", json!({ "type": "done", "outcome": { "type": "failed", "error": { "kind": "rate_limited", "message": "Slow down" } } }));
        // After done, a turn gets nothing more.
        event(&mut rt, "a", json!({ "type": "text", "text": "late" }));
        wait_for(&a_events, 3);
        wait_for(&b_events, 3);
        thread::sleep(Duration::from_millis(50));

        let a = a_events.lock();
        assert_eq!(a.len(), 3);
        assert!(matches!(&a[0], AgentEvent::Session { id, resumed: true } if id == "s-a"));
        assert!(matches!(&a[1], AgentEvent::ItemStarted { key, body: ItemBody::Command { command, .. }, .. } if key == "tu1" && command == "ls"));
        assert!(matches!(&a[2], AgentEvent::Done(TurnOutcome::Completed)));
        let b = b_events.lock();
        assert!(matches!(&b[0], AgentEvent::Text { text } if text == "from b"));
        assert!(matches!(&b[1], AgentEvent::Usage(u) if u.input_tokens == Some(3) && u.output_tokens == Some(4)));
        assert!(matches!(&b[2], AgentEvent::Done(TurnOutcome::Failed(e)) if e.kind == ErrorKind::RateLimited && e.message == "Slow down"));
        assert!(sidecar.routes.lock().is_empty());
    }

    #[test]
    fn approvals_round_trip_and_unknown_turns_are_cancelled() {
        let (sidecar, rx) = fake_sidecar();
        let adapter = Arc::new(SdkAdapter::new(Engine::ClaudeCode, sidecar));
        let replies: Arc<Mutex<Vec<(String, PermissionRequest, Reply)>>> = Arc::new(Mutex::new(Vec::new()));
        let r = Arc::clone(&replies);
        let sink: AgentSink = Arc::new(move |ev| {
            if let AgentEvent::Approval { key, request, reply } = ev {
                r.lock().push((key, request, reply));
            }
        });
        let a = Arc::clone(&adapter);
        let t = thread::spawn(move || a.start_turn(request("t1", "c1", Engine::ClaudeCode), Arc::new(NoGuard), sink).map(|_| ()));
        let mut rt = accept(&rx);
        let msg = rt.expect("turn/start");
        rt.send(json!({ "jsonrpc": "2.0", "id": msg["id"], "result": {} }));
        t.join().unwrap().unwrap();

        rt.send(json!({ "jsonrpc": "2.0", "id": 41, "method": "turn/approval", "params": {
            "turnId": "t1", "key": "tu9",
            "request": { "kind": "write", "title": "Edit src/a.rs", "path": "C:/proj/src/a.rs", "paths": [], "canAllowSession": true }
        }}));
        for _ in 0..200 {
            if !replies.lock().is_empty() {
                break;
            }
            thread::sleep(Duration::from_millis(10));
        }
        let (key, req, reply) = replies.lock().pop().expect("approval reached the sink");
        assert_eq!(key, "tu9");
        assert_eq!(req.kind, PermissionKind::Write);
        assert_eq!(req.path.as_deref(), Some("C:/proj/src/a.rs"));
        assert!(req.can_allow_session);
        reply(Decision::AllowSession);
        assert_eq!(rt.recv(), json!({ "jsonrpc": "2.0", "id": 41, "result": { "decision": "allow_session" } }));

        // A malformed request for a live turn is denied; one for an unknown turn is cancelled.
        rt.send(json!({ "jsonrpc": "2.0", "id": 42, "method": "turn/approval", "params": { "turnId": "t1", "key": "x", "request": { "kind": "teleport" } } }));
        assert_eq!(rt.recv()["result"]["decision"], "deny");
        rt.send(json!({ "jsonrpc": "2.0", "id": 43, "method": "turn/approval", "params": { "turnId": "gone", "key": "x", "request": { "kind": "read", "title": "r", "paths": [] } } }));
        assert_eq!(rt.recv()["result"]["decision"], "cancel");
        rt.send(json!({ "jsonrpc": "2.0", "id": 44, "method": "fs/readFile", "params": {} }));
        assert_eq!(rt.recv()["error"]["code"], -32601);
    }

    #[test]
    fn a_crash_ends_running_turns_and_the_next_turn_restarts_the_sidecar() {
        let (sidecar, rx) = fake_sidecar();
        let adapter = Arc::new(SdkAdapter::new(Engine::CopilotCli, Arc::clone(&sidecar)));
        let (sink, events) = collecting();
        let a = Arc::clone(&adapter);
        let t = thread::spawn(move || a.start_turn(request("t1", "c1", Engine::CopilotCli), Arc::new(NoGuard), sink).map(|_| ()));
        let mut rt = accept(&rx);
        let msg = rt.expect("turn/start");
        rt.send(json!({ "jsonrpc": "2.0", "id": msg["id"], "result": {} }));
        t.join().unwrap().unwrap();
        event(&mut rt, "t1", json!({ "type": "text", "text": "working" }));
        rt.close();
        wait_for(&events, 2);
        assert!(matches!(&events.lock()[1], AgentEvent::Done(TurnOutcome::Failed(e)) if e.kind == ErrorKind::RuntimeExited));

        let (sink2, events2) = collecting();
        let a = Arc::clone(&adapter);
        let t = thread::spawn(move || a.start_turn(request("t2", "c1", Engine::CopilotCli), Arc::new(NoGuard), sink2).map(|_| ()));
        let mut rt2 = accept(&rx);
        let msg = rt2.expect("turn/start");
        assert_eq!(msg["params"]["turnId"], "t2");
        rt2.send(json!({ "jsonrpc": "2.0", "id": msg["id"], "result": {} }));
        t.join().unwrap().unwrap();
        event(&mut rt2, "t2", json!({ "type": "done", "outcome": { "type": "cancelled" } }));
        wait_for(&events2, 1);
        assert!(matches!(&events2.lock()[0], AgentEvent::Done(TurnOutcome::Cancelled)));
    }

    #[test]
    fn malformed_events_are_ignored_and_unknown_error_kinds_still_end_the_turn() {
        let (sidecar, rx) = fake_sidecar();
        let adapter = Arc::new(SdkAdapter::new(Engine::ClaudeCode, sidecar));
        let (sink, events) = collecting();
        let a = Arc::clone(&adapter);
        let t = thread::spawn(move || a.start_turn(request("t1", "c1", Engine::ClaudeCode), Arc::new(NoGuard), sink).map(|_| ()));
        let mut rt = accept(&rx);
        let msg = rt.expect("turn/start");
        rt.send(json!({ "jsonrpc": "2.0", "id": msg["id"], "result": {} }));
        t.join().unwrap().unwrap();

        event(&mut rt, "t1", json!({ "type": "teleport", "where": "mars" }));
        event(&mut rt, "t1", json!({ "type": "text" }));
        event(&mut rt, "t1", json!({ "type": "itemStarted", "key": "k", "status": "exploding", "body": {} }));
        event(&mut rt, "other-turn", json!({ "type": "text", "text": "not mine" }));
        rt.send(json!({ "jsonrpc": "2.0", "method": "turn/event", "params": { "event": { "type": "text", "text": "no turn id" } } }));
        rt.send(json!({ "jsonrpc": "2.0", "method": "log", "params": {} }));
        event(&mut rt, "t1", json!({ "type": "textBreak" }));
        event(&mut rt, "t1", json!({ "type": "notice", "text": "key sk-ant-api03-abcdefgh leaked", "tone": "warn" }));
        event(&mut rt, "t1", json!({ "type": "done", "outcome": { "type": "failed", "error": { "kind": "brand_new_kind", "message": "Odd" } } }));
        wait_for(&events, 3);
        let ev = events.lock();
        assert_eq!(ev.len(), 3);
        assert!(matches!(&ev[0], AgentEvent::TextBreak));
        assert!(matches!(&ev[1], AgentEvent::Notice { text, tone: Tone::Warn } if !text.contains("abcdefgh")));
        assert!(matches!(&ev[2], AgentEvent::Done(TurnOutcome::Failed(e)) if e.kind == ErrorKind::ProviderError && e.message == "Odd"));
    }

    #[test]
    fn probe_maps_the_result_and_start_failures() {
        let (sidecar, rx) = fake_sidecar();
        let adapter = Arc::new(SdkAdapter::new(Engine::CopilotCli, sidecar));
        let a = Arc::clone(&adapter);
        let t = thread::spawn(move || a.probe(Some(Path::new("C:/tools/copilot.exe")), None));
        let mut rt = accept(&rx);
        let msg = rt.expect("probe");
        assert_eq!(msg["params"], json!({ "engine": "copilot-cli", "executable": "C:/tools/copilot.exe" }));
        rt.send(json!({ "jsonrpc": "2.0", "id": msg["id"], "result": {
            "state": "sign_in_needed", "message": "Run copilot", "version": "1.0.103",
            "models": [{ "id": "default", "label": "Default", "isDefault": true }]
        }}));
        let p = t.join().unwrap();
        assert_eq!(p.state, ProbeState::SignInNeeded);
        assert_eq!(p.message.as_deref(), Some("Run copilot"));
        assert_eq!(p.version.as_deref(), Some("1.0.103"));
        assert_eq!(p.models.len(), 1);
        assert!(p.models[0].is_default);

        // No script: not found, with the build hint.
        let missing = SdkAdapter::new(Engine::ClaudeCode, Sidecar::new(Some(PathBuf::from("Z:/nowhere/main.mjs"))));
        let p = missing.probe(None, None);
        assert_eq!(p.state, ProbeState::NotFound);
        assert!(p.message.unwrap().contains("isn't built"));
        let err = missing.start_turn(request("t", "c", Engine::ClaudeCode), Arc::new(NoGuard), Arc::new(|_| {})).err().unwrap();
        assert_eq!(err.kind, ErrorKind::EngineNotFound);
    }

    #[test]
    fn rejected_turn_start_is_an_error_and_unroutes_the_turn() {
        let (sidecar, rx) = fake_sidecar();
        let adapter = Arc::new(SdkAdapter::new(Engine::ClaudeCode, Arc::clone(&sidecar)));
        let a = Arc::clone(&adapter);
        let t = thread::spawn(move || a.start_turn(request("t1", "c1", Engine::ClaudeCode), Arc::new(NoGuard), Arc::new(|_| {})).map(|_| ()));
        let mut rt = accept(&rx);
        let msg = rt.expect("turn/start");
        rt.send(json!({ "jsonrpc": "2.0", "id": msg["id"], "error": { "code": -32602, "message": "unknown mode" } }));
        let err = t.join().unwrap().unwrap_err();
        assert_eq!(err.kind, ErrorKind::InvalidRequest);
        assert!(sidecar.routes.lock().is_empty());
    }

    #[test]
    fn interrupt_and_close_go_to_the_running_sidecar() {
        let (sidecar, rx) = fake_sidecar();
        let adapter = Arc::new(SdkAdapter::new(Engine::ClaudeCode, Arc::clone(&sidecar)));
        // Nothing running: close_session doesn't start the sidecar.
        adapter.close_session("c0");
        assert!(rx.try_recv().is_err());
        let a = Arc::clone(&adapter);
        let t = thread::spawn(move || a.start_turn(request("t1", "c1", Engine::ClaudeCode), Arc::new(NoGuard), Arc::new(|_| {})));
        let mut rt = accept(&rx);
        let msg = rt.expect("turn/start");
        rt.send(json!({ "jsonrpc": "2.0", "id": msg["id"], "result": {} }));
        let handle = t.join().unwrap().map_err(|e| e.message).unwrap();
        handle.interrupt();
        let m = rt.expect("turn/interrupt");
        assert_eq!(m["params"]["turnId"], "t1");
        rt.send(json!({ "jsonrpc": "2.0", "id": m["id"], "result": {} }));
        let a = Arc::clone(&adapter);
        let closer = thread::spawn(move || a.close_session("c1"));
        let m = rt.expect("session/close");
        assert_eq!(m["params"]["conversationId"], "c1");
        rt.send(json!({ "jsonrpc": "2.0", "id": m["id"], "result": {} }));
        closer.join().unwrap();
        let a = Arc::clone(&adapter);
        let stopper = thread::spawn(move || a.shutdown());
        let m = rt.expect("shutdown");
        rt.send(json!({ "jsonrpc": "2.0", "id": m["id"], "result": {} }));
        stopper.join().unwrap();
        assert!(sidecar.running().is_none());
    }

    #[test]
    fn node_version_range() {
        for ok in ["v20.19.0", "v22.12.0", "v24.22.0", "v26.1.0\n"] {
            assert!(node_supported(ok), "{ok}");
        }
        for bad in ["v18.20.0", "v20.18.9", "v21.7.0", "v22.11.0", "", "garbage"] {
            assert!(!node_supported(bad), "{bad}");
        }
    }

    /// Probe-only smoke test against the real sidecar build (`pnpm --filter agenthub-sidecar build`).
    /// Starts the sidecar and Claude Code's initialize; sends no prompt, so no API request.
    #[test]
    #[ignore]
    fn live_probe_smoke() {
        let script = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("sidecar").join("dist").join("main.mjs");
        assert!(script.is_file(), "build the sidecar first");
        let sidecar = Sidecar::new(Some(script));
        let claude = SdkAdapter::new(Engine::ClaudeCode, Arc::clone(&sidecar));
        let p = claude.probe(None, None);
        eprintln!("claude: {:?} {:?} {:?} models={}", p.state, p.path, p.version, p.models.len());
        assert_eq!(p.state, ProbeState::Ready, "{:?}", p.message);
        let copilot = SdkAdapter::new(Engine::CopilotCli, Arc::clone(&sidecar));
        let p = copilot.probe(None, None);
        eprintln!("copilot: {:?} {:?} {:?} {:?}", p.state, p.version, p.message, p.models.len());
        sidecar.shutdown();
    }
}
