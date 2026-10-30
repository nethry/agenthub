// Transient UI state. Live PTYs are owned by the Rust backend; this store only
// mirrors their status for rendering.
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import {
  defaultEditorPrefs,
  defaultTerminalPrefs,
  defaultUsagePrefs,
  defaultWorkspace,
  type EditorPrefs,
  type Preset,
  type Project,
  type SessionInfo,
  type ShellProfile,
  type TerminalPrefs,
  type UsagePrefs,
  type UsageSnapshot,
  type View,
  type WorkspaceState,
} from "@/lib/types";

export type SettingsSection = "general" | "appearance" | "ai" | "chat" | "editor" | "git" | "terminals" | "shortcuts";
export type Screen = "workspace" | "settings";
/** The General workspace (chats without a project) or the active project. */
export type WorkspaceKind = "general" | "project";
export type PaletteMode = "all" | "chats" | "projects" | "files" | "sessions" | "commands";

export type Dialog =
  | { type: "addProject"; path?: string }
  | { type: "createProject" }
  | { type: "removeProject"; projectId: string }
  | { type: "endSession"; sessionId: string }
  | { type: "unsaved"; projectId: string; path: string }
  | { type: "deleteEntry"; projectId: string; path: string; isDir: boolean }
  | { type: "quit" }
  | { type: "customCommand" }
  | { type: "update" }
  | { type: "deleteChat"; conversationId: string }
  | { type: "revertAll"; conversationId: string; itemIds: string[] }
  | null;

export interface Toast {
  id: number;
  message: string;
  tone: "info" | "danger" | "warn";
}

interface AppState {
  ready: boolean;
  projects: Project[];
  activeProjectId: string | null;
  workspace: WorkspaceKind;
  workspaces: Record<string, WorkspaceState>;
  sessions: Record<string, SessionInfo>;
  presets: Preset[];
  shells: ShellProfile[];
  defaultShell: string;
  editorPrefs: EditorPrefs;
  terminalPrefs: TerminalPrefs;
  railCollapsed: boolean;
  screen: Screen;
  settingsSection: SettingsSection;
  settingsPresetId: string | null;
  paletteOpen: boolean;
  paletteMode: PaletteMode;
  focusSessionId: string | null;
  dialog: Dialog;
  /** Keys are `${projectId}:${path}`. */
  dirty: Record<string, true>;
  /** Markdown files shown as code or split; absent means preview. Same keys as `dirty`. */
  mdView: Record<string, "code" | "split">;
  /** Open files whose disk copy changed under unsaved edits, or was deleted. Same keys as `dirty`. */
  diskState: Record<string, "changed" | "deleted">;
  /** Files an agent changed this session → its conversation id (AI badge, conflict banner). Same keys as `dirty`. */
  aiChanged: Record<string, string>;
  usage: UsageSnapshot | null;
  usagePrefs: UsagePrefs;
  toasts: Toast[];
}

export const useApp = create<AppState>(() => ({
  ready: false,
  projects: [],
  activeProjectId: null,
  workspace: "project",
  workspaces: {},
  sessions: {},
  presets: [],
  shells: [],
  defaultShell: "pwsh",
  editorPrefs: defaultEditorPrefs,
  terminalPrefs: defaultTerminalPrefs,
  railCollapsed: false,
  screen: "workspace",
  settingsSection: "ai",
  settingsPresetId: null,
  paletteOpen: false,
  paletteMode: "all",
  focusSessionId: null,
  dialog: null,
  dirty: {},
  mdView: {},
  diskState: {},
  aiChanged: {},
  usage: null,
  usagePrefs: defaultUsagePrefs,
  toasts: [],
}));

export const set = useApp.setState;
export const get = useApp.getState;

export const fileKey = (projectId: string, path: string) => `${projectId}:${path}`;

/** The project whose workspace is showing; `null` in General. */
export function currentProjectId(s: Pick<AppState, "workspace" | "activeProjectId"> = get()): string | null {
  return s.workspace === "general" ? null : s.activeProjectId;
}

export function workspaceOf(projectId: string | null): WorkspaceState {
  if (!projectId) return defaultWorkspace();
  return get().workspaces[projectId] ?? defaultWorkspace();
}

export function updateWorkspace(projectId: string, patch: Partial<WorkspaceState>) {
  set((s) => ({
    workspaces: {
      ...s.workspaces,
      [projectId]: { ...(s.workspaces[projectId] ?? defaultWorkspace()), ...patch },
    },
  }));
}

export function setView(projectId: string, view: View) {
  updateWorkspace(projectId, { view });
}

/** Sessions of a project in user order (drag order first, then start order). */
export function sessionsFor(state: Pick<AppState, "sessions" | "workspaces">, projectId: string | null): SessionInfo[] {
  if (!projectId) return [];
  const order = state.workspaces[projectId]?.sessionOrder ?? [];
  const list = Object.values(state.sessions).filter((s) => s.projectId === projectId);
  const rank = (s: SessionInfo) => {
    const i = order.indexOf(s.id);
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  };
  return list.sort((a, b) => rank(a) - rank(b) || a.startedAt - b.startedAt);
}

export const isLive = (s: SessionInfo) => s.status === "running" || s.status === "starting";
export const isBusy = (s: SessionInfo) => s.status === "running" && s.activity === "busy";

/** Sessions of a project, re-rendering only when the list actually changes. */
export function useSessions(projectId: string | null): SessionInfo[] {
  return useApp(useShallow((s) => sessionsFor(s, projectId)));
}

let toastSeq = 0;
export function toast(message: string, tone: Toast["tone"] = "info") {
  const id = ++toastSeq;
  set((s) => ({ toasts: [...s.toasts, { id, message, tone }] }));
  setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), 5000);
}
