//! Drives one agent turn: turns `AgentEvent`s into stored items and
//! `ChatEvent`s, answers approvals through `policy` (or waits for the user),
//! checkpoints files before any write is allowed, and records the resulting
//! file changes when the turn ends.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Weak};
use std::time::{Duration, Instant};

use parking_lot::Mutex;

use super::{AgentEvent, AgentSink, EngineAdapter, Reply, TurnHandle, TurnOutcome, TurnRequest, WriteGuard};
use crate::chat::checkpoints::{Checkpoints, Snapshot};
use crate::chat::policy::{self, Verdict};
use crate::chat::service::Sink;
use crate::chat::{
    repository, ChangeState, ChatError, ChatEvent, Conversation, ConversationStatus, Decision, Engine, ErrorKind, Item, ItemBody,
    ItemStatus, MessageStatus, Mode, PermissionKind, PermissionRequest, Policy, Tone, Usage,
};
use crate::error::{now_ms, AppError, AppResult};
use crate::persistence::Db;

const SAVE_EVERY: Duration = Duration::from_millis(1500);
/// Command output kept per item.
const MAX_OUTPUT: usize = 256 * 1024;

struct PendingApproval {
    turn: Arc<Turn>,
    reply: Reply,
}

/// Owns the engine adapters and the approvals waiting for the user.
pub struct AgentRuntime {
    db: Arc<Db>,
    checkpoints: Arc<Checkpoints>,
    adapters: HashMap<Engine, Arc<dyn EngineAdapter>>,
    approvals: Mutex<HashMap<String, PendingApproval>>,
}

/// Called once when a turn has fully ended (to release the conversation).
pub type OnDone = Box<dyn FnOnce() + Send>;

pub struct StartTurn {
    pub request: TurnRequest,
    pub message_id: String,
    pub on_done: OnDone,
}

impl AgentRuntime {
    pub fn new(db: Arc<Db>, checkpoints: Arc<Checkpoints>, adapters: Vec<Arc<dyn EngineAdapter>>) -> Arc<Self> {
        Arc::new(Self {
            db,
            checkpoints,
            adapters: adapters.into_iter().map(|a| (a.engine(), a)).collect(),
            approvals: Mutex::new(HashMap::new()),
        })
    }

    pub fn adapter(&self, engine: Engine) -> Option<Arc<dyn EngineAdapter>> {
        self.adapters.get(&engine).cloned()
    }

    pub fn checkpoints(&self) -> &Arc<Checkpoints> {
        &self.checkpoints
    }

    /// Starts a turn. Returns the turn (for `interrupt`) once the adapter accepted it.
    pub fn start(self: &Arc<Self>, start: StartTurn, sink: Sink) -> Result<Arc<Turn>, ChatError> {
        let req = start.request;
        let adapter = self
            .adapter(req.engine)
            .ok_or_else(|| ChatError::new(ErrorKind::EngineNotFound, format!("{} isn't available in this build.", req.engine.label())))?;
        let turn = Arc::new(Turn {
            runtime: Arc::downgrade(self),
            db: Arc::clone(&self.db),
            checkpoints: Arc::clone(&self.checkpoints),
            conversation_id: req.conversation_id.clone(),
            request_id: req.turn_id.clone(),
            message_id: start.message_id,
            engine: req.engine,
            mode: req.mode,
            policy: req.policy,
            root: req.cwd.clone(),
            sink,
            state: Mutex::new(TurnState::default()),
            handle: Mutex::new(None),
            on_done: Mutex::new(Some(start.on_done)),
        });
        let t = Arc::clone(&turn);
        let agent_sink: AgentSink = Arc::new(move |ev| t.handle_event(ev));
        let guard: Arc<dyn WriteGuard> = Arc::new(Guard(Arc::downgrade(&turn)));
        let handle = adapter.start_turn(req, guard, agent_sink)?;
        // An adapter may already have finished (a fast failure); don't keep a handle then.
        if !turn.state.lock().done {
            *turn.handle.lock() = Some(handle);
        }
        Ok(turn)
    }

    /// The user's answer to a pending approval.
    pub fn respond(&self, item_id: &str, decision: Decision) -> AppResult<()> {
        let pending = self
            .approvals
            .lock()
            .remove(item_id)
            .ok_or_else(|| AppError::Invalid("This approval was already answered or has expired".into()))?;
        pending.turn.resolve(item_id, decision, pending.reply, false, None);
        Ok(())
    }

