// Engine/model catalog and pure display helpers for Chat (no React, no IPC).
import type {
  ApprovalPolicy,
  ChatError,
  ChatErrorKind,
  ChatMode,
  ChatPrefs,
  ChatProvider,
  Conversation,
  ConversationStatus,
  EngineId,
  EngineInfo,
  ProbeState,
  ProviderStatus,
  Usage,
} from "@/lib/types";

export interface ModelChoice {
  id: string;
  label: string;
  hint?: string;
}

export const AGENT_ENGINES: EngineId[] = ["claude-code", "codex", "gemini-cli", "antigravity", "copilot-cli"];
export const API_ENGINES: EngineId[] = ["openai-api", "anthropic-api", "gemini-api"];
export const ENGINE_ORDER: EngineId[] = [...AGENT_ENGINES, ...API_ENGINES];

export const ENGINE_LABEL: Record<EngineId, string> = {
  "claude-code": "Claude Agent",
  codex: "OpenAI Codex",
  "gemini-cli": "Gemini CLI",
  antigravity: "Antigravity",
  "copilot-cli": "Copilot CLI",
  "openai-api": "OpenAI API",
  "anthropic-api": "Anthropic API",
  "gemini-api": "Gemini API",
};

/** How the engine runs, for the engine menu and settings. */
export const ENGINE_VIA: Record<EngineId, string> = {
  "claude-code": "CLAUDE AGENT SDK · API KEY",
  codex: "CLI · codex app-server",
  "gemini-cli": "CLI · gemini --acp · API KEY",
  antigravity: "ACP SERVER · GOOGLE ACCOUNT",
  "copilot-cli": "COPILOT SDK · CLI LOGIN",
  "openai-api": "API KEY · CREDENTIAL MANAGER",
  "anthropic-api": "API KEY · CREDENTIAL MANAGER",
  "gemini-api": "API KEY · CREDENTIAL MANAGER",
};

export const ENGINE_PROVIDER: Partial<Record<EngineId, ChatProvider>> = {
  "openai-api": "openai",
  "anthropic-api": "anthropic",
  "gemini-api": "gemini",
};

export const PROVIDER_LABEL: Record<ChatProvider, string> = { anthropic: "Anthropic", openai: "OpenAI", gemini: "Gemini" };
export const PROVIDER_ORDER: ChatProvider[] = ["anthropic", "openai", "gemini"];

export const isAgent = (e: EngineId) => AGENT_ENGINES.includes(e);

