import { useState } from "react";
import { Copy, GripVertical, Maximize2, MoreHorizontal, Pencil, RotateCw, Square, X } from "lucide-react";
import {
  focusSession,
  openSettings,
  renameSession,
  reorderSessions,
  requestCloseSession,
  restartSession,
} from "@/app/actions";
import { isLive, set, useApp, useSessions } from "@/app/store";
import { Button, IconButton } from "@/components/ui/button";
import { SectionLabel } from "@/components/ui/form";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { StatusChip, StatusDot } from "@/components/ui/status";
import { useActiveSession } from "@/features/terminals/useActiveSession";
import { NewSessionMenu } from "@/features/terminals/NewSessionMenu";
import { useNow } from "@/lib/hooks";
import { ipc } from "@/lib/ipc";
import type { PaneLayout, SessionInfo } from "@/lib/types";
import { cn, pad2, uptime } from "@/lib/utils";
import { TerminalView } from "./TerminalView";

const SLOTS: Record<PaneLayout, number> = { single: 1, columns: 2, "two-over-one": 3 };

export function TerminalsView({ projectId, layout }: { projectId: string; layout: PaneLayout }) {
  const sessions = useSessions(projectId);
  const active = useActiveSession(projectId);
  const now = useNow();
  const [dragId, setDragId] = useState<string | null>(null);

  const ordered = active ? [active, ...sessions.filter((s) => s.id !== active.id)] : sessions;
  const panes = ordered.slice(0, SLOTS[layout]);

  const drop = (targetId: string) => {
    if (!dragId || dragId === targetId) return;
    const ids = sessions.map((s) => s.id).filter((id) => id !== dragId);
    ids.splice(ids.indexOf(targetId), 0, dragId);
    reorderSessions(projectId, ids);
    setDragId(null);
  };

  return (
    <div className="flex min-h-0 flex-1 gap-2.5 pt-3.5 pr-5 pb-4 pl-4">
      <section aria-label="Sessions" className="flex w-[264px] shrink-0 flex-col gap-1.5 overflow-y-auto">
        <div className="flex items-center justify-between px-1 pt-0.5 pb-1.5">
          <SectionLabel>
            Shells <span className="text-accent">// {pad2(sessions.length)}</span>
          </SectionLabel>
          {sessions.length > 1 && <span className="text-[11px] text-muted">Drag to reorder</span>}
        </div>
        {sessions.length === 0 && (
          <p className="m-0 px-1 text-[12px] leading-[18px] text-muted">No terminals yet. Start one with New terminal.</p>
        )}
        {sessions.map((s) => (
          <SessionRow
            key={s.id}
            session={s}
            selected={s.id === active?.id}
            now={now}
            dragging={dragId === s.id}
            onDragStart={() => setDragId(s.id)}
            onDrop={() => drop(s.id)}
            onDragEnd={() => setDragId(null)}
          />
        ))}
        <p className="m-0 mt-auto px-1 pt-3 text-[11.5px] leading-[17px] text-muted">Terminals are for shells and your own commands. AI agents run in Chat.</p>
      </section>

      {panes.length === 0 ? (
        <div className="hud scan flex flex-1 flex-col items-center justify-center gap-3 border border-line bg-well">
          <span className="font-mono text-[11px] text-muted">NO TERMINALS · START A SHELL OR A SAVED COMMAND</span>
          <NewSessionMenu projectId={projectId} align="start">
            <Button variant="primary">New terminal</Button>
          </NewSessionMenu>
        </div>
      ) : (
        <div
          className="grid min-w-0 flex-1 gap-2.5"
          style={{
            gridTemplateColumns: layout === "single" || panes.length === 1 ? "minmax(0,1fr)" : "repeat(2, minmax(0, 1fr))",
            gridTemplateRows: layout === "two-over-one" && panes.length === 3 ? "minmax(0,1.25fr) minmax(0,1fr)" : "minmax(0,1fr)",
          }}
        >
          {panes.map((s, i) => (
            <Pane key={s.id} session={s} active={s.id === active?.id} wide={layout === "two-over-one" && i === 2} />
          ))}
        </div>
      )}
    </div>
  );
}

