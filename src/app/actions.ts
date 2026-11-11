// User-facing flows that span the backend and the store.
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { errorMessage, ipc, onFsChanged, onTerminalOutput, onTerminalStatus, onUsageChanged } from "@/lib/ipc";
import { PROVIDERS, alertKey, current, resetText } from "@/features/usage/format";
import { basename } from "@/lib/utils";
import {
  defaultEditorPrefs,
  defaultGitPrefs,
  defaultUpdatePrefs,
  defaultTerminalPrefs,
  defaultUsagePrefs,
  defaultWorkspace,
  type EditorPrefs,
  type GitPrefs,
  type UpdatePrefs,
  type UsagePrefs,
  type UsageSnapshot,
  type SessionInfo,
  type SpawnRequest,
  type TerminalPrefs,
  type UiPrefs,
  type WorkspaceState,
} from "@/lib/types";
import * as terms from "@/features/terminals/registry";
import * as files from "@/features/editor/models";
import { emitFsChange } from "@/features/explorer/fsEvents";
import { invalidateFileIndex } from "@/features/palette/fileIndex";
import { ensureChatLoaded, onAgentFilesChanged } from "@/features/chat/actions";
import { engineOn } from "@/features/chat/models";
import { getChat } from "@/features/chat/store";
import { hasRunningWork, runningWork } from "./work";
import { loadAppearance } from "./appearance";
import { onGitTreeChanged, setGitPrefs, startGitEvents } from "@/features/git/actions";
import { setUpdatePrefs, startUpdateEvents } from "@/features/updates/actions";
import { get, isLive, sessionsFor, set, setView, toast, updateWorkspace, useApp, workspaceOf, type SettingsSection } from "./store";

function parse<T>(raw: string | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return { ...fallback, ...JSON.parse(raw) };
  } catch {
    return fallback;
  }
}

/** Fields that only make sense while the app runs (session ids die with it). */
function persistable(ws: WorkspaceState) {
  const { activeSessionId: _a, sessionOrder: _o, overviewSessionIds: _v, ...rest } = ws;
  return rest;
}

// ---------- bootstrap ----------

export async function bootstrap() {
  // Subscribe before listing sessions so no output is lost; replayed sessions
  // ignore live output until their snapshot is written.
  const replaying = new Set<string>();
  await onTerminalOutput((id, data) => {
    if (!replaying.has(id)) terms.write(id, data);
  });
  await onTerminalStatus(upsertSession);
  await onFsChanged(fsChanged);
  await onUsageChanged(setUsage);

  const [projects, presets, shells, settings, sessions, info] = await Promise.all([
    ipc.listProjects(),
    ipc.listPresets(),
    ipc.listShells(),
    ipc.getSettings(),
    ipc.listSessions(),
    ipc.appInfo().catch(() => null),
    terms.loadFonts(),
  ]);

  // Before any editor or terminal is created, so they start in the saved theme.
  loadAppearance(settings.appearance);

  const ui = parse<UiPrefs>(settings.ui, { activeProjectId: null, railCollapsed: false, workspace: "project" });
  const workspaces: Record<string, WorkspaceState> = {};
  await Promise.all(
    projects.map(async (p) => {
      const saved = (await ipc.getWorkspaceState(p.id).catch(() => null)) as Partial<WorkspaceState> | null;
      workspaces[p.id] = { ...defaultWorkspace(), ...(saved ?? {}), activeSessionId: null, sessionOrder: [], overviewSessionIds: [] };
    }),
  );

  terms.setWindowsBuild(info?.windowsBuild ?? null);
  for (const s of sessions) replaying.add(s.id);
  await Promise.all(
    sessions.map(async (s) => {
      const snap = await ipc.snapshot(s.id).catch(() => "");
      terms.write(s.id, snap);
      replaying.delete(s.id);
    }),
  );

  const activeProjectId =
    projects.find((p) => p.id === ui.activeProjectId)?.id ??
    [...projects].sort((a, b) => (b.lastOpenedAt ?? 0) - (a.lastOpenedAt ?? 0))[0]?.id ??
    null;

  set({
    ready: true,
    projects,
    presets,
    shells,
    workspaces,
    sessions: Object.fromEntries(sessions.map((s) => [s.id, s])),
    activeProjectId,
    workspace: ui.workspace === "general" || !activeProjectId ? "general" : "project",
    railCollapsed: ui.railCollapsed,
    defaultShell: settings.default_shell ?? shells.find((s) => s.available && !s.preview)?.id ?? "cmd",
    editorPrefs: parse<EditorPrefs>(settings.editor, defaultEditorPrefs),
    terminalPrefs: parse<TerminalPrefs>(settings.terminal, defaultTerminalPrefs),
    usagePrefs: parse<UsagePrefs>(settings.usage, defaultUsagePrefs),
  });
  for (const s of sessions) ensureActiveSession(s);

  onAgentFilesChanged(agentChangedFiles);
  // Git rewrites files (discard, pull, abort): editors, tree and palette reload like after any change.
  onGitTreeChanged(fsChanged);
  setGitPrefs(parse<GitPrefs>(settings.git, defaultGitPrefs));
  void startGitEvents();
  setUpdatePrefs(parse<UpdatePrefs>(settings.updates, defaultUpdatePrefs));
  void startUpdateEvents();
  // Conversations feed the rail badges and Overview, not only the Chat view.
  void ensureChatLoaded();
  startPersistence();
  startUsagePolling();
}

