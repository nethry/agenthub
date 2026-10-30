import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatEvent, ChatItem, ChatMessage, Conversation, EngineInfo, ProviderStatus } from "@/lib/types";

// The backend is mocked: these tests cover the store flows only.
const ipcMock = vi.hoisted(() => ({
  getSettings: vi.fn(),
  setSetting: vi.fn(),
  chatListConversations: vi.fn(),
  chatProviders: vi.fn(),
  chatEngines: vi.fn(),
  chatProbeEngines: vi.fn(),
  chatGetMessages: vi.fn(),
  chatCreateConversation: vi.fn(),
  chatSend: vi.fn(),
  chatRegenerate: vi.fn(),
  chatStop: vi.fn(),
  chatSetEngine: vi.fn(),
  chatSetMode: vi.fn(),
  chatSetPolicy: vi.fn(),
  chatRespondApproval: vi.fn(),
  chatSetChange: vi.fn(),
  chatRenameConversation: vi.fn(),
  chatDeleteConversation: vi.fn(),
}));

vi.mock("@/lib/ipc", () => ({
  ipc: ipcMock,
  // The fake channel just carries the handler, so tests can push events.
  chatChannel: (onEvent: (e: ChatEvent) => void) => ({ onEvent }),
  onEnginesChanged: () => Promise.resolve(() => {}),
  errorMessage: (e: unknown) => (e && typeof e === "object" && "message" in e ? String((e as { message: string }).message) : String(e)),
  errorKind: (e: unknown) => (e && typeof e === "object" && "kind" in e ? String((e as { kind: string }).kind) : null),
}));

const actions = await import("./actions");
const { getChat, initialChatState, setChat } = await import("./store");
const { ENGINE_ORDER, imagePasteError } = await import("./models");
const { useApp } = await import("@/app/store");

const ready = (provider: ProviderStatus["provider"]): ProviderStatus => ({ provider, hasKey: true, keyHint: "1234", state: "ok", message: null, checkedAt: 1 });

const engine = (id: EngineInfo["engine"], modes: EngineInfo["capabilities"]["modes"], state: EngineInfo["probe"]["state"] = "ready"): EngineInfo => ({
  engine: id,
  label: id,
  kind: id.endsWith("-api") ? "api" : "agent",
  enabled: true,
  capabilities: {
    modes,
    unsupported: (["ask", "plan", "agent"] as const).filter((m) => !modes.includes(m)).map((m) => [m, `${id} can't ${m}`]),
    tools: true,
    fileRead: true,
    fileWrite: true,
    commands: true,
    approvals: true,
    sessionResume: true,
    modelDiscovery: true,
    usage: true,
    images: true,
    notes: [],
  },
  probe: { engine: id, state, message: null, path: null, version: null, account: null, models: [], probedAt: 1 },
});

const conversation = (id: string, patch: Partial<Conversation> = {}): Conversation => ({
  id,
  projectId: "p1",
  title: "Question",
  engine: "codex",
  model: "gpt-6.1-sol",
  mode: "plan",
  policy: "ask",
  status: "idle",
  runtimeSessionId: null,
  createdAt: 1,
  updatedAt: 1,
  ...patch,
});

const message = (id: string, conversationId: string, patch: Partial<ChatMessage> = {}): ChatMessage => ({
  id,
  conversationId,
  role: "assistant",
  content: "",
  status: "streaming",
  engine: "codex",
  model: "gpt-6.1-sol",
  error: null,
  usage: null,
  items: [],
  createdAt: 2,
  ...patch,
});

const item = (id: string, messageId: string, idx: number, body: ChatItem["body"], status: ChatItem["status"] = "running"): ChatItem => ({
  id,
  messageId,
  idx,
  status,
  body,
  createdAt: 3,
  updatedAt: 3,
});

beforeEach(() => {
  vi.clearAllMocks();
  ipcMock.setSetting.mockResolvedValue(undefined);
  ipcMock.chatDeleteConversation.mockResolvedValue(undefined);
  setChat(initialChatState(), true);
  setChat({
    loaded: true,
    providers: { anthropic: ready("anthropic"), openai: ready("openai") },
    engines: [
      engine("claude-code", ["ask", "plan", "agent"]),
      engine("codex", ["plan", "agent"]),
      engine("openai-api", ["ask"]),
      engine("anthropic-api", ["ask"]),
    ],
  });
  useApp.setState({ workspace: "project", activeProjectId: "p1", dialog: null });
});

