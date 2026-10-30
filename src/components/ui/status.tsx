import { X } from "lucide-react";
import type { SessionActivity, SessionInfo, SessionStatus } from "@/lib/types";
import { cn } from "@/lib/utils";

type StatusView = Pick<SessionInfo, "status" | "exitCode"> & Partial<Pick<SessionInfo, "activity" | "activitySource">>;

/** Arc glyph for STARTING (spins unless reduced motion). */
function Arc({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={cn("size-3 animate-[spin_1.2s_linear_infinite]", className)}>
      <path d="M21 12a9 9 0 1 1-6.2-8.6" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="square" />
    </svg>
  );
}

/**
 * Running is split by activity: busy is an orange pulsing square, idle a green
 * square without glow. Without an activity reading, `glow` decides as before.
 */
export function StatusDot({
  status,
  activity,
  glow = true,
  className,
}: {
  status: SessionStatus;
  activity?: SessionActivity | null;
  glow?: boolean;
  className?: string;
}) {
  if (status === "running")
    return (
      <span
        aria-hidden="true"
        className={cn(
          "inline-block size-[5px] shrink-0",
          activity === "busy" ? "busy-pulse" : cn("bg-run", !activity && glow && "shadow-[0_0_6px_#3DF5A0]"),
          className,
        )}
      />
    );
  if (status === "starting") return <Arc className={cn("size-2.5 text-warn", className)} />;
  if (status === "failed") return <X aria-hidden="true" className={cn("icon-strong size-3 text-danger", className)} />;
  return <span aria-hidden="true" className={cn("inline-block size-[5px] shrink-0 border border-muted", className)} />;
}

export function statusLabel(s: StatusView): string {
  switch (s.status) {
    case "starting":
      return "Starting";
    case "running":
      return s.activity === "busy" ? "Busy" : s.activity === "idle" ? "Idle" : "Running";
    case "failed":
      return "Failed";
    case "exited":
      return s.exitCode == null ? "Exited" : `Exit ${s.exitCode}`;
  }
}

/** Says what BUSY / IDLE is based on, so it's never mistaken for agent insight. */
export function activityTitle(s: StatusView): string | undefined {
  if (s.status !== "running" || !s.activity) return undefined;
  if (s.activitySource === "shell")
    return s.activity === "busy" ? "Busy: a command is running" : "Idle: shell prompt is waiting for input";
  return s.activity === "busy" ? "Busy: terminal output in the last 2 s" : "Idle: no output for 2 s";
}

const chipTone: Record<SessionStatus, string> = {
  starting: "border-warn/50 bg-warn/8 text-warn",
  running: "border-run/45 bg-run/8 text-run",
  exited: "border-line-strong text-muted",
  failed: "border-danger/50 bg-danger/8 text-danger",
};

const inlineTone: Record<SessionStatus, string> = {
  starting: "text-warn",
  running: "text-run",
  exited: "text-muted",
  failed: "text-danger",
};

const busyChipTone = "border-warn/50 bg-warn/8 text-warn";

/** Process status: color + glyph + label, never color alone. */
export function StatusChip({
  session,
  variant = "chip",
  suffix,
  className,
}: {
  session: StatusView;
  variant?: "chip" | "inline";
  suffix?: string;
  className?: string;
}) {
  const busy = session.status === "running" && session.activity === "busy";
  return (
    <span
      title={activityTitle(session)}
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 font-display text-[11px] font-bold tracking-[0.14em] uppercase whitespace-nowrap",
        variant === "chip"
          ? cn("border px-1.5 py-px", busy ? busyChipTone : chipTone[session.status])
          : busy
            ? "text-warn"
            : inlineTone[session.status],
        className,
      )}
    >
      <StatusDot status={session.status} activity={session.activity} />
      {statusLabel(session)}
      {suffix && <span className="font-mono tracking-normal">· {suffix}</span>}
    </span>
  );
}

/** Executable detection — separate from process status by design. */
export function Availability({ found, wsl, className }: { found: boolean; wsl?: boolean; className?: string }) {
  if (wsl)
    return (
      <span className={cn("font-display text-[11px] font-bold tracking-[0.14em] text-muted uppercase", className)}>
        WSL
      </span>
    );
  return (
    <span
      className={cn(
        "font-display text-[11px] font-bold tracking-[0.14em] uppercase",
        found ? "text-run" : "text-danger-soft",
        className,
      )}
    >
      {found ? "Online" : "Not found"}
    </span>
  );
}
