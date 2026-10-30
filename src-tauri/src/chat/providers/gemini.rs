//! Google Gemini API (`POST /v1beta/models/{model}:streamGenerateContent?alt=sse`).
//! Each SSE event is a whole `GenerateContentResponse`; the stream has no end
//! marker, so the chunk carrying `finishReason` ends the answer. Thought parts
//! (`thought: true`) are skipped and never stored.

use serde_json::{json, Value};

use super::openai::urlencode;
use super::{clip, malformed, server_error, Outcome, Request, StreamEvent, Usage, SYSTEM_PROMPT};
use crate::chat::sse::SseEvent;
use crate::chat::{ChatError, ErrorKind, Provider, Role};

pub fn body(req: &Request) -> Value {
    let contents: Vec<Value> = req
        .turns
        .iter()
        .map(|t| {
            let role = if t.role == Role::User { "user" } else { "model" };
            let mut parts: Vec<Value> = t.images.iter().map(|i| json!({ "inlineData": { "mimeType": i.mime, "data": i.data } })).collect();
            parts.push(json!({ "text": t.content }));
            json!({ "role": role, "parts": parts })
        })
        .collect();
    json!({
        "systemInstruction": { "parts": [{ "text": SYSTEM_PROMPT }] },
        "contents": contents,
    })
}

pub fn build(client: &reqwest::Client, base: &str, key: &str, req: &Request) -> reqwest::RequestBuilder {
    client
        .post(format!("{base}/v1beta/models/{}:streamGenerateContent?alt=sse", urlencode(req.model)))
        .header("x-goog-api-key", key)
        .header("content-type", "application/json")
        .header("accept", "text/event-stream")
        .body(body(req).to_string())
}

pub fn build_test(client: &reqwest::Client, base: &str, key: &str, model: &str) -> reqwest::RequestBuilder {
    client
        .get(format!("{base}/v1beta/models/{}", urlencode(model)))
        .header("x-goog-api-key", key)
}

pub fn build_list(client: &reqwest::Client, base: &str, key: &str) -> reqwest::RequestBuilder {
    client.get(format!("{base}/v1beta/models?pageSize=1000")).header("x-goog-api-key", key)
}

/// Model ids from a `models.list` reply that can generate content.
pub fn parse_models(body: &str) -> Vec<String> {
    let v: Value = serde_json::from_str(body).unwrap_or(Value::Null);
    v["models"]
        .as_array()
        .map(|list| {
            list.iter()
                .filter(|m| {
                    m["supportedGenerationMethods"]
                        .as_array()
                        .is_some_and(|ms| ms.iter().any(|x| x == "generateContent"))
                })
                .filter_map(|m| m["name"].as_str())
                .map(|n| n.trim_start_matches("models/").to_string())
                .collect()
        })
        .unwrap_or_default()
}

pub fn parse(ev: &SseEvent) -> Vec<StreamEvent> {
    let Ok(v) = serde_json::from_str::<Value>(&ev.data) else {
        return vec![malformed("invalid JSON event")];
    };
    if v.get("error").is_some() {
        let e = &v["error"];
        return vec![StreamEvent::Error(stream_error(e["status"].as_str(), e["message"].as_str()))];
    }
    let mut out = Vec::new();
    if let Some(reason) = v["promptFeedback"]["blockReason"].as_str() {
        return vec![StreamEvent::Done(Outcome::Refused(format!("Gemini blocked this request ({reason}).")))];
    }
    let cand = &v["candidates"][0];
    if let Some(parts) = cand["content"]["parts"].as_array() {
        for p in parts {
            if p["thought"].as_bool() == Some(true) {
                continue;
            }
            if let Some(t) = p["text"].as_str().filter(|t| !t.is_empty()) {
                out.push(StreamEvent::Delta(t.to_string()));
            }
        }
    }
    let usage = &v["usageMetadata"];
    if usage.is_object() {
        out.push(StreamEvent::Usage(Usage {
            input_tokens: usage["promptTokenCount"].as_u64(),
            output_tokens: usage["candidatesTokenCount"].as_u64(),
            cost_usd: None,
        }));
    }
    if let Some(reason) = cand["finishReason"].as_str() {
        out.push(StreamEvent::Done(match reason {
            "STOP" | "FINISH_REASON_UNSPECIFIED" => Outcome::Complete,
            "MAX_TOKENS" => Outcome::Truncated("The answer reached the model's output limit.".into()),
            "SAFETY" | "RECITATION" | "PROHIBITED_CONTENT" | "BLOCKLIST" | "SPII" | "IMAGE_SAFETY" => {
                Outcome::Refused(format!("Gemini stopped this answer ({reason})."))
            }
            other => Outcome::Truncated(format!("Gemini ended the answer early ({other}).")),
        }));
    }
    out
}

fn stream_error(status: Option<&str>, message: Option<&str>) -> ChatError {
    let detail = clip(message.unwrap_or(""));
    match status.unwrap_or("") {
        "RESOURCE_EXHAUSTED" => ChatError::new(ErrorKind::RateLimited, "Gemini rate limit or quota reached. Wait a moment, then retry."),
        "UNAVAILABLE" => server_error(Provider::Gemini, 503, ""),
        _ => ChatError::new(
            ErrorKind::ProviderError,
            format!("Gemini couldn't finish the answer. {detail}").trim_end().to_string(),
        ),
    }
}

