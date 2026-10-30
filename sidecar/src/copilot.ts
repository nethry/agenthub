// Copilot engine on the GitHub Copilot SDK: one CopilotClient per sidecar,
// one session per conversation. Uses the user's own Copilot login.

import { randomUUID } from "node:crypto";
import type { CopilotClient, CopilotSession, PermissionRequestResult, SessionConfig } from "@github/copilot-sdk";
import { PLAN_TOOLS, PLAN_TOOL_NAMES, copilotBody, copilotPermission } from "./copilot-tools.js";
import { type Engine, errorMessage, log, withTimeout } from "./engine.js";
import { isFile, isShellShim, isVsCodeCopilotShim, which as defaultWhich } from "./exe.js";
import { type ErrorKind, type ItemBody, type ModelInfo, type ProbeResult, type TurnStartParams, composePrompt, failed, redact, truncate } from "./protocol.js";
import type { Turn } from "./turn.js";

export interface CopilotSdk {
  CopilotClient: new (options: any) => CopilotClient;
  RuntimeConnection: { forStdio(opts?: { path?: string }): unknown };
}

export interface CopilotDeps {
  loadSdk(): Promise<CopilotSdk>;
  which(name: string): string | undefined;
}

export const NOT_SIGNED_IN = "Copilot CLI isn't signed in. Run `copilot` in a terminal and use /login, then recheck.";
const START_TIMEOUT_MS = 60_000;
const INTERRUPT_GRACE_MS = 5000;
const RESULT_MAX = 2000;

export function defaultCopilotDeps(): CopilotDeps {
  return {
    loadSdk: () => import("@github/copilot-sdk") as unknown as Promise<CopilotSdk>,
    which: (n) => defaultWhich(n),
  };
}

type Runtime = { path?: string } | { error: string };

/** The runtime to start: an override, a real Copilot CLI on PATH, or the SDK's bundled one. */
export function resolveRuntime(executable: string | undefined, which: (n: string) => string | undefined): Runtime {
  if (executable) {
    if (!isFile(executable)) return { error: `${executable} wasn't found.` };
    if (isShellShim(executable)) return { error: `${executable} is a script shim; point AgentHub at the Copilot CLI executable instead.` };
    if (isVsCodeCopilotShim(executable)) return { error: `${executable} is VS Code's Copilot shim, not the Copilot CLI.` };
    return { path: executable };
  }
  const found = which("copilot");
  return found && !isVsCodeCopilotShim(found) ? { path: found } : {};
}

export function errorKindFor(errorType: string | undefined): ErrorKind {
  switch (errorType) {
    case "rate_limit":
    case "quota":
      return "rate_limited";
    case "authentication":
    case "authorization":
      return "not_signed_in";
    case "context_limit":
      return "context_too_long";
    default:
      return "provider_error";
  }
}

function authLabel(type: string | undefined): string {
  switch (type) {
    case "user":
      return "GitHub login";
    case "gh-cli":
      return "GitHub CLI login";
    case "env":
      return "Token from the environment";
    case "api-key":
      return "API key";
    default:
      return type ? `Signed in (${type})` : "Signed in";
  }
}

interface TurnState {
  turn: Turn;
  streamed: Set<string>;
  started: Map<string, ItemBody>;
  denied: Set<string>;
  input: number;
  output: number;
  active: boolean;
}

interface Holder {
  conversationId: string;
  sig: string;
  mode: TurnStartParams["mode"];
  cwd: string;
  session?: CopilotSession;
  sessionId?: string;
  unsubscribe?: () => void;
  turn?: TurnState;
  closed: boolean;
}

const ACTIVITY = new Set(["user.message", "assistant.turn_start", "assistant.message", "assistant.message_delta", "tool.execution_start", "session.error"]);

export class CopilotEngine implements Engine {
  private client?: { path?: string; client: CopilotClient; ready: Promise<void> };
  private sessions = new Map<string, Holder>();

  constructor(private readonly deps: CopilotDeps = defaultCopilotDeps()) {}

  private newClient(sdk: CopilotSdk, path: string | undefined): CopilotClient {
    return new sdk.CopilotClient({
      connection: path ? sdk.RuntimeConnection.forStdio({ path }) : undefined,
      logLevel: "error",
      useLoggedInUser: true,
      clientInfo: { applicationName: "AgentHub", applicationVersion: "0.1.0" },
    });
  }

  // ---------- probe ----------

