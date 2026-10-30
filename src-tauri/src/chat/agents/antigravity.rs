//! Google Antigravity over its official Agent Client Protocol server
//! (`agy_acp_server`, from the ACP registry as `antigravity-acp`); the
//! protocol itself is `acp`. This is the profile:
//!
//! - Signs in with the user's Google account (`oauth-personal`), but only when
//!   the user asks for it in Settings: probes and turns never start a sign-in.
//!   Antigravity keeps its own credentials; AgentHub never reads them.
//! - The server is slow to start (about 15 s on Windows), so one process per
//!   conversation stays up, and model and mode changes are applied to the live
//!   session. `session/load` doesn't replay history, so a restarted
//!   conversation gets AgentHub's recap in a fresh session.
//! - Modes come from the session: never one whose name says it approves on its
//!   own. Antigravity's own permission settings also apply, so every finished
//!   tool call is checked (`verify_routing`) and the turn ends if one edited,
//!   ran or (in Ask) read something without going through AgentHub.
//!
//! Started directly (an executable, no shell, no arguments on Windows).

use std::path::{Path, PathBuf};
use std::sync::Arc;

use super::acp::{self, ModeChoice, ModeInfo, Profile, SpawnSpec};
use super::jsonrpc::{Handler, Peer};
use crate::chat::{ChatError, Engine, ErrorKind, Mode};

const PROGRAM: &str = "agy_acp_server";
const INSTALL_HINT: &str = "Download the Antigravity ACP server for your system from the Agent Client Protocol registry (antigravity-acp), unzip it with the files next to it, then add its folder to PATH or choose the program here.";
pub(super) const NOT_SIGNED_IN: &str = "Antigravity isn't signed in. Use Sign in with Google under Antigravity in Settings › AI integrations.";
const SIGN_IN_METHOD: &str = "oauth-personal";

/// Words in a mode's id or name that mean it approves edits or commands on its own.
const AUTO_APPROVE: [&str; 12] =
    ["yolo", "auto", "turbo", "bypass", "accept", "always", "full", "unrestricted", "trust", "skip", "dangerous", "no approval"];

/// The Antigravity adapter.
pub fn adapter() -> acp::Adapter {
    acp::Adapter::new(Arc::new(Antigravity))
}

pub(super) struct Antigravity;

impl Profile for Antigravity {
    fn engine(&self) -> Engine {
        Engine::Antigravity
    }

    fn locate(&self, executable: Option<&Path>) -> Result<PathBuf, ChatError> {
        let found = super::locate(PROGRAM, executable)
            .ok_or_else(|| ChatError::new(ErrorKind::EngineNotFound, format!("The Antigravity ACP server isn't installed (no `{PROGRAM}` on PATH). {INSTALL_HINT}")))?;
        if super::is_shell_shim(&found) {
            return Err(ChatError::new(
                ErrorKind::EngineNotFound,
                format!("{} is a launcher script, which AgentHub doesn't run through a shell. Choose agy_acp_server itself.", found.display()),
            ));
        }
        Ok(found)
    }

    /// Asking the server for `--version` would start it (slowly); the probe
    /// reads the version from `initialize` instead.
    fn version(&self, _found: &Path) -> Option<String> {
        None
    }

    fn spawn(&self, spec: &SpawnSpec, handler: Handler) -> Result<Arc<Peer>, ChatError> {
        let found = self.locate(spec.executable)?;
        let mut cmd = super::command(&found);
        // The registry starts the Linux build with an empty `--uid=`.
        if cfg!(target_os = "linux") {
            cmd.arg("--uid=");
        }
        cmd.current_dir(spec.cwd);
        Peer::spawn(cmd, true, handler).map_err(|e| ChatError::new(ErrorKind::EngineNotFound, format!("Couldn't start Antigravity: {e}")))
    }

    fn not_signed_in(&self, _remote: &str) -> String {
        NOT_SIGNED_IN.into()
    }