function startPersistence() {
  const timers = new Map<string, number>();
  let last = get().workspaces;
  let lastUi = JSON.stringify({ activeProjectId: get().activeProjectId, railCollapsed: get().railCollapsed, workspace: get().workspace });
  useApp.subscribe((s) => {
    if (s.workspaces !== last) {
      for (const [id, ws] of Object.entries(s.workspaces)) {
        if (last[id] === ws) continue;
        window.clearTimeout(timers.get(id));
        timers.set(
          id,
          window.setTimeout(() => void ipc.saveWorkspaceState(id, persistable(ws)).catch(() => {}), 400),
        );
      }
      last = s.workspaces;
    }
    const ui = JSON.stringify({ activeProjectId: s.activeProjectId, railCollapsed: s.railCollapsed, workspace: s.workspace });
    if (ui !== lastUi) {
      lastUi = ui;
      void ipc.setSetting("ui", ui).catch(() => {});
    }
  });
}

// ---------- projects ----------

export function selectProject(id: string) {
  set({ activeProjectId: id, workspace: "project", screen: "workspace", focusSessionId: null });
  void ipc.touchProject(id).catch(() => {});
}

export async function pickFolder(title: string): Promise<string | null> {
  const picked = await openDialog({ directory: true, multiple: false, title });
  return typeof picked === "string" ? picked : null;
}

export async function addProject(path: string, name?: string) {
  try {
    const project = await ipc.addProject(path, name);
    set((s) => ({
      projects: s.projects.some((p) => p.id === project.id) ? s.projects : [...s.projects, project],
      workspaces: s.workspaces[project.id] ? s.workspaces : { ...s.workspaces, [project.id]: defaultWorkspace() },
      dialog: null,
    }));
    selectProject(project.id);
    return true;
  } catch (e) {
    toast(errorMessage(e), "danger");
    return false;
  }
}

export async function createProject(parent: string, name: string) {
  try {
    const project = await ipc.createProjectFolder(parent, name);
    set((s) => ({
      projects: [...s.projects, project],
      workspaces: { ...s.workspaces, [project.id]: defaultWorkspace() },
      dialog: null,
    }));
    selectProject(project.id);
    return true;
  } catch (e) {
    toast(errorMessage(e), "danger");
    return false;
  }
}

/** Open the native folder picker straight away (Ctrl+O). */
export async function openFolderAsProject() {
  const path = await pickFolder("Open existing folder");
  if (path) set({ dialog: { type: "addProject", path } });
}

export async function removeProject(id: string) {
  for (const s of sessionsFor(get(), id)) terms.dispose(s.id);
  files.disposeProject(id);
  try {
    await ipc.removeProject(id);
  } catch (e) {
    toast(errorMessage(e), "danger");
    return;
  }
  set((s) => {
    const projects = s.projects.filter((p) => p.id !== id);
    const sessions = Object.fromEntries(Object.entries(s.sessions).filter(([, v]) => v.projectId !== id));
    const { [id]: _removed, ...workspaces } = s.workspaces;
    return {
      projects,
      sessions,
      workspaces,
      dialog: null,
      activeProjectId: s.activeProjectId === id ? (projects[0]?.id ?? null) : s.activeProjectId,
      workspace: s.activeProjectId === id && !projects.length ? "general" : s.workspace,
    };
  });
}

export async function reorderProjects(ids: string[]) {
  set((s) => ({ projects: ids.map((id) => s.projects.find((p) => p.id === id)!).filter(Boolean) }));
  await ipc.reorderProjects(ids).catch(() => {});
}

// ---------- sessions ----------

function ensureActiveSession(info: SessionInfo) {
  const ws = workspaceOf(info.projectId);
  if (!ws.activeSessionId || !get().sessions[ws.activeSessionId]) {
    updateWorkspace(info.projectId, { activeSessionId: info.id });
  }
}

