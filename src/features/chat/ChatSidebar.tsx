import { useRef, useState } from "react";
import { MoreHorizontal, PanelLeftClose, Pencil, Plus, Search, Trash2 } from "lucide-react";
import { IconButton } from "@/components/ui/button";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu";
import { useNow } from "@/lib/hooks";
import type { Conversation } from "@/lib/types";
import { cn } from "@/lib/utils";
import { newChat, renameConversation, requestDeleteConversation, selectConversation, toggleConversationList } from "./actions";
import { Chip } from "./items";
import { conversationsIn, ENGINE_LABEL, listTime, matchesSearch, MODE_META, statusChip, visibleConversations, workspaceKey } from "./models";
import { setChat, useChat } from "./store";

/**
 * A workspace's conversations: New chat, search, newest activity first, each
 * with its mode, engine and status. Only this workspace's chats are listed;
 * they keep running when you switch away.
 */
export function ChatSidebar({ projectId, projectName }: { projectId: string | null; projectName: string }) {
  const ws = workspaceKey(projectId);
  const all = useChat((s) => s.conversations);
  const engines = useChat((s) => s.engines);
  const activeId = useChat((s) => s.active[ws] ?? null);
  const query = useChat((s) => s.query[ws] ?? "");
  const now = useNow(60_000);
  const mine = conversationsIn(visibleConversations(all, engines), projectId);
  const shown = mine.filter((c) => matchesSearch(c, query));

  return (
    <aside aria-label="Conversations" className="flex w-[268px] shrink-0 flex-col border-r border-line bg-[rgba(5,8,13,0.85)]">
      <div className="flex items-center gap-2 px-3 pt-3 pb-2">
        <button
          type="button"
          onClick={() => newChat(projectId)}
          aria-current={activeId === null ? "page" : undefined}
          className="flex h-8 flex-1 items-center gap-2 border border-accent/50 bg-accent/10 px-2.5 font-display text-[13px] font-bold tracking-[0.14em] text-accent uppercase transition-colors duration-200 hover:bg-accent/15"
        >
          <Plus className="size-4" />
          <span className="flex-1 text-left">New chat</span>
          <kbd className="font-mono text-[10px] font-normal tracking-normal text-muted">CTRL N</kbd>
        </button>
        <IconButton aria-label="Collapse conversation list (Ctrl B)" bordered size={32} onClick={toggleConversationList}>
          <PanelLeftClose className="size-4" />
        </IconButton>
      </div>
      <div className="relative px-3 pb-2">
        <label htmlFor="chat-search" className="sr-only">
          Search conversations
        </label>
        <Search className="pointer-events-none absolute top-2 left-[22px] size-3.5 text-muted" />
        <input
          id="chat-search"
          value={query}
          onChange={(e) => setChat((s) => ({ query: { ...s.query, [ws]: e.target.value } }))}
          placeholder={`Search ${projectId ? projectName : "Ask"} chats`}
          autoComplete="off"
          spellCheck={false}
          className="h-[30px] w-full border border-line bg-surface pr-2.5 pl-[30px] text-[12px] outline-none placeholder:text-dim focus:border-accent"
        />
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto pb-2">
        <h2 className="label-caps m-0 px-[18px] pt-2 pb-1 text-[11px] text-muted">{projectId ? projectName : "Ask"}</h2>
        {mine.length === 0 ? (
          <p className="m-0 px-[18px] pt-1 text-[12px] leading-[18px] text-muted">
            {projectId
              ? "No conversations yet. Each project keeps its own chats; they keep running when you switch projects."
              : "No conversations yet. Ask chats aren't linked to a project and use direct APIs."}
          </p>
        ) : shown.length === 0 ? (
          <p className="m-0 px-[18px] pt-1 text-[12px] text-muted">No chats match “{query.trim()}”.</p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
            {shown.map((c) => (
              <ConversationItem key={c.id} conv={c} active={c.id === activeId} now={now} />
            ))}
          </ul>
        )}
      </div>
      <div className="border-t border-line px-3.5 py-2.5 font-mono text-[10px] text-muted">
        {String(mine.length).padStart(2, "0")} CONVERSATION{mine.length === 1 ? "" : "S"} · STORED LOCALLY
      </div>
    </aside>
  );
}

