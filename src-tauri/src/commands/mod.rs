//! Tauri command handlers: thin wrappers that validate input and delegate.

pub mod git;
pub mod updates;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::{AppHandle, State};

use crate::chat::checkpoints::FileDiff;
use crate::chat::images::NewImage;
use crate::chat::engines::{EngineInfo, ModelInfo};
use crate::chat::repository::ChangedFile;
use crate::chat::service::{NewChat, ProviderStatus};
use crate::chat::{self, ChatEvent, ChatMessage, Conversation, Decision, Engine, Mode, Policy, Provider};
use crate::error::{AppError, AppResult};
use crate::filesystem::{self, DirEntry, FileContent, WriteResult};
use crate::presets::{self, Preset, PresetInput};
use crate::projects::{self, Project};
use crate::terminals::shells::{self, ShellProfile};
use crate::terminals::{LaunchSpec, SessionInfo};
use crate::usage::{self, UsageSnapshot};
use crate::AppState;

// ---------- projects ----------

#[tauri::command]
pub fn list_projects(state: State<'_, AppState>) -> AppResult<Vec<Project>> {
    projects::list(&state.db)
}

fn watch_project(state: &AppState, project: &Project) {
    if let Ok(root) = projects::root(&state.db, &project.id) {
        state.watchers.watch(&project.id, &root);
    }
}

#[tauri::command]
pub fn add_project(state: State<'_, AppState>, path: String, name: Option<String>) -> AppResult<Project> {
    let project = projects::add(&state.db, &path, name.as_deref())?;
    watch_project(&state, &project);
    Ok(project)
}

#[tauri::command]
pub fn create_project_folder(state: State<'_, AppState>, parent: String, name: String) -> AppResult<Project> {
    let project = projects::create_folder(&state.db, &parent, &name)?;
    watch_project(&state, &project);
    Ok(project)
}

#[tauri::command]
pub fn rename_project(state: State<'_, AppState>, id: String, name: String) -> AppResult<Project> {
    projects::rename(&state.db, &id, &name)
}

/// Forget a project and end its sessions. Never deletes anything on disk.
#[tauri::command]
pub fn remove_project(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.terminals.close_project(&id);
    state.watchers.unwatch(&id);
    state.git.forget(&id);
    projects::remove(&state.db, &id)
}

#[tauri::command]
pub fn touch_project(state: State<'_, AppState>, id: String) -> AppResult<()> {
    projects::touch(&state.db, &id)
}

#[tauri::command]
pub fn reorder_projects(state: State<'_, AppState>, ids: Vec<String>) -> AppResult<()> {
    projects::reorder(&state.db, &ids)
}

#[tauri::command]
pub fn get_workspace_state(state: State<'_, AppState>, project_id: String) -> AppResult<Option<serde_json::Value>> {
    projects::get_workspace_state(&state.db, &project_id)
}

#[tauri::command]
pub fn save_workspace_state(state: State<'_, AppState>, project_id: String, value: serde_json::Value) -> AppResult<()> {
    projects::save_workspace_state(&state.db, &project_id, &value)
}

// ---------- settings ----------

const SETTING_KEYS: &[&str] = &["default_shell", "ui", "editor", "terminal", "usage", "chat", "git", "updates"];

#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> AppResult<HashMap<String, String>> {
    Ok(state
        .db
        .all_settings()?
        .into_iter()
        .filter(|(k, _)| SETTING_KEYS.contains(&k.as_str()))
        .collect())
}

#[tauri::command]
pub fn set_setting(state: State<'_, AppState>, key: String, value: String) -> AppResult<()> {
    if !SETTING_KEYS.contains(&key.as_str()) {
        return Err(AppError::Invalid(format!("Unknown setting: {key}")));
    }
    if value.len() > 64 * 1024 {
        return Err(AppError::Invalid("Setting value is too large".into()));
    }
    state.db.set_setting(&key, &value)
}

// ---------- files ----------

#[tauri::command]
pub fn fs_list_dir(state: State<'_, AppState>, project_id: String, path: String) -> AppResult<Vec<DirEntry>> {
    let root = projects::root(&state.db, &project_id)?;
    filesystem::list_dir(&root, &path)
}

#[tauri::command]
pub async fn fs_index(state: State<'_, AppState>, project_id: String) -> AppResult<Vec<String>> {
    let root = projects::root(&state.db, &project_id)?;
    tauri::async_runtime::spawn_blocking(move || filesystem::index_files(&root))
        .await
        .map_err(|e| AppError::Invalid(e.to_string()))?
}

