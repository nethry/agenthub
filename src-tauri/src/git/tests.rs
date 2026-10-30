//! Integration tests with the real `git` in temp folders. They isolate git's
//! config (no user hooks, signing or autocrlf leak in) and use a local bare
//! "origin", so they run offline. Skipped with a note when git is missing.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;

use parking_lot::Mutex;
use tempfile::TempDir;

use super::*;

struct Fixture {
    _dir: TempDir,
    root: PathBuf,
    origin: PathBuf,
    env: Vec<(OsString, OsString)>,
    trashed: Arc<Mutex<Vec<PathBuf>>>,
    git: GitService,
}

fn git_available() -> bool {
    exe::probe(None).1.ok
}

impl Fixture {
    fn new() -> Option<Self> {
        if !git_available() {
            eprintln!("git not found or too old: skipping git integration test");
            return None;
        }
        let dir = tempfile::tempdir().unwrap();
        let base = dunce::canonicalize(dir.path()).unwrap();
        let config = base.join("gitconfig");
        std::fs::write(
            &config,
            "[user]\n\tname = Test User\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n[core]\n\tautocrlf = false\n[commit]\n\tgpgsign = false\n",
        )
        .unwrap();
        let env: Vec<(OsString, OsString)> = vec![
            ("GIT_CONFIG_GLOBAL".into(), config.into_os_string()),
            ("GIT_CONFIG_NOSYSTEM".into(), "1".into()),
        ];
        let root = base.join("work");
        let origin = base.join("origin.git");
        std::fs::create_dir_all(&root).unwrap();
        let trashed = Arc::new(Mutex::new(Vec::new()));
        let bin = base.join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let t = Arc::clone(&trashed);
        let trash: TrashFn = Box::new(move |p: &Path| {
            let to = bin.join(format!("{}-{}", t.lock().len(), p.file_name().unwrap().to_string_lossy()));
            std::fs::rename(p, &to).map_err(|e| e.to_string())?;
            t.lock().push(to);
            Ok(())
        });
        let db = Arc::new(Db::open_in_memory().unwrap());
        let git = GitService::with(db, Arc::new(|_| {}), env.clone(), trash);
        let f = Fixture { _dir: dir, root, origin, env, trashed, git };
        f.run(&f.root, &["init", "-q", "-b", "main"]);
        Some(f)
    }

    fn run(&self, cwd: &Path, args: &[&str]) -> String {
        let out = Command::new("git").args(args).current_dir(cwd).envs(self.env.iter().cloned()).output().unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8_lossy(&out.stdout).into_owned()
    }

    fn sh(&self, args: &[&str]) -> String {
        self.run(&self.root, args)
    }

    fn write(&self, rel: &str, text: &str) {
        let p = self.root.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, text).unwrap();
    }

    fn read(&self, rel: &str) -> String {
        std::fs::read_to_string(self.root.join(rel)).unwrap()
    }

    fn commit_all(&self, msg: &str) {
        self.sh(&["add", "-A"]);
        self.sh(&["commit", "-q", "-m", msg]);
    }

    /// A bare origin with `main` pushed and tracked.
    fn with_origin(&self) {
        self.run(self.root.parent().unwrap(), &["init", "-q", "--bare", "-b", "main", self.origin.to_str().unwrap()]);
        self.sh(&["remote", "add", "origin", self.origin.to_str().unwrap()]);
        self.sh(&["push", "-q", "-u", "origin", "main"]);
    }

    /// Another clone of origin, for commits that "someone else" pushes.
    fn other_clone(&self) -> PathBuf {
        let other = self.root.parent().unwrap().join("other");
        self.run(self.root.parent().unwrap(), &["clone", "-q", self.origin.to_str().unwrap(), other.to_str().unwrap()]);
        other
    }

    fn status(&self) -> GitStatus {
        self.git.status("p", &self.root).unwrap()
    }
}

fn no_progress(_: GitProgress) {}

fn entry<'a>(s: &'a GitStatus, path: &str) -> &'a StatusEntry {
    s.parsed.entries.iter().find(|e| e.path == path).unwrap_or_else(|| panic!("no entry {path}"))
}

