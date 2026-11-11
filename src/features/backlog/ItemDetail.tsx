import { useEffect, useRef, useState, type ClipboardEvent } from "react";
import { ImagePlus, Link2, Pencil, Play, Trash2, X } from "lucide-react";
import { Button, IconButton } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Select } from "@/components/ui/form";
import { openConversation } from "@/features/chat/actions";
import { ChatMarkdown } from "@/features/chat/ChatMarkdown";
import { Chip } from "@/features/chat/items";
import { ENGINE_LABEL, formatBytes, MODE_META, statusChip, visibleConversations } from "@/features/chat/models";
import { useChat } from "@/features/chat/store";
import { ipc } from "@/lib/ipc";
import type { BacklogImage, BacklogItem, BacklogKind, BacklogPriority, BacklogPurpose, BacklogStatus } from "@/lib/types";
import { clipboardImages, cn } from "@/lib/utils";
import {
  addScreenshots,
  confirmDelete,
  createItem,
  dismissSuggestion,
  openItem,
  removeScreenshot,
  savePlan,
  select,
  setStatus,
  startAiAction,
  updateItem,
} from "./actions";
import { KindIcon } from "./KindIcon";
import {
  actionsFor,
  BODY_TEMPLATE,
  itemKey,
  KIND_LABEL,
  MAX_ITEM_IMAGES,
  PRIORITIES,
  PRIORITY_LABEL,
  PURPOSE,
  screenshotPasteError,
  STATUS_ORDER,
  STATUS_TONE,
  statusLabel,
  suggestion,
} from "./model";
import { setBacklog, useBacklog } from "./store";

const fieldCls =
  "w-full border border-line bg-well px-3 py-2.5 text-[13px] leading-5 outline-none transition-[border-color,box-shadow] duration-200 placeholder:text-dim focus:border-accent hud:focus:shadow-[0_0_12px_rgba(77,163,255,0.3)] graphite:focus:shadow-[0_0_0_3px_var(--color-accent-subtle)]";

/** Screenshots in a paste: attach them; a bare image doesn't also paste as text. */
function pastedScreenshots(e: ClipboardEvent, onFiles: (files: File[]) => void) {
  const files = clipboardImages(e.clipboardData);
  if (files.length === 0) return;
  if (!e.clipboardData.getData("text/plain")) e.preventDefault();
  onFiles(files);
}

function ErrorLine() {
  const error = useBacklog((s) => s.error);
  if (!error) return null;
  return (
    <div role="alert" className="flex items-start gap-2 border border-danger/45 bg-danger/[0.06] px-3 py-2 text-[12.5px]">
      <span className="flex-1">{error}</span>
      <IconButton aria-label="Dismiss" size={20} onClick={() => setBacklog({ error: null })}>
        <X className="size-3.5" />
      </IconButton>
    </div>
  );
}

function SectionTitle({ children, aside }: { children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <h3 className="label-caps m-0 text-[11.5px] text-muted">{children}</h3>
      <span className="h-px flex-1 bg-line" />
      {aside}
    </div>
  );
}

// ---------- new item ----------

