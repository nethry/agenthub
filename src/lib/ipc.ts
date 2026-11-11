// Typed wrappers around Tauri commands. All backend access goes through here.
import { Channel, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  AppError,
  AppInfo,
  ApprovalPolicy,
  BacklogItem,
  BacklogPatch,
  BacklogRef,
  BacklogStatus,
  NewBacklogItem,
  ChangedFile,
  ChatEvent,
  ChatItem,
  ChatMessage,
  ChatMode,
  ChatProvider,
  Conversation,
  Decision,
  EngineId,
  EngineInfo,
  FileDiff,
  ModelInfo,
  NewChat,
  NewImage,
  ProviderStatus,
  DirEntry,
  FileContent,
  FsChange,
  GitChanged,
  GitInfo,
  GitProgress,
  GitStatus,
  Preset,
  PresetInput,
  Project,
  SessionInfo,
  ShellProfile,
  SpawnRequest,
  UpdateInfo,
  UpdateProgress,
  UsageSnapshot,
} from "./types";

export function errorMessage(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) return String((e as AppError).message);
  return String(e);
}

export function errorKind(e: unknown): string | null {
  if (e && typeof e === "object" && "kind" in e) return String((e as AppError).kind);
  return null;
}

export const ipc = {
  // updates (check, download and install run in Rust)
  updateCheck: () => invoke<UpdateInfo | null>("update_check"),
  updateDownload: (onProgress: Channel<UpdateProgress>) => invoke<UpdateInfo>("update_download", { onProgress }),
  updateDownloaded: () => invoke<UpdateInfo | null>("update_downloaded"),
  /** Ends terminals and chat turns, then runs the installer; the app closes and the new version starts. */
  updateInstall: () => invoke<void>("update_install"),
  // git (Editor › Source control)
  gitInfo: (refresh = false) => invoke<GitInfo>("git_info", { refresh }),
  gitSetPath: (path: string | null) => invoke<GitInfo>("git_set_path", { path }),
  gitStatus: (projectId: string) => invoke<GitStatus>("git_status", { projectId }),
  gitTrustFolder: (projectId: string, path: string) => invoke<GitStatus>("git_trust_folder", { projectId, path }),
  gitStage: (projectId: string, paths: string[], confirmed = false) => invoke<GitStatus>("git_stage", { projectId, paths, confirmed }),
  gitUnstage: (projectId: string, paths: string[]) => invoke<GitStatus>("git_unstage", { projectId, paths }),
  gitStageAll: (projectId: string) => invoke<GitStatus>("git_stage_all", { projectId }),
  gitUnstageAll: (projectId: string) => invoke<GitStatus>("git_unstage_all", { projectId }),
  /** Files go to the Recycle Bin first; refused for files with unsaved editor changes. */
  gitDiscard: (projectId: string, paths: string[], dirty: string[], confirmed: boolean) =>
    invoke<GitStatus>("git_discard", { projectId, paths, dirty, confirmed }),
  gitOperationContinue: (projectId: string, dirty: string[]) => invoke<GitStatus>("git_operation_continue", { projectId, dirty }),
  gitOperationAbort: (projectId: string, dirty: string[], confirmed: boolean) =>
    invoke<GitStatus>("git_operation_abort", { projectId, dirty, confirmed }),
  gitHeadMessage: (projectId: string) => invoke<string>("git_head_message", { projectId }),
  gitCommit: (projectId: string, message: string, amend: boolean, trailers: string[], onProgress: Channel<GitProgress>) =>
    invoke<GitStatus>("git_commit", { projectId, message, amend, trailers, onProgress }),
  gitFetch: (projectId: string, opId: string, onProgress: Channel<GitProgress>) => invoke<GitStatus>("git_fetch", { projectId, opId, onProgress }),
  gitPull: (projectId: string, opId: string, dirty: string[], onProgress: Channel<GitProgress>) =>
    invoke<GitStatus>("git_pull", { projectId, opId, dirty, onProgress }),
  gitPush: (projectId: string, opId: string, onProgress: Channel<GitProgress>) => invoke<GitStatus>("git_push", { projectId, opId, onProgress }),
  gitPublish: (projectId: string, opId: string, onProgress: Channel<GitProgress>) => invoke<GitStatus>("git_publish", { projectId, opId, onProgress }),
  gitCancel: (opId: string) => invoke<boolean>("git_cancel", { opId }),

  // projects
  listProjects: () => invoke<Project[]>("list_projects"),
  addProject: (path: string, name?: string) => invoke<Project>("add_project", { path, name }),
  createProjectFolder: (parent: string, name: string) =>
    invoke<Project>("create_project_folder", { parent, name }),
  renameProject: (id: string, name: string) => invoke<Project>("rename_project", { id, name }),
  removeProject: (id: string) => invoke<void>("remove_project", { id }),
  touchProject: (id: string) => invoke<void>("touch_project", { id }),
  reorderProjects: (ids: string[]) => invoke<void>("reorder_projects", { ids }),
  getWorkspaceState: (projectId: string) => invoke<unknown>("get_workspace_state", { projectId }),
  saveWorkspaceState: (projectId: string, value: unknown) =>
    invoke<void>("save_workspace_state", { projectId, value }),

  // settings
  getSettings: () => invoke<Record<string, string>>("get_settings"),
  setSetting: (key: string, value: string) => invoke<void>("set_setting", { key, value }),

  // files
  listDir: (projectId: string, path: string) => invoke<DirEntry[]>("fs_list_dir", { projectId, path }),
  indexFiles: (projectId: string) => invoke<string[]>("fs_index", { projectId }),
  readFile: (projectId: string, path: string, encoding?: string) =>
    invoke<FileContent>("fs_read_file", { projectId, path, encoding: encoding ?? null }),
  writeFile: (
    projectId: string,
    path: string,
    content: string,
    encoding: string,
    hasBom: boolean,
    expectedMtimeMs: number | null,
  ) => invoke<{ mtimeMs: number }>("fs_write_file", { projectId, path, content, encoding, hasBom, expectedMtimeMs }),
  /** Returns the new entry's project-relative path. Never overwrites. */
  createEntry: (projectId: string, parent: string, name: string, isDir: boolean) =>
    invoke<string>("fs_create", { projectId, parent, name, isDir }),
  /** Returns the renamed entry's project-relative path. */
  renameEntry: (projectId: string, path: string, newName: string) =>
    invoke<string>("fs_rename", { projectId, path, newName }),
  /** Moves to the Recycle Bin. */
  deleteEntry: (projectId: string, path: string) => invoke<void>("fs_delete", { projectId, path }),

  // presets & shells
  listPresets: () => invoke<Preset[]>("list_presets"),
  savePreset: (preset: PresetInput) => invoke<Preset>("save_preset", { preset }),
  deletePreset: (id: string) => invoke<void>("delete_preset", { id }),
  resolveExecutable: (executable: string) => invoke<string | null>("resolve_executable", { executable }),
  listShells: (rescan = false) => invoke<ShellProfile[]>("list_shells", { rescan }),

  // terminals
  spawn: (request: SpawnRequest) => invoke<SessionInfo>("terminal_spawn", { request }),
  listSessions: () => invoke<SessionInfo[]>("terminal_list"),
  snapshot: (id: string) => invoke<string>("terminal_snapshot", { id }),
  write: (id: string, data: string) => invoke<void>("terminal_write", { id, data }),
  resize: (id: string, cols: number, rows: number) => invoke<void>("terminal_resize", { id, cols, rows }),
  rename: (id: string, title: string) => invoke<SessionInfo>("terminal_rename", { id, title }),
  restart: (id: string, cols: number, rows: number) => invoke<SessionInfo>("terminal_restart", { id, cols, rows }),
  kill: (id: string) => invoke<void>("terminal_kill", { id }),
  close: (id: string) => invoke<void>("terminal_close", { id }),

  // usage limits
  usageGet: () => invoke<UsageSnapshot>("usage_get"),
  /** Starts a refresh; fresh numbers arrive via `onUsageChanged`. */
  usageRefresh: () => invoke<UsageSnapshot>("usage_refresh"),

  // chat (agent runtimes and direct APIs)
  chatListConversations: () => invoke<Conversation[]>("chat_list_conversations"),
  chatGetMessages: (conversationId: string) => invoke<ChatMessage[]>("chat_get_messages", { conversationId }),
  chatCreateConversation: (chat: NewChat) => invoke<Conversation>("chat_create_conversation", { chat }),
  chatRenameConversation: (id: string, title: string) => invoke<Conversation>("chat_rename_conversation", { id, title }),
  chatSetEngine: (id: string, engine: EngineId, model: string) => invoke<Conversation>("chat_set_engine", { id, engine, model }),
  chatSetMode: (id: string, mode: ChatMode) => invoke<Conversation>("chat_set_mode", { id, mode }),
  chatSetPolicy: (id: string, policy: ApprovalPolicy) => invoke<Conversation>("chat_set_policy", { id, policy }),
  chatDeleteConversation: (id: string) => invoke<void>("chat_delete_conversation", { id }),
  /** Returns the request id; the turn streams on `onEvent`. */
  chatSend: (conversationId: string, content: string, attachments: string[], images: NewImage[], backlog: BacklogRef | null, onEvent: Channel<ChatEvent>) =>
    invoke<string>("chat_send", { conversationId, content, attachments, images, backlog, onEvent }),
  /** A pasted image of a message, as a `data:` URL. */
  chatImage: (itemId: string) => invoke<string>("chat_image", { itemId }),
  chatRegenerate: (conversationId: string, onEvent: Channel<ChatEvent>) => invoke<string>("chat_regenerate", { conversationId, onEvent }),
  chatStop: (requestId: string) => invoke<boolean>("chat_stop", { requestId }),
  chatRespondApproval: (itemId: string, decision: Decision) => invoke<void>("chat_respond_approval", { itemId, decision }),
  chatEngines: () => invoke<EngineInfo[]>("chat_engines"),
  /** Starts probing; results arrive via `onEnginesChanged`. */
  chatProbeEngines: (engine?: EngineId) => invoke<EngineInfo[]>("chat_probe_engines", { engine: engine ?? null }),
  chatSetEnginePath: (engine: EngineId, path: string | null) => invoke<EngineInfo[]>("chat_set_engine_path", { engine, path }),
  /** Refused while one of the engine's turns is running. */
  chatSetEngineEnabled: (engine: EngineId, enabled: boolean) => invoke<EngineInfo[]>("chat_set_engine_enabled", { engine, enabled }),
  /** Runs the runtime's own sign-in (Antigravity: Google in the browser); resolves when it ends. */
  chatEngineSignIn: (engine: EngineId) => invoke<EngineInfo[]>("chat_engine_sign_in", { engine }),
  chatEngineCancelSignIn: (engine: EngineId) => invoke<void>("chat_engine_cancel_sign_in", { engine }),
  chatApiModels: (provider: ChatProvider) => invoke<ModelInfo[]>("chat_api_models", { provider }),
  chatFileDiff: (itemId: string) => invoke<FileDiff>("chat_file_diff", { itemId }),
  /** Keep (true) or revert (false) an agent's file change. */
  chatSetChange: (itemId: string, keep: boolean) => invoke<ChatItem>("chat_set_change", { itemId, keep }),
  chatChangedFiles: (projectId: string) => invoke<ChangedFile[]>("chat_changed_files", { projectId }),
  chatProviders: () => invoke<ProviderStatus[]>("chat_providers"),
  /** The key goes straight to the OS credential store; only a status comes back. */
  chatSaveKey: (provider: ChatProvider, key: string, model?: string) =>
    invoke<ProviderStatus>("chat_save_key", { provider, key, model: model ?? null }),
  chatRemoveKey: (provider: ChatProvider) => invoke<ProviderStatus>("chat_remove_key", { provider }),
  chatTestConnection: (provider: ChatProvider, model?: string) =>
    invoke<ProviderStatus>("chat_test_connection", { provider, model: model ?? null }),

  // backlog (features and bugs per project)
  backlogList: (projectId: string) => invoke<BacklogItem[]>("backlog_list", { projectId }),
  backlogCreate: (item: NewBacklogItem) => invoke<BacklogItem>("backlog_create", { item }),
  backlogUpdate: (id: string, patch: BacklogPatch) => invoke<BacklogItem>("backlog_update", { id, patch }),
  backlogSetStatus: (id: string, status: BacklogStatus) => invoke<BacklogItem>("backlog_set_status", { id, status }),
  backlogSetPlan: (id: string, plan: string | null) => invoke<BacklogItem>("backlog_set_plan", { id, plan }),
  /** Deletes the item and its screenshots; chats started from it stay. */
  backlogDelete: (id: string) => invoke<void>("backlog_delete", { id }),
  /** Checked by type (from the bytes) and size in Rust; up to 8 per item. */
  backlogAddImages: (id: string, images: NewImage[]) => invoke<BacklogItem>("backlog_add_images", { id, images }),
  backlogRemoveImage: (imageId: string) => invoke<BacklogItem>("backlog_remove_image", { imageId }),
  /** A screenshot as a `data:` URL. */
  backlogImage: (imageId: string) => invoke<string>("backlog_image", { imageId }),
  /** The context pack a message sent now would carry. */
  backlogContextPreview: (id: string) => invoke<string>("backlog_context_preview", { id }),

  // app
  appInfo: () => invoke<AppInfo>("app_info"),
  quit: () => invoke<void>("app_quit"),
};

