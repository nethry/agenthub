// Wire types shared with the Rust side (`src-tauri/src/chat/mod.rs`,
// `agents/sidecar.rs`). Field names and enum values must match the serde
// shapes there exactly; optional fields are omitted rather than sent as null.

export type EngineId = "claude-code" | "copilot-cli";
export type Mode = "ask" | "plan" | "agent";

export type ItemStatus = "running" | "completed" | "failed" | "declined" | "cancelled";
export type ToolKind = "read" | "search" | "edit" | "delete" | "move" | "run" | "think" | "fetch" | "mcp" | "other";

export type ItemBody =
  | { kind: "tool"; tool: ToolKind; title: string; detail?: string; result?: string }
  | { kind: "command"; command: string; cwd?: string; output: string; exitCode?: number; durationMs?: number };

export type PermissionKind = "read" | "write" | "delete" | "command" | "network" | "mcp" | "other";

export interface PermissionRequest {
  kind: PermissionKind;
  title: string;
  command?: string;
  /** Absolute. */
  path?: string;
  /** Absolute. */
  paths: string[];
  detail?: string;
  canAllowSession: boolean;
}

export type Decision = "allow_once" | "allow_session" | "deny" | "cancel";

export interface PlanStep {
  text: string;
  status: "pending" | "in_progress" | "completed";
}

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

/** Rust `ErrorKind` (snake_case). */
export type ErrorKind =
  | "engine_not_found"
  | "not_signed_in"
  | "runtime_exited"
  | "resume_failed"
  | "mode_unsupported"
  | "missing_key"
  | "invalid_key"
  | "permission_denied"
  | "model_unavailable"
  | "insufficient_credits"
  | "rate_limited"
  | "overloaded"
  | "network"
  | "timeout"
  | "interrupted"
  | "malformed"
  | "provider_error"
  | "context_too_long"
  | "invalid_request"
  | "refused";

export interface WireError {
  kind: ErrorKind;
  message: string;
}

export type Outcome = { type: "completed" } | { type: "cancelled" } | { type: "failed"; error: WireError };

export type Tone = "info" | "warn" | "danger";

export type AgentEvent =
  | { type: "session"; id: string; resumed: boolean }
  | { type: "resumeFailed"; message: string }
  | { type: "text"; text: string }
  | { type: "textBreak" }
  | { type: "thinking"; text: string }
  | { type: "itemStarted" | "itemUpdated"; key: string; status: ItemStatus; body: ItemBody }
  | { type: "output"; key: string; text: string }
  | { type: "plan"; steps: PlanStep[]; explanation?: string }
  | { type: "usage"; usage: Usage }
  | { type: "notice"; text: string; tone: Tone }
  | { type: "done"; outcome: Outcome };

export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export const MAX_IMAGES = 4;

export interface ImageInput {
  mimeType: (typeof IMAGE_TYPES)[number];
  /** Base64. */
  data: string;
}

export interface TurnStartParams {
  turnId: string;
  conversationId: string;
  engine: EngineId;
  model: string;
  mode: Mode;
  cwd: string;
  prompt: string;
  /** Images pasted into the message, checked by AgentHub; sent as bytes, never as paths. */
  images?: ImageInput[];
  sessionId?: string;
  handoff?: string;
  reconfigure: boolean;
  executable?: string;
  /** Claude only. Goes into the SDK child's environment and nowhere else. */
  apiKey?: string;
}

export type ProbeState = "ready" | "not_found" | "sign_in_needed" | "key_missing" | "error";

export interface ModelInfo {
  id: string;
  label: string;
  isDefault: boolean;
}

export interface ProbeResult {
  state: ProbeState;
  message?: string;
  path?: string;
  version?: string;
  account?: string;
  models: ModelInfo[];
}

export function failed(kind: ErrorKind, message: string): Outcome {
  return { type: "failed", error: { kind, message } };
}

/** Prompt prefix for AgentHub modes the runtime has no native switch for (mirrors Rust `mode_instructions`). */
export function modeInstructions(mode: Mode): string | undefined {
  switch (mode) {
    case "ask":
      return "AgentHub Ask mode: answer from the conversation and any attached files only. Don't read, search, edit or run anything; those requests will be denied.";
    case "plan":
      return "AgentHub Plan mode: you may read and search files in this project to analyze it, but don't edit files or run commands (they will be denied). End with a numbered plan of milestones, then risks.";
    case "agent":
      return undefined;
  }
}

/** The prompt actually sent: mode instructions, then the earlier conversation when a resume failed. */
export function composePrompt(prompt: string, mode: Mode, handoff?: string): string {
  const parts: string[] = [];
  const mi = modeInstructions(mode);
  if (mi) parts.push(mi);
  if (handoff) parts.push(`Earlier in this conversation (your previous session couldn't be resumed):\n\n${handoff}`);
  parts.push(prompt);
  return parts.join("\n\n");
}

/** Removes key-like strings (and the exact key) from runtime text before it's shown. */
export function redact(text: string, key?: string): string {
  let out = key && key.length >= 8 ? text.split(key).join("[redacted]") : text;
  out = out.replace(/(^|[^A-Za-z0-9])((?:sk-|sess-|gh[pousr]_|github_pat_)[A-Za-z0-9_\-*.]{6,})/g, "$1[redacted]");
  return out;
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