  async probe(executable?: string): Promise<ProbeResult> {
    let sdk: CopilotSdk;
    try {
      sdk = await this.deps.loadSdk();
    } catch {
      return { state: "error", message: "The GitHub Copilot SDK isn't installed in the sidecar. Run `pnpm install`, then rebuild the sidecar.", models: [] };
    }
    const rt = resolveRuntime(executable, this.deps.which);
    if ("error" in rt) return { state: "not_found", message: rt.error, models: [] };
    const client = this.newClient(sdk, rt.path);
    try {
      await withTimeout(client.start(), START_TIMEOUT_MS, () => {
        throw new Error("timed out");
      });
    } catch (e) {
      void client.forceStop().catch(() => {});
      return { state: rt.path ? "error" : "not_found", path: rt.path, message: `Copilot CLI couldn't start: ${truncate(redact(errorMessage(e)), 300)}`, models: [] };
    }
    try {
      const status = await client.getStatus().catch(() => undefined);
      const auth = await client.getAuthStatus();
      const base = { path: rt.path, version: status?.version, message: rt.path ? undefined : "Using the Copilot runtime bundled with the SDK." };
      if (!auth.isAuthenticated) return { ...base, state: "sign_in_needed", message: NOT_SIGNED_IN, models: [] };
      const account = auth.login ? `${authLabel(auth.authType)}: ${auth.login}` : authLabel(auth.authType);
      let models: ModelInfo[] = [];
      try {
        const list = await client.listModels();
        models = [
          { id: "default", label: "Default", isDefault: true },
          ...list.filter((m) => m?.id && m.policy?.state !== "disabled").map((m) => ({ id: m.id, label: m.name || m.id, isDefault: false })),
        ];
      } catch {
        models = [];
      }
      return { ...base, state: "ready", account, models };
    } catch (e) {
      return { state: "error", path: rt.path, message: `Copilot CLI didn't answer: ${truncate(redact(errorMessage(e)), 300)}`, models: [] };
    } finally {
      await withTimeout(client.stop().then(() => undefined), 5000, () => undefined).catch(() => undefined);
    }
  }

  // ---------- turns ----------

  startTurn(params: TurnStartParams, turn: Turn): void {
    this.run(params, turn).catch((e) => {
      log(`copilot: turn failed (${truncate(redact(errorMessage(e)), 200)})`);
      this.client = undefined;
      turn.done(failed("runtime_exited", `Copilot CLI stopped: ${truncate(redact(errorMessage(e)), 300)}`));
    });
  }

  private async getClient(sdk: CopilotSdk, path: string | undefined): Promise<CopilotClient> {
    if (this.client && this.client.path !== path) {
      const old = this.client;
      this.client = undefined;
      for (const h of [...this.sessions.values()]) await this.closeHolder(h);
      await old.client.stop().catch(() => undefined);
    }
    if (!this.client) {
      const client = this.newClient(sdk, path);
      const ready = withTimeout(client.start(), START_TIMEOUT_MS, () => {
        throw new Error("timed out");
      });
      this.client = { path, client, ready };
      ready.catch(() => {
        if (this.client?.client === client) this.client = undefined;
      });
    }
    await this.client.ready;
    return this.client.client;
  }

