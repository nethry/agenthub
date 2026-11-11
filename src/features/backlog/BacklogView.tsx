import { Search } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import type { BacklogItem, BacklogKind } from "@/lib/types";
import { cn } from "@/lib/utils";
import { select, startCreate, useProjectBacklog } from "./actions";
import { CreateItemForm, ItemDetail } from "./ItemDetail";
import { KindIcon } from "./KindIcon";
import { closedCount, groupItems, groupLabel, itemKey, KIND_LABEL, PRIORITY_LABEL, STATUS_TONE, statusLabel, type BacklogFilter } from "./model";
import { filterOf, itemsOf, setBacklog, useBacklog } from "./store";

const KIND_FILTERS: { id: BacklogFilter["kind"]; label: string }[] = [
  { id: "all", label: "All" },
  { id: "feature", label: "Features" },
  { id: "bug", label: "Bugs" },
];

/**
 * A project's backlog: features and bugs grouped by status, and the selected
 * item (or the form for a new one). Chats started from an item are linked to it.
 */
export function BacklogView({ projectId }: { projectId: string }) {
  useProjectBacklog(projectId);
  const items = useBacklog((s) => itemsOf(s, projectId));
  const loaded = useBacklog((s) => !!s.items[projectId]);
  const filter = useBacklog(useShallow((s) => filterOf(s, projectId)));
  const selection = useBacklog((s) => s.selection[projectId] ?? null);
  const selected = selection && "item" in selection ? (items.find((i) => i.id === selection.item) ?? null) : null;
  const groups = groupItems(items, filter);
  const closed = closedCount(items, filter.kind);
  const setFilter = (patch: Partial<BacklogFilter>) => setBacklog((s) => ({ filter: { ...s.filter, [projectId]: { ...filterOf(s, projectId), ...patch } } }));

  return (
    <div className="flex min-h-0 flex-1">
      <aside aria-label="Backlog items" className="flex w-[340px] shrink-0 flex-col border-r border-line bg-ground/85">
        <div className="flex gap-2 px-3 pt-3 pb-2">
          <NewButton kind="feature" onClick={() => startCreate(projectId, "feature")} active={selection !== null && "create" in selection && selection.create === "feature"} />
          <NewButton kind="bug" onClick={() => startCreate(projectId, "bug")} active={selection !== null && "create" in selection && selection.create === "bug"} />
        </div>
        <div className="flex items-center gap-2 px-3 pb-2">
          <div role="radiogroup" aria-label="Show" className="flex border border-line">
            {KIND_FILTERS.map((k, i) => (
              <button
                key={k.id}
                type="button"
                role="radio"
                aria-checked={filter.kind === k.id}
                onClick={() => setFilter({ kind: k.id })}
                className={cn(
                  "h-[26px] border-0 px-2.5 font-display text-[11.5px] font-semibold tracking-[0.12em] uppercase transition-colors duration-200",
                  i > 0 && "border-l border-line",
                  filter.kind === k.id ? "bg-accent/12 text-accent" : "bg-transparent text-muted hover:text-fg",
                )}
              >
                {k.label}
              </button>
            ))}
          </div>
          <span className="flex-1" />
          <label className="flex cursor-pointer items-center gap-1.5 font-mono text-[10px] text-muted uppercase">
            <input type="checkbox" checked={filter.showClosed} onChange={(e) => setFilter({ showClosed: e.target.checked })} className="accent-accent" />
            Closed{closed ? ` (${closed})` : ""}
          </label>
        </div>
        <div className="relative px-3 pb-2">
          <label htmlFor="backlog-search" className="sr-only">
            Search the backlog
          </label>
          <Search className="pointer-events-none absolute top-2 left-[22px] size-3.5 text-muted" />
          <input
            id="backlog-search"
            value={filter.query}
            onChange={(e) => setFilter({ query: e.target.value })}
            placeholder="Search titles, descriptions, IDs"
            autoComplete="off"
            spellCheck={false}
            className="h-[30px] w-full border border-line bg-surface pr-2.5 pl-[30px] text-[12px] outline-none placeholder:text-dim focus:border-accent"
          />
        </div>
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto pb-2">
          {!loaded ? (
            <p className="m-0 px-[18px] pt-1 font-mono text-[10.5px] text-muted">LOADING…</p>
          ) : items.length === 0 ? (
            <p className="m-0 px-[18px] pt-1 text-[12px] leading-[18px] text-muted">
              Nothing here yet. Describe a feature or report a bug, then let an agent plan, investigate, implement or fix it. Each plan sees the other open items.
            </p>
          ) : groups.length === 0 ? (
            <p className="m-0 px-[18px] pt-1 text-[12px] leading-[18px] text-muted">
              {filter.query.trim() ? `No items match “${filter.query.trim()}”.` : "No open items. Turn on Closed to see finished ones."}
            </p>
          ) : (
            groups.map((g) => (
              <section key={g.status} aria-label={groupLabel(g.status, filter.kind)} className="flex flex-col gap-0.5">
                <h2 className={cn("label-caps m-0 flex items-center gap-2 px-[18px] pt-2.5 pb-1 text-[11px]", STATUS_TONE[g.status])}>
                  {groupLabel(g.status, filter.kind)}
                  <span className="font-mono text-[10px] tracking-normal text-muted">{String(g.items.length).padStart(2, "0")}</span>
                </h2>
                <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
                  {g.items.map((item) => (
                    <Row key={item.id} item={item} active={selected?.id === item.id} onSelect={() => select(projectId, { item: item.id })} />
                  ))}
                </ul>
              </section>
            ))
          )}
        </div>
        <div className="border-t border-line px-3.5 py-2.5 font-mono text-[10px] text-muted">
          {String(items.filter((i) => i.kind === "feature").length).padStart(2, "0")} FEATURES · {String(items.filter((i) => i.kind === "bug").length).padStart(2, "0")} BUGS · STORED LOCALLY
        </div>
      </aside>
      <section aria-label="Backlog item" className="flex min-w-0 flex-1 flex-col overflow-y-auto">
        {selection && "create" in selection ? (
          <CreateItemForm key={selection.create} projectId={projectId} kind={selection.create} />
        ) : selected ? (
          <ItemDetail key={selected.id} item={selected} items={items} />
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 px-8 text-center">
            <span className="label-caps text-[13px] text-muted">Backlog</span>
            <p className="m-0 max-w-[420px] text-[13px] leading-5 text-muted">
              Select an item, or add a feature or a bug. Paste screenshots with Ctrl V. Plan and Investigate run in Plan mode; Implement and Fix in Agent mode, with your approvals.
            </p>
          </div>
        )}
      </section>
    </div>
  );
}