describe("prefs", () => {
  it("reads the v1 shape and keeps per-provider models", () => {
    const p = actions.parsePrefs(JSON.stringify({ defaultProvider: "openai", sendKey: "ctrlEnter", openai: { model: "gpt-6-luna", customModels: ["x"] } }));
    expect(p.defaultGeneralEngine).toBe("openai-api");
    expect(p.models["openai-api"]).toBe("gpt-6-luna");
    expect(p.customModels["openai-api"]).toEqual(["x"]);
    expect(p.sendKey).toBe("ctrlEnter");
    expect(actions.parsePrefs("{oops").defaultEngine).toBe("claude-code");
  });
});

describe("workspaces", () => {
  it("keeps a selected chat per workspace and lists only that workspace's chats", async () => {
    setChat({ conversations: [conversation("c1"), conversation("g1", { projectId: null, engine: "openai-api", mode: "ask" })] });
    ipcMock.chatGetMessages.mockResolvedValue([]);
    await actions.selectConversation("c1");
    await actions.selectConversation("g1");
    expect(getChat().active).toEqual({ p1: "c1", general: "g1" });
    expect(actions.activeConversation(getChat(), "p1")?.id).toBe("c1");
    expect(actions.activeConversation(getChat(), null)?.id).toBe("g1");
  });

  it("hides the chats of a turned-off integration and won't send with it", async () => {
    setChat({ conversations: [conversation("c1")], active: { p1: "c1" } });
    expect(actions.activeConversation(getChat(), "p1")?.id).toBe("c1");
    setChat((s) => ({ engines: s.engines.map((e) => (e.engine === "codex" ? { ...e, enabled: false } : e)) }));
    expect(actions.activeConversation(getChat(), "p1")).toBeNull();
    await actions.selectConversation("c1");
    expect(ipcMock.chatGetMessages).not.toHaveBeenCalled();
    setChat({ newChat: { p1: { engine: "codex", model: "gpt-6.1-sol", mode: "plan", policy: "ask" } } });
    expect(actions.newChatConfig(getChat(), "p1").engine).toBe("claude-code");

    setChat({ engines: ENGINE_ORDER.map((id) => ({ ...engine(id, ["ask"]), enabled: false })) });
    expect(await actions.sendMessage("Hello", "p1")).toBe(false);
    expect(getChat().composerError).toMatch(/All AI integrations are turned off/);
    expect(ipcMock.chatCreateConversation).not.toHaveBeenCalled();
  });

  it("new chats in General use a direct API, projects the default agent", () => {
    expect(actions.newChatConfig(getChat(), null).engine).toBe("anthropic-api");
    expect(actions.newChatConfig(getChat(), "p1").engine).toBe("claude-code");
  });

  it("opening a conversation from elsewhere switches workspace and view", () => {
    setChat({ conversations: [conversation("c2", { projectId: "p2" })] });
    ipcMock.chatGetMessages.mockResolvedValue([]);
    actions.openConversation("c2");
    expect(useApp.getState().activeProjectId).toBe("p2");
    expect(useApp.getState().workspaces.p2.view).toBe("chat");
    expect(getChat().active.p2).toBe("c2");
  });
});

describe("modes", () => {
  it("asks before escalating to Agent and keeps the same conversation", async () => {
    setChat({ conversations: [conversation("c1")], active: { p1: "c1" } });
    actions.requestMode("agent", "p1");
    expect(getChat().modeConfirm).toEqual({ conversationId: "c1", ws: "p1" });
    expect(ipcMock.chatSetMode).not.toHaveBeenCalled();
    ipcMock.chatSetMode.mockResolvedValue(conversation("c1", { mode: "agent" }));
    actions.confirmAgentMode();
    await vi.waitFor(() => expect(ipcMock.chatSetMode).toHaveBeenCalledWith("c1", "agent"));
    await vi.waitFor(() => expect(getChat().conversations[0].mode).toBe("agent"));
    expect(getChat().modeConfirm).toBeNull();
  });

  it("never switches to a mode the engine can't enforce", () => {
    setChat({ conversations: [conversation("c1", { mode: "plan" })], active: { p1: "c1" } });
    actions.requestMode("ask", "p1"); // Codex can't do Ask
    expect(ipcMock.chatSetMode).not.toHaveBeenCalled();
    expect(getChat().modeConfirm).toBeNull();
  });

  it("de-escalating needs no confirmation; a new chat keeps its draft mode", () => {
    actions.requestMode("plan", "p1");
    expect(actions.newChatConfig(getChat(), "p1").mode).toBe("plan");
    actions.requestMode("agent", "p1");
    expect(getChat().modeConfirm?.conversationId).toBeNull();
    actions.confirmAgentMode();
    expect(actions.newChatConfig(getChat(), "p1").mode).toBe("agent");
  });
});

