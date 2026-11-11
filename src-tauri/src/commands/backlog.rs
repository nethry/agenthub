//! Backlog commands: features and bugs per project, their screenshots, and the
//! context pack a chat gets (`chat_send` takes the item; see `chat::service`).

use tauri::State;

use crate::backlog::{self, repository, BacklogItem, ItemPatch, NewItem, Status};
use crate::chat::images::NewImage;
use crate::error::AppResult;
use crate::AppState;

#[tauri::command]
pub fn backlog_list(state: State<'_, AppState>, project_id: String) -> AppResult<Vec<BacklogItem>> {
    repository::list(&state.db, &project_id)
}

#[tauri::command]
pub fn backlog_create(state: State<'_, AppState>, item: NewItem) -> AppResult<BacklogItem> {
    repository::create(&state.db, item)
}

#[tauri::command]
pub fn backlog_update(state: State<'_, AppState>, id: String, patch: ItemPatch) -> AppResult<BacklogItem> {
    repository::update(&state.db, &id, patch)
}

#[tauri::command]
pub fn backlog_set_status(state: State<'_, AppState>, id: String, status: Status) -> AppResult<BacklogItem> {
    repository::set_status(&state.db, &id, status)
}

#[tauri::command]
pub fn backlog_set_plan(state: State<'_, AppState>, id: String, plan: Option<String>) -> AppResult<BacklogItem> {
    repository::set_plan(&state.db, &id, plan.as_deref())
}

/// Deletes the item and its screenshots; chats started from it stay.
#[tauri::command]
pub fn backlog_delete(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.backlog.delete(&id)
}

#[tauri::command]
pub fn backlog_add_images(state: State<'_, AppState>, id: String, images: Vec<NewImage>) -> AppResult<BacklogItem> {
    state.backlog.add_images(&id, &images)
}

#[tauri::command]
pub fn backlog_remove_image(state: State<'_, AppState>, image_id: String) -> AppResult<BacklogItem> {
    state.backlog.remove_image(&image_id)
}

/// A screenshot as a `data:` URL.
#[tauri::command]
pub fn backlog_image(state: State<'_, AppState>, image_id: String) -> AppResult<String> {
    state.backlog.image_data_url(&image_id)
}

/// The context pack exactly as a message sent now would carry it.
#[tauri::command]
pub fn backlog_context_preview(state: State<'_, AppState>, id: String) -> AppResult<String> {
    backlog::context::for_item(&state.db, &id).map(|(_, text)| text)
}
