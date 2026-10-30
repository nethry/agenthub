//! OpenAI Responses API (`POST /v1/responses`, `stream: true`). History is
//! sent in full on every request from local storage (`store: false`), so no
//! conversation state lives on OpenAI's side.

use serde_json::{json, Value};

use super::{clip, malformed, server_error, Outcome, Request, StreamEvent, Usage, SYSTEM_PROMPT};
use crate::chat::sse::SseEvent;
use crate::chat::{ChatError, ErrorKind, Provider};

pub fn body(req: &Request) -> Value {
    let input: Vec<Value> = req
        .turns
        .iter()
        .map(|t| {
            if t.images.is_empty() {
                return json!({ "role": t.role.as_str(), "content": t.content });
            }
            let mut content: Vec<Value> = t.images.iter().map(|i| json!({ "type": "input_image", "image_url": i.data_url() })).collect();
            content.push(json!({ "type": "input_text", "text": t.content }));
            json!({ "role": t.role.as_str(), "content": content })
        })
        .collect();
    json!({
        "model": req.model,
        "instructions": SYSTEM_PROMPT,
        "input": input,
        "stream": true,
        "store": false,
    })
}

pub fn build(client: &reqwest::Client, base: &str, key: &str, req: &Request) -> reqwest::RequestBuilder {
    client
        .post(format!("{base}/v1/responses"))
        .bearer_auth(key)
        .header("content-type", "application/json")
        .header("accept", "text/event-stream")
        .body(body(req).to_string())
}

pub fn build_test(client: &reqwest::Client, base: &str, key: &str, model: &str) -> reqwest::RequestBuilder {
    client.get(format!("{base}/v1/models/{}", urlencode(model))).bearer_auth(key)
}

pub(crate) fn urlencode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

pub fn parse(ev: &SseEvent) -> Vec<StreamEvent> {
    let mut out = Vec::new();
    if let Some(usage) = usage_of(ev) {
        out.push(StreamEvent::Usage(usage));
    }
    out.extend(parse_one(ev));
    out
}

/// `response.completed` / `response.incomplete` carry `response.usage`.
fn usage_of(ev: &SseEvent) -> Option<Usage> {
    let v = serde_json::from_str::<Value>(&ev.data).ok()?;
    let u = v["response"]["usage"].as_object()?;
    Some(Usage {
        input_tokens: u.get("input_tokens").and_then(Value::as_u64),
        output_tokens: u.get("output_tokens").and_then(Value::as_u64),
        cost_usd: None,
    })
}

fn parse_one(ev: &SseEvent) -> Option<StreamEvent> {
    if ev.data.trim() == "[DONE]" {
        return None;
    }
    let Ok(v) = serde_json::from_str::<Value>(&ev.data) else {
        return Some(malformed("invalid JSON event"));
    };
    let kind = v["type"].as_str().unwrap_or(ev.event.as_str());
    match kind {
        "response.output_text.delta" | "response.refusal.delta" => match v["delta"].as_str() {
            Some(d) if !d.is_empty() => Some(StreamEvent::Delta(d.to_string())),
            Some(_) => None,
            None => Some(malformed("text delta without text")),
        },
        "response.completed" => Some(StreamEvent::Done(Outcome::Complete)),
        "response.incomplete" => {
            let reason = v["response"]["incomplete_details"]["reason"].as_str().unwrap_or("unknown");
            Some(StreamEvent::Done(match reason {
                "content_filter" => Outcome::Refused("OpenAI's content filter stopped this answer.".into()),
                "max_output_tokens" => Outcome::Truncated("The answer reached the model's output limit.".into()),
                other => Outcome::Truncated(format!("OpenAI ended the answer early ({other}).")),
            }))
        }
        "response.failed" => {
            let e = &v["response"]["error"];
            Some(StreamEvent::Error(stream_error(e["code"].as_str(), e["message"].as_str())))
        }
        "error" => Some(StreamEvent::Error(stream_error(v["code"].as_str(), v["message"].as_str()))),
        _ => None,
    }
}

fn stream_error(code: Option<&str>, message: Option<&str>) -> ChatError {
    let detail = clip(message.unwrap_or(""));
    match code.unwrap_or("") {
        "rate_limit_exceeded" => ChatError::new(ErrorKind::RateLimited, "OpenAI rate limit reached. Wait a moment, then retry."),
        "insufficient_quota" => credits(),
        "context_length_exceeded" => context(),
        "server_error" | "" if detail.is_empty() => server_error(Provider::OpenAI, 500, ""),
        code => ChatError::new(
            ErrorKind::ProviderError,
            if detail.is_empty() { format!("OpenAI couldn't finish the answer ({code}).") } else { format!("OpenAI couldn't finish the answer: {detail}") },
        ),
    }
}

fn credits() -> ChatError {
    ChatError::new(
        ErrorKind::InsufficientCredits,
        "Your OpenAI account is out of credits or over its quota. Check billing on platform.openai.com.",
    )
}

fn context() -> ChatError {
    ChatError::new(
        ErrorKind::ContextTooLong,
        "This conversation is longer than the model's context window. Start a new chat or pick a model with a larger window.",
    )
}

