//! Backlog: the features and bugs of a project, kept in AgentHub's SQLite.
//! Chat can plan, investigate, implement or fix an item; the item then reaches
//! the agent only through the budgeted context pack (`context.rs`), shown in
//! the transcript as a chip. Screenshots pasted into an item live in the app
//! data folder (`chat::images` storage), never in the project or in SQLite.

pub mod context;
pub mod repository;

use std::path::PathBuf;
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::chat::images::{self, Images, NewImage};
use crate::error::{now_ms, AppError, AppResult};
use crate::persistence::Db;

/// Screenshots one item keeps.
pub const MAX_ITEM_IMAGES: usize = 8;
pub const MAX_TITLE_CHARS: usize = 200;
pub const MAX_BODY_CHARS: usize = 100_000;
pub const MAX_RELATED: usize = 10;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Feature,
    Bug,
}

impl Kind {
    pub fn as_str(self) -> &'static str {
        match self {
            Kind::Feature => "feature",
            Kind::Bug => "bug",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "feature" => Some(Kind::Feature),
            "bug" => Some(Kind::Bug),
            _ => None,
        }
    }

    fn prefix(self) -> &'static str {
        match self {
            Kind::Feature => "FEAT",
            Kind::Bug => "BUG",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Kind::Feature => "Feature",
            Kind::Bug => "Bug",
        }
    }
}

/// One set of statuses; the UI names some of them per kind (a done bug is "Fixed").
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Open,
    Planned,
    InProgress,
    Review,
    Done,
    Dropped,
}

impl Status {
    pub fn as_str(self) -> &'static str {
        match self {
            Status::Open => "open",
            Status::Planned => "planned",
            Status::InProgress => "in_progress",
            Status::Review => "review",
            Status::Done => "done",
            Status::Dropped => "dropped",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "open" => Some(Status::Open),
            "planned" => Some(Status::Planned),
            "in_progress" => Some(Status::InProgress),
            "review" => Some(Status::Review),
            "done" => Some(Status::Done),
            "dropped" => Some(Status::Dropped),
            _ => None,
        }
    }

    /// Still to be worked on (shown to agents as context).
    pub fn is_open(self) -> bool {
        !matches!(self, Status::Done | Status::Dropped)
    }

    pub fn label(self, kind: Kind) -> &'static str {
        match (self, kind) {
            (Status::Open, Kind::Feature) => "Idea",
            (Status::Open, Kind::Bug) => "Reported",
            (Status::Planned, Kind::Feature) => "Planned",
            (Status::Planned, Kind::Bug) => "Diagnosed",
            (Status::InProgress, _) => "In progress",
            (Status::Review, _) => "Review",
            (Status::Done, Kind::Feature) => "Done",
            (Status::Done, Kind::Bug) => "Fixed",
            (Status::Dropped, Kind::Feature) => "Won't do",
            (Status::Dropped, Kind::Bug) => "Won't fix",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Priority {
    Low,
    Normal,
    High,
}

impl Priority {
    pub fn as_str(self) -> &'static str {
        match self {
            Priority::Low => "low",
            Priority::Normal => "normal",
            Priority::High => "high",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "low" => Some(Priority::Low),
            "normal" => Some(Priority::Normal),
            "high" => Some(Priority::High),
            _ => None,
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Priority::Low => "Low",
            Priority::Normal => "Normal",
            Priority::High => "High",
        }
    }
}

/// Why a chat was started from an item.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Purpose {
    Plan,
    Investigate,
    Implement,
    Fix,
}

