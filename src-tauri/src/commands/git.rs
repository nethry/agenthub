//! Git commands for the Editor's Source control. Git runs on a blocking thread;
//! every mutating command returns the fresh status so the UI doesn't wait for
//! the watcher.

use std::path::PathBuf;
use std::sync::Arc;

use tauri::ipc::Channel;
use tauri::State;

use crate::chat::{repository, ChangeState};
use crate::error::{AppError, AppResult};
use crate::git::{AiChange, GitInfo, GitProgress, GitService, GitStatus};
use crate::projects;
use crate::AppState;

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> AppResult<T> + Send + 'static) -> AppResult<T> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| AppError::Invalid(format!("Git stopped unexpectedly: {e}")))?
}

fn ctx(state: &AppState, project_id: &str) -> AppResult<(Arc<GitService>, PathBuf)> {
    Ok((Arc::clone(&state.git), projects::root(&state.db, project_id)?))
}

fn progress(channel: Channel<GitProgress>) -> impl Fn(GitProgress) + Sync {
    move |p| {
        let _ = channel.send(p);
    }
}

/// Uncommitted files an agent changed in Chat: the AI badges and the trailer.
fn with_ai(state: &AppState, project_id: &str, root: &std::path::Path, mut status: GitStatus) -> GitStatus {
    if status.state != "ok" {
        return status;
    }
    let changed = repository::changed_files(&state.db, project_id, 200).unwrap_or_default();
    let candidates: Vec<(String, &repository::ChangedFile)> = changed
        .iter()
        .filter(|c| c.state != ChangeState::Reverted && !c.path.starts_with('/') && !c.path.contains(':'))
        .map(|c| (format!("{}{}", status.prefix, c.path), c))
        .filter(|(p, _)| status.parsed.entries.iter().any(|e| &e.path == p && e.conflict.is_none()))
        .collect();
    if candidates.is_empty() {
        return status;
    }
    let paths: Vec<String> = candidates.iter().map(|(p, _)| p.clone()).collect();
    let committed = state.git.last_commit_times(project_id, root, &paths);
    status.ai = candidates
        .into_iter()
        // A change older than the file's last commit was already committed.
        .filter(|(p, c)| !committed.get(p).is_some_and(|t| c.at <= t * 1000))
        .map(|(path, c)| AiChange {
            path,
            engine: c.engine.as_str().to_string(),
            engine_label: c.engine.label().to_string(),
            conversation_id: c.conversation_id.clone(),
        })
        .collect();
    status
}

#[tauri::command]
pub async fn git_info(state: State<'_, AppState>, refresh: Option<bool>) -> AppResult<GitInfo> {
    let git = Arc::clone(&state.git);
    blocking(move || Ok(git.info(refresh.unwrap_or(false)))).await
}

/// Executable override from Settings › Git (`None` = PATH lookup).
#[tauri::command]
pub async fn git_set_path(state: State<'_, AppState>, path: Option<String>) -> AppResult<GitInfo> {
    let git = Arc::clone(&state.git);
    blocking(move || git.set_path(path)).await
}

#[tauri::command]
pub async fn git_status(state: State<'_, AppState>, project_id: String) -> AppResult<GitStatus> {
    let (git, root) = ctx(&state, &project_id)?;
    let (pid, r) = (project_id.clone(), root.clone());
    let status = blocking(move || git.status(&pid, &r)).await?;
    Ok(with_ai(&state, &project_id, &root, status))
}

/// Adds the folder to the user's `safe.directory`, after they confirmed.
#[tauri::command]
pub async fn git_trust_folder(state: State<'_, AppState>, project_id: String, path: String) -> AppResult<GitStatus> {
    let (git, root) = ctx(&state, &project_id)?;
    blocking(move || git.trust(&project_id, &root, &path)).await
}

macro_rules! status_command {
    ($name:ident, |$git:ident, $pid:ident, $root:ident $(, $arg:ident : $ty:ty)*| $body:expr) => {
        #[tauri::command]
        pub async fn $name(state: State<'_, AppState>, project_id: String $(, $arg: $ty)*) -> AppResult<GitStatus> {
            let (git, root) = ctx(&state, &project_id)?;
            let (pid2, root2) = (project_id.clone(), root.clone());
            let status = blocking(move || {
                let ($git, $pid, $root) = (git, pid2, root2);
                $body
            })
            .await?;
            Ok(with_ai(&state, &project_id, &root, status))
        }
    };
}