const CLAUDE_MODELS: ModelChoice[] = [
  { id: "claude-opus-5-5", label: "Claude Opus 5.5", hint: "Deep reasoning" },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", hint: "Fast and capable" },
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5", hint: "Fastest, lowest cost" },
  { id: "claude-fable-5-1", label: "Claude Fable 5.1", hint: "Most capable, highest cost" },
];
const GPT_MODELS: ModelChoice[] = [
  { id: "gpt-6.1-sol", label: "GPT-6.1 Sol", hint: "Strong reasoning at lower cost" },
  { id: "gpt-6-astra", label: "GPT-6 Astra", hint: "Most capable" },
  { id: "gpt-6-luna", label: "GPT-6 Luna", hint: "Fastest, lowest cost" },
];
const GEMINI_MODELS: ModelChoice[] = [
  { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash", hint: "Fast, recommended" },
  { id: "gemini-4-argon", label: "Gemini 4 Argon", hint: "Flagship reasoning" },
  { id: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash-Lite", hint: "Lowest cost" },
];

/**
 * Built-in choices (October 2026) used until a probe or the provider lists
 * real models. Any other model ID can be typed, so a newer model never needs
 * an app update.
 */
export const MODELS: Record<EngineId, ModelChoice[]> = {
  "claude-code": CLAUDE_MODELS,
  codex: GPT_MODELS,
  "gemini-cli": GEMINI_MODELS,
  antigravity: [{ id: "default", label: "Default model", hint: "Antigravity's own default" }],
  "copilot-cli": [{ id: "default", label: "Default model", hint: "Copilot's own default" }],
  "openai-api": GPT_MODELS,
  "anthropic-api": CLAUDE_MODELS,
  "gemini-api": GEMINI_MODELS,
};

export const DEFAULT_MODEL: Record<EngineId, string> = {
  "claude-code": "claude-opus-5-5",
  codex: "gpt-6.1-sol",
  "gemini-cli": "gemini-3.8-flash",
  antigravity: "default",
  "copilot-cli": "default",
  "openai-api": "gpt-6.1-sol",
  "anthropic-api": "claude-opus-5-5",
  "gemini-api": "gemini-3.8-flash",
};

export function modelLabel(id: string): string {
  if (id === "default") return "Default model";
  for (const list of Object.values(MODELS)) {
    const m = list.find((x) => x.id === id);
    if (m) return m.label;
  }
  return id;
}

/** Compact readout: `OPUS 5.5`, `GPT-6.1 SOL`, or the raw ID. */
export function shortModelLabel(id: string): string {
  return modelLabel(id).replace(/^Claude /, "").toUpperCase();
}

/** Models for an engine: what the runtime reported, else the catalog, plus custom IDs. */
export function modelsFor(engine: EngineId, info: EngineInfo | undefined, prefs: ChatPrefs): ModelChoice[] {
  const probed = info?.probe.models ?? [];
  const base: ModelChoice[] = probed.length ? probed.map((m) => ({ id: m.id, label: m.label || modelLabel(m.id) })) : MODELS[engine];
  const custom = (prefs.customModels[engine] ?? [])
    .filter((id) => !base.some((m) => m.id === id))
    .map((id) => ({ id, label: id, hint: "Custom model ID" }));
  return [...base, ...custom];
}

export function defaultModelFor(engine: EngineId, info: EngineInfo | undefined, prefs: ChatPrefs): string {
  const saved = prefs.models[engine];
  if (saved) return saved;
  const probed = info?.probe.models.find((m) => m.isDefault)?.id;
  return probed ?? DEFAULT_MODEL[engine];
}

export const MODEL_ID_RE = /^[A-Za-z0-9._:/@[\]-]{1,128}$/;

export function isValidModelId(id: string): boolean {
  return MODEL_ID_RE.test(id.trim());
}

// ---------- modes & policy ----------

export const MODE_ORDER: ChatMode[] = ["ask", "plan", "agent"];
/** Project chats are coding agents in Plan or Agent; General chats are direct APIs in Ask. */
export const AGENT_MODES: ChatMode[] = ["plan", "agent"];

export const chatModes = (inProject: boolean): ChatMode[] => (inProject ? AGENT_MODES : ["ask"]);
/** Engines offered for new chats in a project, or in General. */
export const chatEngines = (inProject: boolean): EngineId[] => (inProject ? AGENT_ENGINES : API_ENGINES);

export const MODE_META: Record<ChatMode, { label: string; color: string; tone: string; hint: string }> = {
  ask: { label: "Ask", color: "var(--color-ask)", tone: "accent", hint: "ANSWERS ONLY · NO FILE OR TOOL ACCESS" },
  plan: { label: "Plan", color: "var(--color-plan)", tone: "plan", hint: "READS PROJECT FILES · NO EDITS OR COMMANDS" },
  agent: { label: "Agent", color: "var(--color-agent)", tone: "agent", hint: "EDITS FILES · RUNS TOOLS WITH YOUR APPROVAL" },
};

export const POLICY_ORDER: ApprovalPolicy[] = ["ask", "auto_edits", "auto_all"];

export const POLICY_LABEL: Record<ApprovalPolicy, string> = {
  ask: "Ask before edits & commands",
  auto_edits: "Auto-approve edits · ask for commands",
  auto_all: "Auto-approve all in this project",
};

export const POLICY_HINT: Record<ApprovalPolicy, string> = {
  ask: "Recommended. Every write and command shows an inline approval.",
  auto_edits: "Edits inside the project are allowed and checkpointed, so you can revert them. Commands still ask.",
  auto_all: "Edits and commands inside the project are allowed. Deletes, pushes, network installs and anything outside the project still ask.",
};

/** Whether `mode` can be used with `engine` (and in General), with the reason when not. */
export function modeAvailability(
  engine: EngineId,
  mode: ChatMode,
  info: EngineInfo | undefined,
  inProject: boolean,
): { ok: true } | { ok: false; reason: string } {
  if (isAgent(engine) && !inProject) return { ok: false, reason: "Coding agents work inside a project." };
  if (inProject && !isAgent(engine)) return { ok: false, reason: "Project chats use a coding agent. Use Ask for direct APIs." };
  if (inProject && mode === "ask") return { ok: false, reason: "Project chats use Plan or Agent. Use Ask for quick questions." };
  const caps = info?.capabilities;
  if (caps && !caps.modes.includes(mode)) {
    const reason = caps.unsupported.find(([m]) => m === mode)?.[1] ?? `${ENGINE_LABEL[engine]} doesn't support ${MODE_META[mode].label}.`;
    return { ok: false, reason };
  }
  if (!caps && !isAgent(engine) && mode !== "ask") return { ok: false, reason: "Direct APIs answer questions only." };
  return { ok: true };
}

/** The first mode the engine supports, keeping `preferred` when possible. */
export function fitMode(engine: EngineId, preferred: ChatMode, info: EngineInfo | undefined, inProject: boolean): ChatMode {
  if (modeAvailability(engine, preferred, info, inProject).ok) return preferred;
  return MODE_ORDER.find((m) => modeAvailability(engine, m, info, inProject).ok) ?? "ask";
}

/** Going to Agent mode always needs the user's explicit confirmation. */
export function needsModeConfirm(from: ChatMode, to: ChatMode): boolean {
  return to === "agent" && from !== "agent";
}

// ---------- engine availability ----------

export const PROBE_LABEL: Record<ProbeState, string> = {
  ready: "READY",
  not_found: "NOT FOUND",
  sign_in_needed: "SIGN IN",
  key_missing: "NO KEY",
  key_invalid: "KEY INVALID",
  error: "ERROR",
  unknown: "CHECKING…",
};

export const PROBE_TONE: Record<ProbeState, "run" | "warn" | "danger" | "muted"> = {
  ready: "run",
  not_found: "danger",
  sign_in_needed: "warn",
  key_missing: "warn",
  key_invalid: "danger",
  error: "danger",
  unknown: "muted",
};

/** Whether an integration is turned on; unknown (engines not loaded yet) counts as on. */
export function engineOn(engines: EngineInfo[], engine: EngineId): boolean {
  return engines.find((e) => e.engine === engine)?.enabled ?? true;
}

/** Conversations of integrations that are turned on; the others stay stored but hidden. */
export function visibleConversations(list: Conversation[], engines: EngineInfo[]): Conversation[] {
  return list.filter((c) => engineOn(engines, c.engine));
}

/** A direct-API engine is ready with a key that wasn't rejected. */
export function providerReady(status: ProviderStatus | undefined): boolean {
  return !!status?.hasKey && status.state !== "invalid";
}

/**
 * Engine for a new chat: the default for the workspace kind when usable,
 * else the first ready engine that fits (agents in projects, APIs in
 * General). Turned-off engines are skipped; with all of them off it's the
 * default, which the composer then reports as turned off.
 */
export function newChatEngine(prefs: ChatPrefs, engines: EngineInfo[], inProject: boolean): EngineId {
  const pool = chatEngines(inProject);
  const allowed = pool.filter((e) => engineOn(engines, e));
  const preferred = inProject ? prefs.defaultEngine : prefs.defaultGeneralEngine;
  const state = (e: EngineId) => engines.find((x) => x.engine === e)?.probe.state;
  if (allowed.includes(preferred) && (state(preferred) === "ready" || state(preferred) === undefined)) return preferred;
  return (
    allowed.find((e) => state(e) === "ready") ??
    (allowed.includes(preferred) ? preferred : (allowed[0] ?? (pool.includes(preferred) ? preferred : pool[0])))
  );
}

// ---------- status chips ----------

/** A theme colour token at `pct`% opacity, for inline styles. */
export function tint(token: string, pct: number): string {
  return `color-mix(in srgb, var(--color-${token}) ${pct}%, transparent)`;
}

export type ChipKind = "streaming" | "running" | "approval" | "interrupted" | "error" | "stopped" | "done";

export const CHIP: Record<ChipKind, { label: string; color: string; border: string; live: boolean }> = {
  streaming: { label: "Streaming", color: "var(--color-accent)", border: tint("accent", 50), live: true },
  running: { label: "Running", color: "var(--color-agent)", border: tint("agent", 50), live: true },
  approval: { label: "Approve", color: "var(--color-warn)", border: tint("warn", 55), live: false },
  interrupted: { label: "Interrupted", color: "var(--color-warn)", border: tint("warn", 55), live: false },
  error: { label: "Error", color: "var(--color-danger)", border: tint("danger", 55), live: false },
  stopped: { label: "Stopped", color: "var(--color-muted)", border: "var(--color-line-strong)", live: false },
  done: { label: "Done", color: "var(--color-run)", border: tint("run", 45), live: false },
};

/** Chip for a conversation; `null` when it's idle. Done only shows for agents. */
export function statusChip(c: Pick<Conversation, "engine" | "status">, running: boolean): ChipKind | null {
  if (running || c.status === "running") return isAgent(c.engine) ? "running" : "streaming";
  switch (c.status as ConversationStatus) {
    case "waiting_for_approval":
      return "approval";
    case "interrupted":
      return "interrupted";
    case "failed":
      return "error";
    case "cancelled":
      return "stopped";
    case "completed":
      return isAgent(c.engine) ? "done" : null;
    default:
      return null;
  }
}

/** Approve, Interrupted and Error count toward the amber rail badge. */
export function needsAttention(c: Pick<Conversation, "status">): boolean {
  return c.status === "waiting_for_approval" || c.status === "interrupted" || c.status === "failed";
}

// ---------- pasted images ----------

/** Same limits as the backend (`chat::images`), checked here first for a quick answer. */
export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
export const MAX_IMAGES = 4;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** `240 KB`, `1.4 MB`. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Why `files` can't all be pasted into a draft that already holds `have` images; `null` when they can. */
export function imagePasteError(files: { type: string; size: number }[], have: number, engine?: EngineId): string | null {
  if (have + files.length > MAX_IMAGES) return `Attach up to ${MAX_IMAGES} images per message.`;
  if (files.some((f) => !IMAGE_TYPES.includes(f.type))) return "Paste PNG, JPEG, GIF or WebP images.";
  // Mirrors `providers::takes_image`: the Gemini API takes no GIF.
  if (engine === "gemini-api" && files.some((f) => f.type === "image/gif")) return "Gemini API doesn't take GIF images. Paste a PNG, JPEG or WebP instead.";
  if (files.some((f) => f.size > MAX_IMAGE_BYTES)) return `Images can be up to ${MAX_IMAGE_BYTES / (1024 * 1024)} MB each.`;
  return null;
}

// ---------- conversation list ----------

/** Key of a workspace's chat state: a project id, or "general". */
export const GENERAL = "general";
export const workspaceKey = (projectId: string | null) => projectId ?? GENERAL;

export function conversationsIn(list: Conversation[], projectId: string | null): Conversation[] {
  return list.filter((c) => c.projectId === projectId).sort((a, b) => b.updatedAt - a.updatedAt);
}

export type DateGroup = "Today" | "Yesterday" | "Previous 7 days" | "Previous 30 days" | "Older";

function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function dateGroup(ts: number, now: number): DateGroup {
  const today = startOfDay(now);
  const day = 86_400_000;
  if (ts >= today) return "Today";
  if (ts >= today - day) return "Yesterday";
  if (ts >= today - 7 * day) return "Previous 7 days";
  if (ts >= today - 30 * day) return "Previous 30 days";
  return "Older";
}

const pad = (n: number) => String(n).padStart(2, "0");

export function clockTime(ts: number): string {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** `14:02` today, `YESTERDAY`, `TUE` within a week, else `OCT 12`. */
export function listTime(ts: number, now: number): string {
  const g = dateGroup(ts, now);
  const d = new Date(ts);
  if (g === "Today") return clockTime(ts);
  if (g === "Yesterday") return "YESTERDAY";
  if (g === "Previous 7 days") return d.toLocaleDateString("en-US", { weekday: "short" }).toUpperCase();
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" }).toUpperCase();
}

export function matchesSearch(c: Conversation, query: string): boolean {
  const q = query.trim().toLowerCase();
  return !q || c.title.toLowerCase().includes(q) || c.model.toLowerCase().includes(q) || ENGINE_LABEL[c.engine].toLowerCase().includes(q);
}

// ---------- usage ----------

/** Totals of the usage a chat's answers reported; a field stays null until some answer reported it. */
export function sumUsage(list: (Usage | null)[]): Usage | null {
  const add = (a: number | null, b: number | null) => (b == null ? a : (a ?? 0) + b);
  return list.reduce<Usage | null>(
    (t, u) =>
      u
        ? {
            inputTokens: add(t?.inputTokens ?? null, u.inputTokens),
            outputTokens: add(t?.outputTokens ?? null, u.outputTokens),
            costUsd: add(t?.costUsd ?? null, u.costUsd),
          }
        : t,
    null,
  );
}

/** `188 IN · 141 OUT · $0.0020 REPORTED`; cost appears only when the engine reported it. */
export function usageLine(u: Usage | null): string | null {
  if (!u) return null;
  const parts: string[] = [];
  if (u.inputTokens != null) parts.push(`${u.inputTokens.toLocaleString("en-US")} IN`);
  if (u.outputTokens != null) parts.push(`${u.outputTokens.toLocaleString("en-US")} OUT`);
  if (u.costUsd != null) parts.push(`$${u.costUsd < 0.01 ? u.costUsd.toFixed(4) : u.costUsd.toFixed(2)} REPORTED`);
  return parts.length ? parts.join(" · ") : null;
}

// ---------- errors ----------

/** Errors fixed in Settings › AI integrations. */
export const KEY_ERRORS: ChatErrorKind[] = ["missing_key", "invalid_key", "permission_denied"];
/** Errors fixed by installing or signing in to a runtime. */
export const RUNTIME_ERRORS: ChatErrorKind[] = ["engine_not_found", "not_signed_in"];

export function errorTitle(engine: EngineId | null, error: ChatError): string {
  const who = engine ? ENGINE_LABEL[engine] : "Engine";
  switch (error.kind) {
    case "not_signed_in":
      return `${who} isn't signed in`;
    case "engine_not_found":
      return `${who} isn't installed`;
    case "runtime_exited":
      return `${who} exited`;
    case "resume_failed":
      return `${who} · Session not restored`;
    case "mode_unsupported":
      return `${who} · Mode not available`;
    case "refused":
      return `${who} · Declined`;
    case "rate_limited":
      return `${who} · Rate limited`;
    case "insufficient_credits":
      return `${who} · Out of credits`;
    case "invalid_key":
    case "missing_key":
    case "permission_denied":
      return `${who} · API key problem`;
    case "model_unavailable":
      return `${who} · Model unavailable`;
    case "network":
    case "timeout":
    case "interrupted":
      return `${who} · Connection lost`;
    default:
      return `${who} · Request failed`;
  }
}

export function wordCount(text: string): number {
  return text.trim() ? text.trim().split(/\s+/).length : 0;
}