function NewButton({ kind, onClick, active }: { kind: BacklogKind; onClick: () => void; active: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "flex h-8 flex-1 items-center justify-center gap-2 border px-2.5 font-display text-[12.5px] font-bold tracking-[0.14em] uppercase transition-colors duration-200",
        kind === "feature" ? "border-tag/50 text-tag hover:bg-tag/10" : "border-danger/50 text-danger hover:bg-danger/10",
        active && (kind === "feature" ? "bg-tag/10" : "bg-danger/10"),
      )}
    >
      <KindIcon kind={kind} className="size-4" />
      {kind === "feature" ? "New feature" : "Report bug"}
    </button>
  );
}

function Row({ item, active, onSelect }: { item: BacklogItem; active: boolean; onSelect: () => void }) {
  return (
    <li className="mx-2">
      <button
        type="button"
        onClick={onSelect}
        aria-current={active ? "true" : undefined}
        title={item.title}
        className={cn(
          "flex w-full items-start gap-2.5 border-0 px-2.5 py-[9px] text-left transition-colors duration-200",
          active ? "bg-accent/10 shadow-[inset_2px_0_0_var(--color-accent)]" : "bg-transparent hover:bg-accent/5",
        )}
      >
        <KindIcon kind={item.kind} className="mt-0.5 size-3.5 shrink-0" />
        <span className="flex min-w-0 flex-1 flex-col gap-[5px]">
          <span className={cn("truncate text-[13px]", active ? "text-fg" : "text-term")}>{item.title}</span>
          <span className="flex items-center gap-1.5 truncate font-mono text-[10px] text-muted uppercase">
            {itemKey(item)} · {KIND_LABEL[item.kind]}
            {item.priority !== "normal" && <span className={item.priority === "high" ? "text-warn" : undefined}>· {PRIORITY_LABEL[item.priority]}</span>}
            {item.images.length > 0 && <span>· {item.images.length} IMG</span>}
            {item.links.length > 0 && <span>· {item.links.length} CHAT{item.links.length === 1 ? "" : "S"}</span>}
          </span>
        </span>
        <span className={cn("shrink-0 font-mono text-[10px] uppercase", STATUS_TONE[item.status])}>{statusLabel(item.kind, item.status)}</span>
      </button>
    </li>
  );
}
