// Backlog flows that span the backend, this store and Chat. Chat is reached
// only through its actions: an AI action opens a new project chat with the
// instruction, the item's context and its screenshots in the draft, and the
// user sends it (nothing runs on its own).
import { useEffect } from "react";
import { set as setApp, setView, toast } from "@/app/store";
import { composerConfig, engineInfo, newChat, requestMode, setDraft, setOnBacklogSent } from "@/features/chat/actions";
import { MAX_IMAGES, workspaceKey } from "@/features/chat/models";
import { draftKey, getChat, setChat } from "@/features/chat/store";
import { errorMessage, ipc } from "@/lib/ipc";
import type { BacklogItem, BacklogKind, BacklogPatch, BacklogPurpose, BacklogRef, BacklogStatus, NewBacklogItem } from "@/lib/types";
import { readDataUrl } from "@/lib/utils";
import { actionPrompt, itemKey, PURPOSE, screenshotPasteError, SCREENSHOTS_PER_ADD, screenshotsForMessage, startsWork } from "./model";
import { getBacklog, setBacklog, type Selection } from "./store";

// ---------- loading ----------

export async function loadBacklog(projectId: string) {
  if (getBacklog().loading[projectId]) return;
  setBacklog((s) => ({ loading: { ...s.loading, [projectId]: true } }));
  try {
    const items = await ipc.backlogList(projectId);
    setBacklog((s) => ({ items: { ...s.items, [projectId]: items } }));
  } catch (e) {
    toast(`Couldn't load the backlog: ${errorMessage(e)}`, "danger");
  } finally {
    setBacklog((s) => ({ loading: { ...s.loading, [projectId]: false } }));
  }
}

/** Loads a project's backlog once (the Backlog view, linked-chat chips). */
export function useProjectBacklog(projectId: string | null) {
  useEffect(() => {
    if (projectId && !getBacklog().items[projectId]) void loadBacklog(projectId);
  }, [projectId]);
}

function upsert(item: BacklogItem) {
  setBacklog((s) => {
    const cur = s.items[item.projectId] ?? [];
    const has = cur.some((i) => i.id === item.id);
    const items = has ? cur.map((i) => (i.id === item.id ? item : i)) : [item, ...cur];
    return { items: { ...s.items, [item.projectId]: items }, error: null };
  });
}

function findItem(id: string): BacklogItem | undefined {
  for (const list of Object.values(getBacklog().items)) {
    const hit = list.find((i) => i.id === id);
    if (hit) return hit;
  }
  return undefined;
}

async function run<T>(what: string, f: () => Promise<T>): Promise<T | null> {
  try {
    return await f();
  } catch (e) {
    setBacklog({ error: `${what}: ${errorMessage(e)}` });
    return null;
  }
}

// ---------- selection ----------

export function select(projectId: string, selection: Selection) {
  setBacklog((s) => ({ selection: { ...s.selection, [projectId]: selection }, error: null }));
}

/** Shows an item in the Backlog view (from a chat's item chip). */
export function openItem(item: BacklogItem) {
  setView(item.projectId, "backlog");
  select(item.projectId, { item: item.id });
}

export function startCreate(projectId: string, kind: BacklogKind) {
  setView(projectId, "backlog");
  select(projectId, { create: kind });
}

// ---------- items ----------

/** Creates the item, then stores the screenshots pasted into the form. */
export async function createItem(item: NewBacklogItem, screenshots: File[]): Promise<BacklogItem | null> {
  const created = await run("Couldn't create the item", () => ipc.backlogCreate(item));
  if (!created) return null;
  upsert(created);
  select(created.projectId, { item: created.id });
  if (screenshots.length) await addScreenshots(created, screenshots);
  return created;
}

export async function updateItem(id: string, patch: BacklogPatch) {
  const item = await run("Couldn't save the item", () => ipc.backlogUpdate(id, patch));
  if (item) upsert(item);
  return item;
}

export async function setStatus(id: string, status: BacklogStatus) {
  const item = await run("Couldn't change the status", () => ipc.backlogSetStatus(id, status));
  if (item) upsert(item);
  return item;
}

export async function savePlan(id: string, plan: string | null) {
  const item = await run("Couldn't save the plan", () => ipc.backlogSetPlan(id, plan));
  if (item) upsert(item);
  return item;
}

