import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CopilotEngine, NOT_SIGNED_IN, resolveRuntime, type CopilotDeps } from "./copilot.js";
import { copilotPermission } from "./copilot-tools.js";
import type { TurnStartParams } from "./protocol.js";
import { FakeTransport, newTurn, until } from "./testing.js";

const CWD = resolve("/proj");

class FakeSession {
  handlers: ((ev: any) => void)[] = [];
  sent: any[] = [];
  aborted = 0;
  disconnected = false;
  constructor(
    readonly sessionId: string,
    readonly config: any,
  ) {}
  on(h: (ev: any) => void) {
    this.handlers.push(h);
    return () => {
      this.handlers = this.handlers.filter((x) => x !== h);
    };
  }
  async send(o: any) {
    this.sent.push(o);
    return "msg";
  }
  async abort() {
    this.aborted++;
  }
  async disconnect() {
    this.disconnected = true;
  }
  fire(type: string, data: any = {}) {
    for (const h of this.handlers) h({ type, data });
  }
}

function setup(opts: { authed?: boolean; resumable?: boolean } = {}) {
  const sessions: FakeSession[] = [];
  const clients: any[] = [];
  class FakeClient {
    started = false;
    stopped = false;
    constructor(readonly options: any) {
      clients.push(this);
    }
    async start() {
      this.started = true;
    }
    async stop() {
      this.stopped = true;
      return [];
    }
    async forceStop() {}
    async getStatus() {
      return { version: "1.0.103", protocolVersion: 3 };
    }
    async getAuthStatus() {
      return opts.authed === false ? { isAuthenticated: false } : { isAuthenticated: true, authType: "user", login: "octo" };
    }
    async listModels() {
      return [{ id: "gpt-x", name: "GPT X", capabilities: {} }, { id: "off", name: "Off", policy: { state: "disabled" } }];
    }
    async createSession(config: any) {
      const s = new FakeSession(`new-${sessions.length + 1}`, config);
      sessions.push(s);
      return s;
    }
    async resumeSession(id: string, config: any) {
      if (opts.resumable === false) throw new Error(`Session ${id} not found`);
      const s = new FakeSession(id, config);
      sessions.push(s);
      return s;
    }
  }
  const deps: CopilotDeps = {
    loadSdk: async () => ({ CopilotClient: FakeClient as any, RuntimeConnection: { forStdio: (o: any) => ({ kind: "stdio", ...o }) } }),
    which: () => undefined,
  };
  return { engine: new CopilotEngine(deps), sessions, clients };
}

function params(over: Partial<TurnStartParams> = {}): TurnStartParams {
  return { turnId: "t1", conversationId: "c1", engine: "copilot-cli", model: "default", mode: "agent", cwd: CWD, prompt: "Do it", reconfigure: false, ...over };
}

