//! Update commands. Check and download run in Rust; installing ends the app on
//! Windows, so it first closes terminals and chat turns, and the UI only calls
//! it after the user confirmed a restart.

use tauri::ipc::Channel;
use tauri::{AppHandle, State};

use crate::error::AppResult;
use crate::updates::{UpdateInfo, UpdateProgress};
use crate::AppState;

/// A newer version, or `None` when up to date.
#[tauri::command]
pub async fn update_check(app: AppHandle, state: State<'_, AppState>) -> AppResult<Option<UpdateInfo>> {
    state.updates.check(&app, &state.db).await
}

/// Downloads and verifies the announced update; doesn't install it.
#[tauri::command]
pub async fn update_download(state: State<'_, AppState>, on_progress: Channel<UpdateProgress>) -> AppResult<UpdateInfo> {
    state.updates.download(on_progress).await
}

/// The update already downloaded and waiting for a restart, if any.
#[tauri::command]
pub fn update_downloaded(state: State<'_, AppState>) -> Option<UpdateInfo> {
    state.updates.downloaded()
}

/// Ends terminals and chat turns, then runs the installer (the app closes and the new version starts).
#[tauri::command]
pub fn update_install(state: State<'_, AppState>) -> AppResult<()> {
    // Fail before ending anything when there's nothing downloaded.
    if state.updates.downloaded().is_none() {
        return state.updates.install();
    }
    state.terminals.close_all();
    state.chat.shutdown();
    state.updates.install()
}
