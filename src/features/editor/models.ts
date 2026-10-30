// Open files are Monaco models kept outside React. The store only tracks
// which ones are dirty, their Markdown view and whether the disk copy moved on.
import { monaco, languageFor } from "./monaco";
import { errorKind, errorMessage, ipc } from "@/lib/ipc";
import type { FileContent, FsChange } from "@/lib/types";
import { basename, dirname } from "@/lib/utils";
import { fileKey, get, set, toast } from "@/app/store";

export interface FileMeta {
  key: string;
  projectId: string;
  path: string;
  model: monaco.editor.ITextModel;
  savedVersion: number;
  mtimeMs: number;
  hasBom: boolean;
  encoding: string;
  readOnly: boolean;
  lineEnding: "LF" | "CRLF";
  /** Set after a save hit an external change; the next save overwrites. */
  conflict: boolean;
  viewState: monaco.editor.ICodeEditorViewState | null;
}

export interface FileError {
  kind: string | null;
  message: string;
}

/** Offered by "Reopen with encoding". Any WHATWG label works on the backend. */
export const ENCODINGS = [
  { id: "utf-8", label: "UTF-8" },
  { id: "utf-16le", label: "UTF-16 LE" },
  { id: "utf-16be", label: "UTF-16 BE" },
  { id: "windows-1252", label: "Western (Windows-1252)" },
  { id: "windows-1250", label: "Central European (Windows-1250)" },
  { id: "iso-8859-2", label: "Central European (ISO-8859-2)" },
  { id: "windows-1251", label: "Cyrillic (Windows-1251)" },
  { id: "shift_jis", label: "Japanese (Shift JIS)" },
  { id: "gbk", label: "Chinese (GBK)" },
] as const;

export function encodingLabel(id: string, hasBom: boolean): string {
  const base = id.toUpperCase();
  return id === "utf-8" && hasBom ? "UTF-8 BOM" : base;
}

const metas = new Map<string, FileMeta>();
const pending = new Map<string, Promise<FileMeta>>();

export function getMeta(projectId: string, path: string): FileMeta | undefined {
  return metas.get(fileKey(projectId, path));
}

type KeyedRecord = "dirty" | "mdView" | "diskState";

function dropKeys(key: string, records: KeyedRecord[] = ["dirty", "mdView", "diskState"]) {
  const s = get();
  const patch: Partial<Record<KeyedRecord, Record<string, unknown>>> = {};
  for (const r of records) {
    if (!(key in s[r])) continue;
    const next = { ...s[r] };
    delete next[key];
    patch[r] = next;
  }
  if (Object.keys(patch).length) set(patch as never);
}

function setDiskState(meta: FileMeta, state: "changed" | "deleted" | null) {
  if ((get().diskState[meta.key] ?? null) === state) return;
  if (state === null) dropKeys(meta.key, ["diskState"]);
  else set((s) => ({ diskState: { ...s.diskState, [meta.key]: state } }));
}

function syncDirty(meta: FileMeta) {
  const dirty = meta.model.getAlternativeVersionId() !== meta.savedVersion;
  const has = !!get().dirty[meta.key];
  if (dirty === has) return;
  if (dirty) set((s) => ({ dirty: { ...s.dirty, [meta.key]: true } }));
  else dropKeys(meta.key, ["dirty"]);
}

const eolOf = (le: "LF" | "CRLF") =>
  le === "CRLF" ? monaco.editor.EndOfLineSequence.CRLF : monaco.editor.EndOfLineSequence.LF;

function createMeta(projectId: string, path: string, content: string, eol: "LF" | "CRLF"): FileMeta {
  const uri = monaco.Uri.file(`/${projectId}/${path}`);
  monaco.editor.getModel(uri)?.dispose();
  const model = monaco.editor.createModel(content, languageFor(path), uri);
  model.setEOL(eolOf(eol));
  const meta: FileMeta = {
    key: fileKey(projectId, path),
    projectId,
    path,
    model,
    savedVersion: model.getAlternativeVersionId(),
    mtimeMs: 0,
    hasBom: false,
    encoding: "utf-8",
    readOnly: false,
    lineEnding: eol,
    conflict: false,
    viewState: null,
  };
  model.onDidChangeContent(() => syncDirty(meta));
  return meta;
}