export function onTerminalOutput(cb: (id: string, data: string) => void): Promise<UnlistenFn> {
  return listen<{ id: string; data: string }>("terminal-output", (e) => cb(e.payload.id, e.payload.data));
}

export function onTerminalStatus(cb: (info: SessionInfo) => void): Promise<UnlistenFn> {
  return listen<SessionInfo>("terminal-status", (e) => cb(e.payload));
}

export function onGitChanged(cb: (change: GitChanged) => void): Promise<UnlistenFn> {
  return listen<GitChanged>("git-changed", (e) => cb(e.payload));
}

/** Channel for one git operation's progress lines. */
export function gitChannel(onLine: (p: GitProgress) => void): Channel<GitProgress> {
  const channel = new Channel<GitProgress>();
  channel.onmessage = onLine;
  return channel;
}

export function errorDetail(e: unknown): string | null {
  if (e && typeof e === "object" && "detail" in e) return String((e as { detail: unknown }).detail);
  return null;
}

/** The daily check found a new version. */
export function onUpdateAvailable(cb: (info: UpdateInfo) => void): Promise<UnlistenFn> {
  return listen<UpdateInfo>("update-available", (e) => cb(e.payload));
}

export function updateChannel(onProgress: (p: UpdateProgress) => void): Channel<UpdateProgress> {
  const channel = new Channel<UpdateProgress>();
  channel.onmessage = onProgress;
  return channel;
}

export function onFsChanged(cb: (change: FsChange) => void): Promise<UnlistenFn> {
  return listen<FsChange>("fs-changed", (e) => cb(e.payload));
}

export function onUsageChanged(cb: (snapshot: UsageSnapshot) => void): Promise<UnlistenFn> {
  return listen<UsageSnapshot>("usage-changed", (e) => cb(e.payload));
}

export function onEnginesChanged(cb: (engines: EngineInfo[]) => void): Promise<UnlistenFn> {
  return listen<EngineInfo[]>("engines-changed", (e) => cb(e.payload));
}

/** Channel for one chat request's `ChatEvent`s (ordered, per request). */
export function chatChannel(onEvent: (event: ChatEvent) => void): Channel<ChatEvent> {
  const channel = new Channel<ChatEvent>();
  channel.onmessage = onEvent;
  return channel;
}