#[tauri::command]
pub fn fs_read_file(
    state: State<'_, AppState>,
    project_id: String,
    path: String,
    encoding: Option<String>,
) -> AppResult<FileContent> {
    let root = projects::root(&state.db, &project_id)?;
    filesystem::read_file(&root, &path, encoding.as_deref())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn fs_write_file(
    state: State<'_, AppState>,
    project_id: String,
    path: String,
    content: String,
    encoding: String,
    has_bom: bool,
    expected_mtime_ms: Option<i64>,
) -> AppResult<WriteResult> {
    let root = projects::root(&state.db, &project_id)?;
    filesystem::write_file(&root, &path, &content, &encoding, has_bom, expected_mtime_ms)
}

#[tauri::command]
pub fn fs_create(
    state: State<'_, AppState>,
    project_id: String,
    parent: String,
    name: String,
    is_dir: bool,
) -> AppResult<String> {
    let root = projects::root(&state.db, &project_id)?;
    filesystem::create_entry(&root, &parent, &name, is_dir)
}

#[tauri::command]
pub fn fs_rename(state: State<'_, AppState>, project_id: String, path: String, new_name: String) -> AppResult<String> {
    let root = projects::root(&state.db, &project_id)?;
    filesystem::rename_entry(&root, &path, &new_name)
}

/// Moves to the Recycle Bin; never deletes permanently.
#[tauri::command]
pub fn fs_delete(state: State<'_, AppState>, project_id: String, path: String) -> AppResult<()> {
    let root = projects::root(&state.db, &project_id)?;
    filesystem::delete_entry(&root, &path)
}

// ---------- presets & shells ----------

#[tauri::command]
pub fn list_presets(state: State<'_, AppState>) -> AppResult<Vec<Preset>> {
    presets::list(&state.db)
}

#[tauri::command]
pub fn save_preset(state: State<'_, AppState>, preset: PresetInput) -> AppResult<Preset> {
    presets::save(&state.db, preset)
}

#[tauri::command]
pub fn delete_preset(state: State<'_, AppState>, id: String) -> AppResult<()> {
    presets::delete(&state.db, &id)
}

#[tauri::command]
pub fn resolve_executable(executable: String) -> Option<String> {
    shells::resolve_executable(&executable).map(|p| p.to_string_lossy().to_string())
}

#[tauri::command]
pub fn list_shells(state: State<'_, AppState>, rescan: Option<bool>) -> Vec<ShellProfile> {
    if rescan.unwrap_or(false) {
        state.terminals.redetect_shells()
    } else {
        state.terminals.shells()
    }
}

// ---------- terminals ----------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnRequest {
    pub project_id: String,
    /// `shell`, `preset` or `custom`.
    pub kind: String,
    pub shell_id: Option<String>,
    pub preset_id: Option<String>,
    pub executable: Option<String>,
    pub args: Option<Vec<String>>,
    pub title: Option<String>,
    pub cols: u16,
    pub rows: u16,
}

fn default_shell(state: &AppState) -> String {
    let profiles = state.terminals.shells();
    state
        .db
        .get_setting("default_shell")
        .ok()
        .flatten()
        .filter(|id| shells::find(&profiles, id).is_some_and(|p| p.available))
        .unwrap_or_else(|| shells::fallback_id(&profiles))
}

fn working_dir(root: &std::path::Path, sub: Option<&str>) -> AppResult<PathBuf> {
    match sub.map(str::trim).filter(|s| !s.is_empty()) {
        Some(rel) => {
            let dir = filesystem::resolve(root, rel)?;
            if !dir.is_dir() {
                return Err(AppError::Invalid(format!("Working directory is not a folder: {rel}")));
            }
            Ok(dir)
        }
        None => Ok(root.to_path_buf()),
    }
}

