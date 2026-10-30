//! Anthropic Messages API (`POST /v1/messages`, `stream: true`), API version
//! 2026-10-21. Text arrives as `content_block_delta` / `text_delta`; thinking
//! blocks (if a model emits any) are skipped and never stored.

use serde_json::{json, Value};

use super::openai::urlencode;
use super::{clip, malformed, server_error, Outcome, ParseState, Request, StreamEvent, Usage, SYSTEM_PROMPT};
use crate::chat::sse::SseEvent;
use crate::chat::{ChatError, ErrorKind, Provider};

pub const API_VERSION: &str = "2026-10-21";
/// Server-side fallback on a safety decline (`fallbacks: "default"`).
const FALLBACK_BETA: &str = "server-side-fallback-2026-07-01";
/// Models that accept `fallbacks: "default"`; others would reject it.
const FALLBACK_MODELS: &[&str] = &["claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"];

pub const MIN_MAX_TOKENS: u32 = 256;
pub const MAX_MAX_TOKENS: u32 = 128_000;
pub const DEFAULT_MAX_TOKENS: u32 = 64_000;

fn uses_fallback(model: &str) -> bool {
    FALLBACK_MODELS.contains(&model)
}

pub fn body(req: &Request) -> Value {
    let messages: Vec<Value> = req
        .turns
        .iter()
        .map(|t| {
            if t.images.is_empty() {
                return json!({ "role": t.role.as_str(), "content": t.content });
            }
            let mut content: Vec<Value> = t
                .images
                .iter()
                .map(|i| json!({ "type": "image", "source": { "type": "base64", "media_type": i.mime, "data": i.data } }))
                .collect();
            content.push(json!({ "type": "text", "text": t.content }));
            json!({ "role": t.role.as_str(), "content": content })
        })
        .collect();
    let mut body = json!({
        "model": req.model,
        "max_tokens": req.max_tokens.clamp(MIN_MAX_TOKENS, MAX_MAX_TOKENS),
        "system": SYSTEM_PROMPT,
        "messages": messages,
        "stream": true,
    });
    if uses_fallback(req.model) {
        body["fallbacks"] = json!("default");
    }
    body
}

pub fn build(client: &reqwest::Client, base: &str, key: &str, req: &Request) -> reqwest::RequestBuilder {
    let mut builder = client
        .post(format!("{base}/v1/messages"))
        .header("x-api-key", key)
        .header("anthropic-version", API_VERSION)
        .header("content-type", "application/json")
        .header("accept", "text/event-stream");
    if uses_fallback(req.model) {
        builder = builder.header("anthropic-beta", FALLBACK_BETA);
    }
    builder.body(body(req).to_string())
}

pub fn build_test(client: &reqwest::Client, base: &str, key: &str, model: &str) -> reqwest::RequestBuilder {
    client
        .get(format!("{base}/v1/models/{}", urlencode(model)))
        .header("x-api-key", key)
        .header("anthropic-version", API_VERSION)
}

pub fn parse(ev: &SseEvent, state: &mut ParseState) -> Vec<StreamEvent> {
    let mut out = Vec::new();
    if let Some(usage) = usage_of(ev) {
        out.push(StreamEvent::Usage(usage));
    }
    out.extend(parse_one(ev, state));
    out
}

/// Input tokens come in `message_start`, output tokens in `message_delta`.
fn usage_of(ev: &SseEvent) -> Option<Usage> {
    let v = serde_json::from_str::<Value>(&ev.data).ok()?;
    let u = match v["type"].as_str()? {
        "message_start" => v["message"]["usage"].as_object()?,
        "message_delta" => v["usage"].as_object()?,
        _ => return None,
    };
    let input = u.get("input_tokens").and_then(Value::as_u64).map(|n| {
        n + u.get("cache_read_input_tokens").and_then(Value::as_u64).unwrap_or(0)
            + u.get("cache_creation_input_tokens").and_then(Value::as_u64).unwrap_or(0)
    });
    Some(Usage { input_tokens: input, output_tokens: u.get("output_tokens").and_then(Value::as_u64), cost_usd: None })
}

