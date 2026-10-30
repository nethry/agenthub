//! Chat history in SQLite (migrations v2–v3). A conversation belongs to a
//! project or to General (`project_id` NULL). Messages hold the visible text;
//! agent activity is stored as items of the assistant message of its turn.
//! No reasoning that wasn't shown, raw protocol messages or keys are stored.

use rusqlite::{params, Connection, OptionalExtension, Row};

use super::{
    ChatError, ChatMessage, Conversation, ConversationStatus, Engine, ErrorKind, Item, ItemBody, ItemStatus, MessageStatus, Mode, Policy,
    Role, Usage,
};
use crate::error::{now_ms, AppError, AppResult};
use crate::persistence::Db;

const CONV_COLUMNS: &str = "id, project_id, title, engine, model, mode, policy, status, runtime_session_id, created_at, updated_at";
const MSG_COLUMNS: &str = "id, conversation_id, role, content, status, engine, model, error_json, usage_json, created_at";
const ITEM_COLUMNS: &str = "id, message_id, idx, status, payload_json, created_at, updated_at";

fn conv_from_row(r: &Row) -> rusqlite::Result<Conversation> {
    let engine: String = r.get(3)?;
    let mode: String = r.get(5)?;
    let policy: String = r.get(6)?;
    let status: String = r.get(7)?;
    Ok(Conversation {
        id: r.get(0)?,
        project_id: r.get(1)?,
        title: r.get(2)?,
        engine: Engine::parse(&engine).unwrap_or(Engine::AnthropicApi),
        model: r.get(4)?,
        mode: Mode::parse(&mode),
        policy: Policy::parse(&policy),
        status: ConversationStatus::parse(&status),
        runtime_session_id: r.get(8)?,
        created_at: r.get(9)?,
        updated_at: r.get(10)?,
    })
}

fn msg_from_row(r: &Row) -> rusqlite::Result<ChatMessage> {
    let role: String = r.get(2)?;
    let status: String = r.get(4)?;
    let engine: Option<String> = r.get(5)?;
    let error: Option<String> = r.get(7)?;
    let usage: Option<String> = r.get(8)?;
    Ok(ChatMessage {
        id: r.get(0)?,
        conversation_id: r.get(1)?,
        role: if role == "user" { Role::User } else { Role::Assistant },
        content: r.get(3)?,
        status: MessageStatus::parse(&status),
        engine: engine.as_deref().and_then(Engine::parse),
        model: r.get(6)?,
        error: error.and_then(|e| serde_json::from_str(&e).ok()),
        usage: usage.and_then(|u| serde_json::from_str(&u).ok()),
        items: vec![],
        created_at: r.get(9)?,
    })
}

fn item_from_row(r: &Row) -> rusqlite::Result<Option<Item>> {
    let status: String = r.get(3)?;
    let payload: String = r.get(4)?;
    let Ok(body) = serde_json::from_str::<ItemBody>(&payload) else {
        return Ok(None); // written by a newer AgentHub; skip rather than fail the transcript
    };
    Ok(Some(Item {
        id: r.get(0)?,
        message_id: r.get(1)?,
        idx: r.get(2)?,
        status: ItemStatus::parse(&status),
        body,
        created_at: r.get(5)?,
        updated_at: r.get(6)?,
    }))
}

pub fn clean_title(title: &str) -> AppResult<String> {
    let t = title.split_whitespace().collect::<Vec<_>>().join(" ");
    if t.is_empty() || t.chars().count() > 120 {
        return Err(AppError::Invalid("Chat title must be 1–120 characters".into()));
    }
    Ok(t)
}

pub fn clean_model(model: &str) -> AppResult<String> {
    let m = model.trim();
    let ok = !m.is_empty()
        && m.len() <= 128
        && m.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | ':' | '/' | '@' | '[' | ']'));
    if !ok {
        return Err(AppError::Invalid(
            "Model IDs use letters, digits and - _ . : / @ [ ] (up to 128 characters)".into(),
        ));
    }
    Ok(m.to_string())
}

