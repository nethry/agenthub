import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GitEntry, GitStatus } from "@/lib/types";

// The backend is mocked: these tests cover the Source control flows only.
const ipcMock = vi.hoisted(() => ({
  gitStatus: vi.fn(),
  gitStage: vi.fn(),
  gitDiscard: vi.fn(),
  gitCommit: vi.fn(),
  gitPush: vi.fn(),
  gitPull: vi.fn(),
  gitPublish: vi.fn(),
  gitHeadMessage: vi.fn(),
  setSetting: vi.fn(),
}));

vi.mock("@/lib/ipc", () => ({
  ipc: ipcMock,
  gitChannel: (onLine: unknown) => ({ onLine }),
  onGitChanged: () => Promise.resolve(() => {}),
  errorMessage: (e: unknown) => (e && typeof e === "object" && "message" in e ? String((e as { message: string }).message) : String(e)),
  errorKind: (e: unknown) => (e && typeof e === "object" && "kind" in e ? String((e as { kind: string }).kind) : null),
  errorDetail: () => null,
}));

const actions = await import("./actions");
const { getGit, initialGitState, setGit, updateGit } = await import("./store");
const { useApp } = await import("@/app/store");

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
  head: { branch: "main", oid: "f3c8a10aaaaaaaa", detached: false, unborn: false },
  upstream: "origin/main",
  upstreamGone: false,
  ahead: 1,
  behind: 0,
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

const tree = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  setGit(initialGitState(), true);
  useApp.setState({ dirty: {}, toasts: [] });
  actions.onGitTreeChanged(tree);
});

describe("source control actions", () => {
  it("commits the staged files with the agents' trailer, then resets the box", async () => {
    const staged = entry("src/manager.rs", { index: "M", worktree: "." });
    updateGit("p1", {
      status: status({ entries: [staged], ai: [{ path: "src/manager.rs", engine: "codex", engineLabel: "OpenAI Codex", conversationId: "c1" }] }),
      msg: "feat: restart sessions",
    });
    ipcMock.gitCommit.mockResolvedValue(status({ ahead: 2 }));
    await actions.commit("p1");
    expect(ipcMock.gitCommit).toHaveBeenCalledWith("p1", "feat: restart sessions", false, ["Co-authored-by: OpenAI Codex <noreply@openai.com>"], expect.anything());
    const g = getGit().projects.p1;
    expect(g.msg).toBe("");
    expect(g.status?.ahead).toBe(2);
    expect(g.busy).toBeNull();
  });

  it("won't commit without staged files or a message, and leaves the trailer out when turned off", async () => {
    updateGit("p1", { status: status({ entries: [entry("a.ts")] }), msg: "x" });
    await actions.commit("p1");
    expect(ipcMock.gitCommit).not.toHaveBeenCalled();
    expect(getGit().projects.p1.msgErr).toMatch(/Nothing staged/);

    updateGit("p1", { status: status({ entries: [entry("a.ts", { index: "M", worktree: "." })], ai: [{ path: "a.ts", engine: "codex", engineLabel: "OpenAI Codex", conversationId: "c" }] }), msg: "  " });
    await actions.commit("p1");
    expect(getGit().projects.p1.msgErr).toMatch(/message/);
    updateGit("p1", { msg: "fix", trailer: false });
    ipcMock.gitCommit.mockResolvedValue(status());
    await actions.commit("p1");
    expect(ipcMock.gitCommit.mock.calls[0][3]).toEqual([]);
  });

  it("passes unsaved editor files to a discard and reloads the file after", async () => {
    updateGit("p1", { status: status({ entries: [entry("a.ts")] }) });
    useApp.setState({ dirty: { "p1:other.ts": true, "p2:a.ts": true } });
    ipcMock.gitDiscard.mockResolvedValue(status());
    await actions.discardFile("p1", "a.ts");
    expect(ipcMock.gitDiscard).toHaveBeenCalledWith("p1", ["a.ts"], ["other.ts"], true);
    expect(tree).toHaveBeenCalledWith({ projectId: "p1", paths: ["a.ts"] });
  });

  it("shows the unsaved-buffers banner instead of a toast", async () => {
    updateGit("p1", { status: status() });
    ipcMock.gitPull.mockRejectedValue({ kind: "git_unsaved_buffers", message: "Save or discard your editor changes to a.ts first." });
    ipcMock.gitStatus.mockResolvedValue(status());
    await actions.pull("p1");
    expect(getGit().projects.p1.banner).toMatchObject({ action: "saveAll", tone: "warn" });
  });

  it("turns a rejected push into the Pull & push banner, which pulls then pushes", async () => {
    updateGit("p1", { status: status({ ahead: 1 }) });
    ipcMock.gitPush.mockRejectedValueOnce({ kind: "git_push_rejected", message: "rejected" });
    ipcMock.gitStatus.mockResolvedValue(status({ ahead: 1, behind: 1 }));
    await actions.push("p1");
    expect(getGit().projects.p1.banner).toMatchObject({ action: "pullAndPush", title: "Push rejected." });

    ipcMock.gitPull.mockResolvedValue(status({ ahead: 1, behind: 0 }));
    ipcMock.gitPush.mockResolvedValue(status({ ahead: 0 }));
    await actions.pullAndPush("p1");
    expect(ipcMock.gitPull).toHaveBeenCalled();
    expect(ipcMock.gitPush).toHaveBeenCalledTimes(2);
    expect(tree).toHaveBeenCalledWith({ projectId: "p1", paths: [], overflow: true });
    expect(getGit().projects.p1.banner).toBeNull();
  });

  it("publishes a branch without upstream, and asks before staging conflict markers", async () => {
    updateGit("p1", { status: status({ upstream: null }) });
    ipcMock.gitPublish.mockResolvedValue(status({ upstream: "origin/feature" }));
    await actions.push("p1");
    expect(ipcMock.gitPublish).toHaveBeenCalled();

    ipcMock.gitStage.mockRejectedValueOnce({ kind: "git_markers", message: "store.ts still has conflict markers" });
    await actions.stageFiles("p1", ["store.ts"]);
    expect(getGit().projects.p1.ask).toEqual({ path: "store.ts", kind: "markers" });
    ipcMock.gitStage.mockResolvedValue(status());
    await actions.stageFiles("p1", ["store.ts"], true);
    expect(ipcMock.gitStage).toHaveBeenLastCalledWith("p1", ["store.ts"], true);
    expect(getGit().projects.p1.ask).toBeNull();
  });
});
