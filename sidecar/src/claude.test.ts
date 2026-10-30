import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ClaudeEngine, HOOK_TIMEOUT_SECONDS, claudeEnv, type ClaudeDeps } from "./claude.js";
import type { TurnStartParams } from "./protocol.js";
import { FakeQuery, FakeTransport, newTurn, until } from "./testing.js";

const CWD = resolve("/proj");

function setup() {
  const queries: FakeQuery[] = [];
  const deps: ClaudeDeps = {
    loadSdk: async () => ({
      query: ({ prompt, options }: any) => {
        const q = new FakeQuery(options, prompt);
        queries.push(q);
        return q as any;
      },
    }),
    which: () => undefined,
    versionOf: async () => "2.1.311 (Claude Code)",
    bundled: () => ({ path: "C:/sdk/claude.exe", version: "2.1.310" }),
    env: { PATH: "C:/bin", CLAUDE_CODE_OAUTH_TOKEN: "oauth-secret", anthropic_auth_token: "bearer", ANTHROPIC_API_KEY: "old" },
  };
  return { engine: new ClaudeEngine(deps), queries };
}

function params(over: Partial<TurnStartParams> = {}): TurnStartParams {
  return {
    turnId: "t1",
    conversationId: "c1",
    engine: "claude-code",
    model: "default",
    mode: "agent",
    cwd: CWD,
    prompt: "Fix the bug",
    reconfigure: false,
    apiKey: "sk-ant-api03-testkey123456",
    ...over,
  };
}

const init = (extra: object = {}) => ({ type: "system", subtype: "init", session_id: "sess-1", apiKeySource: "ANTHROPIC_API_KEY", ...extra });
const success = (cost = 0.01) => ({
  type: "result",
  subtype: "success",
  is_error: false,
  result: "ok",
  total_cost_usd: cost,
  usage: { input_tokens: 10, cache_read_input_tokens: 5, cache_creation_input_tokens: 0, output_tokens: 7 },
});