#[tauri::command]
pub fn terminal_spawn(state: State<'_, AppState>, request: SpawnRequest) -> AppResult<SessionInfo> {
    let root = projects::root(&state.db, &request.project_id)?;
    let (title, spec) = match request.kind.as_str() {
        "shell" => {
            let shell_id = request.shell_id.clone().unwrap_or_else(|| default_shell(&state));
            let profiles = state.terminals.shells();
            let profile = shells::find(&profiles, &shell_id)
                .ok_or_else(|| AppError::Invalid(format!("Unknown shell: {shell_id}")))?;
            let title = request.title.clone().unwrap_or_else(|| "Shell".into());
            let spec = LaunchSpec {
                kind: "shell".into(),
                shell_id: profile.id.clone(),
                executable: None,
                args: vec![],
                cwd: root.clone(),
                ..Default::default()
            };
            (title, spec)
        }
        "preset" => {
            let id = request
                .preset_id
                .as_deref()
                .ok_or_else(|| AppError::Invalid("presetId is required".into()))?;
            let preset = presets::get(&state.db, id)?;
            let spec = LaunchSpec {
                kind: "preset".into(),
                shell_id: preset.shell_profile.clone(),
                executable: Some(preset.executable.clone()),
                args: preset.args.clone(),
                cwd: working_dir(&root, preset.working_dir.as_deref())?,
                preset_id: Some(preset.id.clone()),
                ..Default::default()
            };
            (preset.display_name, spec)
        }
        "custom" => {
            let exe = request
                .executable
                .clone()
                .filter(|e| !e.trim().is_empty())
                .ok_or_else(|| AppError::Invalid("Executable is required".into()))?;
            let args = request.args.clone().unwrap_or_default();
            if args.len() > 64 || args.iter().any(|a| a.contains('\0')) {
                return Err(AppError::Invalid("Arguments are invalid".into()));
            }
            let title = request
                .title
                .clone()
                .filter(|t| !t.trim().is_empty())
                .unwrap_or_else(|| exe.clone());
            let spec = LaunchSpec {
                kind: "custom".into(),
                shell_id: request.shell_id.clone().unwrap_or_else(|| "direct".into()),
                executable: Some(exe.trim().to_string()),
                args,
                cwd: root.clone(),
                ..Default::default()
            };
            (title, spec)
        }
        other => return Err(AppError::Invalid(format!("Unknown session kind: {other}"))),
    };
    Ok(state
        .terminals
        .spawn(&request.project_id, title, spec, request.cols, request.rows))
}

#[tauri::command]
pub fn terminal_list(state: State<'_, AppState>) -> Vec<SessionInfo> {
    state.terminals.list()
}

#[tauri::command]
pub fn terminal_snapshot(state: State<'_, AppState>, id: String) -> AppResult<String> {
    state.terminals.snapshot(&id)
}

#[tauri::command]
pub fn terminal_write(state: State<'_, AppState>, id: String, data: String) -> AppResult<()> {
    state.terminals.write(&id, &data)
}

#[tauri::command]
pub fn terminal_resize(state: State<'_, AppState>, id: String, cols: u16, rows: u16) -> AppResult<()> {
    state.terminals.resize(&id, cols, rows)
}

#[tauri::command]
pub fn terminal_rename(state: State<'_, AppState>, id: String, title: String) -> AppResult<SessionInfo> {
    state.terminals.rename(&id, &title)
}

#[tauri::command]
pub fn terminal_restart(state: State<'_, AppState>, id: String, cols: u16, rows: u16) -> AppResult<SessionInfo> {
    state.terminals.restart(&id, cols, rows)
}

#[tauri::command]
pub fn terminal_kill(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.terminals.kill(&id)
}

#[tauri::command]
pub fn terminal_close(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.terminals.close(&id)
}

// ---------- usage limits ----------

#[tauri::command]
pub fn usage_get(state: State<'_, AppState>) -> UsageSnapshot {
    state.usage.snapshot()
}

/// Ask Codex again (in the background; the result arrives as a
/// `usage-changed` event).
#[tauri::command]
pub fn usage_refresh(state: State<'_, AppState>) -> UsageSnapshot {
    // A turned-off Codex is never started, not even for its usage windows.
    if !state.chat.is_enabled(Engine::Codex) {
        return state.usage.snapshot();
    }
    let exe = state.chat.executable_override(Engine::Codex);
    state.usage.refresh(usage::codex::locate(exe.as_deref()));
    state.usage.snapshot()
}

// ---------- chat ----------
// One Chat for agent runtimes and direct APIs. Agent access to project files
// is enforced in `chat::policy`; these handlers only validate and delegate.

#[tauri::command]
pub fn chat_list_conversations(state: State<'_, AppState>) -> AppResult<Vec<Conversation>> {
    chat::repository::list_conversations(&state.db)
}

#[tauri::command]
pub fn chat_get_messages(state: State<'_, AppState>, conversation_id: String) -> AppResult<Vec<ChatMessage>> {
    chat::repository::messages(&state.db, &conversation_id)
}

/// Titled from the first message; the message itself is sent with `chat_send`.
#[tauri::command]
pub fn chat_create_conversation(state: State<'_, AppState>, chat: NewChat) -> AppResult<Conversation> {
    state.chat.create_conversation(chat)
}

#[tauri::command]
pub fn chat_rename_conversation(state: State<'_, AppState>, id: String, title: String) -> AppResult<Conversation> {
    chat::repository::rename(&state.db, &id, &title)
}

