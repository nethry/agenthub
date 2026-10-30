//! Gemini CLI over the Agent Client Protocol (`gemini --acp`); the protocol
//! itself is `acp`. This is the profile:
//!
//! - Signs in with the user's Gemini API key only (`GEMINI_API_KEY` in the
//!   child's environment, then `authenticate` with `gemini-api-key`). Gemini
//!   CLI no longer serves personal Google accounts; those use Antigravity.
//! - The model is fixed per process (`-m`), so a model or mode change restarts
//!   it and `session/load`s the same session.
//! - Modes: Gemini's `default` approval mode (asks before edits and
//!   commands), or `plan` for Plan mode when the session offers it;
//!   `autoEdit`/`yolo` are never used. Ask and Plan also get, when this Gemini
//!   version supports `--admin-policy`, a policy file that denies tools (Ask:
//!   every tool; Plan: edits, shell, web, memory, delegation and MCP).
//!
//! Spawned with argument arrays only. An npm `.cmd`/`.ps1` shim is never run:
//! `node <package>/bundle/gemini.js` is started instead.

use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde_json::Value;

use super::acp::{self, model_arg, ModeChoice, ModeInfo, Profile, SpawnSpec};
use super::jsonrpc::{Handler, Peer};
use crate::chat::engines::ProbeState;
use crate::chat::{ChatError, Engine, ErrorKind, Mode};

const INSTALL_HINT: &str = "Install it with `npm install -g @google/gemini-cli`, then recheck.";
pub(super) const NEEDS_KEY: &str =
    "Gemini CLI needs a Gemini API key: add one under Gemini API in Settings › AI integrations. For a personal Google account, use Antigravity.";
const KEY_REJECTED: &str = "Gemini CLI couldn't sign in with your Gemini API key. Check the key under Gemini API in Settings › AI integrations.";
const LEGACY_SIGN_IN: &str =
    "Gemini CLI no longer accepts personal Google sign-in. Add a Gemini API key under Gemini API in Settings › AI integrations, or use Antigravity.";
const API_KEY_METHOD: &str = "gemini-api-key";
const HELP_TIMEOUT: Duration = Duration::from_secs(20);

const ASK_POLICY: &str = r#"# Written by AgentHub for Gemini CLI in Ask mode: no tools or file access.
[[rule]]
toolName = "*"
decision = "deny"
priority = 999
denyMessage = "AgentHub Ask mode: answer without tools or file access."
"#;

const PLAN_POLICY: &str = r#"# Written by AgentHub for Gemini CLI in Plan mode: read-only inside the project.
[[rule]]
toolName = ["write_file", "replace", "run_shell_command", "web_fetch", "google_web_search", "save_memory", "activate_skill", "invoke_agent"]
decision = "deny"
priority = 999
denyMessage = "AgentHub Plan mode is read-only: no edits, commands, web access or delegation."

[[rule]]
toolName = "*"
mcpName = "*"
decision = "deny"
priority = 999
denyMessage = "AgentHub Plan mode doesn't allow MCP tools."
"#;

/// The Gemini CLI adapter.
pub fn adapter() -> acp::Adapter {
    acp::Adapter::new(Arc::new(Gemini::default()))
}

#[derive(Default)]
pub(super) struct Gemini {
    /// Whether each launch knows `--admin-policy`.
    help: Mutex<HashMap<String, bool>>,
}

impl Profile for Gemini {
    fn engine(&self) -> Engine {
        Engine::GeminiCli
    }

    fn locate(&self, executable: Option<&Path>) -> Result<PathBuf, ChatError> {
        locate_launch(executable).map(|(found, _)| found)
    }

    fn version(&self, found: &Path) -> Option<String> {
        launch_for(found, || super::locate("node", None)).ok().and_then(|l| launch_version(&l))
    }

