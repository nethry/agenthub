import { describe, expect, it } from "vitest";
import { fuzzyMatch, initials, joinPath, safeExternalUrl, uptime } from "./utils";

describe("joinPath", () => {
  it("uses the root's separator", () => {
    expect(joinPath("C:\\Work\\app", "src/a.ts")).toBe("C:\\Work\\app\\src\\a.ts");
    expect(joinPath("C:\\Work\\app\\", "a.ts")).toBe("C:\\Work\\app\\a.ts");
    expect(joinPath("/home/me/app", "src/a.ts")).toBe("/home/me/app/src/a.ts");
    expect(joinPath("C:\\Work\\app", "")).toBe("C:\\Work\\app");
  });
});

describe("initials", () => {
  it("uses word boundaries", () => {
    expect(initials("billing-api")).toBe("BA");
    expect(initials("docs site")).toBe("DS");
    expect(initials("agenthub")).toBe("AG");
  });
});

describe("uptime", () => {
  it("formats hours, minutes and seconds", () => {
    expect(uptime(0, (18 * 60 + 4) * 1000)).toBe("T+00:18:04");
    expect(uptime(0, 3 * 3600 * 1000, true)).toBe("T+03:00");
  });
});

describe("fuzzyMatch", () => {
  it("prefers contiguous prefix matches", () => {
    const a = fuzzyMatch("bill", "billing-api")!;
    const b = fuzzyMatch("bill", "src/components/BillingNotice.tsx")!;
    expect(a.indices).toEqual([0, 1, 2, 3]);
    expect(a.score).toBeGreaterThan(b.score);
  });
  it("matches subsequences and rejects misses", () => {
    expect(fuzzyMatch("ust", "useSession.ts")).not.toBeNull();
    expect(fuzzyMatch("zzz", "useSession.ts")).toBeNull();
  });
});

describe("safeExternalUrl", () => {
  it("only allows http(s)", () => {
    expect(safeExternalUrl("https://example.com/x")).toBe("https://example.com/x");
    expect(safeExternalUrl("file:///C:/Windows")).toBeNull();
    expect(safeExternalUrl("javascript:alert(1)")).toBeNull();
  });
});
