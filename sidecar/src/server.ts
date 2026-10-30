// The sidecar's JSON-RPC surface (see `src-tauri/src/chat/agents/sidecar.rs`).

import type { Engine } from "./engine.js";
import { errorMessage, log, withTimeout } from "./engine.js";
import type { EngineId, ImageInput, Mode, TurnStartParams } from "./protocol.js";
import { failed, IMAGE_TYPES, MAX_IMAGES, redact } from "./protocol.js";
import { type Rpc, RpcError } from "./rpc.js";
import { Turn } from "./turn.js";

declare const __SIDECAR_VERSION__: string;
export const VERSION = typeof __SIDECAR_VERSION__ === "string" ? __SIDECAR_VERSION__ : "0.0.0-dev";

const ENGINES: readonly EngineId[] = ["claude-code", "copilot-cli"];
const MODES: readonly Mode[] = ["ask", "plan", "agent"];

function invalid(message: string): RpcError {
  return new RpcError(-32602, message);
}

function optString(v: unknown, name: string): string | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string") throw invalid(`${name} must be a string`);
  return v;
}

function reqString(v: unknown, name: string): string {
  if (typeof v !== "string" || v.length === 0) throw invalid(`${name} is required`);
  return v;
}

function parseImages(v: unknown): ImageInput[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > MAX_IMAGES) throw invalid("images");
  return v.map((i) => {
    if (!IMAGE_TYPES.includes(i?.mimeType) || typeof i?.data !== "string" || !i.data) throw invalid("images");
    return { mimeType: i.mimeType, data: i.data };
  });
}

export function parseTurnStart(p: any): TurnStartParams {
  const engine = p?.engine;
  if (!ENGINES.includes(engine)) throw invalid("unknown engine");
  const mode = p?.mode;
  if (!MODES.includes(mode)) throw invalid("unknown mode");
  return {
    turnId: reqString(p.turnId, "turnId"),
    conversationId: reqString(p.conversationId, "conversationId"),
    engine,
    model: optString(p.model, "model") ?? "default",
    mode,
    cwd: reqString(p.cwd, "cwd"),
    prompt: typeof p.prompt === "string" ? p.prompt : "",
    images: parseImages(p.images),
    sessionId: optString(p.sessionId, "sessionId"),
    handoff: optString(p.handoff, "handoff"),
    reconfigure: p.reconfigure === true,
    executable: optString(p.executable, "executable"),
    apiKey: optString(p.apiKey, "apiKey"),
  };
}

export interface ServerOptions {
  engines: Record<EngineId, Engine>;
  exit: (code: number) => void;
}

export function serve(rpc: Rpc, opts: ServerOptions): { turns: Map<string, Turn> } {
  const turns = new Map<string, Turn>();
  const byConversation = new Map<string, Turn>();
  const engineOf = (id: unknown): Engine => {
    if (!ENGINES.includes(id as EngineId)) throw invalid("unknown engine");
    return opts.engines[id as EngineId];
  };
  let shuttingDown = false;
  const shutdownAll = async () => {
    for (const t of turns.values()) t.interrupt();
    await withTimeout(Promise.all(Object.values(opts.engines).map((e) => e.shutdown().catch(() => undefined))), 3000, () => []);
  };

  rpc.on("initialize", () => ({ version: VERSION, node: process.versions.node }));

  rpc.on("probe", async (p: any) => {
    const engine = engineOf(p?.engine);
    try {
      return await engine.probe(optString(p?.executable, "executable"));
    } catch (e) {
      return { state: "error", message: redact(errorMessage(e)), models: [] };
    }
  });

  rpc.on("turn/start", (p: any) => {
    if (shuttingDown) throw new RpcError(-32000, "The sidecar is shutting down");
    const params = parseTurnStart(p);
    if (turns.has(params.turnId)) throw invalid("turn already started");
    const engine = engineOf(params.engine);
    const turn = new Turn(params.turnId, params.conversationId, rpc);
    turns.set(params.turnId, turn);
    turn.onDone(() => {
      turns.delete(params.turnId);
      if (byConversation.get(params.conversationId) === turn) byConversation.delete(params.conversationId);
    });
    const busy = byConversation.get(params.conversationId);
    if (busy && !busy.isDone) {
      // Accepted, then failed: AgentHub runs one turn per conversation.
      queueMicrotask(() => turn.done(failed("invalid_request", "This conversation already has a turn running.")));
      return {};
    }
    byConversation.set(params.conversationId, turn);
    // Answer first, then run: the turn's events follow the response.
    setImmediate(() => {
      try {
        engine.startTurn(params, turn);
      } catch (e) {
        turn.done(failed("provider_error", redact(errorMessage(e), params.apiKey)));
      }
    });
    return {};
  });

  rpc.on("turn/interrupt", (p: any) => {
    turns.get(String(p?.turnId ?? ""))?.interrupt();
    return {};
  });

  rpc.on("session/close", async (p: any) => {
    const id = reqString(p?.conversationId, "conversationId");
    await Promise.all(Object.values(opts.engines).map((e) => e.closeSession(id).catch(() => undefined)));
    return {};
  });

  rpc.on("shutdown", async () => {
    shuttingDown = true;
    await shutdownAll();
    setTimeout(() => opts.exit(0), 50);
    return {};
  });

  rpc.onClose(() => {
    // AgentHub is gone: nobody can answer approvals or read events.
    log("connection closed; shutting down");
    shuttingDown = true;
    void shutdownAll().finally(() => opts.exit(0));
  });

  return { turns };
}
