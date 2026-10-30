//! Newline-delimited JSON-RPC over a child's stdio, both directions: our
//! requests get responses, and the peer's requests (approvals, file access)
//! and notifications go to a handler. Used for `codex app-server`,
//! `gemini --acp` and the Node sidecar. A reader thread owns stdout; when the
//! process exits, every pending request fails with `RpcError::Closed`.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, ChildStdin, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc};
use std::thread;
use std::time::Duration;

use parking_lot::Mutex;
use serde_json::{json, Value};

/// One line may not be longer than this (a broken or hostile peer).
const MAX_LINE: usize = 32 * 1024 * 1024;
/// stderr lines kept for error messages.
const STDERR_LINES: usize = 40;

#[derive(Debug, Clone, PartialEq)]
pub enum RpcError {
    /// The peer answered with a JSON-RPC error.
    Remote { code: i64, message: String, data: Option<Value> },
    Timeout,
    /// The process exited or closed its output.
    Closed,
    Io(String),
}

impl std::fmt::Display for RpcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RpcError::Remote { message, .. } => f.write_str(message),
            RpcError::Timeout => f.write_str("The runtime didn't answer in time"),
            RpcError::Closed => f.write_str("The runtime process ended"),
            RpcError::Io(m) => f.write_str(m),
        }
    }
}

#[derive(Debug, Clone)]
pub enum Incoming {
    Notification { method: String, params: Value },
    /// Answer with `Peer::respond` / `respond_error`, from any thread.
    Request { id: Value, method: String, params: Value },
    /// The peer is gone (process exit or closed stdout). Sent once.
    Closed,
}

pub type Handler = Arc<dyn Fn(&Arc<Peer>, Incoming) + Send + Sync>;

pub struct Peer {
    writer: Mutex<Box<dyn Write + Send>>,
    next_id: AtomicU64,
    pending: Mutex<HashMap<u64, mpsc::Sender<Result<Value, RpcError>>>>,
    alive: AtomicBool,
    /// Codex omits `"jsonrpc":"2.0"`; ACP and the sidecar send it.
    with_version: bool,
    stderr: Arc<Mutex<Vec<String>>>,
    child: Mutex<Option<Child>>,
}

impl Peer {
    /// Starts `cmd` with piped stdio. stderr is kept (last lines) for diagnostics.
    pub fn spawn(mut cmd: std::process::Command, with_version: bool, handler: Handler) -> Result<Arc<Peer>, RpcError> {
        cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        let mut child = cmd.spawn().map_err(|e| RpcError::Io(format!("Couldn't start the runtime: {e}")))?;
        let stdin: ChildStdin = child.stdin.take().ok_or(RpcError::Closed)?;
        let stdout = child.stdout.take().ok_or(RpcError::Closed)?;
        let stderr = child.stderr.take();
        let peer = Self::connect(stdout, stdin, with_version, handler);
        if let Some(err) = stderr {
            let lines = Arc::clone(&peer.stderr);
            thread::spawn(move || {
                for line in BufReader::new(err).lines().map_while(Result::ok) {
                    let mut l = lines.lock();
                    l.push(crate::chat::redact(&line, None));
                    if l.len() > STDERR_LINES {
                        l.remove(0);
                    }
                }
            });
        }
        *peer.child.lock() = Some(child);
        Ok(peer)
    }

    /// Wires a peer to any reader/writer (tests use in-memory pipes).
    pub fn connect(reader: impl Read + Send + 'static, writer: impl Write + Send + 'static, with_version: bool, handler: Handler) -> Arc<Peer> {
        let peer = Arc::new(Peer {
            writer: Mutex::new(Box::new(writer)),
            next_id: AtomicU64::new(1),
            pending: Mutex::new(HashMap::new()),
            alive: AtomicBool::new(true),
            with_version,
            stderr: Arc::new(Mutex::new(Vec::new())),
            child: Mutex::new(None),
        });
        let p = Arc::clone(&peer);
        thread::spawn(move || p.read_loop(BufReader::new(reader), handler));
        peer
    }

    fn read_loop(self: Arc<Self>, mut reader: BufReader<impl Read>, handler: Handler) {
        let mut buf = Vec::new();
        loop {
            buf.clear();
            match reader.by_ref().take(MAX_LINE as u64).read_until(b'\n', &mut buf) {
                Ok(0) | Err(_) => break,
                Ok(_) => {}
            }
            let line = String::from_utf8_lossy(&buf);
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let Ok(msg) = serde_json::from_str::<Value>(line) else {
                continue; // not protocol output; runtimes keep stdout clean, but don't trust it
            };
            self.dispatch(msg, &handler);
        }
        self.alive.store(false, Ordering::SeqCst);
        for (_, tx) in self.pending.lock().drain() {
            let _ = tx.send(Err(RpcError::Closed));
        }
        handler(&self, Incoming::Closed);
    }

