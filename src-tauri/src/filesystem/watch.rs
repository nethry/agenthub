//! Watches every registered project root and reports changed paths (project
//! relative, debounced) so the explorer, palette and open editors stay in sync.

use std::collections::{BTreeSet, HashMap};
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_full::{new_debouncer_opt, DebounceEventResult, Debouncer, NoCache};
use parking_lot::Mutex;
use serde::Serialize;

use super::TEMP_MARKER;

const DEBOUNCE: Duration = Duration::from_millis(300);
/// More changed paths than this in one batch: tell the UI to refresh everything.
const MAX_PATHS: usize = 500;
/// Churn that never matters to the explorer or editor.
const IGNORED_DIRS: &[&str] = &[".git", "node_modules", "target"];

#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FsChange {
    pub project_id: String,
    pub paths: Vec<String>,
    /// Too many changes to list; refresh everything.
    pub overflow: bool,
}

pub type ChangeSink = Arc<dyn Fn(FsChange) + Send + Sync>;

pub struct Watchers {
    sink: ChangeSink,
    active: Mutex<HashMap<String, Debouncer<RecommendedWatcher, NoCache>>>,
}

impl Watchers {
    pub fn new(sink: ChangeSink) -> Self {
        Self {
            sink,
            active: Mutex::new(HashMap::new()),
        }
    }

    /// Start watching a project root. Failure only loses live updates, so it's
    /// silent; the manual refresh keeps working.
    pub fn watch(&self, project_id: &str, root: &Path) {
        if self.active.lock().contains_key(project_id) {
            return;
        }
        let sink = self.sink.clone();
        let pid = project_id.to_string();
        let base = root.to_path_buf();
        let handler = move |res: DebounceEventResult| {
            let Ok(events) = res else { return };
            let paths: BTreeSet<String> = events
                .iter()
                .flat_map(|e| e.paths.iter())
                .filter_map(|p| relevant(&base, p))
                .collect();
            if paths.is_empty() {
                return;
            }
            let overflow = paths.len() > MAX_PATHS;
            sink(FsChange {
                project_id: pid.clone(),
                paths: if overflow { vec![] } else { paths.into_iter().collect() },
                overflow,
            });
        };
        let Ok(mut debouncer) = new_debouncer_opt::<_, RecommendedWatcher, NoCache>(
            DEBOUNCE,
            None,
            handler,
            NoCache,
            notify::Config::default(),
        ) else {
            return;
        };
        if debouncer.watch(root, RecursiveMode::Recursive).is_ok() {
            self.active.lock().insert(project_id.to_string(), debouncer);
        }
    }

    pub fn unwatch(&self, project_id: &str) {
        self.active.lock().remove(project_id);
    }
}

/// Project-relative `/` path for an event path, or `None` when it's noise.
fn relevant(root: &Path, path: &Path) -> Option<String> {
    let rel: PathBuf = path.strip_prefix(root).ok()?.to_path_buf();
    for comp in rel.components() {
        match comp {
            Component::Normal(name) if IGNORED_DIRS.contains(&name.to_string_lossy().as_ref()) => return None,
            Component::Normal(_) => {}
            _ => return None,
        }
    }
    let name = rel.file_name()?.to_string_lossy();
    if name.contains(TEMP_MARKER) {
        return None;
    }
    Some(rel.to_string_lossy().replace('\\', "/"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::Instant;

    #[test]
    fn filters_noise() {
        let root = Path::new("/p");
        assert_eq!(relevant(root, Path::new("/p/src/a.ts")).as_deref(), Some("src/a.ts"));
        assert_eq!(relevant(root, Path::new("/p/node_modules/x/y.js")), None);
        assert_eq!(relevant(root, Path::new("/p/.git/index")), None);
        assert_eq!(relevant(root, Path::new("/p/.a.ts.agenthub-save-123")), None);
        assert_eq!(relevant(root, Path::new("/elsewhere/a.ts")), None);
        assert_eq!(relevant(root, Path::new("/p")), None);
    }

    #[test]
    fn reports_changes_in_a_real_folder() {
        let dir = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(dir.path()).unwrap();
        let seen: Arc<Mutex<Vec<FsChange>>> = Arc::default();
        let rec = seen.clone();
        let watchers = Watchers::new(Arc::new(move |c| rec.lock().push(c)));
        watchers.watch("p1", &root);
        fs::write(root.join("new.txt"), "x").unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            if seen.lock().iter().any(|c| c.paths.iter().any(|p| p == "new.txt")) {
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        let got = seen.lock().clone();
        assert!(
            got.iter().any(|c| c.project_id == "p1" && c.paths.contains(&"new.txt".to_string())),
            "{got:?}"
        );
        watchers.unwatch("p1");
    }
}
