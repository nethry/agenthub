//! Git failures as `AppError::Git { kind, message, detail }`. Kinds come from
//! git's own (LC_ALL=C) messages, or from AgentHub's guards.

use crate::chat::redact;
use crate::error::AppError;

use super::runner::Output;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GitErrorKind {
    NotFound,
    NotRepo,
    UnsafeRepo,
    Locked,
    Busy,
    Auth,
    HostKey,
    Network,
    WouldOverwrite,
    Identity,
    NothingToCommit,
    HookFailed,
    NoUpstream,
    NoRemote,
    Signing,
    PushRejected,
    PushRemoteRejected,
    Markers,
    PushedCommits,
    UnsavedBuffers,
    InProgress,
    Unresolved,
    Detached,
    Cancelled,
    Failed,
}

impl GitErrorKind {
    pub fn as_str(self) -> &'static str {
        match self {
            GitErrorKind::NotFound => "git_not_found",
            GitErrorKind::NotRepo => "git_not_repo",
            GitErrorKind::UnsafeRepo => "git_unsafe_repo",
            GitErrorKind::Locked => "git_locked",
            GitErrorKind::Busy => "git_busy",
            GitErrorKind::Auth => "git_auth",
            GitErrorKind::HostKey => "git_host_key",
            GitErrorKind::Network => "git_network",
            GitErrorKind::WouldOverwrite => "git_would_overwrite",
            GitErrorKind::Identity => "git_identity",
            GitErrorKind::NothingToCommit => "git_nothing_to_commit",
            GitErrorKind::HookFailed => "git_hook_failed",
            GitErrorKind::NoUpstream => "git_no_upstream",
            GitErrorKind::NoRemote => "git_no_remote",
            GitErrorKind::Signing => "git_signing",
            GitErrorKind::PushRejected => "git_push_rejected",
            GitErrorKind::PushRemoteRejected => "git_push_remote_rejected",
            GitErrorKind::Markers => "git_markers",
            GitErrorKind::PushedCommits => "git_pushed_commits",
            GitErrorKind::UnsavedBuffers => "git_unsaved_buffers",
            GitErrorKind::InProgress => "git_in_progress",
            GitErrorKind::Unresolved => "git_unresolved",
            GitErrorKind::Detached => "git_detached",
            GitErrorKind::Cancelled => "git_cancelled",
            GitErrorKind::Failed => "git_failed",
        }
    }
}

pub fn err(kind: GitErrorKind, message: impl Into<String>) -> AppError {
    AppError::Git { kind, message: message.into(), detail: None }
}

/// The kind of a failed git call, from its (C-locale) stderr.
pub fn classify(stderr: &str) -> GitErrorKind {
    let s = stderr;
    let has = |p: &str| s.contains(p);
    if has("not a git repository") {
        GitErrorKind::NotRepo
    } else if has("detected dubious ownership") {
        GitErrorKind::UnsafeRepo
    } else if has(".lock': File exists") || (has("Unable to create") && has(".lock")) {
        GitErrorKind::Locked
    } else if has("Host key verification failed") {
        GitErrorKind::HostKey
    } else if has("Authentication failed")
        || has("could not read Username")
        || has("could not read Password")
        || has("terminal prompts disabled")
        || has("Permission denied (publickey")
        || has("Invalid username or password")
    {
        GitErrorKind::Auth
    } else if has("Could not resolve host") || has("unable to access") || has("Connection timed out") || has("Could not read from remote repository") {
        GitErrorKind::Network
    } else if has("would be overwritten by") {
        GitErrorKind::WouldOverwrite
    } else if has("Please tell me who you are") || has("empty ident name") || has("unable to auto-detect email address") {
        GitErrorKind::Identity
    } else if has("nothing to commit") || has("no changes added to commit") {
        GitErrorKind::NothingToCommit
    } else if has("has no upstream branch") || has("no tracking information") {
        GitErrorKind::NoUpstream
    } else if has("gpg failed to sign") || has("failed to sign the data") {
        GitErrorKind::Signing
    } else {
        GitErrorKind::Failed
    }
}

fn friendly(kind: GitErrorKind, what: &str) -> String {
    match kind {
        GitErrorKind::NotRepo => "This folder isn't a Git repository.".into(),
        GitErrorKind::UnsafeRepo => "Git doesn't trust this folder (it's owned by another user).".into(),
        GitErrorKind::Locked => "Another Git process is using this repository (index.lock exists). Retry when it finishes.".into(),
        GitErrorKind::HostKey => "SSH doesn't know this host yet. Connect once from a terminal to accept its key.".into(),
        GitErrorKind::Auth => "Git couldn't sign in to the remote. Sign in with Git Credential Manager, or check your SSH key.".into(),
        GitErrorKind::Network => "Git couldn't reach the remote. Check your connection.".into(),
        GitErrorKind::WouldOverwrite => "Your local changes would be overwritten.".into(),
        GitErrorKind::Identity => "Git doesn't know who you are. Set user.name and user.email (git config --global).".into(),
        GitErrorKind::NothingToCommit => "Nothing staged to commit.".into(),
        GitErrorKind::NoUpstream => "This branch has no upstream. Publish it first.".into(),
        GitErrorKind::Signing => "Git couldn't sign the commit (gpg).".into(),
        _ => format!("Git couldn't {what}."),
    }
}

/// The `AppError` for a failed call: friendly message, redacted output as detail.
pub fn from_output(out: &Output, what: &str) -> AppError {
    if out.cancelled {
        return err(GitErrorKind::Cancelled, format!("Stopped: {what}"));
    }
    let kind = classify(&out.stderr);
    let detail = redact(&tail(&out.stderr, 1200), None);
    let detail = if detail.trim().is_empty() { None } else { Some(detail) };
    AppError::Git { kind, message: friendly(kind, what), detail }
}

pub fn io_error(e: std::io::Error) -> AppError {
    err(GitErrorKind::NotFound, format!("Couldn't start git: {e}"))
}

fn tail(s: &str, n: usize) -> String {
    let t = s.trim();
    if t.len() <= n {
        return t.to_string();
    }
    let mut start = t.len() - n;
    while !t.is_char_boundary(start) {
        start += 1;
    }
    format!("…{}", &t[start..])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_git_messages() {
        let cases = [
            ("fatal: not a git repository (or any of the parent directories): .git", GitErrorKind::NotRepo),
            ("fatal: detected dubious ownership in repository at 'D:/x'", GitErrorKind::UnsafeRepo),
            ("fatal: Unable to create 'C:/r/.git/index.lock': File exists.", GitErrorKind::Locked),
            ("fatal: could not read Username for 'https://github.com': terminal prompts disabled", GitErrorKind::Auth),
            ("ssh: Could not resolve hostname x\nfatal: Could not read from remote repository.", GitErrorKind::Network),
            ("error: Your local changes to the following files would be overwritten by checkout:\n\ta.txt", GitErrorKind::WouldOverwrite),
            ("Author identity unknown\n*** Please tell me who you are.", GitErrorKind::Identity),
            ("fatal: The current branch x has no upstream branch.", GitErrorKind::NoUpstream),
            ("Host key verification failed.", GitErrorKind::HostKey),
            ("something else", GitErrorKind::Failed),
        ];
        for (text, kind) in cases {
            assert_eq!(classify(text), kind, "{text}");
        }
    }
}
