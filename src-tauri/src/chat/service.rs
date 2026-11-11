//! Chat requests: one turn per conversation at a time. A turn goes either to
//! a direct API (streamed here, persisted every ~1.5 s and finally as
//! `complete`, `stopped` or `error`) or to an agent runtime (`agents::turn`).
//! Requests are never retried automatically: a retry can cost money, repeat
//! an action or duplicate an answer, so the UI offers Retry instead.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tokio::sync::oneshot;

use super::agents::turn::{AgentRuntime, StartTurn, Turn};
use super::agents::{EngineAdapter, TurnRequest};
use super::engines::{self, EngineInfo, EngineProbe, ModelInfo, ProbeState};
use super::images::{self, Checked, Images, NewImage};
use super::providers::{self, anthropic, gemini, Outcome, ParseState, Request, StreamEvent, Turn as ApiTurn, Usage};
use super::repository::{self, NewConversation};
use super::secrets::{clean_key, ApiKey, SecretStore};
use super::sse::SseParser;
use super::{
    redact, ChatError, ChatEvent, ChatMessage, Conversation, ConversationStatus, Decision, Engine, ErrorKind, Item, ItemBody, ItemStatus,
    MessageStatus, Mode, Policy, Provider, Role,
};
use crate::backlog::BacklogRef;
use crate::error::{now_ms, AppError, AppResult};
use crate::persistence::Db;

pub type Sink = Arc<dyn Fn(ChatEvent) + Send + Sync>;
/// Notified when engine probes change (startup, Recheck).
pub type EnginesSink = Arc<dyn Fn(Vec<EngineInfo>) + Send + Sync>;

/// Longest message the composer may send.
pub const MAX_MESSAGE_CHARS: usize = 100_000;
/// History sent with an API request, newest first, about 90k tokens at ~4
/// chars per token. Older turns that don't fit aren't sent, and the UI says so.
pub const CONTEXT_BUDGET_CHARS: usize = 360_000;
/// Attachments per message, and characters kept per attached file.
pub const MAX_ATTACHMENTS: usize = 8;
pub const MAX_ATTACHMENT_CHARS: usize = 200_000;
/// Pasted images resent with an API request (newest first); older ones become a note.
pub const MAX_CONTEXT_IMAGES: usize = 8;
/// Earlier turns passed to an agent whose own session couldn't be resumed.
const HANDOFF_CHARS: usize = 40_000;

const HEADERS_TIMEOUT: Duration = Duration::from_secs(90);
/// Reasoning models can think for a while before the first token.
const IDLE_TIMEOUT: Duration = Duration::from_secs(180);
const SAVE_EVERY: Duration = Duration::from_millis(1500);
const TEST_TIMEOUT: Duration = Duration::from_secs(20);

const STATUS_SETTING: &str = "chat_status";
/// Integrations the user turned off (JSON array of engine ids).
const DISABLED_SETTING: &str = "engines_disabled";

pub fn default_model(provider: Provider) -> &'static str {
    engines::default_model(provider.engine())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum KeyState {
    /// Saved but not checked yet.
    #[default]
    Unknown,
    Ok,
    Invalid,
    Error,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StatusRecord {
    state: KeyState,
    message: Option<String>,
    checked_at: Option<i64>,
}

/// What the UI may know about a provider's key: whether there is one and its
/// last 4 characters, never the key.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderStatus {
    pub provider: Provider,
    pub has_key: bool,
    pub key_hint: Option<String>,
    pub state: KeyState,
    pub message: Option<String>,
    pub checked_at: Option<i64>,
}

enum Running {
    /// Claimed, not started yet.
    Starting,
    Api(Option<oneshot::Sender<()>>),
    Agent(Arc<Turn>),
}

struct Active {
    request_id: String,
    running: Running,
}

struct Job {
    request_id: String,
    conversation_id: String,
    message_id: String,
    provider: Provider,
    model: String,
    key: ApiKey,
    turns: Vec<ApiTurn>,
    max_tokens: u32,
}

struct Final {
    content: String,
    status: MessageStatus,
    error: Option<ChatError>,
}

impl Final {
    fn complete(content: String, note: Option<ChatError>) -> Self {
        Self { content, status: MessageStatus::Complete, error: note }
    }
    fn stopped(content: String) -> Self {
        Self { content, status: MessageStatus::Stopped, error: None }
    }
    fn error(content: String, error: ChatError) -> Self {
        Self { content, status: MessageStatus::Error, error: Some(error) }
    }
}

/// Options for a new conversation.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewChat {
    pub project_id: Option<String>,
    pub engine: Engine,
    pub model: String,
    pub mode: Mode,
    #[serde(default = "default_policy")]
    pub policy: Policy,
    pub first_message: String,
}

fn default_policy() -> Policy {
    Policy::Ask
}

/// A new user message: its text, attached project files, checked pasted
/// images and the backlog item it is about.
struct Input<'a> {
    content: &'a str,
    files: &'a [String],
    images: Vec<Checked>,
    backlog: Option<&'a BacklogRef>,
}

/// Project chats use a coding agent in Plan or Agent mode; General chats a
/// direct API in Ask (agents outside a project are refused in
/// `check_engine_mode`). Checked when a chat is created or changed, so chats
/// made before this rule keep working.
fn check_workspace(project_id: Option<&str>, engine: Engine, mode: Mode) -> AppResult<()> {
    let reason = match project_id {
        Some(_) if !engine.is_agent() => "Project chats use a coding agent. Use Ask for direct APIs.",
        Some(_) if mode == Mode::Ask => "Project chats use Plan or Agent mode. Use Ask for quick questions.",
        _ => return Ok(()),
    };
    Err(AppError::Provider(ChatError::new(ErrorKind::ModeUnsupported, reason)))
}

pub struct ChatService {
    db: Arc<Db>,
    secrets: Box<dyn SecretStore>,
    client: reqwest::Client,
    base_urls: HashMap<Provider, String>,
    /// One turn per conversation id.
    active: Mutex<HashMap<String, Active>>,
    status: Mutex<HashMap<Provider, StatusRecord>>,
    agents: Arc<AgentRuntime>,
    /// Conversations whose mode changed since their live runtime session started.
    reconfigure: Mutex<HashSet<String>>,
    probes: Mutex<HashMap<Engine, EngineProbe>>,
    on_engines: Mutex<Option<EnginesSink>>,
    /// Turned off in Settings: never probed or started. Locked after `active`.
    disabled: Mutex<HashSet<Engine>>,
    /// Pasted images, in the app data folder.
    images: Images,
}