    fn cancel_approvals(&self, turn: &Turn) {
        let ids: Vec<String> = self
            .approvals
            .lock()
            .iter()
            .filter(|(_, p)| p.turn.request_id == turn.request_id)
            .map(|(k, _)| k.clone())
            .collect();
        for id in ids {
            if let Some(p) = self.approvals.lock().remove(&id) {
                p.turn.resolve(&id, Decision::Cancel, p.reply, true, Some("The turn ended before you answered".into()));
            }
        }
    }

    pub fn has_pending_approval(&self, conversation_id: &str) -> bool {
        self.approvals.lock().values().any(|p| p.turn.conversation_id == conversation_id)
    }

    pub fn close_session(&self, engine: Engine, conversation_id: &str) {
        if let Some(a) = self.adapter(engine) {
            a.close_session(conversation_id);
        }
    }

    pub fn shutdown(&self) {
        for a in self.adapters.values() {
            a.shutdown();
        }
    }
}

struct FileTrack {
    snapshot: Option<Snapshot>,
}

#[derive(Default)]
struct TurnState {
    next_idx: i64,
    /// Current text block: item id and its text.
    text: Option<Item>,
    thinking: Option<Item>,
    items: HashMap<String, Item>,
    content: String,
    usage: Usage,
    last_save: Option<Instant>,
    files: Vec<(PathBuf, FileTrack)>,
    done: bool,
    waiting: usize,
}

pub struct Turn {
    runtime: Weak<AgentRuntime>,
    db: Arc<Db>,
    checkpoints: Arc<Checkpoints>,
    pub conversation_id: String,
    pub request_id: String,
    pub message_id: String,
    engine: Engine,
    mode: Mode,
    policy: Policy,
    root: PathBuf,
    sink: Sink,
    state: Mutex<TurnState>,
    handle: Mutex<Option<Box<dyn TurnHandle>>>,
    on_done: Mutex<Option<OnDone>>,
}

/// `WriteGuard` handed to adapters; weak so a finished turn can drop.
struct Guard(Weak<Turn>);

impl WriteGuard for Guard {
    fn before_write(&self, path: &Path) -> Result<(), String> {
        let Some(turn) = self.0.upgrade() else { return Err("The turn has ended".into()) };
        if turn.mode != Mode::Agent {
            return Err("This mode doesn't allow edits".into());
        }
        if !policy::inside_root(&turn.root, &path.to_string_lossy()) {
            return Err("Writes outside the project folder aren't allowed".into());
        }
        turn.checkpoint(path);
        Ok(())
    }

    fn may_read(&self, path: &Path) -> bool {
        let Some(turn) = self.0.upgrade() else { return false };
        let req = PermissionRequest {
            kind: PermissionKind::Read,
            title: "Read a file".into(),
            command: None,
            path: Some(path.to_string_lossy().to_string()),
            paths: vec![],
            detail: None,
            can_allow_session: false,
        };
        matches!(policy::decide(turn.mode, turn.policy, &req, Some(&turn.root)), Verdict::Allow(_))
    }
}

impl Turn {
    fn emit(&self, ev: ChatEvent) {
        (self.sink)(ev);
    }

    fn new_item(&self, st: &mut TurnState, status: ItemStatus, body: ItemBody) -> Item {
        let now = now_ms();
        let item = Item {
            id: uuid::Uuid::new_v4().to_string(),
            message_id: self.message_id.clone(),
            idx: st.next_idx,
            status,
            body,
            created_at: now,
            updated_at: now,
        };
        st.next_idx += 1;
        item
    }

    fn save_item(&self, item: &Item) {
        let _ = repository::upsert_item(&self.db, &self.conversation_id, item);
        self.emit(ChatEvent::Item {
            conversation_id: self.conversation_id.clone(),
            request_id: self.request_id.clone(),
            message_id: self.message_id.clone(),
            item: item.clone(),
        });
    }

    fn end_blocks(&self, st: &mut TurnState) {
        if let Some(mut t) = st.text.take() {
            t.status = ItemStatus::Completed;
            t.updated_at = now_ms();
            self.save_item(&t);
            if !st.content.ends_with("\n\n") && !st.content.is_empty() {
                st.content.push_str("\n\n");
            }
        }
        if let Some(mut t) = st.thinking.take() {
            t.status = ItemStatus::Completed;
            self.save_item(&t);
        }
    }

