//! Busy/idle detection for a running session. Pure logic: callers pass the
//! time in, so it is fully unit-tested.
//!
//! Two sources, never agent-specific guesses:
//! - **Shell:** OSC 133 prompt markers (injected into plain PowerShell and cmd
//!   sessions). Prompt shown → idle; command started → busy.
//! - **Output:** everything else. Output that isn't keystroke echo or a resize
//!   redraw → busy; [`QUIET`] of silence → idle.

use std::time::{Duration, Instant};

use serde::Serialize;

/// Silence after which an output-tracked session counts as idle.
pub const QUIET: Duration = Duration::from_millis(2000);
/// Output this soon after input is treated as echo.
const ECHO_WINDOW: Duration = Duration::from_millis(300);
/// Output this soon after a resize is treated as a redraw.
const RESIZE_WINDOW: Duration = Duration::from_millis(500);
/// Longest OSC payload worth inspecting; longer ones (titles, hyperlinks) are skipped.
const MAX_OSC: usize = 64;

#[derive(Debug, Serialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Activity {
    Busy,
    Idle,
}

#[derive(Debug, Serialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ActivitySource {
    Shell,
    Output,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mark {
    /// `133;A` / `133;B`: the prompt is shown and waiting for input.
    Prompt,
    /// `133;C`: the entered command started.
    CommandStart,
    /// `133;D[;code]`: the command finished.
    CommandDone,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
enum ScanState {
    #[default]
    Ground,
    Esc,
    Osc,
    OscEsc,
}

/// Finds OSC 133 marks in a stream, including ones split across chunks.
/// The stream itself is not modified (xterm.js ignores unknown OSCs).
#[derive(Debug, Default)]
pub struct Osc133Scanner {
    state: ScanState,
    buf: Vec<u8>,
    overflow: bool,
}

impl Osc133Scanner {
    pub fn scan(&mut self, text: &str) -> Vec<Mark> {
        let mut marks = Vec::new();
        for &b in text.as_bytes() {
            self.state = match (self.state, b) {
                (ScanState::Ground, 0x1b) => ScanState::Esc,
                (ScanState::Ground, _) => ScanState::Ground,
                (ScanState::Esc, b']') => {
                    self.buf.clear();
                    self.overflow = false;
                    ScanState::Osc
                }
                (ScanState::Esc, 0x1b) => ScanState::Esc,
                (ScanState::Esc, _) => ScanState::Ground,
                (ScanState::Osc, 0x07) => {
                    marks.extend(self.finish());
                    ScanState::Ground
                }
                (ScanState::Osc, 0x1b) => ScanState::OscEsc,
                (ScanState::Osc, b) => {
                    if self.buf.len() < MAX_OSC {
                        self.buf.push(b);
                    } else {
                        self.overflow = true;
                    }
                    ScanState::Osc
                }
                (ScanState::OscEsc, b'\\') => {
                    marks.extend(self.finish());
                    ScanState::Ground
                }
                (ScanState::OscEsc, b']') => {
                    // ESC ] again: an unterminated OSC followed by a new one.
                    self.buf.clear();
                    self.overflow = false;
                    ScanState::Osc
                }
                (ScanState::OscEsc, _) => ScanState::Ground,
            };
        }
        marks
    }

    fn finish(&mut self) -> Option<Mark> {
        if self.overflow {
            return None;
        }
        let payload = self.buf.strip_prefix(b"133;")?;
        match payload.first()? {
            b'A' | b'B' => Some(Mark::Prompt),
            b'C' => Some(Mark::CommandStart),
            b'D' => Some(Mark::CommandDone),
            _ => None,
        }
    }
}

#[derive(Debug)]
pub struct ActivityTracker {
    state: Activity,
    source: ActivitySource,
    scanner: Osc133Scanner,
    last_output: Option<Instant>,
    last_input: Option<Instant>,
    last_resize: Option<Instant>,
}

impl Default for ActivityTracker {
    fn default() -> Self {
        Self {
            state: Activity::Idle,
            source: ActivitySource::Output,
            scanner: Osc133Scanner::default(),
            last_output: None,
            last_input: None,
            last_resize: None,
        }
    }
}

impl ActivityTracker {
    pub fn state(&self) -> Activity {
        self.state
    }

    pub fn source(&self) -> ActivitySource {
        self.source
    }

    /// Returns the new state when it changed.
    pub fn on_output(&mut self, now: Instant, text: &str) -> Option<Activity> {
        let before = self.state;
        for mark in self.scanner.scan(text) {
            // Once a shell reports prompts, they're the only signal for this process.
            self.source = ActivitySource::Shell;
            self.state = match mark {
                Mark::Prompt | Mark::CommandDone => Activity::Idle,
                Mark::CommandStart => Activity::Busy,
            };
        }
        if self.source == ActivitySource::Output && !self.is_echo(now) {
            self.last_output = Some(now);
            self.state = Activity::Busy;
        }
        (self.state != before).then_some(self.state)
    }

    pub fn on_input(&mut self, now: Instant, data: &str) -> Option<Activity> {
        self.last_input = Some(now);
        // Shells without a command-start mark (cmd, pwsh without PSReadLine):
        // Enter at the prompt runs the command.
        if self.source == ActivitySource::Shell && self.state == Activity::Idle && data.contains('\r') {
            self.state = Activity::Busy;
            return Some(self.state);
        }
        None
    }

    pub fn on_resize(&mut self, now: Instant) {
        self.last_resize = Some(now);
    }

    /// Output-tracked sessions fall idle after [`QUIET`].
    pub fn tick(&mut self, now: Instant) -> Option<Activity> {
        if self.source != ActivitySource::Output || self.state != Activity::Busy {
            return None;
        }
        let quiet = !matches!(self.last_output, Some(t) if now.duration_since(t) < QUIET);
        if quiet {
            self.state = Activity::Idle;
            return Some(self.state);
        }
        None
    }

    fn is_echo(&self, now: Instant) -> bool {
        let within = |t: Option<Instant>, window: Duration| t.is_some_and(|t| now.duration_since(t) < window);
        within(self.last_input, ECHO_WINDOW) || within(self.last_resize, RESIZE_WINDOW)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const BEL_A: &str = "\x1b]133;A\x07";
    const ST_C: &str = "\x1b]133;C\x1b\\";

    fn ms(base: Instant, n: u64) -> Instant {
        base + Duration::from_millis(n)
    }

    #[test]
    fn scanner_finds_marks_with_either_terminator() {
        let mut s = Osc133Scanner::default();
        let text = format!("PS> {BEL_A}x{ST_C}\x1b]133;D;0\x07\x1b]133;B\x07");
        assert_eq!(
            s.scan(&text),
            vec![Mark::Prompt, Mark::CommandStart, Mark::CommandDone, Mark::Prompt]
        );
    }

    #[test]
    fn scanner_handles_marks_split_across_chunks() {
        let mut s = Osc133Scanner::default();
        assert!(s.scan("out\x1b]13").is_empty());
        assert!(s.scan("3;C\x1b").is_empty());
        assert_eq!(s.scan("\\rest"), vec![Mark::CommandStart]);
    }

    #[test]
    fn scanner_ignores_other_sequences() {
        let mut s = Osc133Scanner::default();
        let long_title = format!("\x1b]0;{}\x07", "t".repeat(200));
        let text = format!("\x1b[31mred\x1b[0m\x1b]0;133;A\x07{long_title}\x1b]8;;https://x\x1b\\\x1b]1337;A\x07");
        assert!(s.scan(&text).is_empty());
    }

    #[test]
    fn output_is_busy_until_quiet() {
        let t0 = Instant::now();
        let mut a = ActivityTracker::default();
        assert_eq!(a.on_output(t0, "working"), Some(Activity::Busy));
        assert_eq!(a.on_output(ms(t0, 900), "still"), None, "no flip-flop while streaming");
        assert_eq!(a.tick(ms(t0, 2000)), None);
        assert_eq!(a.tick(ms(t0, 2900)), Some(Activity::Idle));
        assert_eq!(a.source(), ActivitySource::Output);
    }

    #[test]
    fn echo_and_resize_redraws_do_not_count() {
        let t0 = Instant::now();
        let mut a = ActivityTracker::default();
        assert_eq!(a.on_input(t0, "l"), None);
        assert_eq!(a.on_output(ms(t0, 20), "l"), None);
        a.on_resize(ms(t0, 1000));
        assert_eq!(a.on_output(ms(t0, 1100), "redraw"), None);
        assert_eq!(a.state(), Activity::Idle);
        assert_eq!(a.on_output(ms(t0, 1700), "real output"), Some(Activity::Busy));
    }

    #[test]
    fn shell_marks_win_over_output() {
        let t0 = Instant::now();
        let mut a = ActivityTracker::default();
        assert_eq!(a.on_output(t0, &format!("PS C:\\> {BEL_A}")), None);
        assert_eq!(a.source(), ActivitySource::Shell);
        assert_eq!(a.on_output(ms(t0, 1000), ST_C), Some(Activity::Busy));
        // A silent command stays busy: no quiet timeout for shells.
        assert_eq!(a.tick(ms(t0, 60_000)), None);
        assert_eq!(a.on_output(ms(t0, 61_000), "done\r\n\x1b]133;D;0\x07"), Some(Activity::Idle));
        assert_eq!(a.on_output(ms(t0, 61_010), "PS C:\\> "), None);
    }

    #[test]
    fn enter_at_a_shell_prompt_is_busy_without_a_c_mark() {
        let t0 = Instant::now();
        let mut a = ActivityTracker::default();
        a.on_output(t0, BEL_A);
        assert_eq!(a.on_input(ms(t0, 10), "dir"), None);
        assert_eq!(a.on_input(ms(t0, 20), "\r"), Some(Activity::Busy));
        assert_eq!(a.on_output(ms(t0, 500), BEL_A), Some(Activity::Idle));
    }
}