function applyDiskInfo(meta: FileMeta, file: FileContent) {
  meta.mtimeMs = file.mtimeMs;
  meta.hasBom = file.hasBom;
  meta.encoding = file.encoding;
  meta.readOnly = file.readOnly;
  meta.lineEnding = file.lineEnding;
  meta.conflict = false;
}

/** Replace the model's text with the disk copy, keeping undo history. */
function applyContent(meta: FileMeta, file: FileContent) {
  const { model } = meta;
  model.setEOL(eolOf(file.lineEnding));
  if (model.getValue() !== file.content) {
    model.pushStackElement();
    model.pushEditOperations([], [{ range: model.getFullModelRange(), text: file.content }], () => null);
    model.pushStackElement();
  }
  applyDiskInfo(meta, file);
  meta.savedVersion = model.getAlternativeVersionId();
  syncDirty(meta);
  setDiskState(meta, null);
}

export function loadFile(projectId: string, path: string, encoding?: string): Promise<FileMeta> {
  const key = fileKey(projectId, path);
  const existing = metas.get(key);
  if (existing) return Promise.resolve(existing);
  const inflight = pending.get(key);
  if (inflight) return inflight;

  const p = ipc
    .readFile(projectId, path, encoding)
    .then((file) => {
      const meta = createMeta(projectId, path, file.content, file.lineEnding);
      applyDiskInfo(meta, file);
      metas.set(key, meta);
      return meta;
    })
    .finally(() => pending.delete(key));
  pending.set(key, p);
  return p;
}

/** Re-read a file with a chosen encoding. Refused while it has unsaved edits. */
export async function reopenWithEncoding(projectId: string, path: string, encoding: string): Promise<FileMeta | null> {
  if (isDirty(projectId, path)) {
    toast(`Save or discard your changes to ${basename(path)} before reopening it.`, "warn");
    return null;
  }
  const meta = getMeta(projectId, path);
  if (!meta) return loadFile(projectId, path, encoding);
  try {
    applyContent(meta, await ipc.readFile(projectId, path, encoding));
    return meta;
  } catch (e) {
    toast(`Couldn't reopen ${basename(path)} as ${encoding.toUpperCase()}: ${errorMessage(e)}`, "danger");
    return null;
  }
}

/** Discard local edits and load the disk copy. */
export async function reloadFromDisk(projectId: string, path: string) {
  const meta = getMeta(projectId, path);
  if (!meta) return;
  try {
    applyContent(meta, await ipc.readFile(projectId, path, meta.encoding));
  } catch (e) {
    toast(`Couldn't reload ${basename(path)}: ${errorMessage(e)}`, "danger");
  }
}

/** Keep the local edits; the next save overwrites the disk copy. */
export function keepLocalChanges(projectId: string, path: string) {
  const meta = getMeta(projectId, path);
  if (!meta) return;
  meta.conflict = true;
  setDiskState(meta, null);
}

export function isDirty(projectId: string, path: string): boolean {
  return !!get().dirty[fileKey(projectId, path)];
}

export async function saveFile(projectId: string, path: string): Promise<boolean> {
  const meta = getMeta(projectId, path);
  if (!meta) return true;
  if (meta.readOnly) {
    toast(`${basename(path)} is open read-only because it is large.`, "warn");
    return false;
  }
  const version = meta.model.getAlternativeVersionId();
  try {
    if (get().diskState[meta.key] === "deleted") {
      await ipc.createEntry(projectId, dirname(path), basename(path), false).catch(() => {});
      meta.conflict = true;
    }
    const res = await ipc.writeFile(
      projectId,
      path,
      meta.model.getValue(),
      meta.encoding,
      meta.hasBom,
      meta.conflict ? null : meta.mtimeMs,
    );
    meta.mtimeMs = res.mtimeMs;
    meta.savedVersion = version;
    meta.conflict = false;
    syncDirty(meta);
    setDiskState(meta, null);
    return true;
  } catch (e) {
    if (errorKind(e) === "conflict") {
      meta.conflict = true;
      setDiskState(meta, "changed");
      toast(`${path} changed on disk. Press Ctrl+S again to overwrite it.`, "warn");
    } else {
      toast(`Couldn't save ${path}: ${errorMessage(e)}`, "danger");
    }
    return false;
  }
}

