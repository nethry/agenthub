// Chat flows that span the backend and the chat store. Chat never touches
// Monaco or terminals directly: it calls the app's typed actions
// (`openFile`, `prefillTerminal`, `fsChanged`) for that.
import { currentProjectId, get as getApp, set as setApp, setView, toast } from "@/app/store";
import { chatChannel, errorKind, errorMessage, ipc, onEnginesChanged } from "@/lib/ipc";
import { readDataUrl } from "@/lib/utils";
import {
  defaultChatPrefs,
  type ApprovalPolicy,
  type BacklogRef,
  type ChatEvent,
  type ChatItem,
  type ChatMessage,
  type ChatMode,
  type ChatPrefs,
  type Conversation,
  type Decision,
  type EngineId,
  type EngineInfo,
} from "@/lib/types";
import {
  defaultModelFor,
  ENGINE_LABEL,
  engineOn,
  ENGINE_PROVIDER,
  fitMode,
  imagePasteError,
  isAgent,
  MAX_IMAGES,
  MODELS,
  modeAvailability,
  needsModeConfirm,
  newChatEngine,
  POLICY_ORDER,
  PROVIDER_LABEL,
  providerReady,
  workspaceKey,
} from "./models";
import { draftKey, getChat, setChat, type ChatState, type NewChatConfig } from "./store";
import { LIST_MIN, PANEL_MIN, panelWidth } from "./layout";

// ---------- loading ----------

let loading: Promise<void> | null = null;
let listening = false;

/** Loads prefs, conversations, key status and engine probes once. */
export function ensureChatLoaded(): Promise<void> {
  if (getChat().loaded) return Promise.resolve();
  loading ??= (async () => {
    if (!listening) {
      listening = true;
      await onEnginesChanged((engines) => setChat({ engines }));
    }
    const [settings, conversations, providers, engines] = await Promise.all([
      ipc.getSettings().catch(() => ({}) as Record<string, string>),
      ipc.chatListConversations(),
      ipc.chatProviders().catch(() => []),
      ipc.chatEngines().catch(() => [] as EngineInfo[]),
    ]);
    setChat({
      loaded: true,
      prefs: parsePrefs(settings.chat),
      conversations,
      providers: Object.fromEntries(providers.map((p) => [p.provider, p])),
      engines,
    });
  })()
    .catch((e) => toast(`Couldn't load chats: ${errorMessage(e)}`, "danger"))
    .finally(() => (loading = null));
  return loading;
}

/** Reads the `chat` setting, including the v1 shape (defaultProvider, per-provider model). */
export function parsePrefs(raw: string | undefined): ChatPrefs {
  if (!raw) return defaultChatPrefs;
  try {
    const v = JSON.parse(raw) as Partial<ChatPrefs> & {
      defaultProvider?: string;
      anthropic?: { model?: string; maxTokens?: number; customModels?: string[] };
      openai?: { model?: string; customModels?: string[] };
    };
    const models: ChatPrefs["models"] = { ...v.models };
    const customModels: ChatPrefs["customModels"] = { ...v.customModels };
    if (v.anthropic?.model && !models["anthropic-api"]) models["anthropic-api"] = v.anthropic.model;
    if (v.openai?.model && !models["openai-api"]) models["openai-api"] = v.openai.model;
    if (v.anthropic?.customModels?.length && !customModels["anthropic-api"]) customModels["anthropic-api"] = v.anthropic.customModels;
    if (v.openai?.customModels?.length && !customModels["openai-api"]) customModels["openai-api"] = v.openai.customModels;
    const legacyGeneral = v.defaultProvider === "openai" ? "openai-api" : v.defaultProvider === "anthropic" ? "anthropic-api" : undefined;
    return {
      ...defaultChatPrefs,
      ...v,
      listWidth: panelWidth(v.listWidth, 268, LIST_MIN, 480),
      panelWidth: panelWidth(v.panelWidth, 380, PANEL_MIN, 800),
      defaultGeneralEngine: v.defaultGeneralEngine ?? legacyGeneral ?? defaultChatPrefs.defaultGeneralEngine,
      models,
      customModels,
      anthropic: { maxTokens: v.anthropic?.maxTokens ?? defaultChatPrefs.anthropic.maxTokens },
    };
  } catch {
    return defaultChatPrefs;
  }
}

