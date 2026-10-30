// Source control flows. Git runs in the backend; these call it, keep the
// sidebar state and tell the rest of the app which files changed. Every
// operation that rewrites the working tree passes the unsaved editor files, so
// the backend can refuse instead of overwriting them.
import { get as getApp, toast } from "@/app/store";
import { onFsChange } from "@/features/explorer/fsEvents";
import { errorDetail, errorKind, errorMessage, gitChannel, ipc, onGitChanged } from "@/lib/ipc";
import type { GitPrefs, GitStatus } from "@/lib/types";
import { basename } from "@/lib/utils";
import { branchLabel, commitBlocker, files, groups, shortHash, stagedAgents, trailers } from "./model";
import { getGit, projectGit, setGit, updateGit, type GitBanner, type GitBusy } from "./store";

// ---------- wiring ----------

type TreeChanged = (change: { projectId: string; paths: string[]; overflow?: boolean }) => void;
let treeChanged: TreeChanged = () => {};

/** The app passes its `fsChanged` so editors, tree and palette reload after git rewrote files. */
export function onGitTreeChanged(cb: TreeChanged) {
  treeChanged = cb;
}

let listening = false;
const timers = new Map<string, ReturnType<typeof setTimeout>>();

/** Refresh on git-dir changes (any tool) and on edits in the working tree. */
export async function startGitEvents() {
  if (listening) return;
  listening = true;
  await onGitChanged((c) => scheduleRefresh(c.projectId, 50));
  onFsChange((c) => scheduleRefresh(c.projectId, 400));
}

function scheduleRefresh(projectId: string, delay: number) {
  if (!getGit().projects[projectId]) return; // never shown: nothing to keep fresh
  clearTimeout(timers.get(projectId));
  timers.set(
    projectId,
    setTimeout(() => {
      timers.delete(projectId);
      void refreshStatus(projectId);
    }, delay),
  );
}

export function setGitPrefs(prefs: GitPrefs) {
  setGit({ prefs });
}

export async function saveGitPrefs(patch: Partial<GitPrefs>) {
  const prefs = { ...getGit().prefs, ...patch };
  setGit({ prefs });
  await ipc.setSetting("git", JSON.stringify(prefs)).catch((e) => toast(`Couldn't save Git settings: ${errorMessage(e)}`, "danger"));
}

// ---------- status ----------

const inflight = new Map<string, Promise<void>>();

export function refreshStatus(projectId: string): Promise<void> {
  const running = inflight.get(projectId);
  if (running) return running;
  updateGit(projectId, { loading: true });
  const p = ipc
    .gitStatus(projectId)
    .then((status) => updateGit(projectId, (cur) => ({ status, loading: false, ask: keepAsk(cur.ask, status) })))
    .catch((e) => {
      updateGit(projectId, { loading: false });
      toast(`Couldn't read the Git status: ${errorMessage(e)}`, "danger");
    })
    .finally(() => inflight.delete(projectId));
  inflight.set(projectId, p);
  return p;
}

function keepAsk(ask: ReturnType<typeof projectGit>["ask"], status: GitStatus) {
  return ask && status.entries.some((e) => e.path === ask.path) ? ask : null;
}

export async function loadGitInfo(refresh = false) {
  try {
    setGit({ info: await ipc.gitInfo(refresh) });
  } catch (e) {
    toast(errorMessage(e), "danger");
  }
}

export async function setGitPath(path: string | null) {
  try {
    setGit({ info: await ipc.gitSetPath(path) });
    for (const id of Object.keys(getGit().projects)) void refreshStatus(id);
  } catch (e) {
    toast(errorMessage(e), "danger");
  }
}

/** Project-relative paths of unsaved editor files in a project. */
export function dirtyPaths(projectId: string): string[] {
  const prefix = `${projectId}:`;
  return Object.keys(getApp().dirty)
    .filter((k) => k.startsWith(prefix))
    .map((k) => k.slice(prefix.length));
}

function applied(projectId: string, status: GitStatus, patch: Partial<ReturnType<typeof projectGit>> = {}) {
  updateGit(projectId, { status, ...patch });
}

/** Errors with a banner of their own; the rest become toasts. */
function failed(projectId: string, e: unknown, what: string) {
  const kind = errorKind(e);
  const message = errorMessage(e);
  if (kind === "git_unsaved_buffers") {
    setBanner(projectId, { tone: "warn", title: "Unsaved editor changes.", text: message, action: "saveAll" });
  } else if (kind === "git_push_rejected") {
    setBanner(projectId, {
      tone: "danger",
      title: "Push rejected.",
      text: `${upstreamOf(projectId)} has commits you don't have. Pull with rebase, then push again.`,
      action: "pullAndPush",
    });
    toast("Push rejected — pull first", "danger");
  } else if (kind === "git_cancelled") {
    toast(message, "warn");
  } else {
    const detail = errorDetail(e);
    if (detail && kind !== "git_markers") setBanner(projectId, { tone: "danger", title: `Couldn't ${what}.`, text: message, detail });
    else toast(message, "danger");
  }
}

