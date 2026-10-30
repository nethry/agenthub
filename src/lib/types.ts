// Mirrors the Rust types serialized by src-tauri (camelCase).

export interface Project {
  id: string;
  name: string;
  path: string;
  createdAt: number;
  lastOpenedAt: number | null;
}

export interface DirEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
}

export interface FileContent {
  content: string;
  mtimeMs: number;
  size: number;
  lineEnding: "LF" | "CRLF";
  hasBom: boolean;
  /** Lowercase WHATWG name, e.g. `utf-8`, `utf-16le`, `windows-1250`. */
  encoding: string;
  /** Large file: shown but not editable. */
  readOnly: boolean;
}

export interface LimitWindow {
  /** 0–100; can exceed 100 once a limit is passed. */
  usedPercent: number;
  /** Epoch ms. */
  resetsAt: number | null;
  windowMins: number | null;
}

export interface ProviderUsage {
  status: "ok" | "noData" | "notFound" | "error";
  message: string | null;
  session: LimitWindow | null;
  weekly: LimitWindow | null;
  /** When the numbers were taken (epoch ms). */
  syncedAt: number | null;
  plan: string | null;
}

/** `usage-changed` event / `usage_get`. */
export interface UsageSnapshot {
  /** OpenAI Codex windows (from `codex app-server`). */
  openai: ProviderUsage;
  refreshing: boolean;
}

// ---------- updates (mirrors src-tauri/src/updates) ----------

/** A newer version announced by the release host. */
export interface UpdateInfo {
  version: string;
  currentVersion: string;
  /** Release notes: untrusted text, rendered without raw HTML. */
  notes: string | null;
  date: string | null;
}

export interface UpdateProgress {
  downloaded: number;
  total: number | null;
}

/** The `updates` setting. The last check time is kept by the backend. */
export interface UpdatePrefs {
  /** Check at start and daily. */
  autoCheck: boolean;
  /** A version the user chose not to be told about again. */
  skipped: string | null;
}

export const defaultUpdatePrefs: UpdatePrefs = { autoCheck: true, skipped: null };

export interface UsagePrefs {
  /** Amber from here. */
  warnAt: number;
  /** A one-time alert toast per window from here. */
  alertAt: number;
}

export const defaultUsagePrefs: UsagePrefs = { warnAt: 80, alertAt: 95 };

// ---------- git (mirrors src-tauri/src/git) ----------

/** `git_info`: the detected git executable. */
export interface GitInfo {
  path: string | null;
  version: string | null;
  ok: boolean;
  reason: string | null;
  /** Chosen in Settings › Git instead of found on PATH. */
  overridden: boolean;
}

export interface GitHead {
  branch: string | null;
  oid: string | null;
  detached: boolean;
  unborn: boolean;
}

/** One porcelain v2 status entry. Paths are repository-relative. */
export interface GitEntry {
  path: string;
  /** Relative to the project root; null when outside it. */
  projectPath: string | null;
  origPath: string | null;
  /** `.` unchanged, `M` `T` `A` `D` `R` `C`. */
  index: string;
  /** `.` `M` `T` `D`, or `?` for untracked. */
  worktree: string;
  untracked: boolean;
  /** Unmerged XY code (`UU`, `AA`…). */
  conflict: string | null;
  submodule: boolean;
  partiallyStaged: boolean;
}

/** An operation git stopped in, waiting for Continue or Abort. */
export interface GitOperation {
  kind: "rebase" | "merge" | "cherry_pick" | "revert" | "am";
  step: number | null;
  total: number | null;
  headName: string | null;
}

/** An uncommitted file an agent changed in Chat. */
export interface GitAiChange {
  path: string;
  engine: EngineId;
  engineLabel: string;
  conversationId: string;
}

export interface GitStatus {
  state: "ok" | "none" | "unsafe" | "no_git";
  message: string | null;
  /** What "Trust this folder" adds to safe.directory. */
  trustPath: string | null;
  toplevel: string | null;
  /** The project root inside the repository (`""` or `"sub/dir/"`). */
  prefix: string;
  head: GitHead;
  upstream: string | null;
  upstreamGone: boolean;
  ahead: number;
  behind: number;
  stashCount: number;
  entries: GitEntry[];
  truncated: boolean;
  operation: GitOperation | null;
  /** HEAD is on a remote: amend would rewrite shared history. */
  headPushed: boolean;
  remotes: string[];
  lastFetch: number | null;
  ai: GitAiChange[];
}