#[tauri::command]
pub fn chat_set_engine(state: State<'_, AppState>, id: String, engine: Engine, model: String) -> AppResult<Conversation> {
    state.chat.set_engine(&id, engine, &model)
}

#[tauri::command]
pub fn chat_set_mode(state: State<'_, AppState>, id: String, mode: Mode) -> AppResult<Conversation> {
    state.chat.set_mode(&id, mode)
}

#[tauri::command]
pub fn chat_set_policy(state: State<'_, AppState>, id: String, policy: Policy) -> AppResult<Conversation> {
    state.chat.set_policy(&id, policy)
}

/// Stops its turn if one runs, ends its runtime session, then deletes the
/// chat, its messages and checkpoints. Files on disk are not touched.
#[tauri::command]
pub fn chat_delete_conversation(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.chat.delete_conversation(&id)
}

fn channel_sink(channel: Channel<ChatEvent>) -> chat::service::Sink {
    Arc::new(move |event| {
        let _ = channel.send(event);
    })
}

/// Returns the request id; events arrive on `on_event`, starting with `Started`.
#[tauri::command]
pub async fn chat_send(
    state: State<'_, AppState>,
    conversation_id: String,
    content: String,
    attachments: Option<Vec<String>>,
    images: Option<Vec<NewImage>>,
    on_event: Channel<ChatEvent>,
) -> AppResult<String> {
    state.chat.send(
        &conversation_id,
        &content,
        &attachments.unwrap_or_default(),
        &images.unwrap_or_default(),
        channel_sink(on_event),
    )
}

/// A pasted image of a message, as a `data:` URL for the transcript.
#[tauri::command]
pub fn chat_image(state: State<'_, AppState>, item_id: String) -> AppResult<String> {
    state.chat.image_data_url(&item_id)
}

#[tauri::command]
pub async fn chat_regenerate(state: State<'_, AppState>, conversation_id: String, on_event: Channel<ChatEvent>) -> AppResult<String> {
    state.chat.regenerate(&conversation_id, channel_sink(on_event))
}

#[tauri::command]
pub fn chat_stop(state: State<'_, AppState>, request_id: String) -> bool {
    state.chat.stop(&request_id)
}

#[tauri::command]
pub fn chat_respond_approval(state: State<'_, AppState>, item_id: String, decision: Decision) -> AppResult<()> {
    state.chat.respond_approval(&item_id, decision)
}

#[tauri::command]
pub fn chat_engines(state: State<'_, AppState>) -> Vec<EngineInfo> {
    state.chat.engines()
}

/// Re-detects runtimes (all, or one); results arrive as `engines-changed`.
#[tauri::command]
pub fn chat_probe_engines(state: State<'_, AppState>, engine: Option<Engine>) -> Vec<EngineInfo> {
    state.chat.probe_engines(engine);
    state.chat.engines()
}

/// Runs a runtime's own sign-in (Antigravity: Google in the browser), then
/// re-probes it. Resolves when the sign-in finished, failed or was cancelled.
/// Turns an integration on (and re-probes it) or off (closes its idle sessions).
#[tauri::command]
pub fn chat_set_engine_enabled(state: State<'_, AppState>, engine: Engine, enabled: bool) -> AppResult<Vec<EngineInfo>> {
    state.chat.set_enabled(engine, enabled)?;
    Ok(state.chat.engines())
}

#[tauri::command]
pub async fn chat_engine_sign_in(state: State<'_, AppState>, engine: Engine) -> AppResult<Vec<EngineInfo>> {
    let chat = Arc::clone(&state.chat);
    tauri::async_runtime::spawn_blocking(move || chat.sign_in(engine))
        .await
        .map_err(|e| AppError::Invalid(format!("Sign-in stopped unexpectedly: {e}")))??;
    Ok(state.chat.engines())
}

#[tauri::command]
pub fn chat_engine_cancel_sign_in(state: State<'_, AppState>, engine: Engine) {
    state.chat.cancel_sign_in(engine);
}

/// Executable override for a runtime (`None` clears it), then re-probes it.
#[tauri::command]
pub fn chat_set_engine_path(state: State<'_, AppState>, engine: Engine, path: Option<String>) -> AppResult<Vec<EngineInfo>> {
    if !engine.is_agent() {
        return Err(AppError::Invalid("Direct APIs have no executable".into()));
    }
    let key = format!("engine_path:{}", engine.as_str());
    match path.map(|p| p.trim().to_string()).filter(|p| !p.is_empty()) {
        Some(p) => {
            let resolved = shells::resolve_executable(&p).ok_or_else(|| AppError::Invalid(format!("No program at {p}")))?;
            state.db.set_setting(&key, &resolved.to_string_lossy())?;
        }
        None => {
            state.db.with(|c| {
                c.execute("DELETE FROM settings WHERE key = ?1", [&key])?;
                Ok(())
            })?;
        }
    }
    state.chat.probe_engines(Some(engine));
    Ok(state.chat.engines())
}

