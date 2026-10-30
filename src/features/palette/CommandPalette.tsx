import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import * as RD from "@radix-ui/react-dialog";
import { motion } from "motion/react";
import {
  Bot,
  File,
  FolderOpen,
  FolderPlus,
  LayoutDashboard,
  Maximize2,
  MessageSquare,
  KeyRound,
  Search,
  SlidersHorizontal,
  SquareTerminal,
  Trash2,
  X,
} from "lucide-react";
import {
  focusSession,
  openChat,
  openFile,
  openFolderAsProject,
  openSettings,
  requestCloseSession,
  selectProject,
  showSession,
  spawnPreset,
  spawnShell,
} from "@/app/actions";
import { get, isLive, set, setView, useApp, type PaletteMode } from "@/app/store";
import { basename, cn, dirname, fuzzyMatch, initials, pad2, relativeAgo } from "@/lib/utils";
import { badgeTextClass } from "@/features/projects/ProjectBadge";
import { indexFor } from "./fileIndex";
import { chooseEngine, newChat, openConversation } from "@/features/chat/actions";
import { AGENT_ENGINES, defaultModelFor, ENGINE_LABEL, engineOn, MODE_META, statusChip, visibleConversations } from "@/features/chat/models";
import { useChat } from "@/features/chat/store";
import { Chip } from "@/features/chat/items";

interface Item {
  id: string;
  group: string;
  title: string;
  /** Text that the query is matched against (defaults to title). */
  match?: string;
  subtitle?: string;
  icon: ReactNode;
  right?: ReactNode;
  hint?: string;
  score: number;
  indices: number[];
  run: (focus: boolean) => void;
}

const MODES: { mode: PaletteMode; label: string; prefix?: string }[] = [
  { mode: "all", label: "All" },
  { mode: "chats", label: "Chats" },
  { mode: "projects", label: "Projects" },
  { mode: "files", label: "Files @", prefix: "@" },
  { mode: "sessions", label: "Sessions #", prefix: "#" },
  { mode: "commands", label: "Commands >", prefix: ">" },
];


const close = () => set({ paletteOpen: false });

function Highlight({ text, indices }: { text: string; indices: number[] }) {
  if (!indices.length) return <>{text}</>;
  const set_ = new Set(indices);
  return (
    <>
      {[...text].map((ch, i) =>
        set_.has(i) ? (
          <span key={i} className="text-accent [text-shadow:0_0_8px_rgba(77,163,255,0.6)]">
            {ch}
          </span>
        ) : (
          <span key={i}>{ch}</span>
        ),
      )}
    </>
  );
}

export function CommandPalette() {
  const open = useApp((s) => s.paletteOpen);
  const initialMode = useApp((s) => s.paletteMode);
  if (!open) return null;
  return <PaletteInner initialMode={initialMode} />;
}

const useChatState = () => useChat.getState();

