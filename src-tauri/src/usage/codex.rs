//! Reads OpenAI usage limits through `codex app-server`: a short-lived
//! JSON-RPC session over stdio (`initialize` → `initialized` →
//! `account/rateLimits/read`). Codex uses its own sign-in; AgentHub never
//! sees a token.

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use super::LimitWindow;

/// The app-server can take a while to start on a cold disk.
const STEP_TIMEOUT: Duration = Duration::from_secs(45);

#[derive(Debug, PartialEq)]
pub struct CodexLimits {
    pub session: Option<LimitWindow>,
    pub weekly: Option<LimitWindow>,
    pub plan: Option<String>,
}

/// Find a Codex executable: the path set in Settings, then `PATH`, then the
/// Codex desktop app's bundled CLI.
pub fn locate(override_path: Option<&Path>) -> Option<PathBuf> {
    if let Some(p) = override_path.filter(|p| p.is_file()).map(Path::to_path_buf) {
        return Some(p);
    }
    if let Some(p) = crate::terminals::shells::resolve_executable("codex") {
        return Some(p);
    }
    desktop_bundle()
}

#[cfg(windows)]
fn desktop_bundle() -> Option<PathBuf> {
    let base = PathBuf::from(std::env::var_os("LOCALAPPDATA")?).join("OpenAI").join("Codex").join("bin");
    std::fs::read_dir(base)
        .ok()?
        .flatten()
        .map(|e| e.path().join("codex.exe"))
        .filter(|p| p.is_file())
        .max_by_key(|p| std::fs::metadata(p).and_then(|m| m.modified()).ok())
}

#[cfg(not(windows))]
fn desktop_bundle() -> Option<PathBuf> {
    None
}

pub fn fetch(exe: &Path) -> Result<CodexLimits, String> {
    let mut cmd = Command::new(exe);
    cmd.arg("app-server")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = cmd.spawn().map_err(|e| format!("Couldn't start Codex: {e}"))?;
    let mut stdin = child.stdin.take().ok_or("Codex has no stdin")?;
    let stdout = child.stdout.take().ok_or("Codex has no stdout")?;

    let (tx, rx) = mpsc::channel::<Value>();
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            if let Ok(v) = serde_json::from_str::<Value>(&line) {
                if tx.send(v).is_err() {
                    break;
                }
            }
        }
    });

    let result = (|| {
        let mut send = |v: Value| -> Result<(), String> {
            writeln!(stdin, "{v}").and_then(|_| stdin.flush()).map_err(|e| format!("Codex closed its input: {e}"))
        };
        send(json!({
            "id": 0,
            "method": "initialize",
            "params": { "clientInfo": { "name": "agenthub", "title": "AgentHub", "version": env!("CARGO_PKG_VERSION") } }
        }))?;
        wait_for(&rx, 0)?;
        send(json!({ "method": "initialized" }))?;
        send(json!({ "id": 1, "method": "account/rateLimits/read" }))?;
        parse(&wait_for(&rx, 1)?)
    })();
    let _ = child.kill();
    let _ = child.wait();
    result
}

/// The `result` of the response with `id`; notifications are skipped.
fn wait_for(rx: &mpsc::Receiver<Value>, id: i64) -> Result<Value, String> {
    let deadline = Instant::now() + STEP_TIMEOUT;
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        let msg = rx
            .recv_timeout(left)
            .map_err(|_| "Codex didn't answer in time.".to_string())?;
        if msg.get("id").and_then(Value::as_i64) != Some(id) {
            continue;
        }
        if let Some(err) = msg.get("error") {
            let text = err.get("message").and_then(Value::as_str).unwrap_or("unknown error");
            return Err(format!("Codex: {text}"));
        }
        return Ok(msg.get("result").cloned().unwrap_or(Value::Null));
    }
}

fn window(v: &Value) -> Option<LimitWindow> {
    let used = v.get("usedPercent").and_then(Value::as_f64)?;
    Some(LimitWindow {
        used_percent: used,
        resets_at: v.get("resetsAt").and_then(Value::as_i64).map(|s| s * 1000),
        window_mins: v.get("windowDurationMins").and_then(Value::as_u64).map(|m| m as u32),
    })
}

/// Map `rateLimits.primary` / `secondary` to session / weekly by window length.
pub fn parse(result: &Value) -> Result<CodexLimits, String> {
    let limits = result
        .get("rateLimits")
        .filter(|v| !v.is_null())
        .ok_or("Codex returned no rate limits. Sign in to Codex with a ChatGPT plan.")?;
    let mut session = None;
    let mut weekly = None;
    for w in [limits.get("primary"), limits.get("secondary")].into_iter().flatten().filter_map(window) {
        // 5-hour style windows are short; weekly ones are days long.
        if w.window_mins.is_some_and(|m| m >= 24 * 60) {
            weekly = weekly.or(Some(w));
        } else {
            session = session.or(Some(w));
        }
    }
    Ok(CodexLimits {
        session,
        weekly,
        plan: limits.get("planType").and_then(Value::as_str).map(str::to_string),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_an_app_server_reply() {
        // Shape of a real `account/rateLimits/read` result (identifiers removed).
        let result = json!({
            "ordinaryUsageAllowed": true,
            "rateLimits": {
                "limitId": "codex",
                "primary": { "usedPercent": 24, "windowDurationMins": 300, "resetsAt": 1792889420 },
                "secondary": { "usedPercent": 81.5, "windowDurationMins": 10080, "resetsAt": 1793476220 },
                "credits": { "hasCredits": false, "unlimited": false, "balance": "0" },
                "planType": "plus",
                "rateLimitReachedType": null
            }
        });
        let r = parse(&result).unwrap();
        assert_eq!(
            r.session,
            Some(LimitWindow { used_percent: 24.0, resets_at: Some(1_792_889_420_000), window_mins: Some(300) })
        );
        assert_eq!(r.weekly.unwrap().used_percent, 81.5);
        assert_eq!(r.plan.as_deref(), Some("plus"));
    }

    /// Talks to the real Codex (network, sign-in): `cargo test -- --ignored codex_live`.
    #[test]
    #[ignore]
    fn codex_live() {
        let exe = locate(None).expect("Codex CLI not found");
        let r = fetch(&exe).unwrap();
        assert!(r.session.is_some() && r.weekly.is_some(), "{r:?}");
        println!("session {:?}\nweekly {:?}\nplan {:?}", r.session, r.weekly, r.plan);
    }

    #[test]
    fn orders_windows_by_length_and_reports_missing_limits() {
        let swapped = json!({ "rateLimits": {
            "primary": { "usedPercent": 5, "windowDurationMins": 10080 },
            "secondary": { "usedPercent": 50, "windowDurationMins": 300 }
        }});
        let r = parse(&swapped).unwrap();
        assert_eq!(r.session.unwrap().used_percent, 50.0);
        assert_eq!(r.weekly.unwrap().used_percent, 5.0);
        assert!(parse(&json!({ "rateLimits": null })).is_err());
    }
}