function upstreamOf(projectId: string): string {
  return projectGit(getGit(), projectId).status?.upstream ?? "The remote";
}

export function setBanner(projectId: string, banner: GitBanner | null) {
  updateGit(projectId, { banner });
}

let opSeq = 0;

/** Runs one long operation at a time per project, with progress lines. */
async function run(projectId: string, busy: GitBusy, what: string, fn: (opId: string, onLine: (line: string) => void) => Promise<GitStatus>): Promise<GitStatus | null> {
  if (projectGit(getGit(), projectId).busy) return null;
  const opId = `git-${Date.now()}-${++opSeq}`;
  updateGit(projectId, { busy, opId, progress: null, banner: null });
  try {
    const status = await fn(opId, (line) => updateGit(projectId, { progress: line }));
    applied(projectId, status);
    return status;
  } catch (e) {
    failed(projectId, e, what);
    void refreshStatus(projectId);
    return null;
  } finally {
    updateGit(projectId, { busy: null, opId: null, progress: null });
  }
}

export function cancelGitOperation(projectId: string) {
  const opId = projectGit(getGit(), projectId).opId;
  if (opId) void ipc.gitCancel(opId);
}

// ---------- files ----------

export async function stageFiles(projectId: string, paths: string[], confirmed = false) {
  try {
    applied(projectId, await ipc.gitStage(projectId, paths, confirmed), { ask: null, msgErr: null });
  } catch (e) {
    if (errorKind(e) === "git_markers" && paths.length === 1) updateGit(projectId, { ask: { path: paths[0], kind: "markers" } });
    else failed(projectId, e, "stage the files");
  }
}

export async function unstageFiles(projectId: string, paths: string[]) {
  try {
    applied(projectId, await ipc.gitUnstage(projectId, paths));
  } catch (e) {
    failed(projectId, e, "unstage the files");
  }
}

export async function stageAll(projectId: string) {
  try {
    applied(projectId, await ipc.gitStageAll(projectId), { msgErr: null });
  } catch (e) {
    failed(projectId, e, "stage all changes");
  }
}

export async function unstageAll(projectId: string) {
  try {
    applied(projectId, await ipc.gitUnstageAll(projectId));
  } catch (e) {
    failed(projectId, e, "unstage all changes");
  }
}

export function askDiscard(projectId: string, path: string | null) {
  updateGit(projectId, { ask: path ? { path, kind: "discard" } : null });
}

export async function discardFile(projectId: string, path: string) {
  const entry = projectGit(getGit(), projectId).status?.entries.find((e) => e.path === path);
  try {
    const status = await ipc.gitDiscard(projectId, [path], dirtyPaths(projectId), true);
    applied(projectId, status, { ask: null });
    if (entry?.projectPath) treeChanged({ projectId, paths: [entry.projectPath] });
    toast(`Discarded changes in ${basename(path)} · the old file is in the Recycle Bin`, "warn");
  } catch (e) {
    updateGit(projectId, { ask: null });
    failed(projectId, e, "discard the changes");
  }
}

// ---------- commit ----------

export function setMessage(projectId: string, msg: string) {
  updateGit(projectId, { msg, msgErr: null });
}

export function setTrailer(projectId: string, on: boolean) {
  updateGit(projectId, { trailer: on });
}

export async function toggleAmend(projectId: string) {
  const g = projectGit(getGit(), projectId);
  const s = g.status;
  if (!s) return;
  if (!g.amend && (s.headPushed || s.head.unborn)) {
    toast(s.head.unborn ? "There's no commit to amend yet" : "Last commit is already pushed — amending would rewrite shared history", "warn");
    return;
  }
  const amend = !g.amend;
  updateGit(projectId, { amend, msgErr: null });
  if (amend && !g.msg.trim()) {
    const last = await ipc.gitHeadMessage(projectId).catch(() => "");
    updateGit(projectId, (cur) => (cur.msg.trim() ? {} : { msg: last }));
  }
}