export function upsertSession(info: SessionInfo) {
  // A status event can race with a close; ignore sessions we already dropped.
  const current = get().sessions[info.id];
  if (!current && info.status === "exited" && !terms.has(info.id)) return;
  if (current && current.version > info.version) return;
  set((s) => ({ sessions: { ...s.sessions, [info.id]: info } }));
  ensureActiveSession(info);
}

async function spawn(req: Omit<SpawnRequest, "cols" | "rows">) {
  const { cols, rows } = terms.size(get().workspaces[req.projectId]?.activeSessionId ?? "");
  try {
    const info = await ipc.spawn({ ...req, cols, rows });
    terms.ensure(info.id);
    upsertSession(info);
    const ws = workspaceOf(req.projectId);
    updateWorkspace(req.projectId, {
      activeSessionId: info.id,
      sessionOrder: [...ws.sessionOrder.filter((x) => get().sessions[x]), info.id],
      // Overview hosts live terminals too. Reveal its dock without leaving instructions.
      ...(ws.view === "overview" ? { overviewTerminalsCollapsed: false } : {}),
    });
    if (get().focusSessionId) set({ focusSessionId: info.id });
    terms.requestFocus(info.id);
    return info;
  } catch (e) {
    toast(errorMessage(e), "danger");
    return null;
  }
}

export const spawnShell = (projectId: string, shellId?: string) =>
  spawn({ projectId, kind: "shell", shellId: shellId ?? get().defaultShell });

export const spawnPreset = (projectId: string, presetId: string) => spawn({ projectId, kind: "preset", presetId });

export const spawnCustom = (projectId: string, executable: string, args: string[], shellId: string, title?: string) =>
  spawn({ projectId, kind: "custom", executable, args, shellId, title });

export function launchPresetByIndex(n: number) {
  const projectId = get().activeProjectId;
  const preset = get().presets.filter((p) => p.enabled)[n - 1];
  if (!projectId || !preset) return;
  void spawnPreset(projectId, preset.id);
}

export function focusSession(id: string) {
  const s = get().sessions[id];
  if (!s) return;
  if (get().activeProjectId !== s.projectId) selectProject(s.projectId);
  updateWorkspace(s.projectId, { activeSessionId: id });
  requestAnimationFrame(() => terms.focus(id));
}

/** Focus a session and switch its project to the Terminals view, where it's visible. */
export function showSession(id: string) {
  const s = get().sessions[id];
  if (!s) return;
  setView(s.projectId, "terminals");
  focusSession(id);
}

export function requestCloseSession(id: string) {
  const s = get().sessions[id];
  if (!s) return;
  if (isLive(s)) set({ dialog: { type: "endSession", sessionId: id } });
  else void closeSession(id);
}

/** Close the session in focus mode, or else the active project's active session. */
export function requestCloseActiveSession() {
  const s = get();
  const id = s.focusSessionId ?? (s.activeProjectId ? s.workspaces[s.activeProjectId]?.activeSessionId : null);
  if (id) requestCloseSession(id);
}

export async function closeSession(id: string) {
  const s = get().sessions[id];
  await ipc.close(id).catch(() => {});
  terms.dispose(id);
  set((st) => {
    const { [id]: _gone, ...sessions } = st.sessions;
    return { sessions, dialog: null, focusSessionId: st.focusSessionId === id ? null : st.focusSessionId };
  });
  if (s) {
    const ws = workspaceOf(s.projectId);
    const order = ws.sessionOrder.filter((x) => x !== id);
    const next = sessionsFor(get(), s.projectId)[0]?.id ?? null;
    updateWorkspace(s.projectId, {
      sessionOrder: order,
      activeSessionId: ws.activeSessionId === id ? next : ws.activeSessionId,
    });
  }
}

export async function restartSession(id: string) {
  const { cols, rows } = terms.size(id);
  try {
    upsertSession(await ipc.restart(id, cols, rows));
  } catch (e) {
    toast(errorMessage(e), "danger");
  }
}

export async function renameSession(id: string, title: string) {
  try {
    upsertSession(await ipc.rename(id, title));
  } catch (e) {
    toast(errorMessage(e), "danger");
  }
}

export function reorderSessions(projectId: string, ids: string[]) {
  updateWorkspace(projectId, { sessionOrder: ids });
}

// ---------- files ----------

export function openFile(projectId: string, path: string) {
  const ws = workspaceOf(projectId);
  updateWorkspace(projectId, {
    openFiles: ws.openFiles.includes(path) ? ws.openFiles : [...ws.openFiles, path],
    activeFile: path,
    view: "editor",
  });
}

