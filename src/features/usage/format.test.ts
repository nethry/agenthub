import { describe, expect, it } from "vitest";
import { alertKey, current, duration, level, resetText, syncedText } from "./format";

const prefs = { warnAt: 80, alertAt: 95 };

describe("level", () => {
  it("follows the thresholds", () => {
    expect(level(79.4, prefs)).toBe("normal");
    expect(level(80, prefs)).toBe("warn");
    expect(level(99.9, prefs)).toBe("warn");
    expect(level(100, prefs)).toBe("limit");
    expect(level(70, { warnAt: 60 })).toBe("warn");
  });
});

describe("duration", () => {
  it("formats words and clock styles", () => {
    expect(duration(108 * 60_000)).toBe("1H 48M");
    expect(duration(42 * 60_000)).toBe("42M");
    expect(duration(42 * 60_000, "clock")).toBe("0:42");
    expect(duration(30 * 3_600_000)).toBe("1D 6H");
    expect(duration(-5)).toBe("0M");
  });
});

describe("resetText", () => {
  const now = new Date(2026, 9, 21, 12, 42).getTime(); // Wed
  it("uses a countdown within a day and a weekday later", () => {
    expect(resetText(new Date(2026, 9, 21, 14, 30).getTime(), now)).toBe("RESETS IN 1H 48M · 14:30");
    expect(resetText(new Date(2026, 9, 26, 9, 0).getTime(), now)).toBe("RESETS MON 09:00");
    expect(resetText(now + 42 * 60_000, now, true)).toBe("RESETS IN 0:42");
    expect(resetText(null, now)).toBe("RESET TIME UNKNOWN");
  });
});

describe("current", () => {
  it("drops windows that already reset", () => {
    const w = { usedPercent: 62, resetsAt: 1000, windowMins: 300 };
    expect(current(w, 999)).toBe(w);
    expect(current(w, 1000)).toBeNull();
    expect(current({ ...w, resetsAt: null }, 5000)).not.toBeNull();
  });
});

describe("syncedText", () => {
  it("reads like the design", () => {
    expect(syncedText(1_000_000, 1_000_000 + 30_000)).toBe("SYNCED JUST NOW");
    expect(syncedText(1_000_000, 1_000_000 + 60_000)).toBe("SYNCED 1 MIN AGO");
    expect(syncedText(1_000_000, 1_000_000 + 3 * 3_600_000)).toBe("SYNCED 3 H AGO");
    expect(syncedText(null, 5)).toBe("NOT SYNCED");
  });
});

describe("alertKey", () => {
  it("fires once per window and level", () => {
    const w = (p: number) => ({ usedPercent: p, resetsAt: 77, windowMins: 300 });
    expect(alertKey("openai", "session", w(90), prefs)).toBeNull();
    expect(alertKey("openai", "session", w(96), prefs)).toBe("openai:session:77:alert");
    expect(alertKey("openai", "weekly", w(100), prefs)).toBe("openai:weekly:77:limit");
  });
});
