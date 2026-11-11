import { ChevronsLeft, ChevronsRight, Copy, Plus, SlidersHorizontal, Trash2 } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { isLive, set, useApp } from "@/app/store";
import { openSettings, selectProject } from "@/app/actions";
import { IconButton } from "@/components/ui/button";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "@/components/ui/menu";
import { engineOn, needsAttention } from "@/features/chat/models";
import { useChat } from "@/features/chat/store";
import { cn, initials, pad2 } from "@/lib/utils";
import { UpdateDot } from "@/features/updates/UpdateBadge";
import { badgeTextClass } from "./ProjectBadge";

export interface Signals {
  attn: number;
  running: number;
  terminals: number;
}

/** Per workspace key ("general" or a project id): chats needing you, chats running, live terminals. */
export function useWorkspaceSignals() {
  const chat = useChat(
    useShallow((s) => {
      const out: Record<string, string> = {};
      for (const c of s.conversations) {
        if (!engineOn(s.engines, c.engine)) continue;
        const k = c.projectId ?? "general";
        const attn = needsAttention(c) ? 1 : 0;
        const run = s.requests[c.id] || c.status === "running" ? 1 : 0;
        const [a, r] = (out[k] ?? "0:0").split(":").map(Number);
        out[k] = `${a + attn}:${r + run}`;
      }
      return out;
    }),
  );
  const terms = useApp(
    useShallow((s) => {
      const out: Record<string, number> = {};
      for (const sess of Object.values(s.sessions)) if (isLive(sess)) out[sess.projectId] = (out[sess.projectId] ?? 0) + 1;
      return out;
    }),
  );
  return (key: string): Signals => {
    const [attn, running] = (chat[key] ?? "0:0").split(":").map(Number);
    return { attn, running, terminals: terms[key] ?? 0 };
  };
}

/** `label, 2 need you, 1 chat running` for aria-labels and tooltips. */
export function signalParts(label: string, signals: Signals): string[] {
  return [
    label,
    signals.attn ? `${signals.attn} need you` : null,
    signals.running ? `${signals.running} chat${signals.running === 1 ? "" : "s"} running` : null,
    signals.terminals ? `${signals.terminals} terminal${signals.terminals === 1 ? "" : "s"} running` : null,
  ].filter((x): x is string => !!x);
}

export function AttentionBadge({ count, className }: { count: number; className?: string }) {
  return (
    <span className={cn("flex h-[15px] min-w-[15px] items-center justify-center bg-warn px-[3px] font-mono text-[9px] hud:text-on-accent graphite:text-ground", className)}>{count}</span>
  );
}

function RailButton({
  name,
  path,
  short,
  colorClass,
  active,
  expanded,
  signals,
  onClick,
}: {
  name: string;
  path: string;
  short: string;
  colorClass: string;
  active: boolean;
  expanded: boolean;
  signals: Signals;
  onClick: () => void;
}) {
  const parts = signalParts(name, signals);
  if (expanded) {
    return (
      <button
        aria-label={parts.join(", ")}
        aria-current={active ? "page" : undefined}
        title={[path, ...parts.slice(1)].join("\n")}
        onClick={onClick}
        className={cn(
          "flex w-full items-start gap-2.5 border px-2 py-1.5 text-left transition-colors duration-200",
          active ? "border-accent/50 bg-accent/10 hud:shadow-[0_0_14px_rgba(77,163,255,0.15)]" : "border-transparent bg-transparent hover:bg-accent/5",
        )}
      >
        <span
          className={cn(
            "flex size-7 shrink-0 items-center justify-center border font-display text-[12px] font-bold",
            active ? "border-accent/50 text-accent" : cn("border-line", colorClass),
          )}
        >
          {short}
        </span>
        <span className={cn("min-w-0 flex-1 pt-[5px] text-[13px] leading-[17px] break-words", active ? "text-fg" : "text-term")}>{name}</span>
        <span className="flex shrink-0 items-center gap-1.5 pt-[6px]">
          {signals.running > 0 && <span className="live-glow size-[5px] bg-agent" />}
          {signals.terminals > 0 && <span className="size-[5px] bg-run" />}
          {signals.attn > 0 && <AttentionBadge count={signals.attn} />}
        </span>
      </button>
    );
  }
  return (
    <button
      aria-label={parts.join(", ")}
      aria-current={active ? "page" : undefined}
      title={[`${name} — ${path}`, ...parts.slice(1)].join("\n")}
      onClick={onClick}
      className={cn(
        "relative flex size-10 shrink-0 items-center justify-center border font-display text-[13px] font-bold transition-colors duration-200",
        active ? "border-accent/50 bg-accent/10 text-accent hud:shadow-[0_0_14px_rgba(77,163,255,0.15)]" : cn("border-line bg-transparent hover:border-line-strong", colorClass),
      )}
    >
      {short}
      {signals.attn > 0 && <AttentionBadge count={signals.attn} className="absolute -top-[5px] -right-[5px]" />}
      {signals.running > 0 && <span className="live-glow absolute right-[3px] bottom-[3px] size-[5px] bg-agent" />}
      {signals.terminals > 0 && <span className="absolute bottom-[3px] left-[3px] size-[5px] bg-run" />}
    </button>
  );
}