export async function refreshProviders() {
  const list = await ipc.chatProviders().catch(() => null);
  if (list) setChat({ providers: Object.fromEntries(list.map((p) => [p.provider, p])) });
  const engines = await ipc.chatEngines().catch(() => null);
  if (engines) setChat({ engines });
}

/** Re-detects runtimes (one or all); results arrive as `engines-changed`. */
export async function recheckEngines(engine?: EngineId) {
  try {
    setChat({ engines: await ipc.chatProbeEngines(engine) });
  } catch (e) {
    toast(`Couldn't check AI integrations: ${errorMessage(e)}`, "danger");
  }
}

/**
 * Turns an integration on or off. While off, its chats, models, status and
 * usage are hidden everywhere (not deleted) and AgentHub never starts it.
 */
export async function setEngineEnabled(engine: EngineId, enabled: boolean) {
  try {
    setChat({ engines: await ipc.chatSetEngineEnabled(engine, enabled) });
    // Codex's usage windows weren't fetched while it was off; fresh ones arrive as `usage-changed`.
    if (enabled && engine === "codex") void ipc.usageRefresh().catch(() => {});
  } catch (e) {
    toast(errorMessage(e), "danger");
  }
}

type PrefsPatch = Partial<Omit<ChatPrefs, "anthropic">> & { anthropic?: Partial<ChatPrefs["anthropic"]> };

export function setChatPrefs(patch: PrefsPatch) {
  const cur = getChat().prefs;
  const prefs: ChatPrefs = { ...cur, ...patch, anthropic: { ...cur.anthropic, ...patch.anthropic } };
  setChat({ prefs });
  void ipc.setSetting("chat", JSON.stringify(prefs)).catch((e) => toast(`Couldn't save chat settings: ${errorMessage(e)}`, "danger"));
}

// ---------- navigation ----------

export function engineInfo(s: ChatState, engine: EngineId): EngineInfo | undefined {
  return s.engines.find((e) => e.engine === engine);
}

/** The project whose chats are showing (`null` = General). */
export function chatProject(): string | null {
  return currentProjectId(getApp());
}

export function activeConversation(s: ChatState = getChat(), projectId: string | null = chatProject()): Conversation | null {
  const id = s.active[workspaceKey(projectId)] ?? null;
  return (id && s.conversations.find((c) => c.id === id && engineOn(s.engines, c.engine))) || null;
}

/** Settings for the next new chat in a workspace. */
export function newChatConfig(s: ChatState, projectId: string | null): NewChatConfig {
  const saved = s.newChat[workspaceKey(projectId)];
  const inProject = projectId !== null;
  if (saved && isAgent(saved.engine) === inProject && engineOn(s.engines, saved.engine)) return saved;
  const engine = newChatEngine(s.prefs, s.engines, inProject);
  const info = engineInfo(s, engine);
  return {
    engine,
    model: defaultModelFor(engine, info, s.prefs),
    // Agent always needs the user's confirmation, so a new project chat starts in Plan.
    mode: fitMode(engine, inProject ? "plan" : "ask", info, inProject),
    policy: s.prefs.defaultPolicy,
  };
}

/** Engine/model/mode the composer works with: the open chat's, or the new chat's. */
export function composerConfig(s: ChatState = getChat(), projectId: string | null = chatProject()): NewChatConfig & { conversation: Conversation | null } {
  const conv = activeConversation(s, projectId);
  if (conv) return { engine: conv.engine, model: conv.model, mode: conv.mode, policy: conv.policy, conversation: conv };
  return { ...newChatConfig(s, projectId), conversation: null };
}

export function newChat(projectId: string | null = chatProject()) {
  const ws = workspaceKey(projectId);
  setChat((s) => ({ active: { ...s.active, [ws]: null }, composerError: null, renamingId: null, modeConfirm: null }));
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => document.getElementById("chat-composer")?.focus());
}