/** A progress or hook output line of a running git operation. */
export interface GitProgress {
  line: string;
  percent: number | null;
}

/** `git-changed`: something changed in a project's git dir. */
export interface GitChanged {
  projectId: string;
  kinds: ("index" | "head" | "refs" | "state" | "config")[];
}

export interface GitPrefs {
  /** Add the AI co-author trailer when staged files include agent changes. */
  coAuthorTrailer: boolean;
}

export const defaultGitPrefs: GitPrefs = { coAuthorTrailer: true };

/** Debounced file-system change in a project (`fs-changed` event). */
export interface FsChange {
  projectId: string;
  paths: string[];
  /** Too many changes to list: refresh everything. */
  overflow: boolean;
}

export interface Preset {
  id: string;
  displayName: string;
  executable: string;
  args: string[];
  /** `direct` or a shell profile id. */
  shellProfile: string;
  workingDir: string | null;
  enabled: boolean;
  builtin: boolean;
  resolvedPath: string | null;
}

export type PresetInput = Omit<Preset, "id" | "builtin" | "resolvedPath"> & { id?: string };

export interface ShellProfile {
  id: string;
  name: string;
  label: string;
  path: string | null;
  available: boolean;
  preview: boolean;
}

export type SessionStatus = "starting" | "running" | "exited" | "failed";
export type SessionKind = "shell" | "preset" | "custom";
/** Busy/idle while running: from shell prompt marks or terminal output, never agent-specific. */
export type SessionActivity = "busy" | "idle";
export type ActivitySource = "shell" | "output";

export interface SessionInfo {
  id: string;
  projectId: string;
  title: string;
  kind: SessionKind;
  commandLine: string;
  shellLabel: string;
  cwd: string;
  status: SessionStatus;
  pid: number | null;
  exitCode: number | null;
  error: string | null;
  startedAt: number;
  exitedAt: number | null;
  presetId: string | null;
  cols: number;
  rows: number;
  /** Set only while running. */
  activity: SessionActivity | null;
  activitySource: ActivitySource | null;
  /** Monotonic; keep the highest seen (events and replies can reorder). */
  version: number;
}

export interface SpawnRequest {
  projectId: string;
  kind: SessionKind;
  shellId?: string;
  presetId?: string;
  executable?: string;
  args?: string[];
  title?: string;
  cols: number;
  rows: number;
}

export interface AppInfo {
  version: string;
  dataDir: string;
  platform: string;
  windowsBuild: number | null;
}

export interface AppError {
  kind: string;
  message: string;
}

export type View = "overview" | "chat" | "editor" | "terminals";
export type PaneLayout = "single" | "columns" | "two-over-one";

/** Per-project UI state persisted to SQLite (no live handles). */
export interface WorkspaceState {
  view: View;
  openFiles: string[];
  activeFile: string | null;
  expandedDirs: string[];
  activeSessionId: string | null;
  sessionOrder: string[];
  layout: PaneLayout;
  filesCollapsed: boolean;
  explorerWidth: number;
  /** Editor sidebar: the file tree or Source control. */
  sidebar: "files" | "scm";
}

export const defaultWorkspace = (): WorkspaceState => ({
  view: "overview",
  openFiles: [],
  activeFile: null,
  expandedDirs: [],
  activeSessionId: null,
  sessionOrder: [],
  layout: "two-over-one",
  filesCollapsed: false,
  explorerWidth: 236,
  sidebar: "files",
});

export interface UiPrefs {
  activeProjectId: string | null;
  railCollapsed: boolean;
  workspace: "general" | "project";
}

export interface EditorPrefs {
  fontSize: number;
  wordWrap: boolean;
  minimap: boolean;
}

export interface TerminalPrefs {
  fontSize: number;
  scrollback: number;
}

export const defaultEditorPrefs: EditorPrefs = { fontSize: 12.5, wordWrap: false, minimap: false };
export const defaultTerminalPrefs: TerminalPrefs = { fontSize: 12, scrollback: 5000 };