impl ChatService {
    pub fn new(
        db: Arc<Db>,
        secrets: Box<dyn SecretStore>,
        checkpoints_dir: PathBuf,
        images_dir: PathBuf,
        adapters: Vec<Arc<dyn EngineAdapter>>,
    ) -> Self {
        let _ = repository::recover_interrupted(&db);
        let status = db
            .get_setting(STATUS_SETTING)
            .ok()
            .flatten()
            .and_then(|raw| serde_json::from_str::<HashMap<Provider, StatusRecord>>(&raw).ok())
            .unwrap_or_default();
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(15))
            .user_agent(concat!("AgentHub/", env!("CARGO_PKG_VERSION")))
            .build()
            .unwrap_or_default();
        let probes = Engine::ALL
            .into_iter()
            .filter(|e| e.is_agent())
            .filter_map(|e| engines::load_probe(&db, e).map(|p| (e, p)))
            .collect();
        let disabled = db
            .get_setting(DISABLED_SETTING)
            .ok()
            .flatten()
            .and_then(|raw| serde_json::from_str::<Vec<String>>(&raw).ok())
            .unwrap_or_default()
            .iter()
            .filter_map(|s| Engine::parse(s))
            .collect();
        let checkpoints = Arc::new(super::checkpoints::Checkpoints::new(checkpoints_dir));
        let agents = AgentRuntime::new(Arc::clone(&db), checkpoints, adapters);
        Self {
            db,
            secrets,
            client,
            base_urls: HashMap::new(),
            active: Mutex::new(HashMap::new()),
            status: Mutex::new(status),
            agents,
            reconfigure: Mutex::new(HashSet::new()),
            probes: Mutex::new(probes),
            on_engines: Mutex::new(None),
            disabled: Mutex::new(disabled),
            images: Images::new(images_dir),
        }
    }

    #[cfg(test)]
    pub fn with_base_url(mut self, provider: Provider, url: &str) -> Self {
        self.base_urls.insert(provider, url.to_string());
        self
    }

    pub fn db(&self) -> &Arc<Db> {
        &self.db
    }

    pub fn agents(&self) -> &Arc<AgentRuntime> {
        &self.agents
    }

    fn base(&self, provider: Provider) -> &str {
        self.base_urls
            .get(&provider)
            .map(String::as_str)
            .unwrap_or_else(|| providers::default_base_url(provider))
    }

    // ---------- keys & connection status ----------

    pub fn providers(&self) -> Vec<ProviderStatus> {
        Provider::ALL.iter().map(|&p| self.provider_status(p)).collect()
    }

    pub fn provider_status(&self, provider: Provider) -> ProviderStatus {
        let key = self.secrets.get(provider);
        let record = self.status.lock().get(&provider).cloned().unwrap_or_default();
        match key {
            Ok(Some(key)) => ProviderStatus {
                provider,
                has_key: true,
                key_hint: Some(key.hint()),
                state: record.state,
                message: record.message,
                checked_at: record.checked_at,
            },
            Ok(None) => ProviderStatus { provider, has_key: false, key_hint: None, state: KeyState::Unknown, message: None, checked_at: None },
            Err(e) => ProviderStatus { provider, has_key: false, key_hint: None, state: KeyState::Error, message: Some(e), checked_at: None },
        }
    }

    fn record(&self, provider: Provider, state: KeyState, message: Option<String>) {
        let mut map = self.status.lock();
        map.insert(provider, StatusRecord { state, message, checked_at: Some(now_ms()) });
        if let Ok(json) = serde_json::to_string(&*map) {
            let _ = self.db.set_setting(STATUS_SETTING, &json);
        }
    }

    fn forget(&self, provider: Provider) {
        let mut map = self.status.lock();
        map.remove(&provider);
        if let Ok(json) = serde_json::to_string(&*map) {
            let _ = self.db.set_setting(STATUS_SETTING, &json);
        }
    }

    pub fn save_key(&self, provider: Provider, raw: &str) -> AppResult<()> {
        let key = clean_key(raw).map_err(AppError::Invalid)?;
        self.secrets.set(provider, &key).map_err(AppError::Invalid)?;
        self.forget(provider);
        Ok(())
    }

    pub fn remove_key(&self, provider: Provider) -> AppResult<ProviderStatus> {
        self.secrets.delete(provider).map_err(AppError::Invalid)?;
        self.forget(provider);
        Ok(self.provider_status(provider))
    }

    /// Checks the saved key with a real authenticated request (retrieving the
    /// model, which costs nothing), and whether that model is available.
    pub async fn test(&self, provider: Provider, model: Option<String>) -> AppResult<ProviderStatus> {
        let Some(key) = self.secrets.get(provider).map_err(AppError::Invalid)? else {
            return Err(AppError::Provider(missing_key(provider)));
        };
        let model = match model.filter(|m| !m.trim().is_empty()) {
            Some(m) => repository::clean_model(&m)?,
            None => default_model(provider).to_string(),
        };
        let req = providers::build_test(provider, &self.client, self.base(provider), key.expose(), &model);
        let (state, message) = match tokio::time::timeout(TEST_TIMEOUT, req.send()).await {
            Err(_) => (KeyState::Error, format!("{} didn't answer within {} s.", provider.label(), TEST_TIMEOUT.as_secs())),
            Ok(Err(e)) => (KeyState::Error, network_error(provider, &e).message),
            Ok(Ok(resp)) => {
                let status = resp.status().as_u16();
                if resp.status().is_success() {
                    (KeyState::Ok, "Connected".to_string())
                } else {
                    let body = resp.text().await.unwrap_or_default();
                    let err = providers::map_http_error(provider, status, &body, None, &model);
                    let message = redact(&err.message, Some(key.expose()));
                    match err.kind {
                        ErrorKind::InvalidKey => (KeyState::Invalid, message),
                        ErrorKind::ModelUnavailable => (KeyState::Ok, format!("Connected, but {}", lower_first(&message))),
                        ErrorKind::PermissionDenied => (KeyState::Invalid, message),
                        _ => (KeyState::Error, message),
                    }
                }
            }
        };
        self.record(provider, state, Some(message));
        self.notify_engines();
        Ok(self.provider_status(provider))
    }

    /// Models the provider offers this key (Gemini, OpenAI, Anthropic list endpoints).
    pub async fn api_models(&self, provider: Provider) -> AppResult<Vec<ModelInfo>> {
        let Some(key) = self.secrets.get(provider).map_err(AppError::Invalid)? else {
            return Err(AppError::Provider(missing_key(provider)));
        };
        let base = self.base(provider);
        let req = match provider {
            Provider::Gemini => gemini::build_list(&self.client, base, key.expose()),
            Provider::OpenAI => self.client.get(format!("{base}/v1/models")).bearer_auth(key.expose()),
            Provider::Anthropic => self
                .client
                .get(format!("{base}/v1/models?limit=100"))
                .header("x-api-key", key.expose())
                .header("anthropic-version", anthropic::API_VERSION),
        };
        let resp = tokio::time::timeout(TEST_TIMEOUT, req.send())
            .await
            .map_err(|_| AppError::Invalid(format!("{} didn't answer in time", provider.label())))?
            .map_err(|e| AppError::Provider(network_error(provider, &e)))?;
        let status = resp.status().as_u16();
        let body = resp.text().await.unwrap_or_default();
        if !(200..300).contains(&status) {
            let mut err = providers::map_http_error(provider, status, &body, None, "");
            err.message = redact(&err.message, Some(key.expose()));
            return Err(AppError::Provider(err));
        }
        let ids: Vec<String> = match provider {
            Provider::Gemini => gemini::parse_models(&body),
            _ => serde_json::from_str::<serde_json::Value>(&body)
                .ok()
                .and_then(|v| v["data"].as_array().cloned())
                .unwrap_or_default()
                .iter()
                .filter_map(|m| m["id"].as_str().map(str::to_string))
                .filter(|id| provider != Provider::OpenAI || id.starts_with("gpt-") || id.starts_with('o'))
                .collect(),
        };
        let default = default_model(provider);
        Ok(ids.into_iter().map(|id| ModelInfo { label: id.clone(), is_default: id == default, id }).collect())
    }

    // ---------- engines ----------

    pub fn set_engines_sink(&self, sink: EnginesSink) {
        *self.on_engines.lock() = Some(sink);
    }

    fn api_probe(&self, provider: Provider) -> EngineProbe {
        let s = self.provider_status(provider);
        let (state, message) = match (s.has_key, s.state) {
            (false, KeyState::Error) => (ProbeState::Error, s.message.clone()),
            (false, _) => (ProbeState::KeyMissing, Some("No API key".into())),
            (true, KeyState::Invalid) => (ProbeState::KeyInvalid, s.message.clone()),
            (true, KeyState::Error) => (ProbeState::Error, s.message.clone()),
            (true, _) => (ProbeState::Ready, s.message.clone()),
        };
        let mut p = EngineProbe::new(provider.engine(), state, message);
        p.account = s.key_hint.map(|h| format!("Key …{h}"));
        p.probed_at = s.checked_at;
        p
    }

    pub fn engines(&self) -> Vec<EngineInfo> {
        let probes = self.probes.lock().clone();
        Engine::ALL
            .into_iter()
            .map(|engine| {
                let probe = match engine.api_provider() {
                    Some(p) => self.api_probe(p),
                    None => probes.get(&engine).cloned().unwrap_or_else(|| EngineProbe::new(engine, ProbeState::Unknown, None)),
                };
                EngineInfo {
                    engine,
                    label: engine.label(),
                    kind: if engine.is_agent() { "agent" } else { "api" },
                    enabled: self.is_enabled(engine),
                    capabilities: engines::capabilities(engine),
                    probe,
                }
            })
            .collect()
    }

    fn notify_engines(&self) {
        let sink = self.on_engines.lock().clone();
        if let Some(s) = sink {
            s(self.engines());
        }
    }

    pub fn executable_override(&self, engine: Engine) -> Option<PathBuf> {
        self.db
            .get_setting(&format!("engine_path:{}", engine.as_str()))
            .ok()
            .flatten()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .map(PathBuf::from)
    }

    /// Probes every agent runtime that's turned on, in the background; results
    /// arrive on the engines sink and are cached.
    pub fn probe_engines(self: &Arc<Self>, only: Option<Engine>) {
        for engine in Engine::ALL
            .into_iter()
            .filter(|e| e.is_agent() && only.map_or(true, |o| o == *e) && self.is_enabled(*e))
        {
            let Some(adapter) = self.agents.adapter(engine) else { continue };
            let this = Arc::clone(self);
            std::thread::spawn(move || {
                let exe = this.executable_override(engine);
                // Only Gemini CLI probes with a key (it can't sign in otherwise).
                let key = match engine {
                    Engine::GeminiCli => this.secrets.get(Provider::Gemini).ok().flatten(),
                    _ => None,
                };
                let mut probe = adapter.probe(exe.as_deref(), key.as_ref().map(|k| k.expose()));
                if probe.probed_at.is_none() {
                    probe.probed_at = Some(now_ms());
                }
                let _ = engines::save_probe(&this.db, &probe);
                this.probes.lock().insert(engine, probe);
                this.notify_engines();
            });
        }
        self.notify_engines();
    }

    /// Runs a runtime's own sign-in because the user asked for it, then
    /// re-probes it. Blocking until the sign-in finished, failed or was cancelled.
    pub fn sign_in(self: &Arc<Self>, engine: Engine) -> AppResult<()> {
        self.check_enabled(engine)?;
        let adapter = self.agents.adapter(engine).ok_or_else(|| AppError::Invalid(format!("{} has no sign-in", engine.label())))?;
        let result = adapter.sign_in(self.executable_override(engine).as_deref());
        self.probe_engines(Some(engine));
        result.map_err(AppError::Provider)
    }

    pub fn cancel_sign_in(&self, engine: Engine) {
        if let Some(adapter) = self.agents.adapter(engine) {
            adapter.cancel_sign_in();
        }
    }

    pub fn is_enabled(&self, engine: Engine) -> bool {
        !self.disabled.lock().contains(&engine)
    }

    fn check_enabled(&self, engine: Engine) -> AppResult<()> {
        if self.is_enabled(engine) {
            return Ok(());
        }
        Err(AppError::Invalid(format!("{} is turned off. Turn it on in Settings › AI integrations.", engine.label())))
    }

    /// Turns an integration on or off. While off it isn't probed or started,
    /// its chats can't run and its idle runtime sessions are closed; its chats
    /// and saved key stay. Refused while one of its turns is running.
    pub fn set_enabled(self: &Arc<Self>, engine: Engine, enabled: bool) -> AppResult<()> {
        let chats: Vec<String> = repository::list_conversations(&self.db)?
            .into_iter()
            .filter(|c| c.engine == engine)
            .map(|c| c.id)
            .collect();
        {
            // Same lock order as `start`, so no turn of this engine starts in between.
            let active = self.active.lock();
            if !enabled && chats.iter().any(|id| active.contains_key(id)) {
                return Err(AppError::Invalid(format!("Stop the running {} chats before turning it off.", engine.label())));
            }
            let mut disabled = self.disabled.lock();
            let mut next = disabled.clone();
            if enabled {
                next.remove(&engine);
            } else {
                next.insert(engine);
            }
            let mut ids: Vec<&str> = next.iter().map(|e| e.as_str()).collect();
            ids.sort_unstable();
            self.db.set_setting(DISABLED_SETTING, &serde_json::to_string(&ids).unwrap_or_default())?;
            *disabled = next;
        }
        if enabled {
            self.probe_engines(Some(engine));
        } else {
            for id in &chats {
                self.agents.close_session(engine, id);
            }
            self.notify_engines();
        }
        Ok(())
    }

    // ---------- conversations ----------

    pub fn create_conversation(&self, n: NewChat) -> AppResult<Conversation> {
        self.check_engine_mode(n.project_id.as_deref(), n.engine, n.mode)?;
        check_workspace(n.project_id.as_deref(), n.engine, n.mode)?;
        if let Some(p) = n.project_id.as_deref() {
            crate::projects::get(&self.db, p)?;
        }
        repository::create_conversation(
            &self.db,
            NewConversation {
                project_id: n.project_id.as_deref(),
                engine: n.engine,
                model: &n.model,
                mode: n.mode,
                policy: n.policy,
                title: &super::title_from(&n.first_message),
            },
        )
    }

    fn check_engine_mode(&self, project_id: Option<&str>, engine: Engine, mode: Mode) -> AppResult<()> {
        self.check_enabled(engine)?;
        if engine.is_agent() && project_id.is_none() {
            return Err(AppError::Provider(ChatError::new(
                ErrorKind::ModeUnsupported,
                "Coding agents work inside a project folder. Open a project, or use a direct API here in Ask.",
            )));
        }
        engines::supports(engine, mode).map_err(|m| AppError::Provider(ChatError::new(ErrorKind::ModeUnsupported, m)))
    }

    /// Engine/model for a conversation. An agent conversation is bound to its
    /// runtime once it has messages; picking another runtime is a new chat.
    pub fn set_engine(&self, id: &str, engine: Engine, model: &str) -> AppResult<Conversation> {
        let conv = repository::get_conversation(&self.db, id)?;
        if conv.engine != engine {
            let has_messages = !repository::messages(&self.db, id)?.is_empty();
            if has_messages && (conv.engine.is_agent() || engine.is_agent()) {
                return Err(AppError::Invalid(format!(
                    "This conversation is bound to {}. Start a new chat to use {}.",
                    conv.engine.label(),
                    engine.label()
                )));
            }
            self.check_engine_mode(conv.project_id.as_deref(), engine, conv.mode)?;
            check_workspace(conv.project_id.as_deref(), engine, conv.mode)?;
            self.agents.close_session(conv.engine, id);
        }
        repository::set_engine(&self.db, id, engine, model)
    }

    /// Changes the mode. The live runtime session is recreated with the new
    /// permissions on the next turn (resumed when the runtime supports it).
    pub fn set_mode(&self, id: &str, mode: Mode) -> AppResult<Conversation> {
        let conv = repository::get_conversation(&self.db, id)?;
        if self.is_busy(id) {
            return Err(AppError::Invalid("Wait for the current turn to finish (or stop it) before changing the mode.".into()));
        }
        self.check_engine_mode(conv.project_id.as_deref(), conv.engine, mode)?;
        if conv.mode != mode {
            check_workspace(conv.project_id.as_deref(), conv.engine, mode)?;
        }
        if conv.mode != mode && conv.engine.is_agent() {
            self.reconfigure.lock().insert(id.to_string());
        }
        repository::set_mode(&self.db, id, mode)
    }

    pub fn set_policy(&self, id: &str, policy: Policy) -> AppResult<Conversation> {
        repository::set_policy(&self.db, id, policy)
    }

    // ---------- requests ----------

    pub fn is_busy(&self, conversation_id: &str) -> bool {
        self.active.lock().contains_key(conversation_id)
    }

    /// Stores the message and starts a turn. Returns the request id;
    /// everything else arrives through `sink`, starting with `Started`.
    pub fn send(
        self: &Arc<Self>,
        conversation_id: &str,
        content: &str,
        attachments: &[String],
        new_images: &[NewImage],
        backlog: Option<&BacklogRef>,
        sink: Sink,
    ) -> AppResult<String> {
        if content.trim().is_empty() {
            return Err(AppError::Invalid("Type a message first".into()));
        }
        if content.chars().count() > MAX_MESSAGE_CHARS {
            return Err(AppError::Invalid(format!(
                "Messages can be up to {MAX_MESSAGE_CHARS} characters. Shorten it or split it up."
            )));
        }
        if attachments.len() > MAX_ATTACHMENTS {
            return Err(AppError::Invalid(format!("Attach up to {MAX_ATTACHMENTS} files per message.")));
        }
        let images = images::check(new_images)?;
        self.start(conversation_id, Some(Input { content, files: attachments, images, backlog }), sink)
    }

    /// Replaces the last answer (or a failed one) with a new one.
    pub fn regenerate(self: &Arc<Self>, conversation_id: &str, sink: Sink) -> AppResult<String> {
        self.start(conversation_id, None, sink)
    }

    /// A stored image as a `data:` URL, for the transcript.
    pub fn image_data_url(&self, item_id: &str) -> AppResult<String> {
        let (conversation_id, item) = repository::get_item(&self.db, item_id)?;
        let ItemBody::Image { id, mime, .. } = item.body else {
            return Err(AppError::Invalid("Not an image".into()));
        };
        Ok(self.images.input(&conversation_id, &id, &mime)?.data_url())
    }

    /// Images of a stored user message, for the runtime.
    fn message_images(&self, conversation_id: &str, m: &ChatMessage) -> AppResult<Vec<images::ImageInput>> {
        m.items
            .iter()
            .filter_map(|i| match &i.body {
                ItemBody::Image { id, mime, .. } => Some(self.images.input(conversation_id, id, mime)),
                _ => None,
            })
            .collect()
    }

    fn start(self: &Arc<Self>, conversation_id: &str, input: Option<Input<'_>>, sink: Sink) -> AppResult<String> {
        let conv = repository::get_conversation(&self.db, conversation_id)?;
        self.check_engine_mode(conv.project_id.as_deref(), conv.engine, conv.mode)?;
        let model = repository::clean_model(&conv.model)?;
        let api_key = match conv.engine.api_provider() {
            Some(p) => Some(self.secrets.get(p).map_err(AppError::Invalid)?.ok_or_else(|| AppError::Provider(missing_key(p)))?),
            None if conv.engine == Engine::ClaudeCode => Some(
                self.secrets
                    .get(Provider::Anthropic)
                    .map_err(AppError::Invalid)?
                    .ok_or_else(|| AppError::Provider(claude_needs_key()))?,
            ),
            None if conv.engine == Engine::GeminiCli => Some(
                self.secrets
                    .get(Provider::Gemini)
                    .map_err(AppError::Invalid)?
                    .ok_or_else(|| AppError::Provider(gemini_cli_needs_key()))?,
            ),
            None => None,
        };
        let root = match conv.project_id.as_deref() {
            Some(p) => Some(crate::projects::root(&self.db, p)?),
            None => None,
        };
        // Read attachments before anything is stored, so a bad path stores nothing.
        let attached = match (&input, root.as_deref()) {
            (Some(i), Some(root)) => read_attachments(root, i.files)?,
            (Some(i), None) if !i.files.is_empty() => {
                return Err(AppError::Invalid("Attach files from a project; Ask chats have no folder.".into()))
            }
            _ => vec![],
        };
        // The backlog pack is built now, from the item as it is when sent.
        let backlog = match input.as_ref().and_then(|i| i.backlog) {
            Some(r) => {
                let (item, text) = crate::backlog::context::for_item(&self.db, &r.item_id)?;
                if conv.project_id.as_deref() != Some(item.project_id.as_str()) {
                    return Err(AppError::Invalid("That backlog item belongs to another project.".into()));
                }
                Some((r.purpose, item, text))
            }
            None => None,
        };
        let pasted: &[Checked] = input.as_ref().map_or(&[], |i| &i.images);
        if !pasted.is_empty() {
            if !engines::capabilities(conv.engine).images {
                return Err(AppError::Invalid(format!("{} takes text only. Remove the images, or pick another engine.", conv.engine.label())));
            }
            if let Some(p) = conv.engine.api_provider() {
                if let Some(img) = pasted.iter().find(|i| !providers::takes_image(p, i.mime)) {
                    return Err(AppError::Invalid(format!(
                        "{} doesn't take {} images. Paste a PNG, JPEG or WebP instead.",
                        conv.engine.label(),
                        img.mime.trim_start_matches("image/").to_uppercase()
                    )));
                }
            }
        }

        // Claim the conversation first: a double click can't start two turns.
        let request_id = uuid::Uuid::new_v4().to_string();
        {
            let mut active = self.active.lock();
            if active.contains_key(conversation_id) {
                return Err(AppError::Invalid("This chat is still working. Stop it or wait for it to finish.".into()));
            }
            // Again under `active`: the integration may have been turned off meanwhile.
            self.check_enabled(conv.engine)?;
            active.insert(conversation_id.to_string(), Active { request_id: request_id.clone(), running: Running::Starting });
        }
        let release = |e| {
            self.active.lock().remove(conversation_id);
            e
        };

        let reply =
            repository::begin_reply(&self.db, conversation_id, input.as_ref().map(|i| i.content), conv.engine, &model).map_err(release)?;
        if let Some(user) = &reply.user_message {
            let context = backlog.iter().map(|(_, item, text)| {
                Ok(ItemBody::BacklogContext { item_id: item.id.clone(), label: format!("{} · {}", item.key(), item.title), text: text.clone() })
            });
            let files = attached
                .iter()
                .map(|(path, text, truncated)| Ok(ItemBody::Attachment { path: path.clone(), text: text.clone(), truncated: *truncated }));
            let pictures = pasted.iter().map(|img| {
                let id = self.images.store(conversation_id, img)?;
                Ok(ItemBody::Image { id, name: img.name.clone(), mime: img.mime.to_string(), size: img.bytes.len() as u64 })
            });
            for (i, body) in context.chain(files).chain(pictures).enumerate() {
                let item = Item {
                    id: uuid::Uuid::new_v4().to_string(),
                    message_id: user.id.clone(),
                    idx: i as i64,
                    status: ItemStatus::Completed,
                    body: body.map_err(release)?,
                    created_at: now_ms(),
                    updated_at: now_ms(),
                };
                repository::upsert_item(&self.db, conversation_id, &item).map_err(release)?;
            }
            if let Some((purpose, item, _)) = &backlog {
                crate::backlog::repository::add_link(&self.db, &item.id, conversation_id, *purpose).map_err(release)?;
            }
        }
        let user_message = match &reply.user_message {
            Some(m) => Some(repository::get_message(&self.db, &m.id).map_err(release)?),
            None => None,
        };
        let history = repository::messages(&self.db, conversation_id).map_err(release)?;
        let history: Vec<&ChatMessage> = history.iter().filter(|m| m.id != reply.assistant_message.id).collect();
        // Only direct APIs get this history; agents keep their own (images go in `TurnRequest`).
        let provider = conv.engine.api_provider();
        let (turns, omitted) = context_turns(history.iter().copied(), CONTEXT_BUDGET_CHARS, |id, mime| {
            provider.filter(|p| providers::takes_image(*p, mime))?;
            self.images.input(conversation_id, id, mime).ok()
        });

        sink(ChatEvent::Started {
            conversation_id: conversation_id.to_string(),
            request_id: request_id.clone(),
            user_message,
            assistant_message: reply.assistant_message.clone(),
            removed_ids: reply.removed_ids,
            omitted: if conv.engine.is_agent() { 0 } else { omitted },
        });

        match conv.engine.api_provider() {
            Some(provider) => {
                let (cancel_tx, cancel_rx) = oneshot::channel();
                if let Some(a) = self.active.lock().get_mut(conversation_id) {
                    a.running = Running::Api(Some(cancel_tx));
                }
                let job = Job {
                    request_id: request_id.clone(),
                    conversation_id: conversation_id.to_string(),
                    message_id: reply.assistant_message.id,
                    provider,
                    model,
                    key: api_key.expect("checked above"),
                    turns,
                    max_tokens: self.max_tokens(),
                };
                let this = Arc::clone(self);
                tokio::spawn(async move { this.run(job, cancel_rx, sink).await });
            }
            None => {
                let root = root.expect("agents have a project");
                let last = history.last().copied();
                let (prompt, images) = match last {
                    // Images come from the stored message, so Regenerate sends them again.
                    Some(m) if m.role == Role::User => (user_turn_text(m), self.message_images(conversation_id, m).map_err(release)?),
                    _ => return Err(release(AppError::Invalid("There is no question to answer yet".into()))),
                };
                let reconfigure = self.reconfigure.lock().remove(conversation_id);
                let handoff = conv.runtime_session_id.as_ref().map(|_| handoff_text(&history[..history.len().saturating_sub(1)]));
                let this = Arc::clone(self);
                let conv_id = conversation_id.to_string();
                let message_id = reply.assistant_message.id.clone();
                let start = StartTurn {
                    request: TurnRequest {
                        conversation_id: conv_id.clone(),
                        turn_id: request_id.clone(),
                        engine: conv.engine,
                        model,
                        mode: conv.mode,
                        policy: conv.policy,
                        cwd: root,
                        prompt,
                        images,
                        runtime_session_id: conv.runtime_session_id.clone(),
                        handoff,
                        reconfigure,
                        api_key: api_key.map(|k| k.expose().to_string()),
                        executable: self.executable_override(conv.engine),
                    },
                    message_id: message_id.clone(),
                    on_done: Box::new(move || {
                        this.active.lock().remove(&conv_id);
                    }),
                };
                match self.agents.start(start, Arc::clone(&sink)) {
                    Ok(turn) => {
                        let mut active = self.active.lock();
                        // `on_done` may already have released a turn that failed at once.
                        if let Some(a) = active.get_mut(conversation_id).filter(|a| a.request_id == request_id) {
                            a.running = Running::Agent(turn);
                        }
                    }
                    Err(err) => {
                        self.active.lock().remove(conversation_id);
                        let _ = repository::set_status(&self.db, conversation_id, ConversationStatus::Failed);
                        let stored = repository::finish(&self.db, &message_id, "", MessageStatus::Error, Some(&err), None);
                        if let (Ok(Some(message)), Ok(conversation)) = (stored, repository::get_conversation(&self.db, conversation_id)) {
                            sink(ChatEvent::Finished { conversation_id: conversation_id.to_string(), request_id: request_id.clone(), message, conversation });
                        }
                    }
                }
            }
        }
        Ok(request_id)
    }

    /// Anthropic's `max_tokens`, from the `chat` setting.
    fn max_tokens(&self) -> u32 {
        self.db
            .get_setting("chat")
            .ok()
            .flatten()
            .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
            .and_then(|v| v["anthropic"]["maxTokens"].as_u64())
            .map(|n| n.clamp(anthropic::MIN_MAX_TOKENS as u64, anthropic::MAX_MAX_TOKENS as u64) as u32)
            .unwrap_or(anthropic::DEFAULT_MAX_TOKENS)
    }

    /// Stops a turn; its partial answer and changes so far are kept.
    pub fn stop(&self, request_id: &str) -> bool {
        let mut active = self.active.lock();
        let Some(a) = active.values_mut().find(|a| a.request_id == request_id) else { return false };
        match &mut a.running {
            Running::Api(tx) => tx.take().is_some_and(|tx| tx.send(()).is_ok()),
            Running::Agent(turn) => {
                let turn = Arc::clone(turn);
                drop(active);
                turn.interrupt();
                true
            }
            Running::Starting => false,
        }
    }

    pub fn respond_approval(&self, item_id: &str, decision: Decision) -> AppResult<()> {
        self.agents.respond(item_id, decision)
    }

    pub fn delete_conversation(&self, conversation_id: &str) -> AppResult<()> {
        if let Ok(conv) = repository::get_conversation(&self.db, conversation_id) {
            let req = self.active.lock().get(conversation_id).map(|a| a.request_id.clone());
            if let Some(r) = req {
                self.stop(&r);
            }
            self.agents.close_session(conv.engine, conversation_id);
        }
        repository::delete(&self.db, conversation_id)?;
        self.agents.checkpoints().remove_conversation(conversation_id);
        self.images.remove_conversation(conversation_id);
        Ok(())
    }

    pub fn shutdown(&self) {
        let reqs: Vec<String> = self.active.lock().values().map(|a| a.request_id.clone()).collect();
        for r in reqs {
            self.stop(&r);
        }
        self.agents.shutdown();
    }

    async fn run(self: Arc<Self>, job: Job, mut cancel: oneshot::Receiver<()>, sink: Sink) {
        // Releases the conversation even if streaming panics.
        struct Release<'a>(&'a ChatService, &'a str);
        impl Drop for Release<'_> {
            fn drop(&mut self) {
                self.0.active.lock().remove(self.1);
            }
        }
        let _release = Release(&self, &job.conversation_id);

        let mut usage = Usage::default();
        let mut fin = self.stream(&job, &mut cancel, &sink, &mut usage).await;
        if let Some(err) = fin.error.as_mut() {
            err.message = redact(&err.message, Some(job.key.expose()));
        }
        match fin.error.as_ref().map(|e| e.kind) {
            Some(ErrorKind::InvalidKey) => {
                let message = fin.error.as_ref().map(|e| e.message.clone());
                self.record(job.provider, KeyState::Invalid, message);
            }
            None | Some(ErrorKind::Truncated) => {
                let ok = self.status.lock().get(&job.provider).is_some_and(|r| r.state == KeyState::Ok);
                if !ok {
                    self.record(job.provider, KeyState::Ok, Some("Connected".into()));
                }
            }
            _ => {}
        }
        let conv_status = match fin.status {
            MessageStatus::Complete => ConversationStatus::Completed,
            MessageStatus::Stopped => ConversationStatus::Cancelled,
            _ => ConversationStatus::Failed,
        };
        let _ = repository::set_status(&self.db, &job.conversation_id, conv_status);
        let stored = repository::finish(&self.db, &job.message_id, &fin.content, fin.status, fin.error.as_ref(), Some(&usage));
        if let (Ok(Some(message)), Ok(conversation)) = (stored, repository::get_conversation(&self.db, &job.conversation_id)) {
            sink(ChatEvent::Finished {
                conversation_id: job.conversation_id.clone(),
                request_id: job.request_id.clone(),
                message,
                conversation,
            });
        }
    }

    async fn stream(&self, job: &Job, cancel: &mut oneshot::Receiver<()>, sink: &Sink, usage: &mut Usage) -> Final {
        let req = providers::build(
            job.provider,
            &self.client,
            self.base(job.provider),
            job.key.expose(),
            &Request { model: &job.model, turns: &job.turns, max_tokens: job.max_tokens },
        );
        let resp = tokio::select! {
            _ = &mut *cancel => return Final::stopped(String::new()),
            r = tokio::time::timeout(HEADERS_TIMEOUT, req.send()) => r,
        };
        let resp = match resp {
            Err(_) => return Final::error(String::new(), timeout_error(job.provider, HEADERS_TIMEOUT)),
            Ok(Err(e)) => return Final::error(String::new(), network_error(job.provider, &e)),
            Ok(Ok(r)) => r,
        };
        if !resp.status().is_success() {
            let status = resp.status().as_u16();
            let retry_after = resp
                .headers()
                .get("retry-after")
                .and_then(|v| v.to_str().ok())
                .and_then(|s| s.trim().parse::<u64>().ok());
            let body = tokio::select! {
                _ = &mut *cancel => return Final::stopped(String::new()),
                b = tokio::time::timeout(Duration::from_secs(15), resp.text()) => b.ok().and_then(Result::ok).unwrap_or_default(),
            };
            let err = providers::map_http_error(job.provider, status, &body, retry_after, &job.model);
            return Final::error(String::new(), err);
        }

        let mut body = resp.bytes_stream();
        let mut parser = SseParser::new();
        let mut state = ParseState::default();
        let mut content = String::new();
        let mut last_save = Instant::now();
        loop {
            let next = tokio::select! {
                _ = &mut *cancel => return Final::stopped(content),
                n = tokio::time::timeout(IDLE_TIMEOUT, body.next()) => n,
            };
            let events = match next {
                Err(_) => return Final::error(content, timeout_error(job.provider, IDLE_TIMEOUT)),
                Ok(Some(Err(_))) => {
                    return Final::error(
                        content,
                        ChatError::new(ErrorKind::Interrupted, format!("The connection to {} dropped mid-answer.", job.provider.label())),
                    )
                }
                Ok(Some(Ok(chunk))) => match parser.feed(&chunk) {
                    Ok(events) => events,
                    Err(m) => return Final::error(content, ChatError::new(ErrorKind::Malformed, m)),
                },
                Ok(None) => {
                    let tail: Vec<_> = parser.finish().into_iter().collect();
                    for ev in &tail {
                        for parsed in providers::parse(job.provider, ev, &mut state) {
                            if let Some(fin) = self.apply(job, parsed, &mut content, usage, sink) {
                                return fin;
                            }
                        }
                    }
                    return Final::error(
                        content,
                        ChatError::new(
                            ErrorKind::Interrupted,
                            format!("{} closed the connection before the answer finished.", job.provider.label()),
                        ),
                    );
                }
            };
            for ev in &events {
                for parsed in providers::parse(job.provider, ev, &mut state) {
                    if let Some(fin) = self.apply(job, parsed, &mut content, usage, sink) {
                        return fin;
                    }
                }
            }
            if last_save.elapsed() >= SAVE_EVERY {
                let _ = repository::save_partial(&self.db, &job.message_id, &content);
                last_save = Instant::now();
            }
        }
    }

    /// Applies one normalized event; returns the final state when it ends the reply.
    fn apply(&self, job: &Job, ev: StreamEvent, content: &mut String, usage: &mut Usage, sink: &Sink) -> Option<Final> {
        match ev {
            StreamEvent::Delta(text) => {
                content.push_str(&text);
                sink(ChatEvent::Delta {
                    conversation_id: job.conversation_id.clone(),
                    request_id: job.request_id.clone(),
                    message_id: job.message_id.clone(),
                    text,
                    item_id: None,
                });
                None
            }
            StreamEvent::Usage(u) => {
                usage.merge(u);
                sink(ChatEvent::Usage {
                    conversation_id: job.conversation_id.clone(),
                    request_id: job.request_id.clone(),
                    message_id: job.message_id.clone(),
                    usage: *usage,
                });
                None
            }
            StreamEvent::Done(Outcome::Complete) => Some(Final::complete(std::mem::take(content), None)),
            StreamEvent::Done(Outcome::Truncated(m)) => {
                Some(Final::complete(std::mem::take(content), Some(ChatError::new(ErrorKind::Truncated, m))))
            }
            StreamEvent::Done(Outcome::Refused(m)) => Some(Final::error(std::mem::take(content), ChatError::new(ErrorKind::Refused, m))),
            StreamEvent::Error(e) => Some(Final::error(std::mem::take(content), e)),
        }
    }
}

