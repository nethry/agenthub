//! SQLite storage of backlog items, their chat links and screenshot metadata.

use std::collections::HashMap;

use rusqlite::{params, Connection, OptionalExtension, Row};

use super::{clean_text, clean_title, BacklogImage, BacklogItem, BacklogLink, ItemPatch, Kind, NewItem, Priority, Purpose, Status, MAX_RELATED};
use crate::error::{now_ms, AppError, AppResult};
use crate::persistence::Db;

const COLUMNS: &str = "id, project_id, seq, kind, title, body, status, priority, plan, related_json, created_at, updated_at";

fn bad(what: &str, value: &str) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, format!("unknown backlog {what} {value:?}").into())
}

fn from_row(r: &Row) -> rusqlite::Result<BacklogItem> {
    let kind: String = r.get(3)?;
    let status: String = r.get(6)?;
    let priority: String = r.get(7)?;
    let related: String = r.get(9)?;
    Ok(BacklogItem {
        id: r.get(0)?,
        project_id: r.get(1)?,
        seq: r.get(2)?,
        kind: Kind::parse(&kind).ok_or_else(|| bad("kind", &kind))?,
        title: r.get(4)?,
        body: r.get(5)?,
        status: Status::parse(&status).ok_or_else(|| bad("status", &status))?,
        priority: Priority::parse(&priority).ok_or_else(|| bad("priority", &priority))?,
        plan: r.get(8)?,
        related: serde_json::from_str(&related).unwrap_or_default(),
        images: vec![],
        links: vec![],
        created_at: r.get(10)?,
        updated_at: r.get(11)?,
    })
}

/// Fills in screenshots and links of `items` (all of one project, or one item).
fn attach(c: &Connection, items: &mut [BacklogItem], filter: &str, arg: &str) -> AppResult<()> {
    let mut images: HashMap<String, Vec<BacklogImage>> = HashMap::new();
    let mut stmt = c.prepare(&format!(
        "SELECT i.item_id, i.id, i.name, i.mime, i.size, i.created_at FROM backlog_images i
         JOIN backlog_items b ON b.id = i.item_id WHERE {filter} ORDER BY i.created_at, i.rowid"
    ))?;
    let rows = stmt.query_map([arg], |r| {
        Ok((r.get::<_, String>(0)?, BacklogImage { id: r.get(1)?, name: r.get(2)?, mime: r.get(3)?, size: r.get::<_, i64>(4)? as u64, created_at: r.get(5)? }))
    })?;
    for row in rows {
        let (item, img) = row?;
        images.entry(item).or_default().push(img);
    }
    let mut links: HashMap<String, Vec<BacklogLink>> = HashMap::new();
    let mut stmt = c.prepare(&format!(
        "SELECT l.item_id, l.conversation_id, l.purpose, l.created_at FROM backlog_links l
         JOIN backlog_items b ON b.id = l.item_id WHERE {filter} ORDER BY l.created_at"
    ))?;
    let rows = stmt.query_map([arg], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, i64>(3)?)))?;
    for row in rows {
        let (item, conversation_id, purpose, created_at) = row?;
        let purpose = Purpose::parse(&purpose).ok_or_else(|| bad("purpose", &purpose))?;
        links.entry(item).or_default().push(BacklogLink { conversation_id, purpose, created_at });
    }
    for item in items {
        item.images = images.remove(&item.id).unwrap_or_default();
        item.links = links.remove(&item.id).unwrap_or_default();
    }
    Ok(())
}

/// A project's items, newest first.
pub fn list(db: &Db, project_id: &str) -> AppResult<Vec<BacklogItem>> {
    db.with(|c| {
        let mut stmt = c.prepare(&format!("SELECT {COLUMNS} FROM backlog_items WHERE project_id = ?1 ORDER BY seq DESC"))?;
        let mut items = stmt.query_map([project_id], from_row)?.collect::<Result<Vec<_>, _>>()?;
        attach(c, &mut items, "b.project_id = ?1", project_id)?;
        Ok(items)
    })
}

fn get_in(c: &Connection, id: &str) -> AppResult<BacklogItem> {
    let item = c
        .query_row(&format!("SELECT {COLUMNS} FROM backlog_items WHERE id = ?1"), [id], from_row)
        .optional()?
        .ok_or_else(|| AppError::NotFound("This backlog item no longer exists".into()))?;
    let mut items = [item];
    attach(c, &mut items, "b.id = ?1", id)?;
    let [item] = items;
    Ok(item)
}

pub fn get(db: &Db, id: &str) -> AppResult<BacklogItem> {
    db.with(|c| get_in(c, id))
}

