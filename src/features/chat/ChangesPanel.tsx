import { useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";
import { openFile } from "@/app/actions";
import { Button, IconButton } from "@/components/ui/button";
import { errorMessage, ipc } from "@/lib/ipc";
import type { ChatItem, ChatMessage, Conversation, FileDiff } from "@/lib/types";
import { basename, cn, dirname } from "@/lib/utils";
import { keepAll, openChange, pendingChanges, requestRevertAll, setFileChange } from "./actions";
import { clockTime } from "./models";
import { setChat, useChat } from "./store";

const EMPTY: ChatMessage[] = [];

/** File changes of a conversation, newest per path last-wins. */
export function changesOf(messages: ChatMessage[]): ChatItem[] {
  const byPath = new Map<string, ChatItem>();
  for (const m of messages) for (const i of m.items) if (i.body.kind === "file_change") byPath.set(i.body.path, i);
  return [...byPath.values()];
}

/** Right panel for agent chats: Changes (diffs, keep/revert) and Activity. */
export function ChangesPanel({ conv }: { conv: Conversation }) {
  const panel = useChat((s) => s.panel);
  const messages = useChat((s) => s.messages[conv.id] ?? EMPTY);
  const running = useChat((s) => !!s.requests[conv.id]);
  const files = useMemo(() => changesOf(messages), [messages]);
  const selected = files.find((f) => f.id === panel.itemId) ?? files[files.length - 1] ?? null;
  const pendingCount = useChat((s) => pendingChanges(conv.id, s).length);

  const tab = (id: "changes" | "activity", label: string) => (
    <button
      type="button"
      role="tab"
      aria-selected={panel.tab === id}
      onClick={() => setChat((s) => ({ panel: { ...s.panel, tab: id } }))}
      className={cn(
        "border-0 bg-transparent px-4 font-display text-[12.5px] font-bold tracking-[0.14em] uppercase",
        panel.tab === id ? "text-accent shadow-[inset_0_-2px_0_#4DA3FF]" : "text-muted hover:text-fg",
      )}
    >
      {label}
    </button>
  );

  return (
    <aside aria-label="Changes and activity" className="rise flex w-[380px] shrink-0 flex-col border-l border-line bg-surface">
      <div role="tablist" aria-label="Panel" className="flex h-[46px] shrink-0 items-stretch border-b border-line">
        {tab("changes", `Changes${files.length ? ` · ${files.length}` : ""}`)}
        {tab("activity", "Activity")}
        <span className="flex-1" />
        <IconButton aria-label="Close panel" size={40} className="h-full" onClick={() => setChat((s) => ({ panel: { ...s.panel, open: false } }))}>
          <X className="size-4" />
        </IconButton>
      </div>
      {panel.tab === "changes" ? (
        <>
          <div className="flex max-h-[38%] shrink-0 flex-col overflow-y-auto border-b border-line py-1.5">
            {files.map((f) => {
              const b = f.body as Extract<ChatItem["body"], { kind: "file_change" }>;
              const sel = selected?.id === f.id;
              return (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => openChange(f.id)}
                  className={cn(
                    "flex items-center gap-2 border-0 px-3.5 py-[7px] text-left text-[12.5px]",
                    sel ? "bg-accent/10 shadow-[inset_2px_0_0_#4DA3FF]" : "bg-transparent hover:bg-accent/5",
                  )}
                >
                  <span className="flex min-w-0 flex-1 flex-col gap-px">
                    <span className={cn(b.state === "reverted" ? "text-muted line-through" : "text-fg")}>{basename(b.path)}</span>
                    <span className="truncate font-mono text-[10px] text-muted">{dirname(b.path) || "/"}</span>
                  </span>
                  {b.state !== "applied" && <span className="font-mono text-[9.5px] text-muted uppercase">{b.state}</span>}
                  <span className="font-mono text-[11px] text-run">+{b.additions}</span>
                  <span className="font-mono text-[11px] text-danger">−{b.deletions}</span>
                </button>
              );
            })}
            {files.length === 0 && (
              <p className="m-0 px-3.5 py-2.5 text-[12.5px] text-muted">
                {running ? "No file changes yet. Edits appear here as the agent writes them." : "No file changes in this conversation."}
              </p>
            )}
          </div>
          {selected ? (
            <DiffView item={selected} conv={conv} />
          ) : (
            <div className="flex-1" />
          )}
          {pendingCount > 0 && (
            <div className="flex shrink-0 gap-2 border-t border-line px-3.5 py-2.5">
              <Button className="flex-1" onClick={() => void keepAll(conv.id, conv.projectId)}>
                Keep all
              </Button>
              <Button variant="outline" className="flex-1 border-danger/55 text-danger" onClick={() => requestRevertAll(conv.id)}>
                Revert all
              </Button>
            </div>
          )}
        </>
      ) : (
        <ActivityLog messages={messages} />
      )}
    </aside>
  );
}

