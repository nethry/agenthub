import { describe, expect, it } from "vitest";
import type { Conversation, EngineInfo, SessionInfo } from "@/lib/types";
import { overviewChat, overviewSessions, rootReadme } from "./model";

const conversation = (id: string, patch: Partial<Conversation> = {}): Conversation => ({
  id, projectId: "p", title: id, engine: "codex", model: "test", mode: "plan", policy: "ask",
  status: "idle", runtimeSessionId: null, createdAt: 0, updatedAt: 0, ...patch,
});
// Selection needs only ids; no terminal runtime is created by these tests.
const sessions = (...ids: string[]) => ids.map((id) => ({ id }) as SessionInfo);

describe("Overview session placement", () => {
  it("keeps both panes stationary when the second pane receives focus", () => {
    expect(overviewSessions(sessions("a", "b", "c"), ["a", "b"], "b")).toEqual(["a", "b"]);
  });
  it("reveals a newly started session and retains another live pane", () => {
    expect(overviewSessions(sessions("a", "b", "c"), ["a", "b"], "c")).toEqual(["c", "a"]);
  });
  it("drops closed or foreign-project sessions and never duplicates hosts", () => {
    expect(overviewSessions(sessions("b", "c"), ["a", "b", "b"], "a")).toEqual(["b", "c"]);
    expect(overviewSessions(sessions("b"), ["b", "b"], "b")).toEqual(["b"]);
    expect(overviewSessions([], ["a", "b"], "a")).toEqual([]);
  });
});

describe("Overview chat selection", () => {
  it("retains the selected conversation and exposes other approvals separately", () => {
    const selected = conversation("selected");
    const approval = conversation("approval", { status: "waiting_for_approval", updatedAt: 10 });
    const result = overviewChat("p", [selected, approval], [], "selected", { approval: "request" });
    expect(result.conversation).toEqual(selected);
    expect(result.attention).toEqual([approval]);
  });
  it("prefers running work to recent idle work when the selection is absent", () => {
    const running = conversation("running", { status: "running" });
    expect(overviewChat("p", [conversation("recent", { updatedAt: 10 }), running], [], null, {}).conversation).toEqual(running);
  });
  it("excludes other projects and disabled integrations, including stale selections", () => {
    const disabled = { engine: "codex", enabled: false } as EngineInfo;
    const eligible = conversation("eligible", { engine: "gemini-cli" });
    const result = overviewChat("p", [conversation("hidden", { status: "waiting_for_approval" }), conversation("other", { projectId: "other" }), eligible], [disabled], "hidden", {});
    expect(result.conversation).toEqual(eligible);
    expect(result.attention).toEqual([]);
  });
});

it("finds a root README case-insensitively without selecting dependency docs", () => {
  expect(rootReadme(["docs/README.md", "AGENTS.md", "readme.markdown", "README.MD"])).toBe("README.MD");
  expect(rootReadme(["docs/README.md", "README.txt"])).toBeNull();
});
