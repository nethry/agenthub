//! Watches a repository's git dir (outside or inside the project) and reports
//! what changed (`git-changed`), so Source control refreshes after commits,
//! checkouts, fetches and operations run anywhere, terminals included. The
//! project watcher keeps ignoring `.git`; this one never reports file paths.

use std::collections::{BTreeSet, HashMap};
use std::path::{Component, Path};
use std::sync::Arc;
use std::time::Duration;

use notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_full::{new_debouncer_opt, DebounceEventResult, Debouncer, NoCache};
use parking_lot::Mutex;
use serde::Serialize;

use super::Repo;

const DEBOUNCE: Duration = Duration::from_millis(300);

#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitChanged {
    pub project_id: String,
    /// `index` | `head` | `refs` | `state` | `config`
    pub kinds: Vec<&'static str>,
}

pub type GitSink = Arc<dyn Fn(GitChanged) + Send + Sync>;

pub struct GitWatchers {
    sink: GitSink,
    active: Mutex<HashMap<String, Debouncer<RecommendedWatcher, NoCache>>>,
}

/// What a path inside the git dir means; `None` for churn (objects, logs, locks).
pub fn classify(rel: &Path) -> Option<&'static str> {
    let parts: Vec<String> = rel
        .components()
        .filter_map(|c| match c {
            Component::Normal(n) => Some(n.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect();
    let first = parts.first()?.as_str();
    let last = parts.last()?.as_str();
    if last.ends_with(".lock") || matches!(first, "objects" | "logs" | "hooks" | "info" | "lfs") {
        return None;
    }
    match first {
        "index" => Some("index"),
        "HEAD" | "ORIG_HEAD" => Some("head"),
        "refs" | "packed-refs" | "FETCH_HEAD" => Some("refs"),
        "MERGE_HEAD" | "CHERRY_PICK_HEAD" | "REVERT_HEAD" | "REBASE_HEAD" | "MERGE_MSG" | "rebase-merge" | "rebase-apply" | "sequencer" => Some("state"),
        "config" => Some("config"),
        _ => None,
    }
}

impl GitWatchers {
    pub fn new(sink: GitSink) -> Self {
        Self { sink, active: Mutex::new(HashMap::new()) }
    }

    /// Starts watching a project's repository once; failures only lose live updates.
    pub fn watch(&self, project_id: &str, repo: &Repo) {
        if self.active.lock().contains_key(project_id) {
            return;
        }
        let sink = self.sink.clone();
        let pid = project_id.to_string();
        let bases = [repo.git_dir.clone(), repo.common_dir.clone()];
        let handler = move |res: DebounceEventResult| {
            let Ok(events) = res else { return };
            let kinds: BTreeSet<&'static str> = events
                .iter()
                .flat_map(|e| e.paths.iter())
                .filter_map(|p| bases.iter().find_map(|b| p.strip_prefix(b).ok()).and_then(classify))
                .collect();
            if !kinds.is_empty() {
                sink(GitChanged { project_id: pid.clone(), kinds: kinds.into_iter().collect() });
            }
        };
        let Ok(mut debouncer) = new_debouncer_opt::<_, RecommendedWatcher, NoCache>(DEBOUNCE, None, handler, NoCache, notify::Config::default())
        else {
            return;
        };
        // Top level of the git dir (HEAD, index, *_HEAD, rebase-*), and refs.
        let mut ok = debouncer.watch(&repo.git_dir, RecursiveMode::NonRecursive).is_ok();
        if repo.common_dir != repo.git_dir {
            ok &= debouncer.watch(&repo.common_dir, RecursiveMode::NonRecursive).is_ok();
        }
        let refs = repo.common_dir.join("refs");
        if refs.is_dir() {
            let _ = debouncer.watch(&refs, RecursiveMode::Recursive);
        }
        if ok {
            self.active.lock().insert(project_id.to_string(), debouncer);
        }
    }

    pub fn unwatch(&self, project_id: &str) {
        self.active.lock().remove(project_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_git_dir_paths() {
        assert_eq!(classify(Path::new("index")), Some("index"));
        assert_eq!(classify(Path::new("HEAD")), Some("head"));
        assert_eq!(classify(Path::new("refs/heads/feature/x")), Some("refs"));
        assert_eq!(classify(Path::new("packed-refs")), Some("refs"));
        assert_eq!(classify(Path::new("rebase-merge/msgnum")), Some("state"));
        assert_eq!(classify(Path::new("MERGE_HEAD")), Some("state"));
        assert_eq!(classify(Path::new("index.lock")), None);
        assert_eq!(classify(Path::new("objects/ab/cdef")), None);
        assert_eq!(classify(Path::new("logs/HEAD")), None);
        assert_eq!(classify(Path::new("COMMIT_EDITMSG")), None);
    }
}
