//! Usage limits (5-hour session and weekly windows) for OpenAI Codex.
//! AgentHub never reads or stores credentials for this: `codex app-server`
//! answers `account/rateLimits/read` with Codex's own sign-in (see [`codex`]),
//! and a running Codex chat pushes `account/rateLimits/updated` as it goes.
//!
//! Claude Agent runs on an Anthropic API key, which has no subscription
//! windows; Gemini doesn't expose quota windows. Their token usage and
//! reported cost appear per message in Chat instead.

pub mod codex;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;

use parking_lot::Mutex;
use serde::Serialize;

use crate::error::now_ms;

#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LimitWindow {
    /// 0–100 (can exceed 100 once a limit is passed).
    pub used_percent: f64,
    /// Unix epoch milliseconds when the window resets.
    pub resets_at: Option<i64>,
    pub window_mins: Option<u32>,
}

#[derive(Debug, Serialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum UsageStatus {
    Ok,
    /// Not checked yet.
    NoData,
    /// The CLI couldn't be found.
    NotFound,
    Error,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProviderUsage {
    pub status: UsageStatus,
    pub message: Option<String>,
    pub session: Option<LimitWindow>,
    pub weekly: Option<LimitWindow>,
    /// When the numbers were taken (epoch ms).
    pub synced_at: Option<i64>,
    pub plan: Option<String>,
}

impl ProviderUsage {
    fn empty(status: UsageStatus, message: &str) -> Self {
        Self {
            status,
            message: Some(message.into()),
            session: None,
            weekly: None,
            synced_at: None,
            plan: None,
        }
    }
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UsageSnapshot {
    pub openai: ProviderUsage,
    /// A Codex request is in flight.
    pub refreshing: bool,
}

pub type UsageSink = Box<dyn Fn(&UsageSnapshot) + Send + Sync>;

pub struct Usage {
    snapshot: Mutex<UsageSnapshot>,
    sink: UsageSink,
    refreshing: AtomicBool,
}

impl Usage {
    pub fn new(sink: UsageSink) -> Arc<Self> {
        Arc::new(Self {
            snapshot: Mutex::new(UsageSnapshot {
                openai: ProviderUsage::empty(UsageStatus::NoData, "Not checked yet."),
                refreshing: false,
            }),
            sink,
            refreshing: AtomicBool::new(false),
        })
    }

    pub fn snapshot(&self) -> UsageSnapshot {
        self.snapshot.lock().clone()
    }

    fn emit(&self) {
        let snap = self.snapshot();
        (self.sink)(&snap);
    }

    /// A `rateLimits` value pushed by a running Codex session.
    pub fn update_openai(&self, rate_limits: &serde_json::Value) {
        let Ok(r) = codex::parse(&serde_json::json!({ "rateLimits": rate_limits })) else { return };
        self.snapshot.lock().openai = ProviderUsage {
            status: UsageStatus::Ok,
            message: None,
            session: r.session,
            weekly: r.weekly,
            synced_at: Some(now_ms()),
            plan: r.plan,
        };
        self.emit();
    }

    /// Ask Codex for fresh numbers in the background. No-op while one runs.
    pub fn refresh(self: &Arc<Self>, codex_exe: Option<PathBuf>) {
        let Some(exe) = codex_exe else {
            self.snapshot.lock().openai = ProviderUsage::empty(
                UsageStatus::NotFound,
                "Codex not found. Install it, or set its path in Settings › AI integrations.",
            );
            self.emit();
            return;
        };
        if self.refreshing.swap(true, Ordering::SeqCst) {
            return;
        }
        self.snapshot.lock().refreshing = true;
        self.emit();
        let usage = self.clone();
        thread::spawn(move || {
            let next = match codex::fetch(&exe) {
                Ok(r) => ProviderUsage {
                    status: UsageStatus::Ok,
                    message: None,
                    session: r.session,
                    weekly: r.weekly,
                    synced_at: Some(now_ms()),
                    plan: r.plan,
                },
                Err(message) => {
                    // Keep the last good numbers visible next to the error.
                    let prev = usage.snapshot.lock().openai.clone();
                    ProviderUsage { status: UsageStatus::Error, message: Some(message), ..prev }
                }
            };
            {
                let mut snap = usage.snapshot.lock();
                snap.openai = next;
                snap.refreshing = false;
            }
            usage.refreshing.store(false, Ordering::SeqCst);
            usage.emit();
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pushed_rate_limits_update_the_snapshot() {
        let seen = Arc::new(Mutex::new(0));
        let s = Arc::clone(&seen);
        let usage = Usage::new(Box::new(move |_| *s.lock() += 1));
        usage.update_openai(&serde_json::json!({ "primary": { "usedPercent": 40, "windowDurationMins": 300 } }));
        let snap = usage.snapshot();
        assert_eq!(snap.openai.status, UsageStatus::Ok);
        assert_eq!(snap.openai.session.unwrap().used_percent, 40.0);
        assert_eq!(*seen.lock(), 1);
    }
}
