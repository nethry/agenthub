import { describe, expect, it } from "vitest";
import { activityTitle, statusLabel } from "./status";

describe("statusLabel", () => {
  it("splits running by activity", () => {
    expect(statusLabel({ status: "running", exitCode: null, activity: "busy" })).toBe("Busy");
    expect(statusLabel({ status: "running", exitCode: null, activity: "idle" })).toBe("Idle");
    expect(statusLabel({ status: "running", exitCode: null, activity: null })).toBe("Running");
    expect(statusLabel({ status: "exited", exitCode: 2, activity: null })).toBe("Exit 2");
  });
});

describe("activityTitle", () => {
  it("names the source of the reading", () => {
    expect(activityTitle({ status: "running", exitCode: null, activity: "idle", activitySource: "shell" })).toMatch(/prompt/);
    expect(activityTitle({ status: "running", exitCode: null, activity: "busy", activitySource: "output" })).toMatch(/output/);
    expect(activityTitle({ status: "exited", exitCode: 0, activity: null, activitySource: null })).toBeUndefined();
  });
});
