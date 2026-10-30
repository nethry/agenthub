//! Finds the system `git` (Git for Windows' `cmd\git.exe` preferred) and checks its version.

use std::path::{Path, PathBuf};

use serde::Serialize;

/// Oldest Git AgentHub supports (`for-each-ref %(ahead-behind)`, `fetch --porcelain`).
pub const MIN_VERSION: (u32, u32) = (2, 41);

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitInfo {
    pub path: Option<String>,
    pub version: Option<String>,
    /// Usable: found and new enough.
    pub ok: bool,
    pub reason: Option<String>,
    /// The path comes from Settings › Git, not from PATH.
    pub overridden: bool,
}

/// Where to look, in order: the override, PATH, then the usual install folders.
pub fn candidates(override_path: Option<&Path>) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(p) = override_path {
        out.push(p.to_path_buf());
        return out;
    }
    if let Some(p) = crate::terminals::shells::resolve_executable("git") {
        out.push(prefer_cmd_wrapper(&p));
    }
    #[cfg(windows)]
    for var in ["ProgramFiles", "ProgramW6432", "LocalAppData"] {
        if let Some(base) = std::env::var_os(var) {
            let base = PathBuf::from(base);
            let dir = if var == "LocalAppData" { base.join("Programs").join("Git") } else { base.join("Git") };
            out.push(dir.join("cmd").join("git.exe"));
        }
    }
    out
}

/// `…\Git\mingw64\bin\git.exe` → `…\Git\cmd\git.exe` when it exists: the
/// wrapper sets up PATH so hooks and `sh` work.
fn prefer_cmd_wrapper(p: &Path) -> PathBuf {
    let wrapper = p
        .parent()
        .and_then(Path::parent)
        .and_then(Path::parent)
        .filter(|_| p.parent().and_then(Path::file_name).is_some_and(|n| n.eq_ignore_ascii_case("bin")))
        .map(|root| root.join("cmd").join("git.exe"));
    match wrapper {
        Some(w) if w.is_file() => w,
        _ => p.to_path_buf(),
    }
}

/// `git version 2.56.0.windows.4` → (2, 56).
pub fn parse_version(text: &str) -> Option<(u32, u32)> {
    let rest = text.trim().strip_prefix("git version ")?;
    let mut parts = rest.split(|c: char| !c.is_ascii_digit());
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    Some((major, minor))
}

/// The first usable git among the candidates.
pub fn probe(override_path: Option<&Path>) -> (Option<PathBuf>, GitInfo) {
    let overridden = override_path.is_some();
    let mut last: Option<GitInfo> = None;
    for path in candidates(override_path) {
        if !path.is_file() || crate::chat::agents::is_shell_shim(&path) {
            continue;
        }
        let version = crate::chat::agents::version_of(&path, &["--version"]);
        let display = path.to_string_lossy().into_owned();
        match version.as_deref().and_then(parse_version) {
            Some(v) if v >= MIN_VERSION => {
                let info = GitInfo { path: Some(display), version, ok: true, reason: None, overridden };
                return (Some(path), info);
            }
            Some((a, b)) => {
                last = Some(GitInfo {
                    path: Some(display),
                    version: version.clone(),
                    ok: false,
                    reason: Some(format!("Git {}.{} or newer is required (found {a}.{b}).", MIN_VERSION.0, MIN_VERSION.1)),
                    overridden,
                });
            }
            None => {
                last.get_or_insert(GitInfo {
                    path: Some(display),
                    version: None,
                    ok: false,
                    reason: Some("This program didn't answer `git --version`.".into()),
                    overridden,
                });
            }
        }
    }
    let info = last.unwrap_or(GitInfo {
        path: None,
        version: None,
        ok: false,
        reason: Some("Git isn't installed (no `git` on PATH). Install Git for Windows, or choose git.exe in Settings › Git.".into()),
        overridden,
    });
    (None, info)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_versions() {
        assert_eq!(parse_version("git version 2.56.0.windows.4"), Some((2, 56)));
        assert_eq!(parse_version("git version 2.41.0\n"), Some((2, 41)));
        assert_eq!(parse_version("nope"), None);
        assert!(parse_version("git version 2.39.1").unwrap() < MIN_VERSION);
    }
}
