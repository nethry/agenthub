//! Git for the Editor's Source control: the system `git` binary, run with
//! argv arrays in the repository folder. Auth is Git Credential Manager's;
//! AgentHub stores no Git secrets. Guards (amend, unsaved buffers, operations
//! in progress, confirmations) are enforced here, not only in the UI.

pub mod error;
pub mod exe;
pub mod remote;
pub mod runner;
pub mod status;
pub mod watch;

#[cfg(test)]
mod tests;

use std::collections::{HashMap, HashSet};
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::Duration;

use parking_lot::{Mutex, RwLock};
use serde::Serialize;

pub use error::GitErrorKind;
use error::{err, from_output, io_error};
pub use exe::GitInfo;
use runner::{with_paths, Access, Call, Cancel, Output};
pub use status::{Operation, Parsed, StatusEntry};

use crate::error::{AppError, AppResult};
use crate::persistence::Db;

/// Settings key of the Git executable override (written by `git_set_path` only).
pub const PATH_SETTING: &str = "git_path";
const LOCK_WAIT: Duration = Duration::from_secs(30);

/// A discovered repository and where the project sits in it.
#[derive(Debug, Clone)]
pub struct Repo {
    pub toplevel: PathBuf,
    pub git_dir: PathBuf,
    pub common_dir: PathBuf,
    /// The project root relative to `toplevel` (`""` or `"sub/dir/"`).
    pub prefix: String,
    /// The repo's `core.fsmonitor` is a hook command: never run it in the background.
    pub fsmonitor_off: bool,
}

#[derive(Default)]
struct RepoLocks {
    index: Arc<Mutex<()>>,
    net: Arc<Mutex<()>>,
}

/// Status of a project's repository for the Source control view.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    /// `ok` | `none` (not a repository) | `unsafe` (dubious ownership) | `no_git`.
    pub state: &'static str,
    pub message: Option<String>,
    /// The folder `Trust this folder` would add to `safe.directory`.
    pub trust_path: Option<String>,
    pub toplevel: Option<String>,
    pub prefix: String,
    #[serde(flatten)]
    pub parsed: Parsed,
    pub operation: Option<Operation>,
    /// HEAD is on a remote-tracking branch (amend and undo would rewrite shared history).
    pub head_pushed: bool,
    pub remotes: Vec<String>,
    /// When `FETCH_HEAD` was last written (epoch ms).
    pub last_fetch: Option<i64>,
    /// Files agents changed that are still uncommitted (filled in by the command layer).
    pub ai: Vec<AiChange>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiChange {
    /// Repository-relative.
    pub path: String,
    pub engine: String,
    pub engine_label: String,
    pub conversation_id: String,
}

impl GitStatus {
    fn empty(state: &'static str, message: Option<String>) -> Self {
        Self {
            state,
            message,
            trust_path: None,
            toplevel: None,
            prefix: String::new(),
            parsed: Parsed::default(),
            operation: None,
            head_pushed: false,
            remotes: vec![],
            last_fetch: None,
            ai: vec![],
        }
    }
}

/// A progress line of a long git operation, for the UI.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitProgress {
    pub line: String,
    pub percent: Option<u8>,
}

pub type TrashFn = Box<dyn Fn(&Path) -> Result<(), String> + Send + Sync>;

pub struct GitService {
    db: Arc<Db>,
    exe: RwLock<Option<(Option<PathBuf>, GitInfo)>>,
    repos: Mutex<HashMap<String, Arc<Repo>>>,
    locks: Mutex<HashMap<PathBuf, Arc<RepoLocks>>>,
    ops: Mutex<HashMap<String, Cancel>>,
    watch: watch::GitWatchers,
    /// Extra environment for every call (tests isolate git's config with it).
    env: Vec<(OsString, OsString)>,
    /// Moves a file to the Recycle Bin before a discard.
    trash: TrashFn,
}

impl GitService {
    pub fn new(db: Arc<Db>, sink: watch::GitSink) -> Self {
        Self::with(db, sink, vec![], Box::new(|p| trash::delete(p).map_err(|e| e.to_string())))
    }

