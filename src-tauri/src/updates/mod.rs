//! App updates. The webview's CSP is closed to remote origins, so checking,
//! downloading and installing all happen here and the UI only calls our
//! commands. Nothing downloads or restarts on its own: a check only announces a
//! version; the user starts the download, and installing (which ends the app on
//! Windows) happens only when they confirm the restart. Updates are verified
//! against the public key in `tauri.conf.json` by the updater plugin.

use std::time::Duration;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::chat::redact;
use crate::error::{AppError, AppResult};
use crate::persistence::Db;

/// The user's choices (`updates` setting, written by the UI).
pub const PREFS_SETTING: &str = "updates";
/// When the last check ran (epoch ms). Written only here, so it can't be overwritten with the prefs.
pub const LAST_CHECK_SETTING: &str = "updates_last_check";
/// First check after launch, and the gaps between automatic checks.
pub const FIRST_CHECK_DELAY: Duration = Duration::from_secs(30);
pub const CHECK_EVERY: Duration = Duration::from_secs(24 * 60 * 60);
/// Restarting often must not hit the release host every time.
pub const MIN_GAP_MS: i64 = 12 * 60 * 60 * 1000;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub version: String,
    pub current_version: String,
    /// Release notes (untrusted text; the UI renders it without raw HTML).
    pub notes: Option<String>,
    pub date: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProgress {
    pub downloaded: u64,
    pub total: Option<u64>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct Prefs {
    auto_check: Option<bool>,
}

struct Found {
    update: Update,
    /// Set once downloaded and verified; installing is a separate, confirmed step.
    bytes: Option<Vec<u8>>,
}

#[derive(Default)]
pub struct Updates {
    found: Mutex<Option<Found>>,
}

/// The endpoint is a placeholder until the repository exists.
pub fn endpoints_configured(endpoints: &[String]) -> bool {
    !endpoints.is_empty() && endpoints.iter().all(|e| !e.contains("OWNER/REPO"))
}

/// Starts the automatic checks: one shortly after launch, then every day. A
/// found version is announced with the `update-available` event; failures are
/// silent (the user sees errors only from a manual check).
pub fn start_scheduler(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(FIRST_CHECK_DELAY).await;
        loop {
            if let Some(state) = app.try_state::<crate::AppState>() {
                if Updates::check_due(&state.db) {
                    if let Ok(Some(info)) = state.updates.check(&app, &state.db).await {
                        let _ = app.emit("update-available", info);
                    }
                }
            }
            tokio::time::sleep(CHECK_EVERY).await;
        }
    });
}

/// Whether the automatic check should run now.
pub fn due(auto_check: bool, last_check_ms: Option<i64>, now_ms: i64) -> bool {
    auto_check && last_check_ms.map_or(true, |t| now_ms - t >= MIN_GAP_MS || now_ms < t)
}

fn describe(e: impl std::fmt::Display) -> AppError {
    AppError::Invalid(redact(&format!("{e}"), None))
}

impl Updates {
    pub fn auto_check(db: &Db) -> bool {
        db.get_setting(PREFS_SETTING)
            .ok()
            .flatten()
            .and_then(|raw| serde_json::from_str::<Prefs>(&raw).ok())
            .and_then(|p| p.auto_check)
            .unwrap_or(true)
    }

    pub fn last_check(db: &Db) -> Option<i64> {
        db.get_setting(LAST_CHECK_SETTING).ok().flatten().and_then(|s| s.parse().ok())
    }

    fn remember_check(db: &Db) {
        let _ = db.set_setting(LAST_CHECK_SETTING, &crate::error::now_ms().to_string());
    }

    /// Whether an automatic check is due (`updates` pref on and not checked lately).
    pub fn check_due(db: &Db) -> bool {
        due(Self::auto_check(db), Self::last_check(db), crate::error::now_ms())
    }