    fn spawn(&self, spec: &SpawnSpec, handler: Handler) -> Result<Arc<Peer>, ChatError> {
        let (_, launch) = locate_launch(spec.executable)?;
        let policy = spec.mode != Mode::Agent && admin_policy_supported(&self.help, &launch);
        spawn(&launch, spec, policy, handler)
    }

    fn not_signed_in(&self, remote: &str) -> String {
        if is_legacy_sign_in(remote) {
            LEGACY_SIGN_IN.into()
        } else {
            KEY_REJECTED.into()
        }
    }

    fn precheck(&self, api_key: Option<&str>) -> Option<(ProbeState, String)> {
        api_key.is_none().then(|| (ProbeState::KeyMissing, NEEDS_KEY.to_string()))
    }

    fn auth_method(&self, init: &Value, api_key: Option<&str>) -> Option<String> {
        api_key?;
        let offered = init["authMethods"].as_array().into_iter().flatten().any(|m| m["id"].as_str() == Some(API_KEY_METHOD));
        offered.then(|| API_KEY_METHOD.to_string())
    }

    fn pick_mode(&self, mode: Mode, modes: &[ModeInfo], _current: Option<&str>) -> Result<Option<ModeChoice>, String> {
        Ok(Some(if mode == Mode::Plan && modes.iter().any(|m| m.id == "plan") {
            ModeChoice { desired: "plan".into(), fallback: Some("default".into()) }
        } else {
            ModeChoice { desired: "default".into(), fallback: None }
        }))
    }
}

/// Gemini CLI's answer to a personal Google account since mid-2026.
fn is_legacy_sign_in(message: &str) -> bool {
    let m = message.to_ascii_lowercase();
    m.contains("no longer supported") || m.contains("code assist for individuals") || m.contains("antigravity")
}

// ---------------------------------------------------------------------------
// Locating and launching
// ---------------------------------------------------------------------------

/// How to start Gemini CLI without a shell.
#[derive(Debug, Clone, PartialEq)]
enum Launch {
    /// A real executable.
    Direct(PathBuf),
    /// `node <script>` (npm installs a `.cmd`/`.ps1` shim around this).
    Node { node: PathBuf, script: PathBuf },
}

impl Launch {
    fn command(&self) -> std::process::Command {
        match self {
            Launch::Direct(p) => super::command(p),
            Launch::Node { node, script } => {
                let mut c = super::command(node);
                c.arg(script);
                c
            }
        }
    }

    fn cache_key(&self) -> String {
        match self {
            Launch::Direct(p) => p.to_string_lossy().to_string(),
            Launch::Node { node, script } => format!("{}|{}", node.display(), script.display()),
        }
    }
}

/// Turns what `locate` found into a shell-free launch. `node` finds Node.js
/// on PATH (only asked when needed).
fn launch_for(found: &Path, node: impl FnOnce() -> Option<PathBuf>) -> Result<Launch, String> {
    let ext = found.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    let script_like = matches!(ext.as_str(), "js" | "mjs" | "cjs");
    // On Windows anything that isn't a binary (e.g. npm's extensionless sh launcher) is a shim too.
    let shim = super::is_shell_shim(found) || (cfg!(windows) && !script_like && ext != "exe" && ext != "com");
    if !script_like && !shim {
        return Ok(Launch::Direct(found.to_path_buf()));
    }
    let dir = found.parent().unwrap_or(Path::new("."));
    let script = if script_like {
        Some(found.to_path_buf())
    } else {
        let standard = dir.join("node_modules").join("@google").join("gemini-cli").join("bundle").join("gemini.js");
        if standard.is_file() {
            Some(standard)
        } else {
            read_small(found).and_then(|text| shim_script(&text)).map(|rel| dir.join(rel)).filter(|p| p.is_file())
        }
    };
    let Some(script) = script else {
        return Err(format!(
            "Found {}, an npm launcher script that AgentHub doesn't run through a shell, but not Gemini CLI's package script next to it.",
            found.display()
        ));
    };
    let local_node = dir.join("node.exe");
    let node = if !script_like && local_node.is_file() { Some(local_node) } else { node() };
    let node = node.ok_or_else(|| "Gemini CLI needs Node.js, which isn't on PATH.".to_string())?;
    Ok(Launch::Node { node, script })
}

