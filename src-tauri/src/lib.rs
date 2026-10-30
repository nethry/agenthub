mod chat;
mod commands;
mod error;
mod filesystem;
mod git;
mod persistence;
mod presets;
mod projects;
mod terminals;
mod updates;
mod usage;

use std::path::PathBuf;
use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, RunEvent};

use filesystem::watch::Watchers;
use persistence::Db;
use terminals::{EventSink, SessionInfo, TerminalManager};

pub struct AppState {
    pub db: Arc<Db>,
    pub terminals: TerminalManager,
    pub watchers: Watchers,
    pub usage: Arc<usage::Usage>,
    pub chat: Arc<chat::ChatService>,
    pub git: Arc<git::GitService>,
    pub updates: updates::Updates,
    pub data_dir: PathBuf,
}

#[derive(Serialize, Clone)]
struct OutputPayload<'a> {
    id: &'a str,
    data: &'a str,
}

struct TauriSink(AppHandle);

impl EventSink for TauriSink {
    fn output(&self, id: &str, data: &str) {
        let _ = self.0.emit("terminal-output", OutputPayload { id, data });
    }
    fn status(&self, info: &SessionInfo) {
        let _ = self.0.emit("terminal-status", info);
    }
}

/// The sidecar entry script: bundled as a resource, or the repo's build in dev.
fn sidecar_script(app: &AppHandle) -> Option<PathBuf> {
    let bundled = app.path().resource_dir().ok().map(|d| d.join("sidecar").join("main.mjs"));
    let dev = cfg!(debug_assertions)
        .then(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("sidecar").join("dist").join("main.mjs"));
    bundled.into_iter().chain(dev).find(|p| p.is_file())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let db = Arc::new(Db::open(&data_dir.join("agenthub.db"))?);
            presets::seed_defaults(&db)?;
            let terminals =
                TerminalManager::new(TauriSink(app.handle().clone()), terminals::shells::detect());
            let handle = app.handle().clone();
            let watchers = Watchers::new(Arc::new(move |change| {
                let _ = handle.emit("fs-changed", change);
            }));
            let handle = app.handle().clone();
            let usage = usage::Usage::new(Box::new(move |snapshot| {
                let _ = handle.emit("usage-changed", snapshot);
            }));
            for project in projects::list(&db)? {
                if let Ok(root) = projects::root(&db, &project.id) {
                    watchers.watch(&project.id, &root);
                }
            }
            let sidecar = chat::agents::sidecar::Sidecar::new(sidecar_script(app.handle()));
            let adapters: Vec<Arc<dyn chat::agents::EngineAdapter>> = vec![
                Arc::new(chat::agents::sidecar::SdkAdapter::new(chat::Engine::ClaudeCode, Arc::clone(&sidecar))),
                Arc::new(chat::agents::codex::Adapter::new(Arc::clone(&usage))),
                Arc::new(chat::agents::gemini::adapter()),
                Arc::new(chat::agents::antigravity::adapter()),
                Arc::new(chat::agents::sidecar::SdkAdapter::new(chat::Engine::CopilotCli, sidecar)),
            ];
            let chat = Arc::new(chat::ChatService::new(
                Arc::clone(&db),
                Box::new(chat::secrets::KeyringStore),
                data_dir.join("checkpoints"),
                data_dir.join("chat-images"),
                adapters,
            ));
            let handle = app.handle().clone();
            chat.set_engines_sink(Arc::new(move |engines| {
                let _ = handle.emit("engines-changed", engines);
            }));
            chat.probe_engines(None);
            let handle = app.handle().clone();
            let git = Arc::new(git::GitService::new(
                Arc::clone(&db),
                Arc::new(move |change| {
                    let _ = handle.emit("git-changed", change);
                }),
            ));
            app.manage(AppState {
                db,
                chat,
                git,
                updates: updates::Updates::default(),
                terminals,
                watchers,
                usage,
                data_dir,
            });
            updates::start_scheduler(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_projects,
            commands::add_project,
            commands::create_project_folder,
            commands::rename_project,
            commands::remove_project,
            commands::touch_project,
            commands::reorder_projects,
            commands::get_workspace_state,
            commands::save_workspace_state,
            commands::get_settings,
            commands::set_setting,
            commands::fs_list_dir,
            commands::fs_index,
            commands::fs_read_file,
            commands::fs_write_file,
            commands::fs_create,
            commands::fs_rename,
            commands::fs_delete,
            commands::list_presets,
            commands::save_preset,
            commands::delete_preset,
            commands::resolve_executable,
            commands::list_shells,
            commands::terminal_spawn,
            commands::terminal_list,
            commands::terminal_snapshot,
            commands::terminal_write,
            commands::terminal_resize,
            commands::terminal_rename,
            commands::terminal_restart,
            commands::terminal_kill,
            commands::terminal_close,
            commands::usage_get,
            commands::usage_refresh,
            commands::chat_list_conversations,
            commands::chat_get_messages,
            commands::chat_create_conversation,
            commands::chat_rename_conversation,
            commands::chat_set_engine,
            commands::chat_set_mode,
            commands::chat_set_policy,
            commands::chat_delete_conversation,
            commands::chat_send,
            commands::chat_regenerate,
            commands::chat_stop,
            commands::chat_respond_approval,
            commands::chat_engines,
            commands::chat_probe_engines,
            commands::chat_set_engine_enabled,
            commands::chat_image,
            commands::chat_engine_sign_in,
            commands::chat_engine_cancel_sign_in,
            commands::chat_set_engine_path,
            commands::chat_api_models,
            commands::chat_file_diff,
            commands::chat_set_change,
            commands::chat_changed_files,
            commands::chat_providers,
            commands::chat_save_key,
            commands::chat_remove_key,
            commands::chat_test_connection,
            commands::app_info,
            commands::app_quit,
            commands::updates::update_check,
            commands::updates::update_download,
            commands::updates::update_downloaded,
            commands::updates::update_install,
            commands::git::git_info,
            commands::git::git_set_path,
            commands::git::git_status,
            commands::git::git_trust_folder,
            commands::git::git_stage,
            commands::git::git_unstage,
            commands::git::git_stage_all,
            commands::git::git_unstage_all,
            commands::git::git_discard,
            commands::git::git_operation_continue,
            commands::git::git_operation_abort,
            commands::git::git_head_message,
            commands::git::git_commit,
            commands::git::git_fetch,
            commands::git::git_pull,
            commands::git::git_push,
            commands::git::git_publish,
            commands::git::git_cancel,
        ])
        .build(tauri::generate_context!())
        .expect("error while building AgentHub");

    app.run(|handle, event| {
        // Managed processes end with the app; reattaching is out of scope.
        if let RunEvent::Exit = event {
            if let Some(state) = handle.try_state::<AppState>() {
                state.terminals.close_all();
                state.chat.shutdown();
            }
        }
    });
}
