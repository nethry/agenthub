import { describe, expect, it } from "vitest";
import type { SessionInfo } from "@/lib/types";
import { hasRunningWork, interruptions, type RunningWork } from "./work";

const none: RunningWork = { sessions: [], turns: 0, unsaved: 0, gitOps: 0 };
const session = { id: "s1" } as SessionInfo;

describe("what a quit or restart interrupts", () => {
  it("is nothing when nothing runs", () => {
    expect(hasRunningWork(none)).toBe(false);
    expect(interruptions(none, "Restarting")).toEqual([]);
  });

  it("counts git operations like the other running work", () => {
    expect(hasRunningWork({ ...none, gitOps: 1 })).toBe(true);
    expect(interruptions({ ...none, gitOps: 1 }, "Quitting")).toEqual(["A Git operation is still running and will be stopped."]);
    expect(interruptions({ ...none, gitOps: 2 }, "Quitting")).toEqual(["2 Git operations are still running and will be stopped."]);
  });

  it("words each interruption, with the verb of the action", () => {
    const lines = interruptions({ sessions: [session, session], turns: 1, unsaved: 3, gitOps: 0 }, "Restarting");
    expect(lines).toEqual([
      "Restarting ends these 2 terminal sessions.",
      "1 chat turn stops; partial answers and changes so far are kept.".replace("stops", "stop"),
      "3 unsaved files will be lost.",
    ]);
    expect(interruptions({ ...none, sessions: [session] }, "Quitting")[0]).toBe("Quitting ends this terminal session.");
  });
});
