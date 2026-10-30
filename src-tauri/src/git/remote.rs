//! Fetch, pull (rebase + autostash), push (never forced) and publish.

use std::path::Path;
use std::time::{Duration, Instant};

use parking_lot::Mutex;

use super::error::{err, from_output, io_error, GitErrorKind};
use super::runner::Access;
use super::{check_unsaved_any, GitProgress, GitService, GitStatus, Repo};
use crate::chat::redact;
use crate::error::{AppError, AppResult};

/// How often progress lines reach the UI.
const PROGRESS_EVERY: Duration = Duration::from_millis(100);

/// One ref line of `git push --porcelain`.
#[derive(Debug, Clone, PartialEq)]
pub struct PushRef {
    pub flag: char,
    pub summary: String,
    pub reason: Option<String>,
}

/// `<flag>\t<from>:<to>\t<summary> (<reason>)` lines; other lines are skipped.
pub fn parse_push(stdout: &str) -> Vec<PushRef> {
    stdout
        .lines()
        .filter_map(|line| {
            let mut parts = line.splitn(3, '\t');
            let flag = parts.next()?;
            let _refs = parts.next()?;
            let rest = parts.next()?;
            let flag = flag.chars().next()?;
            let (summary, reason) = match rest.find(" (") {
                Some(i) if rest.ends_with(')') => (rest[..i].to_string(), Some(rest[i + 2..rest.len() - 1].to_string())),
                _ => (rest.to_string(), None),
            };
            Some(PushRef { flag, summary, reason })
        })
        .collect()
}

/// `Receiving objects:  45% (9/20)` → 45.
pub fn progress_percent(line: &str) -> Option<u8> {
    let i = line.find("% ")?;
    let digits: String = line[..i].chars().rev().take_while(|c| c.is_ascii_digit()).collect();
    digits.chars().rev().collect::<String>().parse().ok()
}

/// Throttles progress lines to the UI.
struct Progress<'a> {
    send: &'a (dyn Fn(GitProgress) + Sync),
    last: Mutex<Option<Instant>>,
}

impl<'a> Progress<'a> {
    fn new(send: &'a (dyn Fn(GitProgress) + Sync)) -> Self {
        Self { send, last: Mutex::new(None) }
    }
    fn line(&self, line: &str) {
        let mut last = self.last.lock();
        if last.is_some_and(|t| t.elapsed() < PROGRESS_EVERY) {
            return;
        }
        *last = Some(Instant::now());
        (self.send)(GitProgress { line: redact(line, None), percent: progress_percent(line) });
    }
}

impl GitService {
    fn config(&self, exe: &Path, repo: &Repo, key: &str) -> Option<String> {
        self.call(exe, repo, Access::Read)
            .args(["config", "--get", key])
            .run()
            .ok()
            .filter(|o| o.ok())
            .map(|o| o.text().trim().to_string())
            .filter(|s| !s.is_empty())
    }

    /// `(remote, merge ref)` of the current branch.
    fn upstream_of(&self, exe: &Path, repo: &Repo, branch: &str) -> Option<(String, String)> {
        let remote = self.config(exe, repo, &format!("branch.{branch}.remote"))?;
        let merge = self.config(exe, repo, &format!("branch.{branch}.merge"))?;
        Some((remote, merge))
    }

    pub fn fetch(&self, project_id: &str, root: &Path, op_id: &str, send: &(dyn Fn(GitProgress) + Sync)) -> AppResult<GitStatus> {
        let (exe, repo) = self.require(project_id, root)?;
        let _net = self.lock_net(&repo)?;
        let cancel = self.register(op_id);
        let progress = Progress::new(send);
        let on_line = |l: &str| progress.line(l);
        let out = self
            .call(&exe, &repo, Access::Network { interactive: true })
            .args(["fetch", "--all", "--prune", "--progress"])
            .timeout(None)
            .on_line(&on_line)
            .cancel(cancel)
            .run();
        self.unregister(op_id);
        let out = out.map_err(io_error)?;
        if !out.ok() {
            return Err(from_output(&out, "fetch"));
        }
        self.status_of(&exe, &repo)
    }

    /// Fetches the upstream, then fast-forwards or rebases local commits onto
    /// it with autostash. A conflict leaves the rebase paused for the banner.
    pub fn pull(&self, project_id: &str, root: &Path, op_id: &str, dirty: &[String], send: &(dyn Fn(GitProgress) + Sync)) -> AppResult<GitStatus> {
        let (exe, repo) = self.require(project_id, root)?;
        check_unsaved_any(dirty)?;
        self.check_no_operation(&repo)?;
        let before = self.status_of(&exe, &repo)?;
        let branch = before.parsed.head.branch.clone().ok_or_else(|| err(GitErrorKind::Detached, "Detached HEAD: there is no branch to pull."))?;
        let (remote, _) = self.upstream_of(&exe, &repo, &branch).ok_or_else(|| err(GitErrorKind::NoUpstream, "This branch has no upstream. Publish it first."))?;
        {
            let _net = self.lock_net(&repo)?;
            let cancel = self.register(op_id);
            let progress = Progress::new(send);
            let on_line = |l: &str| progress.line(l);
            let out = self
                .call(&exe, &repo, Access::Network { interactive: true })
                .args(["fetch", "--progress", "--"])
                .arg(&remote)
                .timeout(None)
                .on_line(&on_line)
                .cancel(cancel)
                .run();
            self.unregister(op_id);
            let out = out.map_err(io_error)?;
            if !out.ok() {
                return Err(from_output(&out, "fetch"));
            }
        }
        let _g = self.lock_index(&repo)?;
        let now = self.status_of(&exe, &repo)?;
        if now.parsed.behind == 0 {
            return Ok(now);
        }
        let args: &[&str] = if now.parsed.ahead == 0 { &["merge", "--ff-only", "--autostash", "@{upstream}"] } else { &["rebase", "--autostash"] };
        let out = self.call(&exe, &repo, Access::Write).args(args).timeout(None).run().map_err(io_error)?;
        if !out.ok() && super::status::operation(&repo.git_dir).is_none() {
            return Err(from_output(&out, "pull"));
        }
        self.status_of(&exe, &repo)
    }