/// Every conversation, newest activity first. The UI groups them by project.
pub fn list_conversations(db: &Db) -> AppResult<Vec<Conversation>> {
    db.with(|c| {
        let mut stmt = c.prepare(&format!(
            "SELECT {CONV_COLUMNS} FROM chat_conversations ORDER BY updated_at DESC, created_at DESC"
        ))?;
        let rows = stmt.query_map([], conv_from_row)?.collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    })
}

fn conversation(c: &Connection, id: &str) -> AppResult<Conversation> {
    c.query_row(
        &format!("SELECT {CONV_COLUMNS} FROM chat_conversations WHERE id = ?1"),
        [id],
        conv_from_row,
    )
    .optional()?
    .ok_or_else(|| AppError::NotFound("Chat not found".into()))
}

pub fn get_conversation(db: &Db, id: &str) -> AppResult<Conversation> {
    db.with(|c| conversation(c, id))
}

pub struct NewConversation<'a> {
    pub project_id: Option<&'a str>,
    pub engine: Engine,
    pub model: &'a str,
    pub mode: Mode,
    pub policy: Policy,
    pub title: &'a str,
}

pub fn create_conversation(db: &Db, n: NewConversation) -> AppResult<Conversation> {
    let now = now_ms();
    let conv = Conversation {
        id: uuid::Uuid::new_v4().to_string(),
        project_id: n.project_id.map(str::to_string),
        title: clean_title(n.title)?,
        engine: n.engine,
        model: clean_model(n.model)?,
        mode: n.mode,
        policy: n.policy,
        status: ConversationStatus::Idle,
        runtime_session_id: None,
        created_at: now,
        updated_at: now,
    };
    db.with(|c| {
        c.execute(
            "INSERT INTO chat_conversations (id, project_id, title, engine, model, mode, policy, status, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'idle', ?8, ?9)",
            params![
                conv.id,
                conv.project_id,
                conv.title,
                conv.engine.as_str(),
                conv.model,
                conv.mode.as_str(),
                conv.policy.as_str(),
                conv.created_at,
                conv.updated_at
            ],
        )?;
        Ok(())
    })?;
    Ok(conv)
}

pub fn rename(db: &Db, id: &str, title: &str) -> AppResult<Conversation> {
    let title = clean_title(title)?;
    db.with(|c| {
        c.execute("UPDATE chat_conversations SET title = ?2 WHERE id = ?1", params![id, title])?;
        conversation(c, id)
    })
}

/// Engine and model. Switching engine drops the runtime session: sessions
/// aren't portable between engines.
pub fn set_engine(db: &Db, id: &str, engine: Engine, model: &str) -> AppResult<Conversation> {
    let model = clean_model(model)?;
    db.with(|c| {
        let cur = conversation(c, id)?;
        let session = if cur.engine == engine { cur.runtime_session_id } else { None };
        c.execute(
            "UPDATE chat_conversations SET engine = ?2, model = ?3, runtime_session_id = ?4 WHERE id = ?1",
            params![id, engine.as_str(), model, session],
        )?;
        conversation(c, id)
    })
}

pub fn set_mode(db: &Db, id: &str, mode: Mode) -> AppResult<Conversation> {
    db.with(|c| {
        c.execute("UPDATE chat_conversations SET mode = ?2 WHERE id = ?1", params![id, mode.as_str()])?;
        conversation(c, id)
    })
}

pub fn set_policy(db: &Db, id: &str, policy: Policy) -> AppResult<Conversation> {
    db.with(|c| {
        c.execute("UPDATE chat_conversations SET policy = ?2 WHERE id = ?1", params![id, policy.as_str()])?;
        conversation(c, id)
    })
}

pub fn set_status(db: &Db, id: &str, status: ConversationStatus) -> AppResult<()> {
    db.with(|c| {
        c.execute("UPDATE chat_conversations SET status = ?2 WHERE id = ?1", params![id, status.as_str()])?;
        Ok(())
    })
}

pub fn set_runtime_session(db: &Db, id: &str, session: Option<&str>) -> AppResult<()> {
    db.with(|c| {
        c.execute("UPDATE chat_conversations SET runtime_session_id = ?2 WHERE id = ?1", params![id, session])?;
        Ok(())
    })
}