fn parse_one(ev: &SseEvent, state: &mut ParseState) -> Option<StreamEvent> {
    let Ok(v) = serde_json::from_str::<Value>(&ev.data) else {
        return Some(malformed("invalid JSON event"));
    };
    let kind = v["type"].as_str().unwrap_or(ev.event.as_str());
    match kind {
        "content_block_delta" => match v["delta"]["type"].as_str() {
            Some("text_delta") => match v["delta"]["text"].as_str() {
                Some("") => None,
                Some(t) => Some(StreamEvent::Delta(t.to_string())),
                None => Some(malformed("text delta without text")),
            },
            _ => None, // thinking, signatures, citations: not shown, not stored
        },
        "message_delta" => {
            if let Some(reason) = v["delta"]["stop_reason"].as_str() {
                state.stop_reason = Some(reason.to_string());
            }
            None
        }
        "message_stop" => Some(StreamEvent::Done(match state.stop_reason.as_deref() {
            Some("max_tokens") => Outcome::Truncated(
                "The answer reached the output limit (max tokens). Raise it in Settings › AI providers.".into(),
            ),
            Some("refusal") => Outcome::Refused("Claude declined to answer this request.".into()),
            Some("model_context_window_exceeded") => {
                Outcome::Truncated("The answer stopped at the model's context window.".into())
            }
            _ => Outcome::Complete,
        })),
        "error" => {
            let e = &v["error"];
            Some(StreamEvent::Error(stream_error(e["type"].as_str(), e["message"].as_str())))
        }
        _ => None, // message_start, content_block_start/stop, ping
    }
}

fn stream_error(kind: Option<&str>, message: Option<&str>) -> ChatError {
    let detail = message.unwrap_or("");
    match kind.unwrap_or("") {
        "overloaded_error" => server_error(Provider::Anthropic, 529, ""),
        "rate_limit_error" => ChatError::new(ErrorKind::RateLimited, "Anthropic rate limit reached. Wait a moment, then retry."),
        "api_error" => server_error(Provider::Anthropic, 500, detail),
        _ => ChatError::new(
            ErrorKind::ProviderError,
            format!("Anthropic couldn't finish the answer. {}", clip(detail)).trim_end().to_string(),
        ),
    }
}

pub fn map_http_error(status: u16, body: &str, model: &str) -> ChatError {
    let v: Value = serde_json::from_str(body).unwrap_or(Value::Null);
    let detail = v["error"]["message"].as_str().unwrap_or("");
    let lower = detail.to_ascii_lowercase();
    match status {
        401 => ChatError::new(
            ErrorKind::InvalidKey,
            "Anthropic rejected the API key (401). Update it in Settings › AI providers.",
        ),
        402 => credits(),
        400 if lower.contains("credit balance") => credits(),
        400 if lower.contains("prompt is too long") || lower.contains("context window") => context(),
        403 => ChatError::new(
            ErrorKind::PermissionDenied,
            format!("This Anthropic key isn't allowed to make this request (403). {}", clip(detail)).trim_end().to_string(),
        ),
        404 => ChatError::new(
            ErrorKind::ModelUnavailable,
            format!("The model “{model}” isn't available to this Anthropic key. Pick another model."),
        ),
        413 => context(),
        429 => ChatError::new(ErrorKind::RateLimited, "Anthropic rate limit reached (429). Wait a moment, then retry."),
        400..=499 => ChatError::new(
            ErrorKind::InvalidRequest,
            format!("Anthropic refused the request ({status}): {}", if detail.is_empty() { "no details given".into() } else { clip(detail) }),
        ),
        _ => server_error(Provider::Anthropic, status, detail),
    }
}

fn credits() -> ChatError {
    ChatError::new(
        ErrorKind::InsufficientCredits,
        "Your Anthropic credit balance is too low. Add credits in the Claude Console (Plans & Billing).",
    )
}

