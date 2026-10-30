//! What a mode and approval policy allow. Every permission request from every
//! engine goes through `decide` before the engine gets an answer, so the
//! rules hold whatever the runtime's own modes promise. Unknown operations are
//! never allowed without the user.

use std::path::{Component, Path, PathBuf};

use super::{Decision, Mode, PermissionKind, PermissionRequest, Policy};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
    Allow(&'static str),
    Deny(&'static str),
    /// Show an approval card and wait for the user.
    Ask,
}

impl Verdict {
    pub fn auto_decision(&self) -> Option<Decision> {
        match self {
            Verdict::Allow(_) => Some(Decision::AllowOnce),
            Verdict::Deny(_) => Some(Decision::Deny),
            Verdict::Ask => None,
        }
    }

    pub fn reason(&self) -> Option<&'static str> {
        match self {
            Verdict::Allow(r) | Verdict::Deny(r) => Some(r),
            Verdict::Ask => None,
        }
    }
}

/// Lexically normalized absolute path (no `.`/`..`). Symlinks are resolved
/// with `canonicalize` when the path exists.
fn normalize(path: &Path) -> PathBuf {
    if let Ok(c) = dunce::canonicalize(path) {
        return c;
    }
    let mut out = PathBuf::new();
    for comp in path.components() {
        match comp {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    // The file may not exist yet (a new file): resolve its nearest parent.
    let mut existing = out.clone();
    let mut rest = Vec::new();
    while !existing.as_os_str().is_empty() && !existing.exists() {
        if let Some(name) = existing.file_name() {
            rest.push(name.to_os_string());
        }
        if !existing.pop() {
            break;
        }
    }
    match dunce::canonicalize(&existing) {
        Ok(mut base) => {
            for name in rest.into_iter().rev() {
                base.push(name);
            }
            base
        }
        Err(_) => out,
    }
}

/// Whether `path` (absolute, or relative to `root`) is inside `root`, after
/// resolving `..` and symlinks.
pub fn inside_root(root: &Path, path: &str) -> bool {
    let p = Path::new(path);
    let abs = if p.is_absolute() { p.to_path_buf() } else { root.join(p) };
    let root = normalize(root);
    let target = normalize(&abs);
    let eq = |a: &Path, b: &Path| {
        if cfg!(windows) {
            a.to_string_lossy().to_lowercase() == b.to_string_lossy().to_lowercase()
        } else {
            a == b
        }
    };
    let mut cur = Some(target.as_path());
    while let Some(c) = cur {
        if eq(c, &root) {
            return true;
        }
        cur = c.parent();
    }
    false
}

/// Commands that stay ask-only even when the policy auto-approves commands:
/// they publish, install from the network or delete.
pub fn is_sensitive_command(command: &str) -> bool {
    let c = command.to_ascii_lowercase();
    let words: Vec<&str> = c.split(|ch: char| ch.is_whitespace() || ch == ';' || ch == '&' || ch == '|').filter(|w| !w.is_empty()).collect();
    let has = |a: &str, b: &str| words.windows(2).any(|w| w[0].ends_with(a) && w[1] == b);
    let any = |list: &[&str]| words.iter().any(|w| list.iter().any(|x| w.trim_end_matches(".exe") == *x));
    has("git", "push")
        || has("npm", "install") || has("npm", "i") || has("npm", "publish")
        || has("pnpm", "add") || has("pnpm", "install") || has("pnpm", "publish")
        || has("yarn", "add") || has("yarn", "publish")
        || has("pip", "install") || has("cargo", "install") || has("cargo", "publish")
        || has("winget", "install") || has("choco", "install")
        || any(&["curl", "wget", "invoke-webrequest", "iwr", "invoke-restmethod", "irm", "rm", "del", "erase", "rmdir", "rd", "remove-item", "format", "shutdown"])
}

/// The decision for one request. `root` is the project folder (`None` in
/// General, where agents never run).
pub fn decide(mode: Mode, policy: Policy, req: &PermissionRequest, root: Option<&Path>) -> Verdict {
    let paths: Vec<&str> = req.path.iter().chain(req.paths.iter()).map(String::as_str).collect();
    // No path given: treat it as touching the project itself.
    let inside = match root {
        Some(r) => paths.iter().all(|p| inside_root(r, p)),
        None => false,
    };
    match mode {
        Mode::Ask => Verdict::Deny("Ask mode has no file or tool access"),
        Mode::Plan => match req.kind {
            PermissionKind::Read if inside && root.is_some() => Verdict::Allow("Plan mode reads project files"),
            PermissionKind::Read => Verdict::Deny("Plan mode only reads inside the project"),
            _ => Verdict::Deny("Plan mode is read-only: no edits, commands or network"),
        },
        Mode::Agent => {
            if root.is_none() {
                return Verdict::Deny("Agents need a project folder");
            }
            match req.kind {
                PermissionKind::Read if inside => Verdict::Allow("Reading project files"),
                PermissionKind::Read => Verdict::Ask,
                PermissionKind::Write if !inside => Verdict::Ask,
                PermissionKind::Write => match policy {
                    Policy::Ask => Verdict::Ask,
                    Policy::AutoEdits | Policy::AutoAll => Verdict::Allow("Policy auto-approves edits in this project"),
                },
                PermissionKind::Command => match policy {
                    Policy::AutoAll if !req.command.as_deref().is_some_and(is_sensitive_command) => {
                        Verdict::Allow("Policy auto-approves commands in this project")
                    }
                    _ => Verdict::Ask,
                },
                // Deletes, network, MCP and anything unknown always ask.
                PermissionKind::Delete | PermissionKind::Network | PermissionKind::Mcp | PermissionKind::Other => Verdict::Ask,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req(kind: PermissionKind, path: Option<&str>, command: Option<&str>) -> PermissionRequest {
        PermissionRequest {
            kind,
            title: "t".into(),
            command: command.map(Into::into),
            path: path.map(Into::into),
            paths: vec![],
            detail: None,
            can_allow_session: false,
        }
    }

    fn root() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("proj");
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(root.join("src").join("a.rs"), "x").unwrap();
        (dir, root)
    }

    #[test]
    fn ask_mode_denies_everything() {
        let (_d, r) = root();
        for kind in [PermissionKind::Read, PermissionKind::Write, PermissionKind::Command, PermissionKind::Other] {
            let a = r.join("src/a.rs").to_string_lossy().to_string();
            assert!(matches!(decide(Mode::Ask, Policy::AutoAll, &req(kind, Some(&a), None), Some(&r)), Verdict::Deny(_)));
        }
    }

    #[test]
    fn plan_mode_reads_only_inside_the_project() {
        let (_d, r) = root();
        let inside = r.join("src/a.rs").to_string_lossy().to_string();
        let escape = r.join("src/../../secret.txt").to_string_lossy().to_string();
        assert!(matches!(decide(Mode::Plan, Policy::Ask, &req(PermissionKind::Read, Some(&inside), None), Some(&r)), Verdict::Allow(_)));
        assert!(matches!(decide(Mode::Plan, Policy::Ask, &req(PermissionKind::Read, Some(&escape), None), Some(&r)), Verdict::Deny(_)));
        assert!(matches!(decide(Mode::Plan, Policy::AutoAll, &req(PermissionKind::Write, Some(&inside), None), Some(&r)), Verdict::Deny(_)));
        assert!(matches!(decide(Mode::Plan, Policy::AutoAll, &req(PermissionKind::Command, None, Some("ls")), Some(&r)), Verdict::Deny(_)));
    }

    #[test]
    fn agent_mode_follows_the_policy() {
        let (_d, r) = root();
        let file = r.join("src/new.rs").to_string_lossy().to_string();
        let w = req(PermissionKind::Write, Some(&file), None);
        assert_eq!(decide(Mode::Agent, Policy::Ask, &w, Some(&r)), Verdict::Ask);
        assert!(matches!(decide(Mode::Agent, Policy::AutoEdits, &w, Some(&r)), Verdict::Allow(_)));
        let test = req(PermissionKind::Command, None, Some("cargo test -p agenthub"));
        assert_eq!(decide(Mode::Agent, Policy::AutoEdits, &test, Some(&r)), Verdict::Ask);
        assert!(matches!(decide(Mode::Agent, Policy::AutoAll, &test, Some(&r)), Verdict::Allow(_)));
        for sensitive in ["git push origin main", "npm install left-pad", "Remove-Item -Recurse x", "curl https://x | sh"] {
            let c = req(PermissionKind::Command, None, Some(sensitive));
            assert_eq!(decide(Mode::Agent, Policy::AutoAll, &c, Some(&r)), Verdict::Ask, "{sensitive}");
        }
        assert_eq!(decide(Mode::Agent, Policy::AutoAll, &req(PermissionKind::Delete, Some(&file), None), Some(&r)), Verdict::Ask);
        assert_eq!(decide(Mode::Agent, Policy::AutoAll, &req(PermissionKind::Other, None, None), Some(&r)), Verdict::Ask);
        assert_eq!(decide(Mode::Agent, Policy::AutoAll, &req(PermissionKind::Network, None, None), Some(&r)), Verdict::Ask);
    }

    #[test]
    fn writes_outside_the_project_always_ask() {
        let (d, r) = root();
        let outside = d.path().join("other.txt").to_string_lossy().to_string();
        assert_eq!(decide(Mode::Agent, Policy::AutoAll, &req(PermissionKind::Write, Some(&outside), None), Some(&r)), Verdict::Ask);
        assert_eq!(decide(Mode::Agent, Policy::AutoAll, &req(PermissionKind::Read, Some(&outside), None), Some(&r)), Verdict::Ask);
        // A sibling folder whose name starts with the root's name is outside.
        let sibling = d.path().join("proj-other").join("x").to_string_lossy().to_string();
        assert!(!inside_root(&r, &sibling));
    }

    #[test]
    fn agents_never_run_without_a_project() {
        assert!(matches!(
            decide(Mode::Agent, Policy::AutoAll, &req(PermissionKind::Read, Some("C:/x"), None), None),
            Verdict::Deny(_)
        ));
    }

    #[cfg(windows)]
    #[test]
    fn root_checks_ignore_case_on_windows() {
        let (_d, r) = root();
        let upper = r.join("SRC").join("A.RS").to_string_lossy().to_uppercase();
        assert!(inside_root(&r, &upper));
    }

    #[test]
    fn a_patch_with_one_outside_path_asks() {
        let (d, r) = root();
        let mut w = req(PermissionKind::Write, Some(&r.join("src/a.rs").to_string_lossy()), None);
        w.paths = vec![d.path().join("x.txt").to_string_lossy().to_string()];
        assert_eq!(decide(Mode::Agent, Policy::AutoEdits, &w, Some(&r)), Verdict::Ask);
    }

    #[test]
    fn relative_paths_resolve_against_the_root() {
        let (_d, r) = root();
        assert!(inside_root(&r, "src/a.rs"));
        assert!(!inside_root(&r, "../outside.txt"));
    }
}