    pub fn with(db: Arc<Db>, sink: watch::GitSink, env: Vec<(OsString, OsString)>, trash: TrashFn) -> Self {
        Self {
            db,
            exe: RwLock::new(None),
            repos: Mutex::new(HashMap::new()),
            locks: Mutex::new(HashMap::new()),
            ops: Mutex::new(HashMap::new()),
            watch: watch::GitWatchers::new(sink),
            env,
            trash,
        }
    }

    // ---------- executable ----------

    fn override_path(&self) -> Option<PathBuf> {
        self.db.get_setting(PATH_SETTING).ok().flatten().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).map(PathBuf::from)
    }

    /// The detected git (probed once; `refresh` probes again).
    pub fn info(&self, refresh: bool) -> GitInfo {
        if !refresh {
            if let Some((_, info)) = &*self.exe.read() {
                return info.clone();
            }
        }
        let (path, info) = exe::probe(self.override_path().as_deref());
        *self.exe.write() = Some((path, info.clone()));
        info
    }

    pub fn set_path(&self, path: Option<String>) -> AppResult<GitInfo> {
        match path.map(|p| p.trim().to_string()).filter(|p| !p.is_empty()) {
            Some(p) => {
                let resolved = crate::terminals::shells::resolve_executable(&p).ok_or_else(|| AppError::Invalid(format!("No program at {p}")))?;
                self.db.set_setting(PATH_SETTING, &resolved.to_string_lossy())?;
            }
            None => self.db.with(|c| {
                c.execute("DELETE FROM settings WHERE key = ?1", [PATH_SETTING])?;
                Ok(())
            })?,
        }
        self.repos.lock().clear();
        Ok(self.info(true))
    }

    fn exe(&self) -> AppResult<PathBuf> {
        self.info(false);
        match &*self.exe.read() {
            Some((Some(p), _)) => Ok(p.clone()),
            Some((None, info)) => Err(err(GitErrorKind::NotFound, info.reason.clone().unwrap_or_else(|| "Git isn't installed.".into()))),
            None => Err(err(GitErrorKind::NotFound, "Git isn't installed.")),
        }
    }

    fn call<'a>(&'a self, exe: &'a Path, repo: &'a Repo, access: Access) -> Call<'a> {
        Call::new(exe, &repo.toplevel, access).envs(&self.env).fsmonitor_off(repo.fsmonitor_off)
    }

    // ---------- repository ----------

    /// The project's repository; `Ok(None)` when the folder isn't one.
    fn repo(&self, project_id: &str, root: &Path) -> AppResult<Option<Arc<Repo>>> {
        if let Some(r) = self.repos.lock().get(project_id) {
            if r.git_dir.exists() {
                return Ok(Some(Arc::clone(r)));
            }
        }
        let exe = self.exe()?;
        let out = Call::new(&exe, root, Access::Read)
            .envs(&self.env)
            .args(["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-dir", "--git-common-dir", "--show-prefix"])
            .timeout(Some(Duration::from_secs(10)))
            .run()
            .map_err(io_error)?;
        if !out.ok() {
            let kind = error::classify(&out.stderr);
            if kind == GitErrorKind::NotRepo || out.stderr.contains("must be run in a work tree") {
                self.repos.lock().remove(project_id);
                return Ok(None);
            }
            return Err(from_output(&out, "read the repository"));
        }
        let text = out.text();
        let lines: Vec<&str> = text.lines().collect();
        if lines.len() < 3 {
            return Ok(None);
        }
        let canon = |s: &str| dunce::canonicalize(s).unwrap_or_else(|_| PathBuf::from(s));
        let mut repo = Repo {
            toplevel: canon(lines[0]),
            git_dir: canon(lines[1]),
            common_dir: canon(lines[2]),
            prefix: lines.get(3).map(|s| s.trim().to_string()).unwrap_or_default(),
            fsmonitor_off: false,
        };
        // A repo's fsmonitor hook command would run every time AgentHub reads status.
        let fsm = self.call(&exe, &repo, Access::Read).args(["config", "--get", "core.fsmonitor"]).timeout(Some(Duration::from_secs(10))).run();
        if let Ok(o) = fsm {
            let v = o.text().trim().to_ascii_lowercase();
            repo.fsmonitor_off = !v.is_empty() && !matches!(v.as_str(), "true" | "false" | "yes" | "no" | "on" | "off" | "1" | "0");
        }
        let repo = Arc::new(repo);
        self.repos.lock().insert(project_id.to_string(), Arc::clone(&repo));
        Ok(Some(repo))
    }

    fn require(&self, project_id: &str, root: &Path) -> AppResult<(PathBuf, Arc<Repo>)> {
        let exe = self.exe()?;
        let repo = self.repo(project_id, root)?.ok_or_else(|| err(GitErrorKind::NotRepo, "This folder isn't a Git repository."))?;
        Ok((exe, repo))
    }

    fn locks(&self, repo: &Repo) -> Arc<RepoLocks> {
        Arc::clone(self.locks.lock().entry(repo.git_dir.clone()).or_default())
    }

    /// Forget a removed project.
    pub fn forget(&self, project_id: &str) {
        self.repos.lock().remove(project_id);
        self.watch.unwatch(project_id);
    }

    /// Adds the folder to the user's `safe.directory` (after the user confirmed).
    pub fn trust(&self, project_id: &str, root: &Path, path: &str) -> AppResult<GitStatus> {
        let exe = self.exe()?;
        let path = path.replace('\\', "/");
        let out = Call::new(&exe, root, Access::Write)
            .envs(&self.env)
            .args(["config", "--global", "--add", "safe.directory"])
            .arg(path)
            .run()
            .map_err(io_error)?;
        if !out.ok() {
            return Err(from_output(&out, "trust this folder"));
        }
        self.status(project_id, root)
    }

    // ---------- status ----------

    pub fn status(&self, project_id: &str, root: &Path) -> AppResult<GitStatus> {
        let exe = match self.exe() {
            Ok(e) => e,
            Err(AppError::Git { message, .. }) => return Ok(GitStatus::empty("no_git", Some(message))),
            Err(e) => return Err(e),
        };
        let repo = match self.repo(project_id, root) {
            Ok(Some(r)) => r,
            Ok(None) => return Ok(GitStatus::empty("none", None)),
            Err(AppError::Git { kind: GitErrorKind::UnsafeRepo, message, detail }) => {
                let mut s = GitStatus::empty("unsafe", Some(message));
                s.trust_path = detail.as_deref().and_then(safe_directory_from).or_else(|| Some(root.to_string_lossy().replace('\\', "/")));
                return Ok(s);
            }
            Err(e) => return Err(e),
        };
        self.watch.watch(project_id, &repo);
        self.status_of(&exe, &repo)
    }

    fn status_of(&self, exe: &Path, repo: &Repo) -> AppResult<GitStatus> {
        let out = self
            .call(exe, repo, Access::Read)
            .args(["status", "--porcelain=v2", "-z", "--branch", "--show-stash", "--untracked-files=all", "--ignore-submodules=dirty"])
            .run()
            .map_err(io_error)?;
        if !out.ok() {
            return Err(from_output(&out, "read the status"));
        }
        let parsed = status::parse(&out.stdout, &repo.prefix);
        let head_pushed = !parsed.head.unborn && !self.head_unpushed(exe, repo);
        let remotes = self
            .call(exe, repo, Access::Read)
            .arg("remote")
            .run()
            .map(|o| o.text().lines().map(str::trim).filter(|l| !l.is_empty()).map(str::to_string).collect())
            .unwrap_or_default();
        let last_fetch = [repo.git_dir.join("FETCH_HEAD"), repo.common_dir.join("FETCH_HEAD")]
            .iter()
            .find_map(|p| std::fs::metadata(p).and_then(|m| m.modified()).ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64);
        Ok(GitStatus {
            state: "ok",
            message: None,
            trust_path: None,
            toplevel: Some(repo.toplevel.to_string_lossy().into_owned()),
            prefix: repo.prefix.clone(),
            operation: status::operation(&repo.git_dir),
            parsed,
            head_pushed,
            remotes,
            last_fetch,
            ai: vec![],
        })
    }

    /// HEAD isn't reachable from any remote-tracking branch.
    fn head_unpushed(&self, exe: &Path, repo: &Repo) -> bool {
        self.call(exe, repo, Access::Read)
            .args(["rev-list", "-n1", "HEAD", "--not", "--remotes"])
            .run()
            .map(|o| o.ok() && !o.text().trim().is_empty())
            .unwrap_or(false)
    }

    /// Last commit time (epoch s) per path; paths with no commit are absent.
    pub fn last_commit_times(&self, project_id: &str, root: &Path, paths: &[String]) -> HashMap<String, i64> {
        let mut out = HashMap::new();
        let Ok((exe, repo)) = self.require(project_id, root) else { return out };
        for p in paths.iter().take(50) {
            let r = self.call(&exe, &repo, Access::Read).args(["log", "-1", "--format=%ct", "--", p]).run();
            if let Some(t) = r.ok().and_then(|o| o.text().trim().parse::<i64>().ok()) {
                out.insert(p.clone(), t);
            }
        }
        out
    }

    // ---------- guards ----------

    fn check_no_operation(&self, repo: &Repo) -> AppResult<()> {
        match status::operation(&repo.git_dir) {
            Some(op) => Err(err(GitErrorKind::InProgress, format!("Finish or abort the {} first.", op_label(op.kind)))),
            None => Ok(()),
        }
    }

    // ---------- files ----------

    pub fn stage(&self, project_id: &str, root: &Path, paths: &[String], confirmed: bool) -> AppResult<GitStatus> {
        let (exe, repo) = self.require(project_id, root)?;
        check_paths(paths)?;
        let _g = self.lock_index(&repo)?;
        if !confirmed {
            let marked = self.conflicted_with_markers(&exe, &repo, paths)?;
            if !marked.is_empty() {
                return Err(AppError::Git {
                    kind: GitErrorKind::Markers,
                    message: format!("{} still has conflict markers. Stage it anyway?", names(&marked)),
                    detail: None,
                });
            }
        }
        self.write(with_paths(self.call(&exe, &repo, Access::Write).arg("add"), paths), "stage the files")?;
        self.status_of(&exe, &repo)
    }

    pub fn unstage(&self, project_id: &str, root: &Path, paths: &[String]) -> AppResult<GitStatus> {
        let (exe, repo) = self.require(project_id, root)?;
        check_paths(paths)?;
        let _g = self.lock_index(&repo)?;
        let unborn = self.status_of(&exe, &repo)?.parsed.head.unborn;
        let call = if unborn {
            self.call(&exe, &repo, Access::Write).args(["rm", "--cached", "-q", "-r"])
        } else {
            self.call(&exe, &repo, Access::Write).args(["restore", "--staged"])
        };
        self.write(with_paths(call, paths), "unstage the files")?;
        self.status_of(&exe, &repo)
    }

    pub fn stage_all(&self, project_id: &str, root: &Path) -> AppResult<GitStatus> {
        let (exe, repo) = self.require(project_id, root)?;
        let _g = self.lock_index(&repo)?;
        let marked = self.conflicted_with_markers(&exe, &repo, &[])?;
        if !marked.is_empty() {
            return Err(err(GitErrorKind::Markers, format!("{} still has conflict markers. Fix it, or stage it on its own.", names(&marked))));
        }
        self.write(self.call(&exe, &repo, Access::Write).args(["add", "-A"]), "stage all changes")?;
        self.status_of(&exe, &repo)
    }

    pub fn unstage_all(&self, project_id: &str, root: &Path) -> AppResult<GitStatus> {
        let (exe, repo) = self.require(project_id, root)?;
        let _g = self.lock_index(&repo)?;
        let unborn = self.status_of(&exe, &repo)?.parsed.head.unborn;
        let call = if unborn {
            self.call(&exe, &repo, Access::Write).args(["rm", "--cached", "-r", "-q", "--", "."])
        } else {
            self.call(&exe, &repo, Access::Write).args(["reset", "-q"])
        };
        self.write(call, "unstage all changes")?;
        self.status_of(&exe, &repo)
    }

    /// Discards working-tree changes: the current file goes to the Recycle Bin
    /// first; tracked files come back from the index, untracked ones are gone.
    pub fn discard(&self, project_id: &str, root: &Path, paths: &[String], dirty: &[String], confirmed: bool) -> AppResult<GitStatus> {
        if !confirmed {
            return Err(AppError::Invalid("Confirm discarding first".into()));
        }
        let (exe, repo) = self.require(project_id, root)?;
        check_paths(paths)?;
        let _g = self.lock_index(&repo)?;
        let current = self.status_of(&exe, &repo)?;
        let targets: Vec<&StatusEntry> = paths
            .iter()
            .filter_map(|p| current.parsed.entries.iter().find(|e| &e.path == p))
            .collect();
        check_unsaved(&repo, &targets.iter().map(|e| e.path.clone()).collect::<Vec<_>>(), dirty)?;
        if let Some(c) = targets.iter().find(|e| e.conflict.is_some()) {
            return Err(err(GitErrorKind::Unresolved, format!("{} has conflicts. Fix them, or abort the operation.", file_name(&c.path))));
        }
        let mut restore = Vec::new();
        for e in &targets {
            let abs = repo.toplevel.join(&e.path);
            if abs.exists() && (e.untracked || e.worktree != '.') {
                (self.trash)(&abs).map_err(|m| AppError::Invalid(format!("Couldn't move {} to the Recycle Bin: {m}", file_name(&e.path))))?;
            }
            if !e.untracked && e.worktree != '.' {
                restore.push(e.path.clone());
            }
        }
        if !restore.is_empty() {
            self.write(with_paths(self.call(&exe, &repo, Access::Write).args(["restore", "--worktree"]), &restore), "discard the changes")?;
        }
        self.status_of(&exe, &repo)
    }

    /// Unmerged paths among `paths` (all when empty) whose file still has conflict markers.
    fn conflicted_with_markers(&self, exe: &Path, repo: &Repo, paths: &[String]) -> AppResult<Vec<String>> {
        let out = with_paths(self.call(exe, repo, Access::Read).args(["diff", "--name-only", "-z", "--diff-filter=U"]), paths)
            .run()
            .map_err(io_error)?;
        let mut found = Vec::new();
        for p in out.stdout.split(|b| *b == 0).filter(|s| !s.is_empty()) {
            let p = String::from_utf8_lossy(p).into_owned();
            if std::fs::read(repo.toplevel.join(&p)).is_ok_and(|b| has_markers(&b)) {
                found.push(p);
            }
        }
        Ok(found)
    }

    // ---------- commit ----------

    pub fn head_message(&self, project_id: &str, root: &Path) -> AppResult<String> {
        let (exe, repo) = self.require(project_id, root)?;
        let out = self.call(&exe, &repo, Access::Read).args(["log", "-1", "--format=%B"]).run().map_err(io_error)?;
        Ok(out.text().trim_end().to_string())
    }

    pub fn commit(
        &self,
        project_id: &str,
        root: &Path,
        message: &str,
        amend: bool,
        trailers: &[String],
        on_line: &(dyn Fn(&str) + Sync),
    ) -> AppResult<GitStatus> {
        let (exe, repo) = self.require(project_id, root)?;
        if message.trim().is_empty() {
            return Err(AppError::Invalid("Write a commit message first.".into()));
        }
        for t in trailers {
            check_trailer(t)?;
        }
        let _g = self.lock_index(&repo)?;
        let before = self.status_of(&exe, &repo)?;
        if before.parsed.head.detached {
            return Err(err(GitErrorKind::Detached, "Detached HEAD: create a branch first to keep commits."));
        }
        if before.parsed.entries.iter().any(|e| e.conflict.is_some()) {
            return Err(err(GitErrorKind::Unresolved, "Resolve the conflicts first."));
        }
        if amend && (before.parsed.head.unborn || before.head_pushed) {
            return Err(err(GitErrorKind::PushedCommits, "The last commit is already pushed. Amending would rewrite shared history."));
        }
        let mut call = self.call(&exe, &repo, Access::Write).args(["commit", "-F", "-"]).timeout(None).stdin(message.as_bytes().to_vec());
        if amend {
            call = call.arg("--amend");
        }
        for t in trailers {
            call = call.arg(format!("--trailer={t}"));
        }
        let out = call.on_line(on_line).run().map_err(io_error)?;
        if !out.ok() {
            let mut e = from_output(&out, "commit");
            if let AppError::Git { kind, message, .. } = &mut e {
                if *kind == GitErrorKind::Failed && self.has_hooks(&exe, &repo) {
                    *kind = GitErrorKind::HookFailed;
                    *message = "A commit hook failed. Nothing was committed.".into();
                }
            }
            return Err(e);
        }
        self.status_of(&exe, &repo)
    }

    fn has_hooks(&self, exe: &Path, repo: &Repo) -> bool {
        let configured = self.call(exe, repo, Access::Read).args(["config", "--get", "core.hooksPath"]).run().is_ok_and(|o| o.ok());
        configured || ["pre-commit", "commit-msg", "prepare-commit-msg"].iter().any(|h| repo.common_dir.join("hooks").join(h).is_file())
    }

    // ---------- operations git stopped in ----------

    pub fn operation_continue(&self, project_id: &str, root: &Path, dirty: &[String]) -> AppResult<GitStatus> {
        let (exe, repo) = self.require(project_id, root)?;
        check_unsaved_any(dirty)?;
        let _g = self.lock_index(&repo)?;
        let current = self.status_of(&exe, &repo)?;
        let op = current.operation.as_ref().ok_or_else(|| AppError::Invalid("Nothing to continue.".into()))?;
        if current.parsed.entries.iter().any(|e| e.conflict.is_some()) {
            return Err(err(GitErrorKind::Unresolved, "Stage the fixed files first; some still have conflicts."));
        }
        let args: &[&str] = match op.kind {
            "rebase" => &["rebase", "--continue"],
            "merge" => &["commit", "--no-edit"],
            "cherry_pick" => &["cherry-pick", "--continue"],
            "revert" => &["revert", "--continue"],
            _ => &["am", "--continue"],
        };
        let out = self.call(&exe, &repo, Access::Write).args(args).timeout(None).run().map_err(io_error)?;
        // A rebase that stops again on the next commit isn't a failure.
        if !out.ok() && status::operation(&repo.git_dir).is_none() {
            return Err(from_output(&out, "continue"));
        }
        self.status_of(&exe, &repo)
    }

    pub fn operation_abort(&self, project_id: &str, root: &Path, dirty: &[String], confirmed: bool) -> AppResult<GitStatus> {
        if !confirmed {
            return Err(AppError::Invalid("Confirm aborting first".into()));
        }
        let (exe, repo) = self.require(project_id, root)?;
        check_unsaved_any(dirty)?;
        let _g = self.lock_index(&repo)?;
        let op = status::operation(&repo.git_dir).ok_or_else(|| AppError::Invalid("Nothing to abort.".into()))?;
        let args: &[&str] = match op.kind {
            "rebase" => &["rebase", "--abort"],
            "merge" => &["merge", "--abort"],
            "cherry_pick" => &["cherry-pick", "--abort"],
            "revert" => &["revert", "--abort"],
            _ => &["am", "--abort"],
        };
        self.write(self.call(&exe, &repo, Access::Write).args(args), "abort")?;
        self.status_of(&exe, &repo)
    }

    // ---------- helpers ----------

    /// Anything that writes the index, working tree or refs takes this.
    fn lock_index(&self, repo: &Repo) -> AppResult<RepoGuard> {
        self.locks(repo).index.try_lock_arc_for(LOCK_WAIT).ok_or_else(|| err(GitErrorKind::Busy, "Another Git action is still running."))
    }

    /// Fetch and push take this; reads never lock.
    fn lock_net(&self, repo: &Repo) -> AppResult<RepoGuard> {
        self.locks(repo).net.try_lock_arc_for(LOCK_WAIT).ok_or_else(|| err(GitErrorKind::Busy, "Another fetch or push is still running."))
    }

    fn write(&self, call: Call<'_>, what: &str) -> AppResult<Output> {
        let out = call.run().map_err(io_error)?;
        if !out.ok() {
            return Err(from_output(&out, what));
        }
        Ok(out)
    }

    fn register(&self, op_id: &str) -> Cancel {
        let c: Cancel = Arc::new(AtomicBool::new(false));
        self.ops.lock().insert(op_id.to_string(), Arc::clone(&c));
        c
    }

    fn unregister(&self, op_id: &str) {
        self.ops.lock().remove(op_id);
    }

    /// Stops a running fetch, pull or push.
    pub fn cancel(&self, op_id: &str) -> bool {
        match self.ops.lock().get(op_id) {
            Some(c) => {
                c.store(true, std::sync::atomic::Ordering::SeqCst);
                true
            }
            None => false,
        }
    }
}