/** Saves a plan from a chat (Plan card or answer) to its linked item. */
export async function savePlanFromChat(item: BacklogItem, plan: string) {
  const saved = await savePlan(item.id, plan);
  if (saved) toast(`Saved as the plan of ${itemKey(saved)}`);
  else toast(getBacklog().error ?? "Couldn't save the plan", "danger");
}

export function confirmDelete(id: string) {
  setApp({ dialog: { type: "deleteBacklogItem", itemId: id } });
}

export async function deleteItem(id: string) {
  const item = findItem(id);
  const ok = await run("Couldn't delete the item", () => ipc.backlogDelete(id));
  if (ok === null || !item) return;
  setBacklog((s) => ({
    items: {
      ...s.items,
      [item.projectId]: (s.items[item.projectId] ?? []).filter((i) => i.id !== id).map((i) => ({ ...i, related: i.related.filter((r) => r !== id) })),
    },
    selection: { ...s.selection, [item.projectId]: null },
  }));
}

export function dismissSuggestion(id: string, status: BacklogStatus) {
  setBacklog((s) => ({ dismissed: { ...s.dismissed, [id]: status } }));
}

// ---------- screenshots ----------

export async function addScreenshots(item: BacklogItem, files: File[]) {
  const problem = screenshotPasteError(files, item.images.length);
  if (problem) {
    setBacklog({ error: problem });
    return;
  }
  let have = item.images.length;
  for (let i = 0; i < files.length; i += SCREENSHOTS_PER_ADD) {
    const batch = files.slice(i, i + SCREENSHOTS_PER_ADD);
    const images = await run("Couldn't read the screenshot", () =>
      Promise.all(batch.map(async (f, j) => ({ name: `Screenshot ${have + j + 1}`, data: (await readDataUrl(f)).split(",", 2)[1] ?? "" }))),
    );
    if (!images) return;
    const updated = await run("Couldn't add the screenshot", () => ipc.backlogAddImages(item.id, images));
    if (!updated) return;
    upsert(updated);
    have = updated.images.length;
  }
}

export async function removeScreenshot(imageId: string) {
  const item = await run("Couldn't remove the screenshot", () => ipc.backlogRemoveImage(imageId));
  if (item) upsert(item);
}

// ---------- AI actions ----------

/**
 * Opens a new project chat for `purpose`: the mode it needs (Agent waits for
 * the usual inline confirmation), the instruction in the composer, the item's
 * context as a chip and its newest screenshots as pasted images. The user
 * reviews and sends it.
 */
export async function startAiAction(item: BacklogItem, purpose: BacklogPurpose) {
  const projectId = item.projectId;
  const key = draftKey(workspaceKey(projectId), null);
  setView(projectId, "chat");
  newChat(projectId);
  const want = PURPOSE[purpose].mode;
  if (composerConfig(getChat(), projectId).mode !== want) requestMode(want, projectId);
  setDraft(key, actionPrompt(item, purpose));
  setChat((s) => ({ backlog: { ...s.backlog, [key]: { itemId: item.id, purpose } }, images: { ...s.images, [key]: [] } }));

  const s = getChat();
  const engine = composerConfig(s, projectId).engine;
  if (!item.images.length || engineInfo(s, engine)?.capabilities.images === false) return;
  const pick = screenshotsForMessage(item.images, MAX_IMAGES);
  try {
    const urls = await Promise.all(pick.map((img) => ipc.backlogImage(img.id)));
    setChat((st) => {
      // The user may have sent or switched the draft meanwhile.
      if (st.backlog[key]?.itemId !== item.id) return {};
      const added = pick.map((img, i) => ({ id: crypto.randomUUID(), name: img.name, mime: img.mime, size: img.size, url: urls[i] }));
      return { images: { ...st.images, [key]: added } };
    });
  } catch (e) {
    toast(`Couldn't attach the item's screenshots: ${errorMessage(e)}`, "warn");
  }
}

/** After a message about an item was sent: record the work and refresh its links. */
async function backlogSent(ref: BacklogRef) {
  const item = findItem(ref.itemId);
  if (!item) return;
  if (startsWork(ref.purpose, item.status)) await setStatus(item.id, "in_progress");
  const fresh = await ipc.backlogList(item.projectId).catch(() => null);
  if (fresh) setBacklog((s) => ({ items: { ...s.items, [item.projectId]: fresh } }));
}

setOnBacklogSent((ref) => void backlogSent(ref));