describe("copilot engine", () => {
  it("sends pasted images as blob attachments", async () => {
    const { engine, sessions } = setup();
    engine.startTurn(params({ images: [{ mimeType: "image/jpeg", data: "/9j/4A" }] }), newTurn(new FakeTransport()));
    await until(() => sessions.length === 1 && sessions[0].sent.length === 1);
    expect(sessions[0].sent[0].attachments).toEqual([{ type: "blob", data: "/9j/4A", mimeType: "image/jpeg", displayName: "image-1" }]);
    expect(sessions[0].sent[0].prompt).toBe("Do it");
  });

  it("runs a turn: text, a shell command with approval, usage, idle", async () => {
    const { engine, sessions } = setup();
    const tr = new FakeTransport();
    engine.startTurn(params(), newTurn(tr));
    await until(() => sessions.length === 1 && sessions[0].sent.length === 1);
    const s = sessions[0];
    expect(s.config.streaming).toBe(true);
    expect(s.config.workingDirectory).toBe(CWD);
    expect(s.config.availableTools).toBeUndefined();
    expect(s.config.model).toBeUndefined();
    expect(s.config.trustWorkingDirectory).toBe("session");

    s.fire("assistant.message_delta", { messageId: "m1", deltaContent: "Running " });
    s.fire("assistant.message_delta", { messageId: "m1", deltaContent: "tests" });
    s.fire("assistant.message", { messageId: "m1", content: "Running tests" });
    const decision = s.config.onPermissionRequest(
      { kind: "shell", toolCallId: "tc1", fullCommandText: "npm test", intention: "Run tests", canOfferSessionApproval: true, commands: [{ identifier: "npm test", readOnly: false }] },
      { sessionId: s.sessionId },
    );
    await until(() => tr.approvals.length === 1);
    expect(tr.approvals[0].params.request).toEqual({ kind: "command", title: "Run a command", command: "npm test", paths: [], detail: "Run tests", canAllowSession: true });
    tr.approvals[0].answer("allow_session");
    expect(await decision).toEqual({ kind: "approve-for-session", approval: { kind: "commands", commandIdentifiers: ["npm test"] } });
    s.fire("tool.execution_start", { toolCallId: "tc1", toolName: "powershell", arguments: { command: "npm test" } });
    s.fire("tool.shell_output", { toolCallId: "tc1", text: "ok\n", sequence: 1 });
    s.fire("tool.execution_complete", { toolCallId: "tc1", success: true, result: { content: "ok\n" }, shellExecution: { exitCode: 0 } });
    s.fire("assistant.usage", { model: "m", inputTokens: 100, outputTokens: 20, cost: 1 });
    s.fire("assistant.usage", { model: "m", inputTokens: 50, outputTokens: 5, cost: 1 });
    s.fire("session.idle", {});
    await until(() => !!tr.done());

    expect(tr.events).toEqual([
      { type: "session", id: "new-1", resumed: false },
      { type: "text", text: "Running " },
      { type: "text", text: "tests" },
      { type: "textBreak" },
      { type: "itemStarted", key: "tc1", status: "running", body: { kind: "command", command: "npm test", cwd: CWD, output: "" } },
      { type: "output", key: "tc1", text: "ok\n" },
      { type: "itemUpdated", key: "tc1", status: "completed", body: { kind: "command", command: "npm test", cwd: CWD, output: "ok\n", exitCode: 0 } },
      { type: "usage", usage: { inputTokens: 100, outputTokens: 20 } },
      { type: "usage", usage: { inputTokens: 150, outputTokens: 25 } },
      { type: "done", outcome: { type: "completed" } },
    ]);
  });

  it("enforces Ask and Plan in the session config and permission handler", async () => {
    const { engine, sessions } = setup();
    const ask = new FakeTransport();
    engine.startTurn(params({ mode: "ask", conversationId: "a" }), newTurn(ask, "ta", "a"));
    const plan = new FakeTransport();
    engine.startTurn(params({ mode: "plan", conversationId: "p" }), newTurn(plan, "tp", "p"));
    await until(() => sessions.length === 2 && sessions.every((s) => s.sent.length === 1));
    const [a, p] = sessions;
    expect(a.config.availableTools).toEqual([]);
    expect(a.sent[0].prompt).toMatch(/^AgentHub Ask mode/);
    expect(await a.config.onPermissionRequest({ kind: "read", path: "x", intention: "" })).toMatchObject({ kind: "reject" });
    expect(await a.config.hooks.onPreToolUse({ toolName: "view" })).toMatchObject({ permissionDecision: "deny" });
    expect(ask.approvals).toHaveLength(0);

    expect(p.config.availableTools).toEqual(["builtin:view", "builtin:glob", "builtin:grep", "builtin:rg"]);
    expect(await p.config.onPermissionRequest({ kind: "write", fileName: "a.rs", diff: "", intention: "", canOfferSessionApproval: true })).toMatchObject({ kind: "reject" });
    expect(await p.config.hooks.onPreToolUse({ toolName: "bash" })).toMatchObject({ permissionDecision: "deny" });
    expect(await p.config.hooks.onPreToolUse({ toolName: "view" })).toBeUndefined();
    const read = p.config.onPermissionRequest({ kind: "read", path: "../outside.txt", intention: "read it", toolCallId: "r1" });
    await until(() => plan.approvals.length === 1);
    expect(plan.approvals[0].params.request).toMatchObject({ kind: "read", path: resolve(CWD, "../outside.txt") });
    plan.approvals[0].answer("deny");
    expect(await read).toMatchObject({ kind: "reject" });
  });

  it("resumes stored sessions and falls back to a fresh one with the handoff", async () => {
    const ok = setup();
    const tr = new FakeTransport();
    ok.engine.startTurn(params({ sessionId: "old" }), newTurn(tr));
    await until(() => ok.sessions.length === 1 && ok.sessions[0].sent.length === 1);
    expect(tr.events[0]).toEqual({ type: "session", id: "old", resumed: true });

    const bad = setup({ resumable: false });
    const tr2 = new FakeTransport();
    bad.engine.startTurn(params({ sessionId: "old", handoff: "User: earlier" }), newTurn(tr2));
    await until(() => bad.sessions.length === 1 && bad.sessions[0].sent.length === 1);
    expect(tr2.types().slice(0, 2)).toEqual(["resumeFailed", "session"]);
    expect(tr2.events[1]).toEqual({ type: "session", id: "new-1", resumed: false });
    expect(bad.sessions[0].sent[0].prompt).toContain("User: earlier");
  });

  it("fails clearly when not signed in", async () => {
    const { engine, sessions } = setup({ authed: false });
    const tr = new FakeTransport();
    engine.startTurn(params(), newTurn(tr));
    await until(() => !!tr.done());
    expect(tr.done()).toEqual({ type: "done", outcome: { type: "failed", error: { kind: "not_signed_in", message: NOT_SIGNED_IN } } });
    expect(sessions).toHaveLength(0);
  });

  it("maps session errors and interrupts with abort", async () => {
    const { engine, sessions } = setup();
    const tr = new FakeTransport();
    engine.startTurn(params(), newTurn(tr));
    await until(() => sessions.length === 1 && sessions[0].sent.length === 1);
    sessions[0].fire("session.error", { errorType: "quota", message: "Quota exceeded" });
    await until(() => !!tr.done());
    expect(tr.done()).toMatchObject({ outcome: { type: "failed", error: { kind: "rate_limited" } } });

    const tr2 = new FakeTransport();
    const turn = newTurn(tr2, "t2");
    engine.startTurn(params({ turnId: "t2" }), turn);
    await until(() => sessions[0].sent.length === 2);
    expect(sessions).toHaveLength(1);
    turn.interrupt();
    expect(sessions[0].aborted).toBe(1);
    sessions[0].fire("session.idle", { aborted: true });
    await until(() => !!tr2.done());
    expect(tr2.done()).toEqual({ type: "done", outcome: { type: "cancelled" } });
  });

  it("probes version, account and models, then stops the client", async () => {
    const { engine, clients } = setup();
    const r = await engine.probe();
    expect(r).toMatchObject({ state: "ready", version: "1.0.103", account: "GitHub login: octo" });
    expect(r.models).toEqual([
      { id: "default", label: "Default", isDefault: true },
      { id: "gpt-x", label: "GPT X", isDefault: false },
    ]);
    expect(clients[0].stopped).toBe(true);
    expect(await setup({ authed: false }).engine.probe()).toMatchObject({ state: "sign_in_needed", message: NOT_SIGNED_IN });
  });

  it("rejects shims as the runtime", () => {
    expect(resolveRuntime("C:/missing/copilot.exe", () => undefined)).toHaveProperty("error");
    expect(resolveRuntime(undefined, () => "C:\\Program Files\\Microsoft VS Code Insiders\\bin\\copilot-shim\\copilot.exe")).toEqual({});
  });

  it("maps permission kinds with absolute paths", () => {
    const w = copilotPermission({ kind: "write", fileName: "src/a.rs", intention: "edit", canOfferSessionApproval: false, fileEdits: [{ after: { path: "src/b.rs", content: "" } }] }, CWD);
    expect(w.request).toMatchObject({ kind: "write", path: resolve(CWD, "src/a.rs"), paths: [resolve(CWD, "src/b.rs")], canAllowSession: false });
    expect(w.session).toBeUndefined();
    const u = copilotPermission({ kind: "url", url: "https://example.com/x", intention: "" }, CWD);
    expect(u).toMatchObject({ request: { kind: "network" }, session: { domain: "example.com" } });
    const m = copilotPermission({ kind: "mcp", serverName: "gh", toolName: "list", toolTitle: "List", readOnly: true }, CWD);
    expect(m.request.kind).toBe("mcp");
    const managed = copilotPermission({ kind: "read", path: "a", intention: "", managedApprovalRequired: true }, CWD);
    expect(managed.request.canAllowSession).toBe(false);
    expect(managed.session).toBeUndefined();
    expect(copilotPermission({ kind: "hook", toolName: "x" }, CWD).request.kind).toBe("other");
  });
});
