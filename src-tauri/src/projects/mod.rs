//! Registered projects and their restorable workspace metadata.
//! Removing a project only forgets it; files on disk are never touched.

use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::{params, OptionalExtension, Row};
use serde::Serialize;

use crate::error::{now_ms, AppError, AppResult};
use crate::filesystem;
use crate::persistence::Db;

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub path: String,
    pub created_at: i64,
    pub last_opened_at: Option<i64>,
}

fn from_row(r: &Row) -> rusqlite::Result<Project> {
    Ok(Project {
        id: r.get(0)?,
        name: r.get(1)?,
        path: r.get(2)?,
        created_at: r.get(3)?,
        last_opened_at: r.get(4)?,
    })
}

const COLUMNS: &str = "id, name, path, created_at, last_opened_at";

pub fn list(db: &Db) -> AppResult<Vec<Project>> {
    db.with(|c| {
        let mut stmt = c.prepare(&format!(
            "SELECT {COLUMNS} FROM projects ORDER BY sort_order, created_at"
        ))?;
        let rows = stmt.query_map([], from_row)?.collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    })
}

pub fn get(db: &Db, id: &str) -> AppResult<Project> {
    db.with(|c| {
        c.query_row(
            &format!("SELECT {COLUMNS} FROM projects WHERE id = ?1"),
            [id],
            from_row,
        )
        .optional()?
        .ok_or_else(|| AppError::NotFound("Project not found".into()))
    })
}

/// Canonical root for a project, re-validated on every call so a folder that
/// was moved or deleted is reported instead of silently used.
pub fn root(db: &Db, id: &str) -> AppResult<PathBuf> {
    let project = get(db, id)?;
    filesystem::canonical_dir(Path::new(&project.path))
}

fn clean_name(name: &str) -> AppResult<String> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 80 {
        return Err(AppError::Invalid("Project name must be 1–80 characters".into()));
    }
    Ok(name.to_string())
}

pub fn add(db: &Db, path: &str, name: Option<&str>) -> AppResult<Project> {
    let canon = filesystem::canonical_dir(Path::new(path))?;
    let path_str = canon.to_string_lossy().to_string();
    let existing = db.with(|c| {
        Ok(c.query_row(
            &format!("SELECT {COLUMNS} FROM projects WHERE path = ?1 COLLATE NOCASE"),
            [&path_str],
            from_row,
        )
        .optional()?)
    })?;
    if let Some(p) = existing {
        return Ok(p);
    }
    let default_name = canon
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path_str.clone());
    let name = clean_name(name.filter(|n| !n.trim().is_empty()).unwrap_or(&default_name))?;
    let project = Project {
        id: uuid::Uuid::new_v4().to_string(),
        name,
        path: path_str,
        created_at: now_ms(),
        last_opened_at: Some(now_ms()),
    };
    db.with(|c| {
        let order: i64 = c.query_row(
            "SELECT COALESCE(MAX(sort_order), 0) + 1 FROM projects",
            [],
            |r| r.get(0),
        )?;
        c.execute(
            "INSERT INTO projects (id, name, path, created_at, last_opened_at, sort_order)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                project.id,
                project.name,
                project.path,
                project.created_at,
                project.last_opened_at,
                order
            ],
        )?;
        Ok(())
    })?;
    Ok(project)
}

/// Create `parent/name` (which must not exist yet) and register it.
pub fn create_folder(db: &Db, parent: &str, name: &str) -> AppResult<Project> {
    let parent = filesystem::canonical_dir(Path::new(parent))?;
    let folder = filesystem::validate_folder_name(name)?;
    let target = parent.join(folder);
    if target.exists() {
        return Err(AppError::Invalid(format!(
            "{} already exists. Use \"Open existing folder\" instead.",
            target.display()
        )));
    }
    fs::create_dir(&target)?;
    add(db, &target.to_string_lossy(), Some(folder))
}

pub fn rename(db: &Db, id: &str, name: &str) -> AppResult<Project> {
    let name = clean_name(name)?;
    db.with(|c| {
        c.execute("UPDATE projects SET name = ?1 WHERE id = ?2", params![name, id])?;
        Ok(())
    })?;
    get(db, id)
}

pub fn remove(db: &Db, id: &str) -> AppResult<()> {
    db.with(|c| {
        c.execute("DELETE FROM workspace_state WHERE project_id = ?1", [id])?;
        c.execute("DELETE FROM projects WHERE id = ?1", [id])?;
        Ok(())
    })
}

pub fn touch(db: &Db, id: &str) -> AppResult<()> {
    db.with(|c| {
        c.execute(
            "UPDATE projects SET last_opened_at = ?1 WHERE id = ?2",
            params![now_ms(), id],
        )?;
        Ok(())
    })
}

pub fn reorder(db: &Db, ids: &[String]) -> AppResult<()> {
    db.with(|c| {
        for (i, id) in ids.iter().enumerate() {
            c.execute(
                "UPDATE projects SET sort_order = ?1 WHERE id = ?2",
                params![i as i64, id],
            )?;
        }
        Ok(())
    })
}

pub fn get_workspace_state(db: &Db, id: &str) -> AppResult<Option<serde_json::Value>> {
    let raw: Option<String> = db.with(|c| {
        Ok(c.query_row(
            "SELECT state_json FROM workspace_state WHERE project_id = ?1",
            [id],
            |r| r.get(0),
        )
        .optional()?)
    })?;
    Ok(raw.and_then(|s| serde_json::from_str(&s).ok()))
}

pub fn save_workspace_state(db: &Db, id: &str, state: &serde_json::Value) -> AppResult<()> {
    let json = serde_json::to_string(state).map_err(|e| AppError::Invalid(e.to_string()))?;
    if json.len() > 256 * 1024 {
        return Err(AppError::Invalid("Workspace state is too large".into()));
    }
    db.with(|c| {
        c.execute(
            "INSERT INTO workspace_state (project_id, state_json, updated_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(project_id) DO UPDATE SET state_json = excluded.state_json,
                                                   updated_at = excluded.updated_at",
            params![id, json, now_ms()],
        )?;
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn add_dedupes_and_remove_keeps_files() {
        let db = Db::open_in_memory().unwrap();
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("keep.txt"), "x").unwrap();
        let path = dir.path().to_string_lossy().to_string();

        let a = add(&db, &path, None).unwrap();
        let b = add(&db, &path, Some("other")).unwrap();
        assert_eq!(a.id, b.id);

        save_workspace_state(&db, &a.id, &serde_json::json!({"view": "editor"})).unwrap();
        remove(&db, &a.id).unwrap();
        assert!(list(&db).unwrap().is_empty());
        assert!(get_workspace_state(&db, &a.id).unwrap().is_none());
        assert!(dir.path().join("keep.txt").exists());
    }

    #[test]
    fn create_folder_refuses_existing() {
        let db = Db::open_in_memory().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let parent = dir.path().to_string_lossy().to_string();
        let p = create_folder(&db, &parent, "fresh").unwrap();
        assert_eq!(p.name, "fresh");
        assert!(create_folder(&db, &parent, "fresh").is_err());
        assert!(create_folder(&db, &parent, "..").is_err());
    }
}
