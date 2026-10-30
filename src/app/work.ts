// What quitting or restarting would interrupt. Quit and Update both ask this,
// so an update restart is exactly as careful as closing the app.
import { useShallow } from "zustand/react/shallow";
import { getChat, useChat } from "@/features/chat/store";
import { getGit, useGit } from "@/features/git/store";
import type { SessionInfo } from "@/lib/types";
import { get, isLive, useApp } from "./store";

export interface RunningWork {
  /** Terminal sessions that are starting or running. */
  sessions: SessionInfo[];
  /** Chat turns in flight. */
  turns: number;
  /** Editor files with unsaved changes. */
  unsaved: number;
  /** Git operations running (fetch, pull, push, commit…). */
  gitOps: number;
}

export function runningWork(): RunningWork {
  return {
    sessions: Object.values(get().sessions).filter(isLive),
    turns: Object.keys(getChat().requests).length,
    unsaved: Object.keys(get().dirty).length,
    gitOps: Object.values(getGit().projects).filter((p) => p.busy).length,
  };
}

export const hasRunningWork = (w: RunningWork) => w.sessions.length > 0 || w.turns > 0 || w.unsaved > 0 || w.gitOps > 0;

/** `runningWork()` kept live for dialogs. */
export function useRunningWork(): RunningWork {
  const sessions = useApp(useShallow((s) => Object.values(s.sessions).filter(isLive)));
  const unsaved = useApp((s) => Object.keys(s.dirty).length);
  const turns = useChat((s) => Object.keys(s.requests).length);
  const gitOps = useGit((s) => Object.values(s.projects).filter((p) => p.busy).length);
  return { sessions, turns, unsaved, gitOps };
}

/** One sentence per thing that would be interrupted, for Quit and Update dialogs. */
export function interruptions(w: RunningWork, verb: "Quitting" | "Restarting"): string[] {
  return [
    w.sessions.length > 0 && `${verb} ends ${w.sessions.length === 1 ? "this terminal session" : `these ${w.sessions.length} terminal sessions`}.`,
    w.turns > 0 && `${w.turns} chat turn${w.turns === 1 ? "" : "s"} stop; partial answers and changes so far are kept.`,
    w.gitOps > 0 && `${w.gitOps === 1 ? "A Git operation is" : `${w.gitOps} Git operations are`} still running and will be stopped.`,
    w.unsaved > 0 && `${w.unsaved} unsaved file${w.unsaved === 1 ? "" : "s"} will be lost.`,
  ].filter((x): x is string => !!x);
}