/** Opens a conversation from anywhere (palette, Overview, Editor badge). */
export function openConversation(id: string) {
  const s = getChat();
  const conv = s.conversations.find((c) => c.id === id);
  if (!conv || !engineOn(s.engines, conv.engine)) return;
  if (conv.projectId) {
    setApp({ workspace: "project", activeProjectId: conv.projectId, screen: "workspace", focusSessionId: null });
    setView(conv.projectId, "chat");
  } else {
    setApp({ workspace: "general", screen: "workspace", focusSessionId: null });
  }
  void selectConversation(id);
}

export async function selectConversation(id: string) {
  const conv = getChat().conversations.find((c) => c.id === id);
  if (!conv || !engineOn(getChat().engines, conv.engine)) return;
  const ws = workspaceKey(conv.projectId);
  setChat((s) => ({ active: { ...s.active, [ws]: id }, composerError: null, modeConfirm: null }));
  if (getChat().messages[id]) return;
  try {
    const list = await ipc.chatGetMessages(id);
    setChat((s) => ({ messages: { ...s.messages, [id]: s.messages[id] ?? list } }));
  } catch (e) {
    toast(`Couldn't open the chat: ${errorMessage(e)}`, "danger");
  }
}

export function toggleConversationList() {
  setChatPrefs({ listCollapsed: !getChat().prefs.listCollapsed });
}

export function toggleChatFocus() {
  setChat((s) => ({ focus: !s.focus }));
}

export function openAiSettings() {
  setChat({ menuOpen: false });
  setApp({ screen: "settings", settingsSection: "ai" });
}

export function setDraft(key: string, text: string) {
  setChat((s) => ({ drafts: { ...s.drafts, [key]: text }, composerError: null }));
}

export function attachFile(key: string, path: string) {
  setChat((s) => {
    const cur = s.attachments[key] ?? [];
    if (cur.includes(path) || cur.length >= 8) return {};
    return { attachments: { ...s.attachments, [key]: [...cur, path] } };
  });
}

export function detachFile(key: string, path: string) {
  setChat((s) => ({ attachments: { ...s.attachments, [key]: (s.attachments[key] ?? []).filter((p) => p !== path) } }));
}

/**
 * Adds images pasted into the composer to the draft (project and Ask chats),
 * if the engine accepts images; the backend checks them again.
 */
export async function pasteImages(key: string, files: File[], projectId: string | null) {
  const s = getChat();
  const engine = composerConfig(s, projectId).engine;
  if (engineInfo(s, engine)?.capabilities.images === false) {
    setChat({ composerError: `${ENGINE_LABEL[engine]} takes text only. Remove the images, or pick another engine.` });
    return;
  }
  const have = s.images[key]?.length ?? 0;
  const problem = imagePasteError(files, have, engine);
  if (problem) {
    setChat({ composerError: problem });
    return;
  }
  try {
    const urls = await Promise.all(files.map(readDataUrl));
    setChat((st) => {
      const cur = st.images[key] ?? [];
      const added = files.map((f, i) => ({
        id: crypto.randomUUID(),
        name: `Pasted image ${cur.length + i + 1}`,
        mime: f.type,
        size: f.size,
        url: urls[i],
      }));
      return { images: { ...st.images, [key]: [...cur, ...added].slice(0, MAX_IMAGES) }, composerError: null };
    });
  } catch (e) {
    setChat({ composerError: `Couldn't read the pasted image: ${errorMessage(e)}` });
  }
}

export function detachImage(key: string, id: string) {
  setChat((s) => ({ images: { ...s.images, [key]: (s.images[key] ?? []).filter((i) => i.id !== id) } }));
}

function upsertConversation(conv: Conversation) {
  setChat((s) => {
    const rest = s.conversations.filter((c) => c.id !== conv.id);
    return { conversations: [conv, ...rest].sort((a, b) => b.updatedAt - a.updatedAt) };
  });
}

function setNewChat(projectId: string | null, patch: Partial<NewChatConfig>) {
  const ws = workspaceKey(projectId);
  setChat((s) => ({ newChat: { ...s.newChat, [ws]: { ...newChatConfig(s, projectId), ...patch } } }));
}

/**
 * Picks engine + model. A new chat takes anything; an existing chat switches
 * in place only between direct APIs (or before its first message). Another
 * runtime means a new chat: runtime sessions aren't portable.
 */