function SessionRow({
  session: s,
  selected,
  now,
  dragging,
  onDragStart,
  onDrop,
  onDragEnd,
}: {
  session: SessionInfo;
  selected: boolean;
  now: number;
  dragging: boolean;
  onDragStart: () => void;
  onDrop: () => void;
  onDragEnd: () => void;
}) {
  const failed = s.status === "failed";
  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        onDragStart();
      }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        onDrop();
      }}
      onDragEnd={onDragEnd}
      className={cn(
        "group flex flex-col gap-2.5 border py-2.5 pr-1.5 pl-1.5 transition-[border-color,box-shadow,opacity] duration-200",
        failed ? "hud hud-danger border-danger/50 bg-danger/[0.06]" : "bg-surface",
        !failed && (selected ? "hud border-accent/60 hud:shadow-[0_0_18px_rgba(77,163,255,0.14)]" : "border-line hover:border-line-strong"),
        dragging && "opacity-50",
      )}
    >
      <div className="flex items-center gap-1">
        <button
          onClick={() => focusSession(s.id)}
          className="flex min-w-0 flex-1 items-center gap-2.5 border-0 bg-transparent p-0 text-left"
          aria-current={selected || undefined}
        >
          <GripVertical aria-hidden="true" className="size-3.5 shrink-0 cursor-grab text-dim" />
          <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
            <span className="truncate font-semibold">{s.title}</span>
            {failed ? (
              <span className="truncate text-[11px] text-danger-soft">{s.error ?? "Failed to start"}</span>
            ) : (
              <span className="truncate font-mono text-[11px] text-muted">
                {s.commandLine}
                {isLive(s) && ` · ${uptime(s.startedAt, now, true)}`}
              </span>
            )}
          </span>
          <StatusChip session={s} variant="inline" />
        </button>
        <IconButton
          aria-label={`Close ${s.title}`}
          size={22}
          onClick={() => requestCloseSession(s.id)}
          className={cn("focus-visible:opacity-100 group-hover:opacity-100", selected ? "opacity-100" : "opacity-0")}
        >
          <X className="size-3" />
        </IconButton>
      </div>
      {failed && (
        <div className="flex gap-1.5 pl-6">
          {s.presetId && (
            <Button size="sm" onClick={() => openSettings("terminals", s.presetId)}>
              Set path
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={() => void restartSession(s.id)}>
            Retry
          </Button>
        </div>
      )}
    </div>
  );
}

export function Pane({ session: s, active, wide = false, compact = false }: { session: SessionInfo; active: boolean; wide?: boolean; compact?: boolean }) {
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(s.title);
  const fontSize = useApp((st) => st.terminalPrefs.fontSize);

  const commit = () => {
    setRenaming(false);
    if (draft.trim() && draft.trim() !== s.title) void renameSession(s.id, draft.trim());
  };

  return (
    <section
      aria-label={`${s.title} terminal`}
      style={wide ? { gridColumn: "span 2" } : undefined}
      onMouseDown={() => !active && focusSession(s.id)}
      className={cn(
        "hud flex min-h-0 min-w-0 flex-col border bg-surface",
        compact && "flex-1",
        active ? "border-accent/60 hud:shadow-[0_0_22px_rgba(77,163,255,0.12)]" : "border-line",
      )}
    >
      <div className="flex h-[34px] shrink-0 items-center gap-2 border-b border-line pr-1.5 pl-3">
        <StatusDot status={s.status} activity={s.activity} />
        {renaming ? (
          <>
            <label htmlFor={`rename-${s.id}`} className="sr-only">
              Session name
            </label>
            <input
              id={`rename-${s.id}`}
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commit}
              onKeyDown={(e) => {
                if (e.key === "Enter") commit();
                if (e.key === "Escape") {
                  setDraft(s.title);
                  setRenaming(false);
                }
              }}
              className="h-6 w-[180px] border border-accent bg-well px-2 text-[12.5px] font-semibold hud:shadow-[0_0_10px_rgba(77,163,255,0.35)] outline-none"
            />
            <span className="truncate text-[11px] text-muted">Enter to rename · Esc to cancel</span>
          </>
        ) : (
          <>
            <span
              onDoubleClick={() => {
                setDraft(s.title);
                setRenaming(true);
              }}
              title="Double-click to rename"
              className="truncate font-display text-[13px] font-bold tracking-[0.14em] uppercase"
            >
              {s.title}
            </span>
            {!compact && <span className="truncate font-mono text-[11px] text-muted">&gt; {s.commandLine}</span>}
          </>
        )}
        <span className="flex-1" />
        {compact && !renaming && <StatusChip session={s} variant="inline" />}
        <IconButton aria-label="Focus pane" onClick={() => set({ focusSessionId: s.id })}>
          <Maximize2 className="size-3.5" />
        </IconButton>
        <Menu>
          <MenuTrigger asChild>
            <IconButton aria-label="More actions">
              <MoreHorizontal className="size-3.5" />
            </IconButton>
          </MenuTrigger>
          <MenuContent width={220}>
            <MenuItem
              icon={<Pencil className="size-4" />}
              onSelect={() => {
                setDraft(s.title);
                setRenaming(true);
              }}
            >
              Rename
            </MenuItem>
            <MenuItem icon={<Copy className="size-4" />} onSelect={() => void navigator.clipboard.writeText(s.cwd)}>
              Copy working directory
            </MenuItem>
            {isLive(s) ? (
              <MenuItem icon={<Square className="size-4" />} onSelect={() => void ipc.kill(s.id)}>
                Stop process
              </MenuItem>
            ) : (
              <MenuItem icon={<RotateCw className="size-4" />} onSelect={() => void restartSession(s.id)}>
                Restart
              </MenuItem>
            )}
            <MenuSeparator />
            <MenuItem danger icon={<X className="size-4" />} onSelect={() => requestCloseSession(s.id)}>
              Close session
            </MenuItem>
          </MenuContent>
        </Menu>
        <IconButton aria-label="Close session" onClick={() => requestCloseSession(s.id)}>
          <X className="size-3.5" />
        </IconButton>
      </div>
      <TerminalView sessionId={s.id} fontSize={fontSize} />
    </section>
  );
}