fn context() -> ChatError {
    ChatError::new(
        ErrorKind::ContextTooLong,
        "This conversation is longer than the model's context window. Start a new chat.",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat::providers::Turn;
    use crate::chat::sse::SseParser;
    use crate::chat::Role;

    #[test]
    fn builds_a_tool_free_streaming_body() {
        let turns = vec![Turn { role: Role::User, content: "Hi".into(), images: vec![] }];
        let b = body(&Request { model: "claude-opus-5-5", turns: &turns, max_tokens: 999_999 });
        assert_eq!(b["stream"], true);
        assert_eq!(b["max_tokens"], MAX_MAX_TOKENS);
        assert_eq!(b["messages"][0]["role"], "user");
        assert_eq!(b["fallbacks"], "default");
        assert!(b.get("tools").is_none());
        assert!(b.get("temperature").is_none(), "sampling params are rejected on {API_VERSION}");
        // Models without server-side fallback don't get the parameter.
        let b = body(&Request { model: "claude-haiku-5-5", turns: &turns, max_tokens: 10 });
        assert!(b.get("fallbacks").is_none());
        assert_eq!(b["max_tokens"], MIN_MAX_TOKENS);
    }

    #[test]
    fn sends_required_headers() {
        let client = reqwest::Client::new();
        let turns = vec![Turn { role: Role::User, content: "Hi".into(), images: vec![] }];
        let req = build(&client, "https://example.test", "sk-ant-test", &Request { model: "claude-opus-5-5", turns: &turns, max_tokens: 1000 })
            .build()
            .unwrap();
        assert_eq!(req.url().as_str(), "https://example.test/v1/messages");
        assert_eq!(req.headers()["x-api-key"], "sk-ant-test");
        assert_eq!(req.headers()["anthropic-version"], API_VERSION);
        assert_eq!(req.headers()["anthropic-beta"], FALLBACK_BETA);
    }

    #[test]
    fn parses_a_recorded_stream() {
        let raw = concat!(
            "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_1\",\"model\":\"claude-opus-5-5\",\"content\":[]}}\n\n",
            "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"thinking\",\"thinking\":\"\"}}\n\n",
            "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"thinking_delta\",\"thinking\":\"hidden\"}}\n\n",
            "event: ping\ndata: {\"type\":\"ping\"}\n\n",
            "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"text_delta\",\"text\":\"Hello\"}}\n\n",
            "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"text_delta\",\"text\":\" world\"}}\n\n",
            "event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":5}}\n\n",
            "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n",
        );
        let mut p = SseParser::new();
        let mut state = ParseState::default();
        let out: Vec<_> = p.feed(raw.as_bytes()).unwrap().iter().filter_map(|e| parse_one(e, &mut state)).collect();
        assert_eq!(
            out,
            vec![
                StreamEvent::Delta("Hello".into()),
                StreamEvent::Delta(" world".into()),
                StreamEvent::Done(Outcome::Complete)
            ]
        );
    }

    #[test]
    fn reports_usage_from_start_and_delta() {
        let ev = |d: &str| SseEvent { event: String::new(), data: d.into() };
        let mut s = ParseState::default();
        let mut usage = Usage::default();
        for e in [
            r#"{"type":"message_start","message":{"usage":{"input_tokens":10,"cache_read_input_tokens":5,"output_tokens":1}}}"#,
            r#"{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":42}}"#,
        ] {
            for out in parse(&ev(e), &mut s) {
                if let StreamEvent::Usage(u) = out {
                    usage.merge(u);
                }
            }
        }
        assert_eq!(usage, Usage { input_tokens: Some(15), output_tokens: Some(42), cost_usd: None });
    }

    #[test]
    fn reports_stop_reasons_and_errors() {
        let ev = |d: &str| SseEvent { event: String::new(), data: d.into() };
        let mut s = ParseState::default();
        parse_one(&ev(r#"{"type":"message_delta","delta":{"stop_reason":"max_tokens"}}"#), &mut s);
        assert!(matches!(parse_one(&ev(r#"{"type":"message_stop"}"#), &mut s), Some(StreamEvent::Done(Outcome::Truncated(_)))));
        let mut s = ParseState::default();
        parse_one(&ev(r#"{"type":"message_delta","delta":{"stop_reason":"refusal"}}"#), &mut s);
        assert!(matches!(parse_one(&ev(r#"{"type":"message_stop"}"#), &mut s), Some(StreamEvent::Done(Outcome::Refused(_)))));
        match parse_one(&ev(r#"{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}"#), &mut s) {
            Some(StreamEvent::Error(e)) => assert_eq!(e.kind, ErrorKind::Overloaded),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn maps_http_errors() {
        let k = |status, body: &str| map_http_error(status, body, "claude-x").kind;
        let err = |t: &str, m: &str| format!(r#"{{"type":"error","error":{{"type":"{t}","message":"{m}"}}}}"#);
        assert_eq!(k(401, &err("authentication_error", "invalid x-api-key")), ErrorKind::InvalidKey);
        assert_eq!(k(400, &err("invalid_request_error", "Your credit balance is too low to access the Anthropic API.")), ErrorKind::InsufficientCredits);
        assert_eq!(k(402, &err("billing_error", "billing")), ErrorKind::InsufficientCredits);
        assert_eq!(k(404, &err("not_found_error", "model: claude-x")), ErrorKind::ModelUnavailable);
        assert_eq!(k(400, &err("invalid_request_error", "prompt is too long: 1200000 tokens > 1000000 maximum")), ErrorKind::ContextTooLong);
        assert_eq!(k(429, &err("rate_limit_error", "slow")), ErrorKind::RateLimited);
        assert_eq!(k(529, &err("overloaded_error", "Overloaded")), ErrorKind::Overloaded);
        assert_eq!(k(500, &err("api_error", "oops")), ErrorKind::ProviderError);
    }
}