fn read_small(path: &Path) -> Option<String> {
    let meta = std::fs::metadata(path).ok()?;
    if meta.len() > 64 * 1024 {
        return None;
    }
    std::fs::read(path).ok().map(|b| String::from_utf8_lossy(&b).into_owned())
}

/// The package script an npm/pnpm shim starts, relative to the shim's folder:
/// `"%dp0%\node_modules\...\gemini.js"` (cmd) or `"$basedir/node_modules/...js"` (ps1, sh).
fn shim_script(text: &str) -> Option<PathBuf> {
    for marker in ["%dp0%\\", "%~dp0\\", "$basedir/", "$basedir\\"] {
        let mut rest = text;
        while let Some(i) = rest.find(marker) {
            let after = &rest[i + marker.len()..];
            let end = after.find(['"', '\'', '\r', '\n']).unwrap_or(after.len());
            let candidate = after[..end].trim();
            let lower = candidate.to_ascii_lowercase();
            if [".js", ".mjs", ".cjs"].iter().any(|e| lower.ends_with(e)) {
                return Some(candidate.split(['\\', '/']).filter(|s| !s.is_empty()).collect());
            }
            rest = &after[end..];
        }
    }
    None
}

fn locate_launch(executable: Option<&Path>) -> Result<(PathBuf, Launch), ChatError> {
    let found = super::locate("gemini", executable)
        .ok_or_else(|| ChatError::new(ErrorKind::EngineNotFound, format!("Gemini CLI isn't installed (no `gemini` on PATH). {INSTALL_HINT}")))?;
    let launch =
        launch_for(&found, || super::locate("node", None)).map_err(|m| ChatError::new(ErrorKind::EngineNotFound, format!("{m} {INSTALL_HINT}")))?;
    Ok((found, launch))
}

/// Runs a short command and returns its stdout, killing it after `timeout`.
fn capture(mut cmd: std::process::Command, timeout: Duration) -> Option<String> {
    let mut child = cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().ok()?;
    let mut out = child.stdout.take()?;
    let reader = thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = out.by_ref().take(1024 * 1024).read_to_end(&mut buf);
        buf
    });
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if start.elapsed() < timeout => thread::sleep(Duration::from_millis(50)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break;
            }
        }
    }
    reader.join().ok().map(|b| String::from_utf8_lossy(&b).into_owned())
}

fn launch_version(launch: &Launch) -> Option<String> {
    match launch {
        Launch::Direct(p) => super::version_of(p, &["--version"]),
        Launch::Node { node, script } => super::version_of(node, &[&script.to_string_lossy(), "--version"]),
    }
}

/// Whether this Gemini version knows `--admin-policy` (an unknown flag makes it exit).
fn admin_policy_supported(cache: &Mutex<HashMap<String, bool>>, launch: &Launch) -> bool {
    let key = launch.cache_key();
    if let Some(v) = cache.lock().get(&key) {
        return *v;
    }
    let mut cmd = launch.command();
    cmd.arg("--help").env("GEMINI_CLI_NO_RELAUNCH", "true");
    let supported = capture(cmd, HELP_TIMEOUT).is_some_and(|out| out.contains("--admin-policy"));
    cache.lock().insert(key, supported);
    supported
}

/// The policy file for Ask/Plan, written fresh to a temp folder.
fn write_policy(mode: Mode) -> Option<PathBuf> {
    let (name, text) = match mode {
        Mode::Ask => ("agenthub-ask.toml", ASK_POLICY),
        Mode::Plan => ("agenthub-plan.toml", PLAN_POLICY),
        Mode::Agent => return None,
    };
    let dir = std::env::temp_dir().join("agenthub-gemini");
    std::fs::create_dir_all(&dir).ok()?;
    let path = dir.join(name);
    std::fs::write(&path, text).ok()?;
    Some(path)
}