/** Commits what's staged (with the co-author trailer when agents' changes are in it), then optionally pushes. */
export async function commit(projectId: string, andPush = false) {
  const g = projectGit(getGit(), projectId);
  const s = g.status;
  if (!s || s.state !== "ok") return;
  const gr = groups(s.entries);
  const blocker = commitBlocker(s, gr, g.amend);
  if (blocker) {
    updateGit(projectId, { msgErr: gr.staged.length || g.amend ? blocker : "Nothing staged — stage files first." });
    return;
  }
  if (!g.msg.trim()) {
    updateGit(projectId, { msgErr: "Write a commit message." });
    return;
  }
  const agents = g.trailer ? stagedAgents(s.ai, gr.staged) : [];
  const amend = g.amend;
  const count = gr.staged.length;
  const done = await run(projectId, "commit", "commit", (_op, onLine) =>
    ipc.gitCommit(projectId, g.msg, amend, trailers(agents), gitChannel((p) => onLine(p.line))),
  );
  if (!done) return;
  updateGit(projectId, { msg: "", amend: false, msgErr: null, trailer: getGit().prefs.coAuthorTrailer });
  toast(`${amend ? "Amended" : "Committed"} ${shortHash(done.head.oid)} to ${branchLabel(done)}${amend ? "" : ` · ${files(count)}`}`);
  if (andPush) await push(projectId);
}

/** "Stage all & commit" from the Nothing staged hint. */
export async function stageAllAndCommit(projectId: string) {
  await stageAll(projectId);
  if (groups(projectGit(getGit(), projectId).status?.entries ?? []).staged.length) await commit(projectId);
}

// ---------- sync ----------

export async function fetchRemotes(projectId: string) {
  const s = await run(projectId, "fetch", "fetch", (op, onLine) => ipc.gitFetch(projectId, op, gitChannel((p) => onLine(p.line))));
  if (s) toast(s.behind ? `Fetched · ${s.upstream} has ${s.behind} new commit${s.behind === 1 ? "" : "s"}` : "Fetched · up to date");
}

export async function pull(projectId: string): Promise<GitStatus | null> {
  const before = projectGit(getGit(), projectId).status;
  const s = await run(projectId, "pull", "pull", (op, onLine) => ipc.gitPull(projectId, op, dirtyPaths(projectId), gitChannel((p) => onLine(p.line))));
  if (!s) return null;
  treeChanged({ projectId, paths: [], overflow: true });
  if (s.operation) toast("Pull stopped on conflicts · fix them, stage, then Continue", "warn");
  else if (before && before.behind === 0 && s.head.oid === before.head.oid) toast("Already up to date");
  else toast(before?.ahead ? `Pulled · rebased ${before.ahead} local commit${before.ahead === 1 ? "" : "s"} onto ${s.upstream}` : "Pulled");
  return s;
}

/** Push, or Publish when the branch has no upstream yet. Never forces. */
export async function push(projectId: string) {
  const before = projectGit(getGit(), projectId).status;
  if (!before || before.state !== "ok") return;
  if (!before.upstream) return publish(projectId);
  if (before.ahead === 0) {
    toast("Nothing to push");
    return;
  }
  const s = await run(projectId, "push", "push", (op, onLine) => ipc.gitPush(projectId, op, gitChannel((p) => onLine(p.line))));
  if (s) toast(`Pushed ${before.ahead} commit${before.ahead === 1 ? "" : "s"} to ${s.upstream ?? "the remote"}`);
}

export async function publish(projectId: string) {
  const s = await run(projectId, "publish", "publish", (op, onLine) => ipc.gitPublish(projectId, op, gitChannel((p) => onLine(p.line))));
  if (s) toast(`Published ${s.head.branch} → ${s.upstream}`);
}

export async function pullAndPush(projectId: string) {
  setBanner(projectId, null);
  const s = await pull(projectId);
  if (s && !s.operation) await push(projectId);
}

// ---------- operation git stopped in ----------

export async function continueOperation(projectId: string) {
  const s = await run(projectId, "continue", "continue", () => ipc.gitOperationContinue(projectId, dirtyPaths(projectId)));
  if (!s) return;
  treeChanged({ projectId, paths: [], overflow: true });
  toast(s.operation ? "Stopped again on the next commit · fix, stage, then Continue" : "Done · conflicts resolved", s.operation ? "warn" : "info");
}

export async function abortOperation(projectId: string) {
  const g = projectGit(getGit(), projectId);
  if (!g.confirmAbort) {
    updateGit(projectId, { confirmAbort: true });
    return;
  }
  updateGit(projectId, { confirmAbort: false });
  const s = await run(projectId, "abort", "abort", () => ipc.gitOperationAbort(projectId, dirtyPaths(projectId), true));
  if (!s) return;
  treeChanged({ projectId, paths: [], overflow: true });
  toast("Aborted · back to where you were", "warn");
}

export function cancelAbort(projectId: string) {
  updateGit(projectId, { confirmAbort: false });
}

export async function trustFolder(projectId: string, path: string) {
  await run(projectId, "trust", "trust this folder", () => ipc.gitTrustFolder(projectId, path));
}

/** The banner's Save all: save the project's unsaved files, then retry by hand. */
export async function saveAllForGit(projectId: string) {
  const { saveAll } = await import("@/features/editor/models");
  if (await saveAll(projectId)) {
    setBanner(projectId, null);
    toast("Saved · try again");
  }
}