type RepoGuard = parking_lot::ArcMutexGuard<parking_lot::RawMutex, ()>;

pub fn op_label(kind: &str) -> &'static str {
    match kind {
        "rebase" => "rebase",
        "merge" => "merge",
        "cherry_pick" => "cherry-pick",
        "revert" => "revert",
        _ => "patch",
    }
}

/// Repository-relative paths from the UI: no absolute paths, no `..`, no options.
fn check_paths(paths: &[String]) -> AppResult<()> {
    if paths.is_empty() {
        return Err(AppError::Invalid("No files given".into()));
    }
    for p in paths {
        let bad = p.is_empty()
            || p.starts_with('-')
            || p.starts_with('/')
            || p.starts_with('\\')
            || p.contains(':')
            || p.split(['/', '\\']).any(|s| s == "..")
            || p.chars().any(char::is_control);
        if bad {
            return Err(AppError::Invalid(format!("Not a path in this repository: {p}")));
        }
    }
    Ok(())
}

/// Refuses when any of the repository paths has unsaved editor changes.
/// `dirty` holds project-relative paths; `repo.prefix` maps them.
fn check_unsaved(repo: &Repo, paths: &[String], dirty: &[String]) -> AppResult<()> {
    let dirty: HashSet<String> = dirty.iter().map(|d| format!("{}{}", repo.prefix, d)).collect();
    let hit: Vec<String> = paths.iter().filter(|p| dirty.contains(*p)).cloned().collect();
    if hit.is_empty() {
        return Ok(());
    }
    Err(AppError::Git {
        kind: GitErrorKind::UnsavedBuffers,
        message: format!("Save or discard your editor changes to {} first.", names(&hit)),
        detail: Some(hit.join("\n")),
    })
}

