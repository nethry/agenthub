//! Shell profile detection and executable resolution.

use std::path::{Path, PathBuf};

use serde::Serialize;

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ShellProfile {
    pub id: String,
    pub name: String,
    /// Short uppercase label shown on session cards (e.g. `PWSH`).
    pub label: String,
    pub path: Option<String>,
    pub available: bool,
    pub preview: bool,
}

fn profile(id: &str, name: &str, label: &str, exe: &str, preview: bool) -> ShellProfile {
    let path = which::which(exe).ok().map(|p| p.to_string_lossy().to_string());
    ShellProfile {
        id: id.into(),
        name: name.into(),
        label: label.into(),
        available: path.is_some(),
        path,
        preview,
    }
}

#[cfg(windows)]
pub fn detect() -> Vec<ShellProfile> {
    vec![
        profile("pwsh", "PowerShell 7", "PWSH", "pwsh.exe", false),
        profile("powershell", "Windows PowerShell", "POWERSHELL", "powershell.exe", false),
        profile("cmd", "Command Prompt", "CMD", "cmd.exe", false),
        profile("wsl", "WSL", "WSL", "wsl.exe", true),
    ]
}

#[cfg(not(windows))]
pub fn detect() -> Vec<ShellProfile> {
    vec![
        profile("zsh", "zsh", "ZSH", "zsh", false),
        profile("bash", "bash", "BASH", "bash", false),
        profile("sh", "sh", "SH", "sh", false),
    ]
}

/// First available profile in preference order.
pub fn fallback_id(profiles: &[ShellProfile]) -> String {
    profiles
        .iter()
        .find(|p| p.available && !p.preview)
        .map(|p| p.id.clone())
        .unwrap_or_else(|| "cmd".into())
}

pub fn find<'a>(profiles: &'a [ShellProfile], id: &str) -> Option<&'a ShellProfile> {
    profiles.iter().find(|p| p.id == id)
}

/// Resolve an executable the way a user expects: an explicit path must exist,
/// a bare name is looked up on `PATH` (honoring `PATHEXT` on Windows).
pub fn resolve_executable(exe: &str) -> Option<PathBuf> {
    let exe = exe.trim();
    if exe.is_empty() {
        return None;
    }
    let p = Path::new(exe);
    if p.components().count() > 1 || p.is_absolute() {
        return dunce::canonicalize(p).ok().filter(|p| p.is_file());
    }
    which::which(exe).ok()
}

pub fn is_batch_file(path: &Path) -> bool {
    path.extension()
        .map(|e| {
            let e = e.to_string_lossy().to_ascii_lowercase();
            e == "cmd" || e == "bat"
        })
        .unwrap_or(false)
}

/// Quote a value as a PowerShell single-quoted literal (no expansion at all).
pub fn ps_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

/// `cmd.exe` cannot receive arbitrary arguments safely; only allow plain tokens.
pub fn cmd_safe(s: &str) -> bool {
    !s.is_empty()
        && !s
            .chars()
            .any(|c| c.is_whitespace() || c.is_control() || "\"&|<>^%!()".contains(c))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quotes_powershell_literals() {
        assert_eq!(ps_quote("a b"), "'a b'");
        assert_eq!(ps_quote("it's"), "'it''s'");
        assert_eq!(ps_quote("$env:X; rm x"), "'$env:X; rm x'");
    }

    #[test]
    fn cmd_safety() {
        assert!(cmd_safe("--watch"));
        assert!(!cmd_safe("a&b"));
        assert!(!cmd_safe("a b"));
        assert!(!cmd_safe("%PATH%"));
    }

    #[test]
    fn detects_batch_files() {
        assert!(is_batch_file(Path::new("C:/x/pnpm.CMD")));
        assert!(!is_batch_file(Path::new("C:/x/claude.exe")));
    }
}