    fn maybe_save(&self, st: &mut TurnState) {
        if st.last_save.is_some_and(|t| t.elapsed() < SAVE_EVERY) {
            return;
        }
        st.last_save = Some(Instant::now());
        let _ = repository::save_partial(&self.db, &self.message_id, &st.content);
        for item in st.text.iter().chain(st.thinking.iter()) {
            let _ = repository::upsert_item(&self.db, &self.conversation_id, item);
        }
        for item in st.items.values().filter(|i| matches!(i.body, ItemBody::Command { .. }) && i.status == ItemStatus::Running) {
            let _ = repository::upsert_item(&self.db, &self.conversation_id, item);
        }
    }

    fn set_status(&self, status: ConversationStatus) {
        let _ = repository::set_status(&self.db, &self.conversation_id, status);
        self.emit(ChatEvent::Status {
            conversation_id: self.conversation_id.clone(),
            request_id: self.request_id.clone(),
            status,
        });
    }

    fn system(&self, st: &mut TurnState, text: String, tone: Tone) {
        self.end_blocks(st);
        let item = self.new_item(st, ItemStatus::Completed, ItemBody::System { text, tone });
        self.save_item(&item);
    }

    /// Snapshot `path` once per turn, before its first write.
    fn checkpoint(&self, path: &Path) {
        let mut st = self.state.lock();
        if st.files.iter().any(|(p, _)| p == path) {
            return;
        }
        let snapshot = self.checkpoints.snapshot(&self.conversation_id, path).ok().flatten();
        st.files.push((path.to_path_buf(), FileTrack { snapshot }));
    }

    fn checkpoint_request(&self, req: &PermissionRequest) {
        if !matches!(req.kind, PermissionKind::Write | PermissionKind::Delete) {
            return;
        }
        for p in req.path.iter().chain(req.paths.iter()) {
            let path = Path::new(p);
            let abs = if path.is_absolute() { path.to_path_buf() } else { self.root.join(path) };
            self.checkpoint(&abs);
        }
    }

    pub fn interrupt(&self) {
        if let Some(rt) = self.runtime.upgrade() {
            rt.cancel_approvals(self);
        }
        if let Some(h) = self.handle.lock().as_ref() {
            h.interrupt();
        }
    }

    /// Applies a decision (the user's or the policy's) to an approval item.
    fn resolve(&self, item_id: &str, decision: Decision, reply: Reply, auto: bool, reason: Option<String>) {
        let mut st = self.state.lock();
        let Some(item) = st.items.values_mut().find(|i| i.id == item_id) else {
            drop(st);
            reply(decision);
            return;
        };
        let request = match &item.body {
            ItemBody::Permission { request, .. } => request.clone(),
            _ => return,
        };
        item.body = ItemBody::Permission { request: request.clone(), decision: Some(decision), auto, reason };
        item.status = if decision.allows() { ItemStatus::Completed } else if decision == Decision::Cancel { ItemStatus::Cancelled } else { ItemStatus::Declined };
        item.updated_at = now_ms();
        let item = item.clone();
        if !auto {
            st.waiting = st.waiting.saturating_sub(1);
        }
        let still_waiting = st.waiting > 0;
        let done = st.done;
        drop(st);
        if decision.allows() {
            self.checkpoint_request(&request);
        }
        self.save_item(&item);
        if !auto && !done && !still_waiting {
            self.set_status(ConversationStatus::Running);
        }
        reply(decision);
    }

