// Claude engine on the Claude Agent SDK. One live Query per conversation in
// streaming-input mode, so later turns reuse the Claude Code process; a mode,
// model, executable or key change recreates it with `resume`.
//
// Auth is the user's Anthropic API key only (AgentHub passes it per turn; the
// claude.ai subscription login isn't allowed for third-party apps). Every tool
// call goes to AgentHub as `turn/approval` from a PreToolUse hook before it runs.

import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import type {
  CanUseTool,
  HookCallback,
  HookJSONOutput,
  Options,
  PermissionUpdate,
  Query,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  AGENT_DISALLOWED_TOOLS,
  READ_TOOLS,
  bodyFor,
  exitCodeOf,
  grantKey,
  permissionFor,
  planFrom,
  resultText,
} from "./claude-tools.js";
import { type Engine, errorMessage, log, withTimeout } from "./engine.js";
import { isFile, isShellShim, versionOf as defaultVersionOf, which as defaultWhich } from "./exe.js";
import {
  type ErrorKind,
  type ItemBody,
  type ModelInfo,
  type Outcome,
  type ProbeResult,
  type TurnStartParams,
  composePrompt,
  failed,
  redact,
  truncate,
} from "./protocol.js";
import { AsyncQueue } from "./queue.js";
import type { Turn } from "./turn.js";

type QueryFn = (params: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }) => Query;

export interface ClaudeDeps {
  loadSdk(): Promise<{ query: QueryFn }>;
  which(name: string): string | undefined;
  versionOf(exe: string): Promise<string | undefined>;
  /** The Claude Code binary that ships with the SDK, if installed. */
  bundled(): { path?: string; version?: string };
  env: NodeJS.ProcessEnv;
}

/** Hooks wait for the user's decision; give them a day before the CLI gives up. */
export const HOOK_TIMEOUT_SECONDS = 24 * 60 * 60;
const INTERRUPT_GRACE_MS = 3000;
const RESULT_MAX = 2000;

/**
 * The one tool allowed without asking AgentHub: TodoWrite only updates Claude's
 * in-memory task list (shown as the turn's plan). It has no file, process or
 * network effect, so an approval prompt for every list update would add noise
 * without protecting anything.
 */
export const SIDE_EFFECT_FREE_TOOLS = new Set(["TodoWrite"]);

/** Tools other than Read/Glob/Grep/TodoWrite, removed by name in Plan (on top of the `tools` allowlist). */
const NON_READ_TOOLS = [
  "Bash",
  "PowerShell",
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "WebFetch",
  "WebSearch",
  "Agent",
  "Task",
  "Skill",
  "Monitor",
  "Workflow",
  "LSP",
  ...AGENT_DISALLOWED_TOOLS,
];

export const NOT_SIGNED_IN = "Anthropic rejected the API key. Check it in Settings › AI providers.";

export function defaultClaudeDeps(): ClaudeDeps {
  return {
    loadSdk: () => import("@anthropic-ai/claude-agent-sdk") as Promise<{ query: QueryFn }>,
    which: (n) => defaultWhich(n),
    versionOf: (exe) => defaultVersionOf(exe, ["--version"]),
    bundled: bundledClaude,
    env: process.env,
  };
}

/** Finds the SDK's bundled Claude Code binary next to the installed SDK. */
function bundledClaude(): { path?: string; version?: string } {
  try {
    const entry = fileURLToPath(import.meta.resolve("@anthropic-ai/claude-agent-sdk"));
    const pkg = JSON.parse(readFileSync(join(dirname(entry), "package.json"), "utf8"));
    const req = createRequire(entry);
    const platform = `${process.platform}-${process.arch}`;
    let path: string | undefined;
    try {
      const pj = req.resolve(`@anthropic-ai/claude-agent-sdk-${platform}/package.json`);
      const exe = join(dirname(pj), process.platform === "win32" ? "claude.exe" : "claude");
      if (isFile(exe)) path = exe;
    } catch {
      // optional platform package not installed
    }
    return { path, version: typeof pkg.claudeCodeVersion === "string" ? pkg.claudeCodeVersion : undefined };
  } catch {
    return {};
  }
}