#[test]
fn reports_not_a_repository() {
    if !git_available() {
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let git = GitService::with(Arc::new(Db::open_in_memory().unwrap()), Arc::new(|_| {}), vec![], Box::new(|_| Ok(())));
    assert_eq!(git.status("p", dir.path()).unwrap().state, "none");
}

#[test]
fn stages_unstages_and_discards_whole_files() {
    let Some(f) = Fixture::new() else { return };
    f.write("a.txt", "one\n");
    f.write("b.txt", "two\n");
    f.commit_all("init");
    f.write("a.txt", "one changed\n");
    f.write("new.txt", "fresh\n");

    let s = f.status();
    assert_eq!(s.state, "ok");
    assert_eq!(s.parsed.head.branch.as_deref(), Some("main"));
    assert_eq!(entry(&s, "a.txt").worktree, 'M');
    assert!(entry(&s, "new.txt").untracked);

    let s = f.git.stage("p", &f.root, &["a.txt".into(), "new.txt".into()], false).unwrap();
    assert_eq!(entry(&s, "a.txt").index, 'M');
    assert_eq!(entry(&s, "new.txt").index, 'A');
    let s = f.git.unstage("p", &f.root, &["new.txt".into()]).unwrap();
    assert!(entry(&s, "new.txt").untracked);

    // Unsaved editor changes block a discard of that file.
    let e = f.git.discard("p", &f.root, &["a.txt".into()], &["a.txt".into()], true).unwrap_err();
    assert_eq!(e.kind(), "git_unsaved_buffers");

    // Staged a.txt, then edit again: discard drops only the unstaged part.
    f.write("a.txt", "one changed twice\n");
    let s = f.git.discard("p", &f.root, &["a.txt".into(), "new.txt".into()], &[], true).unwrap();
    assert_eq!(f.read("a.txt"), "one changed\n", "back to the staged version");
    assert!(!f.root.join("new.txt").exists());
    assert_eq!(f.trashed.lock().len(), 2, "both went to the Recycle Bin first");
    assert_eq!(entry(&s, "a.txt").index, 'M');
    assert!(s.parsed.entries.iter().all(|e| e.path != "new.txt"));

    let s = f.git.unstage_all("p", &f.root).unwrap();
    assert_eq!(entry(&s, "a.txt").index, '.');
    let s = f.git.stage_all("p", &f.root).unwrap();
    assert_eq!(entry(&s, "a.txt").index, 'M');
}

#[test]
fn commits_with_a_trailer_and_guards_amend() {
    let Some(f) = Fixture::new() else { return };
    f.write("a.txt", "one\n");
    f.commit_all("init");
    f.with_origin();
    f.write("a.txt", "two\n");
    f.git.stage("p", &f.root, &["a.txt".into()], false).unwrap();
    let trailer = "Co-authored-by: OpenAI Codex <noreply@openai.com>".to_string();
    let s = f.git.commit("p", &f.root, "feat: two", false, &[trailer], &|_| {}).unwrap();
    assert_eq!(s.parsed.ahead, 1);
    assert!(!s.head_pushed);
    let msg = f.git.head_message("p", &f.root).unwrap();
    assert!(msg.starts_with("feat: two"), "{msg}");
    assert!(msg.contains("Co-authored-by: OpenAI Codex <noreply@openai.com>"), "{msg}");
    assert!(f.git.commit("p", &f.root, "x", false, &["Co-authored-by: x\nevil".into()], &|_| {}).is_err());

    // Amending an unpushed commit is fine; after a push it's refused.
    let s = f.git.commit("p", &f.root, "feat: two, amended", true, &[], &|_| {}).unwrap();
    assert_eq!(s.parsed.ahead, 1);
    f.git.push("p", &f.root, "op1", &no_progress).unwrap();
    let e = f.git.commit("p", &f.root, "again", true, &[], &|_| {}).unwrap_err();
    assert_eq!(e.kind(), "git_pushed_commits");
}

#[test]
fn a_failing_hook_reports_hook_failed() {
    let Some(f) = Fixture::new() else { return };
    f.write("a.txt", "one\n");
    f.commit_all("init");
    let hook = f.root.join(".git").join("hooks").join("pre-commit");
    std::fs::write(&hook, "#!/bin/sh\necho lint failed >&2\nexit 1\n").unwrap();
    f.write("a.txt", "two\n");
    f.git.stage("p", &f.root, &["a.txt".into()], false).unwrap();
    let lines = Mutex::new(Vec::<String>::new());
    let e = f.git.commit("p", &f.root, "feat", false, &[], &|l| lines.lock().push(l.to_string())).unwrap_err();
    assert_eq!(e.kind(), "git_hook_failed");
    assert!(lines.lock().iter().any(|l| l.contains("lint failed")), "hook output streamed");
}

#[test]
fn rejected_push_then_pull_and_push_gives_linear_history() {
    let Some(f) = Fixture::new() else { return };
    f.write("a.txt", "one\n");
    f.commit_all("init");
    f.with_origin();
    let other = f.other_clone();
    std::fs::write(other.join("b.txt"), "theirs\n").unwrap();
    f.run(&other, &["add", "-A"]);
    f.run(&other, &["commit", "-q", "-m", "theirs"]);
    f.run(&other, &["push", "-q"]);

    f.write("c.txt", "mine\n");
    f.commit_all("mine");
    let e = f.git.push("p", &f.root, "op1", &no_progress).unwrap_err();
    assert_eq!(e.kind(), "git_push_rejected");

    // Uncommitted work is autostashed through the rebase.
    f.write("a.txt", "local edit\n");
    let s = f.git.pull("p", &f.root, "op2", &[], &no_progress).unwrap();
    assert!(s.operation.is_none());
    assert_eq!((s.parsed.ahead, s.parsed.behind), (1, 0));
    assert_eq!(f.read("a.txt"), "local edit\n");
    let s = f.git.push("p", &f.root, "op3", &no_progress).unwrap();
    assert_eq!(s.parsed.ahead, 0);
    let log = f.sh(&["log", "--format=%s", "--first-parent"]);
    assert_eq!(log.lines().collect::<Vec<_>>(), vec!["mine", "theirs", "init"]);
    assert!(f.sh(&["log", "--merges", "--format=%H"]).trim().is_empty(), "no merge commit");
}

#[test]
fn a_pull_conflict_pauses_then_continues_or_aborts() {
    let Some(f) = Fixture::new() else { return };
    f.write("a.txt", "base\n");
    f.commit_all("init");
    f.with_origin();
    let other = f.other_clone();
    std::fs::write(other.join("a.txt"), "theirs\n").unwrap();
    f.run(&other, &["commit", "-q", "-am", "theirs"]);
    f.run(&other, &["push", "-q"]);
    f.write("a.txt", "mine\n");
    f.commit_all("mine");

    let s = f.git.pull("p", &f.root, "op", &[], &no_progress).unwrap();
    let op = s.operation.clone().expect("paused rebase");
    assert_eq!(op.kind, "rebase");
    assert_eq!(entry(&s, "a.txt").conflict.as_deref(), Some("UU"));
    // Unsaved buffers, unresolved files and leftover markers are refused.
    assert_eq!(f.git.operation_continue("p", &f.root, &["a.txt".into()]).unwrap_err().kind(), "git_unsaved_buffers");
    assert_eq!(f.git.operation_continue("p", &f.root, &[]).unwrap_err().kind(), "git_unresolved");
    assert_eq!(f.git.stage("p", &f.root, &["a.txt".into()], false).unwrap_err().kind(), "git_markers");
    assert_eq!(f.git.push("p", &f.root, "x", &no_progress).unwrap_err().kind(), "git_in_progress");

    f.write("a.txt", "mine and theirs\n");
    f.git.stage("p", &f.root, &["a.txt".into()], false).unwrap();
    let s = f.git.operation_continue("p", &f.root, &[]).unwrap();
    assert!(s.operation.is_none());
    assert_eq!(f.read("a.txt"), "mine and theirs\n");
    assert_eq!(s.parsed.ahead, 1);

    // A second conflict, aborted this time.
    std::fs::write(other.join("a.txt"), "theirs again\n").unwrap();
    f.run(&other, &["commit", "-q", "-am", "theirs again"]);
    f.run(&other, &["push", "-q"]);
    f.write("a.txt", "mine again\n");
    f.commit_all("mine again");
    let s = f.git.pull("p", &f.root, "op", &[], &no_progress).unwrap();
    assert!(s.operation.is_some());
    assert!(f.git.operation_abort("p", &f.root, &[], false).is_err(), "needs confirmation");
    let s = f.git.operation_abort("p", &f.root, &[], true).unwrap();
    assert!(s.operation.is_none());
    assert_eq!(f.read("a.txt"), "mine again\n");
}

#[test]
fn publishes_a_new_branch_and_reports_no_upstream() {
    let Some(f) = Fixture::new() else { return };
    f.write("a.txt", "one\n");
    f.commit_all("init");
    f.with_origin();
    f.sh(&["switch", "-q", "-c", "feature/x"]);
    f.write("a.txt", "two\n");
    f.commit_all("feature");
    assert_eq!(f.git.push("p", &f.root, "op", &no_progress).unwrap_err().kind(), "git_no_upstream");
    assert_eq!(f.git.pull("p", &f.root, "op", &[], &no_progress).unwrap_err().kind(), "git_no_upstream");
    let s = f.git.publish("p", &f.root, "op", &no_progress).unwrap();
    assert_eq!(s.parsed.upstream.as_deref(), Some("origin/feature/x"));
    assert_eq!(s.parsed.ahead, 0);
    assert!(s.head_pushed);
    let s = f.git.fetch("p", &f.root, "op", &no_progress).unwrap();
    assert!(s.last_fetch.is_some());
}

#[test]
fn watcher_reports_index_and_head_changes() {
    let Some(f) = Fixture::new() else { return };
    f.write("a.txt", "one\n");
    f.commit_all("init");
    let seen = Arc::new(Mutex::new(Vec::<&'static str>::new()));
    let s = Arc::clone(&seen);
    let git = GitService::with(
        Arc::new(Db::open_in_memory().unwrap()),
        Arc::new(move |c: watch::GitChanged| s.lock().extend(c.kinds)),
        f.env.clone(),
        Box::new(|_| Ok(())),
    );
    git.status("p", &f.root).unwrap();
    std::thread::sleep(std::time::Duration::from_millis(300));
    f.write("a.txt", "two\n");
    f.commit_all("second");
    let start = std::time::Instant::now();
    while start.elapsed() < std::time::Duration::from_secs(5) {
        let k = seen.lock().clone();
        if k.contains(&"index") && (k.contains(&"head") || k.contains(&"refs")) {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    panic!("watcher saw {:?}", seen.lock());
}
