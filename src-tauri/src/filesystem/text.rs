//! Text decoding and encoding for the editor. UTF-8 is the default; a BOM
//! selects UTF-8/UTF-16 automatically, and the user can reopen a file with any
//! encoding `encoding_rs` knows (e.g. windows-1250 for older Polish files).

use encoding_rs::{Encoding, UTF_16BE, UTF_16LE, UTF_8};

use crate::error::{AppError, AppResult};

pub struct Decoded {
    pub content: String,
    /// Lowercase WHATWG name, e.g. `utf-8`, `utf-16le`, `windows-1252`.
    pub encoding: String,
    pub has_bom: bool,
}

fn name(enc: &'static Encoding) -> String {
    enc.name().to_ascii_lowercase()
}

fn lookup(label: &str) -> AppResult<&'static Encoding> {
    Encoding::for_label(label.trim().as_bytes())
        .ok_or_else(|| AppError::Invalid(format!("Unknown encoding: {label}")))
}

/// Decode file bytes. Without `forced`, a BOM wins, NUL bytes mean binary, and
/// anything else must be valid UTF-8.
pub fn decode(bytes: &[u8], forced: Option<&str>) -> AppResult<Decoded> {
    let bom = Encoding::for_bom(bytes).map(|(enc, _)| enc);
    let enc = match forced {
        Some(label) => lookup(label)?,
        None => match bom {
            Some(enc) => enc,
            None => {
                if bytes[..bytes.len().min(8000)].contains(&0) {
                    return Err(AppError::Binary);
                }
                UTF_8
            }
        },
    };
    let has_bom = bom == Some(enc);
    let (content, had_errors) = enc.decode_with_bom_removal(bytes);
    if had_errors {
        return Err(AppError::Encoding(enc.name().to_string()));
    }
    Ok(Decoded {
        content: content.into_owned(),
        encoding: name(enc),
        has_bom,
    })
}

/// Encode editor text for saving in the file's encoding.
pub fn encode(content: &str, label: &str, has_bom: bool) -> AppResult<Vec<u8>> {
    let enc = lookup(label)?;
    let utf16 = |le: bool| {
        let mut out = Vec::with_capacity(content.len() * 2 + 2);
        if has_bom {
            out.extend_from_slice(if le { &[0xFF, 0xFE] } else { &[0xFE, 0xFF] });
        }
        for unit in content.encode_utf16() {
            out.extend_from_slice(&if le { unit.to_le_bytes() } else { unit.to_be_bytes() });
        }
        out
    };
    if enc == UTF_16LE {
        return Ok(utf16(true));
    }
    if enc == UTF_16BE {
        return Ok(utf16(false));
    }
    if enc == UTF_8 {
        let mut out = Vec::with_capacity(content.len() + 3);
        if has_bom {
            out.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
        }
        out.extend_from_slice(content.as_bytes());
        return Ok(out);
    }
    let (bytes, _, unmappable) = enc.encode(content);
    if unmappable {
        return Err(AppError::Invalid(format!(
            "Some characters can't be saved as {}. Reopen the file as UTF-8 to keep them.",
            enc.name()
        )));
    }
    Ok(bytes.into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf8_with_and_without_bom() {
        let d = decode(b"\xEF\xBB\xBFhi", None).unwrap();
        assert_eq!((d.content.as_str(), d.encoding.as_str(), d.has_bom), ("hi", "utf-8", true));
        let d = decode("zażółć".as_bytes(), None).unwrap();
        assert_eq!((d.content.as_str(), d.has_bom), ("zażółć", false));
        assert_eq!(encode("hi", "utf-8", true).unwrap(), b"\xEF\xBB\xBFhi");
    }

    #[test]
    fn utf16_round_trips_by_bom() {
        let bytes = encode("a€\n", "utf-16le", true).unwrap();
        assert_eq!(&bytes[..2], &[0xFF, 0xFE]);
        let d = decode(&bytes, None).unwrap();
        assert_eq!((d.content.as_str(), d.encoding.as_str(), d.has_bom), ("a€\n", "utf-16le", true));
        let be = encode("a", "utf-16be", true).unwrap();
        assert_eq!(be, [0xFE, 0xFF, 0x00, b'a']);
        assert_eq!(decode(&be, None).unwrap().encoding, "utf-16be");
    }

    #[test]
    fn invalid_utf8_and_binary_are_refused_unless_forced() {
        let cp1250 = [b'z', 0xB9, 0xBF]; // "ząż" in windows-1250
        assert!(matches!(decode(&cp1250, None), Err(AppError::Encoding(_))));
        let d = decode(&cp1250, Some("windows-1250")).unwrap();
        assert_eq!((d.content.as_str(), d.encoding.as_str()), ("ząż", "windows-1250"));
        assert_eq!(encode("ząż", "windows-1250", false).unwrap(), cp1250);
        assert!(matches!(decode(&[b'a', 0, b'b'], None), Err(AppError::Binary)));
        assert_eq!(decode(&[b'a', 0], Some("utf-16le")).unwrap().content, "a");
    }

    #[test]
    fn unmappable_characters_are_reported() {
        assert!(matches!(encode("€ and ✓", "iso-8859-2", false), Err(AppError::Invalid(_))));
        assert!(matches!(decode(b"x", Some("klingon")), Err(AppError::Invalid(_))));
    }
}
