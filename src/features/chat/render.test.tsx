import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ChatItem, ChatMessage, Conversation } from "@/lib/types";

// App-level actions pull in Monaco and xterm; components only need their names here.
vi.mock("@/app/actions", () => ({ openFile: vi.fn(), prefillTerminal: vi.fn() }));
import { ChatMarkdown, fenceLanguage } from "./ChatMarkdown";
import { AssistantMessage, blocksOf, UserMessage } from "./ChatMessage";

const answer = (patch: Partial<ChatMessage> = {}): ChatMessage => ({
  id: "a1",
  conversationId: "c1",
  role: "assistant",
  content: "",
  status: "complete",
  engine: "openai-api",
  model: "gpt-6.1-sol",
  error: null,
  usage: null,
  items: [],
  createdAt: new Date(2026, 9, 25, 14, 2).getTime(),
  ...patch,
});

describe("answer markdown", () => {
  const md = [
    "## Recommended approach",
    "",
    "1. Observe with a `ResizeObserver`.",
    "2. Send one call.",
    "",
    "| Option | Cost |",
    "| --- | --- |",
    "| A | low |",
    "",
    "See [the docs](https://example.com/docs).",
    "",
    "```ts",
    "const x: number = 1;",
    "```",
  ].join("\n");

  it("renders headings, lists, tables, inline code, links and code blocks", () => {
    const html = renderToStaticMarkup(<ChatMarkdown text={md} />);
    expect(html).toContain("<h2>Recommended approach</h2>");
    expect(html).toContain("<ol>");
    expect(html).toContain("<code>ResizeObserver</code>");
    expect(html).toContain("<table>");
    expect(html).toContain('href="https://example.com/docs"');
    // Fenced code becomes a code block with its language and a copy action.
    expect(html).toContain("TYPESCRIPT");
    expect(html).toContain('aria-label="Copy code"');
    expect(html).toContain("const x: number = 1;");
  });

  it("never renders raw HTML or fetches images", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown text={'Hi <script>alert(1)</script> <img src="https://evil.test/x.png" onerror="alert(2)"> ![logo](https://evil.test/logo.png)'} />,
    );
    // Raw HTML shows as escaped text, never as elements.
    expect(html).not.toMatch(/<(script|img)\b/);
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("md-image");
    expect(html).toContain("logo");
  });

  it("marks a streaming answer for the caret", () => {
    expect(renderToStaticMarkup(<ChatMarkdown text="Partial" streaming />)).toContain("is-streaming");
  });

  it("reads the fence language", () => {
    expect(fenceLanguage(["language-rust"])).toBe("rust");
    expect(fenceLanguage("hljs language-ts")).toBe("ts");
    expect(fenceLanguage(undefined)).toBe("");
  });
});

const conv = (patch: Partial<Conversation> = {}): Conversation => ({
  id: "c1",
  projectId: null,
  title: "Q",
  engine: "openai-api",
  model: "gpt-6.1-sol",
  mode: "ask",
  policy: "ask",
  status: "idle",
  runtimeSessionId: null,
  createdAt: 0,
  updatedAt: 0,
  ...patch,
});

const it_ = (id: string, idx: number, body: ChatItem["body"], status: ChatItem["status"] = "completed"): ChatItem => ({
  id,
  messageId: "a1",
  idx,
  status,
  body,
  createdAt: new Date(2026, 9, 25, 14, 2).getTime(),
  updatedAt: 0,
});

const render = (m: ChatMessage, c: Conversation = conv(), canRegenerate = true) =>
  renderToStaticMarkup(<AssistantMessage message={m} conv={c} cwd={c.projectId ? "C:\\dev\\agenthub" : null} canRegenerate={canRegenerate} />);

