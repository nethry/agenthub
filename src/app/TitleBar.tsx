import { MessagesSquare, Search } from "lucide-react";
import { AttentionBadge, signalParts, useWorkspaceSignals } from "@/features/projects/ProjectRail";
import { UpdateBadge } from "@/features/updates/UpdateBadge";
import { cn } from "@/lib/utils";
import { selectGeneral } from "./actions";
import { set, useApp } from "./store";
import { WindowControls } from "./WindowControls";

export function Logo() {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className="size-5 fill-none stroke-accent drop-shadow-[0_0_4px_rgba(77,163,255,0.6)]"
      strokeWidth={1.5}
    >
      <polygon points="12 2 21 7 21 17 12 22 3 17 3 7" />
      <circle cx="12" cy="12" r="3.5" />
    </svg>
  );
}

/** Custom title bar: drag region, global search, window controls. */
export function TitleBar({ search = true }: { search?: boolean }) {
  return (
    <header data-tauri-drag-region className="flex h-10 shrink-0 items-center gap-3 border-b border-line bg-ground pl-3.5">
      <div data-tauri-drag-region className="flex w-[206px] items-center gap-2.5">
        <Logo />
        <span data-tauri-drag-region className="font-display text-[15px] font-bold tracking-[0.22em]">
          AGENTHUB
        </span>
      </div>
      <div data-tauri-drag-region className="flex flex-1 justify-center gap-2">
        {search && (
          <>
            <button
              onClick={() => set({ paletteOpen: true, paletteMode: "all" })}
              className="flex h-7 w-[440px] min-w-0 items-center gap-2 border border-line bg-surface pr-2 pl-2.5 text-[12px] text-muted transition-colors duration-200 hover:border-line-strong"
            >
              <Search className="size-3.5" />
              <span className="flex-1 truncate text-left">Search chats, files and commands</span>
              <kbd className="kbd">CTRL K</kbd>
            </button>
            <GeneralButton />
          </>
        )}
      </div>
      <UpdateBadge />
      <WindowControls />
    </header>
  );
}

/** General: chats without a project (direct APIs). */
function GeneralButton() {
  const active = useApp((s) => s.screen === "workspace" && s.workspace === "general");
  const signals = useWorkspaceSignals()("general");
  const parts = signalParts("Ask chats", signals);
  return (
    <button
      aria-label={parts.join(", ")}
      aria-current={active ? "page" : undefined}
      title={["Ask: chats without a project, answered by direct APIs", ...parts.slice(1)].join("\n")}
      onClick={selectGeneral}
      className={cn(
        "relative flex h-7 shrink-0 items-center gap-2 border px-2.5 font-display text-[12px] font-bold tracking-[0.14em] uppercase transition-colors duration-200",
        active ? "border-accent/50 bg-accent/10 text-accent shadow-[0_0_10px_rgba(77,163,255,0.2)]" : "border-line bg-surface text-muted hover:border-line-strong hover:text-fg",
      )}
    >
      <MessagesSquare className="size-3.5" />
      Ask
      {signals.running > 0 && <span className="live-glow size-[5px] bg-agent" />}
      {signals.attn > 0 && <AttentionBadge count={signals.attn} />}
    </button>
  );
}
