//! SQLite storage for projects, presets, preferences, and restorable workspace
//! metadata. Live PTY handles and terminal buffers never touch the database.

use std::path::Path;

use parking_lot::Mutex;
use rusqlite::{params, Connection, OptionalExtension};

use crate::error::AppResult;

pub struct Db {
    conn: Mutex<Connection>,
}

const MIGRATIONS: &[&str] = &[
    // v1
    r#"
    CREATE TABLE projects (
        id             TEXT PRIMARY KEY,
        name           TEXT NOT NULL,
        path           TEXT NOT NULL UNIQUE,
        created_at     INTEGER NOT NULL,
        last_opened_at INTEGER,
        sort_order     INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE presets (
        id            TEXT PRIMARY KEY,
        display_name  TEXT NOT NULL,
        executable    TEXT NOT NULL,
        args_json     TEXT NOT NULL DEFAULT '[]',
        shell_profile TEXT NOT NULL DEFAULT 'direct',
        working_dir   TEXT,
        enabled       INTEGER NOT NULL DEFAULT 1,
        builtin       INTEGER NOT NULL DEFAULT 0,
        sort_order    INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE workspace_state (
        project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
        state_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
    );
    CREATE TABLE settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );
    "#,
    // v2: AI Chat history (global, not per project). API keys never go here.
    r#"
    CREATE TABLE chat_conversations (
        id         TEXT PRIMARY KEY,
        title      TEXT NOT NULL,
        provider   TEXT NOT NULL,
        model      TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
    );
    CREATE INDEX chat_conversations_updated ON chat_conversations (updated_at DESC);
    CREATE TABLE chat_messages (
        id              TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
        seq             INTEGER NOT NULL,
        role            TEXT NOT NULL,
        content         TEXT NOT NULL DEFAULT '',
        status          TEXT NOT NULL,
        provider        TEXT,
        model           TEXT,
        error_json      TEXT,
        created_at      INTEGER NOT NULL,
        UNIQUE (conversation_id, seq)
    );
    "#,
    // v3: unified Chat. Conversations belong to a project or to General
    // (project_id NULL); `engine` names the runtime or API (old `openai` /
    // `anthropic` rows become `openai-api` / `anthropic-api`). Agent activity
    // (tools, commands, approvals, plans, file changes) is stored as items of
    // the assistant message of its turn. Built-in agent presets become engine
    // settings; user-made presets stay as custom terminal commands.
    r#"
    ALTER TABLE chat_conversations RENAME COLUMN provider TO engine;
    UPDATE chat_conversations SET engine = engine || '-api' WHERE engine IN ('openai', 'anthropic');
    ALTER TABLE chat_conversations ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE SET NULL;
    ALTER TABLE chat_conversations ADD COLUMN mode TEXT NOT NULL DEFAULT 'ask';
    ALTER TABLE chat_conversations ADD COLUMN policy TEXT NOT NULL DEFAULT 'ask';
    ALTER TABLE chat_conversations ADD COLUMN status TEXT NOT NULL DEFAULT 'idle';
    ALTER TABLE chat_conversations ADD COLUMN runtime_session_id TEXT;
    ALTER TABLE chat_conversations ADD COLUMN runtime_json TEXT;
    CREATE INDEX chat_conversations_project ON chat_conversations (project_id, updated_at DESC);

    ALTER TABLE chat_messages RENAME COLUMN provider TO engine;
    UPDATE chat_messages SET engine = engine || '-api' WHERE engine IN ('openai', 'anthropic');
    ALTER TABLE chat_messages ADD COLUMN usage_json TEXT;

    CREATE TABLE chat_items (
        id              TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
        message_id      TEXT NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
        idx             INTEGER NOT NULL,
        kind            TEXT NOT NULL,
        status          TEXT NOT NULL,
        payload_json    TEXT NOT NULL,
        created_at      INTEGER NOT NULL,
        updated_at      INTEGER NOT NULL
    );
    CREATE INDEX chat_items_message ON chat_items (message_id, idx);
    CREATE INDEX chat_items_conversation ON chat_items (conversation_id, kind);

    CREATE TABLE engine_probes (
        engine    TEXT PRIMARY KEY,
        json      TEXT NOT NULL,
        probed_at INTEGER NOT NULL
    );

    INSERT OR IGNORE INTO settings (key, value)
        SELECT 'engine_path:claude-code', executable FROM presets
        WHERE id = 'claude-code' AND builtin = 1 AND executable NOT IN ('claude', 'claude.exe');
    INSERT OR IGNORE INTO settings (key, value)
        SELECT 'engine_path:codex', executable FROM presets
        WHERE id = 'codex-cli' AND builtin = 1 AND executable NOT IN ('codex', 'codex.exe');
    DELETE FROM presets WHERE builtin = 1;
    "#,
    // v4: Backlog. Features and bugs per project (one `seq` per project for
    // both kinds), the chats started from them, and the metadata of pasted
    // screenshots (the files live in the app data folder, `backlog-images/`).
    r#"
    CREATE TABLE backlog_items (
        id           TEXT PRIMARY KEY,
        project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        seq          INTEGER NOT NULL,
        kind         TEXT NOT NULL,
        title        TEXT NOT NULL,
        body         TEXT NOT NULL DEFAULT '',
        status       TEXT NOT NULL DEFAULT 'open',
        priority     TEXT NOT NULL DEFAULT 'normal',
        plan         TEXT,
        related_json TEXT NOT NULL DEFAULT '[]',
        created_at   INTEGER NOT NULL,
        updated_at   INTEGER NOT NULL,
        UNIQUE (project_id, seq)
    );
    CREATE INDEX backlog_items_project ON backlog_items (project_id, status);
    CREATE TABLE backlog_links (
        item_id         TEXT NOT NULL REFERENCES backlog_items(id) ON DELETE CASCADE,
        conversation_id TEXT NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
        purpose         TEXT NOT NULL,
        created_at      INTEGER NOT NULL,
        PRIMARY KEY (item_id, conversation_id)
    );
    CREATE INDEX backlog_links_conversation ON backlog_links (conversation_id);
    CREATE TABLE backlog_images (
        id         TEXT PRIMARY KEY,
        item_id    TEXT NOT NULL REFERENCES backlog_items(id) ON DELETE CASCADE,
        name       TEXT NOT NULL,
        mime       TEXT NOT NULL,
        size       INTEGER NOT NULL,
        created_at INTEGER NOT NULL
    );
    CREATE INDEX backlog_images_item ON backlog_images (item_id, created_at);
    "#,
];

impl Db {
    pub fn open(path: &Path) -> AppResult<Self> {
        let conn = Connection::open(path)?;
        Self::init(conn)
    }

    #[cfg(test)]
    pub fn open_in_memory() -> AppResult<Self> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(conn: Connection) -> AppResult<Self> {
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        migrate(&conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    pub fn with<T>(&self, f: impl FnOnce(&Connection) -> AppResult<T>) -> AppResult<T> {
        let conn = self.conn.lock();
        f(&conn)
    }

    pub fn get_setting(&self, key: &str) -> AppResult<Option<String>> {
        self.with(|c| {
            Ok(c.query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| {
                r.get(0)
            })
            .optional()?)
        })
    }

    pub fn set_setting(&self, key: &str, value: &str) -> AppResult<()> {
        self.with(|c| {
            c.execute(
                "INSERT INTO settings (key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![key, value],
            )?;
            Ok(())
        })
    }

    pub fn all_settings(&self) -> AppResult<Vec<(String, String)>> {
        self.with(|c| {
            let mut stmt = c.prepare("SELECT key, value FROM settings")?;
            let rows = stmt
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })
    }
}

/// Each migration and its version bump commit together, so a failure leaves
/// the database at the previous version, unchanged.
fn migrate(conn: &Connection) -> AppResult<()> {
    let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    for (i, sql) in MIGRATIONS.iter().enumerate().skip(version.max(0) as usize) {
        let tx = conn.unchecked_transaction()?;
        tx.execute_batch(sql)?;
        tx.pragma_update(None, "user_version", i as i64 + 1)?;
        tx.commit()?;
    }
    Ok(())
}

#[cfg(test)]
pub(crate) fn migrate_to(conn: &Connection, target: usize) -> AppResult<()> {
    let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    for (i, sql) in MIGRATIONS.iter().enumerate().take(target).skip(version.max(0) as usize) {
        conn.execute_batch(sql)?;
        conn.pragma_update(None, "user_version", i as i64 + 1)?;
    }
    Ok(())
}

#[cfg(test)]
pub(crate) fn from_connection(conn: Connection) -> AppResult<Db> {
    Db::init(conn)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrates_and_stores_settings() {
        let db = Db::open_in_memory().unwrap();
        assert_eq!(db.get_setting("missing").unwrap(), None);
        db.set_setting("default_shell", "pwsh").unwrap();
        db.set_setting("default_shell", "cmd").unwrap();
        assert_eq!(db.get_setting("default_shell").unwrap().as_deref(), Some("cmd"));
    }

    /// A v2 database as AgentHub 0.1 left it: global chats, built-in and
    /// user-made presets, a project.
    fn v2_database() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        migrate_to(&conn, 2).unwrap();
        conn.execute_batch(
            r#"
            INSERT INTO projects (id, name, path, created_at) VALUES ('p1', 'agenthub', 'C:\dev\agenthub', 1);
            INSERT INTO presets (id, display_name, executable, builtin) VALUES
                ('claude-code', 'Claude Code', 'C:\tools\claude.exe', 1),
                ('codex-cli', 'Codex CLI', 'codex', 1),
                ('opencode', 'OpenCode', 'opencode', 1),
                ('mine', 'Tests', 'pnpm', 0);
            INSERT INTO chat_conversations (id, title, provider, model, created_at, updated_at) VALUES
                ('c1', 'Lifetimes', 'anthropic', 'claude-opus-5-5', 10, 20),
                ('c2', 'Regex', 'openai', 'gpt-6.1-sol', 11, 21);
            INSERT INTO chat_messages (id, conversation_id, seq, role, content, status, provider, model, error_json, created_at) VALUES
                ('m1', 'c1', 1, 'user', 'Why?', 'complete', NULL, NULL, NULL, 12),
                ('m2', 'c1', 2, 'assistant', 'Because.', 'complete', 'anthropic', 'claude-opus-5-5', NULL, 13),
                ('m3', 'c2', 1, 'user', 'Regex?', 'complete', NULL, NULL, NULL, 14),
                ('m4', 'c2', 2, 'assistant', 'Half', 'error', 'openai', 'gpt-6.1-sol', '{"kind":"network","message":"lost"}', 15);
            "#,
        )
        .unwrap();
        conn
    }

    #[test]
    fn v3_keeps_chat_history_and_moves_it_to_general() {
        let db = from_connection(v2_database()).unwrap();
        db.with(|c| {
            let rows: Vec<(String, String, Option<String>, String, String)> = c
                .prepare("SELECT id, engine, project_id, mode, title FROM chat_conversations ORDER BY id")?
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))?
                .collect::<Result<_, _>>()?;
            assert_eq!(
                rows,
                vec![
                    ("c1".into(), "anthropic-api".into(), None, "ask".into(), "Lifetimes".into()),
                    ("c2".into(), "openai-api".into(), None, "ask".into(), "Regex".into()),
                ]
            );
            type Row = (String, Option<String>, String, Option<String>, i64);
            let msgs: Vec<Row> = c
                .prepare("SELECT id, engine, status, error_json, created_at FROM chat_messages ORDER BY id")?
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))?
                .collect::<Result<_, _>>()?;
            assert_eq!(msgs.len(), 4);
            assert_eq!(msgs[1].1.as_deref(), Some("anthropic-api"));
            assert_eq!(msgs[3].2, "error");
            assert!(msgs[3].3.as_deref().unwrap().contains("network"));
            assert_eq!(msgs[0].1, None, "user messages have no engine");
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn v3_turns_builtin_presets_into_engine_settings_and_keeps_custom_ones() {
        let db = from_connection(v2_database()).unwrap();
        let presets: Vec<String> = db
            .with(|c| Ok(c.prepare("SELECT id FROM presets")?.query_map([], |r| r.get(0))?.collect::<Result<_, _>>()?))
            .unwrap();
        assert_eq!(presets, vec!["mine".to_string()]);
        assert_eq!(db.get_setting("engine_path:claude-code").unwrap().as_deref(), Some(r"C:\tools\claude.exe"));
        assert_eq!(db.get_setting("engine_path:codex").unwrap(), None, "default executables aren't overrides");
    }

    #[test]
    fn removing_a_project_keeps_its_chats_in_general() {
        let db = from_connection(v2_database()).unwrap();
        db.with(|c| {
            c.execute("UPDATE chat_conversations SET project_id = 'p1' WHERE id = 'c1'", [])?;
            c.execute("DELETE FROM projects WHERE id = 'p1'", [])?;
            let p: Option<String> = c.query_row("SELECT project_id FROM chat_conversations WHERE id = 'c1'", [], |r| r.get(0))?;
            assert_eq!(p, None);
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn v4_adds_the_backlog_to_a_v3_database() {
        let conn = v2_database();
        migrate_to(&conn, 3).unwrap();
        let db = from_connection(conn).unwrap();
        db.with(|c| {
            let version: i64 = c.query_row("PRAGMA user_version", [], |r| r.get(0))?;
            assert_eq!(version, MIGRATIONS.len() as i64);
            c.execute(
                "INSERT INTO backlog_items (id, project_id, seq, kind, title, created_at, updated_at) VALUES ('b1', 'p1', 1, 'bug', 'Crash', 1, 1)",
                [],
            )?;
            c.execute("UPDATE chat_conversations SET project_id = 'p1' WHERE id = 'c1'", [])?;
            c.execute("INSERT INTO backlog_links (item_id, conversation_id, purpose, created_at) VALUES ('b1', 'c1', 'fix', 1)", [])?;
            assert!(
                c.execute("INSERT INTO backlog_items (id, project_id, seq, kind, title, created_at, updated_at) VALUES ('b2', 'p1', 1, 'bug', 'Dup', 1, 1)", [])
                    .is_err(),
                "seq is unique per project"
            );
            let chats: i64 = c.query_row("SELECT COUNT(*) FROM chat_conversations", [], |r| r.get(0))?;
            assert_eq!(chats, 2, "chat history is untouched");
            Ok(())
        })
        .unwrap();
    }

    /// Migrates a COPY of a real database: `AGENTHUB_DB_COPY=<path> cargo test -- --ignored live_migrate_copy --nocapture`.
    #[test]
    #[ignore]
    fn live_migrate_copy() {
        let path = std::env::var("AGENTHUB_DB_COPY").expect("set AGENTHUB_DB_COPY to a copy of agenthub.db");
        let before = Connection::open(&path).unwrap();
        let v0: i64 = before.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        let count = |c: &Connection, t: &str| c.query_row(&format!("SELECT COUNT(*) FROM {t}"), [], |r| r.get::<_, i64>(0)).unwrap_or(-1);
        let (convs, msgs, presets) = (count(&before, "chat_conversations"), count(&before, "chat_messages"), count(&before, "presets"));
        drop(before);
        let db = Db::open(Path::new(&path)).unwrap();
        db.with(|c| {
            let v1: i64 = c.query_row("PRAGMA user_version", [], |r| r.get(0))?;
            println!("user_version {v0} -> {v1}");
            println!("conversations {convs} -> {}", count(c, "chat_conversations"));
            println!("messages {msgs} -> {}", count(c, "chat_messages"));
            println!("presets {presets} -> {} (built-ins removed)", count(c, "presets"));
            let engines: Vec<(String, i64)> = c
                .prepare("SELECT engine, COUNT(*) FROM chat_conversations GROUP BY engine")?
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
                .collect::<Result<_, _>>()?;
            println!("engines {engines:?}");
            assert_eq!(count(c, "chat_conversations"), convs);
            assert_eq!(count(c, "chat_messages"), msgs);
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn a_failed_migration_rolls_back() {
        let conn = Connection::open_in_memory().unwrap();
        migrate_to(&conn, 2).unwrap();
        // Break v3: its RENAME COLUMN fails if the column is gone.
        conn.execute_batch("ALTER TABLE chat_conversations RENAME COLUMN provider TO other;").unwrap();
        assert!(migrate(&conn).is_err());
        let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(version, 2);
        let items: i64 = conn
            .query_row("SELECT COUNT(*) FROM sqlite_master WHERE name = 'chat_items'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(items, 0, "nothing from v3 was kept");
    }
}