fn check_unsaved_any(dirty: &[String]) -> AppResult<()> {
    if dirty.is_empty() {
        return Ok(());
    }
    Err(AppError::Git {
        kind: GitErrorKind::UnsavedBuffers,
        message: format!("Save or discard your editor changes to {} first.", names(dirty)),
        detail: Some(dirty.join("\n")),
    })
}

/// `Co-authored-by: Name <email>` on one line.
fn check_trailer(t: &str) -> AppResult<()> {
    let ok = t.starts_with("Co-authored-by: ")
        && !t.contains(['\n', '\r'])
        && t.ends_with('>')
        && t.contains(" <")
        && t.contains('@')
        && t.len() <= 200;
    if ok {
        Ok(())
    } else {
        Err(AppError::Invalid(format!("Not a co-author trailer: {t}")))
    }
}

fn has_markers(bytes: &[u8]) -> bool {
    let text = String::from_utf8_lossy(bytes);
    let mut open = false;
    for line in text.lines() {
        if line.starts_with("<<<<<<< ") || line == "<<<<<<<" {
            open = true;
        } else if open && (line.starts_with(">>>>>>> ") || line == ">>>>>>>") {
            return true;
        }
    }
    false
}

fn file_name(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

fn names(paths: &[String]) -> String {
    match paths {
        [one] => file_name(one).to_string(),
        [a, b] => format!("{} and {}", file_name(a), file_name(b)),
        [a, rest @ ..] => format!("{} and {} more", file_name(a), rest.len()),
        [] => String::new(),
    }
}

/// The path git suggests in its "dubious ownership" message.
fn safe_directory_from(detail: &str) -> Option<String> {
    let i = detail.find("safe.directory ")?;
    let rest = detail[i + "safe.directory ".len()..].trim_start();
    let rest = rest.trim_start_matches(['\'', '"']);
    let end = rest.find(['\'', '"', '\n']).unwrap_or(rest.len());
    let p = rest[..end].trim();
    (!p.is_empty()).then(|| p.to_string())
}
