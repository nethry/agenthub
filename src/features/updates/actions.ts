// Update flows. Nothing downloads or restarts by itself: a check only
// announces a version, the user starts the download, and installing (which ends
// the app) happens only from the confirmed restart dialog.
import { set, toast } from "@/app/store";
import { errorMessage, ipc, onUpdateAvailable, updateChannel } from "@/lib/ipc";
import type { UpdateInfo, UpdatePrefs } from "@/lib/types";
import { getUpdates, setUpdates } from "./store";

let listening = false;

/** Listens for the daily check's result and picks up an update downloaded earlier in this run. */
export async function startUpdateEvents() {
  if (listening) return;
  listening = true;
  await onUpdateAvailable((info) => announce(info));
  const ready = await ipc.updateDownloaded().catch(() => null);
  if (ready) setUpdates({ state: "ready", info: ready, progress: null, error: null });
}

export function setUpdatePrefs(prefs: UpdatePrefs) {
  setUpdates({ prefs });
}

export async function saveUpdatePrefs(patch: Partial<UpdatePrefs>) {
  const prefs = { ...getUpdates().prefs, ...patch };
  setUpdates({ prefs });
  await ipc.setSetting("updates", JSON.stringify(prefs)).catch((e) => toast(`Couldn't save update settings: ${errorMessage(e)}`, "danger"));
}

/** A version was found: show it unless the user skipped it, or one is already further along. */
function announce(info: UpdateInfo, manual = false) {
  const cur = getUpdates();
  // Never knock a download that is under way (or ready) back to "available".
  if ((cur.state === "downloading" || cur.state === "ready") && cur.info?.version === info.version) return;
  if (!manual && cur.prefs.skipped === info.version) {
    setUpdates({ state: "idle", info: null });
    return;
  }
  setUpdates({ state: "available", info, progress: null, error: null });
}

/** The Check now button. */
export async function checkForUpdates() {
  const cur = getUpdates();
  if (cur.state === "checking" || cur.state === "downloading") return;
  setUpdates({ state: "checking", error: null });
  try {
    const info = await ipc.updateCheck();
    setUpdates({ checkedAt: Date.now() });
    if (info) {
      announce(info, true);
      toast(`AgentHub ${info.version} is available`);
    } else {
      setUpdates({ state: "idle", info: null });
      toast("AgentHub is up to date");
    }
  } catch (e) {
    setUpdates({ state: "error", error: errorMessage(e), checkedAt: Date.now() });
  }
}

export function openUpdateDialog() {
  set({ dialog: { type: "update" } });
}

/** Downloads and verifies the update; installing waits for a confirmed restart. */
export async function downloadUpdate() {
  const cur = getUpdates();
  if (cur.state !== "available" || !cur.info) return;
  setUpdates({ state: "downloading", progress: { downloaded: 0, total: null }, error: null });
  try {
    const info = await ipc.updateDownload(updateChannel((progress) => setUpdates({ progress })));
    setUpdates({ state: "ready", info, progress: null });
  } catch (e) {
    setUpdates({ state: "error", error: errorMessage(e), progress: null });
  }
}

/** Ends terminals and chat turns, then installs; on success the app closes and the new version opens. */
export async function installAndRestart() {
  try {
    await ipc.updateInstall();
  } catch (e) {
    setUpdates({ state: "error", error: errorMessage(e) });
  }
}

/** Stop being told about this version (a newer one still shows). */
export async function skipVersion() {
  const info = getUpdates().info;
  if (!info) return;
  await saveUpdatePrefs({ skipped: info.version });
  setUpdates({ state: "idle", info: null, progress: null });
  set({ dialog: null });
}

/** After an error: go back to where the update was. */
export function dismissUpdateError() {
  const cur = getUpdates();
  setUpdates({ error: null, state: cur.info ? "available" : "idle" });
}
