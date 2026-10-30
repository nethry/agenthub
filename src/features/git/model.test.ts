import { describe, expect, it } from "vitest";
import type { GitAiChange, GitEntry, GitStatus } from "@/lib/types";
import { branchLabel, commitBlocker, discardCopy, groups, letter, stagedAgents, subjectLength, syncLine, trailers, treeLetters } from "./model";

const entry = (path: string, patch: Partial<GitEntry> = {}): GitEntry => ({
  path,
  projectPath: path,
  origPath: null,
  index: ".",
  worktree: "M",
  untracked: false,
  conflict: null,
  submodule: false,
  partiallyStaged: false,
  ...patch,
});

const status = (patch: Partial<GitStatus> = {}): GitStatus => ({
  state: "ok",
  message: null,
  trustPath: null,
  toplevel: "C:/dev/app",
  prefix: "",
  head: { branch: "main", oid: "f3c8a10aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", detached: false, unborn: false },
  upstream: "origin/main",
  upstreamGone: false,
  ahead: 2,
  behind: 1,
  stashCount: 0,
  entries: [],
  truncated: false,
  operation: null,
  headPushed: false,
  remotes: ["origin"],
  lastFetch: null,
  ai: [],
  ...patch,
});

const codex: GitAiChange = { path: "src/manager.rs", engine: "codex", engineLabel: "OpenAI Codex", conversationId: "c1" };

describe("source control model", () => {
  it("groups entries: conflicts apart, partially staged in both lists", () => {
    const g = groups([
      entry("b.ts", { index: "M", worktree: "M", partiallyStaged: true }),
      entry("a.ts", { index: "A", worktree: "." }),
      entry("new.txt", { index: ".", worktree: "?", untracked: true }),
      entry("store.ts", { index: "U", worktree: "U", conflict: "UU" }),
    ]);
    expect(g.conflicts.map((e) => e.path)).toEqual(["store.ts"]);
    expect(g.staged.map((e) => e.path)).toEqual(["a.ts", "b.ts"]);
    expect(g.changes.map((e) => e.path)).toEqual(["b.ts", "new.txt"]);
    expect(letter(g.changes[1], "changes")).toBe("U");
    expect(letter(g.staged[0], "staged")).toBe("A");
    expect(letter(g.conflicts[0], "conflicts")).toBe("C");
  });

  it("builds one co-author trailer per agent with staged changes", () => {
    const gemini: GitAiChange = { path: "src/resize.ts", engine: "gemini-cli", engineLabel: "Gemini CLI", conversationId: "c2" };
    const twice: GitAiChange = { ...codex, path: "src/commands.rs" };
    const staged = [entry("src/manager.rs", { index: "M", worktree: "." }), entry("src/commands.rs", { index: "A", worktree: "." })];
    const agents = stagedAgents([codex, twice, gemini], staged);
    expect(agents.map((a) => a.engineLabel)).toEqual(["OpenAI Codex"]);
    expect(trailers(agents)).toEqual(["Co-authored-by: OpenAI Codex <noreply@openai.com>"]);
  });

  it("explains why Commit can't run", () => {
    expect(commitBlocker(status({ head: { branch: null, oid: "abc", detached: true, unborn: false } }), groups([]), false)).toMatch(/detached HEAD/);
    const conflict = groups([entry("x", { conflict: "UU", index: "U", worktree: "U" })]);
    expect(commitBlocker(status({ operation: { kind: "rebase", step: 1, total: 2, headName: "main" } }), conflict, false)).toMatch(/Continue/);
    expect(commitBlocker(status(), groups([entry("a")]), false)).toBe("Nothing staged yet.");
    expect(commitBlocker(status(), groups([]), false)).toBe("No changes to commit.");
    expect(commitBlocker(status(), groups([]), true)).toBeNull();
    expect(commitBlocker(status(), groups([entry("a", { index: "M", worktree: "." })]), false)).toBeNull();
  });

  it("formats branch and sync readouts", () => {
    expect(branchLabel(status())).toBe("main");
    expect(branchLabel(status({ head: { branch: null, oid: "f3c8a10ffff", detached: true, unborn: false } }))).toBe("HEAD (detached at f3c8a10)");
    const now = Date.now();
    expect(syncLine(status({ lastFetch: now - 12 * 60_000 }), now)).toBe("⇄ origin/main · FETCHED 12 MIN AGO");
    expect(syncLine(status({ upstream: null }), now)).toBe("NOT PUBLISHED · NOT FETCHED YET");
    expect(syncLine(status({ upstream: null, remotes: [] }), now)).toBe("NO REMOTE");
  });

  it("words the discard confirmation by status and maps tree letters", () => {
    expect(discardCopy(entry("a.txt", { untracked: true, worktree: "?" })).action).toBe("Delete file");
    expect(discardCopy(entry("a.txt", { worktree: "D" })).action).toBe("Restore");
    expect(discardCopy(entry("a.txt")).action).toBe("Discard");
    const s = status({
      prefix: "app/",
      entries: [entry("app/a.ts", { projectPath: "a.ts" }), entry("other/b.ts", { projectPath: null }), entry("app/n.ts", { projectPath: "n.ts", untracked: true, worktree: "?" })],
    });
    expect(treeLetters(s)).toEqual({ "a.ts": "M", "n.ts": "U" });
    expect(subjectLength("feat: x\n\nbody")).toBe(7);
  });
});
