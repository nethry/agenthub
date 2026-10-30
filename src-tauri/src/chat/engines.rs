//! What each engine can do, and what the startup probe found on this machine.
//! Capabilities here are the ones AgentHub can *enforce* with that runtime's
//! hooks; a mode the runtime can't keep within its rules is unsupported, with
//! the reason shown in the UI. Probe results are cached in SQLite (no secrets).

use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};

use super::{Engine, Mode};
use crate::error::{now_ms, AppResult};
use crate::persistence::Db;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    pub modes: Vec<Mode>,
    /// Why a mode is missing from `modes`, per mode.
    pub unsupported: Vec<(Mode, String)>,
    pub tools: bool,
    pub file_read: bool,
    pub file_write: bool,
    pub commands: bool,
    pub approvals: bool,
    pub session_resume: bool,
    pub model_discovery: bool,
    pub usage: bool,
    /// Takes images pasted into a message (ACP runtimes are also checked at turn time).
    pub images: bool,
    /// Plain-language limits of this runtime's enforcement (e.g. no sandbox on Windows).
    pub notes: Vec<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProbeState {
    Ready,
    /// The executable (or Node.js for SDK runtimes) isn't installed.
    NotFound,
    SignInNeeded,
    KeyMissing,
    KeyInvalid,
    Error,
    /// Not probed yet.
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub is_default: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EngineProbe {
    pub engine: Engine,
    pub state: ProbeState,
    pub message: Option<String>,
    /// Executable that will run (never a secret).
    pub path: Option<String>,
    pub version: Option<String>,
    /// e.g. "ChatGPT account", "API key", a login name; never a token.
    pub account: Option<String>,
    pub models: Vec<ModelInfo>,
    pub probed_at: Option<i64>,
}

impl EngineProbe {
    pub fn new(engine: Engine, state: ProbeState, message: impl Into<Option<String>>) -> Self {
        Self {
            engine,
            state,
            message: message.into(),
            path: None,
            version: None,
            account: None,
            models: vec![],
            probed_at: Some(now_ms()),
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EngineInfo {
    pub engine: Engine,
    pub label: &'static str,
    pub kind: &'static str,
    /// Turned on in Settings › AI integrations (off: not probed, started or shown).
    pub enabled: bool,
    pub capabilities: Capabilities,
    pub probe: EngineProbe,
}

fn modes(list: &[Mode]) -> Vec<Mode> {
    list.to_vec()
}

pub fn capabilities(engine: Engine) -> Capabilities {
    let api = |models: bool| Capabilities {
        modes: modes(&[Mode::Ask]),
        unsupported: vec![
            (Mode::Plan, "Direct APIs answer questions only; they can't read your project.".into()),
            (Mode::Agent, "Direct APIs answer questions only; they can't edit files or run tools.".into()),
        ],
        tools: false,
        file_read: false,
        file_write: false,
        commands: false,
        approvals: false,
        session_resume: false,
        model_discovery: models,
        usage: true,
        images: true,
        notes: vec!["Files and images reach the model only when you attach or paste them.".into()],
    };
    let agent = |modes_: &[Mode], unsupported: Vec<(Mode, String)>, notes: Vec<String>| Capabilities {
        modes: modes(modes_),
        unsupported,
        tools: true,
        file_read: true,
        file_write: true,
        commands: true,
        approvals: true,
        session_resume: true,
        model_discovery: true,
        usage: true,
        images: true,
        notes,
    };
    match engine {
        Engine::ClaudeCode => agent(
            &[Mode::Ask, Mode::Plan, Mode::Agent],
            vec![],
            vec![
                "Runs on the Claude Agent SDK with your Anthropic API key.".into(),
                "Ask runs with no tools; Plan allows only Read, Glob and Grep inside the project.".into(),
                "Commands aren't sandboxed on Windows: every command needs your approval unless the policy allows it.".into(),
            ],
        ),
        Engine::Codex => agent(
            &[Mode::Plan, Mode::Agent],
            vec![(
                Mode::Ask,
                "Codex always runs its built-in read-only commands, so it can't promise Ask's no-file-access rule. Use Plan, or a direct API."
                    .into(),
            )],
            vec![
                "Runs in a read-only sandbox; every edit and non-trusted command is an approval AgentHub answers by policy.".into(),
                "Codex's built-in read-only commands (listing and reading files) run without asking.".into(),
                "Approving a command also approves running it outside the sandbox if the sandbox blocks it. On Windows the sandbox only exists if Codex's Windows sandbox is set up, so your approval is the safeguard.".into(),
            ],
        ),
        Engine::GeminiCli => agent(
            &[Mode::Ask, Mode::Plan, Mode::Agent],
            vec![],
            vec![
                "Runs on your Gemini API key (paid usage). Personal Google accounts can't sign in to Gemini CLI any more; use Antigravity.".into(),
                "Project file reads and writes go through AgentHub, which denies them by mode.".into(),
                "Gemini CLI may read its own files outside the project (settings, .gemini) directly.".into(),
            ],
        ),
        Engine::Antigravity => {
            let mut c = agent(
                &[Mode::Ask, Mode::Plan, Mode::Agent],
                vec![],
                vec![
                    "Runs Google's Antigravity ACP server with your Google account; it offers Gemini models only.".into(),
                    "File reads and writes it sends through AgentHub are checked by mode, and its edits and commands come to you as approvals.".into(),
                    "Antigravity's own permission settings also apply. If it edits, runs or (in Ask) reads something without asking AgentHub, the turn stops with an error; what already happened isn't undone.".into(),
                    "The server takes about 15 s to start for each chat. It doesn't reload earlier sessions, so after a restart it gets a recap of the chat.".into(),
                ],
            );
            c.session_resume = false;
            c
        }
        Engine::CopilotCli => agent(
            &[Mode::Ask, Mode::Plan, Mode::Agent],
            vec![],
            vec![
                "Ask runs with no tools; in Plan every write, command, URL and MCP request is rejected.".into(),
                "Each prompt counts against your Copilot premium-request allowance.".into(),
            ],
        ),
        Engine::OpenAiApi | Engine::AnthropicApi | Engine::GeminiApi => api(true),
    }
}

/// Model used when a new conversation doesn't pick one.
pub fn default_model(engine: Engine) -> &'static str {
    match engine {
        Engine::ClaudeCode => "claude-opus-5-5",
        Engine::Codex => "gpt-6.1-sol",
        Engine::GeminiCli => "gemini-3.8-flash",
        Engine::Antigravity => "default",
        Engine::CopilotCli => "default",
        Engine::OpenAiApi => "gpt-6.1-sol",
        Engine::AnthropicApi => "claude-opus-5-5",
        Engine::GeminiApi => "gemini-3.8-flash",
    }
}

pub fn supports(engine: Engine, mode: Mode) -> Result<(), String> {
    let caps = capabilities(engine);
    if caps.modes.contains(&mode) {
        return Ok(());
    }
    Err(caps
        .unsupported
        .into_iter()
        .find(|(m, _)| *m == mode)
        .map(|(_, r)| r)
        .unwrap_or_else(|| format!("{} doesn't support this mode.", engine.label())))
}

pub fn load_probe(db: &Db, engine: Engine) -> Option<EngineProbe> {
    db.with(|c| {
        Ok(c.query_row("SELECT json FROM engine_probes WHERE engine = ?1", [engine.as_str()], |r| r.get::<_, String>(0))
            .optional()?)
    })
    .ok()
    .flatten()
    .and_then(|raw| serde_json::from_str(&raw).ok())
}

pub fn save_probe(db: &Db, probe: &EngineProbe) -> AppResult<()> {
    let json = serde_json::to_string(probe).unwrap_or_default();
    db.with(|c| {
        c.execute(
            "INSERT INTO engine_probes (engine, json, probed_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(engine) DO UPDATE SET json = excluded.json, probed_at = excluded.probed_at",
            params![probe.engine.as_str(), json, probe.probed_at.unwrap_or_else(now_ms)],
        )?;
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn apis_are_ask_only_and_agents_say_why_a_mode_is_missing() {
        for e in [Engine::OpenAiApi, Engine::AnthropicApi, Engine::GeminiApi] {
            assert_eq!(capabilities(e).modes, vec![Mode::Ask]);
            assert!(supports(e, Mode::Agent).is_err());
        }
        assert!(supports(Engine::Codex, Mode::Ask).unwrap_err().contains("read-only commands"));
        assert!(supports(Engine::ClaudeCode, Mode::Plan).is_ok());
        for e in Engine::ALL {
            let c = capabilities(e);
            for m in [Mode::Ask, Mode::Plan, Mode::Agent] {
                assert!(c.modes.contains(&m) || c.unsupported.iter().any(|(x, _)| *x == m), "{e:?} {m:?} needs a reason");
            }
        }
    }

    #[test]
    fn probes_round_trip_through_the_cache() {
        let db = Db::open_in_memory().unwrap();
        assert!(load_probe(&db, Engine::Codex).is_none());
        let mut p = EngineProbe::new(Engine::Codex, ProbeState::Ready, None);
        p.version = Some("0.164.0".into());
        save_probe(&db, &p).unwrap();
        assert_eq!(load_probe(&db, Engine::Codex).unwrap().version.as_deref(), Some("0.164.0"));
    }
}
