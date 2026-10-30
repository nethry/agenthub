//! `git status --porcelain=v2 -z --branch --show-stash` parsed into a snapshot.

use std::path::Path;

use serde::Serialize;

/// Status entries beyond this are dropped (the UI suggests a .gitignore).
pub const MAX_ENTRIES: usize = 50_000;

#[derive(Debug, Clone, Serialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Head {
    pub branch: Option<String>,
    pub oid: Option<String>,
    pub detached: bool,
    /// No commit yet.
    pub unborn: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StatusEntry {
    /// Repository-relative, `/`-separated.
    pub path: String,
    /// Relative to the project root; `None` when outside it.
    pub project_path: Option<String>,
    pub orig_path: Option<String>,
    /// Index side: `.` unchanged, `M` `T` `A` `D` `R` `C`.
    pub index: char,
    /// Working-tree side: `.` `M` `T` `D`, or `?` for untracked.
    pub worktree: char,
    pub untracked: bool,
    /// Unmerged XY code (`UU`, `AA`, `DU`…).
    pub conflict: Option<String>,
    pub submodule: bool,
    /// Staged and also changed again in the working tree.
    pub partially_staged: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Parsed {
    pub head: Head,
    pub upstream: Option<String>,
    pub upstream_gone: bool,
    pub ahead: u32,
    pub behind: u32,
    pub stash_count: u32,
    pub entries: Vec<StatusEntry>,
    pub truncated: bool,
}

/// An operation git is in the middle of (it stopped and waits for the user).
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Operation {
    /// `rebase` | `merge` | `cherry_pick` | `revert` | `am`
    pub kind: &'static str,
    pub step: Option<u32>,
    pub total: Option<u32>,
    /// The branch being rebased.
    pub head_name: Option<String>,
}

fn code(c: u8) -> char {
    c as char
}

/// Parses porcelain v2 `-z` output. `prefix` is the project's path inside the repo (`""` or `"sub/dir/"`).
pub fn parse(out: &[u8], prefix: &str) -> Parsed {
    let mut p = Parsed::default();
    let tokens: Vec<&[u8]> = out.split(|b| *b == 0).collect();
    let mut saw_ab = false;
    let mut i = 0;
    while i < tokens.len() {
        let t = String::from_utf8_lossy(tokens[i]).into_owned();
        i += 1;
        if t.is_empty() {
            continue;
        }
        if let Some(h) = t.strip_prefix("# ") {
            let (key, val) = h.split_once(' ').unwrap_or((h, ""));
            match key {
                "branch.oid" => {
                    if val == "(initial)" {
                        p.head.unborn = true;
                    } else {
                        p.head.oid = Some(val.to_string());
                    }
                }
                "branch.head" => {
                    if val == "(detached)" {
                        p.head.detached = true;
                    } else {
                        p.head.branch = Some(val.to_string());
                    }
                }
                "branch.upstream" => p.upstream = Some(val.to_string()),
                "branch.ab" => {
                    saw_ab = true;
                    for part in val.split(' ') {
                        if let Some(n) = part.strip_prefix('+') {
                            p.ahead = n.parse().unwrap_or(0);
                        } else if let Some(n) = part.strip_prefix('-') {
                            p.behind = n.parse().unwrap_or(0);
                        }
                    }
                }
                "stash" => p.stash_count = val.parse().unwrap_or(0),
                _ => {}
            }
            continue;
        }
        if p.entries.len() >= MAX_ENTRIES {
            p.truncated = true;
            continue;
        }
        let kind = t.as_bytes()[0];
        let entry = match kind {
            b'1' => {
                let f: Vec<&str> = t.splitn(9, ' ').collect();
                (f.len() == 9).then(|| ordinary(f[1], f[2], f[8], None, prefix))
            }
            b'2' => {
                let f: Vec<&str> = t.splitn(10, ' ').collect();
                // The original path is the next NUL-separated token.
                let orig = tokens.get(i).map(|b| String::from_utf8_lossy(b).into_owned());
                i += 1;
                (f.len() == 10).then(|| ordinary(f[1], f[2], f[9], orig, prefix))
            }
            b'u' => {
                let f: Vec<&str> = t.splitn(11, ' ').collect();
                (f.len() == 11).then(|| StatusEntry {
                    project_path: project_path(f[10], prefix),
                    path: f[10].to_string(),
                    orig_path: None,
                    index: 'U',
                    worktree: 'U',
                    untracked: false,
                    conflict: Some(f[1].to_string()),
                    submodule: f[2].starts_with('S'),
                    partially_staged: false,
                })
            }
            b'?' => t.get(2..).map(|path| StatusEntry {
                project_path: project_path(path, prefix),
                path: path.to_string(),
                orig_path: None,
                index: '.',
                worktree: '?',
                untracked: true,
                conflict: None,
                submodule: false,
                partially_staged: false,
            }),
            _ => None,
        };
        if let Some(e) = entry {
            p.entries.push(e);
        }
    }
    p.upstream_gone = p.upstream.is_some() && !saw_ab;
    p
}

fn ordinary(xy: &str, sub: &str, path: &str, orig: Option<String>, prefix: &str) -> StatusEntry {
    let b = xy.as_bytes();
    let (x, y) = (code(*b.first().unwrap_or(&b'.')), code(*b.get(1).unwrap_or(&b'.')));
    StatusEntry {
        project_path: project_path(path, prefix),
        path: path.to_string(),
        orig_path: orig,
        index: x,
        worktree: y,
        untracked: false,
        conflict: None,
        submodule: sub.starts_with('S'),
        partially_staged: x != '.' && y != '.',
    }
}

fn project_path(repo_path: &str, prefix: &str) -> Option<String> {
    repo_path.strip_prefix(prefix).filter(|p| !p.is_empty()).map(str::to_string)
}

/// The operation git stopped in, from files in the git dir.
pub fn operation(git_dir: &Path) -> Option<Operation> {
    let read_num = |p: &Path| std::fs::read_to_string(p).ok().and_then(|s| s.trim().parse::<u32>().ok());
    let read_name = |p: &Path| {
        std::fs::read_to_string(p).ok().map(|s| s.trim().trim_start_matches("refs/heads/").to_string()).filter(|s| !s.is_empty())
    };
    let merge = git_dir.join("rebase-merge");
    if merge.is_dir() {
        return Some(Operation {
            kind: "rebase",
            step: read_num(&merge.join("msgnum")),
            total: read_num(&merge.join("end")),
            head_name: read_name(&merge.join("head-name")),
        });
    }
    let apply = git_dir.join("rebase-apply");
    if apply.is_dir() {
        let kind = if apply.join("applying").exists() { "am" } else { "rebase" };
        return Some(Operation {
            kind,
            step: read_num(&apply.join("next")),
            total: read_num(&apply.join("last")),
            head_name: read_name(&apply.join("head-name")),
        });
    }
    let simple = |kind| Some(Operation { kind, step: None, total: None, head_name: None });
    if git_dir.join("MERGE_HEAD").exists() {
        return simple("merge");
    }
    if git_dir.join("CHERRY_PICK_HEAD").exists() {
        return simple("cherry_pick");
    }
    if git_dir.join("REVERT_HEAD").exists() {
        return simple("revert");
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn z(parts: &[&str]) -> Vec<u8> {
        let mut v = Vec::new();
        for p in parts {
            v.extend_from_slice(p.as_bytes());
            v.push(0);
        }
        v
    }

    #[test]
    fn parses_branch_headers_and_entries() {
        let out = z(&[
            "# branch.oid 1a7f3c9d0000000000000000000000000000000",
            "# branch.head main",
            "# branch.upstream origin/main",
            "# branch.ab +2 -1",
            "# stash 1",
            "1 .M N... 100644 100644 100644 aaa bbb src/terminals/manager.rs",
            "1 MM N... 100644 100644 100644 aaa bbb src/a b.ts",
            "2 R. N... 100644 100644 100644 aaa bbb R100 docs/new name.md",
            "docs/old name.md",
            "u UU N... 100644 100644 100644 100644 h1 h2 h3 src/store.ts",
            "? notes/todo.txt",
        ]);
        let p = parse(&out, "");
        assert_eq!(p.head.branch.as_deref(), Some("main"));
        assert!(!p.head.unborn && !p.head.detached);
        assert_eq!((p.ahead, p.behind, p.stash_count), (2, 1, 1));
        assert!(!p.upstream_gone);
        assert_eq!(p.entries.len(), 5);
        assert_eq!((p.entries[0].index, p.entries[0].worktree), ('.', 'M'));
        assert!(p.entries[1].partially_staged);
        assert_eq!(p.entries[1].path, "src/a b.ts");
        assert_eq!(p.entries[2].path, "docs/new name.md");
        assert_eq!(p.entries[2].orig_path.as_deref(), Some("docs/old name.md"));
        assert_eq!(p.entries[3].conflict.as_deref(), Some("UU"));
        assert!(p.entries[4].untracked);
    }

    #[test]
    fn detects_unborn_detached_gone_and_project_prefix() {
        let p = parse(&z(&["# branch.oid (initial)", "# branch.head main", "? app/x.txt", "? other/y.txt"]), "app/");
        assert!(p.head.unborn);
        assert_eq!(p.entries[0].project_path.as_deref(), Some("x.txt"));
        assert_eq!(p.entries[1].project_path, None);
        let p = parse(&z(&["# branch.oid abc", "# branch.head (detached)", "# branch.upstream origin/gone"]), "");
        assert!(p.head.detached && p.head.branch.is_none());
        assert!(p.upstream_gone);
    }
}