pub fn delete(db: &Db, id: &str) -> AppResult<()> {
    db.with(|c| {
        c.execute("DELETE FROM chat_conversations WHERE id = ?1", [id])?;
        Ok(())
    })
}

fn items_for(c: &Connection, message_id: &str) -> AppResult<Vec<Item>> {
    let mut stmt = c.prepare(&format!("SELECT {ITEM_COLUMNS} FROM chat_items WHERE message_id = ?1 ORDER BY idx"))?;
    let rows = stmt.query_map([message_id], item_from_row)?.collect::<Result<Vec<_>, _>>()?;
    Ok(rows.into_iter().flatten().collect())
}

pub fn messages(db: &Db, conversation_id: &str) -> AppResult<Vec<ChatMessage>> {
    db.with(|c| {
        let mut stmt = c.prepare(&format!(
            "SELECT {MSG_COLUMNS} FROM chat_messages WHERE conversation_id = ?1 ORDER BY seq"
        ))?;
        let mut rows = stmt.query_map([conversation_id], msg_from_row)?.collect::<Result<Vec<_>, _>>()?;
        drop(stmt);
        for m in rows.iter_mut() {
            m.items = items_for(c, &m.id)?;
        }
        Ok(rows)
    })
}

fn message(c: &Connection, id: &str) -> AppResult<ChatMessage> {
    let mut m = c
        .query_row(&format!("SELECT {MSG_COLUMNS} FROM chat_messages WHERE id = ?1"), [id], msg_from_row)
        .optional()?
        .ok_or_else(|| AppError::NotFound("Message not found".into()))?;
    m.items = items_for(c, id)?;
    Ok(m)
}

pub fn get_message(db: &Db, id: &str) -> AppResult<ChatMessage> {
    db.with(|c| message(c, id))
}

fn insert(
    c: &Connection,
    conversation_id: &str,
    role: Role,
    content: &str,
    status: MessageStatus,
    engine: Option<Engine>,
    model: Option<&str>,
) -> AppResult<ChatMessage> {
    let seq: i64 = c.query_row(
        "SELECT COALESCE(MAX(seq), 0) + 1 FROM chat_messages WHERE conversation_id = ?1",
        [conversation_id],
        |r| r.get(0),
    )?;
    let msg = ChatMessage {
        id: uuid::Uuid::new_v4().to_string(),
        conversation_id: conversation_id.to_string(),
        role,
        content: content.to_string(),
        status,
        engine,
        model: model.map(str::to_string),
        error: None,
        usage: None,
        items: vec![],
        created_at: now_ms(),
    };
    c.execute(
        "INSERT INTO chat_messages (id, conversation_id, seq, role, content, status, engine, model, error_json, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, NULL, ?9)",
        params![
            msg.id,
            msg.conversation_id,
            seq,
            role.as_str(),
            msg.content,
            status.as_str(),
            engine.map(Engine::as_str),
            msg.model,
            msg.created_at
        ],
    )?;
    Ok(msg)
}

pub struct Reply {
    pub user_message: Option<ChatMessage>,
    pub assistant_message: ChatMessage,
    pub removed_ids: Vec<String>,
}

