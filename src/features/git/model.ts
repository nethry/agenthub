// Pure Source control helpers (no React, no IPC): list grouping, status
// letters, the co-author trailer, readouts.
import type { EngineId, GitAiChange, GitEntry, GitStatus } from "@/lib/types";
import { basename, relativeAgo } from "@/lib/utils";

export type Area = "conflicts" | "staged" | "changes";

export interface Groups {
  conflicts: GitEntry[];
  staged: GitEntry[];
  changes: GitEntry[];
}

/** Conflicts first; a partially staged file is in both Staged and Changes. */
export function groups(entries: GitEntry[]): Groups {
  const out: Groups = { conflicts: [], staged: [], changes: [] };
  for (const e of entries) {
    if (e.conflict) out.conflicts.push(e);
    else {
      if (!e.untracked && e.index !== ".") out.staged.push(e);
      if (e.untracked || e.worktree !== ".") out.changes.push(e);
    }
  }
  const byPath = (a: GitEntry, b: GitEntry) => a.path.localeCompare(b.path);
  out.conflicts.sort(byPath);
  out.staged.sort(byPath);
  out.changes.sort(byPath);
  return out;
}

/** The letter a row shows: `M` modified, `A`/`U` added/untracked, `D` deleted, `R` renamed, `C` conflict. */
export function letter(e: GitEntry, area: Area): string {
  if (area === "conflicts") return "C";
  if (area === "staged") return e.index === "T" ? "M" : e.index;
  if (e.untracked) return "U";
  return e.worktree === "T" ? "M" : e.worktree;
}

export const LETTER_TONE: Record<string, string> = {
  M: "text-warn",
  T: "text-warn",
  A: "text-run",
  U: "text-run",
  D: "text-danger",
  C: "text-danger",
  R: "text-accent",
};

export const LETTER_TITLE: Record<string, string> = {
  M: "Modified",
  A: "Added",
  U: "Untracked",
  D: "Deleted",
  C: "Conflict",
  R: "Renamed",
};

/** Letter per project-relative path for the file tree (staged or not). */
export function treeLetters(status: GitStatus | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!status || status.state !== "ok") return out;
  for (const e of status.entries) {
    if (!e.projectPath) continue;
    out[e.projectPath] = e.conflict ? "C" : e.untracked ? "U" : e.worktree !== "." ? letter(e, "changes") : letter(e, "staged");
  }
  return out;
}

/** Vendor noreply addresses for `Co-authored-by` (git trailers need `Name <email>`). */
export const ENGINE_EMAIL: Record<EngineId, string> = {
  "claude-code": "noreply@anthropic.com",
  codex: "noreply@openai.com",
  "gemini-cli": "noreply@google.com",
  antigravity: "noreply@google.com",
  "copilot-cli": "noreply@github.com",
  "openai-api": "noreply@openai.com",
  "anthropic-api": "noreply@anthropic.com",
  "gemini-api": "noreply@google.com",
};

/** Agents whose uncommitted changes are among the staged files, once each. */
export function stagedAgents(ai: GitAiChange[], staged: GitEntry[]): GitAiChange[] {
  const paths = new Set(staged.map((e) => e.path));
  const seen = new Set<string>();
  return ai.filter((a) => paths.has(a.path) && !seen.has(a.engineLabel) && seen.add(a.engineLabel));
}

export function trailers(agents: GitAiChange[]): string[] {
  return agents.map((a) => `Co-authored-by: ${a.engineLabel} <${ENGINE_EMAIL[a.engine]}>`);
}

/** Length of the subject line (the 72-character guide counts only it). */
export function subjectLength(msg: string): number {
  return msg.split(/\r?\n/, 1)[0].length;
}

export function shortHash(oid: string | null | undefined): string {
  return oid ? oid.slice(0, 7) : "";
}

/** `main`, or `HEAD (detached at f3c8a10)`. */
export function branchLabel(s: GitStatus): string {
  if (s.head.detached) return `HEAD (detached at ${shortHash(s.head.oid)})`;
  return s.head.branch ?? "HEAD";
}

/** `⇄ origin/main · FETCHED 12 MIN AGO`, `NOT PUBLISHED · …`, `DETACHED HEAD · …`. */
export function syncLine(s: GitStatus, now: number): string {
  const fetched = s.lastFetch ? `FETCHED ${relativeAgo(s.lastFetch, now).toUpperCase()}` : "NOT FETCHED YET";
  if (s.head.detached) return `DETACHED HEAD · ${fetched}`;
  if (s.upstreamGone) return `${s.upstream} IS GONE · ${fetched}`;
  if (!s.upstream) return s.remotes.length ? `NOT PUBLISHED · ${fetched}` : "NO REMOTE";
  return `⇄ ${s.upstream} · ${fetched}`;
}

/** Why Commit can't run now (shown under the button); `null` when it can. */
export function commitBlocker(s: GitStatus, g: Groups, amend: boolean): string | null {
  if (s.head.detached) return "You are on a detached HEAD. Create a branch to keep new commits.";
  if (g.conflicts.length) return s.operation ? "Fix the conflicts, stage the files, then Continue." : "Resolve the conflicts first.";
  if (s.operation) return `Continue or abort the ${OPERATION_LABEL[s.operation.kind]} before committing.`;
  if (!g.staged.length && !amend) return g.changes.length ? "Nothing staged yet." : "No changes to commit.";
  return null;
}

export const OPERATION_LABEL: Record<NonNullable<GitStatus["operation"]>["kind"], string> = {
  rebase: "rebase",
  merge: "merge",
  cherry_pick: "cherry-pick",
  revert: "revert",
  am: "patch",
};

/** Inline confirmation text for discarding a row in Changes. */
export function discardCopy(e: GitEntry): { text: string; action: string } {
  const name = basename(e.path);
  if (e.untracked) return { text: `Delete untracked ${name}? It isn’t in Git. It goes to the Recycle Bin.`, action: "Delete file" };
  if (e.worktree === "D") return { text: `Restore ${name} from Git?`, action: "Restore" };
  return { text: `Discard unstaged changes to ${name}? The current file goes to the Recycle Bin.`, action: "Discard" };
}

/** `"Committed f3c8a10 to main"`-style counts. */
export function files(n: number): string {
  return `${n} file${n === 1 ? "" : "s"}`;
}