export function chooseEngine(engine: EngineId, model: string, projectId: string | null = chatProject()) {
  const s = getChat();
  const builtin = MODELS[engine].some((m) => m.id === model) || engineInfo(s, engine)?.probe.models.some((m) => m.id === model);
  const custom = s.prefs.customModels[engine] ?? [];
  setChatPrefs({
    models: { ...s.prefs.models, [engine]: model },
    customModels: builtin || custom.includes(model) ? s.prefs.customModels : { ...s.prefs.customModels, [engine]: [...custom, model] },
  });
  setChat({ menuOpen: false, composerError: null });
  const conv = activeConversation(getChat(), projectId);
  const info = engineInfo(getChat(), engine);
  const inProject = projectId !== null;
  if (!conv) {
    setNewChat(projectId, { engine, model, mode: fitMode(engine, newChatConfig(getChat(), projectId).mode, info, inProject) });
    return;
  }
  const hasMessages = (getChat().messages[conv.id]?.length ?? 0) > 0;
  if (conv.engine !== engine && hasMessages && (isAgent(conv.engine) || isAgent(engine))) {
    setNewChat(projectId, { engine, model, mode: fitMode(engine, conv.mode === "agent" ? "plan" : conv.mode, info, inProject) });
    newChat(projectId);
    toast(`New chat with ${ENGINE_LABEL[engine]} — an agent conversation stays with the runtime it started on.`);
    return;
  }
  upsertConversation({ ...conv, engine, model });
  void ipc
    .chatSetEngine(conv.id, engine, model)
    .then(upsertConversation)
    .catch((e) => {
      upsertConversation(conv);
      toast(`Couldn't change the engine: ${errorMessage(e)}`, "danger");
    });
}

/** Mode switch; escalating to Agent waits for the inline confirmation. */
export function requestMode(mode: ChatMode, projectId: string | null = chatProject()) {
  const s = getChat();
  const cfg = composerConfig(s, projectId);
  const avail = modeAvailability(cfg.engine, mode, engineInfo(s, cfg.engine), projectId !== null);
  if (!avail.ok || mode === cfg.mode) return;
  if (needsModeConfirm(cfg.mode, mode)) {
    setChat({ modeConfirm: { conversationId: cfg.conversation?.id ?? null, ws: workspaceKey(projectId) } });
    return;
  }
  void applyMode(mode, projectId);
}

export function confirmAgentMode() {
  const c = getChat().modeConfirm;
  if (!c) return;
  setChat({ modeConfirm: null });
  void applyMode("agent", c.ws === "general" ? null : c.ws);
}

export function cancelModeConfirm() {
  setChat({ modeConfirm: null });
}

async function applyMode(mode: ChatMode, projectId: string | null) {
  const conv = activeConversation(getChat(), projectId);
  if (!conv) {
    setNewChat(projectId, { mode });
    return;
  }
  try {
    upsertConversation(await ipc.chatSetMode(conv.id, mode));
  } catch (e) {
    toast(errorMessage(e), "danger");
  }
}

/** The policy chip cycles through the policies (Agent mode only). */
export async function cyclePolicy(projectId: string | null = chatProject()) {
  const cfg = composerConfig(getChat(), projectId);
  const next: ApprovalPolicy = POLICY_ORDER[(POLICY_ORDER.indexOf(cfg.policy) + 1) % POLICY_ORDER.length];
  if (!cfg.conversation) {
    setNewChat(projectId, { policy: next });
    return;
  }
  try {
    upsertConversation(await ipc.chatSetPolicy(cfg.conversation.id, next));
  } catch (e) {
    toast(errorMessage(e), "danger");
  }
}

// ---------- turns ----------