  private async run(params: TurnStartParams, turn: Turn): Promise<void> {
    let sdk: CopilotSdk;
    try {
      sdk = await this.deps.loadSdk();
    } catch {
      turn.done(failed("engine_not_found", "The GitHub Copilot SDK isn't installed in the sidecar. Run `pnpm install`, then rebuild the sidecar."));
      return;
    }
    const rt = resolveRuntime(params.executable, this.deps.which);
    if ("error" in rt) {
      turn.done(failed("engine_not_found", rt.error));
      return;
    }
    let client: CopilotClient;
    try {
      client = await this.getClient(sdk, rt.path);
    } catch (e) {
      turn.done(failed("engine_not_found", `Copilot CLI couldn't start: ${truncate(redact(errorMessage(e)), 300)}`));
      return;
    }
    const auth = await client.getAuthStatus().catch(() => undefined);
    if (!auth?.isAuthenticated) {
      turn.done(failed("not_signed_in", NOT_SIGNED_IN));
      return;
    }
    if (turn.isDone) return;

    const sig = JSON.stringify([params.mode, params.model, params.cwd]);
    let holder = this.sessions.get(params.conversationId);
    let resumeId = params.sessionId;
    if (holder && (params.reconfigure || holder.sig !== sig || holder.turn || holder.closed)) {
      resumeId = holder.sessionId ?? resumeId;
      await this.closeHolder(holder);
      holder = undefined;
    }
    let prompt = composePrompt(params.prompt, params.mode);
    if (!holder) {
      const h: Holder = { conversationId: params.conversationId, sig, mode: params.mode, cwd: params.cwd, closed: false };
      const config = this.config(params, h);
      let session: CopilotSession | undefined;
      let resumeError: string | undefined;
      if (resumeId) {
        try {
          session = await client.resumeSession(resumeId, config);
        } catch (e) {
          resumeError = truncate(redact(errorMessage(e)), 300) || "the session wasn't found";
        }
      }
      if (!session) session = await client.createSession({ ...config, trustWorkingDirectory: "session" } as SessionConfig);
      h.session = session;
      h.sessionId = session.sessionId;
      h.unsubscribe = session.on((ev: any) => this.onEvent(h, ev));
      this.sessions.set(params.conversationId, h);
      holder = h;
      if (resumeError) {
        turn.emit({ type: "resumeFailed", message: resumeError });
        prompt = composePrompt(params.prompt, params.mode, params.handoff);
      }
      turn.emit({ type: "session", id: session.sessionId, resumed: Boolean(resumeId) && !resumeError });
    } else if (holder.sessionId) {
      turn.emit({ type: "session", id: holder.sessionId, resumed: true });
    }
    if (turn.isDone) return;
    const h = holder;
    const state: TurnState = { turn, streamed: new Set(), started: new Map(), denied: new Set(), input: 0, output: 0, active: false };
    h.turn = state;
    turn.onInterrupt = () => {
      void h.session?.abort().catch(() => undefined);
      setTimeout(() => {
        if (!state.turn.isDone) state.turn.done({ type: "cancelled" });
        if (h.turn === state) h.turn = undefined;
      }, INTERRUPT_GRACE_MS);
    };
    try {
      // Pasted images go as blob attachments, so Copilot reads no file outside the project.
      const attachments = (params.images ?? []).map((i, n) => ({ type: "blob" as const, data: i.data, mimeType: i.mimeType, displayName: `image-${n + 1}` }));
      await h.session!.send(attachments.length ? { prompt, attachments } : { prompt });
      state.active = true;
    } catch (e) {
      if (h.turn === state) h.turn = undefined;
      await this.closeHolder(h);
      this.client = undefined;
      turn.done(failed("runtime_exited", `Copilot CLI didn't accept the message: ${truncate(redact(errorMessage(e)), 300)}`));
    }
  }

  private config(params: TurnStartParams, h: Holder): SessionConfig {
    const config: SessionConfig = {
      model: params.model && params.model !== "default" ? params.model : undefined,
      streaming: true,
      workingDirectory: params.cwd,
      clientName: "AgentHub",
      onPermissionRequest: (req: any) => this.permission(h, req),
      hooks: {
        onPreToolUse: async (input: any) => {
          if (h.mode === "ask") return { permissionDecision: "deny", permissionDecisionReason: "Ask mode has no file or tool access." };
          if (h.mode === "plan" && !PLAN_TOOL_NAMES.includes(String(input?.toolName))) {
            return { permissionDecision: "deny", permissionDecisionReason: "Plan mode is read-only: no edits, commands or network." };
          }
          return undefined;
        },
      },
    };
    if (params.mode === "ask") config.availableTools = [];
    if (params.mode === "plan") config.availableTools = [...PLAN_TOOLS];
    return config;
  }

  private async permission(h: Holder, req: any): Promise<PermissionRequestResult> {
    const state = h.turn;
    if (!state || state.turn.isDone) return { kind: "reject", feedback: "The turn has ended." } as PermissionRequestResult;
    const id = typeof req?.toolCallId === "string" ? req.toolCallId : randomUUID();
    const reject = (feedback: string) => {
      state.denied.add(id);
      return { kind: "reject", feedback } as PermissionRequestResult;
    };
    if (h.mode === "ask") return reject("Ask mode has no file or tool access.");
    const mapped = copilotPermission(req, h.cwd);
    if (h.mode === "plan" && mapped.request.kind !== "read") return reject("Plan mode is read-only: no edits, commands, URLs or MCP tools.");
    const decision = await state.turn.approval(id, mapped.request);
    switch (decision) {
      case "allow_once":
        return { kind: "approve-once" } as PermissionRequestResult;
      case "allow_session":
        return (mapped.session && mapped.request.canAllowSession ? { kind: "approve-for-session", ...mapped.session } : { kind: "approve-once" }) as PermissionRequestResult;
      case "cancel":
        state.denied.add(id);
        state.turn.interrupt();
        return { kind: "reject", feedback: "The user stopped this turn." } as PermissionRequestResult;
      default:
        return reject("AgentHub declined this (by mode, approval policy or the user's answer).");
    }
  }