fn spawn(launch: &Launch, spec: &SpawnSpec, admin_policy: bool, handler: Handler) -> Result<Arc<Peer>, ChatError> {
    let mut cmd = launch.command();
    cmd.arg("--acp");
    if let Some(m) = model_arg(spec.model) {
        cmd.arg("-m").arg(m);
    }
    if admin_policy {
        if let Some(p) = write_policy(spec.mode) {
            cmd.arg("--admin-policy").arg(p);
        }
    }
    if let Some(key) = spec.api_key {
        // Only in Gemini's environment: never an argument, never logged.
        cmd.env("GEMINI_API_KEY", key).env("GEMINI_DEFAULT_AUTH_TYPE", API_KEY_METHOD);
    }
    // No supervisor/child relaunch: killing the process must end Gemini.
    cmd.current_dir(spec.cwd).env("GEMINI_CLI_NO_RELAUNCH", "true");
    Peer::spawn(cmd, true, handler).map_err(|e| ChatError::new(ErrorKind::EngineNotFound, format!("Couldn't start Gemini CLI: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat::agents::EngineAdapter;
    use serde_json::json;

    #[test]
    fn npm_shims_resolve_to_node_and_the_package_script() {
        let dir = tempfile::tempdir().unwrap();
        let npm = dir.path().join("npm");
        let pkg = npm.join("node_modules").join("@google").join("gemini-cli").join("bundle");
        std::fs::create_dir_all(&pkg).unwrap();
        let script = pkg.join("gemini.js");
        std::fs::write(&script, "// bundle").unwrap();
        let shim = npm.join("gemini.cmd");
        std::fs::write(&shim, "@ECHO off\r\n").unwrap();
        let node = PathBuf::from("C:/node/node.exe");
        assert_eq!(launch_for(&shim, || Some(node.clone())), Ok(Launch::Node { node: node.clone(), script: script.clone() }));
        let ps1 = npm.join("gemini.ps1");
        std::fs::write(&ps1, "").unwrap();
        assert_eq!(launch_for(&ps1, || Some(node.clone())), Ok(Launch::Node { node: node.clone(), script: script.clone() }));
        // A node.exe next to the shim wins (npm's own rule).
        let local = npm.join("node.exe");
        std::fs::write(&local, "").unwrap();
        assert_eq!(launch_for(&shim, || None), Ok(Launch::Node { node: local, script: script.clone() }));

        // pnpm-style shim pointing elsewhere: read the script path from the shim.
        let pnpm = dir.path().join("pnpm");
        let target = pnpm.join("global").join("5").join("node_modules").join("@google").join("gemini-cli").join("bundle");
        std::fs::create_dir_all(&target).unwrap();
        std::fs::write(target.join("gemini.js"), "").unwrap();
        let pshim = pnpm.join("gemini.cmd");
        std::fs::write(
            &pshim,
            "@IF EXIST \"%~dp0\\node.exe\" (\r\n  \"%~dp0\\node.exe\"  \"%~dp0\\global\\5\\node_modules\\@google\\gemini-cli\\bundle\\gemini.js\" %*\r\n)",
        )
        .unwrap();
        assert_eq!(launch_for(&pshim, || Some(node.clone())), Ok(Launch::Node { node: node.clone(), script: target.join("gemini.js") }));

        // A shim without its package, or without Node.js, can't run.
        let lonely = dir.path().join("lonely");
        std::fs::create_dir_all(&lonely).unwrap();
        std::fs::write(lonely.join("gemini.cmd"), "@ECHO off").unwrap();
        assert!(launch_for(&lonely.join("gemini.cmd"), || Some(node.clone())).unwrap_err().contains("npm launcher"));
        let bare = dir.path().join("bare");
        let bare_pkg = bare.join("node_modules").join("@google").join("gemini-cli").join("bundle");
        std::fs::create_dir_all(&bare_pkg).unwrap();
        std::fs::write(bare_pkg.join("gemini.js"), "").unwrap();
        std::fs::write(bare.join("gemini.cmd"), "").unwrap();
        assert!(launch_for(&bare.join("gemini.cmd"), || None).unwrap_err().contains("Node.js"));

        // A real binary runs directly.
        let exe = dir.path().join("gemini.exe");
        assert_eq!(launch_for(&exe, || None), Ok(Launch::Direct(exe.clone())));
    }

    #[test]
    fn shim_scripts_are_read_from_cmd_and_ps1_launchers() {
        let cmd = "endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & \"%_prog%\"  \"%dp0%\\node_modules\\@google\\gemini-cli\\bundle\\gemini.js\" %*";
        let expected: PathBuf = ["node_modules", "@google", "gemini-cli", "bundle", "gemini.js"].iter().collect();
        assert_eq!(shim_script(cmd), Some(expected.clone()));
        let ps1 = "  & \"$basedir/node$exe\"  \"$basedir/node_modules/@google/gemini-cli/bundle/gemini.js\" $args";
        assert_eq!(shim_script(ps1), Some(expected));
        assert_eq!(shim_script("@ECHO off"), None);
    }

    #[test]
    fn signs_in_with_the_api_key_only() {
        let g = Gemini::default();
        let init = json!({ "authMethods": [{ "id": "oauth-personal" }, { "id": "gemini-api-key" }, { "id": "vertex-ai" }] });
        assert_eq!(g.auth_method(&init, Some("AIzaTestKey123456")).as_deref(), Some("gemini-api-key"));
        assert_eq!(g.auth_method(&init, None), None, "no key: nothing to authenticate with");
        assert_eq!(g.auth_method(&json!({ "authMethods": [{ "id": "oauth-personal" }] }), Some("AIzaTestKey123456")), None);
        assert_eq!(g.precheck(None).unwrap().0, ProbeState::KeyMissing);
        assert!(g.precheck(Some("AIzaTestKey123456")).is_none());
    }

    #[test]
    fn personal_google_sign_in_points_to_antigravity() {
        let g = Gemini::default();
        let legacy = "Failed to sign in. Message: This client is no longer supported for Gemini Code Assist for individuals. To continue using Gemini, please migrate to the Antigravity suite of products";
        assert_eq!(g.not_signed_in(legacy), LEGACY_SIGN_IN);
        assert_eq!(g.not_signed_in("API key not valid."), KEY_REJECTED);
        assert!(acp::is_auth_error(-32603, legacy), "the legacy answer counts as not signed in");
    }

    #[test]
    fn plan_mode_uses_geminis_plan_mode_when_offered() {
        let g = Gemini::default();
        let with_plan = [ModeInfo { id: "default".into(), name: String::new() }, ModeInfo { id: "plan".into(), name: String::new() }];
        assert_eq!(
            g.pick_mode(Mode::Plan, &with_plan, None).unwrap(),
            Some(ModeChoice { desired: "plan".into(), fallback: Some("default".into()) })
        );
        assert_eq!(g.pick_mode(Mode::Plan, &with_plan[..1], None).unwrap().unwrap().desired, "default");
        assert_eq!(g.pick_mode(Mode::Agent, &[], None).unwrap().unwrap().desired, "default");
    }

    /// Needs Gemini CLI and a paid Gemini API key:
    /// `AGENTHUB_GEMINI_KEY=… cargo test gemini::tests::live_probe -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn live_probe() {
        let key = std::env::var("AGENTHUB_GEMINI_KEY").ok();
        let probe = adapter().probe(None, key.as_deref());
        println!("{probe:#?}");
        assert_ne!(probe.state, ProbeState::NotFound, "{:?}", probe.message);
    }
}