    fn handle_event(self: &Arc<Self>, ev: AgentEvent) {
        let mut st = self.state.lock();
        if st.done {
            // A late event after Done: approvals must still get an answer.
            if let AgentEvent::Approval { reply, .. } = ev {
                drop(st);
                reply(Decision::Cancel);
            }
            return;
        }
        match ev {
            AgentEvent::Session { id, resumed: _ } => {
                let _ = repository::set_runtime_session(&self.db, &self.conversation_id, Some(&id));
            }
            AgentEvent::ResumeFailed { message } => {
                let text = format!(
                    "Couldn't resume the previous {} session ({}). This turn started a new session; the earlier messages were passed to it as plain text, but its own context from before (files it read, tool results) is gone.",
                    self.engine.label(),
                    message
                );
                self.system(&mut st, text, Tone::Warn);
            }
            AgentEvent::Text { text } => {
                if let Some(mut t) = st.thinking.take() {
                    t.status = ItemStatus::Completed;
                    self.save_item(&t);
                }
                if st.text.is_none() {
                    let item = self.new_item(&mut st, ItemStatus::Running, ItemBody::Text { text: String::new() });
                    self.save_item(&item);
                    st.text = Some(item);
                }
                let id = {
                    let t = st.text.as_mut().unwrap();
                    if let ItemBody::Text { text: buf } = &mut t.body {
                        buf.push_str(&text);
                    }
                    t.updated_at = now_ms();
                    t.id.clone()
                };
                st.content.push_str(&text);
                self.emit(ChatEvent::Delta {
                    conversation_id: self.conversation_id.clone(),
                    request_id: self.request_id.clone(),
                    message_id: self.message_id.clone(),
                    text,
                    item_id: Some(id),
                });
                self.maybe_save(&mut st);
            }
            AgentEvent::TextBreak => self.end_blocks(&mut st),
            AgentEvent::Thinking { text } => {
                if st.thinking.is_none() {
                    if let Some(mut t) = st.text.take() {
                        t.status = ItemStatus::Completed;
                        self.save_item(&t);
                    }
                    let item = self.new_item(&mut st, ItemStatus::Running, ItemBody::Thinking { text: String::new() });
                    st.thinking = Some(item);
                }
                let t = st.thinking.as_mut().unwrap();
                if let ItemBody::Thinking { text: buf } = &mut t.body {
                    buf.push_str(&text);
                }
                let item = t.clone();
                self.save_item(&item);
            }
            AgentEvent::ItemStarted { key, status, body } | AgentEvent::ItemUpdated { key, status, body } => {
                self.end_blocks(&mut st);
                let item = match st.items.get(&key).cloned() {
                    Some(mut existing) => {
                        // Keep output streamed so far when the update has none.
                        let body = match (&existing.body, body) {
                            (ItemBody::Command { output: old, .. }, ItemBody::Command { command, cwd, output, exit_code, duration_ms }) => {
                                ItemBody::Command { command, cwd, output: if output.is_empty() { old.clone() } else { output }, exit_code, duration_ms }
                            }
                            (_, b) => b,
                        };
                        existing.body = body;
                        existing.status = status;
                        existing.updated_at = now_ms();
                        existing
                    }
                    None => self.new_item(&mut st, status, body),
                };
                st.items.insert(key, item.clone());
                self.save_item(&item);
            }
            AgentEvent::Output { key, text } => {
                let Some(item) = st.items.get_mut(&key) else { return };
                if let ItemBody::Command { output, .. } = &mut item.body {
                    if output.len() < MAX_OUTPUT {
                        output.push_str(&text);
                    }
                }
                let item_id = item.id.clone();
                self.emit(ChatEvent::Output {
                    conversation_id: self.conversation_id.clone(),
                    request_id: self.request_id.clone(),
                    item_id,
                    text,
                });
                self.maybe_save(&mut st);
            }
            AgentEvent::Plan { steps, explanation } => {
                self.end_blocks(&mut st);
                let item = match st.items.get("__plan").cloned() {
                    Some(mut p) => {
                        p.body = ItemBody::Plan { steps, explanation };
                        p.updated_at = now_ms();
                        p
                    }
                    None => self.new_item(&mut st, ItemStatus::Completed, ItemBody::Plan { steps, explanation }),
                };
                st.items.insert("__plan".into(), item.clone());
                self.save_item(&item);
            }
            AgentEvent::Approval { key, request, reply } => {
                self.end_blocks(&mut st);
                let verdict = policy::decide(self.mode, self.policy, &request, Some(&self.root));
                let item = self.new_item(
                    &mut st,
                    ItemStatus::Pending,
                    ItemBody::Permission { request, decision: None, auto: false, reason: None },
                );
                let id = item.id.clone();
                st.items.insert(format!("approval:{key}:{id}"), item.clone());
                match verdict.auto_decision() {
                    Some(decision) => {
                        drop(st);
                        self.resolve(&id, decision, reply, true, verdict.reason().map(str::to_string));
                    }
                    None => {
                        st.waiting += 1;
                        drop(st);
                        self.save_item(&item);
                        self.set_status(ConversationStatus::WaitingForApproval);
                        match self.runtime.upgrade() {
                            Some(rt) => {
                                rt.approvals.lock().insert(id, PendingApproval { turn: Arc::clone(self), reply });
                            }
                            None => reply(Decision::Cancel),
                        }
                    }
                }
            }
            AgentEvent::Usage(u) => {
                st.usage.merge(u);
                let usage = st.usage;
                self.emit(ChatEvent::Usage {
                    conversation_id: self.conversation_id.clone(),
                    request_id: self.request_id.clone(),
                    message_id: self.message_id.clone(),
                    usage,
                });
            }
            AgentEvent::Notice { text, tone } => self.system(&mut st, text, tone),
            AgentEvent::Done(outcome) => {
                st.done = true;
                self.end_blocks(&mut st);
                // Anything still running didn't finish.
                let open: Vec<Item> = st
                    .items
                    .values()
                    .filter(|i| i.status == ItemStatus::Running && !matches!(i.body, ItemBody::Permission { .. }))
                    .cloned()
                    .collect();
                for mut i in open {
                    i.status = if outcome == TurnOutcome::Completed { ItemStatus::Completed } else { ItemStatus::Cancelled };
                    self.save_item(&i);
                }
                let files = std::mem::take(&mut st.files);
                for (path, track) in files {
                    self.record_change(&mut st, &path, track);
                }
                let content = std::mem::take(&mut st.content).trim_end().to_string();
                let usage = st.usage;
                drop(st);
                if let Some(rt) = self.runtime.upgrade() {
                    rt.cancel_approvals(self);
                }
                self.finish(outcome, content, usage);
            }
        }
    }

