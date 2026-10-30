import { Minimize2, X } from "lucide-react";
import { set, useApp, useSessions } from "@/app/store";
import { focusSession, requestCloseSession } from "@/app/actions";
import { IconButton } from "@/components/ui/button";
import { Kbd } from "@/components/ui/form";
import { StatusChip, StatusDot, activityTitle, statusLabel } from "@/components/ui/status";
import { WindowControls } from "@/app/WindowControls";
import { useNow } from "@/lib/hooks";
import { cn, initials, uptime } from "@/lib/utils";
import { TerminalView } from "./TerminalView";

/** One full-window terminal. Ctrl+1–9 switches session, Shift+Esc exits. */
export function FocusMode({ sessionId }: { sessionId: string }) {
  const session = useApp((s) => s.sessions[sessionId]);
  const project = useApp((s) => s.projects.find((p) => p.id === session?.projectId));
  const sessions = useSessions(session?.projectId ?? null);
  const scrollback = useApp((s) => s.terminalPrefs.scrollback);
  const now = useNow();
  if (!session || !project) return null;

  const exit = () => set({ focusSessionId: null });

  return (
    <div className="scan flex h-full flex-col bg-well">
      <header data-tauri-drag-region className="flex h-11 shrink-0 items-center gap-3 border-b border-line bg-ground pl-3.5">
        <span className="flex size-6 items-center justify-center border border-accent font-display text-[12px] font-bold text-accent">
          {initials(project.name)}
        </span>
        <span className="font-display text-[13px] font-semibold tracking-[0.14em] text-muted uppercase">{project.name}</span>
        <span className="font-mono text-accent">//</span>
        <span className="max-w-[240px] truncate font-display text-[15px] font-bold tracking-[0.14em] uppercase [text-shadow:0_0_12px_rgba(77,163,255,0.5)]">
          {session.title}
        </span>
        <StatusChip
          session={session}
          suffix={session.status === "running" ? uptime(session.startedAt, now, true) : undefined}
          className="text-[11px]"
        />
        <div data-tauri-drag-region className="flex min-w-0 flex-1 justify-center">
          <div role="tablist" aria-label="Switch session" className="flex min-w-0 overflow-x-auto border border-line">
            {sessions.map((s, i) => {
              const selected = s.id === sessionId;
              return (
                <button
                  key={s.id}
                  role="tab"
                  aria-selected={selected}
                  title={i < 9 ? `Ctrl+${i + 1} · middle-click to close` : "Middle-click to close"}
                  onClick={() => {
                    set({ focusSessionId: s.id });
                    focusSession(s.id);
                  }}
                  onAuxClick={(e) => e.button === 1 && requestCloseSession(s.id)}
                  className={cn(
                    "flex h-7 shrink-0 items-center gap-1.5 border-0 px-3 text-[12px]",
                    i > 0 && "border-l border-line",
                    selected
                      ? "bg-accent/12 font-semibold text-accent shadow-[inset_0_-2px_0_#4DA3FF]"
                      : "bg-transparent text-muted hover:text-fg",
                  )}
                >
                  {i < 9 && <kbd className="font-mono text-[10px]">{i + 1}</kbd>}
                  <StatusDot status={s.status} activity={s.activity} glow={selected} />
                  <span className="max-w-[140px] truncate" title={activityTitle(s)}>
                    {s.title}
                  </span>
                  <span className="sr-only">, {statusLabel(s)}</span>
                </button>
              );
            })}
          </div>
        </div>
        <IconButton
          aria-label="Close session"
          title="Close session (Ctrl Shift W)"
          bordered
          size={28}
          onClick={() => requestCloseSession(session.id)}
          className="hover:border-danger/60 hover:text-danger"
        >
          <X className="size-3.5" />
        </IconButton>
        <button
          onClick={exit}
          className="flex h-7 items-center gap-2 border border-line bg-transparent px-2.5 font-display text-[12px] font-semibold tracking-[0.12em] uppercase hover:border-line-strong"
        >
          <Minimize2 className="size-3.5" />
          Exit focus
          <Kbd className="px-[5px] py-0 text-[10px]">SHIFT ESC</Kbd>
        </button>
        <WindowControls height={44} />
      </header>

      <main className="flex min-h-0 flex-1 justify-center px-10 py-7">
        <div className="hud flex w-full max-w-[1120px] min-w-0 flex-col border border-line-dim px-3.5 py-2.5">
          <TerminalView key={session.id} sessionId={session.id} fontSize={14} autoFocus className="bg-transparent" />
        </div>
      </main>

      <footer className="flex h-[30px] shrink-0 items-center gap-[18px] border-t border-line bg-ground px-4 font-mono text-[10.5px] text-muted">
        <span className="truncate">
          {session.shellLabel} · {session.cwd}
        </span>
        <span>CTRL SHIFT C COPY · CTRL SHIFT V PASTE</span>
        <span className="flex-1" />
        <span>SCROLLBACK {scrollback}</span>
        <span>
          {session.cols}×{session.rows}
        </span>
      </footer>
    </div>
  );
}
