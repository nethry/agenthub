import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { exitCodeOf, grantKey, permissionFor, planFrom } from "./claude-tools.js";
import type { Engine } from "./engine.js";
import { redact } from "./protocol.js";
import { Rpc } from "./rpc.js";
import { serve } from "./server.js";
import { until } from "./testing.js";

/** AgentHub's side of the pipe. */
function harness(engine: Partial<Engine> = {}) {
  const toSidecar = new PassThrough();
  const lines: any[] = [];
  const rpc = new Rpc(toSidecar, (line) => {
    for (const l of line.split("\n").filter(Boolean)) lines.push(JSON.parse(l));
  });
  const started: any[] = [];
  const fake: Engine = {
    probe: async () => ({ state: "ready", models: [] }),
    startTurn: (p, turn) => {
      started.push({ p, turn });
    },
    closeSession: async () => {},
    shutdown: async () => {},
    ...engine,
  };
  let exited: number | undefined;
  serve(rpc, { engines: { "claude-code": fake, "copilot-cli": fake }, exit: (c) => (exited = c) });
  const send = (msg: object) => toSidecar.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`);
  return { send, lines, started, rpc, exited: () => exited, close: () => toSidecar.end() };
}

const start = { turnId: "t1", conversationId: "c1", engine: "claude-code", model: "default", mode: "agent", cwd: "C:/p", prompt: "hi", reconfigure: false };

describe("sidecar server", () => {
  it("answers initialize and probe, rejects unknown methods", async () => {
    const h = harness();
    h.send({ id: 1, method: "initialize", params: {} });
    h.send({ id: 2, method: "probe", params: { engine: "copilot-cli" } });
    h.send({ id: 3, method: "nope", params: {} });
    h.send({ id: 4, method: "probe", params: { engine: "x" } });
    await until(() => h.lines.length === 4);
    const by = (id: number) => h.lines.find((l) => l.id === id);
    expect(by(1).result).toEqual({ version: expect.any(String), node: process.versions.node });
    expect(by(2).result).toEqual({ state: "ready", models: [] });
    expect(by(3).error.code).toBe(-32601);
    expect(by(4).error.code).toBe(-32602);
  });

  it("passes checked images through and rejects anything else", async () => {
    const h = harness();
    const png = { mimeType: "image/png", data: "iVBORw0K" };
    h.send({ id: 1, method: "turn/start", params: { ...start, images: [png] } });
    h.send({ id: 2, method: "turn/start", params: { ...start, turnId: "t2", conversationId: "c2", images: [{ mimeType: "image/svg+xml", data: "PHN2Zz4=" }] } });
    h.send({ id: 3, method: "turn/start", params: { ...start, turnId: "t3", conversationId: "c3", images: Array(5).fill(png) } });
    await until(() => h.lines.length === 3);
    expect(h.started[0].p.images).toEqual([png]);
    expect(h.lines.find((l) => l.id === 2).error.code).toBe(-32602);
    expect(h.lines.find((l) => l.id === 3).error.code).toBe(-32602);
    expect(h.started).toHaveLength(1);
  });

  it("accepts a turn, then routes its events, approvals and interrupt", async () => {
    const h = harness();
    h.send({ id: 1, method: "turn/start", params: start });
    await until(() => h.started.length === 1);
    expect(h.lines[0]).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
    const turn = h.started[0].turn;
    turn.emit({ type: "text", text: "hello" });
    const approval = turn.approval("k1", { kind: "command", title: "Run", command: "ls", paths: [], canAllowSession: true });
    await until(() => h.lines.length === 3);
    expect(h.lines[1]).toEqual({ jsonrpc: "2.0", method: "turn/event", params: { turnId: "t1", event: { type: "text", text: "hello" } } });
    const req = h.lines[2];
    expect(req.method).toBe("turn/approval");
    expect(req.params.key).toBe("k1");
    h.send({ id: req.id, result: { decision: "allow_session" } });
    expect(await approval).toBe("allow_session");

    // A malformed answer is a denial.
    const second = turn.approval("k2", { kind: "write", title: "Write", paths: [], canAllowSession: false });
    await until(() => h.lines.length === 4);
    h.send({ id: h.lines[3].id, result: { decision: "yes please" } });
    expect(await second).toBe("deny");

    h.send({ id: 2, method: "turn/interrupt", params: { turnId: "t1" } });
    await until(() => h.lines.some((l) => l.params?.event?.type === "done"));
    expect(h.lines.find((l) => l.params?.event?.type === "done").params.event.outcome).toEqual({ type: "cancelled" });
    // Done is sent once; later events are dropped.
    turn.emit({ type: "text", text: "late" });
    turn.done({ type: "completed" });
    await new Promise((r) => setTimeout(r, 20));
    expect(h.lines.filter((l) => l.params?.event?.type === "done" || l.params?.event?.text === "late")).toHaveLength(1);
  });

  it("validates turn/start and refuses a second turn in the same conversation", async () => {
    const h = harness();
    h.send({ id: 1, method: "turn/start", params: { ...start, mode: "yolo" } });
    h.send({ id: 2, method: "turn/start", params: start });
    h.send({ id: 3, method: "turn/start", params: { ...start, turnId: "t2" } });
    await until(() => h.lines.filter((l) => l.id).length === 3 && h.lines.some((l) => l.params?.turnId === "t2"));
    expect(h.lines.find((l) => l.id === 1).error.code).toBe(-32602);
    const t2done = h.lines.find((l) => l.params?.turnId === "t2" && l.params.event.type === "done");
    expect(t2done.params.event.outcome.type).toBe("failed");
    expect(h.started).toHaveLength(1);
  });

  it("pending approvals end as cancel when the turn ends, and shutdown exits", async () => {
    const h = harness();
    h.send({ id: 1, method: "turn/start", params: start });
    await until(() => h.started.length === 1);
    const turn = h.started[0].turn;
    const pending = turn.approval("k", { kind: "read", title: "Read", paths: [], canAllowSession: true });
    turn.done({ type: "completed" });
    expect(await pending).toBe("cancel");
    h.send({ id: 9, method: "shutdown", params: {} });
    await until(() => h.exited() === 0);
  });
});

describe("claude tool mapping", () => {
  const cwd = process.platform === "win32" ? "C:\\proj" : "/proj";
  it("maps tools to permission kinds", () => {
    expect(permissionFor("Glob", { pattern: "**/*.rs" }, cwd)).toMatchObject({ kind: "read", path: cwd });
    expect(permissionFor("NotebookEdit", { notebook_path: "n.ipynb", new_source: "" }, cwd).kind).toBe("write");
    expect(permissionFor("PowerShell", { command: "Get-ChildItem" }, cwd)).toMatchObject({ kind: "command", command: "Get-ChildItem" });
    expect(permissionFor("WebFetch", { url: "https://docs.rs/x", prompt: "" }, cwd)).toMatchObject({ kind: "network", title: "Fetch docs.rs" });
    expect(permissionFor("mcp__github__list_issues", {}, cwd)).toMatchObject({ kind: "mcp", title: "Use MCP tool github › list_issues" });
    expect(permissionFor("Agent", { description: "x" }, cwd).kind).toBe("other");
    expect(grantKey("Bash", { command: "ls" }, cwd)).not.toBe(grantKey("Bash", { command: "ls -la" }, cwd));
  });

  it("reads plans and exit codes", () => {
    expect(planFrom({ todos: [{ content: "A", status: "completed", activeForm: "" }, { content: "B", status: "weird" }] })).toEqual([
      { text: "A", status: "completed" },
      { text: "B", status: "pending" },
    ]);
    expect(exitCodeOf("Exit code 2\nboom")).toBe(2);
    expect(exitCodeOf("fine")).toBeUndefined();
  });

  it("redacts key-like text", () => {
    expect(redact("bad key sk-ant-api03-abcdef123 and ghp_abcdefghijkl", undefined)).toBe("bad key [redacted] and [redacted]");
    expect(redact("risk-free task-list")).toBe("risk-free task-list");
  });
});