describe("claude engine", () => {
  it("fails without an API key and never starts the SDK", async () => {
    const { engine, queries } = setup();
    const tr = new FakeTransport();
    engine.startTurn(params({ apiKey: undefined }), newTurn(tr));
    await until(() => !!tr.done());
    expect(tr.done()).toMatchObject({ outcome: { type: "failed", error: { kind: "missing_key" } } });
    expect(queries).toHaveLength(0);
  });

  it("passes only the API key and restrictive options", async () => {
    const { engine, queries } = setup();
    engine.startTurn(params(), newTurn(new FakeTransport()));
    await until(() => queries.length === 1);
    const o = queries[0].options;
    expect(o.env.ANTHROPIC_API_KEY).toBe("sk-ant-api03-testkey123456");
    expect(o.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(o.env.anthropic_auth_token).toBeUndefined();
    expect(o.env.PATH).toBe("C:/bin");
    expect(o.settingSources).toEqual([]);
    expect(o.permissionMode).toBe("default");
    expect(o.includePartialMessages).toBe(true);
    expect(o.verbatimPrompts).toBe(true);
    expect(o.model).toBeUndefined();
    expect(o.tools).toEqual({ type: "preset", preset: "claude_code" });
    expect(o.disallowedTools).toContain("ExitPlanMode");
    expect(o.hooks.PreToolUse[0].timeout).toBe(HOOK_TIMEOUT_SECONDS);
    expect(o.resume).toBeUndefined();
  });

  it("restricts tools by mode and prefixes mode instructions", async () => {
    const { engine, queries } = setup();
    engine.startTurn(params({ mode: "ask", conversationId: "a" }), newTurn(new FakeTransport(), "t-a", "a"));
    engine.startTurn(params({ mode: "plan", conversationId: "p", model: "opus" }), newTurn(new FakeTransport(), "t-p", "p"));
    await until(() => queries.length === 2 && queries.every((q) => q.prompts.length === 1));
    const [ask, plan] = queries;
    expect(ask.options.tools).toEqual([]);
    expect(plan.options.tools).toEqual(["Read", "Glob", "Grep", "TodoWrite"]);
    expect(plan.options.disallowedTools).toEqual(expect.arrayContaining(["Bash", "Write", "Edit", "WebFetch"]));
    expect(plan.options.model).toBe("opus");
    expect(ask.options.disallowedTools).toContain("TodoWrite");
    expect(plan.options.disallowedTools).not.toContain("TodoWrite");
    expect(ask.prompts[0].message.content).toMatch(/^AgentHub Ask mode/);
    expect(plan.prompts[0].message.content).toMatch(/Fix the bug$/);
  });

  it("sends pasted images as base64 image blocks before the text", async () => {
    const { engine, queries } = setup();
    engine.startTurn(params({ images: [{ mimeType: "image/png", data: "iVBORw0K" }] }), newTurn(new FakeTransport()));
    await until(() => queries.length === 1 && queries[0].prompts.length === 1);
    expect(queries[0].prompts[0].message.content).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0K" } },
      { type: "text", text: "Fix the bug" },
    ]);
  });

  it("maps a whole turn: session, streamed text, a command with approval, usage, done", async () => {
    const { engine, queries } = setup();
    const tr = new FakeTransport();
    engine.startTurn(params(), newTurn(tr));
    await until(() => queries.length === 1);
    const q = queries[0];
    q.emit(init());
    q.emit({ type: "stream_event", parent_tool_use_id: null, event: { type: "message_start", message: { id: "m1" } } });
    q.emit({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_start", index: 0, content_block: { type: "text" } } });
    q.emit({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Let me " } } });
    q.emit({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "check." } } });
    q.emit({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_stop", index: 0 } });
    q.emit({ type: "assistant", parent_tool_use_id: null, message: { id: "m1", content: [{ type: "text", text: "Let me check." }] } });
    q.emit({
      type: "assistant",
      parent_tool_use_id: null,
      message: { id: "m1", content: [{ type: "tool_use", id: "tu1", name: "Bash", input: { command: "cargo test", description: "Run tests" } }] },
    });
    await until(() => tr.types().includes("itemStarted"));

    const hook = q.preToolUse("Bash", { command: "cargo test" }, "tu1");
    await until(() => tr.approvals.length === 1);
    expect(tr.approvals[0].params).toEqual({
      turnId: "t1",
      key: "tu1",
      request: { kind: "command", title: "Run a command", command: "cargo test", paths: [], canAllowSession: true },
    });
    tr.approvals[0].answer("allow_once");
    expect((await hook).hookSpecificOutput).toMatchObject({ hookEventName: "PreToolUse", permissionDecision: "allow" });

    q.emit({
      type: "user",
      parent_tool_use_id: null,
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "test result: ok", is_error: false }] },
      tool_use_result: { stdout: "test result: ok", stderr: "", interrupted: false },
    });
    q.emit(success(0.25));
    await until(() => !!tr.done());

    expect(tr.events).toEqual([
      { type: "session", id: "sess-1", resumed: false },
      { type: "text", text: "Let me " },
      { type: "text", text: "check." },
      { type: "textBreak" },
      { type: "itemStarted", key: "tu1", status: "running", body: { kind: "command", command: "cargo test", cwd: CWD, output: "" } },
      { type: "itemUpdated", key: "tu1", status: "completed", body: { kind: "command", command: "cargo test", cwd: CWD, output: "test result: ok", exitCode: 0 } },
      { type: "usage", usage: { inputTokens: 15, outputTokens: 7, costUsd: 0.25 } },
      { type: "done", outcome: { type: "completed" } },
    ]);
  });

  it("asks for reads with absolute paths and marks denied tools declined", async () => {
    const { engine, queries } = setup();
    const tr = new FakeTransport();
    engine.startTurn(params(), newTurn(tr));
    await until(() => queries.length === 1);
    const q = queries[0];
    q.emit(init());
    q.emit({ type: "assistant", parent_tool_use_id: null, message: { id: "m1", content: [{ type: "tool_use", id: "w1", name: "Write", input: { file_path: "src/a.rs", content: "x" } }] } });
    const read = q.preToolUse("Read", { file_path: "src/b.rs" }, "r1");
    await until(() => tr.approvals.length === 1);
    expect(tr.approvals[0].params.request).toMatchObject({ kind: "read", path: resolve(CWD, "src/b.rs") });
    tr.approvals[0].answer("allow_once");
    await read;
    const write = q.preToolUse("Write", { file_path: "src/a.rs", content: "x" }, "w1");
    await until(() => tr.approvals.length === 2);
    expect(tr.approvals[1].params.request).toMatchObject({ kind: "write", path: resolve(CWD, "src/a.rs"), title: "Write src/a.rs" });
    tr.approvals[1].answer("deny");
    expect((await write).hookSpecificOutput.permissionDecision).toBe("deny");
    q.emit({ type: "user", parent_tool_use_id: null, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "w1", content: "denied", is_error: true }] } });
    await until(() => tr.types().includes("itemUpdated"));
    expect(tr.events.find((e) => e.type === "itemUpdated")).toMatchObject({ key: "w1", status: "declined" });
  });

  it("remembers allow-for-session for the same command in the live session", async () => {
    const { engine, queries } = setup();
    const tr = new FakeTransport();
    engine.startTurn(params(), newTurn(tr));
    await until(() => queries.length === 1);
    const q = queries[0];
    q.emit(init());
    const first = q.preToolUse("Bash", { command: "pnpm test" }, "b1");
    await until(() => tr.approvals.length === 1);
    tr.approvals[0].answer("allow_session");
    expect((await first).hookSpecificOutput.permissionDecision).toBe("allow");
    const again = await q.preToolUse("Bash", { command: "pnpm test" }, "b2");
    expect(again.hookSpecificOutput.permissionDecision).toBe("allow");
    const other = q.preToolUse("Bash", { command: "pnpm build" }, "b3");
    await until(() => tr.approvals.length === 2);
    tr.approvals[1].answer("deny");
    await other;
  });

  it("allows TodoWrite without an approval (and shows it as a plan) while Write still asks", async () => {
    const { engine, queries } = setup();
    const tr = new FakeTransport();
    engine.startTurn(params(), newTurn(tr));
    await until(() => queries.length === 1);
    const q = queries[0];
    q.emit(init());
    const todos = { todos: [{ content: "Read the code", status: "in_progress", activeForm: "Reading" }] };
    q.emit({ type: "assistant", parent_tool_use_id: null, message: { id: "m1", content: [{ type: "tool_use", id: "td1", name: "TodoWrite", input: todos }] } });
    await until(() => tr.types().includes("plan"));
    const todo = await q.preToolUse("TodoWrite", todos, "td1");
    expect(todo.hookSpecificOutput.permissionDecision).toBe("allow");
    expect(tr.approvals).toHaveLength(0);
    expect(tr.events).toContainEqual({ type: "plan", steps: [{ text: "Read the code", status: "in_progress" }] });
    expect(tr.types()).not.toContain("itemStarted");

    const write = q.preToolUse("Write", { file_path: "a.txt", content: "x" }, "w1");
    await until(() => tr.approvals.length === 1);
    expect(tr.approvals[0].params.request.kind).toBe("write");
    tr.approvals[0].answer("deny");
    expect((await write).hookSpecificOutput.permissionDecision).toBe("deny");
  });

  it("stops before any request when the CLI doesn't use the API key", async () => {
    const { engine, queries } = setup();
    const tr = new FakeTransport();
    engine.startTurn(params(), newTurn(tr));
    await until(() => queries.length === 1);
    queries[0].emit(init({ apiKeySource: "none" }));
    await until(() => !!tr.done());
    expect(tr.done()).toMatchObject({ outcome: { type: "failed", error: { kind: "invalid_key" } } });
    expect(queries[0].closed).toBe(true);
  });

  it("maps assistant errors to error kinds without leaking the key", async () => {
    const { engine, queries } = setup();
    const tr = new FakeTransport();
    engine.startTurn(params(), newTurn(tr));
    await until(() => queries.length === 1);
    const q = queries[0];
    q.emit(init());
    q.emit({ type: "assistant", parent_tool_use_id: null, error: "rate_limit", message: { id: "m", content: [] } });
    q.emit({ type: "result", subtype: "success", is_error: true, result: "Rate limited for sk-ant-api03-testkey123456", total_cost_usd: 0, usage: {} });
    await until(() => !!tr.done());
    const done: any = tr.done();
    expect(done.outcome.error.kind).toBe("rate_limited");
    expect(done.outcome.error.message).not.toContain("testkey");
  });

  it("reuses the live query for the next turn and recreates it with resume on reconfigure", async () => {
    const { engine, queries } = setup();
    const tr1 = new FakeTransport();
    engine.startTurn(params(), newTurn(tr1));
    await until(() => queries.length === 1);
    queries[0].emit(init());
    queries[0].emit(success(0.1));
    await until(() => !!tr1.done());

    const tr2 = new FakeTransport();
    engine.startTurn(params({ turnId: "t2", prompt: "Next" }), newTurn(tr2, "t2"));
    await until(() => queries[0].prompts.length === 2);
    expect(queries).toHaveLength(1);
    expect(tr2.events[0]).toEqual({ type: "session", id: "sess-1", resumed: true });
    queries[0].emit(success(0.3));
    await until(() => !!tr2.done());
    expect(tr2.events.find((e) => e.type === "usage")).toMatchObject({ usage: { costUsd: expect.closeTo(0.2, 5) } });

    const tr3 = new FakeTransport();
    engine.startTurn(params({ turnId: "t3", mode: "plan", reconfigure: true }), newTurn(tr3, "t3"));
    await until(() => queries.length === 2);
    expect(queries[0].closed).toBe(true);
    expect(queries[1].options.resume).toBe("sess-1");
    expect(queries[1].options.tools).toEqual(["Read", "Glob", "Grep", "TodoWrite"]);
  });

  it("starts fresh with the handoff when the stored session can't be resumed", async () => {
    const { engine, queries } = setup();
    const tr = new FakeTransport();
    engine.startTurn(params({ sessionId: "gone", handoff: "User: hi\nAssistant: hello" }), newTurn(tr));
    await until(() => queries.length === 1);
    expect(queries[0].options.resume).toBe("gone");
    queries[0].fail(new Error("No conversation found with session ID: gone"));
    await until(() => queries.length === 2);
    expect(queries[1].options.resume).toBeUndefined();
    await until(() => queries[1].prompts.length === 1);
    expect(queries[1].prompts[0].message.content).toContain("User: hi");
    expect(tr.events[0]).toMatchObject({ type: "resumeFailed" });
    queries[1].emit(init({ session_id: "fresh" }));
    await until(() => tr.types().includes("session"));
    expect(tr.events.find((e) => e.type === "session")).toEqual({ type: "session", id: "fresh", resumed: false });
  });

  it("interrupts through the SDK and ends cancelled", async () => {
    const { engine, queries } = setup();
    const tr = new FakeTransport();
    const turn = newTurn(tr);
    engine.startTurn(params(), turn);
    await until(() => queries.length === 1);
    queries[0].emit(init());
    await until(() => tr.types().includes("session"));
    turn.interrupt();
    expect(queries[0].interrupted).toBe(1);
    queries[0].emit({ type: "result", subtype: "error_during_execution", is_error: true, errors: [], total_cost_usd: 0, usage: {} });
    await until(() => !!tr.done());
    expect(tr.done()).toEqual({ type: "done", outcome: { type: "cancelled" } });
    expect(queries[0].closed).toBe(true);
  });

  it("reports a crash as runtime_exited", async () => {
    const { engine, queries } = setup();
    const tr = new FakeTransport();
    engine.startTurn(params(), newTurn(tr));
    await until(() => queries.length === 1);
    queries[0].emit(init());
    queries[0].fail(new Error("Claude Code process exited with code 1"));
    await until(() => !!tr.done());
    expect(tr.done()).toMatchObject({ outcome: { type: "failed", error: { kind: "runtime_exited" } } });
  });

  it("probes the executable, version and models without a key", async () => {
    const { engine, queries } = setup();
    const r = await engine.probe();
    expect(r).toMatchObject({ state: "ready", path: "C:/sdk/claude.exe", version: "2.1.310" });
    expect(r.models).toEqual([
      { id: "default", label: "Default", isDefault: true },
      { id: "opus", label: "Opus", isDefault: false },
    ]);
    expect(queries[0].options.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(queries[0].closed).toBe(true);
    expect(await engine.probe("C:/nope/claude.exe")).toMatchObject({ state: "not_found" });
  });

  it("builds the child environment without subscription credentials", () => {
    const env = claudeEnv({ Path: "x", Claude_Code_OAuth_Token: "t" }, "key");
    expect(env).toEqual({ Path: "x", ANTHROPIC_API_KEY: "key", CLAUDE_AGENT_SDK_CLIENT_APP: "agenthub/0.1.0" });
  });
});