// ---------- Chat (agents and direct APIs) ----------

/** Direct-API providers (keys in the OS credential store). */
export type ChatProvider = "openai" | "anthropic" | "gemini";

/** What answers a conversation: a local coding-agent runtime or a direct API. */
export type EngineId = "claude-code" | "codex" | "gemini-cli" | "antigravity" | "copilot-cli" | "openai-api" | "anthropic-api" | "gemini-api";
export type ChatMode = "ask" | "plan" | "agent";
/** Agent-mode approval policy, per conversation. */
export type ApprovalPolicy = "ask" | "auto_edits" | "auto_all";
export type ConversationStatus =
  | "idle"
  | "running"
  | "waiting_for_approval"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export interface Conversation {
  id: string;
  /** null: the General workspace. */
  projectId: string | null;
  title: string;
  engine: EngineId;
  model: string;
  mode: ChatMode;
  policy: ApprovalPolicy;
  status: ConversationStatus;
  runtimeSessionId: string | null;
  createdAt: number;
  updatedAt: number;
}

export type ChatRole = "user" | "assistant";
/** `streaming` only while a turn runs. */
export type ChatMessageStatus = "complete" | "streaming" | "stopped" | "error";

export type ChatErrorKind =
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
  | "refused"
  /** Not a failure: the answer hit the output limit. */
  | "truncated";

export interface ChatError {
  kind: ChatErrorKind;
  message: string;
  status: number | null;
  /** Seconds. */
  retryAfter: number | null;
}

export interface Usage {
  inputTokens: number | null;
  outputTokens: number | null;
  /** Only when the engine reports it; AgentHub never estimates prices. */
  costUsd: number | null;
}

export type ItemStatus = "pending" | "running" | "completed" | "failed" | "declined" | "cancelled";
export type ToolKind = "read" | "search" | "edit" | "delete" | "move" | "run" | "think" | "fetch" | "mcp" | "other";
export type PermissionKind = "read" | "write" | "delete" | "command" | "network" | "mcp" | "other";
export type Decision = "allow_once" | "allow_session" | "deny" | "cancel";
export type ChangeKind = "add" | "modify" | "delete";
export type ChangeState = "applied" | "kept" | "reverted";
export type Tone = "info" | "warn" | "danger";

export interface PermissionRequest {
  kind: PermissionKind;
  title: string;
  command: string | null;
  path: string | null;
  paths: string[];
  detail: string | null;
  canAllowSession: boolean;
}

export interface PlanStep {
  text: string;
  status: "pending" | "in_progress" | "completed";
}

export type ItemBody =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool"; tool: ToolKind; title: string; detail: string | null; result: string | null }
  | { kind: "command"; command: string; cwd: string | null; output: string; exitCode: number | null; durationMs: number | null }
  | { kind: "permission"; request: PermissionRequest; decision: Decision | null; auto: boolean; reason: string | null }
  | { kind: "plan"; steps: PlanStep[]; explanation: string | null }
  | {
      kind: "file_change";
      path: string;
      change: ChangeKind;
      additions: number;
      deletions: number;
      checkpoint: string | null;
      state: ChangeState;
    }
  | { kind: "system"; text: string; tone: Tone }
  | { kind: "error"; error: ChatError }
  | { kind: "attachment"; path: string; text: string; truncated: boolean }
  /** A pasted image; its bytes stay in AgentHub's app data folder (see `ipc.chatImage`). */
  | { kind: "image"; id: string; name: string; mime: string; size: number };

/** An image pasted into the composer, sent with the next message. */
export interface NewImage {
  name: string;
  /** Base64, without a `data:` prefix. */
  data: string;
}

export interface ChatItem {
  id: string;
  messageId: string;
  idx: number;
  status: ItemStatus;
  body: ItemBody;
  createdAt: number;
  updatedAt: number;
}

export interface ChatMessage {
  id: string;
  conversationId: string;
  role: ChatRole;
  content: string;
  status: ChatMessageStatus;
  engine: EngineId | null;
  model: string | null;
  error: ChatError | null;
  usage: Usage | null;
  /** Agent activity in order; empty for direct-API answers. */
  items: ChatItem[];
  createdAt: number;
}