/// Starts a reply in one transaction, so a retry or regenerate can never
/// leave two answers to the same question.
///
/// - `user_content: Some(text)`: stores the question, then a `streaming` reply.
/// - `None` (regenerate / retry): deletes the replies after the last question,
///   then adds a fresh `streaming` reply.
pub fn begin_reply(db: &Db, conversation_id: &str, user_content: Option<&str>, engine: Engine, model: &str) -> AppResult<Reply> {
    db.with(|c| {
        let tx = c.unchecked_transaction()?;
        conversation(&tx, conversation_id)?;
        let mut removed_ids = Vec::new();
        let user_message = match user_content {
            Some(text) => Some(insert(&tx, conversation_id, Role::User, text, MessageStatus::Complete, None, None)?),
            None => {
                let last_user: Option<i64> = tx.query_row(
                    "SELECT MAX(seq) FROM chat_messages WHERE conversation_id = ?1 AND role = 'user'",
                    [conversation_id],
                    |r| r.get(0),
                )?;
                let Some(last_user) = last_user else {
                    return Err(AppError::Invalid("There is no question to answer yet".into()));
                };
                let mut stmt = tx.prepare("SELECT id FROM chat_messages WHERE conversation_id = ?1 AND seq > ?2")?;
                removed_ids = stmt
                    .query_map(params![conversation_id, last_user], |r| r.get(0))?
                    .collect::<Result<Vec<String>, _>>()?;
                drop(stmt);
                tx.execute(
                    "DELETE FROM chat_messages WHERE conversation_id = ?1 AND seq > ?2",
                    params![conversation_id, last_user],
                )?;
                None
            }
        };
        let assistant_message = insert(&tx, conversation_id, Role::Assistant, "", MessageStatus::Streaming, Some(engine), Some(model))?;
        tx.execute(
            "UPDATE chat_conversations SET engine = ?2, model = ?3, status = 'running', updated_at = ?4 WHERE id = ?1",
            params![conversation_id, engine.as_str(), model, now_ms()],
        )?;
        tx.commit()?;
        Ok(Reply { user_message, assistant_message, removed_ids })
    })
}

/// Saves partial text while streaming, so a crash keeps what was shown.
pub fn save_partial(db: &Db, message_id: &str, content: &str) -> AppResult<()> {
    db.with(|c| {
        c.execute(
            "UPDATE chat_messages SET content = ?2 WHERE id = ?1 AND status = 'streaming'",
            params![message_id, content],
        )?;
        Ok(())
    })
}

/// Final state of a reply. Returns `None` when the chat was deleted meanwhile.
pub fn finish(
    db: &Db,
    message_id: &str,
    content: &str,
    status: MessageStatus,
    error: Option<&ChatError>,
    usage: Option<&Usage>,
) -> AppResult<Option<ChatMessage>> {
    let error_json = error.map(|e| serde_json::to_string(e).unwrap_or_default());
    let usage_json = usage.filter(|u| !u.is_empty()).map(|u| serde_json::to_string(u).unwrap_or_default());
    db.with(|c| {
        let n = c.execute(
            "UPDATE chat_messages SET content = ?2, status = ?3, error_json = ?4, usage_json = ?5 WHERE id = ?1",
            params![message_id, content, status.as_str(), error_json, usage_json],
        )?;
        if n == 0 {
            return Ok(None);
        }
        Ok(Some(message(c, message_id)?))
    })
}

/// Inserts or replaces an item. Returns false when its message is gone.
pub fn upsert_item(db: &Db, conversation_id: &str, item: &Item) -> AppResult<bool> {
    let payload = serde_json::to_string(&item.body).unwrap_or_default();
    db.with(|c| {
        let exists: bool = c
            .query_row("SELECT 1 FROM chat_messages WHERE id = ?1", [&item.message_id], |_| Ok(true))
            .optional()?
            .unwrap_or(false);
        if !exists {
            return Ok(false);
        }
        c.execute(
            "INSERT INTO chat_items (id, conversation_id, message_id, idx, kind, status, payload_json, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(id) DO UPDATE SET status = excluded.status, payload_json = excluded.payload_json, updated_at = excluded.updated_at",
            params![
                item.id,
                conversation_id,
                item.message_id,
                item.idx,
                item.body.kind(),
                item.status.as_str(),
                payload,
                item.created_at,
                item.updated_at
            ],
        )?;
        Ok(true)
    })
}

pub fn get_item(db: &Db, id: &str) -> AppResult<(String, Item)> {
    db.with(|c| {
        let row = c
            .query_row(
                &format!("SELECT conversation_id, {ITEM_COLUMNS} FROM chat_items WHERE id = ?1"),
                [id],
                |r| {
                    let conv: String = r.get(0)?;
                    let status: String = r.get(4)?;
                    let payload: String = r.get(5)?;
                    Ok((conv, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, i64>(3)?, status, payload, r.get::<_, i64>(6)?, r.get::<_, i64>(7)?))
                },
            )
            .optional()?
            .ok_or_else(|| AppError::NotFound("Item not found".into()))?;
        let body = serde_json::from_str(&row.5).map_err(|_| AppError::Invalid("Item can't be read".into()))?;
        Ok((
            row.0,
            Item { id: row.1, message_id: row.2, idx: row.3, status: ItemStatus::parse(&row.4), body, created_at: row.6, updated_at: row.7 },
        ))
    })
}