/** Environment for the Claude Code child: the API key, never the subscription login. */
export function claudeEnv(base: NodeJS.ProcessEnv, apiKey: string | undefined): Record<string, string | undefined> {
  const drop = new Set(["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"]);
  const env: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(base)) {
    if (!drop.has(k.toUpperCase())) env[k] = v;
  }
  if (apiKey) env.ANTHROPIC_API_KEY = apiKey;
  env.CLAUDE_AGENT_SDK_CLIENT_APP = "agenthub/0.1.0";
  return env;
}

export function errorKindFor(error: string | undefined): ErrorKind {
  switch (error) {
    case "authentication_failed":
    case "oauth_org_not_allowed":
    case "account_on_hold":
    case "verification_required":
      return "not_signed_in";
    case "billing_error":
      return "insufficient_credits";
    case "rate_limit":
      return "rate_limited";
    case "overloaded":
      return "overloaded";
    case "invalid_request":
      return "invalid_request";
    case "model_not_found":
      return "model_unavailable";
    default:
      return "provider_error";
  }
}

interface ToolCall {
  name: string;
  input: unknown;
}

interface TurnState {
  turn: Turn;
  params: TurnStartParams;
  prompt: string;
  sessionEmitted: boolean;
  streamed: Set<string>;
  messageId?: string;
  blocks: Map<number, string>;
  tools: Map<string, ToolCall>;
  denied: Set<string>;
  decided: Map<string, boolean>;
  assistantError?: string;
}

interface Session {
  conversationId: string;
  sig: string;
  q: Query;
  input: AsyncQueue<SDKUserMessage>;
  cwd: string;
  exe?: string;
  apiKey?: string;
  sessionId?: string;
  resumeId?: string;
  sawInit: boolean;
  closed: boolean;
  turn?: TurnState;
  grants: Set<string>;
  /** Last cumulative `total_cost_usd`; unknown for a resumed query until its first result. */
  costBase?: number;
  stderr: string[];
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

export class ClaudeEngine implements Engine {
  private sessions = new Map<string, Session>();

  constructor(private readonly deps: ClaudeDeps = defaultClaudeDeps()) {}

  // ---------- probe ----------

  async probe(executable?: string): Promise<ProbeResult> {
    let sdk: { query: QueryFn };
    try {
      sdk = await this.deps.loadSdk();
    } catch {
      return { state: "error", message: "The Claude Agent SDK isn't installed in the sidecar. Run `pnpm install`, then rebuild the sidecar.", models: [] };
    }
    let exe: string | undefined;
    let version: string | undefined;
    if (executable) {
      if (!isFile(executable) || isShellShim(executable)) {
        return { state: "not_found", message: `${executable} isn't a runnable Claude Code executable.`, models: [] };
      }
      exe = executable;
    } else {
      exe = this.deps.which("claude");
    }
    if (exe) {
      version = await this.deps.versionOf(exe);
    } else {
      const b = this.deps.bundled();
      exe = b.path;
      version = b.version;
      if (!exe) {
        return { state: "not_found", message: "Claude Code wasn't found on PATH and the SDK's bundled binary is missing. Reinstall the sidecar's dependencies.", models: [] };
      }
    }
    const models = await this.models(sdk, executable ? exe : this.deps.which("claude"));
    return { state: "ready", path: exe, version, models };
  }

  /** Model list from the CLI's initialize answer (no prompt, so no API request). */
  private async models(sdk: { query: QueryFn }, exe: string | undefined): Promise<ModelInfo[]> {
    const input = new AsyncQueue<SDKUserMessage>();
    let q: Query | undefined;
    try {
      q = sdk.query({
        prompt: input,
        options: {
          pathToClaudeCodeExecutable: exe,
          env: claudeEnv(this.deps.env, undefined),
          settingSources: [],
          strictMcpConfig: true,
          tools: [],
          permissionMode: "default",
          persistSession: false,
          stderr: () => {},
        },
      });
      const list = await withTimeout(q.supportedModels(), 20_000, () => []);
      return list
        .filter((m) => typeof m?.value === "string")
        .map((m) => ({ id: m.value, label: m.displayName || m.value, isDefault: m.value === "default" }));
    } catch (e) {
      log(`claude: model list unavailable (${truncate(redact(errorMessage(e)), 200)})`);
      return [];
    } finally {
      input.end();
      try {
        q?.close();
      } catch {
        // ignore
      }
    }
  }