pub fn create(db: &Db, n: NewItem) -> AppResult<BacklogItem> {
    let title = clean_title(&n.title)?;
    let body = clean_text(&n.body, "description")?;
    crate::projects::get(db, &n.project_id)?;
    let id = uuid::Uuid::new_v4().to_string();
    let now = now_ms();
    db.with(|c| {
        let tx = c.unchecked_transaction()?;
        let seq: i64 = tx.query_row("SELECT COALESCE(MAX(seq), 0) + 1 FROM backlog_items WHERE project_id = ?1", [&n.project_id], |r| r.get(0))?;
        tx.execute(
            "INSERT INTO backlog_items (id, project_id, seq, kind, title, body, status, priority, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'open', ?7, ?8, ?8)",
            params![id, n.project_id, seq, n.kind.as_str(), title, body, n.priority.as_str(), now],
        )?;
        tx.commit()?;
        get_in(c, &id)
    })
}

/// Related items must be other items of the same project.
fn clean_related(c: &Connection, item: &BacklogItem, related: &[String]) -> AppResult<Vec<String>> {
    let mut out: Vec<String> = Vec::new();
    for r in related {
        if r == &item.id || out.contains(r) {
            continue;
        }
        let project: Option<String> = c.query_row("SELECT project_id FROM backlog_items WHERE id = ?1", [r], |row| row.get(0)).optional()?;
        if project.as_deref() != Some(item.project_id.as_str()) {
            return Err(AppError::Invalid("Related items must belong to the same project".into()));
        }
        out.push(r.clone());
    }
    if out.len() > MAX_RELATED {
        return Err(AppError::Invalid(format!("Link up to {MAX_RELATED} related items")));
    }
    Ok(out)
}

pub fn update(db: &Db, id: &str, patch: ItemPatch) -> AppResult<BacklogItem> {
    let title = patch.title.as_deref().map(clean_title).transpose()?;
    let body = patch.body.as_deref().map(|b| clean_text(b, "description")).transpose()?;
    db.with(|c| {
        let cur = get_in(c, id)?;
        let related = match &patch.related {
            Some(r) => clean_related(c, &cur, r)?,
            None => cur.related.clone(),
        };
        c.execute(
            "UPDATE backlog_items SET title = ?2, body = ?3, priority = ?4, related_json = ?5, updated_at = ?6 WHERE id = ?1",
            params![
                id,
                title.unwrap_or(cur.title),
                body.unwrap_or(cur.body),
                patch.priority.unwrap_or(cur.priority).as_str(),
                serde_json::to_string(&related).unwrap_or_else(|_| "[]".into()),
                now_ms()
            ],
        )?;
        get_in(c, id)
    })
}

pub fn set_status(db: &Db, id: &str, status: Status) -> AppResult<BacklogItem> {
    db.with(|c| {
        let n = c.execute("UPDATE backlog_items SET status = ?2, updated_at = ?3 WHERE id = ?1", params![id, status.as_str(), now_ms()])?;
        if n == 0 {
            return Err(AppError::NotFound("This backlog item no longer exists".into()));
        }
        get_in(c, id)
    })
}

/// Saves (or with `None` / blank, clears) the item's plan.
pub fn set_plan(db: &Db, id: &str, plan: Option<&str>) -> AppResult<BacklogItem> {
    let plan = plan.map(|p| clean_text(p, "plan")).transpose()?.filter(|p| !p.trim().is_empty());
    db.with(|c| {
        let n = c.execute("UPDATE backlog_items SET plan = ?2, updated_at = ?3 WHERE id = ?1", params![id, plan, now_ms()])?;
        if n == 0 {
            return Err(AppError::NotFound("This backlog item no longer exists".into()));
        }
        get_in(c, id)
    })
}