    fn dispatch(self: &Arc<Self>, msg: Value, handler: &Handler) {
        let method = msg.get("method").and_then(Value::as_str).map(str::to_string);
        let id = msg.get("id").cloned().filter(|v| !v.is_null());
        match (method, id) {
            (Some(method), Some(id)) => {
                let params = msg.get("params").cloned().unwrap_or(Value::Null);
                handler(self, Incoming::Request { id, method, params });
            }
            (Some(method), None) => {
                let params = msg.get("params").cloned().unwrap_or(Value::Null);
                handler(self, Incoming::Notification { method, params });
            }
            (None, Some(id)) => {
                let Some(n) = id.as_u64() else { return };
                let Some(tx) = self.pending.lock().remove(&n) else { return };
                let result = if let Some(err) = msg.get("error") {
                    Err(RpcError::Remote {
                        code: err.get("code").and_then(Value::as_i64).unwrap_or(0),
                        message: err.get("message").and_then(Value::as_str).unwrap_or("Unknown error").to_string(),
                        data: err.get("data").cloned(),
                    })
                } else {
                    Ok(msg.get("result").cloned().unwrap_or(Value::Null))
                };
                let _ = tx.send(result);
            }
            (None, None) => {}
        }
    }

    pub fn is_alive(&self) -> bool {
        self.alive.load(Ordering::SeqCst)
    }

    fn write(&self, mut msg: Value) -> Result<(), RpcError> {
        if !self.is_alive() {
            return Err(RpcError::Closed);
        }
        if self.with_version {
            msg["jsonrpc"] = json!("2.0");
        }
        let mut line = serde_json::to_vec(&msg).map_err(|e| RpcError::Io(e.to_string()))?;
        line.push(b'\n');
        let mut w = self.writer.lock();
        w.write_all(&line).and_then(|_| w.flush()).map_err(|_| RpcError::Closed)
    }

    /// Sends a request and waits for its response.
    pub fn request(&self, method: &str, params: Value, timeout: Duration) -> Result<Value, RpcError> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = mpsc::channel();
        self.pending.lock().insert(id, tx);
        if let Err(e) = self.write(json!({ "id": id, "method": method, "params": params })) {
            self.pending.lock().remove(&id);
            return Err(e);
        }
        match rx.recv_timeout(timeout) {
            Ok(r) => r,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                self.pending.lock().remove(&id);
                Err(RpcError::Timeout)
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => Err(RpcError::Closed),
        }
    }

    pub fn notify(&self, method: &str, params: Value) -> Result<(), RpcError> {
        self.write(json!({ "method": method, "params": params }))
    }

    pub fn respond(&self, id: Value, result: Value) -> Result<(), RpcError> {
        self.write(json!({ "id": id, "result": result }))
    }

    pub fn respond_error(&self, id: Value, code: i64, message: &str) -> Result<(), RpcError> {
        self.write(json!({ "id": id, "error": { "code": code, "message": message } }))
    }

    /// Recent stderr lines (already redacted), for an error message.
    pub fn stderr_tail(&self, n: usize) -> String {
        let l = self.stderr.lock();
        l[l.len().saturating_sub(n)..].join("\n")
    }

    /// Ends the process (and with it the reader thread). Waiting requests
    /// fail with `Closed` at once, even if a child of the process still holds
    /// the pipe open.
    pub fn kill(&self) {
        self.alive.store(false, Ordering::SeqCst);
        self.pending.lock().clear();
        if let Some(mut child) = self.child.lock().take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }

    pub fn exit_code(&self) -> Option<i32> {
        self.child.lock().as_mut().and_then(|c| c.try_wait().ok().flatten()).and_then(|s| s.code())
    }
}

impl Drop for Peer {
    fn drop(&mut self) {
        if let Some(mut child) = self.child.get_mut().take() {
            let _ = child.kill();
        }
    }
}

#[cfg(test)]
pub mod testing {
    //! An in-memory peer: the test plays the runtime's side.
    use super::*;

    /// A pipe: writes on one end become reads on the other.
    pub struct PipeReader(mpsc::Receiver<Vec<u8>>, Vec<u8>);
    pub struct PipeWriter(mpsc::Sender<Vec<u8>>);

    pub fn pipe() -> (PipeWriter, PipeReader) {
        let (tx, rx) = mpsc::channel();
        (PipeWriter(tx), PipeReader(rx, Vec::new()))
    }