/// Reads attached files (project-relative) through the root-scoped file service.
pub fn read_attachments(root: &Path, files: &[String]) -> AppResult<Vec<(String, String, bool)>> {
    let mut out = Vec::new();
    for rel in files {
        let file = crate::filesystem::read_file(root, rel, None)?;
        let mut text = file.content;
        let truncated = text.chars().count() > MAX_ATTACHMENT_CHARS;
        if truncated {
            text = text.chars().take(MAX_ATTACHMENT_CHARS).collect();
        }
        out.push((rel.replace('\\', "/"), text, truncated));
    }
    Ok(out)
}

/// A user message as the model sees it: the backlog context, attached files, then the text.
pub fn user_turn_text(m: &ChatMessage) -> String {
    let mut out = String::new();
    for item in &m.items {
        if let ItemBody::BacklogContext { text, .. } = &item.body {
            out.push_str(text);
            out.push_str("

");
        }
    }
    for item in &m.items {
        if let ItemBody::Attachment { path, text, truncated } = &item.body {
            out.push_str(&format!("<attached_file path=\"{path}\"{}>\n", if *truncated { " truncated=\"true\"" } else { "" }));
            out.push_str(text);
            if !text.ends_with('\n') {
                out.push('\n');
            }
            out.push_str("</attached_file>\n\n");
        }
    }
    out.push_str(&m.content);
    out
}

/// Earlier turns as plain text, newest kept, for an agent that lost its session.
fn handoff_text(history: &[&ChatMessage]) -> String {
    let mut parts: Vec<String> = Vec::new();
    let mut used = 0;
    for m in history.iter().rev() {
        if m.content.trim().is_empty() {
            continue;
        }
        let who = if m.role == Role::User { "User" } else { "Assistant" };
        let entry = format!("{who}: {}", m.content.trim());
        if used + entry.len() > HANDOFF_CHARS {
            break;
        }
        used += entry.len();
        parts.push(entry);
    }
    parts.reverse();
    format!(
        "Earlier in this AgentHub conversation (your previous session couldn't be resumed, so this is a plain-text recap):\n\n{}\n\n---\n\n",
        parts.join("\n\n")
    )
}

/// History for an API request, newest first within `budget` characters.
/// Failed answers aren't sent (they may be cut off mid-sentence); stopped
/// ones are, because the user saw them. Always includes the latest message;
/// the result starts with a user turn. Returns the turns and how many were
/// left out.
/// The history sent with an API request, newest first within `budget` chars.
/// Pasted images of the kept user turns are loaded with `load` (id, mime),
/// newest first and at most `MAX_CONTEXT_IMAGES`; one that isn't resent, or
/// can't be loaded or sent, becomes a short note in that turn's text.
pub fn context_turns<'a>(
    history: impl Iterator<Item = &'a ChatMessage>,
    budget: usize,
    mut load: impl FnMut(&str, &str) -> Option<images::ImageInput>,
) -> (Vec<ApiTurn>, usize) {
    let eligible: Vec<(&ChatMessage, String)> = history
        .filter(|m| match m.role {
            Role::User => true,
            Role::Assistant => matches!(m.status, MessageStatus::Complete | MessageStatus::Stopped) && !m.content.trim().is_empty(),
        })
        .map(|m| (m, if m.role == Role::User { user_turn_text(m) } else { m.content.clone() }))
        .collect();
    let mut used = 0;
    let mut start = eligible.len();
    for (i, (_, text)) in eligible.iter().enumerate().rev() {
        let len = text.len();
        if start != eligible.len() && used + len > budget {
            break;
        }
        used += len;
        start = i;
    }
    while start < eligible.len() && eligible[start].0.role == Role::Assistant {
        start += 1;
    }
    let mut left = MAX_CONTEXT_IMAGES;
    let mut turns: Vec<ApiTurn> = eligible[start..]
        .iter()
        .rev()
        .map(|(m, text)| {
            let mut images = Vec::new();
            let mut notes = Vec::new();
            for item in m.items.iter().filter(|_| m.role == Role::User) {
                let ItemBody::Image { id, name, mime, .. } = &item.body else { continue };
                if left == 0 {
                    notes.push(format!("[An earlier image, \"{name}\", isn't resent.]"));
                } else if let Some(img) = load(id, mime) {
                    images.push(img);
                    left -= 1;
                } else {
                    notes.push(format!("[The image \"{name}\" couldn't be sent to this model.]"));
                }
            }
            let content = if notes.is_empty() { text.clone() } else { format!("{}\n\n{text}", notes.join("\n")) };
            ApiTurn { role: m.role, content, images }
        })
        .collect();
    turns.reverse();
    (turns, start)
}