/// A file an agent changed, for the Overview and the Editor's AI badge.
#[derive(Debug, Clone, serde::Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    pub conversation_id: String,
    pub item_id: String,
    pub engine: Engine,
    pub path: String,
    pub state: super::ChangeState,
    pub additions: u32,
    pub deletions: u32,
    pub at: i64,
}

/// Latest change per path in a project's conversations, newest first.
pub fn changed_files(db: &Db, project_id: &str, limit: usize) -> AppResult<Vec<ChangedFile>> {
    db.with(|c| {
        let mut stmt = c.prepare(
            "SELECT i.conversation_id, i.id, conv.engine, i.payload_json, i.updated_at
             FROM chat_items i JOIN chat_conversations conv ON conv.id = i.conversation_id
             WHERE conv.project_id = ?1 AND i.kind = 'file_change'
             ORDER BY i.updated_at DESC LIMIT 500",
        )?;
        let rows = stmt.query_map([project_id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?, r.get::<_, i64>(4)?))
        })?;
        let mut out: Vec<ChangedFile> = Vec::new();
        for row in rows {
            let (conv, item, engine, payload, at) = row?;
            let Ok(ItemBody::FileChange { path, state, additions, deletions, .. }) = serde_json::from_str(&payload) else { continue };
            if out.iter().any(|f| f.path == path) {
                continue;
            }
            out.push(ChangedFile {
                conversation_id: conv,
                item_id: item,
                engine: Engine::parse(&engine).unwrap_or(Engine::Codex),
                path,
                state,
                additions,
                deletions,
                at,
            });
            if out.len() >= limit {
                break;
            }
        }
        Ok(out)
    })
}