export function CreateItemForm({ projectId, kind }: { projectId: string; kind: BacklogKind }) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState(BODY_TEMPLATE[kind]);
  const [priority, setPriority] = useState<BacklogPriority>("normal");
  const [shots, setShots] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const urls = useObjectUrls(shots);
  const addShots = (files: File[]) => {
    const problem = screenshotPasteError(files, shots.length);
    if (problem) setBacklog({ error: problem });
    else setShots((cur) => [...cur, ...files]);
  };
  const submit = async () => {
    if (!title.trim() || busy) return;
    setBusy(true);
    const body2 = body.trim() === BODY_TEMPLATE[kind].trim() ? "" : body;
    await createItem({ projectId, kind, title, body: body2, priority }, shots);
    setBusy(false);
  };
  return (
    <form
      className="flex max-w-[880px] flex-col gap-4 px-7 py-6"
      onPaste={(e) => pastedScreenshots(e, addShots)}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="flex items-center gap-2.5">
        <KindIcon kind={kind} className="size-4" />
        <span className="label-caps text-[13px] text-fg">{kind === "feature" ? "New feature" : "Report a bug"}</span>
      </div>
      <ErrorLine />
      <label className="flex flex-col gap-1.5">
        <span className="label-caps text-[11.5px] text-body">Title</span>
        <Input
          autoFocus
          value={title}
          maxLength={200}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={kind === "feature" ? "What should the app do?" : "What goes wrong?"}
        />
      </label>
      <label className="flex flex-col gap-1.5">
        <span className="label-caps text-[11.5px] text-body">{kind === "feature" ? "Description" : "Report"}</span>
        <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={14} spellCheck className={cn(fieldCls, "resize-y font-mono text-[12.5px]")} />
      </label>
      <div className="flex flex-wrap items-end gap-4">
        <label className="flex flex-col gap-1.5">
          <span className="label-caps text-[11.5px] text-body">Priority</span>
          <Select value={priority} onChange={(e) => setPriority(e.target.value as BacklogPriority)}>
            {PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {PRIORITY_LABEL[p]}
              </option>
            ))}
          </Select>
        </label>
        <ScreenshotPicker count={shots.length} onFiles={addShots} />
      </div>
      {shots.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {shots.map((_, i) => (
            <span key={urls[i]} className="relative flex h-[72px] min-w-[72px] items-center justify-center border border-line bg-well">
              <img src={urls[i]} alt={`Screenshot ${i + 1}`} className="h-full max-w-[160px] object-contain" />
              <IconButton
                aria-label={`Remove screenshot ${i + 1}`}
                size={20}
                className="absolute top-0.5 right-0.5 bg-ground/80"
                onClick={() => setShots((cur) => cur.filter((_, j) => j !== i))}
              >
                <X className="size-3" />
              </IconButton>
            </span>
          ))}
        </div>
      )}
      <p className="m-0 font-mono text-[10.5px] text-muted">PASTE SCREENSHOTS WITH CTRL V · UP TO {MAX_ITEM_IMAGES} · KEPT IN APP DATA, NOT IN THE PROJECT</p>
      <div className="flex gap-2">
        <Button variant="primary" type="submit" disabled={!title.trim() || busy}>
          {kind === "feature" ? "Add feature" : "Report bug"}
        </Button>
        <Button variant="outline" onClick={() => select(projectId, null)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function useObjectUrls(files: File[]): string[] {
  const [urls, setUrls] = useState<string[]>([]);
  useEffect(() => {
    const next = files.map((f) => URL.createObjectURL(f));
    setUrls(next);
    return () => next.forEach((u) => URL.revokeObjectURL(u));
  }, [files]);
  return urls;
}

function ScreenshotPicker({ count, onFiles, disabled }: { count: number; onFiles: (files: File[]) => void; disabled?: boolean }) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={ref}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        multiple
        hidden
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = "";
          if (files.length) onFiles(files);
        }}
      />
      <Button variant="outline" size="sm" disabled={disabled || count >= MAX_ITEM_IMAGES} onClick={() => ref.current?.click()}>
        <ImagePlus className="size-3.5" />
        Add screenshot
      </Button>
    </>
  );
}

// ---------- an item ----------

