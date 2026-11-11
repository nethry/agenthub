import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Splitter } from "@/components/ui/splitter";
import { chatLayout, LIST_MIN, PANEL_MIN, TRANSCRIPT_MIN } from "./layout";
import { Bot, MoreHorizontal, PanelLeftOpen, PanelRight, Pencil, Trash2 } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { IconButton } from "@/components/ui/button";
import { LinkedItemChip } from "@/features/backlog/ChatLinks";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu";
import type { ChatMode, Conversation } from "@/lib/types";
import { cn } from "@/lib/utils";
import {
  activeConversation,
  cancelModeConfirm,
  composerConfig,
  confirmAgentMode,
  ensureChatLoaded,
  refreshProviders,
  requestDeleteConversation,
  requestMode,
  setDraft,
  setChatPrefs,
  stopGenerating,
  toggleConversationList,
} from "./actions";
import { ChangesPanel } from "./ChangesPanel";
import { HexMark } from "./ChatMessage";
import { ChatSidebar, RenameInput } from "./ChatSidebar";
import { Composer } from "./Composer";
import { Chip } from "./items";
import { MessageList } from "./MessageList";
import { ENGINE_LABEL, engineOn, isAgent, MODE_META, modelLabel, POLICY_LABEL, statusChip, tint, workspaceKey } from "./models";
import { draftKey, getChat, setChat, useChat } from "./store";

/** The only AI surface: a workspace's conversations, transcript, composer and changes. */
export function ChatView({ projectId, projectName }: { projectId: string | null; projectName: string }) {
  const collapsed = useChat((s) => s.prefs.listCollapsed);
  const focus = useChat((s) => s.focus);
  const loaded = useChat((s) => s.loaded);
  const conv = useChat((s) => activeConversation(s, projectId));
  const panelOpen = useChat((s) => s.panel.open);
  const rootRef = useRef<HTMLDivElement>(null);
  const listWidth = useChat((s) => s.prefs.listWidth);
  const panelWidth = useChat((s) => s.prefs.panelWidth);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    setWidth(el.clientWidth);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (getChat().loaded) void refreshProviders();
    else void ensureChatLoaded();
  }, []);

  // Esc stops the turn while focus is in Chat (never bound globally:
  // terminals need Esc). Menus and dialogs handle their own Esc first.
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || e.defaultPrevented) return;
    const s = getChat();
    if (s.menuOpen || s.renamingId || !rootRef.current?.contains(e.target as Node)) return;
    if (s.modeConfirm) {
      e.preventDefault();
      cancelModeConfirm();
      return;
    }
    const c = activeConversation(s, projectId);
    if (c && s.requests[c.id]) {
      e.preventDefault();
      stopGenerating(c.id);
    }
  };

  const showPanel = !!conv && isAgent(conv.engine) && panelOpen && !focus;
  const showList = !collapsed && !focus;
  const sizes = chatLayout(width, listWidth, panelWidth, showList, showPanel);

  return (
    <div ref={rootRef} className="flex min-h-0 min-w-0 flex-1 overflow-x-auto" onKeyDown={onKeyDown}>
      {showList && <>
        <ChatSidebar projectId={projectId} projectName={projectName} width={sizes.list} />
        <Splitter label="Resize conversations" side="left" value={sizes.list} min={LIST_MIN} max={sizes.listMax} onChange={(v) => setChatPrefs({ listWidth: v })} />
      </>}
      <section style={{ minWidth: TRANSCRIPT_MIN }} className="relative flex flex-1 flex-col">
        {conv && <ConversationHeader conv={conv} collapsed={collapsed || focus} />}
        {!loaded ? (
          <div className="flex flex-1 items-center justify-center font-mono text-[11px] text-muted">LOADING CHATS…</div>
        ) : conv ? (
          <MessageList key={conv.id} conv={conv} />
        ) : (
          <EmptyChat projectId={projectId} projectName={projectName} collapsed={collapsed || focus} />
        )}
        <ModeConfirmBar projectId={projectId} projectName={projectName} />
        <div className="shrink-0 px-7 pt-1.5 pb-3.5">
          <div className="mx-auto max-w-[760px]">{loaded && <Composer projectId={projectId} />}</div>
        </div>
      </section>
      {showPanel && <>
        <Splitter label="Resize changes and activity" side="right" value={sizes.panel} min={PANEL_MIN} max={sizes.panelMax} onChange={(v) => setChatPrefs({ panelWidth: v })} />
        <ChangesPanel conv={conv} width={sizes.panel} />
      </>}
    </div>
  );
}

