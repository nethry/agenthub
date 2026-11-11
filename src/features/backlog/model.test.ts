import { describe, expect, it } from "vitest";
import type { BacklogItem } from "@/lib/types";
import {
  actionPrompt,
  actionsFor,
  closedCount,
  defaultFilter,
  groupItems,
  groupLabel,
  itemKey,
  screenshotPasteError,
  screenshotsForMessage,
  startsWork,
  statusLabel,
  suggestion,
} from "./model";

const item = (patch: Partial<BacklogItem> = {}): BacklogItem => ({
  id: "i1",
  projectId: "p",
  seq: 1,
  kind: "feature",
  title: "Dark mode",
  body: "",
  status: "open",
  priority: "normal",
  plan: null,
  related: [],
  images: [],
  links: [],
  createdAt: 0,
  updatedAt: 0,
  ...patch,
});

describe("labels", () => {
  it("names statuses per kind and keys items", () => {
    expect(statusLabel("feature", "open")).toBe("Idea");
    expect(statusLabel("bug", "open")).toBe("Reported");
    expect(statusLabel("bug", "planned")).toBe("Diagnosed");
    expect(statusLabel("bug", "done")).toBe("Fixed");
    expect(statusLabel("feature", "dropped")).toBe("Won't do");
    expect(groupLabel("open", "all")).toBe("New");
    expect(groupLabel("open", "bug")).toBe("Reported");
    expect(itemKey({ kind: "feature", seq: 12 })).toBe("FEAT-12");
    expect(itemKey({ kind: "bug", seq: 7 })).toBe("BUG-7");
  });
});

describe("grouping", () => {
  const items = [
    item({ id: "a", seq: 1, status: "open", priority: "low" }),
    item({ id: "b", seq: 2, status: "open", priority: "high" }),
    item({ id: "c", seq: 3, status: "in_progress", kind: "bug", title: "Crash", body: "on save" }),
    item({ id: "d", seq: 4, status: "done" }),
    item({ id: "e", seq: 5, status: "open", priority: "high" }),
  ];

  it("orders by status, then priority, then newest; hides closed items by default", () => {
    const groups = groupItems(items, defaultFilter());
    expect(groups.map((g) => [g.status, g.items.map((i) => i.id)])).toEqual([
      ["in_progress", ["c"]],
      ["open", ["e", "b", "a"]],
    ]);
    expect(closedCount(items, "all")).toBe(1);
    expect(groupItems(items, { ...defaultFilter(), showClosed: true }).map((g) => g.status)).toEqual(["in_progress", "open", "done"]);
  });

  it("filters by kind and searches titles, bodies and keys", () => {
    expect(groupItems(items, { ...defaultFilter(), kind: "bug" }).flatMap((g) => g.items.map((i) => i.id))).toEqual(["c"]);
    expect(groupItems(items, { ...defaultFilter(), query: "on SAVE" }).flatMap((g) => g.items.map((i) => i.id))).toEqual(["c"]);
    expect(groupItems(items, { ...defaultFilter(), query: "feat-5" }).flatMap((g) => g.items.map((i) => i.id))).toEqual(["e"]);
  });
});

describe("AI actions", () => {
  it("offers Plan/Implement for features and Investigate/Fix for bugs", () => {
    expect(actionsFor("feature")).toEqual(["plan", "implement"]);
    expect(actionsFor("bug")).toEqual(["investigate", "fix"]);
  });

  it("prefills an instruction naming the item and its saved plan", () => {
    expect(actionPrompt(item(), "plan")).toContain("Plan the implementation of FEAT-1 “Dark mode”");
    expect(actionPrompt(item(), "plan")).toContain("other backlog items");
    expect(actionPrompt(item(), "implement")).not.toContain("saved plan");
    expect(actionPrompt(item({ plan: "1. x" }), "implement")).toContain("following its saved plan");
    expect(actionPrompt(item({ kind: "bug", seq: 3 }), "investigate")).toContain("Don't change files yet");
  });

  it("only Implement and Fix start work, and only on items not started yet", () => {
    expect(startsWork("implement", "open")).toBe(true);
    expect(startsWork("fix", "planned")).toBe(true);
    expect(startsWork("plan", "open")).toBe(false);
    expect(startsWork("implement", "review")).toBe(false);
  });
});

describe("suggestions", () => {
  it("suggests Planned once a plan is saved", () => {
    expect(suggestion(item({ plan: "1. x" }), [])?.status).toBe("planned");
    expect(suggestion(item({ plan: "1. x", status: "planned" }), [])).toBeNull();
  });

  it("suggests Review when the latest Implement/Fix chat completed, never Done", () => {
    const links = [
      { conversationId: "plan", purpose: "plan" as const, createdAt: 1 },
      { conversationId: "impl", purpose: "implement" as const, createdAt: 2 },
    ];
    const it2 = item({ status: "in_progress", links });
    expect(suggestion(it2, [{ id: "impl", status: "running" }])).toBeNull();
    expect(suggestion(it2, [{ id: "impl", status: "completed" }])?.status).toBe("review");
    expect(suggestion(item({ status: "review", links }), [{ id: "impl", status: "completed" }])).toBeNull();
  });
});

describe("screenshots", () => {
  const png = { type: "image/png", size: 1000 };
  it("checks count, type and size like the backend", () => {
    expect(screenshotPasteError([png], 7)).toBeNull();
    expect(screenshotPasteError([png, png], 7)).toContain("up to 8");
    expect(screenshotPasteError([{ type: "image/svg+xml", size: 10 }], 0)).toContain("PNG, JPEG, GIF or WebP");
    expect(screenshotPasteError([{ type: "image/png", size: 6 * 1024 * 1024 }], 0)).toContain("5 MB");
  });

  it("sends the newest screenshots with a message", () => {
    const imgs = [1, 5, 3, 4, 2].map((t) => ({ id: `i${t}`, createdAt: t }));
    expect(screenshotsForMessage(imgs, 4).map((i) => i.id)).toEqual(["i5", "i4", "i3", "i2"]);
  });
});