export function ItemDetail({ item, items }: { item: BacklogItem; items: BacklogItem[] }) {
  const [title, setTitle] = useState(item.title);
  const conversations = useChat((s) => s.conversations);
  const dismissed = useBacklog((s) => s.dismissed[item.id]);
  const hint = suggestion(item, conversations);
  const showHint = hint && dismissed !== hint.status;
  const saveTitle = () => {
    if (title.trim() && title.trim() !== item.title) void updateItem(item.id, { title });
    else setTitle(item.title);
  };

  return (
    <div className="flex max-w-[920px] flex-col gap-5 px-7 py-6" onPaste={(e) => pastedScreenshots(e, (files) => void addScreenshots(item, files))}>
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2.5 font-mono text-[11px] text-muted uppercase">
          <KindIcon kind={item.kind} className="size-3.5" />
          <span className={item.kind === "bug" ? "text-danger" : "text-tag"}>{itemKey(item)}</span>
          <span>· {KIND_LABEL[item.kind]}</span>
          <span className="flex-1" />
          <IconButton aria-label={`Delete ${itemKey(item)}`} size={26} onClick={() => confirmDelete(item.id)}>
            <Trash2 className="size-4" />
          </IconButton>
        </div>
        <label htmlFor="backlog-title" className="sr-only">
          Title
        </label>
        <input
          id="backlog-title"
          value={title}
          maxLength={200}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={saveTitle}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") {
              setTitle(item.title);
              e.currentTarget.blur();
            }
          }}
          className="w-full border border-transparent bg-transparent px-0 py-0.5 font-display text-[22px] font-bold tracking-[0.06em] text-fg outline-none hover:border-b-line focus:border-b-accent"
        />
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2">
            <span className="label-caps text-[11px] text-muted">Status</span>
            <Select
              value={item.status}
              onChange={(e) => void setStatus(item.id, e.target.value as BacklogStatus)}
              className={cn("h-[28px] text-[12.5px]", STATUS_TONE[item.status])}
            >
              {STATUS_ORDER.map((s) => (
                <option key={s} value={s}>
                  {statusLabel(item.kind, s)}
                </option>
              ))}
            </Select>
          </label>
          <label className="flex items-center gap-2">
            <span className="label-caps text-[11px] text-muted">Priority</span>
            <Select value={item.priority} onChange={(e) => void updateItem(item.id, { priority: e.target.value as BacklogPriority })} className="h-[28px] text-[12.5px]">
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {PRIORITY_LABEL[p]}
                </option>
              ))}
            </Select>
          </label>
        </div>
      </div>

      <ErrorLine />

      {showHint && (
        <div role="status" className="flex flex-wrap items-center gap-2.5 border border-accent/40 bg-accent/[0.05] px-3 py-2 text-[12.5px]">
          <span className="flex-1">{hint.text}</span>
          <Button size="sm" onClick={() => void setStatus(item.id, hint.status)}>
            Mark as {statusLabel(item.kind, hint.status)}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => dismissSuggestion(item.id, hint.status)}>
            Not now
          </Button>
        </div>
      )}

      <ActionBar item={item} />
      <Description item={item} />
      <Screenshots item={item} />
      <PlanSection item={item} />
      <Related item={item} items={items} />
      <LinkedChats item={item} conversations={conversations} />
    </div>
  );
}

function ActionBar({ item }: { item: BacklogItem }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {actionsFor(item.kind).map((p: BacklogPurpose) => {
        const meta = PURPOSE[p];
        const agent = meta.mode === "agent";
        return (
          <button
            key={p}
            type="button"
            title={meta.hint}
            onClick={() => void startAiAction(item, p)}
            className={cn(
              "flex h-8 items-center gap-2 border px-3.5 font-display text-[12.5px] font-bold tracking-[0.14em] uppercase transition-colors duration-200",
              agent ? "border-agent/55 text-agent hover:bg-agent/10" : "border-plan/55 text-plan hover:bg-plan/10",
            )}
          >
            <Play className="size-3.5 fill-current" />
            {meta.label}
            <span className="font-mono text-[10px] font-normal tracking-normal opacity-80">{MODE_META[meta.mode].label.toUpperCase()}</span>
          </button>
        );
      })}
      <span className="font-mono text-[10.5px] text-muted">OPENS A NEW CHAT WITH THIS ITEM AND THE OTHER OPEN ITEMS AS CONTEXT · YOU SEND IT</span>
    </div>
  );
}

function Description({ item }: { item: BacklogItem }) {
  const [editing, setEditing] = useState(!item.body.trim());
  const [body, setBody] = useState(item.body || BODY_TEMPLATE[item.kind]);
  const save = () => {
    const next = body.trim() === BODY_TEMPLATE[item.kind].trim() ? "" : body;
    if (next !== item.body) void updateItem(item.id, { body: next });
    if (next.trim()) setEditing(false);
  };
  return (
    <section aria-label="Description" className="flex flex-col gap-2">
      <SectionTitle
        aside={
          !editing && (
            <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
              <Pencil className="size-3.5" />
              Edit
            </Button>
          )
        }
      >
        {item.kind === "feature" ? "Description" : "Report"}
      </SectionTitle>
      {editing ? (
        <>
          <label htmlFor="backlog-body" className="sr-only">
            Description
          </label>
          <textarea
            id="backlog-body"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={12}
            className={cn(fieldCls, "resize-y font-mono text-[12.5px]")}
          />
          <div className="flex gap-2">
            <Button size="sm" onClick={save}>
              Save
            </Button>
            {item.body.trim() && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setBody(item.body);
                  setEditing(false);
                }}
              >
                Cancel
              </Button>
            )}
          </div>
        </>
      ) : (
        <div className="text-[13.5px] leading-[22px]">
          <ChatMarkdown text={item.body} />
        </div>
      )}
    </section>
  );
}