function ConversationHeader({ conv, collapsed }: { conv: Conversation; collapsed: boolean }) {
  const renaming = useChat((s) => s.renamingId === conv.id);
  const running = useChat((s) => !!s.requests[conv.id]);
  const panelOpen = useChat((s) => s.panel.open);
  const chip = statusChip(conv, running);
  const mode = MODE_META[conv.mode];
  return (
    <div className="flex h-[46px] shrink-0 items-center gap-2.5 border-b border-line pr-3.5 pl-5">
      {collapsed && (
        <IconButton aria-label="Show conversations (Ctrl B)" bordered size={30} onClick={toggleConversationList}>
          <PanelLeftOpen className="size-4" />
        </IconButton>
      )}
      {renaming ? (
        <div className="max-w-[420px] min-w-0 flex-1">
          <RenameInput conv={conv} />
        </div>
      ) : (
        <h2 className="m-0 min-w-0 truncate text-[14.5px] font-semibold" title={conv.title} onDoubleClick={() => setChat({ renamingId: conv.id })}>
          {conv.title}
        </h2>
      )}
      <LinkedItemChip conv={conv} />
      {conv.projectId && (
        <span
          className="inline-flex h-5 shrink-0 items-center border px-1.5 font-display text-[11px] font-bold tracking-[0.14em] uppercase"
          style={{ borderColor: tint(mode.tone, 55), color: mode.color }}
        >
          {mode.label}
        </span>
      )}
      <span className="truncate font-mono text-[10.5px] text-muted">
        {ENGINE_LABEL[conv.engine]} · {modelLabel(conv.model)}
        {conv.mode === "agent" ? ` · ${POLICY_LABEL[conv.policy].toUpperCase()}` : ""}
      </span>
      <span className="flex-1" />
      {chip && <Chip kind={chip} />}
      {isAgent(conv.engine) && (
        <IconButton
          aria-label="Changes panel"
          aria-pressed={panelOpen}
          bordered
          size={30}
          active={panelOpen}
          onClick={() => setChat((s) => ({ panel: { ...s.panel, open: !s.panel.open } }))}
        >
          <PanelRight className="size-4" />
        </IconButton>
      )}
      <Menu>
        <MenuTrigger asChild>
          <IconButton aria-label="Chat actions" bordered size={30}>
            <MoreHorizontal className="size-4" />
          </IconButton>
        </MenuTrigger>
        <MenuContent align="end" width={200}>
          <MenuItem icon={<Pencil className="size-4" />} onSelect={() => setTimeout(() => setChat({ renamingId: conv.id }), 0)}>
            Rename
          </MenuItem>
          <MenuItem danger icon={<Trash2 className="size-4" />} onSelect={() => requestDeleteConversation(conv.id)}>
            Delete chat
          </MenuItem>
        </MenuContent>
      </Menu>
    </div>
  );
}

/** Inline confirmation before a conversation may edit files and run tools. */
function ModeConfirmBar({ projectId, projectName }: { projectId: string | null; projectName: string }) {
  const confirm = useChat((s) => s.modeConfirm);
  const cfg = useChat(useShallow((s) => composerConfig(s, projectId)));
  if (!confirm || confirm.ws !== workspaceKey(projectId)) return null;
  return (
    <div className="shrink-0 px-7 pb-2">
      <div
        role="alertdialog"
        aria-label="Switch to Agent mode"
        className="hud hud-agent rise mx-auto flex max-w-[760px] flex-wrap items-center gap-3.5 border border-agent/50 bg-surface px-3.5 py-3 hud:shadow-[0_0_24px_rgba(56,225,255,0.1)]"
      >
        <Bot className="size-[18px] text-agent" />
        <span className="flex min-w-[260px] flex-1 flex-col gap-0.5">
          <span className="font-semibold">Switch this conversation to Agent mode?</span>
          <span className="text-[12.5px] text-body">
            {ENGINE_LABEL[cfg.engine]} will be able to edit files in {projectName} and run tools. Policy: {POLICY_LABEL[cfg.policy]}.
          </span>
        </span>
        <button
          type="button"
          autoFocus
          onClick={cancelModeConfirm}
          className="h-[30px] border border-line bg-accent/[0.05] px-3 font-display text-[12.5px] font-semibold tracking-[0.12em] uppercase hover:border-line-strong"
        >
          Stay in {MODE_META[cfg.mode].label}
        </button>
        <button
          type="button"
          onClick={confirmAgentMode}
          className="chamfer h-[30px] border-0 bg-accent-fill px-3.5 font-display text-[12.5px] font-bold tracking-[0.14em] text-on-accent uppercase hover:bg-accent-fill-hover"
        >
          Switch to Agent
        </button>
      </div>
    </div>
  );
}