status_command!(git_stage, |git, pid, root, paths: Vec<String>, confirmed: Option<bool>| git.stage(&pid, &root, &paths, confirmed.unwrap_or(false)));
status_command!(git_unstage, |git, pid, root, paths: Vec<String>| git.unstage(&pid, &root, &paths));
status_command!(git_stage_all, |git, pid, root| git.stage_all(&pid, &root));
status_command!(git_unstage_all, |git, pid, root| git.unstage_all(&pid, &root));
status_command!(git_discard, |git, pid, root, paths: Vec<String>, dirty: Vec<String>, confirmed: bool| git.discard(&pid, &root, &paths, &dirty, confirmed));
status_command!(git_operation_continue, |git, pid, root, dirty: Vec<String>| git.operation_continue(&pid, &root, &dirty));
status_command!(git_operation_abort, |git, pid, root, dirty: Vec<String>, confirmed: bool| git.operation_abort(&pid, &root, &dirty, confirmed));

#[tauri::command]
pub async fn git_head_message(state: State<'_, AppState>, project_id: String) -> AppResult<String> {
    let (git, root) = ctx(&state, &project_id)?;
    blocking(move || git.head_message(&project_id, &root)).await
}

/// Commits the staged changes; hook output streams on `on_progress`.
#[tauri::command]
pub async fn git_commit(
    state: State<'_, AppState>,
    project_id: String,
    message: String,
    amend: bool,
    trailers: Vec<String>,
    on_progress: Channel<GitProgress>,
) -> AppResult<GitStatus> {
    let (git, root) = ctx(&state, &project_id)?;
    let (pid, r) = (project_id.clone(), root.clone());
    let status = blocking(move || {
        let on_line = move |l: &str| {
            let _ = on_progress.send(GitProgress { line: l.to_string(), percent: None });
        };
        git.commit(&pid, &r, &message, amend, &trailers, &on_line)
    })
    .await?;
    Ok(with_ai(&state, &project_id, &root, status))
}

#[tauri::command]
pub async fn git_fetch(state: State<'_, AppState>, project_id: String, op_id: String, on_progress: Channel<GitProgress>) -> AppResult<GitStatus> {
    let (git, root) = ctx(&state, &project_id)?;
    let (pid, r) = (project_id.clone(), root.clone());
    let status = blocking(move || git.fetch(&pid, &r, &op_id, &progress(on_progress))).await?;
    Ok(with_ai(&state, &project_id, &root, status))
}

#[tauri::command]
pub async fn git_pull(
    state: State<'_, AppState>,
    project_id: String,
    op_id: String,
    dirty: Vec<String>,
    on_progress: Channel<GitProgress>,
) -> AppResult<GitStatus> {
    let (git, root) = ctx(&state, &project_id)?;
    let (pid, r) = (project_id.clone(), root.clone());
    let status = blocking(move || git.pull(&pid, &r, &op_id, &dirty, &progress(on_progress))).await?;
    Ok(with_ai(&state, &project_id, &root, status))
}

#[tauri::command]
pub async fn git_push(state: State<'_, AppState>, project_id: String, op_id: String, on_progress: Channel<GitProgress>) -> AppResult<GitStatus> {
    let (git, root) = ctx(&state, &project_id)?;
    let (pid, r) = (project_id.clone(), root.clone());
    let status = blocking(move || git.push(&pid, &r, &op_id, &progress(on_progress))).await?;
    Ok(with_ai(&state, &project_id, &root, status))
}

#[tauri::command]
pub async fn git_publish(state: State<'_, AppState>, project_id: String, op_id: String, on_progress: Channel<GitProgress>) -> AppResult<GitStatus> {
    let (git, root) = ctx(&state, &project_id)?;
    let (pid, r) = (project_id.clone(), root.clone());
    let status = blocking(move || git.publish(&pid, &r, &op_id, &progress(on_progress))).await?;
    Ok(with_ai(&state, &project_id, &root, status))
}

/// Stops a running fetch, pull or push.
#[tauri::command]
pub fn git_cancel(state: State<'_, AppState>, op_id: String) -> bool {
    state.git.cancel(&op_id)
}