  private onEvent(h: Holder, ev: any): void {
    const state = h.turn;
    if (!state || state.turn.isDone) return;
    const turn = state.turn;
    const d = ev?.data ?? {};
    if (ACTIVITY.has(ev?.type)) state.active = true;
    switch (ev?.type) {
      case "assistant.message_delta":
        if (d.parentToolCallId || typeof d.deltaContent !== "string" || !d.deltaContent) return;
        state.streamed.add(d.messageId);
        turn.emit({ type: "text", text: d.deltaContent });
        return;
      case "assistant.message":
        if (d.parentToolCallId) return;
        if (!state.streamed.has(d.messageId) && typeof d.content === "string" && d.content) turn.emit({ type: "text", text: d.content });
        turn.emit({ type: "textBreak" });
        return;
      case "assistant.reasoning_delta":
        if (typeof d.deltaContent === "string" && d.deltaContent) turn.emit({ type: "thinking", text: d.deltaContent });
        return;
      case "tool.execution_start": {
        if (typeof d.toolCallId !== "string") return;
        const body = copilotBody(d, h.cwd);
        state.started.set(d.toolCallId, body);
        turn.emit({ type: "itemStarted", key: d.toolCallId, status: "running", body });
        return;
      }
      case "tool.shell_output":
        if (typeof d.toolCallId === "string" && typeof d.text === "string" && d.text) turn.emit({ type: "output", key: d.toolCallId, text: d.text });
        return;
      case "tool.execution_complete": {
        if (typeof d.toolCallId !== "string") return;
        const base = state.started.get(d.toolCallId) ?? copilotBody(d, h.cwd);
        const code = String(d.error?.code ?? "");
        const status = state.denied.has(d.toolCallId) || code === "rejected" || code === "denied" ? "declined" : d.success ? "completed" : "failed";
        const text = typeof d.result?.content === "string" ? d.result.content : typeof d.error?.message === "string" ? d.error.message : "";
        const body: ItemBody =
          base.kind === "command"
            ? { ...base, output: text, exitCode: typeof d.shellExecution?.exitCode === "number" ? d.shellExecution.exitCode : undefined }
            : { ...base, result: text ? truncate(text, RESULT_MAX) : undefined };
        turn.emit({ type: "itemUpdated", key: d.toolCallId, status, body });
        return;
      }
      case "assistant.usage": {
        if (typeof d.inputTokens === "number") state.input += d.inputTokens;
        if (typeof d.outputTokens === "number") state.output += d.outputTokens;
        // `cost` is a premium-request multiplier, not dollars: never reported as cost.
        turn.emit({ type: "usage", usage: { inputTokens: state.input || undefined, outputTokens: state.output || undefined } });
        return;
      }
      case "session.error": {
        const kind = errorKindFor(d.errorType);
        const message = kind === "not_signed_in" ? NOT_SIGNED_IN : truncate(redact(String(d.message ?? "Copilot reported an error.")), 500);
        h.turn = undefined;
        turn.done(failed(kind, message));
        return;
      }
      case "session.idle":
        if (!state.active) return;
        h.turn = undefined;
        turn.done(turn.interrupted || d.aborted ? { type: "cancelled" } : { type: "completed" });
        return;
      default:
        return;
    }
  }

  private async closeHolder(h: Holder): Promise<void> {
    if (h.closed) return;
    h.closed = true;
    if (this.sessions.get(h.conversationId) === h) this.sessions.delete(h.conversationId);
    const state = h.turn;
    h.turn = undefined;
    if (state && !state.turn.isDone) state.turn.done({ type: "cancelled" });
    try {
      h.unsubscribe?.();
    } catch {
      // ignore
    }
    await h.session?.disconnect().catch(() => undefined);
  }

  async closeSession(conversationId: string): Promise<void> {
    const h = this.sessions.get(conversationId);
    if (h) await this.closeHolder(h);
  }

  async shutdown(): Promise<void> {
    for (const h of [...this.sessions.values()]) await this.closeHolder(h);
    const c = this.client;
    this.client = undefined;
    if (c) await withTimeout(c.client.stop().then(() => undefined), 3000, () => undefined).catch(() => undefined);
  }
}