describe("engines", () => {
  it("an agent conversation with messages stays on its runtime; picking another starts a new chat", () => {
    setChat({ conversations: [conversation("c1")], active: { p1: "c1" }, messages: { c1: [message("m1", "c1", { status: "complete" })] } });
    actions.chooseEngine("claude-code", "claude-opus-5-5", "p1");
    expect(ipcMock.chatSetEngine).not.toHaveBeenCalled();
    expect(getChat().active.p1).toBeNull();
    expect(getChat().newChat.p1.engine).toBe("claude-code");
  });

  it("API chats switch provider in place", () => {
    const g = conversation("g1", { projectId: null, engine: "openai-api", mode: "ask" });
    setChat({ conversations: [g], active: { general: "g1" }, messages: { g1: [message("m1", "g1", { status: "complete" })] } });
    ipcMock.chatSetEngine.mockResolvedValue({ ...g, engine: "anthropic-api" });
    actions.chooseEngine("anthropic-api", "claude-opus-5-5", null);
    expect(ipcMock.chatSetEngine).toHaveBeenCalledWith("g1", "anthropic-api", "claude-opus-5-5");
  });
});

describe("sending", () => {
  it("creates the chat with the draft config and attachments, then streams", async () => {
    actions.setDraft("new:p1", "Plan it");
    actions.attachFile("new:p1", "src/a.rs");
    setChat({ newChat: { p1: { engine: "codex", model: "gpt-6.1-sol", mode: "plan", policy: "ask" } } });
    ipcMock.chatCreateConversation.mockResolvedValue(conversation("c9"));
    ipcMock.chatSend.mockResolvedValue("r1");
    expect(await actions.sendMessage("Plan it", "p1")).toBe(true);
    expect(ipcMock.chatCreateConversation).toHaveBeenCalledWith({ projectId: "p1", engine: "codex", model: "gpt-6.1-sol", mode: "plan", policy: "ask", firstMessage: "Plan it" });
    expect(ipcMock.chatSend.mock.calls[0].slice(0, 3)).toEqual(["c9", "Plan it", ["src/a.rs"]]);
    expect(getChat().active.p1).toBe("c9");
    expect(getChat().drafts["new:p1"]).toBe("");
  });

  it("sends pasted images as base64 and puts them back if the send fails", async () => {
    setChat({ conversations: [conversation("c1")], active: { p1: "c1" }, messages: { c1: [] } });
    const png = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "image.png", { type: "image/png" });
    await actions.pasteImages("c1", [png], "p1");
    const [img] = getChat().images.c1;
    expect(img).toMatchObject({ name: "Pasted image 1", mime: "image/png", size: 4, url: "data:image/png;base64,iVBORw==" });

    ipcMock.chatSend.mockRejectedValueOnce({ kind: "invalid", message: "nope" });
    expect(await actions.sendMessage("What's this?", "p1")).toBe(false);
    expect(getChat().images.c1).toEqual([img]);

    ipcMock.chatSend.mockResolvedValue("r1");
    expect(await actions.sendMessage("What's this?", "p1")).toBe(true);
    expect(ipcMock.chatSend.mock.calls[1][3]).toEqual([{ name: "Pasted image 1", data: "iVBORw==" }]);
    expect(getChat().images.c1).toEqual([]);
  });

  it("takes pasted images in project and Ask chats, within the limits", async () => {
    const png = (size = 4) => new File([new Uint8Array(size)], "image.png", { type: "image/png" });
    await actions.pasteImages("new:general", [png()], null);
    expect(getChat().images["new:general"]).toHaveLength(1);
    setChat({ engines: getChat().engines.map((e) => (e.engine === "anthropic-api" ? { ...e, capabilities: { ...e.capabilities, images: false } } : e)) });
    await actions.pasteImages("new:general", [png()], null);
    expect(getChat().composerError).toMatch(/Anthropic API takes text only/);
    expect(imagePasteError([{ type: "image/gif", size: 4 }], 0, "gemini-api")).toMatch(/doesn't take GIF/);
    await actions.pasteImages("new:p1", [png(), png(), png(), png(), png()], "p1");
    expect(getChat().composerError).toMatch(/up to 4 images/);
    await actions.pasteImages("new:p1", [new File(["<svg/>"], "a.svg", { type: "image/svg+xml" })], "p1");
    expect(getChat().composerError).toMatch(/PNG, JPEG, GIF or WebP/);
    expect(getChat().images["new:p1"]).toBeUndefined();
  });

  it("refuses Claude Agent without an Anthropic key and keeps the draft", async () => {
    setChat({ providers: {} });
    actions.setDraft("new:p1", "Hi");
    expect(await actions.sendMessage("Hi", "p1")).toBe(false);
    expect(getChat().composerError).toMatch(/Anthropic API key/);
    expect(ipcMock.chatCreateConversation).not.toHaveBeenCalled();
  });

  it("deletes a chat it just created when the send fails", async () => {
    ipcMock.chatCreateConversation.mockResolvedValue(conversation("c9", { engine: "claude-code" }));
    ipcMock.chatSend.mockRejectedValue({ kind: "engine_not_found", message: "Node.js not found" });
    expect(await actions.sendMessage("Hi", "p1")).toBe(false);
    expect(ipcMock.chatDeleteConversation).toHaveBeenCalledWith("c9");
    expect(getChat().conversations).toEqual([]);
    expect(getChat().drafts["new:p1"]).toBe("Hi");
  });
});

