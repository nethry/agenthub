//! Incremental Server-Sent Events parser. Bytes arrive in arbitrary chunks;
//! lines are split on raw bytes (UTF-8 never puts `\n` inside a character),
//! so a character cut across chunks is decoded only once its line is whole.

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SseEvent {
    /// `event:` field; empty when the stream didn't name one.
    pub event: String,
    pub data: String,
}

#[derive(Default)]
pub struct SseParser {
    buf: Vec<u8>,
    event: String,
    data: Vec<String>,
}

/// One unterminated line may not grow past this (a broken or hostile stream).
const MAX_LINE: usize = 8 * 1024 * 1024;

impl SseParser {
    pub fn new() -> Self {
        Self::default()
    }

    /// Feeds a chunk and returns the events it completed.
    pub fn feed(&mut self, chunk: &[u8]) -> Result<Vec<SseEvent>, String> {
        self.buf.extend_from_slice(chunk);
        let mut events = Vec::new();
        let mut start = 0;
        while let Some(pos) = self.buf[start..].iter().position(|&b| b == b'\n') {
            let end = start + pos;
            let mut line = &self.buf[start..end];
            if line.last() == Some(&b'\r') {
                line = &line[..line.len() - 1];
            }
            let line = String::from_utf8_lossy(line).into_owned();
            start = end + 1;
            if let Some(ev) = self.line(&line) {
                events.push(ev);
            }
        }
        self.buf.drain(..start);
        if self.buf.len() > MAX_LINE {
            return Err("The response stream sent a line that is too long".into());
        }
        Ok(events)
    }

    /// Dispatches what's buffered when the stream ends without a blank line.
    pub fn finish(&mut self) -> Option<SseEvent> {
        if !self.buf.is_empty() {
            let rest = String::from_utf8_lossy(&std::mem::take(&mut self.buf)).into_owned();
            let rest = rest.trim_end_matches('\r').to_string();
            if let Some(ev) = self.line(&rest) {
                return Some(ev);
            }
        }
        self.dispatch()
    }

    fn line(&mut self, line: &str) -> Option<SseEvent> {
        if line.is_empty() {
            return self.dispatch();
        }
        if line.starts_with(':') {
            return None; // comment / keep-alive
        }
        let (field, value) = match line.split_once(':') {
            Some((f, v)) => (f, v.strip_prefix(' ').unwrap_or(v)),
            None => (line, ""),
        };
        match field {
            "event" => self.event = value.to_string(),
            "data" => self.data.push(value.to_string()),
            _ => {} // id, retry: unused
        }
        None
    }

    fn dispatch(&mut self) -> Option<SseEvent> {
        if self.data.is_empty() {
            self.event.clear();
            return None;
        }
        Some(SseEvent {
            event: std::mem::take(&mut self.event),
            data: std::mem::take(&mut self.data).join("\n"),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const STREAM: &str = "event: message_start\ndata: {\"a\":1}\n\n: ping\n\nevent: delta\r\ndata: {\"text\":\"héllo ✓\"}\r\n\r\ndata: line1\ndata: line2\n\n";

    fn expected() -> Vec<SseEvent> {
        vec![
            SseEvent { event: "message_start".into(), data: "{\"a\":1}".into() },
            SseEvent { event: "delta".into(), data: "{\"text\":\"héllo ✓\"}".into() },
            SseEvent { event: "".into(), data: "line1\nline2".into() },
        ]
    }

    #[test]
    fn parses_a_whole_stream() {
        let mut p = SseParser::new();
        assert_eq!(p.feed(STREAM.as_bytes()).unwrap(), expected());
        assert_eq!(p.finish(), None);
    }

    #[test]
    fn handles_every_chunk_boundary() {
        let bytes = STREAM.as_bytes();
        for split in 1..bytes.len() {
            let mut p = SseParser::new();
            let mut got = p.feed(&bytes[..split]).unwrap();
            got.extend(p.feed(&bytes[split..]).unwrap());
            assert_eq!(got, expected(), "split at {split}");
        }
        // One byte at a time, including inside multi-byte characters.
        let mut p = SseParser::new();
        let mut got = Vec::new();
        for b in bytes {
            got.extend(p.feed(std::slice::from_ref(b)).unwrap());
        }
        assert_eq!(got, expected());
    }

    #[test]
    fn finish_flushes_an_unterminated_event() {
        let mut p = SseParser::new();
        assert!(p.feed(b"data: tail").unwrap().is_empty());
        assert_eq!(p.finish(), Some(SseEvent { event: "".into(), data: "tail".into() }));
    }
}