  // ---------- turns ----------

  startTurn(params: TurnStartParams, turn: Turn): void {
    this.run(params, turn).catch((e) => {
      log(`claude: turn failed to start (${truncate(redact(errorMessage(e), params.apiKey), 200)})`);
      turn.done(failed("provider_error", `Claude Agent couldn't start: ${redact(errorMessage(e), params.apiKey)}`));
    });
  }

  private async run(params: TurnStartParams, turn: Turn): Promise<void> {
    if (!params.apiKey) {
      turn.done(failed("missing_key", "Claude Agent runs with your Anthropic API key. Add it in Settings › AI providers."));
      return;
    }
    let exe: string | undefined;
    if (params.executable) {
      if (!isFile(params.executable) || isShellShim(params.executable)) {
        turn.done(failed("engine_not_found", `${params.executable} isn't a runnable Claude Code executable. Check Settings › AI integrations.`));
        return;
      }
      exe = params.executable;
    } else {
      exe = this.deps.which("claude");
    }
    let sdk: { query: QueryFn };
    try {
      sdk = await this.deps.loadSdk();
    } catch {
      turn.done(failed("engine_not_found", "The Claude Agent SDK isn't installed in the sidecar. Run `pnpm install`, then rebuild the sidecar."));
      return;
    }
    if (turn.isDone) return;

    const sig = JSON.stringify([params.mode, params.model, params.cwd, exe ?? "", sha(params.apiKey)]);
    let session = this.sessions.get(params.conversationId);
    let resumeId = params.sessionId;
    if (session && (params.reconfigure || session.sig !== sig || session.closed || session.turn)) {
      resumeId = session.sessionId ?? resumeId;
      this.closeSessionObj(session);
      session = undefined;
    }
    if (!session) session = this.open(sdk, params, exe, sig, resumeId);
    this.begin(session, params, turn, composePrompt(params.prompt, params.mode));
  }

