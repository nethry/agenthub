//! Images the user pastes into a project chat. The frontend sends the bytes
//! (base64); AgentHub checks what they are from the bytes themselves, never
//! from a name or a claimed type, and keeps them in the app data folder (never
//! in the project or in SQLite). Each runtime then gets the bytes in its own
//! protocol, so no runtime has to read a file outside the project.

use std::path::PathBuf;

use base64::Engine as _;
use serde::Deserialize;

use super::checkpoints::safe_id;
use crate::error::{AppError, AppResult};

pub const MAX_IMAGES: usize = 4;
pub const MAX_IMAGE_BYTES: usize = 5 * 1024 * 1024;

const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;

/// An image as the frontend sends it.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewImage {
    /// Shown in the transcript ("Pasted image 1"); never used as a path.
    pub name: String,
    /// Base64, without a `data:` prefix.
    pub data: String,
}

/// A checked image, ready to store.
#[derive(Debug, Clone, PartialEq)]
pub struct Checked {
    pub name: String,
    pub mime: &'static str,
    pub bytes: Vec<u8>,
}

/// What a runtime gets for one image.
#[derive(Debug, Clone, PartialEq)]
pub struct ImageInput {
    pub mime: String,
    /// Base64.
    pub data: String,
}

impl ImageInput {
    pub fn data_url(&self) -> String {
        format!("data:{};base64,{}", self.mime, self.data)
    }
}

/// PNG, JPEG, GIF or WebP, from the magic bytes.
pub fn sniff(b: &[u8]) -> Option<&'static str> {
    if b.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if b.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("image/jpeg")
    } else if b.starts_with(b"GIF87a") || b.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if b.len() >= 12 && &b[..4] == b"RIFF" && &b[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

fn ext(mime: &str) -> &'static str {
    match mime {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/gif" => "gif",
        _ => "webp",
    }
}

fn clean_name(name: &str, i: usize) -> String {
    let n: String = name.chars().filter(|c| !c.is_control()).take(80).collect();
    let n = n.trim();
    if n.is_empty() { format!("Image {}", i + 1) } else { n.to_string() }
}

/// Decodes and checks every image before anything is stored.
pub fn check(images: &[NewImage]) -> AppResult<Vec<Checked>> {
    if images.len() > MAX_IMAGES {
        return Err(AppError::Invalid(format!("Attach up to {MAX_IMAGES} images per message.")));
    }
    images
        .iter()
        .enumerate()
        .map(|(i, img)| {
            let name = clean_name(&img.name, i);
            // Base64 is 4/3 of the bytes: refuse an oversized one before decoding it.
            if img.data.len() > MAX_IMAGE_BYTES / 3 * 4 + 4 {
                return Err(too_big(&name));
            }
            let bytes = B64.decode(img.data.trim()).map_err(|_| AppError::Invalid(format!("{name} isn't a readable image.")))?;
            if bytes.len() > MAX_IMAGE_BYTES {
                return Err(too_big(&name));
            }
            let mime = sniff(&bytes).ok_or_else(|| AppError::Invalid(format!("{name} isn't a PNG, JPEG, GIF or WebP image.")))?;
            Ok(Checked { name, mime, bytes })
        })
        .collect()
}

fn too_big(name: &str) -> AppError {
    AppError::Invalid(format!("{name} is larger than {} MB.", MAX_IMAGE_BYTES / (1024 * 1024)))
}

/// Image files, one folder per conversation: `<dir>/<conversation>/<id>.<ext>`.
pub struct Images {
    dir: PathBuf,
}

impl Images {
    pub fn new(dir: PathBuf) -> Self {
        Self { dir }
    }

    fn path(&self, conversation_id: &str, id: &str, mime: &str) -> AppResult<PathBuf> {
        if !safe_id(conversation_id) || !safe_id(id) {
            return Err(AppError::Invalid("Bad image id".into()));
        }
        Ok(self.dir.join(conversation_id).join(format!("{id}.{}", ext(mime))))
    }

    /// Writes the image and returns its id.
    pub fn store(&self, conversation_id: &str, img: &Checked) -> AppResult<String> {
        let id = uuid::Uuid::new_v4().to_string();
        let path = self.path(conversation_id, &id, img.mime)?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&path, &img.bytes)?;
        Ok(id)
    }

    pub fn read(&self, conversation_id: &str, id: &str, mime: &str) -> AppResult<Vec<u8>> {
        let path = self.path(conversation_id, id, mime)?;
        std::fs::read(&path).map_err(|_| AppError::Invalid("This image is no longer stored.".into()))
    }

    /// The image as a runtime gets it (base64), checked again after reading.
    pub fn input(&self, conversation_id: &str, id: &str, mime: &str) -> AppResult<ImageInput> {
        let bytes = self.read(conversation_id, id, mime)?;
        let mime = sniff(&bytes).ok_or_else(|| AppError::Invalid("A stored image is damaged.".into()))?;
        Ok(ImageInput { mime: mime.to_string(), data: B64.encode(bytes) })
    }

    pub fn remove_file(&self, conversation_id: &str, id: &str, mime: &str) {
        if let Ok(path) = self.path(conversation_id, id, mime) {
            let _ = std::fs::remove_file(path);
        }
    }

    /// Removes the folder of `conversation_id` (any folder key, e.g. a backlog item).
    pub fn remove_conversation(&self, conversation_id: &str) {
        if safe_id(conversation_id) {
            let _ = std::fs::remove_dir_all(self.dir.join(conversation_id));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR";

    fn new(name: &str, bytes: &[u8]) -> NewImage {
        NewImage { name: name.into(), data: B64.encode(bytes) }
    }

    #[test]
    fn checks_the_bytes_not_the_name() {
        let ok = check(&[new("shot.txt", PNG)]).unwrap();
        assert_eq!(ok[0].mime, "image/png");
        assert_eq!(ok[0].name, "shot.txt");
        assert_eq!(sniff(b"\xFF\xD8\xFF\xE0"), Some("image/jpeg"));
        assert_eq!(sniff(b"RIFF\0\0\0\0WEBPVP8 "), Some("image/webp"));
        let err = check(&[new("evil.png", b"<svg onload=alert(1)>")]).unwrap_err().to_string();
        assert!(err.contains("isn't a PNG"), "{err}");
        assert!(check(&[NewImage { name: "x".into(), data: "!!!".into() }]).is_err());
        assert_eq!(check(&[new("", PNG)]).unwrap()[0].name, "Image 1");
    }

    #[test]
    fn limits_count_and_size() {
        let five: Vec<_> = (0..5).map(|_| new("a", PNG)).collect();
        assert!(check(&five).unwrap_err().to_string().contains("up to 4"));
        let mut big = PNG.to_vec();
        big.resize(MAX_IMAGE_BYTES + 1, 0);
        assert!(check(&[new("big", &big)]).unwrap_err().to_string().contains("larger than 5 MB"));
    }

    #[test]
    fn stores_per_conversation_and_removes_with_it() {
        let dir = tempfile::tempdir().unwrap();
        let images = Images::new(dir.path().to_path_buf());
        let img = check(&[new("a", PNG)]).unwrap().remove(0);
        let id = images.store("conv-1", &img).unwrap();
        let input = images.input("conv-1", &id, img.mime).unwrap();
        assert_eq!(input.mime, "image/png");
        assert!(input.data_url().starts_with("data:image/png;base64,"));
        assert!(images.read("../x", &id, img.mime).is_err(), "ids can't escape the folder");
        images.remove_conversation("conv-1");
        assert!(images.read("conv-1", &id, img.mime).is_err());
    }
}