function ConversationItem({ conv, active, now }: { conv: Conversation; active: boolean; now: number }) {
  const running = useChat((s) => !!s.requests[conv.id]);
  const renaming = useChat((s) => s.renamingId === conv.id);
  const chip = statusChip(conv, running);
  const mode = MODE_META[conv.mode];

  if (renaming) {
    return (
      <li className="mx-2 p-1.5">
        <RenameInput conv={conv} />
      </li>
    );
  }

  return (
    <li className="group relative mx-2">
      <button
        type="button"
        onClick={() => void selectConversation(conv.id)}
        onDoubleClick={() => setChat({ renamingId: conv.id })}
        aria-current={active ? "page" : undefined}
        title={conv.title}
        className={cn(
          "flex w-full items-start gap-2.5 border-0 px-2.5 py-[9px] text-left transition-colors duration-200",
          active ? "bg-accent/10 shadow-[inset_2px_0_0_#4DA3FF]" : "bg-transparent hover:bg-accent/5",
        )}
      >
        <span className="flex min-w-0 flex-1 flex-col gap-[5px]">
          <span className={cn("truncate text-[13px]", active ? "text-fg" : "text-term")}>{conv.title}</span>
          <span className="flex items-center gap-1.5 truncate font-mono text-[10px] text-muted uppercase">
            {conv.projectId && (
              <>
                <span className="size-1.5 shrink-0" style={{ background: mode.color }} />
                {mode.label} ·{" "}
              </>
            )}
            {ENGINE_LABEL[conv.engine]}
          </span>
        </span>
        <span className="flex shrink-0 flex-col items-end gap-[5px] group-focus-within:invisible group-hover:invisible">
          <span className="font-mono text-[10px] text-muted">{listTime(conv.updatedAt, now)}</span>
          {chip && <Chip kind={chip} small />}
        </span>
      </button>
      <Menu>
        <MenuTrigger asChild>
          <IconButton
            aria-label={`Actions for ${conv.title}`}
            size={24}
            className="absolute top-1/2 right-1.5 -translate-y-1/2 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100"
          >
            <MoreHorizontal className="size-4" />
          </IconButton>
        </MenuTrigger>
        <MenuContent align="start" side="right" width={200}>
          <MenuItem icon={<Pencil className="size-4" />} onSelect={() => setTimeout(() => setChat({ renamingId: conv.id }), 0)}>
            Rename
          </MenuItem>
          <MenuItem danger icon={<Trash2 className="size-4" />} onSelect={() => requestDeleteConversation(conv.id)}>
            Delete
          </MenuItem>
        </MenuContent>
      </Menu>
    </li>
  );
}

/** Inline title editor: Enter saves, Esc cancels, blur saves. */
export function RenameInput({ conv, className }: { conv: Conversation; className?: string }) {
  const [value, setValue] = useState(conv.title);
  const done = useRef(false);
  const commit = () => {
    if (done.current) return;
    done.current = true;
    void renameConversation(conv.id, value);
  };
  return (
    <>
      <label htmlFor={`rename-${conv.id}`} className="sr-only">
        Chat title
      </label>
      <input
        id={`rename-${conv.id}`}
        autoFocus
        value={value}
        maxLength={120}
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            done.current = true;
            setChat({ renamingId: null });
          }
        }}
        onBlur={commit}
        className={cn("h-7 w-full border border-accent bg-well px-2 text-[13px] shadow-[0_0_10px_rgba(77,163,255,0.3)] outline-none", className)}
      />
    </>
  );
}
