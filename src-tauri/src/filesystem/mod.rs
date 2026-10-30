//! File service scoped to registered project roots.
//!
//! Every path from the frontend is a path *relative to a project root*. It is
//! joined to the canonical root, canonicalized (resolving symlinks), and then
//! required to still live under that root.

pub mod text;
pub mod watch;

use std::fs;
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::Serialize;

use crate::error::{AppError, AppResult};

/// Larger files open read-only.
pub const MAX_EDIT_BYTES: u64 = 5 * 1024 * 1024;
/// Larger files don't open at all.
pub const MAX_OPEN_BYTES: u64 = 50 * 1024 * 1024;
/// Marker in temp-file names used by atomic saves (the watcher ignores them).
pub const TEMP_MARKER: &str = ".agenthub-save-";
const MAX_INDEX_ENTRIES: usize = 20_000;
const HIDDEN_DIRS: &[&str] = &[".git"];
const INDEX_SKIP_DIRS: &[&str] = &[".git", "node_modules", "target", "dist", "build", ".next", ".venv"];

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileContent {
    pub content: String,
    pub mtime_ms: i64,
    pub size: u64,
    pub line_ending: &'static str,
    pub has_bom: bool,
    pub encoding: String,
    /// Over [`MAX_EDIT_BYTES`]: shown, but not editable.
    pub read_only: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteResult {
    pub mtime_ms: i64,
}

/// Canonicalize a directory the user picked so it can be registered as a root.
pub fn canonical_dir(path: &Path) -> AppResult<PathBuf> {
    let canon = dunce::canonicalize(path)
        .map_err(|_| AppError::NotFound(format!("Folder not found: {}", path.display())))?;
    if !canon.is_dir() {
        return Err(AppError::Invalid(format!("Not a folder: {}", canon.display())));
    }
    Ok(canon)
}

/// Reject absolute paths, drive prefixes and `..` before touching the disk.
fn check_relative(rel: &str) -> AppResult<PathBuf> {
    let rel = rel.replace('\\', "/");
    let p = PathBuf::from(rel.trim_start_matches("./"));
    for comp in p.components() {
        match comp {
            Component::Normal(_) | Component::CurDir => {}
            _ => return Err(AppError::OutsideRoot),
        }
    }
    Ok(p)
}

/// Resolve `rel` against `root`, following symlinks, and require the result to
/// stay inside `root`. The target must exist.
pub fn resolve(root: &Path, rel: &str) -> AppResult<PathBuf> {
    let rel = check_relative(rel)?;
    let joined = root.join(rel);
    let canon = dunce::canonicalize(&joined)
        .map_err(|_| AppError::NotFound(format!("Not found: {}", joined.display())))?;
    if !canon.starts_with(root) {
        return Err(AppError::OutsideRoot);
    }
    Ok(canon)
}

fn rel_string(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

fn mtime_ms(meta: &fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn list_dir(root: &Path, rel: &str) -> AppResult<Vec<DirEntry>> {
    let dir = resolve(root, rel)?;
    if !dir.is_dir() {
        return Err(AppError::Invalid("Not a folder".into()));
    }
    let mut out = Vec::new();
    for entry in fs::read_dir(&dir)? {
        let Ok(entry) = entry else { continue };
        let name = entry.file_name().to_string_lossy().to_string();
        if HIDDEN_DIRS.contains(&name.as_str()) {
            continue;
        }
        let path = entry.path();
        let Ok(file_type) = entry.file_type() else { continue };
        // Symlinks and junctions are only shown when they resolve inside the root.
        let (is_dir, size) = if file_type.is_symlink() {
            match dunce::canonicalize(&path) {
                Ok(target) if target.starts_with(root) => {
                    let meta = fs::metadata(&target)?;
                    (meta.is_dir(), meta.len())
                }
                _ => continue,
            }
        } else {
            let meta = entry.metadata()?;
            (meta.is_dir(), if meta.is_dir() { 0 } else { meta.len() })
        };
        out.push(DirEntry {
            name,
            path: rel_string(root, &path),
            is_dir,
            size,
        });
    }
    out.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(out)
}

/// Flat list of file paths for the command palette's file search.
pub fn index_files(root: &Path) -> AppResult<Vec<String>> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let Ok(file_type) = entry.file_type() else { continue };
            if file_type.is_symlink() {
                continue;
            }
            let name = entry.file_name();
            let path = entry.path();
            if file_type.is_dir() {
                if !INDEX_SKIP_DIRS.contains(&name.to_string_lossy().as_ref()) {
                    stack.push(path);
                }
            } else {
                out.push(rel_string(root, &path));
                if out.len() >= MAX_INDEX_ENTRIES {
                    return Ok(out);
                }
            }
        }
    }
    out.sort();
    Ok(out)
}