/**
 * Project rail: full project names, or (collapsed) their initials. General
 * chats open from the title bar.
 */
export function ProjectRail() {
  const projects = useApp((s) => s.projects);
  const activeId = useApp((s) => s.activeProjectId);
  const workspace = useApp((s) => s.workspace);
  const screen = useApp((s) => s.screen);
  const collapsed = useApp((s) => s.railCollapsed);
  const focus = useChat((s) => s.focus);
  const signals = useWorkspaceSignals();
  if (focus && screen === "workspace") return null;
  const onWorkspace = screen === "workspace";
  const expanded = !collapsed;
  const toggle = () => set((s) => ({ railCollapsed: !s.railCollapsed }));

  return (
    <nav
      aria-label="Projects"
      className={cn(
        "flex shrink-0 flex-col gap-1.5 border-r border-line bg-ground/85 pt-3 pb-2.5",
        expanded ? "w-[232px] items-stretch" : "w-[60px] items-center",
      )}
    >
      {expanded && (
        <span className="label-caps flex items-center px-3.5 pb-0.5 text-[11px] text-muted">
          Projects
          <span className="flex-1" />
          <span className="font-mono text-[10px] tracking-normal">{pad2(projects.length)}</span>
        </span>
      )}
      <div className={cn("flex min-h-0 flex-1 flex-col gap-1.5 overflow-x-hidden overflow-y-auto px-2 pt-1", !expanded && "items-center")}>
        {projects.map((p) => (
          <ContextMenu key={p.id}>
            <ContextMenuTrigger asChild>
              <div className={cn(expanded && "w-full")}>
                <RailButton
                  name={p.name}
                  path={p.path}
                  short={initials(p.name)}
                  colorClass={badgeTextClass(p.id)}
                  active={onWorkspace && workspace === "project" && p.id === activeId}
                  expanded={expanded}
                  signals={signals(p.id)}
                  onClick={() => selectProject(p.id)}
                />
              </div>
            </ContextMenuTrigger>
            <ContextMenuContent width={220}>
              <ContextMenuItem icon={<Copy className="size-4" />} onSelect={() => void navigator.clipboard.writeText(p.path)}>
                Copy path
              </ContextMenuItem>
              <ContextMenuItem danger icon={<Trash2 className="size-4" />} onSelect={() => set({ dialog: { type: "removeProject", projectId: p.id } })}>
                Remove from AgentHub
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        ))}
        <button
          aria-label="Add project"
          title="Add project"
          onClick={() => set({ dialog: { type: "addProject" } })}
          className={cn(
            "flex shrink-0 items-center border border-dashed border-dash bg-transparent text-accent hover:border-accent/60",
            expanded ? "h-9 w-full gap-2.5 px-2 font-display text-[12px] font-bold tracking-[0.14em] uppercase" : "size-10 justify-center",
          )}
        >
          <Plus className="size-4" />
          {expanded && "Add project"}
        </button>
      </div>
      <div className={cn("flex", expanded ? "items-center gap-1 px-2" : "flex-col items-center gap-1")}>
        <IconButton aria-label="Settings (Ctrl ,)" size={40} className="relative" onClick={() => openSettings()}>
          <SlidersHorizontal className="size-4" />
          <UpdateDot />
        </IconButton>
        {expanded && <span className="flex-1" />}
        <IconButton aria-label={expanded ? "Collapse project list" : "Expand project list"} size={40} onClick={toggle}>
          {expanded ? <ChevronsLeft className="size-4" /> : <ChevronsRight className="size-4" />}
        </IconButton>
      </div>
    </nav>
  );
}
