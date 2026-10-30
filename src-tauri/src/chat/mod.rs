//! Unified Chat: one conversation model for coding-agent runtimes (Claude
//! Agent SDK, Codex app-server, Gemini CLI over ACP, Copilot SDK) and direct
//! APIs (OpenAI, Anthropic, Gemini). AgentHub is the client: it owns the
//! conversation registry, enforces the mode and approval policy (`policy`)
//! and normalizes every engine's events into `ChatEvent`s and stored `Item`s.
//!
//! - `service`: requests, one turn per conversation at a time, direct APIs.
//! - `agents`: native runtimes behind `EngineAdapter`, plus the turn driver.
//! - `engines`: capability catalog and the startup probe.
//! - `repository`: SQLite history (migrations v2–v3). API keys never go there:
//!   they live in the OS credential store (`secrets`).

pub mod agents;
pub mod checkpoints;
pub mod engines;
pub mod images;
pub mod policy;
pub mod providers;
pub mod repository;
pub mod secrets;
pub mod service;
pub mod sse;

use serde::{Deserialize, Serialize};

pub use providers::Usage;
pub use service::ChatService;

/// Direct-API providers: the ones with an API key in the credential store.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    OpenAI,
    Anthropic,
    Gemini,
}

impl Provider {
    pub const ALL: [Provider; 3] = [Provider::Anthropic, Provider::OpenAI, Provider::Gemini];

    pub fn as_str(self) -> &'static str {
        match self {
            Provider::OpenAI => "openai",
            Provider::Anthropic => "anthropic",
            Provider::Gemini => "gemini",
        }
    }

    pub fn parse(s: &str) -> Option<Provider> {
        match s {
            "openai" => Some(Provider::OpenAI),
            "anthropic" => Some(Provider::Anthropic),
            "gemini" => Some(Provider::Gemini),
            _ => None,
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Provider::OpenAI => "OpenAI",
            Provider::Anthropic => "Anthropic",
            Provider::Gemini => "Gemini",
        }
    }

    pub fn engine(self) -> Engine {
        match self {
            Provider::OpenAI => Engine::OpenAiApi,
            Provider::Anthropic => Engine::AnthropicApi,
            Provider::Gemini => Engine::GeminiApi,
        }
    }
}

/// What answers a conversation: a local coding-agent runtime or a direct API.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Engine {
    #[serde(rename = "claude-code")]
    ClaudeCode,
    #[serde(rename = "codex")]
    Codex,
    #[serde(rename = "gemini-cli")]
    GeminiCli,
    #[serde(rename = "antigravity")]
    Antigravity,
    #[serde(rename = "copilot-cli")]
    CopilotCli,
    #[serde(rename = "openai-api")]
    OpenAiApi,
    #[serde(rename = "anthropic-api")]
    AnthropicApi,
    #[serde(rename = "gemini-api")]
    GeminiApi,
}

impl Engine {
    pub const ALL: [Engine; 8] = [
        Engine::ClaudeCode,
        Engine::Codex,
        Engine::GeminiCli,
        Engine::Antigravity,
        Engine::CopilotCli,
        Engine::OpenAiApi,
        Engine::AnthropicApi,
        Engine::GeminiApi,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Engine::ClaudeCode => "claude-code",
            Engine::Codex => "codex",
            Engine::GeminiCli => "gemini-cli",
            Engine::Antigravity => "antigravity",
            Engine::CopilotCli => "copilot-cli",
            Engine::OpenAiApi => "openai-api",
            Engine::AnthropicApi => "anthropic-api",
            Engine::GeminiApi => "gemini-api",
        }
    }

    /// Also reads the v2 provider names, in case a row predates migration v3.
    pub fn parse(s: &str) -> Option<Engine> {
        Engine::ALL.into_iter().find(|e| e.as_str() == s).or(match s {
            "openai" => Some(Engine::OpenAiApi),
            "anthropic" => Some(Engine::AnthropicApi),
            _ => None,
        })
    }

    pub fn label(self) -> &'static str {
        match self {
            Engine::ClaudeCode => "Claude Agent",
            Engine::Codex => "OpenAI Codex",
            Engine::GeminiCli => "Gemini CLI",
            Engine::Antigravity => "Antigravity",
            Engine::CopilotCli => "Copilot CLI",
            Engine::OpenAiApi => "OpenAI API",
            Engine::AnthropicApi => "Anthropic API",
            Engine::GeminiApi => "Gemini API",
        }
    }

    pub fn api_provider(self) -> Option<Provider> {
        match self {
            Engine::OpenAiApi => Some(Provider::OpenAI),
            Engine::AnthropicApi => Some(Provider::Anthropic),
            Engine::GeminiApi => Some(Provider::Gemini),
            _ => None,
        }
    }

    pub fn is_agent(self) -> bool {
        self.api_provider().is_none()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    Ask,
    Plan,
    Agent,
}