    impl Read for PipeReader {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            while self.1.is_empty() {
                match self.0.recv() {
                    Ok(chunk) => self.1 = chunk,
                    Err(_) => return Ok(0),
                }
            }
            let n = buf.len().min(self.1.len());
            buf[..n].copy_from_slice(&self.1[..n]);
            self.1.drain(..n);
            Ok(n)
        }
    }

    impl Write for PipeWriter {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0.send(buf.to_vec()).map_err(|_| std::io::ErrorKind::BrokenPipe)?;
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    /// The runtime side of a fake connection: read what AgentHub sent, write replies.
    pub struct FakeRuntime {
        pub to_client: Option<PipeWriter>,
        pub from_client: BufReader<PipeReader>,
    }

    impl FakeRuntime {
        pub fn send(&mut self, v: Value) {
            let mut line = serde_json::to_vec(&v).unwrap();
            line.push(b'\n');
            self.to_client.as_mut().unwrap().write_all(&line).unwrap();
        }
        /// Next message AgentHub wrote.
        pub fn recv(&mut self) -> Value {
            let mut line = String::new();
            self.from_client.read_line(&mut line).unwrap();
            serde_json::from_str(&line).unwrap_or_else(|_| panic!("not JSON: {line:?}"))
        }
        /// Reads until a message with `method`, answering nothing else.
        pub fn expect(&mut self, method: &str) -> Value {
            loop {
                let m = self.recv();
                if m["method"] == method {
                    return m;
                }
            }
        }
        /// Close the runtime's output (like a process exit).
        pub fn close(&mut self) {
            self.to_client = None;
        }
    }

    pub fn fake_peer(with_version: bool, handler: Handler) -> (Arc<Peer>, FakeRuntime) {
        let (to_client, client_reads) = pipe();
        let (client_writes, from_client) = pipe();
        let peer = Peer::connect(client_reads, client_writes, with_version, handler);
        (peer, FakeRuntime { to_client: Some(to_client), from_client: BufReader::new(from_client) })
    }
}

#[cfg(test)]
mod tests {
    use super::testing::*;
    use super::*;

    #[test]
    fn requests_responses_and_server_requests() {
        let seen = Arc::new(Mutex::new(Vec::<String>::new()));
        let s = Arc::clone(&seen);
        let handler: Handler = Arc::new(move |peer, msg| match msg {
            Incoming::Request { id, method, .. } => {
                s.lock().push(method);
                peer.respond(id, json!({ "decision": "accept" })).unwrap();
            }
            Incoming::Notification { method, .. } => s.lock().push(method),
            Incoming::Closed => s.lock().push("closed".into()),
        });
        let (peer, mut rt) = fake_peer(false, handler);
        let p = Arc::clone(&peer);
        let call = thread::spawn(move || p.request("thread/start", json!({ "cwd": "C:/p" }), Duration::from_secs(5)));
        let req = rt.recv();
        assert_eq!(req["method"], "thread/start");
        assert!(req.get("jsonrpc").is_none(), "Codex style omits the version");
        rt.send(json!({ "method": "thread/started", "params": {} }));
        rt.send(json!({ "id": 7, "method": "item/commandExecution/requestApproval", "params": {} }));
        let answer = rt.recv();
        assert_eq!(answer, json!({ "id": 7, "result": { "decision": "accept" } }));
        rt.send(json!({ "id": req["id"], "result": { "thread": { "id": "thr" } } }));
        assert_eq!(call.join().unwrap().unwrap()["thread"]["id"], "thr");

        let p = Arc::clone(&peer);
        let failing = thread::spawn(move || p.request("turn/start", json!({}), Duration::from_secs(5)));
        let req = rt.recv();
        rt.send(json!({ "id": req["id"], "error": { "code": -32602, "message": "bad params" } }));
        assert!(matches!(failing.join().unwrap(), Err(RpcError::Remote { code: -32602, .. })));

        let p = Arc::clone(&peer);
        let orphan = thread::spawn(move || p.request("never", json!({}), Duration::from_secs(5)));
        rt.recv();
        rt.close();
        assert_eq!(orphan.join().unwrap(), Err(RpcError::Closed));
        thread::sleep(Duration::from_millis(50));
        assert_eq!(*seen.lock(), vec!["thread/started", "item/commandExecution/requestApproval", "closed"]);
        assert!(!peer.is_alive());
    }

    #[test]
    fn acp_style_sends_the_version_and_times_out() {
        let (peer, mut rt) = fake_peer(true, Arc::new(|_, _| {}));
        let p = Arc::clone(&peer);
        let t = thread::spawn(move || p.request("initialize", json!({}), Duration::from_millis(100)));
        assert_eq!(rt.recv()["jsonrpc"], "2.0");
        assert_eq!(t.join().unwrap(), Err(RpcError::Timeout));
    }
}