    /// Asks the release host for a newer version; `None` when up to date.
    pub async fn check(&self, app: &AppHandle, db: &Db) -> AppResult<Option<UpdateInfo>> {
        let endpoints: Vec<String> = app
            .config()
            .plugins
            .0
            .get("updater")
            .and_then(|v| v.get("endpoints"))
            .and_then(|v| v.as_array())
            .map(|a| a.iter().filter_map(|e| e.as_str().map(str::to_string)).collect())
            .unwrap_or_default();
        if !endpoints_configured(&endpoints) {
            return Err(AppError::Invalid("Updates aren't set up yet: this build has no release address.".into()));
        }
        let updater = app.updater().map_err(describe)?;
        let result = updater.check().await;
        Self::remember_check(db);
        let update = result.map_err(|e| describe(format!("Couldn't check for updates: {e}")))?;
        let Some(update) = update else {
            *self.found.lock() = None;
            return Ok(None);
        };
        let info = UpdateInfo {
            version: update.version.clone(),
            current_version: update.current_version.clone(),
            notes: update.body.clone().map(|b| b.chars().take(20_000).collect()),
            date: update.date.map(|d| d.to_string()),
        };
        // Keep an already downloaded copy when the same version is announced again.
        let mut found = self.found.lock();
        let keep = found.as_ref().is_some_and(|f| f.update.version == update.version && f.bytes.is_some());
        if !keep {
            *found = Some(Found { update, bytes: None });
        }
        Ok(Some(info))
    }

    /// Downloads and verifies the announced update. Doesn't install it.
    pub async fn download(&self, on_progress: Channel<UpdateProgress>) -> AppResult<UpdateInfo> {
        let update = {
            let found = self.found.lock();
            let f = found.as_ref().ok_or_else(|| AppError::Invalid("There's no update to download. Check for updates first.".into()))?;
            if f.bytes.is_some() {
                return Ok(info_of(&f.update));
            }
            f.update.clone()
        };
        let mut downloaded = 0u64;
        let bytes = update
            .download(
                |chunk, total| {
                    downloaded += chunk as u64;
                    let _ = on_progress.send(UpdateProgress { downloaded, total });
                },
                || {},
            )
            .await
            .map_err(|e| describe(format!("Couldn't download the update: {e}")))?;
        let info = info_of(&update);
        if let Some(f) = self.found.lock().as_mut().filter(|f| f.update.version == update.version) {
            f.bytes = Some(bytes);
        }
        Ok(info)
    }

    pub fn downloaded(&self) -> Option<UpdateInfo> {
        self.found.lock().as_ref().filter(|f| f.bytes.is_some()).map(|f| info_of(&f.update))
    }

    /// Runs the installer. On Windows this ends the app, so the caller closes
    /// terminals and chat turns first (after the user confirmed).
    pub fn install(&self) -> AppResult<()> {
        let (update, bytes) = {
            let found = self.found.lock();
            let f = found.as_ref().ok_or_else(|| AppError::Invalid("There's no update to install.".into()))?;
            let bytes = f.bytes.clone().ok_or_else(|| AppError::Invalid("Download the update first.".into()))?;
            (f.update.clone(), bytes)
        };
        update.install(bytes).map_err(|e| describe(format!("Couldn't install the update: {e}")))
    }
}

fn info_of(u: &Update) -> UpdateInfo {
    UpdateInfo {
        version: u.version.clone(),
        current_version: u.current_version.clone(),
        notes: u.body.clone().map(|b| b.chars().take(20_000).collect()),
        date: u.date.map(|d| d.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn placeholder_endpoints_are_not_configured() {
        assert!(!endpoints_configured(&[]));
        assert!(!endpoints_configured(&["https://github.com/OWNER/REPO/releases/latest/download/latest.json".into()]));
        assert!(endpoints_configured(&["https://github.com/acme/agenthub/releases/latest/download/latest.json".into()]));
    }

    #[test]
    fn automatic_checks_wait_twelve_hours_and_respect_the_switch() {
        let h = 60 * 60 * 1000;
        let now = 100 * h;
        assert!(due(true, None, now), "never checked");
        assert!(!due(true, Some(now - 11 * h), now), "checked lately");
        assert!(due(true, Some(now - 12 * h), now));
        assert!(!due(false, None, now), "switched off");
        assert!(due(true, Some(now + h), now), "a clock set back doesn't block checks forever");
    }

    #[test]
    fn prefs_default_to_automatic_checks_and_remember_the_last_check() {
        let db = Db::open_in_memory().unwrap();
        assert!(Updates::auto_check(&db));
        db.set_setting(PREFS_SETTING, r#"{"autoCheck":false}"#).unwrap();
        assert!(!Updates::auto_check(&db));
        assert!(!Updates::check_due(&db));
        db.set_setting(PREFS_SETTING, r#"{"autoCheck":true,"skipped":"0.2.0"}"#).unwrap();
        assert!(Updates::check_due(&db));
        Updates::remember_check(&db);
        assert!(Updates::last_check(&db).is_some());
        assert!(!Updates::check_due(&db), "just checked");
    }
}