const STARTERS_GENERAL: { mode: ChatMode; text: string }[] = [
  { mode: "ask", text: "Explain lifetimes in Rust closures passed to thread::spawn" },
  { mode: "ask", text: "Compare Zustand and Redux Toolkit for a desktop app" },
  { mode: "ask", text: "Review this snippet for bugs and readability issues:\n\n" },
];

const STARTERS_PROJECT: { mode: ChatMode; text: string }[] = [
  { mode: "plan", text: "Find the cause of this error and plan a fix:\n\n" },
  { mode: "plan", text: "Plan how to add " },
  { mode: "agent", text: "Add tests for " },
];

function EmptyChat({ projectId, projectName, collapsed }: { projectId: string | null; projectName: string; collapsed: boolean }) {
  const ws = workspaceKey(projectId);
  const cfg = useChat(useShallow((s) => composerConfig(s, projectId)));
  const hasChats = useChat((s) => s.conversations.some((c) => c.projectId === projectId && engineOn(s.engines, c.engine)));
  const starters = projectId ? STARTERS_PROJECT : STARTERS_GENERAL;
  const fill = (text: string, mode: ChatMode) => {
    setDraft(draftKey(ws, null), text);
    if (projectId) requestMode(mode, projectId);
    requestAnimationFrame(() => {
      const el = document.getElementById("chat-composer") as HTMLTextAreaElement | null;
      el?.focus();
      el?.setSelectionRange(el.value.length, el.value.length);
    });
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {collapsed && (
        <div className="flex h-12 shrink-0 items-center gap-2 px-3.5">
          <IconButton aria-label="Show conversations (Ctrl B)" bordered size={30} onClick={toggleConversationList}>
            <PanelLeftOpen className="size-4" />
          </IconButton>
        </div>
      )}
      <div className="flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-7 pt-14 pb-6">
        <div className="rise flex w-full max-w-[760px] flex-col items-center gap-4 text-center">
          <HexMark className="size-[42px] hud:drop-shadow-[0_0_10px_rgba(77,163,255,0.55)] [stroke-width:1.2]" />
          <h1 className="glow-text m-0 font-display text-[30px] leading-[34px] font-bold tracking-[0.08em] uppercase">
            {projectId ? (hasChats ? `New chat in ${projectName}` : `No chats in ${projectName} yet`) : "Ask anything"}
          </h1>
          <p className="m-0 max-w-[520px] text-[14px] leading-[22px] text-body">
            {projectId
              ? "A local coding agent plans in Plan mode and edits files only in Agent mode, with your approval. Use Ask for quick questions."
              : "Ask chats aren't linked to a project. Direct APIs answer questions here; paste images with Ctrl V if they help, nothing runs. Open a project to use a coding agent."}
          </p>
          <div className="mt-2 grid w-full grid-cols-[repeat(auto-fit,minmax(min(220px,100%),1fr))] gap-2.5">
            {starters.map((s) => (
              <button
                key={s.text}
                type="button"
                onClick={() => fill(s.text, s.mode)}
                className="flex flex-col items-start gap-1.5 border border-line bg-overlay/85 px-3.5 py-3 text-left transition-colors duration-200 hover:border-line-strong hover:bg-accent/5"
              >
                {projectId && (
                  <span
                    className="inline-flex h-[18px] items-center border px-1.5 font-display text-[10px] font-bold tracking-[0.14em] uppercase"
                    style={{ borderColor: MODE_META[s.mode].color, color: MODE_META[s.mode].color }}
                  >
                    {MODE_META[s.mode].label}
                  </span>
                )}
                <span className={cn("text-[13px] leading-[19px]")}>{s.text.trim()}…</span>
              </button>
            ))}
          </div>
          <span className="font-mono text-[10.5px] text-muted">
            {ENGINE_LABEL[cfg.engine].toUpperCase()} · {modelLabel(cfg.model).toUpperCase()} · {MODE_META[cfg.mode].hint}
          </span>
        </div>
      </div>
    </div>
  );
}