function Screenshots({ item }: { item: BacklogItem }) {
  const [open, setOpen] = useState<BacklogImage | null>(null);
  return (
    <section aria-label="Screenshots" className="flex flex-col gap-2">
      <SectionTitle aside={<ScreenshotPicker count={item.images.length} onFiles={(files) => void addScreenshots(item, files)} />}>
        Screenshots <span className="font-mono text-[10px] tracking-normal">{item.images.length}/{MAX_ITEM_IMAGES}</span>
      </SectionTitle>
      {item.images.length === 0 ? (
        <p className="m-0 text-[12.5px] text-muted">Paste a screenshot with Ctrl V anywhere on this item. The newest ones go with the item when you start a chat.</p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {item.images.map((img) => (
            <Thumb key={img.id} img={img} onOpen={() => setOpen(img)} />
          ))}
        </div>
      )}
      {open && <Lightbox img={open} onClose={() => setOpen(null)} />}
    </section>
  );
}

function useImageUrl(id: string): { src: string | null; missing: boolean } {
  const [src, setSrc] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    let stale = false;
    ipc
      .backlogImage(id)
      .then((url) => !stale && setSrc(url))
      .catch(() => !stale && setMissing(true));
    return () => {
      stale = true;
    };
  }, [id]);
  return { src, missing };
}

function Thumb({ img, onOpen }: { img: BacklogImage; onOpen: () => void }) {
  const { src, missing } = useImageUrl(img.id);
  return (
    <span className="group relative flex h-[84px] min-w-[84px] items-center justify-center border border-line bg-well">
      <button type="button" onClick={onOpen} aria-label={`Open ${img.name}`} title={`${img.name} · ${formatBytes(img.size)}`} className="flex h-full items-center border-0 bg-transparent p-0">
        {src ? (
          <img src={src} alt={img.name} className="h-full max-w-[200px] object-contain" />
        ) : (
          <span className="px-2 font-mono text-[10px] text-muted">{missing ? "NOT STORED" : "IMAGE"}</span>
        )}
      </button>
      <IconButton
        aria-label={`Remove ${img.name}`}
        size={20}
        className="absolute top-0.5 right-0.5 bg-ground/80 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100"
        onClick={() => void removeScreenshot(img.id)}
      >
        <X className="size-3" />
      </IconButton>
    </span>
  );
}

function Lightbox({ img, onClose }: { img: BacklogImage; onClose: () => void }) {
  const { src } = useImageUrl(img.id);
  return (
    <Dialog open onClose={onClose} title={img.name} eyebrow={`▸ SCREENSHOT · ${formatBytes(img.size)}`} width={960}>
      <div className="flex max-h-[70vh] items-center justify-center overflow-auto bg-well">
        {src ? <img src={src} alt={img.name} className="max-w-full object-contain" /> : <span className="p-6 font-mono text-[11px] text-muted">LOADING…</span>}
      </div>
    </Dialog>
  );
}

function PlanSection({ item }: { item: BacklogItem }) {
  const [editing, setEditing] = useState(false);
  const [plan, setPlan] = useState(item.plan ?? "");
  return (
    <section aria-label="Plan" className="flex flex-col gap-2">
      <SectionTitle
        aside={
          !editing && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setPlan(item.plan ?? "");
                setEditing(true);
              }}
            >
              <Pencil className="size-3.5" />
              {item.plan ? "Edit" : "Write"}
            </Button>
          )
        }
      >
        Plan
      </SectionTitle>
      {editing ? (
        <>
          <label htmlFor="backlog-plan" className="sr-only">
            Plan
          </label>
          <textarea id="backlog-plan" value={plan} onChange={(e) => setPlan(e.target.value)} rows={10} className={cn(fieldCls, "resize-y font-mono text-[12.5px]")} />
          <div className="flex gap-2">
            <Button
              size="sm"
              onClick={() => {
                void savePlan(item.id, plan.trim() ? plan : null);
                setEditing(false);
              }}
            >
              Save
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </>
      ) : item.plan ? (
        <div className="border-l-2 border-plan/50 pl-3.5 text-[13.5px] leading-[22px]">
          <ChatMarkdown text={item.plan} />
        </div>
      ) : (
        <p className="m-0 text-[12.5px] text-muted">
          No plan yet. Start {item.kind === "feature" ? "Plan" : "Investigate"}, then save the agent's plan from the chat with “Save to {itemKey(item)}”, or write one here.
        </p>
      )}
    </section>
  );
}