/** Why the engine can't take a message right now (shown above the composer). */
function readyError(engine: EngineId): string | null {
  const s = getChat();
  if (!engineOn(s.engines, engine)) {
    return s.engines.some((e) => e.enabled)
      ? `${ENGINE_LABEL[engine]} is turned off. Pick another engine, or turn it on in Settings › AI integrations.`
      : "All AI integrations are turned off. Turn one on in Settings › AI integrations.";
  }
  const provider = ENGINE_PROVIDER[engine];
  if (provider) {
    const status = s.providers[provider];
    if (!status?.hasKey) return `Add a ${PROVIDER_LABEL[provider]} API key in Settings › AI integrations to use ${ENGINE_LABEL[engine]}.`;
    if (!providerReady(status)) return `The saved ${PROVIDER_LABEL[provider]} key was rejected. Update it in Settings › AI integrations.`;
    return null;
  }
  if (engine === "claude-code" && !s.providers.anthropic?.hasKey) {
    return "Claude Agent runs on the Claude Agent SDK with an Anthropic API key. Add one in Settings › AI integrations.";
  }
  return null;
}

/** Called after a message about a backlog item was sent (the Backlog refreshes its links). */
let onBacklogSent: ((ref: BacklogRef, conversationId: string) => void) | null = null;
export function setOnBacklogSent(cb: typeof onBacklogSent) {
  onBacklogSent = cb;
}

/** Removes the backlog context from a draft (the chip's ✕). */
export function detachBacklog(key: string) {
  setChat((s) => {
    const { [key]: _gone, ...rest } = s.backlog;
    return { backlog: rest };
  });
}

/** Sends the composer text (with attachments). Creates the chat on the first message. */
export async function sendMessage(text: string, projectId: string | null = chatProject()): Promise<boolean> {
  const s = getChat();
  if (!text.trim()) return false;
  const cfg = composerConfig(s, projectId);
  if (cfg.conversation && s.requests[cfg.conversation.id]) return false;
  const notReady = readyError(cfg.engine);
  if (notReady) {
    setChat({ composerError: notReady });
    return false;
  }
  const ws = workspaceKey(projectId);
  const key = draftKey(ws, cfg.conversation?.id ?? null);
  const attachments = s.attachments[key] ?? [];
  const images = s.images[key] ?? [];
  const backlog = s.backlog[key] ?? null;
  setChat((st) => {
    const { [key]: _sent, ...rest } = st.backlog;
    return { drafts: { ...st.drafts, [key]: "" }, attachments: { ...st.attachments, [key]: [] }, images: { ...st.images, [key]: [] }, backlog: rest };
  });

  let conversationId = cfg.conversation?.id ?? null;
  let created = false;
  try {
    if (!conversationId) {
      const conv = await ipc.chatCreateConversation({
        projectId,
        engine: cfg.engine,
        model: cfg.model,
        mode: cfg.mode,
        policy: cfg.policy,
        firstMessage: text,
      });
      created = true;
      conversationId = conv.id;
      setChat((st) => {
        const { [ws]: _gone, ...newChat } = st.newChat;
        return {
          conversations: [conv, ...st.conversations],
          messages: { ...st.messages, [conv.id]: [] },
          // Stay on it unless the user moved on meanwhile.
          active: { ...st.active, [ws]: st.active[ws] ?? conv.id },
          newChat,
        };
      });
    }
    const pasted = images.map((i) => ({ name: i.name, data: i.url.slice(i.url.indexOf(",") + 1) }));
    await ipc.chatSend(conversationId, text, attachments, pasted, backlog, chatChannel(handleChatEvent));
    if (backlog) onBacklogSent?.(backlog, conversationId);
    return true;
  } catch (e) {
    if (created && conversationId) {
      const id = conversationId;
      await ipc.chatDeleteConversation(id).catch(() => {});
      setChat((st) => ({
        conversations: st.conversations.filter((c) => c.id !== id),
        active: { ...st.active, [ws]: st.active[ws] === id ? null : st.active[ws] },
      }));
    }
    const back = created ? draftKey(ws, null) : key;
    setChat((st) => ({
      drafts: { ...st.drafts, [back]: text },
      attachments: { ...st.attachments, [back]: attachments },
      images: { ...st.images, [back]: images },
      backlog: backlog ? { ...st.backlog, [back]: backlog } : st.backlog,
      composerError: errorMessage(e),
    }));
    if (errorKind(e) === "missing_key") void refreshProviders();
    return false;
  }
}

