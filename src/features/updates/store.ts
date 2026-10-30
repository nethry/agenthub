// Update UI state. The backend owns checking, downloading and installing;
// this mirrors where that stands for the badge, the dialog and Settings.
import { create } from "zustand";
import { defaultUpdatePrefs, type UpdateInfo, type UpdatePrefs, type UpdateProgress } from "@/lib/types";

export type UpdateState = "idle" | "checking" | "available" | "downloading" | "ready" | "error";

export interface UpdatesState {
  state: UpdateState;
  info: UpdateInfo | null;
  progress: UpdateProgress | null;
  /** Last error of a manual check, download or install. */
  error: string | null;
  /** When the last check finished in this session (epoch ms). */
  checkedAt: number | null;
  prefs: UpdatePrefs;
}

export const initialUpdatesState = (): UpdatesState => ({
  state: "idle",
  info: null,
  progress: null,
  error: null,
  checkedAt: null,
  prefs: defaultUpdatePrefs,
});

export const useUpdates = create<UpdatesState>(initialUpdatesState);
export const setUpdates = useUpdates.setState;
export const getUpdates = useUpdates.getState;

/** A new version is waiting for the user (badge on). */
export const updatePending = (s: Pick<UpdatesState, "state">) => s.state === "available" || s.state === "downloading" || s.state === "ready";