/// Startup cleanup after a crash or close mid-turn: replies still
/// `streaming` become `error` (interrupted), running conversations become
/// `interrupted`, and approvals nobody answered are cancelled. Nothing re-runs.
pub fn recover_interrupted(db: &Db) -> AppResult<usize> {
    let err = ChatError::new(ErrorKind::Interrupted, "This answer was cut off when AgentHub closed.");
    let json = serde_json::to_string(&err).unwrap_or_default();
    db.with(|c| {
        let tx = c.unchecked_transaction()?;
        let n = tx.execute(
            "UPDATE chat_messages SET status = 'error', error_json = ?1 WHERE status = 'streaming'",
            [json],
        )?;
        tx.execute(
            "UPDATE chat_conversations SET status = 'interrupted' WHERE status IN ('running', 'waiting_for_approval')",
            [],
        )?;
        tx.execute(
            "UPDATE chat_items SET status = 'cancelled' WHERE status IN ('pending', 'running')",
            [],
        )?;
        tx.commit()?;
        Ok(n)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat::{ChangeKind, ChangeState};

    fn db_with_chat() -> (Db, Conversation) {
        let db = Db::open_in_memory().unwrap();
        let conv = create_conversation(
            &db,
            NewConversation {
                project_id: None,
                engine: Engine::AnthropicApi,
                model: "claude-opus-5-5",
                mode: Mode::Ask,
                policy: Policy::Ask,
                title: "First question",
            },
        )
        .unwrap();
        (db, conv)
    }

    fn project(db: &Db, id: &str) {
        db.with(|c| {
            c.execute("INSERT INTO projects (id, name, path, created_at) VALUES (?1, ?1, ?1, 0)", [id])?;
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn stores_messages_in_order() {
        let (db, conv) = db_with_chat();
        let r1 = begin_reply(&db, &conv.id, Some("Q1"), Engine::AnthropicApi, "claude-opus-5-5").unwrap();
        let usage = Usage { input_tokens: Some(3), output_tokens: Some(4), cost_usd: None };
        finish(&db, &r1.assistant_message.id, "A1", MessageStatus::Complete, None, Some(&usage)).unwrap();
        let r2 = begin_reply(&db, &conv.id, Some("Q2"), Engine::OpenAiApi, "gpt-6.1-sol").unwrap();
        save_partial(&db, &r2.assistant_message.id, "A2 part").unwrap();
        let msgs = messages(&db, &conv.id).unwrap();
        let text: Vec<_> = msgs.iter().map(|m| (m.role, m.content.as_str(), m.status)).collect();
        assert_eq!(
            text,
            vec![
                (Role::User, "Q1", MessageStatus::Complete),
                (Role::Assistant, "A1", MessageStatus::Complete),
                (Role::User, "Q2", MessageStatus::Complete),
                (Role::Assistant, "A2 part", MessageStatus::Streaming),
            ]
        );
        assert_eq!(msgs[1].usage, Some(usage));
        assert_eq!(msgs[3].model.as_deref(), Some("gpt-6.1-sol"));
        let conv = get_conversation(&db, &conv.id).unwrap();
        assert_eq!((conv.engine, conv.model.as_str(), conv.status), (Engine::OpenAiApi, "gpt-6.1-sol", ConversationStatus::Running));
    }

    #[test]
    fn regenerate_replaces_the_last_reply_and_its_items() {
        let (db, conv) = db_with_chat();
        let r1 = begin_reply(&db, &conv.id, Some("Q1"), Engine::AnthropicApi, "m").unwrap();
        let item = Item {
            id: "it".into(),
            message_id: r1.assistant_message.id.clone(),
            idx: 0,
            status: ItemStatus::Completed,
            body: ItemBody::Text { text: "x".into() },
            created_at: 0,
            updated_at: 0,
        };
        assert!(upsert_item(&db, &conv.id, &item).unwrap());
        let err = ChatError::new(ErrorKind::Network, "lost");
        finish(&db, &r1.assistant_message.id, "partial", MessageStatus::Error, Some(&err), None).unwrap();
        let r2 = begin_reply(&db, &conv.id, None, Engine::AnthropicApi, "m").unwrap();
        assert_eq!(r2.removed_ids, vec![r1.assistant_message.id.clone()]);
        assert!(get_item(&db, "it").is_err(), "items cascade with their message");
        let msgs = messages(&db, &conv.id).unwrap();
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[1].id, r2.assistant_message.id);
    }

    #[test]
    fn items_round_trip_in_order_and_update_in_place() {
        let (db, conv) = db_with_chat();
        let r = begin_reply(&db, &conv.id, Some("Q"), Engine::Codex, "m").unwrap();
        let mk = |id: &str, idx: i64, body: ItemBody, status| Item {
            id: id.into(),
            message_id: r.assistant_message.id.clone(),
            idx,
            status,
            body,
            created_at: 1,
            updated_at: 1,
        };
        upsert_item(&db, &conv.id, &mk("b", 1, ItemBody::Text { text: "after".into() }, ItemStatus::Completed)).unwrap();
        let mut cmd = mk(
            "a",
            0,
            ItemBody::Command { command: "cargo test".into(), cwd: None, output: String::new(), exit_code: None, duration_ms: None },
            ItemStatus::Running,
        );
        upsert_item(&db, &conv.id, &cmd).unwrap();
        cmd.status = ItemStatus::Completed;
        cmd.body = ItemBody::Command { command: "cargo test".into(), cwd: None, output: "ok".into(), exit_code: Some(0), duration_ms: Some(4) };
        upsert_item(&db, &conv.id, &cmd).unwrap();
        let m = get_message(&db, &r.assistant_message.id).unwrap();
        assert_eq!(m.items.iter().map(|i| i.id.as_str()).collect::<Vec<_>>(), vec!["a", "b"]);
        assert_eq!(m.items[0].status, ItemStatus::Completed);
        assert!(matches!(&m.items[0].body, ItemBody::Command { exit_code: Some(0), .. }));
    }

    #[test]
    fn recovery_marks_interrupted_turns_and_cancels_open_approvals() {
        let (db, conv) = db_with_chat();
        let r = begin_reply(&db, &conv.id, Some("Q"), Engine::AnthropicApi, "m").unwrap();
        save_partial(&db, &r.assistant_message.id, "half").unwrap();
        let pending = Item {
            id: "p".into(),
            message_id: r.assistant_message.id.clone(),
            idx: 0,
            status: ItemStatus::Pending,
            body: ItemBody::System { text: "x".into(), tone: crate::chat::Tone::Info },
            created_at: 0,
            updated_at: 0,
        };
        upsert_item(&db, &conv.id, &pending).unwrap();
        assert_eq!(recover_interrupted(&db).unwrap(), 1);
        let m = messages(&db, &conv.id).unwrap().pop().unwrap();
        assert_eq!(m.status, MessageStatus::Error);
        assert_eq!(m.content, "half");
        assert_eq!(m.error.unwrap().kind, ErrorKind::Interrupted);
        assert_eq!(m.items[0].status, ItemStatus::Cancelled);
        assert_eq!(get_conversation(&db, &conv.id).unwrap().status, ConversationStatus::Interrupted);
    }

    #[test]
    fn conversations_belong_to_projects_and_engine_switches_drop_the_session() {
        let db = Db::open_in_memory().unwrap();
        project(&db, "p1");
        let conv = create_conversation(
            &db,
            NewConversation { project_id: Some("p1"), engine: Engine::Codex, model: "gpt-6.1-sol", mode: Mode::Plan, policy: Policy::Ask, title: "Plan it" },
        )
        .unwrap();
        assert_eq!(conv.project_id.as_deref(), Some("p1"));
        set_runtime_session(&db, &conv.id, Some("thr_1")).unwrap();
        assert_eq!(set_engine(&db, &conv.id, Engine::Codex, "gpt-6.1-mini").unwrap().runtime_session_id.as_deref(), Some("thr_1"));
        assert_eq!(set_engine(&db, &conv.id, Engine::ClaudeCode, "claude-opus-5-5").unwrap().runtime_session_id, None);
        assert_eq!(set_mode(&db, &conv.id, Mode::Agent).unwrap().mode, Mode::Agent);
        assert_eq!(set_policy(&db, &conv.id, Policy::AutoEdits).unwrap().policy, Policy::AutoEdits);
    }

    #[test]
    fn changed_files_keep_the_latest_change_per_path() {
        let db = Db::open_in_memory().unwrap();
        project(&db, "p1");
        let conv = create_conversation(
            &db,
            NewConversation { project_id: Some("p1"), engine: Engine::Codex, model: "m", mode: Mode::Agent, policy: Policy::Ask, title: "T" },
        )
        .unwrap();
        let r = begin_reply(&db, &conv.id, Some("Q"), Engine::Codex, "m").unwrap();
        for (id, at, adds) in [("x1", 1, 1), ("x2", 2, 5)] {
            let item = Item {
                id: id.into(),
                message_id: r.assistant_message.id.clone(),
                idx: at,
                status: ItemStatus::Completed,
                body: ItemBody::FileChange {
                    path: "src/a.rs".into(),
                    change: ChangeKind::Modify,
                    additions: adds,
                    deletions: 0,
                    checkpoint: None,
                    state: ChangeState::Applied,
                },
                created_at: at,
                updated_at: at,
            };
            upsert_item(&db, &conv.id, &item).unwrap();
        }
        let files = changed_files(&db, "p1", 10).unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!((files[0].item_id.as_str(), files[0].additions), ("x2", 5));
    }

    #[test]
    fn rename_delete_and_validation() {
        let (db, conv) = db_with_chat();
        assert_eq!(rename(&db, &conv.id, "  New   name ").unwrap().title, "New name");
        assert!(rename(&db, &conv.id, "   ").is_err());
        assert!(set_engine(&db, &conv.id, Engine::OpenAiApi, "bad model id").is_err());
        begin_reply(&db, &conv.id, Some("Q"), Engine::AnthropicApi, "m").unwrap();
        delete(&db, &conv.id).unwrap();
        assert!(list_conversations(&db).unwrap().is_empty());
        assert!(messages(&db, &conv.id).unwrap().is_empty(), "messages cascade");
        assert!(finish(&db, "gone", "x", MessageStatus::Complete, None, None).unwrap().is_none());
    }
}