  private open(sdk: { query: QueryFn }, params: TurnStartParams, exe: string | undefined, sig: string, resumeId: string | undefined): Session {
    const input = new AsyncQueue<SDKUserMessage>();
    const session: Session = {
      conversationId: params.conversationId,
      sig,
      q: undefined as unknown as Query,
      input,
      cwd: params.cwd,
      exe,
      apiKey: params.apiKey,
      resumeId,
      sawInit: false,
      closed: false,
      grants: new Set(),
      costBase: resumeId ? undefined : 0,
      stderr: [],
    };
    const preToolUse: HookCallback = async (hookInput): Promise<HookJSONOutput> => {
      if (hookInput.hook_event_name !== "PreToolUse") return {};
      const r = await this.gate(session, hookInput.tool_name, hookInput.tool_input, hookInput.tool_use_id);
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: r.allow ? "allow" : "deny",
          permissionDecisionReason: r.reason,
        },
      };
    };
    // Fail-safe: anything that still reaches a permission prompt asks AgentHub too.
    const canUseTool: CanUseTool = async (name, toolInput, opts) => {
      const r = await this.gate(session, name, toolInput, opts.toolUseID);
      if (!r.allow) return { behavior: "deny", message: r.reason ?? "Denied by AgentHub." };
      const updatedPermissions: PermissionUpdate[] | undefined =
        r.session && opts.suggestions ? opts.suggestions.map((s) => ({ ...s, destination: "session" as const })) : undefined;
      return { behavior: "allow", updatedInput: toolInput, updatedPermissions };
    };
    const mode = params.mode;
    const options: Options = {
      cwd: params.cwd,
      model: params.model && params.model !== "default" ? params.model : undefined,
      pathToClaudeCodeExecutable: exe,
      env: claudeEnv(this.deps.env, params.apiKey),
      settingSources: [],
      strictMcpConfig: true,
      includePartialMessages: true,
      permissionMode: "default",
      systemPrompt: { type: "preset", preset: "claude_code" },
      tools: mode === "ask" ? [] : mode === "plan" ? [...READ_TOOLS, "TodoWrite"] : { type: "preset", preset: "claude_code" },
      disallowedTools: mode === "agent" ? [...AGENT_DISALLOWED_TOOLS] : mode === "plan" ? [...NON_READ_TOOLS] : [...NON_READ_TOOLS, "TodoWrite"],
      hooks: { PreToolUse: [{ hooks: [preToolUse], timeout: HOOK_TIMEOUT_SECONDS }] },
      canUseTool,
      // No @file expansion or slash commands: Ask mode must not read files that way.
      verbatimPrompts: true,
      resume: resumeId,
      stderr: (data: string) => {
        for (const line of data.split(/\r?\n/)) {
          if (!line.trim()) continue;
          session.stderr.push(redact(line, params.apiKey));
          if (session.stderr.length > 20) session.stderr.shift();
        }
      },
    };
    session.q = sdk.query({ prompt: input, options });
    this.sessions.set(params.conversationId, session);
    void this.read(session, sdk);
    return session;
  }

  private begin(session: Session, params: TurnStartParams, turn: Turn, prompt: string): void {
    const state: TurnState = {
      turn,
      params,
      prompt,
      sessionEmitted: false,
      streamed: new Set(),
      blocks: new Map(),
      tools: new Map(),
      denied: new Set(),
      decided: new Map(),
    };
    session.turn = state;
    turn.onInterrupt = () => this.interrupt(session, state);
    // A live session already knows its id: report it now.
    if (session.sawInit && session.sessionId) {
      state.sessionEmitted = true;
      turn.emit({ type: "session", id: session.sessionId, resumed: true });
    }
    const images = params.images ?? [];
    session.input.push({
      type: "user",
      // Pasted images go first as base64 image blocks, then the text.
      message: {
        role: "user",
        content: images.length
          ? [
              ...images.map((i) => ({ type: "image" as const, source: { type: "base64" as const, media_type: i.mimeType, data: i.data } })),
              { type: "text" as const, text: prompt },
            ]
          : prompt,
      },
      parent_tool_use_id: null,
    });
  }

  private interrupt(session: Session, state: TurnState): void {
    session.q.interrupt().catch(() => {});
    setTimeout(() => {
      if (!state.turn.isDone) state.turn.done({ type: "cancelled" });
      this.closeSessionObj(session);
    }, INTERRUPT_GRACE_MS);
  }

  /** Asks AgentHub about one tool call. Remembers the answer per tool-use id (hook and fallback). */
  private async gate(session: Session, name: string, input: unknown, toolUseId: string | undefined): Promise<{ allow: boolean; session?: boolean; reason?: string }> {
    const state = session.turn;
    if (!state || state.turn.isDone) return { allow: false, reason: "The turn has ended." };
    const id = toolUseId ?? randomUUID();
    // See SIDE_EFFECT_FREE_TOOLS (never in Ask: it has no tools at all).
    if (SIDE_EFFECT_FREE_TOOLS.has(name) && state.params.mode !== "ask") return { allow: true };
    const known = state.decided.get(id);
    if (known !== undefined) return known ? { allow: true } : { allow: false, reason: "Denied by AgentHub." };
    const key = grantKey(name, input, session.cwd);
    if (session.grants.has(key)) {
      state.decided.set(id, true);
      return { allow: true };
    }
    const decision = await state.turn.approval(id, permissionFor(name, input, session.cwd));
    switch (decision) {
      case "allow_once":
        state.decided.set(id, true);
        return { allow: true };
      case "allow_session":
        session.grants.add(key);
        state.decided.set(id, true);
        return { allow: true, session: true };
      case "cancel":
        state.decided.set(id, false);
        state.denied.add(id);
        state.turn.interrupt();
        return { allow: false, reason: "The user stopped this turn." };
      default:
        state.decided.set(id, false);
        state.denied.add(id);
        return { allow: false, reason: "AgentHub declined this (by mode, approval policy or the user's answer)." };
    }
  }

  // ---------- message stream ----------

  private async read(session: Session, sdk: { query: QueryFn }): Promise<void> {
    let error: unknown;
    try {
      for await (const msg of session.q) this.onMessage(session, msg);
    } catch (e) {
      error = e;
    }
    this.onEnd(session, sdk, error);
  }

  private onEnd(session: Session, sdk: { query: QueryFn }, error: unknown): void {
    const wasClosed = session.closed;
    session.closed = true;
    if (this.sessions.get(session.conversationId) === session) this.sessions.delete(session.conversationId);
    const state = session.turn;
    session.turn = undefined;
    if (!state || state.turn.isDone) return;
    if (state.turn.interrupted || wasClosed) {
      state.turn.done({ type: "cancelled" });
      return;
    }
    const detail = [error ? errorMessage(error) : "", ...session.stderr].join("\n");
    if (session.resumeId && !session.sawInit && /conversation|session|resume/i.test(detail)) {
      this.resumeFresh(session, sdk, state, truncate(redact(detail.split("\n").find((l) => /conversation|session|resume/i.test(l)) ?? detail, session.apiKey), 300));
      return;
    }
    const tail = session.stderr.slice(-3).join(" ").trim();
    state.turn.done(
      failed(
        "runtime_exited",
        `Claude Agent stopped unexpectedly${error ? `: ${truncate(redact(errorMessage(error), session.apiKey), 300)}` : "."}${tail ? ` ${truncate(tail, 300)}` : ""}`,
      ),
    );
  }

  /** The stored session couldn't be resumed: start a fresh one with the conversation as text. */
  private resumeFresh(old: Session, sdk: { query: QueryFn }, state: TurnState, message: string): void {
    const params = state.params;
    state.turn.emit({ type: "resumeFailed", message: message || "the session wasn't found" });
    const session = this.open(sdk, params, old.exe, old.sig, undefined);
    this.begin(session, params, state.turn, composePrompt(params.prompt, params.mode, params.handoff));
  }

  private onMessage(session: Session, msg: SDKMessage): void {
    const state = session.turn;
    const m = msg as any;
    if (m.type === "system" && m.subtype === "init") {
      session.sawInit = true;
      session.sessionId = typeof m.session_id === "string" ? m.session_id : session.sessionId;
      if (m.apiKeySource !== "ANTHROPIC_API_KEY") {
        if (state && !state.turn.isDone) {
          state.turn.done(
            failed(
              "invalid_key",
              `Claude Agent didn't use your Anthropic API key (credential source: ${String(m.apiKeySource ?? "unknown")}), so AgentHub stopped before sending anything. Check for Anthropic settings that override the key.`,
            ),
          );
        }
        session.turn = undefined;
        this.closeSessionObj(session);
        return;
      }
      if (state && !state.sessionEmitted && session.sessionId) {
        state.sessionEmitted = true;
        state.turn.emit({ type: "session", id: session.sessionId, resumed: Boolean(session.resumeId) });
      }
      return;
    }
    if (!state || state.turn.isDone) return;
    const turn = state.turn;
    switch (m.type) {
      case "stream_event": {
        if (m.parent_tool_use_id) return;
        const ev = m.event ?? {};
        if (ev.type === "message_start") {
          state.messageId = ev.message?.id;
        } else if (ev.type === "content_block_start") {
          state.blocks.set(ev.index, ev.content_block?.type);
        } else if (ev.type === "content_block_delta") {
          const d = ev.delta ?? {};
          if (d.type === "text_delta" && typeof d.text === "string" && d.text) {
            if (state.messageId) state.streamed.add(state.messageId);
            turn.emit({ type: "text", text: d.text });
          } else if (d.type === "thinking_delta" && typeof d.thinking === "string" && d.thinking) {
            if (state.messageId) state.streamed.add(state.messageId);
            turn.emit({ type: "thinking", text: d.thinking });
          }
        } else if (ev.type === "content_block_stop") {
          if (state.blocks.get(ev.index) === "text") turn.emit({ type: "textBreak" });
          state.blocks.delete(ev.index);
        }
        return;
      }
      case "assistant": {
        if (typeof m.error === "string") state.assistantError = m.error;
        const message = m.message ?? {};
        const streamed = message.id ? state.streamed.has(message.id) : false;
        const main = !m.parent_tool_use_id;
        for (const block of Array.isArray(message.content) ? message.content : []) {
          if (block?.type === "text" && main && !streamed && block.text) {
            turn.emit({ type: "text", text: block.text });
            turn.emit({ type: "textBreak" });
          } else if (block?.type === "thinking" && main && !streamed && block.thinking) {
            turn.emit({ type: "thinking", text: block.thinking });
          } else if (block?.type === "tool_use" && typeof block.id === "string") {
            const name = String(block.name ?? "");
            state.tools.set(block.id, { name, input: block.input });
            if (name === "TodoWrite") {
              const steps = planFrom(block.input);
              if (steps) turn.emit({ type: "plan", steps });
              continue;
            }
            const body = bodyFor(name, block.input, session.cwd);
            if (body) turn.emit({ type: "itemStarted", key: block.id, status: "running", body });
          }
        }
        return;
      }
      case "user": {
        const content = m.message?.content;
        if (!Array.isArray(content)) return;
        for (const block of content) {
          if (block?.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
          const call = state.tools.get(block.tool_use_id);
          if (!call || call.name === "TodoWrite") continue;
          const id = block.tool_use_id;
          const text = resultText(block.content);
          const status = state.denied.has(id) ? "declined" : block.is_error ? "failed" : "completed";
          const base = bodyFor(call.name, call.input, session.cwd);
          if (!base) continue;
          let body: ItemBody;
          if (base.kind === "command") {
            const r = m.tool_use_result;
            const structured = r && typeof r === "object" && typeof r.stdout === "string";
            const output = structured ? [r.stdout, r.stderr].filter((s: string) => s).join("\n") : text;
            const exitCode = status === "declined" ? undefined : block.is_error ? exitCodeOf(text) : r?.interrupted ? undefined : 0;
            body = { ...base, output, exitCode };
          } else {
            body = { ...base, result: text ? truncate(text, RESULT_MAX) : undefined };
          }
          turn.emit({ type: "itemUpdated", key: id, status, body });
        }
        return;
      }
      case "result": {
        this.onResult(session, state, m);
        return;
      }
      default:
        return;
    }
  }

  private onResult(session: Session, state: TurnState, m: any): void {
    const u = m.usage ?? {};
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
    const inputTokens = num(u.input_tokens) + num(u.cache_read_input_tokens) + num(u.cache_creation_input_tokens);
    let costUsd: number | undefined;
    if (typeof m.total_cost_usd === "number") {
      if (session.costBase !== undefined) costUsd = Math.max(0, m.total_cost_usd - session.costBase);
      session.costBase = m.total_cost_usd;
    }
    const usage = {
      inputTokens: inputTokens || undefined,
      outputTokens: typeof u.output_tokens === "number" ? u.output_tokens : undefined,
      costUsd,
    };
    if (usage.inputTokens !== undefined || usage.outputTokens !== undefined || usage.costUsd !== undefined) {
      state.turn.emit({ type: "usage", usage });
    }
    session.turn = undefined;
    let outcome: Outcome;
    if (state.turn.interrupted) {
      outcome = { type: "cancelled" };
    } else if (m.subtype === "success" && !m.is_error) {
      outcome = { type: "completed" };
    } else {
      const kind = errorKindFor(state.assistantError);
      const raw =
        m.subtype === "success"
          ? String(m.result ?? "")
          : Array.isArray(m.errors) && m.errors.length
            ? m.errors.join("; ")
            : m.subtype === "error_max_turns"
              ? "Claude Agent hit its turn limit."
              : m.subtype === "error_max_budget_usd"
                ? "Claude Agent hit its budget limit."
                : "Claude Agent stopped with an error.";
      const message = kind === "not_signed_in" ? `${NOT_SIGNED_IN} (${truncate(redact(raw, session.apiKey), 200)})` : truncate(redact(raw, session.apiKey), 500);
      outcome = failed(kind, message || "Claude Agent stopped with an error.");
    }
    state.turn.done(outcome);
    if (state.turn.interrupted) this.closeSessionObj(session);
  }

  // ---------- lifecycle ----------

  private closeSessionObj(session: Session): void {
    if (session.closed) return;
    session.closed = true;
    if (this.sessions.get(session.conversationId) === session) this.sessions.delete(session.conversationId);
    session.input.end();
    try {
      session.q.close();
    } catch {
      // already gone
    }
  }

  async closeSession(conversationId: string): Promise<void> {
    const s = this.sessions.get(conversationId);
    if (!s) return;
    const state = s.turn;
    this.closeSessionObj(s);
    if (state && !state.turn.isDone) state.turn.done({ type: "cancelled" });
  }

  async shutdown(): Promise<void> {
    for (const id of [...this.sessions.keys()]) await this.closeSession(id);
  }
}