    fn record_change(&self, st: &mut TurnState, path: &Path, track: FileTrack) {
        let rel = path
            .strip_prefix(&self.root)
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .unwrap_or_else(|_| path.to_string_lossy().to_string());
        let (change, additions, deletions, checkpoint) = match &track.snapshot {
            Some(s) => match self.checkpoints.diff(&self.conversation_id, &s.id, path) {
                Ok(d) if d.additions == 0 && d.deletions == 0 && d.change == crate::chat::ChangeKind::Modify && !d.binary => return,
                Ok(d) => (d.change, d.additions, d.deletions, Some(s.id.clone())),
                Err(_) => return,
            },
            // Too large to checkpoint: report it, without Revert.
            None => (crate::chat::ChangeKind::Modify, 0, 0, None),
        };
        if track.snapshot.as_ref().is_some_and(|s| !s.existed) && !path.exists() {
            return; // approved but never written
        }
        let item = self.new_item(
            st,
            ItemStatus::Completed,
            ItemBody::FileChange { path: rel, change, additions, deletions, checkpoint, state: ChangeState::Applied },
        );
        self.save_item(&item);
    }

    fn finish(&self, outcome: TurnOutcome, content: String, usage: Usage) {
        let (status, error, conv_status) = match outcome {
            TurnOutcome::Completed => (MessageStatus::Complete, None, ConversationStatus::Completed),
            TurnOutcome::Cancelled => (MessageStatus::Stopped, None, ConversationStatus::Cancelled),
            TurnOutcome::Failed(e) => (MessageStatus::Error, Some(e), ConversationStatus::Failed),
        };
        let stored = repository::finish(&self.db, &self.message_id, &content, status, error.as_ref(), Some(&usage));
        let _ = repository::set_status(&self.db, &self.conversation_id, conv_status);
        if let (Ok(Some(message)), Ok(conversation)) = (stored, repository::get_conversation(&self.db, &self.conversation_id)) {
            self.emit(ChatEvent::Finished {
                conversation_id: self.conversation_id.clone(),
                request_id: self.request_id.clone(),
                message,
                conversation,
            });
        }
        self.handle.lock().take();
        if let Some(f) = self.on_done.lock().take() {
            f();
        }
    }
}

