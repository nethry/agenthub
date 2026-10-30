//! Agent presets: named commands launched in a project terminal.

use rusqlite::{params, OptionalExtension, Row};
use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};
use crate::persistence::Db;
use crate::terminals::shells;

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Preset {
    pub id: String,
    pub display_name: String,
    pub executable: String,
    pub args: Vec<String>,
    /// `direct` or a shell profile id (`pwsh`, `powershell`, `cmd`, `wsl`).
    pub shell_profile: String,
    /// Subfolder relative to the project root; `None` means the root.
    pub working_dir: Option<String>,
    pub enabled: bool,
    pub builtin: bool,
    /// Resolved executable path, or `None` when it can't be found.
    pub resolved_path: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PresetInput {
    pub id: Option<String>,
    pub display_name: String,
    pub executable: String,
    pub args: Vec<String>,
    pub shell_profile: String,
    pub working_dir: Option<String>,
    pub enabled: bool,
}

const COLUMNS: &str =
    "id, display_name, executable, args_json, shell_profile, working_dir, enabled, builtin";

fn from_row(r: &Row) -> rusqlite::Result<Preset> {
    let args_json: String = r.get(3)?;
    Ok(Preset {
        id: r.get(0)?,
        display_name: r.get(1)?,
        executable: r.get(2)?,
        args: serde_json::from_str(&args_json).unwrap_or_default(),
        shell_profile: r.get(4)?,
        working_dir: r.get(5)?,
        enabled: r.get::<_, i64>(6)? != 0,
        builtin: r.get::<_, i64>(7)? != 0,
        resolved_path: None,
    })
}

fn with_resolution(mut p: Preset) -> Preset {
    p.resolved_path = if p.shell_profile == "wsl" {
        None
    } else {
        shells::resolve_executable(&p.executable).map(|p| p.to_string_lossy().to_string())
    };
    p
}

pub fn list(db: &Db) -> AppResult<Vec<Preset>> {
    let rows = db.with(|c| {
        let mut stmt = c.prepare(&format!(
            "SELECT {COLUMNS} FROM presets ORDER BY sort_order, rowid"
        ))?;
        let rows = stmt.query_map([], from_row)?.collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    })?;
    Ok(rows.into_iter().map(with_resolution).collect())
}

pub fn get(db: &Db, id: &str) -> AppResult<Preset> {
    let p = db.with(|c| {
        c.query_row(
            &format!("SELECT {COLUMNS} FROM presets WHERE id = ?1"),
            [id],
            from_row,
        )
        .optional()?
        .ok_or_else(|| AppError::NotFound("Preset not found".into()))
    })?;
    Ok(with_resolution(p))
}

fn validate(input: &PresetInput) -> AppResult<()> {
    if input.display_name.trim().is_empty() || input.display_name.chars().count() > 60 {
        return Err(AppError::Invalid("Display name must be 1–60 characters".into()));
    }
    if input.executable.trim().is_empty() {
        return Err(AppError::Invalid("Executable is required".into()));
    }
    if input.args.len() > 64 || input.args.iter().any(|a| a.contains('\0') || a.len() > 4096) {
        return Err(AppError::Invalid("Arguments are invalid".into()));
    }
    if !["direct", "pwsh", "powershell", "cmd", "wsl", "zsh", "bash", "sh"]
        .contains(&input.shell_profile.as_str())
    {
        return Err(AppError::Invalid("Unknown shell profile".into()));
    }
    Ok(())
}

pub fn save(db: &Db, input: PresetInput) -> AppResult<Preset> {
    validate(&input)?;
    let args_json = serde_json::to_string(&input.args).unwrap_or_else(|_| "[]".into());
    let working_dir = input
        .working_dir
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty() && *s != ".")
        .map(str::to_string);
    let id = match input.id.as_deref().filter(|s| !s.is_empty()) {
        Some(id) => {
            let changed = db.with(|c| {
                Ok(c.execute(
                    "UPDATE presets SET display_name = ?1, executable = ?2, args_json = ?3,
                     shell_profile = ?4, working_dir = ?5, enabled = ?6 WHERE id = ?7",
                    params![
                        input.display_name.trim(),
                        input.executable.trim(),
                        args_json,
                        input.shell_profile,
                        working_dir,
                        input.enabled as i64,
                        id
                    ],
                )?)
            })?;
            if changed == 0 {
                return Err(AppError::NotFound("Preset not found".into()));
            }
            id.to_string()
        }
        None => {
            let id = uuid::Uuid::new_v4().to_string();
            insert(db, &id, &input, &args_json, working_dir.as_deref(), false)?;
            id
        }
    };
    get(db, &id)
}

fn insert(
    db: &Db,
    id: &str,
    input: &PresetInput,
    args_json: &str,
    working_dir: Option<&str>,
    builtin: bool,
) -> AppResult<()> {
    db.with(|c| {
        let order: i64 = c.query_row(
            "SELECT COALESCE(MAX(sort_order), 0) + 1 FROM presets",
            [],
            |r| r.get(0),
        )?;
        c.execute(
            "INSERT INTO presets (id, display_name, executable, args_json, shell_profile,
             working_dir, enabled, builtin, sort_order) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                id,
                input.display_name.trim(),
                input.executable.trim(),
                args_json,
                input.shell_profile,
                working_dir,
                input.enabled as i64,
                builtin as i64,
                order
            ],
        )?;
        Ok(())
    })
}

pub fn delete(db: &Db, id: &str) -> AppResult<()> {
    db.with(|c| {
        c.execute("DELETE FROM presets WHERE id = ?1", [id])?;
        Ok(())
    })
}

/// Seed Claude Code, Codex CLI and OpenCode once. Deleting them later sticks.
pub fn seed_defaults(db: &Db) -> AppResult<()> {
    if db.get_setting("presets_seeded")?.is_some() {
        return Ok(());
    }
    for (id, name, exe) in [
        ("claude-code", "Claude Code", "claude"),
        ("codex-cli", "Codex CLI", "codex"),
        ("opencode", "OpenCode", "opencode"),
    ] {
        let input = PresetInput {
            id: None,
            display_name: name.into(),
            executable: exe.into(),
            args: vec![],
            shell_profile: "direct".into(),
            working_dir: None,
            enabled: true,
        };
        insert(db, id, &input, "[]", None, true)?;
    }
    db.set_setting("presets_seeded", "1")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seeds_once_and_round_trips() {
        let db = Db::open_in_memory().unwrap();
        seed_defaults(&db).unwrap();
        seed_defaults(&db).unwrap();
        assert_eq!(list(&db).unwrap().len(), 3);

        delete(&db, "opencode").unwrap();
        seed_defaults(&db).unwrap();
        assert_eq!(list(&db).unwrap().len(), 2);

        let saved = save(
            &db,
            PresetInput {
                id: None,
                display_name: "Tests".into(),
                executable: "pnpm".into(),
                args: vec!["test".into(), "--watch".into()],
                shell_profile: "pwsh".into(),
                working_dir: Some(" ".into()),
                enabled: true,
            },
        )
        .unwrap();
        assert_eq!(saved.args, vec!["test", "--watch"]);
        assert_eq!(saved.working_dir, None);
        assert!(!saved.builtin);
    }

    #[test]
    fn rejects_bad_input() {
        let db = Db::open_in_memory().unwrap();
        let bad = PresetInput {
            id: None,
            display_name: "x".into(),
            executable: "x".into(),
            args: vec![],
            shell_profile: "bogus".into(),
            working_dir: None,
            enabled: true,
        };
        assert!(save(&db, bad).is_err());
    }
}
