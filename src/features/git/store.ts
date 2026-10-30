// Source control UI state per project. The repository is the source of
// truth; this caches the last status and what the sidebar is doing.
import { create } from "zustand";
import { defaultGitPrefs, type GitInfo, type GitPrefs, type GitStatus } from "@/lib/types";

export type GitBusy = "fetch" | "pull" | "push" | "publish" | "commit" | "continue" | "abort" | "trust";

/** A Source control banner (`saveAll` offers to save unsaved editor files). */
export interface GitBanner {
  tone: "danger" | "warn";
  title: string;
  text: string;
  detail?: string | null;
  action?: "pullAndPush" | "saveAll";
}

export interface ProjectGit {
  status: GitStatus | null;
  loading: boolean;
  busy: GitBusy | null;
  opId: string | null;
  /** Last progress or hook output line of `busy`. */
  progress: string | null;
  banner: GitBanner | null;
  msg: string;
  msgErr: string | null;
  amend: boolean;
  /** Add the co-author trailer to the next commit. */
  trailer: boolean;
  /** Path with an inline confirm open (`discard`, or `markers` = stage with conflict markers). */
  ask: { path: string; kind: "discard" | "markers" } | null;
  /** Abort needs a second click. */
  confirmAbort: boolean;
}

export interface GitState {
  projects: Record<string, ProjectGit>;
  info: GitInfo | null;
  prefs: GitPrefs;
}

export const emptyProjectGit = (prefs: GitPrefs = defaultGitPrefs): ProjectGit => ({
  status: null,
  loading: false,
  busy: null,
  opId: null,
  progress: null,
  banner: null,
  msg: "",
  msgErr: null,
  amend: false,
  trailer: prefs.coAuthorTrailer,
  ask: null,
  confirmAbort: false,
});

export const initialGitState = (): GitState => ({ projects: {}, info: null, prefs: defaultGitPrefs });

export const useGit = create<GitState>(initialGitState);
export const setGit = useGit.setState;
export const getGit = useGit.getState;

export function projectGit(s: GitState, projectId: string): ProjectGit {
  return s.projects[projectId] ?? emptyProjectGit(s.prefs);
}

export function updateGit(projectId: string, patch: Partial<ProjectGit> | ((p: ProjectGit) => Partial<ProjectGit>)) {
  setGit((s) => {
    const cur = projectGit(s, projectId);
    const next = typeof patch === "function" ? patch(cur) : patch;
    return { projects: { ...s.projects, [projectId]: { ...cur, ...next } } };
  });
}
