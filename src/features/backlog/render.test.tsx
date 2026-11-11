import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { BacklogItem, ChatMessage, Conversation } from "@/lib/types";

// App-level actions pull in Monaco and xterm; components only need their names here.
vi.mock("@/app/actions", () => ({ openFile: vi.fn(), prefillTerminal: vi.fn() }));
const { BacklogView } = await import("./BacklogView");
const { ItemDetail } = await import("./ItemDetail");
const { useBacklog } = await import("./store");
const { useChat } = await import("@/features/chat/store");

// Server rendering reads a store's initial state, so tests seed that object.
const setBacklog = (patch: object) => Object.assign(useBacklog.getInitialState(), patch);
const setChat = (patch: object) => Object.assign(useChat.getInitialState(), patch);
const { UserMessage } = await import("@/features/chat/ChatMessage");
const { LinkedItemChip } = await import("./ChatLinks");

const item = (patch: Partial<BacklogItem> = {}): BacklogItem => ({
  id: "i1",
  projectId: "p1",
  seq: 1,
  kind: "feature",
  title: "Dark mode",
  body: "## Goal\n\nAll views dark.",
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

const conv = (patch: Partial<Conversation> = {}): Conversation => ({
  id: "c1",
  projectId: "p1",
  title: "Plan dark mode",
  engine: "codex",
  model: "m",
  mode: "plan",
  policy: "ask",
  status: "completed",
  runtimeSessionId: null,
  createdAt: 0,
  updatedAt: 0,
  ...patch,
});

describe("Backlog view", () => {
  it("groups open items by status with kind, key and status, and hides closed ones", () => {
    setBacklog({
      items: {
        p1: [
          item(),
          item({ id: "i2", seq: 2, kind: "bug", title: "Crash on save", status: "in_progress", priority: "high", images: [{ id: "x", name: "s", mime: "image/png", size: 1, createdAt: 0 }] }),
          item({ id: "i3", seq: 3, title: "Shipped", status: "done" }),
        ],
      },
      selection: {},
    });
    const html = renderToStaticMarkup(<BacklogView projectId="p1" />);
    expect(html).toContain("New feature");
    expect(html).toContain("Report bug");
    expect(html.indexOf("In progress")).toBeLessThan(html.indexOf("Dark mode"));
    expect(html).toContain("BUG-2 · Bug");
    expect(html).toContain("· 1 IMG");
    expect(html).toContain("Idea");
    expect(html).not.toContain("Shipped");
    expect(html).toContain("Closed (1)");
  });

  it("shows an item with its actions, plan, screenshots, related items and chats", () => {
    const bug = item({ id: "i2", seq: 2, kind: "bug", title: "Crash on save" });
    const feature = item({
      plan: "1. Tokens",
      related: ["i2"],
      links: [{ conversationId: "c1", purpose: "plan", createdAt: 1 }],
    });
    setChat({ conversations: [conv()], engines: [] });
    const html = renderToStaticMarkup(<ItemDetail item={feature} items={[feature, bug]} />);
    expect(html).toContain("FEAT-1");
    expect(html).toContain(">Plan<");
    expect(html).toContain(">Implement<");
    expect(html).not.toContain(">Fix<");
    expect(html).toContain("A plan is saved.");
    expect(html).toContain("Mark as Planned");
    expect(html).toContain("<li>Tokens</li>");
    expect(html).toContain("Paste a screenshot with Ctrl V");
    expect(html).toContain("BUG-2</span> Crash on save");
    expect(html).toContain("Plan dark mode");
  });

  it("offers Investigate and Fix for a bug", () => {
    const bug = item({ kind: "bug" });
    const html = renderToStaticMarkup(<ItemDetail item={bug} items={[bug]} />);
    expect(html).toContain(">Investigate<");
    expect(html).toContain(">Fix<");
    expect(html).toContain("Report");
  });
});

describe("Chat links", () => {
  it("shows the context a message carried and the item a chat came from", () => {
    const message: ChatMessage = {
      id: "m1",
      conversationId: "c1",
      role: "user",
      content: "Plan it",
      status: "complete",
      engine: null,
      model: null,
      error: null,
      usage: null,
      items: [
        {
          id: "x",
          messageId: "m1",
          idx: 0,
          status: "completed",
          body: { kind: "backlog_context", itemId: "i1", label: "FEAT-1 · Dark mode", text: "<backlog_context>…</backlog_context>" },
          createdAt: 0,
          updatedAt: 0,
        },
      ],
      createdAt: 0,
    };
    expect(renderToStaticMarkup(<UserMessage message={message} />)).toContain("FEAT-1 · Dark mode · BACKLOG CONTEXT");

    setBacklog({ items: { p1: [item({ links: [{ conversationId: "c1", purpose: "plan", createdAt: 1 }] })] } });
    expect(renderToStaticMarkup(<LinkedItemChip conv={conv()} />)).toContain("FEAT-1");
    expect(renderToStaticMarkup(<LinkedItemChip conv={conv({ id: "other" })} />)).toBe("");
  });
});