/// Deletes the row with its links and screenshot rows; other items drop it from `related`.
pub fn delete(db: &Db, id: &str) -> AppResult<()> {
    db.with(|c| {
        let tx = c.unchecked_transaction()?;
        let project: Option<String> = tx.query_row("SELECT project_id FROM backlog_items WHERE id = ?1", [id], |r| r.get(0)).optional()?;
        tx.execute("DELETE FROM backlog_items WHERE id = ?1", [id])?;
        if let Some(p) = project {
            let mut stmt = tx.prepare("SELECT id, related_json FROM backlog_items WHERE project_id = ?1 AND related_json LIKE ?2")?;
            let rows = stmt
                .query_map(params![p, format!("%{id}%")], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
                .collect::<Result<Vec<_>, _>>()?;
            drop(stmt);
            for (other, json) in rows {
                let mut related: Vec<String> = serde_json::from_str(&json).unwrap_or_default();
                related.retain(|r| r != id);
                tx.execute(
                    "UPDATE backlog_items SET related_json = ?2 WHERE id = ?1",
                    params![other, serde_json::to_string(&related).unwrap_or_else(|_| "[]".into())],
                )?;
            }
        }
        tx.commit()?;
        Ok(())
    })
}

/// Links a chat to an item (the first purpose is kept).
pub fn add_link(db: &Db, item_id: &str, conversation_id: &str, purpose: Purpose) -> AppResult<()> {
    db.with(|c| {
        c.execute(
            "INSERT OR IGNORE INTO backlog_links (item_id, conversation_id, purpose, created_at) VALUES (?1, ?2, ?3, ?4)",
            params![item_id, conversation_id, purpose.as_str(), now_ms()],
        )?;
        Ok(())
    })
}

pub fn add_image(db: &Db, item_id: &str, img: &BacklogImage) -> AppResult<()> {
    db.with(|c| {
        c.execute(
            "INSERT INTO backlog_images (id, item_id, name, mime, size, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![img.id, item_id, img.name, img.mime, img.size as i64, img.created_at],
        )?;
        c.execute("UPDATE backlog_items SET updated_at = ?2 WHERE id = ?1", params![item_id, now_ms()])?;
        Ok(())
    })
}

/// A screenshot and its item id.
pub fn image(db: &Db, image_id: &str) -> AppResult<(String, BacklogImage)> {
    db.with(|c| {
        c.query_row("SELECT item_id, id, name, mime, size, created_at FROM backlog_images WHERE id = ?1", [image_id], |r| {
            Ok((r.get(0)?, BacklogImage { id: r.get(1)?, name: r.get(2)?, mime: r.get(3)?, size: r.get::<_, i64>(4)? as u64, created_at: r.get(5)? }))
        })
        .optional()?
        .ok_or_else(|| AppError::NotFound("This screenshot is no longer stored".into()))
    })
}

pub fn remove_image(db: &Db, image_id: &str) -> AppResult<()> {
    db.with(|c| {
        c.execute("DELETE FROM backlog_images WHERE id = ?1", [image_id])?;
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat::repository::{create_conversation, NewConversation};
    use crate::chat::{Engine, Mode, Policy};

    fn setup() -> (tempfile::TempDir, Db, String) {
        let dir = tempfile::tempdir().unwrap();
        let db = Db::open_in_memory().unwrap();
        let p = crate::projects::add(&db, &dir.path().to_string_lossy(), Some("P")).unwrap();
        (dir, db, p.id)
    }

    fn new(project: &str, kind: Kind, title: &str) -> NewItem {
        NewItem { project_id: project.into(), kind, title: title.into(), body: "Body".into(), priority: Priority::Normal }
    }

    #[test]
    fn creates_with_one_sequence_per_project_and_updates() {
        let (_dir, db, project) = setup();
        let a = create(&db, new(&project, Kind::Feature, "  Dark mode  ")).unwrap();
        let b = create(&db, new(&project, Kind::Bug, "Crash on save")).unwrap();
        assert_eq!((a.seq, a.key(), a.title.as_str(), a.status), (1, "FEAT-1".to_string(), "Dark mode", Status::Open));
        assert_eq!(b.key(), "BUG-2");
        assert!(create(&db, new(&project, Kind::Bug, "   ")).is_err());
        assert!(create(&db, new("nope", Kind::Bug, "x")).is_err());

        let a = update(&db, &a.id, ItemPatch { body: Some("New".into()), priority: Some(Priority::High), related: Some(vec![b.id.clone(), a.id.clone()]), ..Default::default() }).unwrap();
        assert_eq!((a.body.as_str(), a.priority, a.title.as_str()), ("New", Priority::High, "Dark mode"));
        assert_eq!(a.related, vec![b.id.clone()], "an item isn't related to itself");
        assert!(update(&db, &a.id, ItemPatch { related: Some(vec!["other".into()]), ..Default::default() }).is_err());

        assert_eq!(set_status(&db, &a.id, Status::Planned).unwrap().status, Status::Planned);
        assert_eq!(set_plan(&db, &a.id, Some("1. Do it\n")).unwrap().plan.as_deref(), Some("1. Do it"));
        assert_eq!(set_plan(&db, &a.id, Some("  ")).unwrap().plan, None);

        let list = list(&db, &project).unwrap();
        assert_eq!(list.iter().map(|i| i.seq).collect::<Vec<_>>(), vec![2, 1], "newest first");

        delete(&db, &b.id).unwrap();
        assert!(get(&db, &a.id).unwrap().related.is_empty(), "a deleted item leaves `related`");
    }

    #[test]
    fn links_go_with_their_chat_and_items_with_their_project() {
        let (_dir, db, project) = setup();
        let item = create(&db, new(&project, Kind::Feature, "F")).unwrap();
        let conv = create_conversation(
            &db,
            NewConversation { project_id: Some(&project), engine: Engine::Codex, model: "m", mode: Mode::Plan, policy: Policy::Ask, title: "t" },
        )
        .unwrap();
        add_link(&db, &item.id, &conv.id, Purpose::Plan).unwrap();
        add_link(&db, &item.id, &conv.id, Purpose::Implement).unwrap();
        let links = get(&db, &item.id).unwrap().links;
        assert_eq!(links.len(), 1);
        assert_eq!((links[0].conversation_id.as_str(), links[0].purpose), (conv.id.as_str(), Purpose::Plan));

        crate::chat::repository::delete(&db, &conv.id).unwrap();
        assert!(get(&db, &item.id).unwrap().links.is_empty(), "deleting a chat drops its link, not the item");

        crate::projects::remove(&db, &project).unwrap();
        assert!(get(&db, &item.id).is_err(), "items go with their project");
    }
}