/// Read a text file. `encoding` forces a decoding ("Reopen with encoding").
pub fn read_file(root: &Path, rel: &str, encoding: Option<&str>) -> AppResult<FileContent> {
    let path = resolve(root, rel)?;
    let meta = fs::metadata(&path)?;
    if meta.is_dir() {
        return Err(AppError::Invalid("Cannot open a folder in the editor".into()));
    }
    if meta.len() > MAX_OPEN_BYTES {
        return Err(AppError::TooLarge(MAX_OPEN_BYTES / 1024 / 1024));
    }
    let bytes = fs::read(&path)?;
    let decoded = text::decode(&bytes, encoding)?;
    let line_ending = if decoded.content.contains("\r\n") { "CRLF" } else { "LF" };
    Ok(FileContent {
        content: decoded.content,
        mtime_ms: mtime_ms(&meta),
        size: meta.len(),
        line_ending,
        has_bom: decoded.has_bom,
        encoding: decoded.encoding,
        read_only: meta.len() > MAX_EDIT_BYTES,
    })
}

/// Overwrite an existing file in its encoding. When `expected_mtime_ms` is
/// given and the file changed on disk since, returns `Conflict` instead of
/// clobbering it.
pub fn write_file(
    root: &Path,
    rel: &str,
    content: &str,
    encoding: &str,
    has_bom: bool,
    expected_mtime_ms: Option<i64>,
) -> AppResult<WriteResult> {
    let path = resolve(root, rel)?;
    let meta = fs::metadata(&path)?;
    if meta.is_dir() {
        return Err(AppError::Invalid("Cannot write to a folder".into()));
    }
    if let Some(expected) = expected_mtime_ms {
        if mtime_ms(&meta) != expected {
            return Err(AppError::Conflict);
        }
    }
    let bytes = text::encode(content, encoding, has_bom)?;
    atomic_write(&path, &bytes)?;
    Ok(WriteResult {
        mtime_ms: mtime_ms(&fs::metadata(&path)?),
    })
}

/// Write to a temp file next to `path`, then rename it over `path`, so a crash
/// mid-save never leaves a truncated file. If the rename is refused (e.g. the
/// file is held open without delete sharing), fall back to a direct write.
fn atomic_write(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let dir = path.parent().unwrap_or(Path::new("."));
    let name = path.file_name().map(|n| n.to_string_lossy()).unwrap_or_default();
    let tmp = dir.join(format!(".{name}{TEMP_MARKER}{}", uuid::Uuid::new_v4().simple()));
    let written = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&tmp)
        .and_then(|mut f| f.write_all(bytes).and_then(|_| f.sync_all()));
    if written.is_err() {
        let _ = fs::remove_file(&tmp);
        return fs::write(path, bytes);
    }
    let perms = fs::metadata(path).map(|m| m.permissions());
    match fs::rename(&tmp, path) {
        Ok(()) => {
            if let Ok(perms) = perms {
                let _ = fs::set_permissions(path, perms);
            }
            Ok(())
        }
        Err(_) => {
            let _ = fs::remove_file(&tmp);
            fs::write(path, bytes)
        }
    }
}

/// The entry itself (not its symlink target): its parent is resolved and must
/// be inside the root. The project folder itself is never a valid target.
fn entry_path(root: &Path, rel: &str) -> AppResult<PathBuf> {
    let rel_path = check_relative(rel)?;
    let name = rel_path
        .file_name()
        .ok_or_else(|| AppError::Invalid("The project folder itself can't be changed here".into()))?
        .to_owned();
    let parent_rel = rel_path.parent().map(|p| p.to_string_lossy().to_string()).unwrap_or_default();
    let path = resolve(root, &parent_rel)?.join(name);
    if fs::symlink_metadata(&path).is_err() {
        return Err(AppError::NotFound(format!("Not found: {rel}")));
    }
    Ok(path)
}