describe("messages", () => {
  it("shows the engine, model, time, copy, regenerate and usage on the last answer", () => {
    const html = render(answer({ content: "Done.", usage: { inputTokens: 188, outputTokens: 141, costUsd: null } }));
    expect(html).toContain("OpenAI API");
    expect(html).toContain("GPT-6.1 Sol");
    expect(html).toContain("14:02");
    expect(html).toContain('aria-label="Copy answer"');
    expect(html).toContain('aria-label="Regenerate answer"');
    expect(html).toContain("188 IN · 141 OUT");
    expect(render(answer({ content: "Done." }), conv(), false)).not.toContain("Regenerate");
  });

  it("shows a skeleton before the first words", () => {
    const html = render(answer({ status: "streaming" }), conv(), false);
    expect(html).toContain("STREAMING");
    expect(html).toContain("skel");
    expect(html).toContain('aria-busy="true"');
  });

  it("keeps stopped text and labels it", () => {
    const html = render(answer({ status: "stopped", content: "Half an answer" }));
    expect(html).toContain("Half an answer");
    expect(html).toContain("STOPPED BY YOU");
  });

  it("renders a provider error with Retry, AI integrations and Switch model", () => {
    const html = render(
      answer({ status: "error", error: { kind: "invalid_key", message: "OpenAI rejected the API key (401).", status: 401, retryAfter: null } }),
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain("OpenAI API · API key problem");
    expect(html).toContain("MESSAGE KEPT");
    expect(html).toContain("Retry");
    expect(html).toContain("AI integrations");
    expect(html).toContain("Switch model");
  });

  it("offers Recheck when a runtime isn't signed in", () => {
    const html = render(
      answer({ engine: "copilot-cli", status: "error", error: { kind: "not_signed_in", message: "Run copilot and /login.", status: null, retryAfter: null } }),
      conv({ engine: "copilot-cli", projectId: "p1", mode: "agent" }),
    );
    expect(html).toContain("Copilot CLI isn&#x27;t signed in");
    expect(html).toContain("Recheck");
    expect(html).toContain("Other engine");
  });

  it("keeps partial text when the connection drops", () => {
    const html = render(answer({ status: "error", content: "one two three", error: { kind: "network", message: "Couldn't reach api.openai.com.", status: null, retryAfter: null } }));
    expect(html).toContain("one two three");
    expect(html).toContain("Connection lost after 3 words.");
  });

  it("renders user text as plain text with attachment chips", () => {
    const html = renderToStaticMarkup(
      <UserMessage
        message={answer({
          role: "user",
          content: "<b>not bold</b>",
          engine: null,
          model: null,
          items: [it_("x", 0, { kind: "attachment", path: "src/a.rs", text: "fn a(){}", truncated: false })],
        })}
      />,
    );
    expect(html).toContain("&lt;b&gt;not bold&lt;/b&gt;");
    expect(html).toContain("src/a.rs · ATTACHED");
  });
});

describe("agent items", () => {
  const agentConv = conv({ engine: "codex", projectId: "p1", mode: "agent" });

  it("groups tools into an Activity block and file changes into one card", () => {
    const items = [
      it_("t0", 0, { kind: "text", text: "I'll look." }),
      it_("r1", 1, { kind: "tool", tool: "read", title: "src/a.rs", detail: null, result: "212 LINES" }),
      it_("r2", 2, { kind: "tool", tool: "search", title: "\"spawn\"", detail: null, result: null }),
      it_("c1", 3, { kind: "command", command: "cargo test", cwd: null, output: "ok", exitCode: 0, durationMs: 4200 }),
      it_("f1", 4, { kind: "file_change", path: "src/a.rs", change: "modify", additions: 6, deletions: 1, checkpoint: "cp", state: "applied" }),
      it_("t1", 5, { kind: "text", text: "Done." }),
    ];
    expect(blocksOf(items).map((b) => (b.kind === "item" ? b.item.body.kind : b.kind))).toEqual(["text", "activity", "command", "text", "changes"]);
    const html = render(answer({ engine: "codex", content: "I'll look.\n\nDone.", items }), agentConv);
    expect(html).toContain("2 STEPS");
    expect(html).toContain("212 LINES");
    expect(html).toContain("cargo test");
    expect(html).toContain("Passed");
    expect(html).toContain("4.2 S");
    expect(html).toContain("OPEN IN TERMINAL");
    expect(html).toContain("Changes · 1 file");
    expect(html).toContain("+6");
    expect(html).toContain("RUN AGAIN");
  });

  it("renders a pending approval as an alertdialog with only the options the engine supports", () => {
    const pending = it_(
      "p1",
      0,
      {
        kind: "permission",
        request: { kind: "command", title: "Run", command: "cargo test -p agenthub", path: null, paths: [], detail: "RUNS THE TEST SUITE", canAllowSession: false },
        decision: null,
        auto: false,
        reason: null,
      },
      "pending",
    );
    const html = render(answer({ engine: "codex", status: "streaming", items: [pending] }), agentConv, false);
    expect(html).toContain('role="alertdialog"');
    expect(html).toContain("OpenAI Codex wants to run a command");
    expect(html).toContain("C:\\dev\\agenthub");
    expect(html).toContain("Approve once");
    expect(html).not.toContain("Allow for this session");
    expect(html).toContain("Deny");
    expect(html).toContain("Cancel task");
    expect(html).toContain("RUN IT YOURSELF IN A TERMINAL");
  });

  it("shows decided approvals compactly, including policy decisions", () => {
    const auto = it_("p2", 0, {
      kind: "permission",
      request: { kind: "write", title: "Edit a.rs", command: null, path: "C:\\dev\\agenthub\\a.rs", paths: [], detail: null, canAllowSession: true },
      decision: "allow_once",
      auto: true,
      reason: "Policy auto-approves edits in this project",
    });
    const html = render(answer({ engine: "codex", items: [auto] }), agentConv);
    expect(html).toContain("APPROVED ONCE · BY POLICY");
    expect(html).not.toContain('role="alertdialog"');
  });

  it("renders a plan with Implement in Agent mode only from Plan mode", () => {
    const plan = it_("pl", 0, {
      kind: "plan",
      steps: [
        { text: "Extract shared types", status: "completed" },
        { text: "Create three slices", status: "pending" },
      ],
      explanation: "Split sessionStore.ts into slices",
    });
    const planHtml = render(answer({ engine: "claude-code", items: [plan] }), conv({ engine: "claude-code", projectId: "p1", mode: "plan" }));
    expect(planHtml).toContain("Split sessionStore.ts into slices");
    expect(planHtml).toContain("2 STEPS · 1 DONE");
    expect(planHtml).toContain("Copy as Markdown");
    expect(planHtml).toContain("Revise plan");
    expect(planHtml).toContain("Implement in Agent mode");
    // Not offered once the conversation is already in Agent mode.
    expect(render(answer({ engine: "claude-code", items: [plan] }), conv({ engine: "claude-code", projectId: "p1", mode: "agent" }))).not.toContain("Implement in Agent mode");
  });
});
