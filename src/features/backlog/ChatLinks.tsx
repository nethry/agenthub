// Where Chat shows the backlog: the item a chat was started from, its context
// as sent (or about to be sent), and saving a plan back to the item.
import { useEffect, useState } from "react";
import { ClipboardList, X } from "lucide-react";
import { detachBacklog } from "@/features/chat/actions";
import { useChat } from "@/features/chat/store";
import { errorMessage, ipc } from "@/lib/ipc";
import type { Conversation } from "@/lib/types";
import { cn } from "@/lib/utils";
import { openItem, savePlanFromChat, useProjectBacklog } from "./actions";
import { KindIcon } from "./KindIcon";
import { itemKey, PURPOSE, statusLabel } from "./model";
import { itemForConversation, useBacklog } from "./store";

const chipCls = "inline-flex h-[22px] items-center gap-1.5 border border-line px-2 font-mono text-[10.5px] text-accent-hover";

/** The context text in a scrollable well. */
function ContextText({ text }: { text: string }) {
  return (
    <pre className="m-0 max-h-[260px] w-full overflow-auto border border-line-dim bg-well px-3 py-2 font-mono text-[11.5px] leading-[18px] whitespace-pre-wrap text-body select-text">
      {text}
    </pre>
  );
}

/** On a sent message: the backlog context the agent got, expandable. */
export function BacklogContextChip({ label, text }: { label: string; text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex max-w-[560px] flex-col items-end gap-1.5">
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className={cn(chipCls, "bg-transparent hover:border-line-strong")} title="Context sent with this message">
        <ClipboardList className="size-3" />
        {label} · BACKLOG CONTEXT
      </button>
      {open && <ContextText text={text} />}
    </div>
  );
}

/** In the composer: the item the draft is about; its context is built when sent. */
export function PendingBacklogChip({ draftKey }: { draftKey: string }) {
  const ref = useChat((s) => s.backlog[draftKey]);
  const item = useBacklog((s) => (ref ? Object.values(s.items).flat().find((i) => i.id === ref.itemId) : undefined));
  const [preview, setPreview] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open || !ref) return;
    let stale = false;
    setPreview(null);
    ipc
      .backlogContextPreview(ref.itemId)
      .then((t) => !stale && setPreview(t))
      .catch((e) => !stale && setPreview(`Couldn't build the context: ${errorMessage(e)}`));
    return () => {
      stale = true;
    };
  }, [open, ref]);
  if (!ref) return null;
  const label = item ? `${itemKey(item)} · ${item.title}` : "Backlog item";
  return (
    <div className="flex w-full flex-col gap-1.5">
      <span className={chipCls} title="The item and the project's other open items go with your message as context">
        <ClipboardList className="size-3" />
        <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="max-w-[360px] truncate border-0 bg-transparent p-0 font-mono text-[10.5px] text-accent-hover hover:text-fg">
          {label} · {PURPOSE[ref.purpose].label.toUpperCase()} · CONTEXT
        </button>
        <button type="button" aria-label="Don't send the backlog context" onClick={() => detachBacklog(draftKey)} className="flex border-0 bg-transparent p-0.5 text-muted hover:text-fg">
          <X className="size-3" />
        </button>
      </span>
      {open && (preview ? <ContextText text={preview} /> : <span className="font-mono text-[10px] text-muted">LOADING…</span>)}
    </div>
  );
}

/** In a chat's header: the item it was started from. */
export function LinkedItemChip({ conv }: { conv: Conversation }) {
  useProjectBacklog(conv.projectId);
  const item = useBacklog((s) => itemForConversation(s, conv.projectId, conv.id));
  if (!item) return null;
  return (
    <button
      type="button"
      onClick={() => openItem(item)}
      title={`${item.title} · ${statusLabel(item.kind, item.status)} · open in Backlog`}
      className="inline-flex h-5 shrink-0 items-center gap-1 border border-line px-1.5 font-mono text-[10.5px] text-term hover:border-line-strong hover:text-fg"
    >
      <KindIcon kind={item.kind} className="size-3" />
      {itemKey(item)}
    </button>
  );
}

/** "Save to FEAT-12" for a plan or an answer in a chat started from an item. */
export function SavePlanButton({ conv, plan, className, compact }: { conv: Conversation; plan: () => string; className?: string; compact?: boolean }) {
  const item = useBacklog((s) => itemForConversation(s, conv.projectId, conv.id));
  if (!item) return null;
  const label = `${compact ? "SAVE AS PLAN OF" : "Save to"} ${itemKey(item)}`;
  return (
    <button
      type="button"
      aria-label={`Save as the plan of ${itemKey(item)}`}
      onClick={() => void savePlanFromChat(item, plan())}
      className={cn(
        compact
          ? "flex h-[26px] items-center gap-1.5 border-0 bg-transparent px-1.5 font-mono text-[10.5px] text-muted transition-colors duration-200 hover:text-fg"
          : "inline-flex h-[26px] items-center gap-1.5 border border-plan/50 bg-transparent px-2.5 font-display text-[12px] font-semibold tracking-[0.12em] text-plan uppercase hover:bg-plan/10",
        className,
      )}
    >
      <ClipboardList className="size-3.5" />
      {label}
    </button>
  );
}