#[tauri::command]
pub async fn chat_api_models(state: State<'_, AppState>, provider: Provider) -> AppResult<Vec<ModelInfo>> {
    state.chat.api_models(provider).await
}

fn change_root(state: &AppState, item_id: &str) -> AppResult<(String, chat::Item, PathBuf)> {
    let (conversation_id, item) = chat::repository::get_item(&state.db, item_id)?;
    let conv = chat::repository::get_conversation(&state.db, &conversation_id)?;
    let project = conv.project_id.ok_or_else(|| AppError::Invalid("This chat has no project".into()))?;
    Ok((conversation_id, item, projects::root(&state.db, &project)?))
}

/// The diff of an agent's file change against the checkpoint taken before it.
#[tauri::command]
pub fn chat_file_diff(state: State<'_, AppState>, item_id: String) -> AppResult<FileDiff> {
    let (conversation_id, item, root) = change_root(&state, &item_id)?;
    let chat::ItemBody::FileChange { path, checkpoint, .. } = item.body else {
        return Err(AppError::Invalid("Not a file change".into()));
    };
    let id = checkpoint.ok_or_else(|| AppError::Invalid("This change has no checkpoint (the file was too large)".into()))?;
    let abs = filesystem::resolve(&root, &path)?;
    state.chat.agents().checkpoints().diff(&conversation_id, &id, &abs)
}

/// Keep (`keep: true`) or revert an agent's file change.
#[tauri::command]
pub fn chat_set_change(state: State<'_, AppState>, item_id: String, keep: bool) -> AppResult<chat::Item> {
    let (_, _, root) = change_root(&state, &item_id)?;
    let (_, item) = chat::agents::turn::set_change_state(&state.db, state.chat.agents().checkpoints(), &root, &item_id, keep)?;
    Ok(item)
}

/// Files agents changed in a project, latest per path (Overview, Editor badges).
#[tauri::command]
pub fn chat_changed_files(state: State<'_, AppState>, project_id: String) -> AppResult<Vec<ChangedFile>> {
    chat::repository::changed_files(&state.db, &project_id, 50)
}

#[tauri::command]
pub fn chat_providers(state: State<'_, AppState>) -> Vec<ProviderStatus> {
    state.chat.providers()
}

/// Saves the key to the OS credential store, then tests it with a real request.
#[tauri::command]
pub async fn chat_save_key(state: State<'_, AppState>, provider: Provider, key: String, model: Option<String>) -> AppResult<ProviderStatus> {
    state.chat.save_key(provider, &key)?;
    reprobe_key_users(&state, provider);
    state.chat.test(provider, model).await
}

#[tauri::command]
pub fn chat_remove_key(state: State<'_, AppState>, provider: Provider) -> AppResult<ProviderStatus> {
    let status = state.chat.remove_key(provider)?;
    reprobe_key_users(&state, provider);
    Ok(status)
}

/// Gemini CLI runs on the Gemini API key, so its status follows the key.
fn reprobe_key_users(state: &AppState, provider: Provider) {
    if provider == Provider::Gemini {
        state.chat.probe_engines(Some(Engine::GeminiCli));
    }
}

#[tauri::command]
pub async fn chat_test_connection(state: State<'_, AppState>, provider: Provider, model: Option<String>) -> AppResult<ProviderStatus> {
    state.chat.test(provider, model).await
}


// ---------- app ----------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub version: String,
    pub data_dir: String,
    pub platform: String,
    pub windows_build: Option<u32>,
}

#[tauri::command]
pub fn app_info(app: AppHandle, state: State<'_, AppState>) -> AppInfo {
    AppInfo {
        version: app.package_info().version.to_string(),
        data_dir: state.data_dir.to_string_lossy().to_string(),
        platform: std::env::consts::OS.into(),
        windows_build: crate::terminals::windows_build(),
    }
}

/// End every managed process and exit. Called after the user confirms.
#[tauri::command]
pub fn app_quit(app: AppHandle, state: State<'_, AppState>) {
    state.terminals.close_all();
    state.chat.shutdown();
    app.exit(0);
}