impl Mode {
    pub fn as_str(self) -> &'static str {
        match self {
            Mode::Ask => "ask",
            Mode::Plan => "plan",
            Mode::Agent => "agent",
        }
    }
    pub fn parse(s: &str) -> Mode {
        match s {
            "plan" => Mode::Plan,
            "agent" => Mode::Agent,
            _ => Mode::Ask,
        }
    }
}

/// Approval policy for Agent mode, per conversation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Policy {
    /// Every write and command asks (the default).
    Ask,
    /// Writes inside the project are allowed; commands ask.
    AutoEdits,
    /// Writes and commands inside the project are allowed; deletes, network
    /// installs and pushes still ask.
    AutoAll,
}

impl Policy {
    pub fn as_str(self) -> &'static str {
        match self {
            Policy::Ask => "ask",
            Policy::AutoEdits => "auto_edits",
            Policy::AutoAll => "auto_all",
        }
    }
    pub fn parse(s: &str) -> Policy {
        match s {
            "auto_edits" => Policy::AutoEdits,
            "auto_all" => Policy::AutoAll,
            _ => Policy::Ask,
        }
    }
}

/// A conversation's state, persisted on every transition.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConversationStatus {
    Idle,
    Running,
    WaitingForApproval,
    Completed,
    Failed,
    Cancelled,
    /// AgentHub closed while a turn ran; nothing re-runs automatically.
    Interrupted,
}