/** Replaces the last answer (also the Retry action after an error). */
export async function regenerate(conversationId: string) {
  const s = getChat();
  if (s.requests[conversationId]) return;
  const conv = s.conversations.find((c) => c.id === conversationId);
  if (!conv) return;
  const notReady = readyError(conv.engine);
  if (notReady) {
    setChat({ composerError: notReady });
    return;
  }
  try {
    await ipc.chatRegenerate(conversationId, chatChannel(handleChatEvent));
  } catch (e) {
    setChat({ composerError: errorMessage(e) });
  }
}

export function stopGenerating(conversationId: string) {
  const requestId = getChat().requests[conversationId];
  if (requestId) void ipc.chatStop(requestId).catch(() => {});
}

export async function respondApproval(itemId: string, decision: Decision) {
  try {
    await ipc.chatRespondApproval(itemId, decision);
  } catch (e) {
    toast(errorMessage(e), "warn");
  }
}

// ---------- streaming events ----------

interface PendingText {
  conversationId: string;
  text: string;
  /** Text items (agents) the text also extends, in order. */
  items: Map<string, string>;
}

const pending = new Map<string, PendingText>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
/** Deltas are applied at most every ~30 ms, not per token. */
const FLUSH_MS = 32;

function patchMessage(
  messages: Record<string, ChatMessage[]>,
  conversationId: string,
  messageId: string,
  fn: (m: ChatMessage) => ChatMessage,
): Record<string, ChatMessage[]> {
  const list = messages[conversationId];
  if (!list) return messages;
  const i = list.findIndex((m) => m.id === messageId);
  if (i === -1) return messages;
  const next = list.slice();
  next[i] = fn(list[i]);
  return { ...messages, [conversationId]: next };
}

function upsertItem(items: ChatItem[], item: ChatItem): ChatItem[] {
  const i = items.findIndex((x) => x.id === item.id);
  const next = i === -1 ? [...items, item] : items.map((x) => (x.id === item.id ? item : x));
  return i === -1 ? next.sort((a, b) => a.idx - b.idx) : next;
}

export function flushDeltas() {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  if (pending.size === 0) return;
  const batch = [...pending.entries()];
  pending.clear();
  setChat((s) => {
    let messages = s.messages;
    for (const [messageId, { conversationId, text, items }] of batch) {
      messages = patchMessage(messages, conversationId, messageId, (m) => {
        if (m.status !== "streaming") return m;
        let next = { ...m, content: m.content + text };
        if (items.size) {
          next = {
            ...next,
            items: m.items.map((it) =>
              items.has(it.id) && it.body.kind === "text" ? { ...it, body: { ...it.body, text: it.body.text + items.get(it.id)! } } : it,
            ),
          };
        }
        return next;
      });
    }
    return { messages };
  });
}

function current(ev: { conversationId: string; requestId: string }): boolean {
  return getChat().requests[ev.conversationId] === ev.requestId;
}