/** Streamed on the channel passed to `chat_send` / `chat_regenerate`. */
export type ChatEvent =
  | {
      type: "started";
      conversationId: string;
      requestId: string;
      userMessage: ChatMessage | null;
      assistantMessage: ChatMessage;
      removedIds: string[];
      /** Earlier messages left out of this request (context budget). */
      omitted: number;
    }
  | { type: "delta"; conversationId: string; requestId: string; messageId: string; text: string; itemId: string | null }
  | { type: "item"; conversationId: string; requestId: string; messageId: string; item: ChatItem }
  | { type: "output"; conversationId: string; requestId: string; itemId: string; text: string }
  | { type: "status"; conversationId: string; requestId: string; status: ConversationStatus }
  | { type: "usage"; conversationId: string; requestId: string; messageId: string; usage: Usage }
  | { type: "finished"; conversationId: string; requestId: string; message: ChatMessage; conversation: Conversation };

export interface NewChat {
  projectId: string | null;
  engine: EngineId;
  model: string;
  mode: ChatMode;
  policy: ApprovalPolicy;
  firstMessage: string;
}

export type KeyState = "unknown" | "ok" | "invalid" | "error";

/** Never the key itself: whether one is saved and its last 4 characters. */
export interface ProviderStatus {
  provider: ChatProvider;
  hasKey: boolean;
  keyHint: string | null;
  state: KeyState;
  message: string | null;
  checkedAt: number | null;
}

export type ProbeState = "ready" | "not_found" | "sign_in_needed" | "key_missing" | "key_invalid" | "error" | "unknown";

export interface ModelInfo {
  id: string;
  label: string;
  isDefault: boolean;
}

export interface EngineProbe {
  engine: EngineId;
  state: ProbeState;
  message: string | null;
  path: string | null;
  version: string | null;
  account: string | null;
  models: ModelInfo[];
  probedAt: number | null;
}

export interface Capabilities {
  modes: ChatMode[];
  /** Why a mode is missing, as [mode, reason] pairs. */
  unsupported: [ChatMode, string][];
  tools: boolean;
  fileRead: boolean;
  fileWrite: boolean;
  commands: boolean;
  approvals: boolean;
  sessionResume: boolean;
  modelDiscovery: boolean;
  usage: boolean;
  /** Takes images pasted into a message. */
  images: boolean;
  notes: string[];
}

export interface EngineInfo {
  engine: EngineId;
  label: string;
  kind: "agent" | "api";
  /** Turned on in Settings › AI integrations; off means not probed, started or shown. */
  enabled: boolean;
  capabilities: Capabilities;
  probe: EngineProbe;
}

export interface DiffLine {
  /** `+`, `-`, ` ` or `@` (hunk header). */
  tag: "+" | "-" | " " | "@";
  text: string;
}

export interface FileDiff {
  change: ChangeKind;
  additions: number;
  deletions: number;
  lines: DiffLine[];
  original: string | null;
  binary: boolean;
}

export interface ChangedFile {
  conversationId: string;
  itemId: string;
  engine: EngineId;
  path: string;
  state: ChangeState;
  additions: number;
  deletions: number;
  at: number;
}

export interface ChatPrefs {
  /** Engine for new chats in projects (coding agents, which start in Plan) and in General (direct APIs, Ask). */
  defaultEngine: EngineId;
  defaultGeneralEngine: EngineId;
  defaultPolicy: ApprovalPolicy;
  /** Last model picked per engine. */
  models: Partial<Record<EngineId, string>>;
  /** Custom model ids per engine. */
  customModels: Partial<Record<EngineId, string[]>>;
  sendKey: "enter" | "ctrlEnter";
  listCollapsed: boolean;
  anthropic: { maxTokens: number };
}

export const defaultChatPrefs: ChatPrefs = {
  defaultEngine: "claude-code",
  defaultGeneralEngine: "anthropic-api",
  defaultPolicy: "ask",
  models: {},
  customModels: {},
  sendKey: "enter",
  listCollapsed: false,
  anthropic: { maxTokens: 64000 },
};