impl Purpose {
    pub fn as_str(self) -> &'static str {
        match self {
            Purpose::Plan => "plan",
            Purpose::Investigate => "investigate",
            Purpose::Implement => "implement",
            Purpose::Fix => "fix",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "plan" => Some(Purpose::Plan),
            "investigate" => Some(Purpose::Investigate),
            "implement" => Some(Purpose::Implement),
            "fix" => Some(Purpose::Fix),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BacklogImage {
    pub id: String,
    pub name: String,
    pub mime: String,
    pub size: u64,
    pub created_at: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BacklogLink {
    pub conversation_id: String,
    pub purpose: Purpose,
    pub created_at: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BacklogItem {
    pub id: String,
    pub project_id: String,
    /// Per project, shared by both kinds: `FEAT-12`, `BUG-13`.
    pub seq: i64,
    pub kind: Kind,
    pub title: String,
    pub body: String,
    pub status: Status,
    pub priority: Priority,
    pub plan: Option<String>,
    pub related: Vec<String>,
    /// Oldest first.
    pub images: Vec<BacklogImage>,
    /// Oldest first.
    pub links: Vec<BacklogLink>,
    pub created_at: i64,
    pub updated_at: i64,
}

impl BacklogItem {
    pub fn key(&self) -> String {
        format!("{}-{}", self.kind.prefix(), self.seq)
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewItem {
    pub project_id: String,
    pub kind: Kind,
    pub title: String,
    #[serde(default)]
    pub body: String,
    #[serde(default = "normal")]
    pub priority: Priority,
}

fn normal() -> Priority {
    Priority::Normal
}

/// Fields to change; absent ones stay as they are.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemPatch {
    pub title: Option<String>,
    pub body: Option<String>,
    pub priority: Option<Priority>,
    pub related: Option<Vec<String>>,
}

/// An item a chat message is about (`chat_send`).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BacklogRef {
    pub item_id: String,
    pub purpose: Purpose,
}

pub fn clean_title(title: &str) -> AppResult<String> {
    let t: String = title.chars().filter(|c| !c.is_control()).collect();
    let t = t.trim();
    if t.is_empty() {
        return Err(AppError::Invalid("Give the item a title".into()));
    }
    if t.chars().count() > MAX_TITLE_CHARS {
        return Err(AppError::Invalid(format!("Titles can be up to {MAX_TITLE_CHARS} characters")));
    }
    Ok(t.to_string())
}

pub fn clean_text(text: &str, what: &str) -> AppResult<String> {
    if text.chars().count() > MAX_BODY_CHARS {
        return Err(AppError::Invalid(format!("The {what} can be up to {MAX_BODY_CHARS} characters")));
    }
    Ok(text.trim_end().to_string())
}

/// Items plus their screenshot files.
pub struct Backlog {
    db: Arc<Db>,
    images: Images,
}

impl Backlog {
    pub fn new(db: Arc<Db>, images_dir: PathBuf) -> Self {
        Self { db, images: Images::new(images_dir) }
    }

    /// Deletes the item, its links and screenshots. Chats stay.
    pub fn delete(&self, id: &str) -> AppResult<()> {
        repository::delete(&self.db, id)?;
        self.images.remove_conversation(id);
        Ok(())
    }

    /// Screenshot files of a project's items, before the project is forgotten
    /// (its rows go with the project).
    pub fn forget_project(&self, project_id: &str) {
        if let Ok(items) = repository::list(&self.db, project_id) {
            for item in items {
                self.images.remove_conversation(&item.id);
            }
        }
    }

    /// Checks (type from the bytes, size) and stores pasted screenshots.
    pub fn add_images(&self, item_id: &str, new: &[NewImage]) -> AppResult<BacklogItem> {
        let item = repository::get(&self.db, item_id)?;
        if item.images.len() + new.len() > MAX_ITEM_IMAGES {
            return Err(AppError::Invalid(format!("An item keeps up to {MAX_ITEM_IMAGES} screenshots. Remove one first.")));
        }
        let checked = images::check(new)?;
        for img in &checked {
            let id = self.images.store(item_id, img)?;
            let row = BacklogImage { id, name: img.name.clone(), mime: img.mime.to_string(), size: img.bytes.len() as u64, created_at: now_ms() };
            repository::add_image(&self.db, item_id, &row)?;
        }
        repository::get(&self.db, item_id)
    }

    pub fn remove_image(&self, image_id: &str) -> AppResult<BacklogItem> {
        let (item_id, img) = repository::image(&self.db, image_id)?;
        repository::remove_image(&self.db, image_id)?;
        self.images.remove_file(&item_id, &img.id, &img.mime);
        repository::get(&self.db, &item_id)
    }

    /// A screenshot as a `data:` URL, for the item view.
    pub fn image_data_url(&self, image_id: &str) -> AppResult<String> {
        let (item_id, img) = repository::image(&self.db, image_id)?;
        Ok(self.images.input(&item_id, &img.id, &img.mime)?.data_url())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine as _;

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR";

    fn setup() -> (tempfile::TempDir, Arc<Db>, Backlog, String) {
        let dir = tempfile::tempdir().unwrap();
        let db = Arc::new(Db::open_in_memory().unwrap());
        let project = dir.path().join("proj");
        std::fs::create_dir_all(&project).unwrap();
        let p = crate::projects::add(&db, &project.to_string_lossy(), Some("Proj")).unwrap();
        let backlog = Backlog::new(Arc::clone(&db), dir.path().join("backlog-images"));
        (dir, db, backlog, p.id)
    }

    fn png(name: &str) -> NewImage {
        NewImage { name: name.into(), data: base64::engine::general_purpose::STANDARD.encode(PNG) }
    }

    #[test]
    fn screenshots_are_checked_limited_and_removed_with_the_item() {
        let (dir, db, backlog, project) = setup();
        let item = repository::create(
            &db,
            NewItem { project_id: project, kind: Kind::Bug, title: "Crash".into(), body: String::new(), priority: Priority::High },
        )
        .unwrap();
        let fake = NewImage { name: "x.png".into(), data: base64::engine::general_purpose::STANDARD.encode(b"<svg/>") };
        assert!(backlog.add_images(&item.id, &[fake]).is_err(), "type comes from the bytes");
        assert!(repository::get(&db, &item.id).unwrap().images.is_empty());

        for _ in 0..2 {
            backlog.add_images(&item.id, &[png("a"), png("b"), png("c"), png("d")]).unwrap();
        }
        let err = backlog.add_images(&item.id, &[png("e")]).unwrap_err().to_string();
        assert!(err.contains("up to 8"), "{err}");

        let got = repository::get(&db, &item.id).unwrap();
        assert_eq!(got.images.len(), 8);
        assert!(backlog.image_data_url(&got.images[0].id).unwrap().starts_with("data:image/png;base64,"));
        let after = backlog.remove_image(&got.images[0].id).unwrap();
        assert_eq!(after.images.len(), 7);

        let folder = dir.path().join("backlog-images").join(&item.id);
        assert!(folder.is_dir());
        backlog.delete(&item.id).unwrap();
        assert!(!folder.exists(), "deleting the item deletes its screenshots");
        assert!(repository::get(&db, &item.id).is_err());
    }
}