function PaletteInner({ initialMode }: { initialMode: PaletteMode }) {
  const projects = useApp((s) => s.projects);
  const sessions = useApp((s) => s.sessions);
  const presets = useApp((s) => s.presets);
  const conversations = useChat((s) => s.conversations);
  const engines = useChat((s) => s.engines);
  const requests = useChat((s) => s.requests);
  const shells = useApp((s) => s.shells);
  const activeId = useApp((s) => s.activeProjectId);
  const activeSessionId = useApp(
    (s) => s.focusSessionId ?? (s.activeProjectId ? s.workspaces[s.activeProjectId]?.activeSessionId : null) ?? null,
  );
  const [raw, setRaw] = useState(() => MODES.find((m) => m.mode === initialMode)?.prefix ?? "");
  const [chipMode, setChipMode] = useState<PaletteMode>(initialMode);
  const [files, setFiles] = useState<string[]>([]);
  const [sel, setSel] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const [now] = useState(() => Date.now());

  const prefixMode = MODES.find((m) => m.prefix && raw.startsWith(m.prefix))?.mode;
  const mode = prefixMode ?? chipMode;
  const query = prefixMode ? raw.slice(1).trimStart() : raw;
  const active = projects.find((p) => p.id === activeId) ?? null;

  useEffect(() => {
    if (activeId) void indexFor(activeId).then(setFiles);
  }, [activeId]);

  const items = useMemo(() => {
    const out: Item[] = [];
    const add = (base: Omit<Item, "score" | "indices">, limitScore = true) => {
      const m = fuzzyMatch(query, base.match ?? base.title);
      if (!m) return;
      if (limitScore && !query && base.group === "Files") return;
      out.push({ ...base, score: m.score, indices: base.match ? [] : m.indices });
    };

    const liveCount = (pid: string) => Object.values(sessions).filter((s) => s.projectId === pid && isLive(s)).length;

    if (mode === "all" || mode === "chats") {
      for (const c of visibleConversations(conversations, engines)) {
        if (mode === "all" && !query) continue;
        const p = projects.find((x) => x.id === c.projectId);
        const chip = statusChip(c, !!requests[c.id]);
        add({
          id: `chat:${c.id}`,
          group: "Chats",
          title: c.title,
          // General (shown as Ask) is always Ask mode, so its chats show no mode.
          subtitle: p ? `${MODE_META[c.mode].label.toUpperCase()} · ${ENGINE_LABEL[c.engine]} · ${p.name}` : `${ENGINE_LABEL[c.engine]} · Ask`,
          icon: p ? (
            <span className="flex w-[54px] font-mono text-[9.5px]" style={{ color: MODE_META[c.mode].color }}>
              {MODE_META[c.mode].label.toUpperCase()}
            </span>
          ) : (
            <span className="flex w-[54px] font-mono text-[9.5px] text-muted">ASK</span>
          ),
          right: chip ? <Chip kind={chip} small /> : undefined,
          run: () => openConversation(c.id),
        });
      }
    }

    if (mode === "all" || mode === "projects") {
      for (const p of projects) {
        const running = liveCount(p.id);
        add({
          id: `p:${p.id}`,
          group: "Projects",
          title: p.name,
          subtitle: p.path,
          icon: (
            <span
              className={cn(
                "flex size-[30px] items-center justify-center border font-display text-[13px] font-bold",
                p.id === activeId ? "border-accent text-accent" : cn("border-line-strong", badgeTextClass(p.id)),
              )}
            >
              {initials(p.name)}
            </span>
          ),
          right: running ? (
            <span className="inline-flex items-center gap-1.5 font-mono text-[11px] text-run">
              <span className="size-[5px] bg-run shadow-[0_0_6px_#3DF5A0]" />
              {pad2(running)} RUNNING
            </span>
          ) : p.lastOpenedAt ? (
            <span className="text-[11px] text-muted">Opened {relativeAgo(p.lastOpenedAt, now)}</span>
          ) : undefined,
          run: (focus) => {
            selectProject(p.id);
            if (focus) {
              const sid = get().workspaces[p.id]?.activeSessionId;
              if (sid) set({ focusSessionId: sid });
            }
          },
        });
      }
    }

    if (mode === "all" || mode === "commands") {
      const targets = query ? projects : active ? [active] : [];
      for (const p of targets) {
        for (const preset of presets.filter((x) => x.enabled && (x.resolvedPath || x.shellProfile === "wsl"))) {
          add({
            id: `c:launch:${p.id}:${preset.id}`,
            group: "Commands",
            title: `Run ${preset.displayName} in a ${p.name} terminal`,
            icon: <SquareTerminal className="size-4" />,
            run: async (focus) => {
              selectProject(p.id);
              const info = await spawnPreset(p.id, preset.id);
              if (focus && info) set({ focusSessionId: info.id });
            },
          });
        }
        for (const engine of AGENT_ENGINES.filter((e) => engineOn(engines, e))) {
          add({
            id: `c:agent:${p.id}:${engine}`,
            group: "Commands",
            title: `New Agent chat with ${ENGINE_LABEL[engine]} in ${p.name}`,
            icon: <Bot className="size-4" />,
            hint: p.id === activeId && engine === AGENT_ENGINES.find((e) => engineOn(engines, e)) ? "CTRL N" : undefined,
            run: () => {
              selectProject(p.id);
              setView(p.id, "chat");
              newChat(p.id);
              chooseEngine(engine, defaultModelFor(engine, undefined, useChatState().prefs), p.id);
            },
          });
        }
        const shell = shells.find((s) => s.id === get().defaultShell);
        add({
          id: `c:shell:${p.id}`,
          group: "Commands",
          title: `New ${shell?.name ?? "shell"} terminal in ${p.name}`,
          icon: <SquareTerminal className="size-4" />,
          hint: p.id === activeId ? "CTRL SHIFT `" : undefined,
          run: async (focus) => {
            selectProject(p.id);
            const info = await spawnShell(p.id);
            if (focus && info) set({ focusSessionId: info.id });
          },
        });
        add({
          id: `c:focus:${p.id}`,
          group: "Commands",
          title: `Open ${p.name} in focus mode`,
          icon: <Maximize2 className="size-4" />,
          run: () => {
            selectProject(p.id);
            const sid = get().workspaces[p.id]?.activeSessionId;
            if (sid) set({ focusSessionId: sid });
          },
        });
      }
      const closeTarget = activeSessionId ? sessions[activeSessionId] : null;
      if (closeTarget) {
        add({
          id: "c:close-session",
          group: "Commands",
          title: `Close session ${closeTarget.title}`,
          icon: <X className="size-4" />,
          hint: "CTRL SHIFT W",
          run: () => requestCloseSession(closeTarget.id),
        });
      }
      if (active) {
        for (const view of ["overview", "chat", "editor", "terminals"] as const) {
          add({
            id: `c:view:${view}`,
            group: "Commands",
            title: `Show ${view[0].toUpperCase()}${view.slice(1)}`,
            icon: <LayoutDashboard className="size-4" />,
            run: () => {
              set({ screen: "workspace" });
              setView(active.id, view);
            },
          });
        }
        add({
          id: "c:remove",
          group: "Commands",
          title: `Remove ${active.name} from AgentHub`,
          icon: <Trash2 className="size-4" />,
          run: () => set({ dialog: { type: "removeProject", projectId: active.id } }),
        });
      }
      const globals: Omit<Item, "score" | "indices">[] = [
        { id: "c:add", group: "Commands", title: "Open existing folder as project", icon: <FolderOpen className="size-4" />, hint: "CTRL O", run: () => void openFolderAsProject() },
        { id: "c:create", group: "Commands", title: "Create new project folder", icon: <FolderPlus className="size-4" />, hint: "CTRL SHIFT N", run: () => set({ dialog: { type: "createProject" } }) },
        { id: "c:settings", group: "Commands", title: "Open settings", icon: <SlidersHorizontal className="size-4" />, hint: "CTRL ,", run: () => openSettings() },
        { id: "c:ai", group: "Commands", title: "AI integrations (agents and API keys)", icon: <KeyRound className="size-4" />, run: () => openSettings("ai") },
        { id: "c:commands", group: "Commands", title: "Manage saved terminal commands", icon: <SquareTerminal className="size-4" />, run: () => openSettings("terminals") },
        { id: "c:chat", group: "Commands", title: "Open Chat", icon: <MessageSquare className="size-4" />, run: () => openChat() },
        { id: "c:general", group: "Commands", title: "New Ask chat (direct API)", icon: <MessageSquare className="size-4" />, run: () => { set({ workspace: "general", screen: "workspace" }); newChat(null); } },
      ];
      for (const g of globals) add(g);
    }

    if ((mode === "all" || mode === "sessions") && (query || mode === "sessions")) {
      for (const s of Object.values(sessions)) {
        const p = projects.find((x) => x.id === s.projectId);
        add({
          id: `s:${s.id}`,
          group: "Sessions",
          title: s.title,
          subtitle: `${p?.name ?? ""} · > ${s.commandLine}`,
          icon: <SquareTerminal className="size-4" />,
          right: <span className="font-mono text-[11px] text-muted uppercase">{s.status}</span>,
          run: (focus) => {
            if (focus) {
              focusSession(s.id);
              set({ focusSessionId: s.id });
            } else showSession(s.id);
          },
        });
      }
    }

    if ((mode === "all" && query) || mode === "files") {
      if (active) {
        const fileItems: Item[] = [];
        for (const path of files) {
          const m = fuzzyMatch(query, path);
          if (!m) continue;
          const name = basename(path);
          const offset = path.length - name.length;
          fileItems.push({
            id: `f:${path}`,
            group: `Files in ${active.name}`,
            title: name,
            subtitle: dirname(path) ? dirname(path) + "/" : "./",
            icon: <File className="size-4" />,
            score: m.score,
            indices: m.indices.filter((i) => i >= offset).map((i) => i - offset),
            run: () => {
              set({ screen: "workspace" });
              openFile(active.id, path);
            },
          });
        }
        fileItems.sort((a, b) => b.score - a.score);
        out.push(...fileItems.slice(0, mode === "files" ? 60 : 8));
      }
    }

    // Group, sort within group, cap per group in "all".
    const groups = new Map<string, Item[]>();
    for (const it of out) groups.set(it.group, [...(groups.get(it.group) ?? []), it]);
    const cap = mode === "all" ? { Chats: 6, Projects: 6, Commands: query ? 8 : 6, Sessions: 6 } : {};
    const ranked = [...groups.entries()].map(([g, list]) => {
      const sorted = query ? [...list].sort((a, b) => b.score - a.score) : list;
      return { g, list: sorted.slice(0, (cap as Record<string, number>)[g] ?? 60) };
    });
    // With a query, the group holding the best match comes first.
    if (query) ranked.sort((a, b) => (b.list[0]?.score ?? 0) - (a.list[0]?.score ?? 0));
    return ranked.flatMap((r) => r.list);
  }, [mode, query, projects, sessions, presets, shells, files, activeId, active, activeSessionId, now, engines]);

  useEffect(() => setSel(0), [query, mode]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${sel}"]`)?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  const run = (i: number, focus: boolean) => {
    const it = items[i];
    if (!it) return;
    close();
    it.run(focus);
  };

  let lastGroup = "";

  return (
    <RD.Root open onOpenChange={(o) => !o && close()}>
      <RD.Portal>
        <RD.Overlay asChild>
          <motion.div
            className="fixed inset-0 z-40 bg-[rgba(2,5,9,0.72)] backdrop-blur-[4px]"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.18 }}
          />
        </RD.Overlay>
        <RD.Content aria-describedby={undefined} className="fixed top-24 left-1/2 z-50 w-[660px] -translate-x-1/2 outline-none">
          <RD.Title className="sr-only">Command palette</RD.Title>
          <motion.div
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.2, ease: [0.2, 0.7, 0.2, 1] }}
            className="hud border border-accent/45 bg-[rgba(10,17,26,0.96)] shadow-[0_0_60px_rgba(77,163,255,0.16),0_24px_64px_rgba(0,0,0,0.6)] [--hud-size:14px] [--hud-weight:2px]"
          >
            <div className="flex h-[26px] items-center justify-between border-b border-line px-3.5 font-mono text-[10.5px] text-muted">
              <span>
                <span className="text-accent">▸</span> COMMAND // QUERY
              </span>
              <span>
                {projects.length} PROJECT{projects.length === 1 ? "" : "S"} INDEXED
              </span>
            </div>
            <div className="flex h-[54px] items-center gap-2.5 border-b border-line px-3.5">
              <Search className="size-[18px] text-accent" />
              <label htmlFor="palette-q" className="sr-only">
                Search
              </label>
              <input
                id="palette-q"
                autoFocus
                value={raw}
                placeholder="Search projects, files and commands"
                onChange={(e) => setRaw(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setSel((s) => Math.min(items.length - 1, s + 1));
                  } else if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setSel((s) => Math.max(0, s - 1));
                  } else if (e.key === "Enter") {
                    e.preventDefault();
                    run(sel, e.ctrlKey);
                  }
                }}
                spellCheck={false}
                autoComplete="off"
                className="h-[52px] flex-1 border-0 bg-transparent font-mono text-[16px] caret-accent outline-none placeholder:text-dim"
              />
              <kbd className="kbd">ESC</kbd>
            </div>

            <div className="flex gap-1.5 px-3.5 pt-2.5 pb-1">
              {MODES.map((m) => {
                const on = mode === m.mode;
                return (
                  <button
                    key={m.mode}
                    aria-pressed={on}
                    onClick={() => {
                      setChipMode(m.mode);
                      setRaw(prefixMode ? query : raw);
                      (document.getElementById("palette-q") as HTMLInputElement | null)?.focus();
                    }}
                    className={cn(
                      "h-6 border px-2.5 font-display text-[12px] tracking-[0.14em] uppercase",
                      on ? "border-accent bg-accent/12 font-bold text-accent" : "border-line bg-transparent font-semibold text-muted hover:text-fg",
                    )}
                  >
                    {m.label}
                  </button>
                );
              })}
            </div>

            <div ref={listRef} role="listbox" aria-label="Results" className="flex max-h-[420px] flex-col overflow-y-auto px-2 pt-1.5 pb-2">
              {items.length === 0 && <div className="px-2 py-6 text-center text-muted">No matches</div>}
              {items.map((it, i) => {
                const header = it.group !== lastGroup ? it.group : null;
                lastGroup = it.group;
                const selected = i === sel;
                return (
                  <div key={it.id}>
                    {header && (
                      <div className="px-2 pt-3 pb-1 font-display text-[12px] font-semibold tracking-[0.16em] text-muted uppercase first:pt-2">
                        {header}
                      </div>
                    )}
                    <div
                      role="option"
                      aria-selected={selected}
                      data-index={i}
                      onMouseMove={() => sel !== i && setSel(i)}
                      onClick={(e) => run(i, e.ctrlKey)}
                      className={cn(
                        "flex cursor-pointer items-center gap-3 p-2",
                        selected && "bg-accent/10 shadow-[inset_0_0_0_1px_rgba(77,163,255,0.45)]",
                      )}
                    >
                      {it.group === "Projects" ? (
                        it.icon
                      ) : (
                        <span className="flex size-[30px] shrink-0 items-center justify-center border border-line text-accent">
                          {it.icon}
                        </span>
                      )}
                      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span className={cn("truncate", selected && "font-semibold")}>
                          <Highlight text={it.title} indices={it.indices} />
                        </span>
                        {it.subtitle && <span className="truncate font-mono text-[11px] text-muted">{it.subtitle}</span>}
                      </span>
                      {it.right}
                      {it.hint && <kbd className="font-mono text-[10.5px] text-muted">{it.hint}</kbd>}
                      {selected && (
                        <kbd className="border border-accent/45 px-1.5 py-px font-mono text-[11px] text-accent">↵</kbd>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="flex h-9 items-center gap-4 border-t border-line bg-well px-3.5 font-mono text-[10.5px] text-muted">
              <span className="flex items-center gap-1.5">
                <kbd className="border border-line px-[5px]">↑↓</kbd>NAVIGATE
              </span>
              <span className="flex items-center gap-1.5">
                <kbd className="border border-line px-[5px]">↵</kbd>OPEN
              </span>
              <span className="flex items-center gap-1.5">
                <kbd className="border border-line px-[5px]">CTRL ↵</kbd>FOCUS MODE
              </span>
              <span className="flex-1" />
              <span>LIVE SESSIONS KEEP RUNNING</span>
            </div>
          </motion.div>
        </RD.Content>
      </RD.Portal>
    </RD.Root>
  );
}