/// Create an empty file or a folder named `name` inside `parent`. Returns its
/// project-relative path. Never overwrites.
pub fn create_entry(root: &Path, parent: &str, name: &str, is_dir: bool) -> AppResult<String> {
    let dir = resolve(root, parent)?;
    if !dir.is_dir() {
        return Err(AppError::Invalid("Not a folder".into()));
    }
    let name = validate_name(name)?;
    let target = dir.join(name);
    let created = if is_dir {
        fs::create_dir(&target)
    } else {
        fs::OpenOptions::new().write(true).create_new(true).open(&target).map(|_| ())
    };
    match created {
        Ok(()) => Ok(rel_string(root, &target)),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            Err(AppError::Invalid(format!("\"{name}\" already exists")))
        }
        Err(e) => Err(e.into()),
    }
}

/// Rename a file or folder in place (same parent). Refuses to overwrite, but a
/// case-only rename is allowed on case-insensitive file systems.
pub fn rename_entry(root: &Path, rel: &str, new_name: &str) -> AppResult<String> {
    let from = entry_path(root, rel)?;
    let name = validate_name(new_name)?;
    let to = from.with_file_name(name);
    if to == from {
        return Ok(rel_string(root, &from));
    }
    if fs::symlink_metadata(&to).is_ok() {
        let same_entry = dunce::canonicalize(&to).ok() == dunce::canonicalize(&from).ok()
            && from.to_string_lossy().to_lowercase() == to.to_string_lossy().to_lowercase();
        if !same_entry {
            return Err(AppError::Invalid(format!("\"{name}\" already exists")));
        }
    }
    fs::rename(&from, &to)?;
    Ok(rel_string(root, &to))
}

/// Move a file or folder to the Recycle Bin / Trash. Never deletes permanently.
pub fn delete_entry(root: &Path, rel: &str) -> AppResult<()> {
    let path = entry_path(root, rel)?;
    trash::delete(&path).map_err(|e| AppError::Invalid(format!("Couldn't move to the Recycle Bin: {e}")))
}