fn missing_key(provider: Provider) -> ChatError {
    ChatError::new(
        ErrorKind::MissingKey,
        format!("Add an {} API key in Settings › AI integrations to use this model.", provider.label()),
    )
}

fn claude_needs_key() -> ChatError {
    ChatError::new(
        ErrorKind::MissingKey,
        "Claude Agent runs on the Claude Agent SDK with an Anthropic API key. Add one in Settings › AI integrations.",
    )
}

fn gemini_cli_needs_key() -> ChatError {
    ChatError::new(
        ErrorKind::MissingKey,
        "Gemini CLI needs a Gemini API key: add one under Gemini API in Settings › AI integrations. Personal Google sign-in moved to Antigravity.",
    )
}

fn timeout_error(provider: Provider, after: Duration) -> ChatError {
    ChatError::new(
        ErrorKind::Timeout,
        format!("{} stopped responding ({} s without data). The partial answer is kept.", provider.label(), after.as_secs()),
    )
}

/// reqwest errors name the URL but never headers, so no key; still, only a
/// fixed message is shown.
fn network_error(provider: Provider, e: &reqwest::Error) -> ChatError {
    let host = providers::default_base_url(provider).trim_start_matches("https://");
    if e.is_timeout() {
        return ChatError::new(ErrorKind::Timeout, format!("Connecting to {host} timed out. Check your connection, then retry."));
    }
    ChatError::new(
        ErrorKind::Network,
        format!("Couldn't reach {host}. Check your internet connection or proxy, then retry."),
    )
}