/// Reverts or keeps an agent's file change (from the Changes panel).
pub fn set_change_state(db: &Db, checkpoints: &Checkpoints, root: &Path, item_id: &str, keep: bool) -> AppResult<(Conversation, Item)> {
    let (conversation_id, mut item) = repository::get_item(db, item_id)?;
    let ItemBody::FileChange { path, change, additions, deletions, checkpoint, state } = item.body.clone() else {
        return Err(AppError::Invalid("Not a file change".into()));
    };
    if state == ChangeState::Reverted {
        return Err(AppError::Invalid("This change was already reverted".into()));
    }
    let abs = {
        let p = Path::new(&path);
        if p.is_absolute() { p.to_path_buf() } else { crate::filesystem::resolve(root, &path)? }
    };
    let new_state = if keep {
        ChangeState::Kept
    } else {
        let id = checkpoint.as_deref().ok_or_else(|| AppError::Invalid("This change has no checkpoint, so it can't be reverted here".into()))?;
        checkpoints.revert(&conversation_id, id, &abs)?;
        ChangeState::Reverted
    };
    item.body = ItemBody::FileChange { path, change, additions, deletions, checkpoint, state: new_state };
    item.updated_at = now_ms();
    repository::upsert_item(db, &conversation_id, &item)?;
    Ok((repository::get_conversation(db, &conversation_id)?, item))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat::engines::EngineProbe;
    use crate::chat::repository::NewConversation;
    use crate::chat::{ChangeKind, ToolKind};
    use std::sync::mpsc;

    type Script = Box<dyn FnOnce(TurnRequest, Arc<dyn WriteGuard>, AgentSink) + Send>;

    /// A scripted adapter: each turn plays the events the test queued.
    struct Scripted {
        script: Mutex<Option<Script>>,
        interrupted: Arc<Mutex<bool>>,
    }

    struct Handle(Arc<Mutex<bool>>);
    impl TurnHandle for Handle {
        fn interrupt(&self) {
            *self.0.lock() = true;
        }
    }

    impl EngineAdapter for Scripted {
        fn engine(&self) -> Engine {
            Engine::Codex
        }
        fn probe(&self, _: Option<&Path>, _: Option<&str>) -> EngineProbe {
            EngineProbe::new(Engine::Codex, crate::chat::engines::ProbeState::Ready, None)
        }
        fn start_turn(&self, req: TurnRequest, guard: Arc<dyn WriteGuard>, sink: AgentSink) -> Result<Box<dyn TurnHandle>, ChatError> {
            let f = self.script.lock().take().expect("one turn per test");
            std::thread::spawn(move || f(req, guard, sink));
            Ok(Box::new(Handle(Arc::clone(&self.interrupted))))
        }
        fn close_session(&self, _: &str) {}
        fn shutdown(&self) {}
    }

    struct Env {
        _dir: tempfile::TempDir,
        root: PathBuf,
        db: Arc<Db>,
        rt: Arc<AgentRuntime>,
        conv: Conversation,
        message_id: String,
        events: mpsc::Receiver<ChatEvent>,
        sink: Sink,
        done: mpsc::Receiver<()>,
        on_done: Option<OnDone>,
    }

    fn env(mode: Mode, policy: Policy, script: impl FnOnce(TurnRequest, Arc<dyn WriteGuard>, AgentSink) + Send + 'static) -> Env {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("proj");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("a.rs"), "one\ntwo\n").unwrap();
        // Project roots are canonical (as `projects::root` returns them).
        let root = dunce::canonicalize(&root).unwrap();
        let db = Arc::new(Db::open_in_memory().unwrap());
        let conv = repository::create_conversation(
            &db,
            NewConversation { project_id: None, engine: Engine::Codex, model: "m", mode, policy, title: "T" },
        )
        .unwrap();
        let reply = repository::begin_reply(&db, &conv.id, Some("Do it"), Engine::Codex, "m").unwrap();
        let adapter = Arc::new(Scripted { script: Mutex::new(Some(Box::new(script))), interrupted: Arc::new(Mutex::new(false)) });
        let rt = AgentRuntime::new(Arc::clone(&db), Arc::new(Checkpoints::new(dir.path().join("cp"))), vec![adapter]);
        let (tx, events) = mpsc::channel();
        let tx = Mutex::new(tx);
        let sink: Sink = Arc::new(move |e| drop(tx.lock().send(e)));
        let (dtx, done) = mpsc::channel();
        Env {
            _dir: dir,
            root,
            db,
            rt,
            conv,
            message_id: reply.assistant_message.id,
            events,
            sink,
            done,
            on_done: Some(Box::new(move || { let _ = dtx.send(()); })),
        }
    }

    fn request(e: &mut Env) -> StartTurn {
        StartTurn {
            request: TurnRequest {
                conversation_id: e.conv.id.clone(),
                turn_id: "turn-1".into(),
                engine: Engine::Codex,
                model: "m".into(),
                mode: e.conv.mode,
                policy: e.conv.policy,
                cwd: e.root.clone(),
                prompt: "Do it".into(),
                images: vec![],
                runtime_session_id: None,
                handoff: None,
                reconfigure: false,
                api_key: None,
                executable: None,
            },
            message_id: e.message_id.clone(),
            on_done: e.on_done.take().unwrap(),
        }
    }

    fn until_finished(e: &Env) -> (Vec<ChatEvent>, crate::chat::ChatMessage) {
        let mut seen = vec![];
        loop {
            let ev = e.events.recv_timeout(Duration::from_secs(10)).expect("timed out");
            if let ChatEvent::Finished { message, .. } = &ev {
                let m = message.clone();
                seen.push(ev);
                return (seen, m);
            }
            seen.push(ev);
        }
    }

    fn write_req(path: &Path) -> PermissionRequest {
        PermissionRequest {
            kind: PermissionKind::Write,
            title: "Edit a.rs".into(),
            command: None,
            path: Some(path.to_string_lossy().to_string()),
            paths: vec![],
            detail: None,
            can_allow_session: true,
        }
    }

    #[test]
    fn text_tools_and_an_auto_approved_edit_become_items_and_a_file_change() {
        let mut e = env(Mode::Agent, Policy::AutoEdits, |req, _guard, sink| {
            sink(AgentEvent::Session { id: "thr_1".into(), resumed: false });
            sink(AgentEvent::Text { text: "I'll edit ".into() });
            sink(AgentEvent::Text { text: "a.rs.".into() });
            sink(AgentEvent::ItemStarted {
                key: "t1".into(),
                status: ItemStatus::Running,
                body: ItemBody::Tool { tool: ToolKind::Edit, title: "a.rs".into(), detail: None, result: None },
            });
            let file = req.cwd.join("a.rs");
            let (tx, rx) = mpsc::channel();
            sink(AgentEvent::Approval { key: "t1".into(), request: write_req(&file), reply: Box::new(move |d| { let _ = tx.send(d); }) });
            assert_eq!(rx.recv().unwrap(), Decision::AllowOnce);
            std::fs::write(&file, "one\nTWO\nthree\n").unwrap();
            sink(AgentEvent::ItemUpdated {
                key: "t1".into(),
                status: ItemStatus::Completed,
                body: ItemBody::Tool { tool: ToolKind::Edit, title: "a.rs".into(), detail: None, result: None },
            });
            sink(AgentEvent::Text { text: "Done.".into() });
            sink(AgentEvent::Usage(Usage { input_tokens: Some(10), output_tokens: Some(5), cost_usd: None }));
            sink(AgentEvent::Done(TurnOutcome::Completed));
        });
        let start = request(&mut e);
        e.rt.start(start, Arc::clone(&e.sink)).unwrap();
        let (_events, msg) = until_finished(&e);
        e.done.recv_timeout(Duration::from_secs(2)).unwrap();
        assert_eq!(msg.status, MessageStatus::Complete);
        assert_eq!(msg.content, "I'll edit a.rs.\n\nDone.");
        let kinds: Vec<&str> = msg.items.iter().map(|i| i.body.kind()).collect();
        assert_eq!(kinds, vec!["text", "tool", "permission", "text", "file_change"]);
        match &msg.items[2].body {
            ItemBody::Permission { decision, auto, .. } => assert_eq!((*decision, *auto), (Some(Decision::AllowOnce), true)),
            other => panic!("{other:?}"),
        }
        let change = msg.items.last().unwrap();
        match &change.body {
            ItemBody::FileChange { path, change: kind, additions, deletions, checkpoint, .. } => {
                assert_eq!((path.as_str(), *kind, *additions, *deletions), ("a.rs", ChangeKind::Modify, 2, 1));
                assert!(checkpoint.is_some());
            }
            other => panic!("{other:?}"),
        }
        assert_eq!(msg.usage.unwrap().output_tokens, Some(5));
        let conv = repository::get_conversation(&e.db, &e.conv.id).unwrap();
        assert_eq!((conv.status, conv.runtime_session_id.as_deref()), (ConversationStatus::Completed, Some("thr_1")));

        // Revert restores the checkpoint.
        let (_, item) = set_change_state(&e.db, e.rt.checkpoints(), &e.root, &change.id, false).unwrap();
        assert!(matches!(item.body, ItemBody::FileChange { state: ChangeState::Reverted, .. }));
        assert_eq!(std::fs::read_to_string(e.root.join("a.rs")).unwrap(), "one\ntwo\n");
    }

    #[test]
    fn approvals_wait_for_the_user_and_set_the_status() {
        let mut e = env(Mode::Agent, Policy::Ask, |req, _guard, sink| {
            let (tx, rx) = mpsc::channel();
            let r = PermissionRequest {
                kind: PermissionKind::Command,
                title: "Run".into(),
                command: Some("cargo test".into()),
                path: None,
                paths: vec![],
                detail: None,
                can_allow_session: true,
            };
            let _ = req;
            sink(AgentEvent::Approval { key: "c1".into(), request: r, reply: Box::new(move |d| { let _ = tx.send(d); }) });
            let d = rx.recv().unwrap();
            assert_eq!(d, Decision::Deny);
            sink(AgentEvent::Done(TurnOutcome::Completed));
        });
        let start = request(&mut e);
        e.rt.start(start, Arc::clone(&e.sink)).unwrap();
        let item_id = loop {
            match e.events.recv_timeout(Duration::from_secs(5)).unwrap() {
                ChatEvent::Item { item, .. } if item.status == ItemStatus::Pending => break item.id,
                _ => {}
            }
        };
        loop {
            if let ChatEvent::Status { status, .. } = e.events.recv_timeout(Duration::from_secs(5)).unwrap() {
                assert_eq!(status, ConversationStatus::WaitingForApproval);
                break;
            }
        }
        assert!(e.rt.has_pending_approval(&e.conv.id));
        assert_eq!(repository::get_conversation(&e.db, &e.conv.id).unwrap().status, ConversationStatus::WaitingForApproval);
        e.rt.respond(&item_id, Decision::Deny).unwrap();
        assert!(e.rt.respond(&item_id, Decision::Deny).is_err(), "answered once");
        let (_, msg) = until_finished(&e);
        match &msg.items[0].body {
            ItemBody::Permission { decision, auto, .. } => assert_eq!((*decision, *auto), (Some(Decision::Deny), false)),
            other => panic!("{other:?}"),
        }
        assert_eq!(msg.items[0].status, ItemStatus::Declined);
    }

    #[test]
    fn plan_mode_denies_writes_without_asking_and_guards_direct_writes() {
        let mut e = env(Mode::Plan, Policy::AutoAll, |req, guard, sink| {
            let file = req.cwd.join("a.rs");
            assert!(guard.may_read(&file));
            assert!(guard.before_write(&file).is_err());
            let (tx, rx) = mpsc::channel();
            sink(AgentEvent::Approval { key: "w".into(), request: write_req(&file), reply: Box::new(move |d| { let _ = tx.send(d); }) });
            assert_eq!(rx.recv().unwrap(), Decision::Deny);
            sink(AgentEvent::Done(TurnOutcome::Completed));
        });
        let start = request(&mut e);
        e.rt.start(start, Arc::clone(&e.sink)).unwrap();
        let (_, msg) = until_finished(&e);
        assert!(msg.items.iter().all(|i| i.body.kind() != "file_change"));
        assert_eq!(std::fs::read_to_string(e.root.join("a.rs")).unwrap(), "one\ntwo\n");
    }

    #[test]
    fn interrupt_cancels_pending_approvals_and_stops_the_turn() {
        let mut e = env(Mode::Agent, Policy::Ask, |req, _guard, sink| {
            let file = req.cwd.join("a.rs");
            let (tx, rx) = mpsc::channel();
            sink(AgentEvent::Text { text: "Working".into() });
            sink(AgentEvent::Approval { key: "w".into(), request: write_req(&file), reply: Box::new(move |d| { let _ = tx.send(d); }) });
            assert_eq!(rx.recv().unwrap(), Decision::Cancel);
            sink(AgentEvent::Done(TurnOutcome::Cancelled));
        });
        let start = request(&mut e);
        let turn = e.rt.start(start, Arc::clone(&e.sink)).unwrap();
        loop {
            if let ChatEvent::Status { status: ConversationStatus::WaitingForApproval, .. } = e.events.recv_timeout(Duration::from_secs(5)).unwrap() {
                break;
            }
        }
        turn.interrupt();
        let (_, msg) = until_finished(&e);
        assert_eq!(msg.status, MessageStatus::Stopped);
        assert_eq!(msg.content, "Working");
        assert!(!e.rt.has_pending_approval(&e.conv.id));
        assert_eq!(repository::get_conversation(&e.db, &e.conv.id).unwrap().status, ConversationStatus::Cancelled);
    }

    #[test]
    fn a_failed_turn_keeps_partial_text_and_reports_the_error() {
        let mut e = env(Mode::Agent, Policy::Ask, |_req, _guard, sink| {
            sink(AgentEvent::ResumeFailed { message: "thread not found".into() });
            sink(AgentEvent::Text { text: "Half".into() });
            sink(AgentEvent::Done(TurnOutcome::Failed(ChatError::new(ErrorKind::RuntimeExited, "Codex exited (code 1)."))));
        });
        let start = request(&mut e);
        e.rt.start(start, Arc::clone(&e.sink)).unwrap();
        let (_, msg) = until_finished(&e);
        assert_eq!(msg.status, MessageStatus::Error);
        assert_eq!(msg.content, "Half");
        assert_eq!(msg.error.unwrap().kind, ErrorKind::RuntimeExited);
        assert!(matches!(&msg.items[0].body, ItemBody::System { tone: Tone::Warn, .. }));
        assert_eq!(repository::get_conversation(&e.db, &e.conv.id).unwrap().status, ConversationStatus::Failed);
    }
}