export function handleChatEvent(ev: ChatEvent) {
  switch (ev.type) {
    case "started": {
      setChat((s) => {
        const list = (s.messages[ev.conversationId] ?? []).filter((m) => !ev.removedIds.includes(m.id));
        const added = [ev.userMessage, ev.assistantMessage].filter((m): m is ChatMessage => !!m);
        const conversations = s.conversations
          .map((c) =>
            c.id === ev.conversationId
              ? {
                  ...c,
                  engine: ev.assistantMessage.engine ?? c.engine,
                  model: ev.assistantMessage.model ?? c.model,
                  status: "running" as const,
                  updatedAt: ev.assistantMessage.createdAt,
                }
              : c,
          )
          .sort((a, b) => b.updatedAt - a.updatedAt);
        return {
          conversations,
          messages: { ...s.messages, [ev.conversationId]: [...list, ...added.filter((m) => !list.some((x) => x.id === m.id))] },
          requests: { ...s.requests, [ev.conversationId]: ev.requestId },
          omitted: { ...s.omitted, [ev.conversationId]: ev.omitted },
          composerError: null,
        };
      });
      break;
    }
    case "delta": {
      // Ignore late events from a turn that is no longer current.
      if (!current(ev)) return;
      const cur = pending.get(ev.messageId) ?? { conversationId: ev.conversationId, text: "", items: new Map<string, string>() };
      cur.text += ev.text;
      if (ev.itemId) cur.items.set(ev.itemId, (cur.items.get(ev.itemId) ?? "") + ev.text);
      pending.set(ev.messageId, cur);
      flushTimer ??= setTimeout(flushDeltas, FLUSH_MS);
      break;
    }
    case "item": {
      if (!current(ev)) return;
      // Queued text belongs before this item's state.
      flushDeltas();
      setChat((s) => ({
        messages: patchMessage(s.messages, ev.conversationId, ev.messageId, (m) => ({ ...m, items: upsertItem(m.items, ev.item) })),
      }));
      break;
    }
    case "output": {
      if (!current(ev)) return;
      setChat((s) => {
        const list = s.messages[ev.conversationId];
        if (!list) return {};
        const next = list.map((m) =>
          m.items.some((i) => i.id === ev.itemId)
            ? {
                ...m,
                items: m.items.map((i) =>
                  i.id === ev.itemId && i.body.kind === "command" ? { ...i, body: { ...i.body, output: i.body.output + ev.text } } : i,
                ),
              }
            : m,
        );
        return { messages: { ...s.messages, [ev.conversationId]: next } };
      });
      break;
    }
    case "status": {
      if (!current(ev)) return;
      setChat((s) => ({ conversations: s.conversations.map((c) => (c.id === ev.conversationId ? { ...c, status: ev.status } : c)) }));
      break;
    }
    case "usage": {
      if (!current(ev)) return;
      setChat((s) => ({ messages: patchMessage(s.messages, ev.conversationId, ev.messageId, (m) => ({ ...m, usage: ev.usage })) }));
      break;
    }
    case "finished": {
      pending.delete(ev.message.id);
      flushDeltas();
      setChat((s) => {
        const requests = { ...s.requests };
        if (requests[ev.conversationId] === ev.requestId) delete requests[ev.conversationId];
        return {
          requests,
          // The stored message and conversation are authoritative.
          messages: patchMessage(s.messages, ev.conversationId, ev.message.id, () => ev.message),
          conversations: s.conversations.map((c) => (c.id === ev.conversationId ? ev.conversation : c)),
        };
      });
      onTurnFinished(ev.message, ev.conversation);
      break;
    }
  }
}

function onTurnFinished(message: ChatMessage, conv: Conversation) {
  // The backend updates key status from real requests; mirror it.
  const provider = message.engine ? ENGINE_PROVIDER[message.engine] : undefined;
  const kind = message.error?.kind;
  const succeeded = !kind || kind === "truncated";
  if (provider && (kind === "invalid_key" || (succeeded && getChat().providers[provider]?.state !== "ok"))) void refreshProviders();
  if (kind === "not_signed_in" || kind === "engine_not_found") void recheckEngines(conv.engine);
  // Agent edits are on disk; refresh the editor and explorer without waiting for the watcher.
  const changed = message.items.filter((i) => i.body.kind === "file_change").map((i) => (i.body.kind === "file_change" ? i.body.path : ""));
  if (conv.projectId && changed.length) notifyFilesChanged(conv.projectId, changed, conv.id);
}

let filesChangedHook: ((projectId: string, paths: string[], conversationId: string) => void) | null = null;
/** The app registers its file-change fan-out here (keeps Chat independent of the editor). */
export function onAgentFilesChanged(hook: (projectId: string, paths: string[], conversationId: string) => void) {
  filesChangedHook = hook;
}
function notifyFilesChanged(projectId: string, paths: string[], conversationId: string) {
  filesChangedHook?.(projectId, paths, conversationId);
}

// ---------- file changes ----------

function patchItemEverywhere(item: ChatItem) {
  setChat((s) => {
    const messages = { ...s.messages };
    for (const [cid, list] of Object.entries(s.messages)) {
      if (list.some((m) => m.id === item.messageId)) {
        messages[cid] = list.map((m) => (m.id === item.messageId ? { ...m, items: upsertItem(m.items, item) } : m));
      }
    }
    return { messages };
  });
}

