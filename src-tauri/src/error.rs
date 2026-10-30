use serde::ser::SerializeStruct;
use serde::{Serialize, Serializer};

/// Errors returned to the frontend as `{ kind, message }`.
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("{0}")]
    NotFound(String),
    #[error("{0}")]
    Invalid(String),
    #[error("Path is outside the project folder")]
    OutsideRoot,
    #[error("This file looks binary and can't be opened in the editor")]
    Binary,
    #[error("File is too large to open (limit {0} MB)")]
    TooLarge(u64),
    #[error("File is not valid {0} text")]
    Encoding(String),
    #[error("The file changed on disk since it was opened")]
    Conflict,
    #[error("{0}")]
    Io(#[from] std::io::Error),
    #[error("Database error: {0}")]
    Db(#[from] rusqlite::Error),
    #[error("{0}")]
    Pty(String),
    /// AI Chat provider error; `kind` is the normalized chat error kind.
    #[error("{0}")]
    Provider(crate::chat::ChatError),
    /// A Git command failed or a Git guard refused; `detail` is git's (redacted) output.
    #[error("{message}")]
    Git { kind: crate::git::GitErrorKind, message: String, detail: Option<String> },
}

impl AppError {
    pub fn kind(&self) -> &'static str {
        match self {
            AppError::NotFound(_) => "not_found",
            AppError::Invalid(_) => "invalid",
            AppError::OutsideRoot => "outside_root",
            AppError::Binary => "binary",
            AppError::TooLarge(_) => "too_large",
            AppError::Encoding(_) => "encoding",
            AppError::Conflict => "conflict",
            AppError::Io(_) => "io",
            AppError::Db(_) => "db",
            AppError::Pty(_) => "pty",
            AppError::Provider(e) => e.kind.as_str(),
            AppError::Git { kind, .. } => kind.as_str(),
        }
    }
}

impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let detail = match self {
            AppError::Git { detail, .. } => detail.as_deref(),
            _ => None,
        };
        let mut s = serializer.serialize_struct("AppError", 3)?;
        s.serialize_field("kind", self.kind())?;
        s.serialize_field("message", &self.to_string())?;
        if let Some(d) = detail {
            s.serialize_field("detail", d)?;
        }
        s.end()
    }
}

pub type AppResult<T> = Result<T, AppError>;

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