export function requestCloseFile(projectId: string, path: string) {
  if (files.isDirty(projectId, path)) set({ dialog: { type: "unsaved", projectId, path } });
  else closeFile(projectId, path);
}

export function closeFile(projectId: string, path: string) {
  files.disposeFile(projectId, path);
  const ws = workspaceOf(projectId);
  const idx = ws.openFiles.indexOf(path);
  const openFiles = ws.openFiles.filter((f) => f !== path);
  updateWorkspace(projectId, {
    openFiles,
    activeFile: ws.activeFile === path ? (openFiles[Math.min(idx, openFiles.length - 1)] ?? null) : ws.activeFile,
  });
  if (get().dialog?.type === "unsaved") set({ dialog: null });
}

export async function saveActiveFile() {
  const projectId = get().activeProjectId;
  if (!projectId) return;
  const path = workspaceOf(projectId).activeFile;
  if (path) await files.saveFile(projectId, path);
}

const under = (path: string, prefix: string) => path === prefix || path.startsWith(prefix + "/");

/** Watcher events and our own file operations go through one place. */
function fsChanged(change: { projectId: string; paths: string[]; overflow?: boolean }) {
  const full = { overflow: false, ...change };
  files.handleFsChange(full);
  invalidateFileIndex(change.projectId);
  emitFsChange(full);
}

/** Create an empty file (opened in the editor) or a folder inside `parent`. */
export async function createEntry(projectId: string, parent: string, name: string, isDir: boolean) {
  try {
    const path = await ipc.createEntry(projectId, parent, name, isDir);
    fsChanged({ projectId, paths: [path] });
    const ws = workspaceOf(projectId);
    if (parent && !ws.expandedDirs.includes(parent)) updateWorkspace(projectId, { expandedDirs: [...ws.expandedDirs, parent] });
    if (!isDir) openFile(projectId, path);
    return path;
  } catch (e) {
    toast(errorMessage(e), "danger");
    return null;
  }
}

/** Rename on disk, then carry open tabs (with unsaved edits) and expanded folders along. */
export async function renameEntry(projectId: string, path: string, newName: string) {
  try {
    const to = await ipc.renameEntry(projectId, path, newName);
    if (to === path) return to;
    files.moveFiles(projectId, path, to);
    const move = (p: string) => (under(p, path) ? to + p.slice(path.length) : p);
    const ws = workspaceOf(projectId);
    updateWorkspace(projectId, {
      openFiles: ws.openFiles.map(move),
      activeFile: ws.activeFile && move(ws.activeFile),
      expandedDirs: ws.expandedDirs.map(move),
    });
    fsChanged({ projectId, paths: [path, to] });
    return to;
  } catch (e) {
    toast(errorMessage(e), "danger");
    return null;
  }
}

export function requestDeleteEntry(projectId: string, path: string, isDir: boolean) {
  set({ dialog: { type: "deleteEntry", projectId, path, isDir } });
}

/** Move to the Recycle Bin. Clean tabs under it close; unsaved ones stay, flagged as deleted. */
export async function deleteEntry(projectId: string, path: string) {
  try {
    await ipc.deleteEntry(projectId, path);
  } catch (e) {
    toast(errorMessage(e), "danger");
    return false;
  }
  set({ dialog: null });
  files.markDeleted(projectId, path);
  for (const f of workspaceOf(projectId).openFiles) {
    if (under(f, path) && !files.isDirty(projectId, f)) closeFile(projectId, f);
  }
  const ws = workspaceOf(projectId);
  updateWorkspace(projectId, { expandedDirs: ws.expandedDirs.filter((d) => !under(d, path)) });
  fsChanged({ projectId, paths: [path] });
  toast(`Moved ${basename(path)} to the Recycle Bin.`);
  return true;
}

export function toggleDir(projectId: string, path: string) {
  const ws = workspaceOf(projectId);
  updateWorkspace(projectId, {
    expandedDirs: ws.expandedDirs.includes(path)
      ? ws.expandedDirs.filter((d) => d !== path && !d.startsWith(path + "/"))
      : [...ws.expandedDirs, path],
  });
}

// ---------- presets, shells, settings ----------

export async function refreshPresets() {
  set({ presets: await ipc.listPresets() });
}

export async function rescanShells() {
  set({ shells: await ipc.listShells(true) });
  await refreshPresets();
}

export async function setDefaultShell(id: string) {
  set({ defaultShell: id });
  await ipc.setSetting("default_shell", id).catch(() => {});
}