pub fn map_http_error(status: u16, body: &str, model: &str) -> ChatError {
    let v: Value = serde_json::from_str(body).unwrap_or(Value::Null);
    let code = v["error"]["code"].as_str().unwrap_or("");
    let detail = v["error"]["message"].as_str().unwrap_or("");
    match status {
        401 => ChatError::new(
            ErrorKind::InvalidKey,
            "OpenAI rejected the API key (401). Update it in Settings › AI providers.",
        ),
        404 => model_unavailable(model),
        403 if code == "model_not_found" || detail.contains("model") => model_unavailable(model),
        403 => ChatError::new(
            ErrorKind::PermissionDenied,
            format!("This OpenAI key isn't allowed to make this request (403). {}", clip(detail)).trim_end().to_string(),
        ),
        429 if code == "insufficient_quota" => credits(),
        429 => ChatError::new(ErrorKind::RateLimited, "OpenAI rate limit reached (429). Wait a moment, then retry."),
        400 if code == "context_length_exceeded" => context(),
        400 if code == "model_not_found" => model_unavailable(model),
        413 => context(),
        400..=499 => ChatError::new(
            ErrorKind::InvalidRequest,
            format!("OpenAI refused the request ({status}): {}", if detail.is_empty() { "no details given".into() } else { clip(detail) }),
        ),
        _ => server_error(Provider::OpenAI, status, detail),
    }
}

fn model_unavailable(model: &str) -> ChatError {
    ChatError::new(
        ErrorKind::ModelUnavailable,
        format!("The model “{model}” isn't available to this OpenAI key. Pick another model."),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat::providers::Turn;
    use crate::chat::Role;

    fn ev(data: &str) -> SseEvent {
        SseEvent { event: String::new(), data: data.into() }
    }

    #[test]
    fn builds_a_tool_free_streaming_body() {
        let turns = vec![
            Turn { role: Role::User, content: "Hi".into(), images: vec![] },
            Turn { role: Role::Assistant, content: "Hello!".into(), images: vec![] },
            Turn { role: Role::User, content: "And?".into(), images: vec![] },
        ];
        let b = body(&Request { model: "gpt-6.1-sol", turns: &turns, max_tokens: 100 });
        assert_eq!(b["model"], "gpt-6.1-sol");
        assert_eq!(b["stream"], true);
        assert_eq!(b["store"], false);
        assert_eq!(b["input"][1]["role"], "assistant");
        assert_eq!(b["input"][2]["content"], "And?");
        assert!(b.get("tools").is_none());
        assert!(b.get("previous_response_id").is_none());
    }

    #[test]
    fn parses_stream_events() {
        assert_eq!(
            parse_one(&ev(r#"{"type":"response.output_text.delta","delta":"Hel","item_id":"i","output_index":0,"content_index":0,"sequence_number":3}"#)),
            Some(StreamEvent::Delta("Hel".into()))
        );
        assert_eq!(parse_one(&ev(r#"{"type":"response.created","response":{}}"#)), None);
        assert_eq!(parse_one(&ev(r#"{"type":"response.reasoning_summary_text.delta","delta":"secret"}"#)), None);
        assert_eq!(parse_one(&ev(r#"{"type":"response.completed","response":{}}"#)), Some(StreamEvent::Done(Outcome::Complete)));
        assert!(matches!(
            parse_one(&ev(r#"{"type":"response.incomplete","response":{"incomplete_details":{"reason":"max_output_tokens"}}}"#)),
            Some(StreamEvent::Done(Outcome::Truncated(_)))
        ));
        match parse_one(&ev(r#"{"type":"response.failed","response":{"error":{"code":"rate_limit_exceeded","message":"slow down"}}}"#)) {
            Some(StreamEvent::Error(e)) => assert_eq!(e.kind, ErrorKind::RateLimited),
            other => panic!("{other:?}"),
        }
        match parse_one(&ev(r#"{"type":"error","code":"server_error","message":"boom","param":null}"#)) {
            Some(StreamEvent::Error(e)) => assert_eq!(e.kind, ErrorKind::ProviderError),
            other => panic!("{other:?}"),
        }
        match parse_one(&ev("{not json")) {
            Some(StreamEvent::Error(e)) => assert_eq!(e.kind, ErrorKind::Malformed),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn maps_http_errors() {
        let k = |status, body: &str| map_http_error(status, body, "gpt-x").kind;
        assert_eq!(k(401, r#"{"error":{"message":"Incorrect API key provided: sk-proj-****abcd","code":"invalid_api_key"}}"#), ErrorKind::InvalidKey);
        assert_eq!(k(429, r#"{"error":{"code":"insufficient_quota","message":"quota"}}"#), ErrorKind::InsufficientCredits);
        assert_eq!(k(429, r#"{"error":{"code":"rate_limit_exceeded"}}"#), ErrorKind::RateLimited);
        assert_eq!(k(404, r#"{"error":{"code":"model_not_found"}}"#), ErrorKind::ModelUnavailable);
        assert_eq!(k(400, r#"{"error":{"code":"context_length_exceeded"}}"#), ErrorKind::ContextTooLong);
        assert_eq!(k(400, "garbage"), ErrorKind::InvalidRequest);
        assert_eq!(k(503, ""), ErrorKind::Overloaded);
        assert_eq!(k(500, ""), ErrorKind::ProviderError);
        // The 401 message is ours; provider text with key fragments never reaches it.
        assert!(!map_http_error(401, r#"{"error":{"message":"sk-proj-secretsecret"}}"#, "m").message.contains("secret"));
        assert!(!map_http_error(400, r#"{"error":{"message":"bad key sk-proj-secretsecret"}}"#, "m").message.contains("secret"));
    }
}