function DiffView({ item, conv }: { item: ChatItem; conv: Conversation }) {
  const b = item.body as Extract<ChatItem["body"], { kind: "file_change" }>;
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stale = false;
    setDiff(null);
    setError(null);
    if (!b.checkpoint || b.state === "reverted") return;
    ipc
      .chatFileDiff(item.id)
      .then((d) => !stale && setDiff(d))
      .catch((e) => !stale && setError(errorMessage(e)));
    return () => {
      stale = true;
    };
  }, [item.id, b.checkpoint, b.state, item.updatedAt]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-[38px] shrink-0 items-center gap-2 border-b border-line-dim pr-2.5 pl-3.5">
        <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-term" title={b.path}>
          {b.path}
        </span>
        {conv.projectId && b.change !== "delete" && b.state !== "reverted" && (
          <button type="button" onClick={() => openFile(conv.projectId!, b.path)} className="border-0 bg-transparent p-0 font-mono text-[10.5px] text-accent hover:text-accent-hover">
            OPEN IN EDITOR
          </button>
        )}
        {b.state === "applied" && b.checkpoint && (
          <button
            type="button"
            onClick={() => void setFileChange(item.id, false, conv.projectId)}
            className="border-0 bg-transparent p-0 font-mono text-[10.5px] text-danger hover:brightness-125"
          >
            REVERT
          </button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-auto py-1.5 font-mono text-[11.5px] leading-[19px] whitespace-pre select-text">
        {b.state === "reverted" ? (
          <p className="m-0 px-3.5 font-sans text-[12.5px] whitespace-normal text-muted">Reverted to the checkpoint taken before the agent's edit.</p>
        ) : !b.checkpoint ? (
          <p className="m-0 px-3.5 font-sans text-[12.5px] whitespace-normal text-muted">
            This file was too large to checkpoint, so there's no diff or Revert here. Open it in the editor to review.
          </p>
        ) : error ? (
          <p className="m-0 px-3.5 font-sans text-[12.5px] whitespace-normal text-danger">{error}</p>
        ) : !diff ? (
          <p className="m-0 px-3.5 text-[10.5px] text-muted">LOADING DIFF…</p>
        ) : diff.binary ? (
          <p className="m-0 px-3.5 font-sans text-[12.5px] whitespace-normal text-muted">Binary file changed.</p>
        ) : diff.lines.length === 0 ? (
          <p className="m-0 px-3.5 font-sans text-[12.5px] whitespace-normal text-muted">No differences from the checkpoint (the file is back to its original content).</p>
        ) : (
          diff.lines.map((l, i) => (
            <div
              key={i}
              className={cn(
                "px-3.5",
                l.tag === "@" && "bg-plan/[0.06] text-plan",
                l.tag === "+" && "bg-run/[0.08] text-[#C9F7DE]",
                l.tag === "-" && "bg-danger/[0.08] text-[#FFC2CC]",
                l.tag === " " && "text-muted",
              )}
            >
              {l.tag === "@" ? l.text : `${l.tag}${l.text}`}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function ActivityLog({ messages }: { messages: ChatMessage[] }) {
  const rows = messages.flatMap((m) => m.items.filter((i) => ["tool", "command", "permission", "plan", "file_change", "system"].includes(i.body.kind)));
  const label = (i: ChatItem): [string, string, string] => {
    const b = i.body;
    switch (b.kind) {
      case "tool":
        return [b.tool.toUpperCase(), b.title, "text-accent"];
      case "command":
        return ["RUN", b.command, "text-accent"];
      case "permission":
        return ["ASK", `${b.decision ? b.decision.replace("_", " ").toUpperCase() : "PENDING"} · ${b.request.command ?? b.request.title}`, "text-warn"];
      case "plan":
        return ["PLAN", `${b.steps.length} steps`, "text-plan"];
      case "file_change":
        return ["EDIT", `${b.path} +${b.additions} −${b.deletions}`, "text-agent"];
      case "system":
        return ["NOTE", b.text, "text-muted"];
      default:
        return ["", "", ""];
    }
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-3.5 py-2.5 font-mono text-[11px] leading-[17px]">
      {rows.map((i) => {
        const [kind, text, color] = label(i);
        return (
          <div key={i.id} className="flex gap-2.5">
            <span className={cn("w-[52px] shrink-0", color)}>{kind}</span>
            <span className="min-w-0 flex-1 break-words text-term">{text}</span>
            <span className="text-muted">{clockTime(i.createdAt)}</span>
          </div>
        );
      })}
      {rows.length === 0 && <span className="text-muted">NO ACTIVITY YET</span>}
      <span className="mt-1.5 text-muted">RAW RUNTIME EVENTS ARE NEVER SHOWN · AGENTHUB STORES TYPED ITEMS ONLY</span>
    </div>
  );
}