impl ConversationStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            ConversationStatus::Idle => "idle",
            ConversationStatus::Running => "running",
            ConversationStatus::WaitingForApproval => "waiting_for_approval",
            ConversationStatus::Completed => "completed",
            ConversationStatus::Failed => "failed",
            ConversationStatus::Cancelled => "cancelled",
            ConversationStatus::Interrupted => "interrupted",
        }
    }
    pub fn parse(s: &str) -> ConversationStatus {
        match s {
            "running" => ConversationStatus::Running,
            "waiting_for_approval" => ConversationStatus::WaitingForApproval,
            "completed" => ConversationStatus::Completed,
            "failed" => ConversationStatus::Failed,
            "cancelled" => ConversationStatus::Cancelled,
            "interrupted" => ConversationStatus::Interrupted,
            _ => ConversationStatus::Idle,
        }
    }
    pub fn is_active(self) -> bool {
        matches!(self, ConversationStatus::Running | ConversationStatus::WaitingForApproval)
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Conversation {
    pub id: String,
    /// `None`: the General workspace.
    pub project_id: Option<String>,
    pub title: String,
    pub engine: Engine,
    pub model: String,
    pub mode: Mode,
    pub policy: Policy,
    pub status: ConversationStatus,
    /// The engine's own session/thread id, when it has one. Bound to `engine`.
    pub runtime_session_id: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

// ---------- items: agent activity inside an assistant message ----------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ItemStatus {
    Pending,
    Running,
    Completed,
    Failed,
    Declined,
    Cancelled,
}

impl ItemStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            ItemStatus::Pending => "pending",
            ItemStatus::Running => "running",
            ItemStatus::Completed => "completed",
            ItemStatus::Failed => "failed",
            ItemStatus::Declined => "declined",
            ItemStatus::Cancelled => "cancelled",
        }
    }
    pub fn parse(s: &str) -> ItemStatus {
        match s {
            "pending" => ItemStatus::Pending,
            "running" => ItemStatus::Running,
            "failed" => ItemStatus::Failed,
            "declined" => ItemStatus::Declined,
            "cancelled" => ItemStatus::Cancelled,
            _ => ItemStatus::Completed,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolKind {
    Read,
    Search,
    Edit,
    Delete,
    Move,
    Run,
    Think,
    Fetch,
    Mcp,
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PermissionKind {
    Read,
    Write,
    Delete,
    Command,
    Network,
    Mcp,
    Other,
}

/// What an engine asks permission for, normalized.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionRequest {
    pub kind: PermissionKind,
    /// One line, e.g. "Run a command" or the engine's own tool title.
    pub title: String,
    #[serde(default)]
    pub command: Option<String>,
    /// Main absolute path the operation touches, when known.
    #[serde(default)]
    pub path: Option<String>,
    /// Every path it touches (a patch can change several files).
    #[serde(default)]
    pub paths: Vec<String>,
    #[serde(default)]
    pub detail: Option<String>,
    /// The engine can remember "allow for this session" itself.
    #[serde(default)]
    pub can_allow_session: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Decision {
    AllowOnce,
    AllowSession,
    Deny,
    /// Deny and stop the turn.
    Cancel,
}

impl Decision {
    pub fn allows(self) -> bool {
        matches!(self, Decision::AllowOnce | Decision::AllowSession)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StepStatus {
    Pending,
    InProgress,
    Completed,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanStep {
    pub text: String,
    pub status: StepStatus,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChangeKind {
    Add,
    Modify,
    Delete,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChangeState {
    /// On disk; not reviewed yet.
    Applied,
    Kept,
    Reverted,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Tone {
    Info,
    Warn,
    Danger,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum ItemBody {
    /// A block of assistant text (agents interleave text and tools).
    Text { text: String },
    /// Reasoning the engine chose to show; never sent back as context.
    Thinking { text: String },
    Tool {
        tool: ToolKind,
        title: String,
        #[serde(default)]
        detail: Option<String>,
        #[serde(default)]
        result: Option<String>,
    },
    Command {
        command: String,
        #[serde(default)]
        cwd: Option<String>,
        #[serde(default)]
        output: String,
        #[serde(default)]
        exit_code: Option<i32>,
        #[serde(default)]
        duration_ms: Option<u64>,
    },
    Permission {
        request: PermissionRequest,
        #[serde(default)]
        decision: Option<Decision>,
        /// Decided by the policy, not by the user.
        #[serde(default)]
        auto: bool,
        /// Why the policy decided as it did.
        #[serde(default)]
        reason: Option<String>,
    },
    Plan {
        steps: Vec<PlanStep>,
        #[serde(default)]
        explanation: Option<String>,
    },
    FileChange {
        /// Project-relative when inside the project, else absolute.
        path: String,
        change: ChangeKind,
        #[serde(default)]
        additions: u32,
        #[serde(default)]
        deletions: u32,
        /// Snapshot id of the content before the change (revertible).
        #[serde(default)]
        checkpoint: Option<String>,
        state: ChangeState,
    },
    System { text: String, tone: Tone },
    Error { error: ChatError },
    /// A file the user attached to their message (`@`), as it was sent.
    Attachment {
        path: String,
        text: String,
        #[serde(default)]
        truncated: bool,
    },
    /// An image the user pasted into their message. `id` names the file in
    /// AgentHub's app data folder (`chat::images`); the bytes aren't in SQLite.
    Image { id: String, name: String, mime: String, size: u64 },
}

impl ItemBody {
    pub fn kind(&self) -> &'static str {
        match self {
            ItemBody::Attachment { .. } => "attachment",
            ItemBody::Image { .. } => "image",
            ItemBody::Text { .. } => "text",
            ItemBody::Thinking { .. } => "thinking",
            ItemBody::Tool { .. } => "tool",
            ItemBody::Command { .. } => "command",
            ItemBody::Permission { .. } => "permission",
            ItemBody::Plan { .. } => "plan",
            ItemBody::FileChange { .. } => "file_change",
            ItemBody::System { .. } => "system",
            ItemBody::Error { .. } => "error",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub id: String,
    pub message_id: String,
    pub idx: i64,
    pub status: ItemStatus,
    pub body: ItemBody,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    User,
    Assistant,
}

impl Role {
    pub fn as_str(self) -> &'static str {
        match self {
            Role::User => "user",
            Role::Assistant => "assistant",
        }
    }
}

/// `streaming` only while a request runs; a reply left `streaming` by a crash
/// becomes `error` (interrupted) on the next start.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MessageStatus {
    Complete,
    Streaming,
    Stopped,
    Error,
}

impl MessageStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            MessageStatus::Complete => "complete",
            MessageStatus::Streaming => "streaming",
            MessageStatus::Stopped => "stopped",
            MessageStatus::Error => "error",
        }
    }

    pub fn parse(s: &str) -> MessageStatus {
        match s {
            "complete" => MessageStatus::Complete,
            "streaming" => MessageStatus::Streaming,
            "stopped" => MessageStatus::Stopped,
            _ => MessageStatus::Error,
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub id: String,
    pub conversation_id: String,
    pub role: Role,
    pub content: String,
    pub status: MessageStatus,
    /// What produced an answer (`None` on user messages).
    pub engine: Option<Engine>,
    pub model: Option<String>,
    /// Why the reply failed, or a note on a complete one (`truncated`).
    pub error: Option<ChatError>,
    /// Token counts and cost, only as reported by the engine.
    pub usage: Option<Usage>,
    /// Agent activity in order (text blocks, tools, approvals, changes).
    /// Empty for direct-API answers, whose text is `content`.
    pub items: Vec<Item>,
    pub created_at: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorKind {
    /// The runtime's executable (or Node.js for SDK runtimes) wasn't found.
    EngineNotFound,
    /// The runtime reports that it isn't signed in.
    NotSignedIn,
    /// The runtime process exited or the sidecar crashed mid-turn.
    RuntimeExited,
    /// The stored runtime session couldn't be resumed.
    ResumeFailed,
    /// The engine can't enforce this mode.
    ModeUnsupported,
    MissingKey,
    InvalidKey,
    PermissionDenied,
    ModelUnavailable,
    InsufficientCredits,
    RateLimited,
    Overloaded,
    Network,
    Timeout,
    Interrupted,
    Malformed,
    ProviderError,
    ContextTooLong,
    InvalidRequest,
    Refused,
    /// Not a failure: the reply hit the output limit.
    Truncated,
}

impl ErrorKind {
    pub fn as_str(self) -> &'static str {
        match self {
            ErrorKind::EngineNotFound => "engine_not_found",
            ErrorKind::NotSignedIn => "not_signed_in",
            ErrorKind::RuntimeExited => "runtime_exited",
            ErrorKind::ResumeFailed => "resume_failed",
            ErrorKind::ModeUnsupported => "mode_unsupported",
            ErrorKind::MissingKey => "missing_key",
            ErrorKind::InvalidKey => "invalid_key",
            ErrorKind::PermissionDenied => "permission_denied",
            ErrorKind::ModelUnavailable => "model_unavailable",
            ErrorKind::InsufficientCredits => "insufficient_credits",
            ErrorKind::RateLimited => "rate_limited",
            ErrorKind::Overloaded => "overloaded",
            ErrorKind::Network => "network",
            ErrorKind::Timeout => "timeout",
            ErrorKind::Interrupted => "interrupted",
            ErrorKind::Malformed => "malformed",
            ErrorKind::ProviderError => "provider_error",
            ErrorKind::ContextTooLong => "context_too_long",
            ErrorKind::InvalidRequest => "invalid_request",
            ErrorKind::Refused => "refused",
            ErrorKind::Truncated => "truncated",
        }
    }
}

/// Normalized provider error. Messages are built here or redacted provider
/// text; they never contain an API key.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatError {
    pub kind: ErrorKind,
    pub message: String,
    /// HTTP status from the provider, when there was one.
    #[serde(default)]
    pub status: Option<u16>,
    /// Seconds, from `retry-after` on rate limits.
    #[serde(default)]
    pub retry_after: Option<u64>,
}

impl ChatError {
    pub fn new(kind: ErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
            status: None,
            retry_after: None,
        }
    }

    pub fn with_status(mut self, status: u16) -> Self {
        self.status = Some(status);
        self
    }
}

impl std::fmt::Display for ChatError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

/// Streamed to the frontend. Every event names its conversation and request,
/// so late events from a stopped or switched-away chat can't land elsewhere.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ChatEvent {
    /// The request was accepted: the stored user message (on send), the
    /// placeholder reply, replies it replaced (regenerate), and how many
    /// earlier messages didn't fit the context budget.
    Started {
        conversation_id: String,
        request_id: String,
        user_message: Option<ChatMessage>,
        assistant_message: ChatMessage,
        removed_ids: Vec<String>,
        omitted: usize,
    },
    /// Answer text. With `item_id` it also extends that text item (agents).
    Delta {
        conversation_id: String,
        request_id: String,
        message_id: String,
        text: String,
        item_id: Option<String>,
    },
    /// An item was added or changed; the payload is its full current state.
    Item {
        conversation_id: String,
        request_id: String,
        message_id: String,
        item: Item,
    },
    /// Appends command output to a command item.
    Output {
        conversation_id: String,
        request_id: String,
        item_id: String,
        text: String,
    },
    Status {
        conversation_id: String,
        request_id: String,
        status: ConversationStatus,
    },
    Usage {
        conversation_id: String,
        request_id: String,
        message_id: String,
        usage: Usage,
    },
    /// The reply as stored: complete, stopped or error.
    Finished {
        conversation_id: String,
        request_id: String,
        message: ChatMessage,
        conversation: Conversation,
    },
}

/// Title from the first user message: its first non-empty line, whitespace
/// collapsed, at most 60 characters.
pub fn title_from(text: &str) -> String {
    let line = text.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("");
    let line = line.trim_start_matches(['#', '>', '-', '*', '`', ' ']);
    let collapsed = line.split_whitespace().collect::<Vec<_>>().join(" ");
    const MAX: usize = 60;
    if collapsed.is_empty() {
        return "New chat".into();
    }
    if collapsed.chars().count() <= MAX {
        return collapsed;
    }
    let cut: String = collapsed.chars().take(MAX - 1).collect();
    format!("{}…", cut.trim_end())
}

/// Removes anything key-like from text that came from a provider, plus the
/// exact key when known. Applied to every provider message we keep or show.
pub fn redact(text: &str, key: Option<&str>) -> String {
    let mut out = match key.filter(|k| k.len() >= 8) {
        Some(k) => text.replace(k, "[redacted]"),
        None => text.to_string(),
    };
    // OpenAI/Anthropic (`sk-`), session tokens, Google API keys (`AIza`), and
    // GitHub/GitLab tokens that can show up in git output.
    for prefix in ["sk-", "sess-", "AIza", "ghp_", "gho_", "ghu_", "ghs_", "ghr_", "github_pat_", "glpat-"] {
        let mut result = String::with_capacity(out.len());
        let mut rest = out.as_str();
        while let Some(i) = rest.find(prefix) {
            let boundary = i == 0 || !rest[..i].ends_with(|c: char| c.is_ascii_alphanumeric());
            let tail = &rest[i + prefix.len()..];
            let len = tail
                .find(|c: char| !(c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '*' | '.')))
                .unwrap_or(tail.len());
            result.push_str(&rest[..i]);
            if boundary && len >= 6 {
                result.push_str("[redacted]");
            } else {
                result.push_str(&rest[i..i + prefix.len() + len]);
            }
            rest = &tail[len..];
        }
        result.push_str(rest);
        out = result;
    }
    redact_url_userinfo(&out)
}

/// `https://user:token@host/…` → `https://[redacted]@host/…` (git prints remote URLs).
fn redact_url_userinfo(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(i) = rest.find("://") {
        let (head, tail) = rest.split_at(i + 3);
        out.push_str(head);
        let end = tail.find(|c: char| c.is_whitespace() || c == '/' || c == '"' || c == '\'').unwrap_or(tail.len());
        match tail[..end].rfind('@') {
            Some(at) if at > 0 => {
                out.push_str("[redacted]");
                out.push_str(&tail[at..end]);
            }
            _ => out.push_str(&tail[..end]),
        }
        rest = &tail[end..];
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn titles_come_from_the_first_line() {
        assert_eq!(title_from("  \n How do I   debounce\nresize?"), "How do I debounce");
        assert_eq!(title_from("## Heading"), "Heading");
        assert_eq!(title_from("   "), "New chat");
        let long = "a".repeat(100);
        let t = title_from(&long);
        assert_eq!(t.chars().count(), 60);
        assert!(t.ends_with('…'));
    }

    #[test]
    fn redacts_keys_from_provider_text() {
        let key = "sk-proj-abcdef1234567890";
        let msg = format!("Incorrect API key provided: {key}. Also sk-ant-api03-XYZ*****wxyz.");
        let out = redact(&msg, Some(key));
        assert!(!out.contains("abcdef"), "{out}");
        assert!(!out.contains("XYZ"), "{out}");
        assert!(out.contains("[redacted]"));
        // Ordinary words with the prefix survive.
        assert_eq!(redact("risk-free task-list", None), "risk-free task-list");
        let google = redact("API key not valid: AIzaSyD-example_key0123456789", None);
        assert_eq!(google, "API key not valid: [redacted]");
    }

    #[test]
    fn redacts_git_tokens_and_url_credentials() {
        let out = redact("fatal: unable to access 'https://kamil:ghp_abcdefghij1234567890@github.com/org/repo.git/'", None);
        assert_eq!(out, "fatal: unable to access 'https://[redacted]@github.com/org/repo.git/'");
        assert_eq!(redact("token github_pat_11ABCDEFG0123456789_xyz", None), "token [redacted]");
        assert_eq!(redact("remote: https://github.com/org/repo.git", None), "remote: https://github.com/org/repo.git");
        assert_eq!(redact("ssh://git@github.com/org/repo.git", None), "ssh://[redacted]@github.com/org/repo.git");
    }

    #[test]
    fn events_serialize_with_ids_and_camel_case() {
        let ev = ChatEvent::Delta {
            conversation_id: "c".into(),
            request_id: "r".into(),
            message_id: "m".into(),
            text: "hi".into(),
            item_id: None,
        };
        let v = serde_json::to_value(&ev).unwrap();
        assert_eq!(v["type"], "delta");
        assert_eq!(v["conversationId"], "c");
        assert_eq!(v["requestId"], "r");
        assert_eq!(v["messageId"], "m");
    }

    #[test]
    fn items_serialize_flat_with_a_kind_tag() {
        let item = Item {
            id: "i".into(),
            message_id: "m".into(),
            idx: 2,
            status: ItemStatus::Pending,
            body: ItemBody::Permission {
                request: PermissionRequest {
                    kind: PermissionKind::Command,
                    title: "Run a command".into(),
                    command: Some("cargo test".into()),
                    path: None,
                    paths: vec![],
                    detail: None,
                    can_allow_session: true,
                },
                decision: None,
                auto: false,
                reason: None,
            },
            created_at: 1,
            updated_at: 1,
        };
        let v = serde_json::to_value(&item).unwrap();
        assert_eq!(v["body"]["kind"], "permission");
        assert_eq!(v["body"]["request"]["canAllowSession"], true);
        let back: Item = serde_json::from_value(v).unwrap();
        assert_eq!(back, item);
    }

    #[test]
    fn engines_parse_their_ids_and_legacy_providers() {
        for e in Engine::ALL {
            assert_eq!(Engine::parse(e.as_str()), Some(e));
            assert_eq!(serde_json::to_value(e).unwrap(), e.as_str());
        }
        assert_eq!(Engine::parse("anthropic"), Some(Engine::AnthropicApi));
        assert!(Engine::GeminiCli.is_agent() && !Engine::GeminiApi.is_agent());
        assert_eq!(Provider::Gemini.engine(), Engine::GeminiApi);
    }
}