export async function setEditorPrefs(patch: Partial<EditorPrefs>) {
  const next = { ...get().editorPrefs, ...patch };
  set({ editorPrefs: next });
  await ipc.setSetting("editor", JSON.stringify(next)).catch(() => {});
}

export async function setTerminalPrefs(patch: Partial<TerminalPrefs>) {
  const next = { ...get().terminalPrefs, ...patch };
  set({ terminalPrefs: next });
  terms.applyPrefs();
  await ipc.setSetting("terminal", JSON.stringify(next)).catch(() => {});
}

export function openSettings(section?: SettingsSection, presetId?: string | null) {
  set((s) => ({
    screen: "settings",
    settingsSection: section ?? s.settingsSection,
    settingsPresetId: presetId === undefined ? s.settingsPresetId : presetId,
    focusSessionId: null,
    paletteOpen: false,
  }));
}

// ---------- usage limits ----------

/** Codex is asked on start and then this often; Claude updates as its sessions reply. */
const USAGE_POLL_MS = 5 * 60_000;
const alerted = new Set<string>();

function startUsagePolling() {
  void ipc.usageGet().then(setUsage).catch(() => {});
  refreshUsage();
  window.setInterval(refreshUsage, USAGE_POLL_MS);
}

export function refreshUsage() {
  void ipc.usageRefresh().then(setUsage).catch(() => {});
}

/** Store a snapshot and raise each alert-level or limit crossing once per window. */
function setUsage(snapshot: UsageSnapshot) {
  set({ usage: snapshot });
  const prefs = get().usagePrefs;
  const now = Date.now();
  for (const p of PROVIDERS) {
    if (!engineOn(getChat().engines, p.engine)) continue;
    for (const kind of ["session", "weekly"] as const) {
      const w = current(snapshot[p.id][kind], now);
      const key = w && alertKey(p.id, kind, w, prefs);
      if (!w || !key || alerted.has(key)) continue;
      alerted.add(key);
      const what = `${p.name} ${kind === "session" ? "5-hour session" : "weekly"}`;
      if (w.usedPercent >= 100) toast(`${what} limit reached · ${resetText(w.resetsAt, now, true).toLowerCase()}.`, "danger");
      else toast(`${what} usage at ${Math.round(w.usedPercent)}% · ${resetText(w.resetsAt, now).toLowerCase()}.`, "warn");
    }
  }
}

export async function setUsagePrefs(patch: Partial<UsagePrefs>) {
  const next = { ...get().usagePrefs, ...patch };
  set({ usagePrefs: next });
  await ipc.setSetting("usage", JSON.stringify(next)).catch(() => {});
}

// ---------- app ----------

/** Save every unsaved file, then quit; stays open if any save fails. */
export async function saveAllAndQuit() {
  if (await files.saveAll()) await ipc.quit();
}

export function requestQuit() {
  if (hasRunningWork(runningWork())) set({ dialog: { type: "quit" } });
  else void ipc.quit();
}

/** Chat tab of the current workspace (General has only Chat). */
export function openChat() {
  const s = get();
  set({ screen: "workspace", focusSessionId: null, paletteOpen: false });
  if (s.workspace === "project" && s.activeProjectId) setView(s.activeProjectId, "chat");
}

export function selectGeneral() {
  set({ workspace: "general", screen: "workspace", focusSessionId: null });
}

/** Agent edits are on disk: refresh editor models, tree and index now (the watcher follows). */
function agentChangedFiles(projectId: string, paths: string[], conversationId: string) {
  fsChanged({ projectId, paths });
  set((st) => {
    const next = { ...st.aiChanged };
    for (const p of paths) next[`${projectId}:${p}`] = conversationId;
    return { aiChanged: next };
  });
}

/**
 * Opens a terminal in the project and types `command` at its prompt without
 * pressing Enter: AgentHub never runs a command it prefills. Line breaks and
 * control characters are removed so nothing can execute on its own.
 */
export async function prefillTerminal(projectId: string, command: string) {
  const safe = command.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  if (!safe) return;
  const info = await spawnShell(projectId);
  if (!info) return;
  setView(projectId, "terminals");
  const started = Date.now();
  // Wait for the shell's prompt (status running and the first output) before typing.
  const tick = () => {
    const s = get().sessions[info.id];
    if (s?.status === "running" && Date.now() - started > 600) {
      void ipc.write(info.id, safe).catch(() => {});
      toast("Command typed into the terminal. Press Enter to run it.");
    } else if (!s || s.status === "exited" || s.status === "failed" || Date.now() - started > 8000) {
      toast("The terminal didn't start; the command wasn't typed.", "warn");
    } else {
      window.setTimeout(tick, 150);
    }
  };
  window.setTimeout(tick, 150);
}