describe("streaming events", () => {
  const start = () => {
    setChat({ conversations: [conversation("c1")], messages: { c1: [] } });
    actions.handleChatEvent({
      type: "started",
      conversationId: "c1",
      requestId: "r1",
      userMessage: message("u1", "c1", { role: "user", status: "complete", content: "Go" }),
      assistantMessage: message("a1", "c1"),
      removedIds: [],
      omitted: 0,
    });
  };

  it("builds items, text deltas and command output into the answer", () => {
    start();
    expect(getChat().requests.c1).toBe("r1");
    expect(getChat().conversations[0].status).toBe("running");
    actions.handleChatEvent({ type: "item", conversationId: "c1", requestId: "r1", messageId: "a1", item: item("t1", "a1", 0, { kind: "text", text: "" }) });
    actions.handleChatEvent({ type: "delta", conversationId: "c1", requestId: "r1", messageId: "a1", text: "Run", itemId: "t1" });
    actions.handleChatEvent({ type: "delta", conversationId: "c1", requestId: "r1", messageId: "a1", text: "ning", itemId: "t1" });
    actions.flushDeltas();
    const cmd = item("k1", "a1", 1, { kind: "command", command: "cargo test", cwd: null, output: "", exitCode: null, durationMs: null });
    actions.handleChatEvent({ type: "item", conversationId: "c1", requestId: "r1", messageId: "a1", item: cmd });
    actions.handleChatEvent({ type: "output", conversationId: "c1", requestId: "r1", itemId: "k1", text: "ok\n" });
    const a = getChat().messages.c1[1];
    expect(a.content).toBe("Running");
    expect(a.items.map((i) => i.id)).toEqual(["t1", "k1"]);
    expect(a.items[0].body).toEqual({ kind: "text", text: "Running" });
    expect(a.items[1].body.kind === "command" && a.items[1].body.output).toBe("ok\n");
  });

  it("tracks approval status and drops late events from another turn", () => {
    start();
    actions.handleChatEvent({ type: "status", conversationId: "c1", requestId: "r1", status: "waiting_for_approval" });
    expect(getChat().conversations[0].status).toBe("waiting_for_approval");
    actions.handleChatEvent({ type: "status", conversationId: "c1", requestId: "old", status: "failed" });
    expect(getChat().conversations[0].status).toBe("waiting_for_approval");
  });

  it("finishing stores the authoritative message and conversation", () => {
    start();
    const final = message("a1", "c1", { status: "complete", content: "Done", usage: { inputTokens: 5, outputTokens: 2, costUsd: null } });
    actions.handleChatEvent({ type: "finished", conversationId: "c1", requestId: "r1", message: final, conversation: conversation("c1", { status: "completed", runtimeSessionId: "thr" }) });
    expect(getChat().requests.c1).toBeUndefined();
    expect(getChat().messages.c1[1]).toEqual(final);
    expect(getChat().conversations[0].runtimeSessionId).toBe("thr");
  });
});

describe("approvals and file changes", () => {
  it("answers approvals through the backend", async () => {
    await actions.respondApproval("i1", "allow_session");
    expect(ipcMock.chatRespondApproval).toHaveBeenCalledWith("i1", "allow_session");
  });

  it("revert-all asks first and covers only checkpointed, unreviewed changes", () => {
    const change = (id: string, state: "applied" | "kept", checkpoint: string | null) =>
      item(id, "a1", 0, { kind: "file_change", path: `${id}.rs`, change: "modify", additions: 1, deletions: 0, checkpoint, state }, "completed");
    setChat({ messages: { c1: [message("a1", "c1", { status: "complete", items: [change("x", "applied", "cp1"), change("y", "kept", "cp2"), change("z", "applied", null)] })] } });
    actions.requestRevertAll("c1");
    expect(useApp.getState().dialog).toEqual({ type: "revertAll", conversationId: "c1", itemIds: ["x"] });
    expect(actions.pendingChanges("c1").map((i) => i.id)).toEqual(["x", "z"]);
  });
});