    fn sign_in_method(&self) -> Option<&'static str> {
        Some(SIGN_IN_METHOD)
    }

    fn pick_mode(&self, mode: Mode, modes: &[ModeInfo], current: Option<&str>) -> Result<Option<ModeChoice>, String> {
        if modes.is_empty() {
            return Ok(None);
        }
        let safe: Vec<&ModeInfo> = modes.iter().filter(|m| !auto_approves(m)).collect();
        let base = safe
            .iter()
            .filter(|m| !is_plan(m))
            .find(|m| Some(m.id.as_str()) == current)
            .or_else(|| safe.iter().find(|m| m.id == "default" && !is_plan(m)))
            .or_else(|| safe.iter().find(|m| !is_plan(m)))
            .map(|m| m.id.clone());
        let plan = (mode == Mode::Plan).then(|| safe.iter().find(|m| is_plan(m)).map(|m| m.id.clone())).flatten();
        match (plan, base) {
            (Some(plan), base) => Ok(Some(ModeChoice { desired: plan, fallback: base })),
            (None, Some(base)) => Ok(Some(ModeChoice { desired: base, fallback: None })),
            (None, None) => {
                let names: Vec<String> = modes.iter().map(|m| if m.name.is_empty() { m.id.clone() } else { m.name.clone() }).collect();
                Err(format!(
                    "Antigravity offers only modes that approve on their own here ({}), so AgentHub can't keep your approvals in this chat.",
                    names.join(", ")
                ))
            }
        }
    }

    fn trust_session_load(&self) -> bool {
        false
    }

    fn no_load_reason(&self) -> String {
        "Antigravity doesn't reload earlier sessions, so AgentHub sent it a recap of this chat.".into()
    }

    fn reconfigure_in_place(&self) -> bool {
        true
    }

    fn verify_routing(&self) -> bool {
        true
    }
}

fn auto_approves(m: &ModeInfo) -> bool {
    let text = format!("{} {}", m.id, m.name).to_ascii_lowercase();
    AUTO_APPROVE.iter().any(|w| text.contains(w))
}

fn is_plan(m: &ModeInfo) -> bool {
    format!("{} {}", m.id, m.name).to_ascii_lowercase().contains("plan")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat::agents::EngineAdapter;
    use crate::chat::engines::ProbeState;

    fn mode(id: &str, name: &str) -> ModeInfo {
        ModeInfo { id: id.into(), name: name.into() }
    }

    #[test]
    fn modes_never_approve_on_their_own() {
        let a = Antigravity;
        let modes = [mode("turbo", "Turbo"), mode("review", "Request review"), mode("planning", "Planning"), mode("auto-edit", "Auto edit")];
        assert_eq!(a.pick_mode(Mode::Agent, &modes, Some("turbo")).unwrap(), Some(ModeChoice { desired: "review".into(), fallback: None }));
        assert_eq!(
            a.pick_mode(Mode::Plan, &modes, Some("turbo")).unwrap(),
            Some(ModeChoice { desired: "planning".into(), fallback: Some("review".into()) })
        );
        // The current mode is kept when it's safe; `default` is preferred otherwise.
        let two = [mode("a", "Ask first"), mode("default", "Default")];
        assert_eq!(a.pick_mode(Mode::Ask, &two, Some("a")).unwrap().unwrap().desired, "a");
        assert_eq!(a.pick_mode(Mode::Ask, &two, None).unwrap().unwrap().desired, "default");
        // Only auto-approving modes: refuse rather than run one.
        let err = a.pick_mode(Mode::Agent, &[mode("yolo", "YOLO"), mode("fast", "Always allow")], None).unwrap_err();
        assert!(err.contains("YOLO, Always allow"), "{err}");
        assert_eq!(a.pick_mode(Mode::Agent, &[], Some("x")).unwrap(), None, "no modes offered: nothing to switch");
    }

    #[test]
    fn locate_reports_how_to_install() {
        let e = Antigravity.locate(Some(Path::new("C:/definitely/missing/agy_acp_server.exe")));
        // Falls back to PATH, which (on CI) has no Antigravity.
        if let Err(e) = e {
            assert_eq!(e.kind, ErrorKind::EngineNotFound);
            assert!(e.message.contains("registry"), "{}", e.message);
        }
        let dir = tempfile::tempdir().unwrap();
        let shim = dir.path().join("agy_acp_server.cmd");
        std::fs::write(&shim, "@echo off").unwrap();
        assert!(Antigravity.locate(Some(&shim)).unwrap_err().message.contains("launcher script"));
    }

    /// Needs the Antigravity ACP server, signed in:
    /// `AGENTHUB_ANTIGRAVITY=C:\…\agy_acp_server.exe cargo test antigravity::tests::live_probe -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn live_probe() {
        let exe = std::env::var("AGENTHUB_ANTIGRAVITY").ok().map(PathBuf::from);
        let probe = adapter().probe(exe.as_deref(), None);
        println!("{probe:#?}");
        assert_ne!(probe.state, ProbeState::NotFound, "{:?}", probe.message);
    }
}