function Related({ item, items }: { item: BacklogItem; items: BacklogItem[] }) {
  const related = item.related.map((id) => items.find((i) => i.id === id)).filter((i): i is BacklogItem => !!i);
  const candidates = items.filter((i) => i.id !== item.id && !item.related.includes(i.id));
  const set = (ids: string[]) => void updateItem(item.id, { related: ids });
  return (
    <section aria-label="Related items" className="flex flex-col gap-2">
      <SectionTitle
        aside={
          candidates.length > 0 && (
            <>
              <label htmlFor="backlog-related" className="sr-only">
                Add a related item
              </label>
              <Select
                id="backlog-related"
                value=""
                onChange={(e) => e.target.value && set([...item.related, e.target.value])}
                className="h-[26px] max-w-[260px] text-[12px]"
              >
                <option value="">Add related…</option>
                {candidates.map((c) => (
                  <option key={c.id} value={c.id}>
                    {itemKey(c)} · {c.title}
                  </option>
                ))}
              </Select>
            </>
          )
        }
      >
        Related
      </SectionTitle>
      {related.length === 0 ? (
        <p className="m-0 text-[12.5px] text-muted">Agents see every open item as one line. Related items go to them in full.</p>
      ) : (
        <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0">
          {related.map((r) => (
            <li key={r.id} className="inline-flex h-[26px] items-center gap-1.5 border border-line pr-1 pl-2 text-[12px]">
              <Link2 className="size-3 text-muted" />
              <button type="button" onClick={() => openItem(r)} className="border-0 bg-transparent p-0 text-left text-term hover:text-fg">
                <span className={cn("font-mono text-[10.5px]", r.kind === "bug" ? "text-danger" : "text-tag")}>{itemKey(r)}</span> {r.title}
              </button>
              <IconButton aria-label={`Unlink ${itemKey(r)}`} size={20} onClick={() => set(item.related.filter((id) => id !== r.id))}>
                <X className="size-3" />
              </IconButton>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function LinkedChats({ item, conversations }: { item: BacklogItem; conversations: ReturnType<typeof useChat.getState>["conversations"] }) {
  const engines = useChat((s) => s.engines);
  const requests = useChat((s) => s.requests);
  const visible = visibleConversations(conversations, engines);
  const chats = [...item.links]
    .reverse()
    .map((l) => ({ link: l, conv: visible.find((c) => c.id === l.conversationId) }))
    .filter((x) => !!x.conv);
  return (
    <section aria-label="Chats" className="flex flex-col gap-2">
      <SectionTitle>Chats</SectionTitle>
      {chats.length === 0 ? (
        <p className="m-0 text-[12.5px] text-muted">Chats started from this item appear here.</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
          {chats.map(({ link, conv }) => {
            const c = conv!;
            const chip = statusChip(c, !!requests[c.id]);
            return (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => openConversation(c.id)}
                  className="flex w-full items-center gap-2.5 border-0 bg-transparent px-2 py-2 text-left hover:bg-accent/5"
                >
                  <span className="size-1.5 shrink-0" style={{ background: MODE_META[c.mode].color }} />
                  <span className="w-[86px] shrink-0 font-mono text-[10.5px] text-muted uppercase">{PURPOSE[link.purpose].label}</span>
                  <span className="min-w-0 flex-1 truncate text-[13px] text-term">{c.title}</span>
                  <span className="font-mono text-[10px] text-muted uppercase">{ENGINE_LABEL[c.engine]}</span>
                  {chip && <Chip kind={chip} small />}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** Confirmation before an item is deleted (Dialogs). */
export function DeleteBacklogItemDialog({ itemId, onClose, onDelete }: { itemId: string; onClose: () => void; onDelete: () => void }) {
  const item = useBacklog((s) => Object.values(s.items).flat().find((i) => i.id === itemId));
  if (!item) return null;
  const chats = item.links.length;
  return (
    <Dialog
      open
      tone="danger"
      onClose={onClose}
      eyebrow="▸ DELETE BACKLOG ITEM"
      title={`Delete ${itemKey(item)}?`}
      description={`“${item.title}”${item.plan ? ", its plan" : ""}${item.images.length ? ` and ${item.images.length} screenshot${item.images.length === 1 ? "" : "s"}` : ""} are removed from this device.${chats ? ` The ${chats} chat${chats === 1 ? "" : "s"} started from it stay.` : ""} Project files are not touched. This can't be undone.`}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" onClick={onDelete}>
            Delete
          </Button>
        </>
      }
    />
  );
}
