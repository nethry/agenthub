import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { GitEntry, GitStatus } from "@/lib/types";

// App-level actions pull in Monaco and xterm; components only need their names here.
vi.mock("@/app/actions", () => ({ openFile: vi.fn() }));
vi.mock("@/lib/ipc", () => ({ ipc: { gitStatus: () => new Promise(() => {}) }, onGitChanged: () => Promise.resolve(() => {}), gitChannel: vi.fn() }));
const { SourceControlView } = await import("./SourceControl");
const { emptyProjectGit } = await import("./store");
const view = (patch: Partial<ReturnType<typeof emptyProjectGit>>) => renderToStaticMarkup(<SourceControlView projectId="p1" width={308} g={{ ...emptyProjectGit(), ...patch }} />);

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
  toplevel: "C:/dev/agenthub",
  prefix: "",
  head: { branch: "main", oid: "f3c8a10aaaaaaaa", detached: false, unborn: false },
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

describe("Source control sidebar", () => {
  it("renders sync, commit box, staged and changes with AI and PART badges", () => {
    const html = view({
      status: status({
        entries: [
          entry("src-tauri/src/terminals/manager.rs", { index: "M", worktree: "M", partiallyStaged: true }),
          entry("src/lib/legacyPresets.ts", { worktree: "D" }),
          entry("src-tauri/src/commands/terminals.rs", { worktree: "?", untracked: true }),
        ],
        ai: [{ path: "src-tauri/src/terminals/manager.rs", engine: "codex", engineLabel: "OpenAI Codex", conversationId: "c1" }],
      }),
      msg: "feat(terminals): restart exited sessions",
    });
    expect(html).toContain("Source control");
    expect(html).toContain("↓1");
    expect(html).toContain("↑2");
    expect(html).toContain("⇄ origin/main");
    expect(html).toContain("Staged changes · 1");
    expect(html).toContain("Changes · 3");
    expect(html).toContain("PART");
    expect(html).toContain(">AI<");
    expect(html).toContain("Add AI co-author trailer");
    expect(html).toContain("OPENAI CODEX");
    expect(html).toContain("Commit 1 file to main");
    expect(html).toContain("40/72");
  });

  it("shows the stopped-pull banner with Continue and Abort, and the not-a-repo state", () => {
    const html = view({
      status: status({ operation: { kind: "rebase", step: 1, total: 2, headName: "main" }, entries: [entry("a.ts", { conflict: "UU", index: "U", worktree: "U" })] }),
    });
    expect(html).toContain("Pull stopped");
    expect(html).toContain("step 1 of 2");
    expect(html).toContain("Conflicts · 1");
    expect(html).toContain("Continue");
    expect(html).toContain("Abort");

    expect(view({ status: status({ state: "none" }) })).toContain("Not a Git repository");
  });
});