/// Validate a single file or folder name typed by the user (no separators, no
/// `..`, nothing Windows forbids or reserves).
pub fn validate_name(name: &str) -> AppResult<&str> {
    let name = name.trim();
    let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
    let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ((stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.len() == 4
            && stem.as_bytes()[3].is_ascii_digit());
    let bad = name.is_empty()
        || name == "."
        || name == ".."
        || name.len() > 255
        || name.ends_with('.')
        || reserved
        || name.chars().any(|c| c.is_control() || r#"<>:"/\|?*"#.contains(c));
    if bad {
        return Err(AppError::Invalid(format!("\"{name}\" is not a valid name")));
    }
    Ok(name)
}

pub fn validate_folder_name(name: &str) -> AppResult<&str> {
    validate_name(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(dir.path()).unwrap();
        fs::create_dir_all(root.join("src/nested")).unwrap();
        fs::write(root.join("src/a.ts"), "export {}\n").unwrap();
        fs::write(root.join("bin.dat"), [0u8, 1, 2]).unwrap();
        (dir, root)
    }

    #[test]
    fn rejects_paths_outside_root() {
        let (_d, root) = setup();
        assert!(matches!(resolve(&root, "../x"), Err(AppError::OutsideRoot)));
        assert!(matches!(resolve(&root, "src/../../x"), Err(AppError::OutsideRoot)));
        assert!(matches!(resolve(&root, "C:/Windows"), Err(AppError::OutsideRoot)));
        assert!(resolve(&root, "src/a.ts").is_ok());
    }

    #[test]
    fn lists_dirs_first() {
        let (_d, root) = setup();
        let entries = list_dir(&root, "").unwrap();
        assert_eq!(entries[0].name, "src");
        assert!(entries[0].is_dir);
    }

    #[test]
    fn reads_text_and_refuses_binary() {
        let (_d, root) = setup();
        let f = read_file(&root, "src/a.ts", None).unwrap();
        assert_eq!(f.content, "export {}\n");
        assert_eq!(f.line_ending, "LF");
        assert_eq!(f.encoding, "utf-8");
        assert!(!f.read_only);
        assert!(matches!(read_file(&root, "bin.dat", None), Err(AppError::Binary)));
    }

    #[test]
    fn write_detects_conflicts() {
        let (_d, root) = setup();
        let f = read_file(&root, "src/a.ts", None).unwrap();
        let r = write_file(&root, "src/a.ts", "x", "utf-8", false, Some(f.mtime_ms)).unwrap();
        assert!(matches!(
            write_file(&root, "src/a.ts", "y", "utf-8", false, Some(r.mtime_ms - 10_000)),
            Err(AppError::Conflict)
        ));
    }

    #[test]
    fn writes_atomically_in_the_files_encoding() {
        let (_d, root) = setup();
        fs::write(root.join("u16.txt"), text::encode("a€", "utf-16le", true).unwrap()).unwrap();
        let f = read_file(&root, "u16.txt", None).unwrap();
        assert_eq!((f.content.as_str(), f.encoding.as_str(), f.has_bom), ("a€", "utf-16le", true));
        write_file(&root, "u16.txt", "b€", &f.encoding, f.has_bom, Some(f.mtime_ms)).unwrap();
        assert_eq!(read_file(&root, "u16.txt", None).unwrap().content, "b€");
        // No temp files are left behind.
        let leftovers: Vec<_> = fs::read_dir(&root)
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().contains(TEMP_MARKER))
            .collect();
        assert!(leftovers.is_empty());
        // An unencodable save leaves the original untouched.
        fs::write(root.join("latin2.txt"), b"x").unwrap();
        assert!(write_file(&root, "latin2.txt", "€", "iso-8859-2", false, None).is_err());
        assert_eq!(fs::read(root.join("latin2.txt")).unwrap(), b"x");
    }

    #[test]
    fn large_files_open_read_only() {
        let (_d, root) = setup();
        let big = "a".repeat(MAX_EDIT_BYTES as usize + 1);
        fs::write(root.join("big.log"), &big).unwrap();
        assert!(read_file(&root, "big.log", None).unwrap().read_only);
    }

    #[test]
    fn creates_renames_and_deletes_inside_the_root() {
        let (_d, root) = setup();
        assert_eq!(create_entry(&root, "src", "b.ts", false).unwrap(), "src/b.ts");
        assert_eq!(create_entry(&root, "", "docs", true).unwrap(), "docs");
        assert!(create_entry(&root, "src", "b.ts", false).is_err(), "never overwrites");
        assert!(create_entry(&root, "src", "../x", false).is_err());
        assert!(create_entry(&root, "..", "x", false).is_err());

        assert_eq!(rename_entry(&root, "src/b.ts", "c.ts").unwrap(), "src/c.ts");
        assert!(rename_entry(&root, "src/c.ts", "a.ts").is_err(), "refuses to overwrite");
        assert_eq!(rename_entry(&root, "src/c.ts", "C.ts").unwrap(), "src/C.ts", "case-only rename");
        assert!(rename_entry(&root, "", "x").is_err(), "root can't be renamed");
        assert!(rename_entry(&root, "../outside", "x").is_err());

        assert!(delete_entry(&root, "").is_err(), "root can't be deleted");
        assert!(delete_entry(&root, "../x").is_err());
        assert!(delete_entry(&root, "docs/missing").is_err());
    }

    #[cfg(windows)]
    #[test]
    fn symlinks_cannot_escape_the_root() {
        let (_d, root) = setup();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("secret.txt"), "s").unwrap();
        // Junctions need no special privilege on Windows.
        let link = root.join("escape");
        let ok = std::process::Command::new("cmd")
            .args(["/c", "mklink", "/J"])
            .arg(&link)
            .arg(outside.path())
            .output()
            .is_ok_and(|o| o.status.success());
        if !ok {
            return;
        }
        assert!(matches!(resolve(&root, "escape/secret.txt"), Err(AppError::OutsideRoot)));
        assert!(read_file(&root, "escape/secret.txt", None).is_err());
        assert!(create_entry(&root, "escape", "x.txt", false).is_err());
        assert!(!list_dir(&root, "").unwrap().iter().any(|e| e.name == "escape"));
    }

    #[test]
    fn validates_names() {
        assert!(validate_name("my-app").is_ok());
        assert!(validate_name(".env").is_ok());
        assert!(validate_name("../x").is_err());
        assert!(validate_name("a:b").is_err());
        assert!(validate_name("  ").is_err());
        assert!(validate_name("CON").is_err());
        assert!(validate_name("com1.txt").is_err());
        assert!(validate_name("console.log").is_ok());
    }

    #[test]
    fn indexes_files() {
        let (_d, root) = setup();
        let files = index_files(&root).unwrap();
        assert!(files.contains(&"src/a.ts".to_string()));
    }
}