/** Keep or revert one agent file change. Reverting restores the checkpoint. */
export async function setFileChange(itemId: string, keep: boolean, projectId: string | null) {
  try {
    const item = await ipc.chatSetChange(itemId, keep);
    patchItemEverywhere(item);
    const conv = getChat().conversations.find((c) => (getChat().messages[c.id] ?? []).some((m) => m.id === item.messageId));
    if (!keep && projectId && conv && item.body.kind === "file_change") notifyFilesChanged(projectId, [item.body.path], conv.id);
  } catch (e) {
    toast(errorMessage(e), "danger");
  }
}

export async function keepAll(conversationId: string, projectId: string | null) {
  const ids = pendingChanges(conversationId).map((i) => i.id);
  for (const id of ids) await setFileChange(id, true, projectId);
}

/** File changes of a conversation that are still on disk unreviewed. */
export function pendingChanges(conversationId: string, s: ChatState = getChat()): ChatItem[] {
  return (s.messages[conversationId] ?? []).flatMap((m) => m.items.filter((i) => i.body.kind === "file_change" && i.body.state === "applied"));
}

export function requestRevertAll(conversationId: string) {
  const itemIds = pendingChanges(conversationId)
    .filter((i) => i.body.kind === "file_change" && i.body.checkpoint)
    .map((i) => i.id);
  if (itemIds.length) setApp({ dialog: { type: "revertAll", conversationId, itemIds } });
}

export async function revertAll(itemIds: string[], projectId: string | null) {
  setApp({ dialog: null });
  for (const id of itemIds) await setFileChange(id, false, projectId);
}

export function openChange(itemId: string) {
  setChat((s) => ({ panel: { ...s.panel, open: true, tab: "changes", itemId } }));
}

// ---------- manage ----------

export async function renameConversation(id: string, title: string) {
  setChat({ renamingId: null });
  const conv = getChat().conversations.find((c) => c.id === id);
  const clean = title.trim();
  if (!conv || !clean || clean === conv.title) return;
  setChat((s) => ({ conversations: s.conversations.map((c) => (c.id === id ? { ...c, title: clean } : c)) }));
  try {
    const saved = await ipc.chatRenameConversation(id, clean);
    setChat((s) => ({ conversations: s.conversations.map((c) => (c.id === id ? saved : c)) }));
  } catch (e) {
    setChat((s) => ({ conversations: s.conversations.map((c) => (c.id === id ? conv : c)) }));
    toast(`Couldn't rename the chat: ${errorMessage(e)}`, "danger");
  }
}

export function requestDeleteConversation(id: string) {
  setApp({ dialog: { type: "deleteChat", conversationId: id } });
}

/** Called after the user confirms. Stops its turn if one runs. */
export async function deleteConversation(id: string) {
  try {
    await ipc.chatDeleteConversation(id);
  } catch (e) {
    toast(`Couldn't delete the chat: ${errorMessage(e)}`, "danger");
    return;
  }
  setChat((s) => {
    const { [id]: _m, ...messages } = s.messages;
    const { [id]: _r, ...requests } = s.requests;
    const { [id]: _d, ...drafts } = s.drafts;
    const { [id]: _i, ...images } = s.images;
    const active = Object.fromEntries(Object.entries(s.active).map(([k, v]) => [k, v === id ? null : v]));
    return { conversations: s.conversations.filter((c) => c.id !== id), messages, requests, drafts, images, active };
  });
}

/** Copy to the clipboard; resolves false when the webview refuses. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    toast("Couldn't copy to the clipboard", "danger");
    return false;
  }
}

/** A plan as Markdown (Copy as Markdown). */
export function planMarkdown(steps: { text: string; status: string }[], explanation: string | null): string {
  const lines = steps.map((s, i) => `${i + 1}. ${s.status === "completed" ? "~~" + s.text + "~~" : s.text}`);
  return [explanation ? explanation.trim() : null, lines.join("\n")].filter(Boolean).join("\n\n");
}

/** Plan → Agent in the same conversation (after the inline confirmation). */
export function implementPlan(projectId: string | null = chatProject()) {
  requestMode("agent", projectId);
}

export const sendKeyLabel = (sendKey: ChatPrefs["sendKey"]) => (sendKey === "enter" ? "ENTER" : "CTRL ENTER");