    pub fn push(&self, project_id: &str, root: &Path, op_id: &str, send: &(dyn Fn(GitProgress) + Sync)) -> AppResult<GitStatus> {
        let (exe, repo) = self.require(project_id, root)?;
        self.check_no_operation(&repo)?;
        let status = self.status_of(&exe, &repo)?;
        let branch = status.parsed.head.branch.clone().ok_or_else(|| err(GitErrorKind::Detached, "Nothing to push from a detached HEAD."))?;
        let (remote, merge) = self.upstream_of(&exe, &repo, &branch).ok_or_else(|| err(GitErrorKind::NoUpstream, "This branch has no upstream. Publish it first."))?;
        self.push_refspec(&exe, &repo, op_id, &remote, &format!("refs/heads/{branch}:{merge}"), false, send)
    }

    /// Pushes a branch that has no upstream yet and sets it (`push -u`).
    pub fn publish(&self, project_id: &str, root: &Path, op_id: &str, send: &(dyn Fn(GitProgress) + Sync)) -> AppResult<GitStatus> {
        let (exe, repo) = self.require(project_id, root)?;
        self.check_no_operation(&repo)?;
        let status = self.status_of(&exe, &repo)?;
        let branch = status.parsed.head.branch.clone().ok_or_else(|| err(GitErrorKind::Detached, "Detached HEAD: create a branch first."))?;
        let remote = status
            .remotes
            .iter()
            .find(|r| *r == "origin")
            .or_else(|| status.remotes.first())
            .cloned()
            .ok_or_else(|| err(GitErrorKind::NoRemote, "This repository has no remote. Add one in a terminal: git remote add origin <url>"))?;
        self.push_refspec(&exe, &repo, op_id, &remote, &format!("refs/heads/{branch}:refs/heads/{branch}"), true, send)
    }

    #[allow(clippy::too_many_arguments)]
    fn push_refspec(
        &self,
        exe: &Path,
        repo: &Repo,
        op_id: &str,
        remote: &str,
        refspec: &str,
        set_upstream: bool,
        send: &(dyn Fn(GitProgress) + Sync),
    ) -> AppResult<GitStatus> {
        if !super::runner::safe_rev(remote) || refspec.starts_with('+') || refspec.starts_with('-') {
            return Err(AppError::Invalid("Bad push target".into()));
        }
        let _net = self.lock_net(repo)?;
        let cancel = self.register(op_id);
        let progress = Progress::new(send);
        let on_line = |l: &str| progress.line(l);
        let mut call = self.call(exe, repo, Access::Network { interactive: true }).args(["push", "--porcelain", "--progress"]);
        if set_upstream {
            call = call.arg("-u");
        }
        let out = call.arg(remote).arg(refspec).timeout(None).on_line(&on_line).cancel(cancel).run();
        self.unregister(op_id);
        let out = out.map_err(io_error)?;
        if !out.ok() {
            let refs = parse_push(&out.text());
            if let Some(r) = refs.iter().find(|r| r.flag == '!') {
                let reason = r.reason.clone().unwrap_or_default();
                if r.summary.contains("remote rejected") {
                    return Err(AppError::Git {
                        kind: GitErrorKind::PushRemoteRejected,
                        message: format!("The remote refused the push: {}", redact(&reason, None)),
                        detail: None,
                    });
                }
                return Err(AppError::Git {
                    kind: GitErrorKind::PushRejected,
                    message: "Push rejected: the remote has commits you don't have. Pull with rebase, then push again.".into(),
                    detail: Some(reason),
                });
            }
            return Err(from_output(&out, "push"));
        }
        self.status_of(exe, repo)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_push_porcelain() {
        let out = "To https://github.com/org/repo.git\n!\trefs/heads/main:refs/heads/main\t[rejected] (fetch first)\nDone\n";
        let refs = parse_push(out);
        assert_eq!(refs, vec![PushRef { flag: '!', summary: "[rejected]".into(), reason: Some("fetch first".into()) }]);
        let ok = parse_push("To x\n \trefs/heads/main:refs/heads/main\t1a2b3c4..5d6e7f8\nDone\n");
        assert_eq!(ok[0].flag, ' ');
        let remote = parse_push("!\trefs/heads/main:refs/heads/main\t[remote rejected] (protected branch hook declined)\n");
        assert_eq!(remote[0].summary, "[remote rejected]");
        assert_eq!(remote[0].reason.as_deref(), Some("protected branch hook declined"));
    }

    #[test]
    fn reads_progress_percent() {
        assert_eq!(progress_percent("Receiving objects:  45% (9/20)"), Some(45));
        assert_eq!(progress_percent("remote: Counting objects: 100% (3/3), done."), Some(100));
        assert_eq!(progress_percent("To github.com:org/repo.git"), None);
    }
}
