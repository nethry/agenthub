//! Provider adapters behind one normalized interface: build the streaming
//! request, turn SSE events into `StreamEvent`s, and map HTTP failures to a
//! `ChatError`. No request ever carries tools.

pub mod anthropic;
pub mod gemini;
pub mod openai;

use super::images::ImageInput;
use super::sse::SseEvent;
use super::{ChatError, ErrorKind, Provider, Role};

/// Prepended to every conversation. Chat has no tools, so it must not claim
/// to act; everything else is ordinary assistant behavior.
pub const SYSTEM_PROMPT: &str = "You are the chat assistant inside AgentHub, a desktop workspace for software developers. \
Answer questions, explain concepts, and write code snippets when they help. \
You have no tools: you can't run commands, read or change files, browse the web, or act on the user's behalf, so never say you did. \
Format answers in Markdown and put code in fenced blocks with a language tag.";

#[derive(Debug, Clone, PartialEq)]
pub struct Turn {
    pub role: Role,
    pub content: String,
    /// Pasted images of a user turn, sent before its text.
    pub images: Vec<ImageInput>,
}

/// Image types a provider accepts (Gemini takes no GIF).
pub fn takes_image(provider: Provider, mime: &str) -> bool {
    match provider {
        Provider::Gemini => matches!(mime, "image/png" | "image/jpeg" | "image/webp"),
        Provider::OpenAI | Provider::Anthropic => matches!(mime, "image/png" | "image/jpeg" | "image/gif" | "image/webp"),
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum Outcome {
    Complete,
    /// Hit the output limit (or another provider stop) mid-answer.
    Truncated(String),
    Refused(String),
}

/// Token counts (and cost, only when the provider reports one) for a reply.
#[derive(Debug, Clone, Copy, PartialEq, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    /// Reported by the provider; AgentHub never estimates prices.
    pub cost_usd: Option<f64>,
}

impl Usage {
    /// Later readings win field by field (Anthropic reports input and output separately).
    pub fn merge(&mut self, other: Usage) {
        self.input_tokens = other.input_tokens.or(self.input_tokens);
        self.output_tokens = other.output_tokens.or(self.output_tokens);
        self.cost_usd = other.cost_usd.or(self.cost_usd);
    }

    pub fn is_empty(&self) -> bool {
        self.input_tokens.is_none() && self.output_tokens.is_none() && self.cost_usd.is_none()
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum StreamEvent {
    Delta(String),
    Usage(Usage),
    Done(Outcome),
    Error(ChatError),
}

/// Everything needed for one streamed reply.
pub struct Request<'a> {
    pub model: &'a str,
    pub turns: &'a [Turn],
    /// Anthropic only (required there).
    pub max_tokens: u32,
}

#[derive(Default)]
pub struct ParseState {
    /// Anthropic reports the stop reason in `message_delta`, before `message_stop`.
    stop_reason: Option<String>,
}

pub fn default_base_url(provider: Provider) -> &'static str {
    match provider {
        Provider::OpenAI => "https://api.openai.com",
        Provider::Anthropic => "https://api.anthropic.com",
        Provider::Gemini => "https://generativelanguage.googleapis.com",
    }
}

pub fn build(provider: Provider, client: &reqwest::Client, base: &str, key: &str, req: &Request) -> reqwest::RequestBuilder {
    match provider {
        Provider::OpenAI => openai::build(client, base, key, req),
        Provider::Anthropic => anthropic::build(client, base, key, req),
        Provider::Gemini => gemini::build(client, base, key, req),
    }
}

/// An authenticated request that costs nothing: retrieve the model.
pub fn build_test(provider: Provider, client: &reqwest::Client, base: &str, key: &str, model: &str) -> reqwest::RequestBuilder {
    match provider {
        Provider::OpenAI => openai::build_test(client, base, key, model),
        Provider::Anthropic => anthropic::build_test(client, base, key, model),
        Provider::Gemini => gemini::build_test(client, base, key, model),
    }
}

pub fn parse(provider: Provider, ev: &SseEvent, state: &mut ParseState) -> Vec<StreamEvent> {
    match provider {
        Provider::OpenAI => openai::parse(ev),
        Provider::Anthropic => anthropic::parse(ev, state),
        Provider::Gemini => gemini::parse(ev),
    }
}

pub fn map_http_error(provider: Provider, status: u16, body: &str, retry_after: Option<u64>, model: &str) -> ChatError {
    let mut err = match provider {
        Provider::OpenAI => openai::map_http_error(status, body, model),
        Provider::Anthropic => anthropic::map_http_error(status, body, model),
        Provider::Gemini => gemini::map_http_error(status, body, model),
    };
    err.status = Some(status);
    if err.kind == ErrorKind::RateLimited {
        err.retry_after = retry_after;
    }
    err
}

/// Provider text in an error message, shortened and redacted.
pub(crate) fn clip(text: &str) -> String {
    let text = super::redact(text.trim(), None);
    if text.chars().count() <= 300 {
        return text;
    }
    let cut: String = text.chars().take(299).collect();
    format!("{cut}…")
}

pub(crate) fn malformed(what: &str) -> StreamEvent {
    StreamEvent::Error(ChatError::new(
        ErrorKind::Malformed,
        format!("The provider sent a response AgentHub couldn't read ({what})."),
    ))
}

pub(crate) fn server_error(provider: Provider, status: u16, detail: &str) -> ChatError {
    let kind = if status == 503 || status == 529 { ErrorKind::Overloaded } else { ErrorKind::ProviderError };
    let base = if kind == ErrorKind::Overloaded {
        format!("{} is overloaded right now ({status}). Try again in a moment.", provider.label())
    } else {
        format!("{} had a server error ({status}). Try again in a moment.", provider.label())
    };
    let detail = clip(detail);
    ChatError::new(kind, if detail.is_empty() { base } else { format!("{base} {detail}") })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pasted_images_go_before_the_text_in_each_providers_format() {
        let png = ImageInput { mime: "image/png".into(), data: "iVBORw0K".into() };
        let turns = vec![
            Turn { role: Role::User, content: "What's this?".into(), images: vec![png] },
            Turn { role: Role::Assistant, content: "A chart.".into(), images: vec![] },
        ];
        let req = Request { model: "m", turns: &turns, max_tokens: 1000 };

        let o = openai::body(&req);
        assert_eq!(o["input"][0]["content"][0], serde_json::json!({ "type": "input_image", "image_url": "data:image/png;base64,iVBORw0K" }));
        assert_eq!(o["input"][0]["content"][1], serde_json::json!({ "type": "input_text", "text": "What's this?" }));
        assert_eq!(o["input"][1]["content"], "A chart.", "turns without images stay plain text");

        let a = anthropic::body(&req);
        assert_eq!(
            a["messages"][0]["content"][0],
            serde_json::json!({ "type": "image", "source": { "type": "base64", "media_type": "image/png", "data": "iVBORw0K" } })
        );
        assert_eq!(a["messages"][0]["content"][1]["text"], "What's this?");

        let g = gemini::body(&req);
        assert_eq!(g["contents"][0]["parts"][0], serde_json::json!({ "inlineData": { "mimeType": "image/png", "data": "iVBORw0K" } }));
        assert_eq!(g["contents"][0]["parts"][1]["text"], "What's this?");

        assert!(!takes_image(Provider::Gemini, "image/gif"));
        assert!(takes_image(Provider::OpenAI, "image/gif"));
    }
}