/** Compare an open file with its disk copy after a watcher event. */
async function checkDisk(meta: FileMeta) {
  let file: FileContent;
  try {
    file = await ipc.readFile(meta.projectId, meta.path, meta.encoding);
  } catch (e) {
    if (errorKind(e) === "not_found" && metas.get(meta.key) === meta) setDiskState(meta, "deleted");
    return;
  }
  if (metas.get(meta.key) !== meta) return;
  if (file.mtimeMs === meta.mtimeMs) {
    if (get().diskState[meta.key] === "deleted") setDiskState(meta, null);
    return;
  }
  if (isDirty(meta.projectId, meta.path)) {
    // Our own copy is newer in the user's eyes; let them decide.
    if (file.content !== meta.model.getValue()) setDiskState(meta, "changed");
    else applyDiskInfo(meta, file);
    return;
  }
  applyContent(meta, file);
}

const under = (path: string, prefix: string) => path === prefix || path.startsWith(prefix + "/");

/** React to `fs-changed`: reload clean files, flag dirty or deleted ones. */
export function handleFsChange(change: FsChange) {
  for (const meta of metas.values()) {
    if (meta.projectId !== change.projectId) continue;
    if (change.overflow || change.paths.some((p) => under(meta.path, p))) void checkDisk(meta);
  }
}

/** Open files at or under `path`, e.g. before a folder is renamed or deleted. */
export function openFilesUnder(projectId: string, path: string): FileMeta[] {
  return [...metas.values()].filter((m) => m.projectId === projectId && under(m.path, path));
}

/**
 * Move open files after a rename on disk, keeping their text and unsaved
 * state. Returns the old → new path pairs that moved.
 */
export function moveFiles(projectId: string, from: string, to: string): [string, string][] {
  const moved: [string, string][] = [];
  for (const meta of openFilesUnder(projectId, from)) {
    const newPath = to + meta.path.slice(from.length);
    const wasDirty = isDirty(projectId, meta.path);
    const disk = get().diskState[meta.key];
    const mdView = get().mdView[meta.key];
    const next = createMeta(projectId, newPath, meta.model.getValue(), meta.lineEnding);
    next.mtimeMs = meta.mtimeMs;
    next.hasBom = meta.hasBom;
    next.encoding = meta.encoding;
    next.readOnly = meta.readOnly;
    next.conflict = meta.conflict;
    next.viewState = meta.viewState;
    if (wasDirty) next.savedVersion = -1;
    disposeFile(projectId, meta.path);
    metas.set(next.key, next);
    set((s) => ({
      dirty: wasDirty ? { ...s.dirty, [next.key]: true } : s.dirty,
      diskState: disk ? { ...s.diskState, [next.key]: disk } : s.diskState,
      mdView: mdView ? { ...s.mdView, [next.key]: mdView } : s.mdView,
    }));
    moved.push([meta.path, newPath]);
  }
  return moved;
}

/** Flag open files under a deleted path; returns the clean ones to close. */
export function markDeleted(projectId: string, path: string): string[] {
  const clean: string[] = [];
  for (const meta of openFilesUnder(projectId, path)) {
    if (isDirty(projectId, meta.path)) setDiskState(meta, "deleted");
    else clean.push(meta.path);
  }
  return clean;
}

export function disposeFile(projectId: string, path: string) {
  const key = fileKey(projectId, path);
  metas.get(key)?.model.dispose();
  metas.delete(key);
  dropKeys(key);
}

export function disposeProject(projectId: string) {
  for (const meta of [...metas.values()]) {
    if (meta.projectId === projectId) disposeFile(projectId, meta.path);
  }
}

/** Unsaved open files, optionally for one project. */
export function dirtyFiles(projectId?: string): FileMeta[] {
  const dirty = get().dirty;
  return [...metas.values()].filter((m) => dirty[m.key] && (!projectId || m.projectId === projectId));
}

/** Save every unsaved file (optionally one project's). True when all saved. */
export async function saveAll(projectId?: string): Promise<boolean> {
  let ok = true;
  for (const meta of dirtyFiles(projectId)) ok = (await saveFile(meta.projectId, meta.path)) && ok;
  return ok;
}

export function cursorInfo(meta: FileMeta | undefined, editor: monaco.editor.ICodeEditor | null) {
  const pos = editor?.getPosition();
  return {
    line: pos?.lineNumber ?? 1,
    col: pos?.column ?? 1,
    eol: meta?.model.getEOL() === "\r\n" ? "CRLF" : "LF",
  };
}