pub fn map_http_error(status: u16, body: &str, model: &str) -> ChatError {
    let v: Value = serde_json::from_str(body).unwrap_or(Value::Null);
    let detail = v["error"]["message"].as_str().unwrap_or("");
    let reason = v["error"]["details"]
        .as_array()
        .and_then(|d| d.iter().find_map(|x| x["reason"].as_str()))
        .unwrap_or("");
    let lower = detail.to_ascii_lowercase();
    match status {
        // Gemini answers 400 (not 401) for a bad key.
        400 if reason == "API_KEY_INVALID" || lower.contains("api key not valid") => invalid_key(),
        401 => invalid_key(),
        400 if lower.contains("token count") || lower.contains("exceeds the maximum") => ChatError::new(
            ErrorKind::ContextTooLong,
            "This conversation is longer than the model's context window. Start a new chat.",
        ),
        403 => ChatError::new(
            ErrorKind::PermissionDenied,
            format!("This Gemini key isn't allowed to make this request (403). {}", clip(detail)).trim_end().to_string(),
        ),
        404 => ChatError::new(
            ErrorKind::ModelUnavailable,
            format!("The model “{model}” isn't available to this Gemini key. Pick another model."),
        ),
        429 => ChatError::new(ErrorKind::RateLimited, "Gemini rate limit or quota reached (429). Wait a moment, then retry."),
        400..=499 => ChatError::new(
            ErrorKind::InvalidRequest,
            format!("Gemini refused the request ({status}): {}", if detail.is_empty() { "no details given".into() } else { clip(detail) }),
        ),
        _ => server_error(Provider::Gemini, status, detail),
    }
}

fn invalid_key() -> ChatError {
    ChatError::new(ErrorKind::InvalidKey, "Google rejected the Gemini API key. Update it in Settings › AI integrations.")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat::providers::Turn;
    use crate::chat::sse::SseParser;

    #[test]
    fn builds_a_tool_free_body_with_model_roles() {
        let turns = vec![
            Turn { role: Role::User, content: "Hi".into(), images: vec![] },
            Turn { role: Role::Assistant, content: "Hello".into(), images: vec![] },
            Turn { role: Role::User, content: "More".into(), images: vec![] },
        ];
        let b = body(&Request { model: "gemini-3.8-flash", turns: &turns, max_tokens: 0 });
        assert_eq!(b["contents"][1]["role"], "model");
        assert_eq!(b["contents"][2]["parts"][0]["text"], "More");
        assert!(b.get("tools").is_none());
        let client = reqwest::Client::new();
        let req = build(&client, "https://g.test", "AIza-test", &Request { model: "gemini-3.8-flash", turns: &turns, max_tokens: 0 })
            .build()
            .unwrap();
        assert_eq!(req.url().as_str(), "https://g.test/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse");
        assert_eq!(req.headers()["x-goog-api-key"], "AIza-test");
    }

    #[test]
    fn parses_a_recorded_stream_with_usage() {
        let raw = concat!(
            "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"plan\",\"thought\":true}],\"role\":\"model\"}}]}\r\n\r\n",
            "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"Hello\"}],\"role\":\"model\"}}]}\r\n\r\n",
            "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\" world\"}],\"role\":\"model\"},\"finishReason\":\"STOP\"}],\"usageMetadata\":{\"promptTokenCount\":7,\"candidatesTokenCount\":2,\"totalTokenCount\":9}}\r\n\r\n",
        );
        let mut p = SseParser::new();
        let out: Vec<_> = p.feed(raw.as_bytes()).unwrap().iter().flat_map(parse).collect();
        assert_eq!(
            out,
            vec![
                StreamEvent::Delta("Hello".into()),
                StreamEvent::Delta(" world".into()),
                StreamEvent::Usage(Usage { input_tokens: Some(7), output_tokens: Some(2), cost_usd: None }),
                StreamEvent::Done(Outcome::Complete),
            ]
        );
    }

    #[test]
    fn reports_blocks_and_stream_errors() {
        let ev = |d: &str| SseEvent { event: String::new(), data: d.into() };
        assert!(matches!(
            parse(&ev(r#"{"promptFeedback":{"blockReason":"SAFETY"}}"#))[..],
            [StreamEvent::Done(Outcome::Refused(_))]
        ));
        assert!(matches!(
            parse(&ev(r#"{"candidates":[{"finishReason":"MAX_TOKENS"}]}"#))[..],
            [StreamEvent::Done(Outcome::Truncated(_))]
        ));
        match &parse(&ev(r#"{"error":{"code":429,"status":"RESOURCE_EXHAUSTED","message":"quota"}}"#))[..] {
            [StreamEvent::Error(e)] => assert_eq!(e.kind, ErrorKind::RateLimited),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn maps_http_errors_including_400_for_bad_keys() {
        let bad_key = r#"{"error":{"code":400,"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT","details":[{"reason":"API_KEY_INVALID"}]}}"#;
        assert_eq!(map_http_error(400, bad_key, "m").kind, ErrorKind::InvalidKey);
        assert_eq!(map_http_error(404, "{}", "m").kind, ErrorKind::ModelUnavailable);
        assert_eq!(map_http_error(429, "{}", "m").kind, ErrorKind::RateLimited);
        assert_eq!(map_http_error(503, "{}", "m").kind, ErrorKind::Overloaded);
        assert_eq!(map_http_error(400, r#"{"error":{"message":"bad field"}}"#, "m").kind, ErrorKind::InvalidRequest);
    }

    #[test]
    fn lists_generating_models() {
        let body = r#"{"models":[{"name":"models/gemini-3.8-flash","supportedGenerationMethods":["generateContent","countTokens"]},{"name":"models/embedding-1","supportedGenerationMethods":["embedContent"]}]}"#;
        assert_eq!(parse_models(body), vec!["gemini-3.8-flash".to_string()]);
    }
}