fn lower_first(s: &str) -> String {
    let mut chars = s.chars();
    match chars.next() {
        Some(c) => c.to_lowercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat::secrets::MemoryStore;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use tokio::sync::mpsc;

    fn msg(role: Role, content: &str, status: MessageStatus) -> ChatMessage {
        ChatMessage {
            id: uuid::Uuid::new_v4().to_string(),
            conversation_id: "c".into(),
            role,
            content: content.into(),
            status,
            engine: None,
            model: None,
            error: None,
            usage: None,
            items: vec![],
            created_at: 0,
        }
    }

    #[test]
    fn context_skips_failed_answers_and_reports_omitted_turns() {
        let h = [
            msg(Role::User, "q1-aaaaaaaaaa", MessageStatus::Complete),
            msg(Role::Assistant, "a1-aaaaaaaaaa", MessageStatus::Complete),
            msg(Role::User, "q2", MessageStatus::Complete),
            msg(Role::Assistant, "broken", MessageStatus::Error),
            msg(Role::Assistant, "partial", MessageStatus::Stopped),
            msg(Role::User, "q3", MessageStatus::Complete),
        ];
        let (turns, omitted) = context_turns(h.iter(), 10_000, |_, _| None);
        let text: Vec<_> = turns.iter().map(|t| t.content.as_str()).collect();
        assert_eq!(text, vec!["q1-aaaaaaaaaa", "a1-aaaaaaaaaa", "q2", "partial", "q3"]);
        assert_eq!(omitted, 0);

        let (turns, omitted) = context_turns(h.iter(), 15, |_, _| None);
        let text: Vec<_> = turns.iter().map(|t| t.content.as_str()).collect();
        assert_eq!(text, vec!["q2", "partial", "q3"]);
        assert_eq!(omitted, 2);

        let (turns, _) = context_turns(h.iter(), 1, |_, _| None);
        assert_eq!(turns.len(), 1);
        assert_eq!(turns[0].content, "q3");
    }

    #[test]
    fn attachments_are_inlined_before_the_question() {
        let mut m = msg(Role::User, "Why?", MessageStatus::Complete);
        m.items.push(Item {
            id: "a".into(),
            message_id: m.id.clone(),
            idx: 0,
            status: ItemStatus::Completed,
            body: ItemBody::Attachment { path: "src/a.rs".into(), text: "fn a() {}".into(), truncated: false },
            created_at: 0,
            updated_at: 0,
        });
        let t = user_turn_text(&m);
        assert!(t.starts_with("<attached_file path=\"src/a.rs\">\nfn a() {}\n</attached_file>"));
        assert!(t.ends_with("Why?"));
    }

    #[test]
    fn attachments_stay_inside_the_project() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("p");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("a.txt"), "hello").unwrap();
        std::fs::write(dir.path().join("secret.txt"), "no").unwrap();
        let root = dunce::canonicalize(&root).unwrap();
        assert_eq!(read_attachments(&root, &["a.txt".into()]).unwrap()[0].1, "hello");
        assert!(read_attachments(&root, &["../secret.txt".into()]).is_err());
    }

    // ---------- end-to-end with a mock provider ----------

    enum Reply {
        Raw(String),
        /// Headers and the first chunk, then the connection stays open.
        Stall(String),
    }

    fn serve(reply: Reply) -> (String, std::sync::mpsc::Receiver<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let (mut sock, _) = listener.accept().unwrap();
            let mut buf = Vec::new();
            let mut chunk = [0u8; 4096];
            loop {
                let n = sock.read(&mut chunk).unwrap();
                buf.extend_from_slice(&chunk[..n]);
                let text = String::from_utf8_lossy(&buf).to_string();
                if let Some(head_end) = text.find("\r\n\r\n") {
                    let len = text[..head_end]
                        .lines()
                        .find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap()))
                        .unwrap_or(0);
                    if buf.len() >= head_end + 4 + len {
                        break;
                    }
                }
                if n == 0 {
                    break;
                }
            }
            let _ = tx.send(String::from_utf8_lossy(&buf).to_string());
            match reply {
                Reply::Raw(r) => {
                    let _ = sock.write_all(r.as_bytes());
                }
                Reply::Stall(r) => {
                    let _ = sock.write_all(r.as_bytes());
                    let _ = sock.flush();
                    std::thread::sleep(Duration::from_secs(30));
                }
            }
        });
        (url, rx)
    }

    fn sse_response(body: &str) -> String {
        format!("HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\nconnection: close\r\n\r\n{body}")
    }

    fn service(db: &Arc<Db>, store: MemoryStore) -> ChatService {
        let dir = std::env::temp_dir().join(format!("agenthub-cp-{}", uuid::Uuid::new_v4()));
        ChatService::new(Arc::clone(db), Box::new(store), dir.join("checkpoints"), dir.join("images"), vec![])
    }

    fn setup(provider: Provider, url: &str) -> (Arc<ChatService>, String) {
        let db = Arc::new(Db::open_in_memory().unwrap());
        let store = MemoryStore::default();
        store.set(provider, "sk-test-secret-key-1234").unwrap();
        let svc = Arc::new(service(&db, store).with_base_url(provider, url));
        let conv = svc
            .create_conversation(NewChat {
                project_id: None,
                engine: provider.engine(),
                model: "model-x".into(),
                mode: Mode::Ask,
                policy: Policy::Ask,
                first_message: "Test".into(),
            })
            .unwrap();
        (svc, conv.id)
    }

    fn channel_sink() -> (Sink, mpsc::UnboundedReceiver<ChatEvent>) {
        let (tx, rx) = mpsc::unbounded_channel();
        (Arc::new(move |ev| drop(tx.send(ev))), rx)
    }

    async fn until_finished(rx: &mut mpsc::UnboundedReceiver<ChatEvent>) -> (Vec<ChatEvent>, ChatMessage) {
        let mut seen = Vec::new();
        loop {
            let ev = tokio::time::timeout(Duration::from_secs(10), rx.recv()).await.expect("timed out").expect("closed");
            if let ChatEvent::Finished { message, .. } = &ev {
                let m = message.clone();
                seen.push(ev);
                return (seen, m);
            }
            seen.push(ev);
        }
    }

    fn deltas(events: &[ChatEvent]) -> String {
        events
            .iter()
            .filter_map(|e| match e {
                ChatEvent::Delta { text, .. } => Some(text.as_str()),
                _ => None,
            })
            .collect()
    }

    #[tokio::test]
    async fn streams_an_openai_answer_with_usage_and_persists_it() {
        let body = concat!(
            "event: response.created\ndata: {\"type\":\"response.created\",\"response\":{}}\n\n",
            "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"Hello\"}\n\n",
            "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\", world\"}\n\n",
            "event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"usage\":{\"input_tokens\":12,\"output_tokens\":3}}}\n\n",
        );
        let (url, req_rx) = serve(Reply::Raw(sse_response(body)));
        let (svc, conv) = setup(Provider::OpenAI, &url);
        let (sink, mut rx) = channel_sink();
        let request_id = svc.send(&conv, "Say hello", &[], &[], None, sink).unwrap();
        let (events, msg) = until_finished(&mut rx).await;

        match &events[0] {
            ChatEvent::Started { request_id: r, user_message, omitted, .. } => {
                assert_eq!(r, &request_id);
                assert_eq!(user_message.as_ref().unwrap().content, "Say hello");
                assert_eq!(*omitted, 0);
            }
            other => panic!("{other:?}"),
        }
        assert_eq!(deltas(&events), "Hello, world");
        assert_eq!(msg.status, MessageStatus::Complete);
        assert_eq!(msg.usage, Some(Usage { input_tokens: Some(12), output_tokens: Some(3), cost_usd: None }));
        match events.last().unwrap() {
            ChatEvent::Finished { conversation, .. } => assert_eq!(conversation.status, ConversationStatus::Completed),
            other => panic!("{other:?}"),
        }
        let stored = repository::messages(&svc.db, &conv).unwrap();
        assert_eq!(stored.len(), 2);
        assert_eq!(stored[1].content, "Hello, world");
        let raw = req_rx.recv().unwrap();
        assert!(raw.starts_with("POST /v1/responses"));
        assert!(raw.to_ascii_lowercase().contains("authorization: bearer sk-test-secret-key-1234"));
        assert!(!raw.contains("\"tools\""));
        assert!(!svc.is_busy(&conv));
        assert_eq!(svc.provider_status(Provider::OpenAI).state, KeyState::Ok);
    }

    #[tokio::test]
    async fn streams_a_gemini_answer() {
        let body = concat!(
            "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"Hi \"}],\"role\":\"model\"}}]}\r\n\r\n",
            "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"there\"}],\"role\":\"model\"},\"finishReason\":\"STOP\"}],\"usageMetadata\":{\"promptTokenCount\":4,\"candidatesTokenCount\":2}}\r\n\r\n",
        );
        let (url, req_rx) = serve(Reply::Raw(sse_response(body)));
        let (svc, conv) = setup(Provider::Gemini, &url);
        let (sink, mut rx) = channel_sink();
        svc.send(&conv, "Hello", &[], &[], None, sink).unwrap();
        let (_, msg) = until_finished(&mut rx).await;
        assert_eq!(msg.content, "Hi there");
        assert_eq!(msg.status, MessageStatus::Complete);
        assert_eq!(msg.engine, Some(Engine::GeminiApi));
        let raw = req_rx.recv().unwrap().to_ascii_lowercase();
        assert!(raw.starts_with("post /v1beta/models/model-x:streamgeneratecontent?alt=sse"));
        assert!(raw.contains("x-goog-api-key: sk-test-secret-key-1234"));
    }

    #[tokio::test]
    async fn streams_an_anthropic_answer() {
        let body = concat!(
            "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":9}}}\n\n",
            "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"Hi \"}}\n\n",
            "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"there\"}}\n\n",
            "event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":2}}\n\n",
            "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n",
        );
        let (url, req_rx) = serve(Reply::Raw(sse_response(body)));
        let (svc, conv) = setup(Provider::Anthropic, &url);
        let (sink, mut rx) = channel_sink();
        svc.send(&conv, "Hello", &[], &[], None, sink).unwrap();
        let (_, msg) = until_finished(&mut rx).await;
        assert_eq!(msg.content, "Hi there");
        assert_eq!(msg.usage.unwrap(), Usage { input_tokens: Some(9), output_tokens: Some(2), cost_usd: None });
        let raw = req_rx.recv().unwrap().to_ascii_lowercase();
        assert!(raw.starts_with("post /v1/messages"));
        assert!(raw.contains("x-api-key: sk-test-secret-key-1234"));
    }

    #[tokio::test]
    async fn maps_an_auth_failure_without_leaking_the_key() {
        let reply = "HTTP/1.1 401 Unauthorized\r\ncontent-type: application/json\r\nconnection: close\r\n\r\n{\"error\":{\"message\":\"Incorrect API key provided: sk-test-secret-key-1234\",\"code\":\"invalid_api_key\"}}";
        let (url, _req) = serve(Reply::Raw(reply.into()));
        let (svc, conv) = setup(Provider::OpenAI, &url);
        let (sink, mut rx) = channel_sink();
        svc.send(&conv, "Hi", &[], &[], None, sink).unwrap();
        let (events, msg) = until_finished(&mut rx).await;
        assert_eq!(msg.status, MessageStatus::Error);
        let err = msg.error.unwrap();
        assert_eq!(err.kind, ErrorKind::InvalidKey);
        assert_eq!(err.status, Some(401));
        let all = serde_json::to_string(&events).unwrap();
        assert!(!all.contains("secret-key"), "key leaked into events: {all}");
        assert_eq!(svc.provider_status(Provider::OpenAI).state, KeyState::Invalid);
        assert_eq!(repository::get_conversation(&svc.db, &conv).unwrap().status, ConversationStatus::Failed);
    }

    #[tokio::test]
    async fn stop_keeps_the_partial_answer() {
        let first = sse_response(
            "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"Partial\"}\n\n",
        );
        let (url, _req) = serve(Reply::Stall(first));
        let (svc, conv) = setup(Provider::OpenAI, &url);
        let (sink, mut rx) = channel_sink();
        let request_id = svc.send(&conv, "Long answer please", &[], &[], None, sink).unwrap();
        loop {
            match tokio::time::timeout(Duration::from_secs(10), rx.recv()).await.unwrap().unwrap() {
                ChatEvent::Delta { .. } => break,
                _ => continue,
            }
        }
        assert!(svc.is_busy(&conv));
        assert!(svc.send(&conv, "again", &[], &[], None, channel_sink().0).is_err(), "one turn at a time");
        let started = Instant::now();
        assert!(svc.stop(&request_id));
        let (_, msg) = until_finished(&mut rx).await;
        assert!(started.elapsed() < Duration::from_secs(2), "stop is immediate");
        assert_eq!(msg.status, MessageStatus::Stopped);
        assert_eq!(msg.content, "Partial");
        assert!(!svc.is_busy(&conv));
    }

    fn new_image(name: &str, bytes: &[u8]) -> NewImage {
        use base64::Engine as _;
        NewImage { name: name.into(), data: base64::engine::general_purpose::STANDARD.encode(bytes) }
    }

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\n\0\0";

    #[tokio::test]
    async fn an_ask_chat_sends_pasted_images_and_shows_them_again() {
        let body = "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"A chart.\"}\n\n\
                    event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{}}\n\n";
        let (url, req_rx) = serve(Reply::Raw(sse_response(body)));
        let (svc, conv) = setup(Provider::OpenAI, &url);
        // A fake image is refused before anything is stored.
        let fake = NewImage { name: "fake.png".into(), data: "PHN2Zz4=".into() };
        let err = svc.send(&conv, "What's this?", &[], &[fake], None, channel_sink().0).unwrap_err().to_string();
        assert!(err.contains("isn't a PNG"), "{err}");
        assert!(repository::messages(&svc.db, &conv).unwrap().is_empty(), "nothing stored");

        let (sink, mut rx) = channel_sink();
        svc.send(&conv, "What's this?", &[], &[new_image("shot", PNG)], None, sink).unwrap();
        let (_, msg) = until_finished(&mut rx).await;
        assert_eq!(msg.content, "A chart.");
        let raw = req_rx.recv().unwrap();
        assert!(raw.contains(r#""type":"input_image","image_url":"data:image/png;base64,"#), "{raw}");
        let stored = repository::messages(&svc.db, &conv).unwrap();
        let image = stored[0].items.iter().find(|i| i.body.kind() == "image").expect("image item");
        assert!(svc.image_data_url(&image.id).unwrap().starts_with("data:image/png;base64,"));
    }

    #[test]
    fn gemini_refuses_gif_at_send() {
        let (svc, conv) = setup(Provider::Gemini, "http://127.0.0.1:9");
        let err = svc.send(&conv, "What's this?", &[], &[new_image("anim", b"GIF89a\0\0")], None, channel_sink().0).unwrap_err().to_string();
        assert!(err.contains("doesn't take GIF images"), "{err}");
    }

    #[test]
    fn api_history_resends_only_the_newest_images() {
        let mut turns = Vec::new();
        for n in 0..10 {
            let mut m = msg(Role::User, &format!("q{n}"), MessageStatus::Complete);
            m.items.push(Item {
                id: format!("i{n}"),
                message_id: m.id.clone(),
                idx: 0,
                status: ItemStatus::Completed,
                body: ItemBody::Image { id: format!("img{n}"), name: format!("Shot {n}"), mime: "image/png".into(), size: 4 },
                created_at: 0,
                updated_at: 0,
            });
            turns.push(m);
        }
        let (sent, _) = context_turns(turns.iter(), 10_000, |id, mime| {
            (id != "img9").then(|| images::ImageInput { mime: mime.into(), data: id.into() })
        });
        let counts: Vec<usize> = sent.iter().map(|t| t.images.len()).collect();
        // Shot 9 can't be loaded (no cap used); Shots 8–1 fill the cap of 8; Shot 0 is past it.
        assert_eq!(counts, vec![0, 1, 1, 1, 1, 1, 1, 1, 1, 0]);
        assert!(sent[0].content.starts_with("[An earlier image, \"Shot 0\", isn't resent.]"));
        assert!(sent[9].content.starts_with("[The image \"Shot 9\" couldn't be sent to this model.]"));
    }

    #[tokio::test]
    async fn a_turned_off_integration_never_starts_and_stays_off() {
        let first = sse_response(
            "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"Partial\"}\n\n",
        );
        let (url, _req) = serve(Reply::Stall(first));
        let (svc, conv) = setup(Provider::OpenAI, &url);
        let (sink, mut rx) = channel_sink();
        let request_id = svc.send(&conv, "Long answer please", &[], &[], None, sink).unwrap();
        loop {
            if let ChatEvent::Delta { .. } = tokio::time::timeout(Duration::from_secs(10), rx.recv()).await.unwrap().unwrap() {
                break;
            }
        }
        let err = svc.set_enabled(Engine::OpenAiApi, false).unwrap_err().to_string();
        assert!(err.contains("Stop the running"), "{err}");
        assert!(svc.is_enabled(Engine::OpenAiApi), "refused while a turn runs");
        svc.stop(&request_id);
        until_finished(&mut rx).await;

        svc.set_enabled(Engine::OpenAiApi, false).unwrap();
        let info = svc.engines().into_iter().find(|e| e.engine == Engine::OpenAiApi).unwrap();
        assert!(!info.enabled);
        let err = svc.send(&conv, "again", &[], &[], None, channel_sink().0).unwrap_err().to_string();
        assert!(err.contains("turned off"), "{err}");
        let new = NewChat {
            project_id: None,
            engine: Engine::OpenAiApi,
            model: "model-x".into(),
            mode: Mode::Ask,
            policy: Policy::Ask,
            first_message: "Hi".into(),
        };
        assert!(svc.create_conversation(new.clone()).is_err());
        assert_eq!(repository::messages(&svc.db, &conv).unwrap().len(), 2, "the chat and its history stay");

        let restarted = service(&svc.db, MemoryStore::default());
        assert!(!restarted.is_enabled(Engine::OpenAiApi), "persisted");
        assert!(restarted.is_enabled(Engine::AnthropicApi));

        svc.set_enabled(Engine::OpenAiApi, true).unwrap();
        assert!(svc.create_conversation(new).is_ok());
    }

    #[tokio::test]
    async fn a_dropped_stream_is_an_interrupted_error_with_partial_text() {
        let body = "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"Half\"}\n\n";
        let (url, _req) = serve(Reply::Raw(sse_response(body)));
        let (svc, conv) = setup(Provider::OpenAI, &url);
        let (sink, mut rx) = channel_sink();
        svc.send(&conv, "Hi", &[], &[], None, sink).unwrap();
        let (_, msg) = until_finished(&mut rx).await;
        assert_eq!(msg.status, MessageStatus::Error);
        assert_eq!(msg.content, "Half");
        assert_eq!(msg.error.unwrap().kind, ErrorKind::Interrupted);
    }

    #[tokio::test]
    async fn regenerate_replaces_the_previous_answer() {
        let body = concat!(
            "data: {\"type\":\"response.output_text.delta\",\"delta\":\"Second\"}\n\n",
            "data: {\"type\":\"response.completed\",\"response\":{}}\n\n",
        );
        let (url, _req) = serve(Reply::Raw(sse_response(body)));
        let (svc, conv) = setup(Provider::OpenAI, &url);
        let first = repository::begin_reply(&svc.db, &conv, Some("Q"), Engine::OpenAiApi, "m").unwrap();
        repository::finish(&svc.db, &first.assistant_message.id, "First", MessageStatus::Complete, None, None).unwrap();
        let (sink, mut rx) = channel_sink();
        svc.regenerate(&conv, sink).unwrap();
        let (events, _) = until_finished(&mut rx).await;
        match &events[0] {
            ChatEvent::Started { removed_ids, user_message, .. } => {
                assert_eq!(removed_ids, &vec![first.assistant_message.id.clone()]);
                assert!(user_message.is_none());
            }
            other => panic!("{other:?}"),
        }
        let stored = repository::messages(&svc.db, &conv).unwrap();
        let text: Vec<_> = stored.iter().map(|m| m.content.as_str()).collect();
        assert_eq!(text, vec!["Q", "Second"]);
    }

    #[tokio::test]
    async fn refuses_without_a_key_and_stores_nothing() {
        let db = Arc::new(Db::open_in_memory().unwrap());
        let svc = Arc::new(service(&db, MemoryStore::default()));
        let conv = svc
            .create_conversation(NewChat {
                project_id: None,
                engine: Engine::AnthropicApi,
                model: "m".into(),
                mode: Mode::Ask,
                policy: Policy::Ask,
                first_message: "T".into(),
            })
            .unwrap();
        let err = svc.send(&conv.id, "Hi", &[], &[], None, channel_sink().0).unwrap_err();
        assert_eq!(err.kind(), "missing_key");
        assert!(repository::messages(&db, &conv.id).unwrap().is_empty(), "nothing stored");
    }

    #[tokio::test]
    async fn a_backlog_item_goes_with_the_message_as_context_and_links_the_chat() {
        use crate::backlog::{self, BacklogRef, Kind, NewItem, Priority, Purpose};
        let db = Arc::new(Db::open_in_memory().unwrap());
        let dir = tempfile::tempdir().unwrap();
        let (a, b) = (dir.path().join("a"), dir.path().join("b"));
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        let pa = crate::projects::add(&db, &a.to_string_lossy(), Some("A")).unwrap();
        let pb = crate::projects::add(&db, &b.to_string_lossy(), Some("B")).unwrap();
        let item = |project: &str, kind, title: &str| {
            backlog::repository::create(&db, NewItem { project_id: project.into(), kind, title: title.into(), body: "Details".into(), priority: Priority::Normal })
                .unwrap()
        };
        let feat = item(&pa.id, Kind::Feature, "Dark mode");
        item(&pa.id, Kind::Bug, "Crash on save");
        let elsewhere = item(&pb.id, Kind::Bug, "Other project");
        let svc = Arc::new(service(&db, MemoryStore::default()));
        let conv = svc
            .create_conversation(NewChat {
                project_id: Some(pa.id.clone()),
                engine: Engine::Codex,
                model: "m".into(),
                mode: Mode::Plan,
                policy: Policy::Ask,
                first_message: "Plan".into(),
            })
            .unwrap();

        let wrong = BacklogRef { item_id: elsewhere.id.clone(), purpose: Purpose::Plan };
        let err = svc.send(&conv.id, "Plan it", &[], &[], Some(&wrong), channel_sink().0).unwrap_err().to_string();
        assert!(err.contains("another project"), "{err}");
        assert!(repository::messages(&db, &conv.id).unwrap().is_empty(), "nothing stored");

        // No adapter in this build: the turn fails, but the message and link are stored.
        let r = BacklogRef { item_id: feat.id.clone(), purpose: Purpose::Plan };
        svc.send(&conv.id, "Plan it", &[], &[], Some(&r), channel_sink().0).unwrap();
        let user = repository::messages(&db, &conv.id).unwrap().into_iter().find(|m| m.role == Role::User).unwrap();
        match &user.items[0].body {
            ItemBody::BacklogContext { item_id, label, text } => {
                assert_eq!(item_id, &feat.id);
                assert_eq!(label, "FEAT-1 · Dark mode");
                assert!(text.contains("- BUG-2 [Reported · Normal] Crash on save"), "{text}");
            }
            other => panic!("{other:?}"),
        }
        let prompt = user_turn_text(&user);
        assert!(prompt.starts_with("<backlog_context project=\"A\">") && prompt.ends_with("</backlog_context>\n\nPlan it"), "{prompt}");
        let links = backlog::repository::get(&db, &feat.id).unwrap().links;
        assert_eq!((links.len(), links[0].conversation_id.as_str(), links[0].purpose), (1, conv.id.as_str(), Purpose::Plan));
    }

    #[tokio::test]
    async fn gemini_cli_needs_the_gemini_api_key() {
        let db = Arc::new(Db::open_in_memory().unwrap());
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_string_lossy().to_string();
        db.with(|c| {
            c.execute("INSERT INTO projects (id, name, path, created_at) VALUES ('p', 'p', ?1, 0)", [&root])?;
            Ok(())
        })
        .unwrap();
        let svc = Arc::new(service(&db, MemoryStore::default()));
        let conv = svc
            .create_conversation(NewChat {
                project_id: Some("p".into()),
                engine: Engine::GeminiCli,
                model: "gemini-3.8-flash".into(),
                mode: Mode::Agent,
                policy: Policy::Ask,
                first_message: "T".into(),
            })
            .unwrap();
        let err = svc.send(&conv.id, "Hi", &[], &[], None, channel_sink().0).unwrap_err();
        assert_eq!(err.kind(), "missing_key");
        assert!(err.to_string().contains("Antigravity"), "{err}");
        assert!(repository::messages(&db, &conv.id).unwrap().is_empty(), "nothing stored");
    }

    #[test]
    fn agents_need_a_project_and_a_supported_mode() {
        let db = Arc::new(Db::open_in_memory().unwrap());
        let svc = service(&db, MemoryStore::default());
        let new = |engine, mode, project_id: Option<&str>| NewChat {
            project_id: project_id.map(Into::into),
            engine,
            model: "m".into(),
            mode,
            policy: Policy::Ask,
            first_message: "Hi".into(),
        };
        assert_eq!(svc.create_conversation(new(Engine::Codex, Mode::Agent, None)).unwrap_err().kind(), "mode_unsupported");
        db.with(|c| {
            c.execute("INSERT INTO projects (id, name, path, created_at) VALUES ('p', 'p', 'p', 0)", [])?;
            Ok(())
        })
        .unwrap();
        assert_eq!(svc.create_conversation(new(Engine::Codex, Mode::Ask, Some("p"))).unwrap_err().kind(), "mode_unsupported");
        assert_eq!(svc.create_conversation(new(Engine::OpenAiApi, Mode::Plan, Some("p"))).unwrap_err().kind(), "mode_unsupported");
        // Project chats are coding agents in Plan or Agent; General is direct APIs in Ask.
        assert_eq!(svc.create_conversation(new(Engine::ClaudeCode, Mode::Ask, Some("p"))).unwrap_err().kind(), "mode_unsupported");
        assert_eq!(svc.create_conversation(new(Engine::OpenAiApi, Mode::Ask, Some("p"))).unwrap_err().kind(), "mode_unsupported");
        let plan = svc.create_conversation(new(Engine::ClaudeCode, Mode::Plan, Some("p"))).unwrap();
        assert_eq!(plan.project_id.as_deref(), Some("p"));
        assert!(svc.set_mode(&plan.id, Mode::Ask).is_err());
        assert!(svc.set_engine(&plan.id, Engine::OpenAiApi, "m").is_err());
        let conv = svc.create_conversation(new(Engine::OpenAiApi, Mode::Ask, None)).unwrap();
        // API chats switch engines in place; with messages, not to an agent.
        repository::begin_reply(&db, &conv.id, Some("Q"), Engine::OpenAiApi, "m").unwrap();
        assert!(svc.set_engine(&conv.id, Engine::GeminiApi, "gemini-3.8-flash").is_ok());
        assert!(svc.set_engine(&conv.id, Engine::Codex, "gpt-6.1-sol").is_err());
    }

    #[tokio::test]
    async fn connection_test_uses_an_authenticated_request() {
        let (url, req_rx) = serve(Reply::Raw(
            "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\nconnection: close\r\n\r\n{\"id\":\"claude-opus-5-5\"}".into(),
        ));
        let (svc, _) = setup(Provider::Anthropic, &url);
        let status = svc.test(Provider::Anthropic, Some("claude-opus-5-5".into())).await.unwrap();
        assert_eq!(status.state, KeyState::Ok);
        assert_eq!(status.key_hint.as_deref(), Some("1234"));
        let raw = req_rx.recv().unwrap().to_ascii_lowercase();
        assert!(raw.starts_with("get /v1/models/claude-opus-5-5"));
        let json = serde_json::to_string(&status).unwrap();
        assert!(!json.contains("secret-key"));
    }

    #[tokio::test]
    async fn lists_gemini_models() {
        let (url, _req) = serve(Reply::Raw(
            "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\nconnection: close\r\n\r\n{\"models\":[{\"name\":\"models/gemini-3.8-flash\",\"supportedGenerationMethods\":[\"generateContent\"]}]}".into(),
        ));
        let (svc, _) = setup(Provider::Gemini, &url);
        let models = svc.api_models(Provider::Gemini).await.unwrap();
        assert_eq!(models, vec![ModelInfo { id: "gemini-3.8-flash".into(), label: "gemini-3.8-flash".into(), is_default: true }]);
    }
}
