//! Checkpoints of files an agent is about to change, so its edits can be
//! reviewed as diffs and reverted. AgentHub takes one before it lets a write
//! through (approval or its own `fs/write_text_file`); the copy lives in the
//! app data folder, never in SQLite. A file that didn't exist is recorded as
//! absent, so Revert deletes it again (to the Recycle Bin).

use std::path::{Path, PathBuf};

use serde::Serialize;
use similar::{ChangeTag, TextDiff};

use super::ChangeKind;
use crate::error::{AppError, AppResult};

/// Bigger files aren't checkpointed (their change can't be reverted from Chat).
const MAX_BYTES: u64 = 8 * 1024 * 1024;

pub struct Checkpoints {
    dir: PathBuf,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Snapshot {
    pub id: String,
    pub existed: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DiffLine {
    /// `+`, `-`, ` ` or `@` (hunk header).
    pub tag: char,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
    pub change: ChangeKind,
    pub additions: u32,
    pub deletions: u32,
    pub lines: Vec<DiffLine>,
    /// Content before the change, for a side-by-side view; `None` for a new file.
    pub original: Option<String>,
    /// The file changed is binary or too large to diff.
    pub binary: bool,
}

pub(crate) fn safe_id(s: &str) -> bool {
    !s.is_empty() && s.len() <= 80 && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

impl Checkpoints {
    pub fn new(dir: PathBuf) -> Self {
        Self { dir }
    }

    fn path_of(&self, conversation_id: &str, id: &str) -> AppResult<PathBuf> {
        if !safe_id(conversation_id) || !safe_id(id) {
            return Err(AppError::Invalid("Bad checkpoint id".into()));
        }
        Ok(self.dir.join(conversation_id).join(id))
    }

    /// Copies `file` (absolute) before it changes. `None` when it is too large.
    pub fn snapshot(&self, conversation_id: &str, file: &Path) -> AppResult<Option<Snapshot>> {
        let id = uuid::Uuid::new_v4().to_string();
        let dest = self.path_of(conversation_id, &id)?;
        std::fs::create_dir_all(dest.parent().unwrap_or(&self.dir))?;
        match std::fs::metadata(file) {
            Ok(m) if m.is_file() && m.len() > MAX_BYTES => Ok(None),
            Ok(m) if m.is_file() => {
                std::fs::copy(file, &dest)?;
                Ok(Some(Snapshot { id, existed: true }))
            }
            Ok(_) => Ok(None),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                // Marker for "didn't exist": an empty `.absent` file.
                std::fs::write(dest.with_extension("absent"), b"")?;
                Ok(Some(Snapshot { id, existed: false }))
            }
            Err(e) => Err(e.into()),
        }
    }

    fn original_bytes(&self, conversation_id: &str, id: &str) -> AppResult<Option<Vec<u8>>> {
        let p = self.path_of(conversation_id, id)?;
        if p.with_extension("absent").exists() {
            return Ok(None);
        }
        Ok(Some(std::fs::read(&p).map_err(|_| AppError::NotFound("The checkpoint for this change is gone".into()))?))
    }

    /// Diff of `file` now against its checkpoint.
    pub fn diff(&self, conversation_id: &str, id: &str, file: &Path) -> AppResult<FileDiff> {
        let before = self.original_bytes(conversation_id, id)?;
        let after = match std::fs::read(file) {
            Ok(b) => Some(b),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => return Err(e.into()),
        };
        Ok(diff_bytes(before.as_deref(), after.as_deref()))
    }

    /// Restores the checkpointed content (or removes a file the agent created).
    pub fn revert(&self, conversation_id: &str, id: &str, file: &Path) -> AppResult<()> {
        match self.original_bytes(conversation_id, id)? {
            Some(bytes) => {
                if let Some(parent) = file.parent() {
                    std::fs::create_dir_all(parent)?;
                }
                std::fs::write(file, bytes)?;
            }
            None => {
                if file.exists() {
                    trash::delete(file).map_err(|e| AppError::Invalid(format!("Couldn't move the new file to the Recycle Bin: {e}")))?;
                }
            }
        }
        Ok(())
    }

    pub fn remove_conversation(&self, conversation_id: &str) {
        if safe_id(conversation_id) {
            let _ = std::fs::remove_dir_all(self.dir.join(conversation_id));
        }
    }
}

fn is_binary(b: &[u8]) -> bool {
    b.iter().take(8000).any(|&c| c == 0) || std::str::from_utf8(b).is_err()
}

pub fn diff_bytes(before: Option<&[u8]>, after: Option<&[u8]>) -> FileDiff {
    let change = match (before, after) {
        (None, _) => ChangeKind::Add,
        (Some(_), None) => ChangeKind::Delete,
        _ => ChangeKind::Modify,
    };
    if before.is_some_and(is_binary) || after.is_some_and(is_binary) {
        return FileDiff { change, additions: 0, deletions: 0, lines: vec![], original: None, binary: true };
    }
    let old = before.map(|b| String::from_utf8_lossy(b).into_owned()).unwrap_or_default();
    let new = after.map(|b| String::from_utf8_lossy(b).into_owned()).unwrap_or_default();
    let (lines, additions, deletions) = diff_text(&old, &new);
    FileDiff { change, additions, deletions, lines, original: before.map(|_| old), binary: false }
}

/// Unified hunks (3 lines of context) and the +/− counts.
pub fn diff_text(old: &str, new: &str) -> (Vec<DiffLine>, u32, u32) {
    let diff = TextDiff::from_lines(old, new);
    let mut lines = Vec::new();
    let (mut add, mut del) = (0, 0);
    for group in diff.grouped_ops(3) {
        let (first, last) = (&group[0], &group[group.len() - 1]);
        let (o, n) = (first.old_range().start, first.new_range().start);
        let (ol, nl) = (last.old_range().end - o, last.new_range().end - n);
        lines.push(DiffLine { tag: '@', text: format!("@@ -{},{} +{},{} @@", o + 1, ol, n + 1, nl) });
        for op in &group {
            for change in diff.iter_changes(op) {
                let tag = match change.tag() {
                    ChangeTag::Insert => {
                        add += 1;
                        '+'
                    }
                    ChangeTag::Delete => {
                        del += 1;
                        '-'
                    }
                    ChangeTag::Equal => ' ',
                };
                lines.push(DiffLine { tag, text: change.value().trim_end_matches(['\n', '\r']).to_string() });
            }
        }
    }
    (lines, add, del)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> (tempfile::TempDir, Checkpoints, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let cp = Checkpoints::new(dir.path().join("checkpoints"));
        let file = dir.path().join("proj").join("a.rs");
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        (dir, cp, file)
    }

    #[test]
    fn diffs_and_reverts_a_modified_file() {
        let (_d, cp, file) = setup();
        std::fs::write(&file, "one\ntwo\nthree\n").unwrap();
        let snap = cp.snapshot("conv-1", &file).unwrap().unwrap();
        assert!(snap.existed);
        std::fs::write(&file, "one\nTWO\nthree\nfour\n").unwrap();
        let d = cp.diff("conv-1", &snap.id, &file).unwrap();
        assert_eq!((d.change, d.additions, d.deletions), (ChangeKind::Modify, 2, 1));
        assert_eq!(d.lines[0].tag, '@');
        assert!(d.lines.iter().any(|l| l.tag == '-' && l.text == "two"));
        assert_eq!(d.original.as_deref(), Some("one\ntwo\nthree\n"));
        cp.revert("conv-1", &snap.id, &file).unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "one\ntwo\nthree\n");
    }

    #[test]
    fn a_new_file_is_an_add_and_reverting_removes_it() {
        let (_d, cp, file) = setup();
        let snap = cp.snapshot("conv-1", &file).unwrap().unwrap();
        assert!(!snap.existed);
        std::fs::write(&file, "fn main() {}\n").unwrap();
        let d = cp.diff("conv-1", &snap.id, &file).unwrap();
        assert_eq!((d.change, d.additions, d.deletions), (ChangeKind::Add, 1, 0));
        assert!(d.original.is_none());
    }

    #[test]
    fn rejects_unsafe_ids_and_flags_binary_files() {
        let (_d, cp, file) = setup();
        assert!(cp.diff("../x", "id", &file).is_err());
        assert!(cp.diff("conv", "..\\x", &file).is_err());
        let d = diff_bytes(Some(b"a\0b"), Some(b"a\0c"));
        assert!(d.binary);
    }
}
