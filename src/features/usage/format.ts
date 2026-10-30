// Pure helpers for usage-limit readouts (thresholds, reset times, sync age).
import type { EngineId, LimitWindow, ProviderUsage, UsagePrefs } from "@/lib/types";
import { pad2 } from "@/lib/utils";

export type Level = "normal" | "warn" | "limit";

/** Providers with plan windows AgentHub can read. Claude Agent runs on an API
 *  key (no plan windows) and Gemini exposes none, so only Codex is here. */
export type UsageProvider = "openai";

/** `engine` is the integration whose windows these are; turned off, they're hidden. */
export const PROVIDERS: { id: UsageProvider; name: string; cli: string; engine: EngineId }[] = [{ id: "openai", name: "OpenAI", cli: "Codex", engine: "codex" }];

/** 0–79 normal, warnAt–99 warn, 100+ limit. */
export function level(pct: number, prefs: Pick<UsagePrefs, "warnAt">): Level {
  if (pct >= 100) return "limit";
  if (pct >= prefs.warnAt) return "warn";
  return "normal";
}

/** A window whose reset time has passed no longer reflects current usage. */
export function isExpired(w: LimitWindow | null, now: number): boolean {
  return !!w?.resetsAt && w.resetsAt <= now;
}

/** The window as of `now`: `null` once it has reset. */
export function current(w: LimitWindow | null, now: number): LimitWindow | null {
  return w && !isExpired(w, now) ? w : null;
}

export function pctText(w: LimitWindow): string {
  return `${Math.round(w.usedPercent)}%`;
}

/** `1H 48M`, `42M`, or `0:42` (h:mm) for the countdown style. */
export function duration(ms: number, style: "words" | "clock" = "words"): string {
  const mins = Math.max(0, Math.ceil(ms / 60_000));
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (style === "clock") return `${h}:${pad2(m)}`;
  if (h === 0) return `${m}M`;
  if (h >= 24) return `${Math.floor(h / 24)}D ${h % 24}H`;
  return `${h}H ${m}M`;
}

const DAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

function clock(d: Date): string {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/**
 * When a window resets, in the design's style: within a day `RESETS IN 1H 48M · 14:30`,
 * later `RESETS MON 09:00`, at the limit a countdown `RESETS IN 0:42`.
 */
export function resetText(resetsAt: number | null, now: number, atLimit = false): string {
  if (!resetsAt) return "RESET TIME UNKNOWN";
  const left = resetsAt - now;
  const at = new Date(resetsAt);
  if (atLimit) return `RESETS IN ${duration(left, "clock")}`;
  if (left < 24 * 3_600_000) return `RESETS IN ${duration(left)} · ${clock(at)}`;
  return `RESETS ${DAYS[at.getDay()]} ${clock(at)}`;
}

export function syncedText(syncedAt: number | null, now: number): string {
  if (!syncedAt) return "NOT SYNCED";
  const mins = Math.floor((now - syncedAt) / 60_000);
  if (mins < 1) return "SYNCED JUST NOW";
  if (mins < 60) return `SYNCED ${mins} MIN AGO`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `SYNCED ${h} H AGO`;
  return `SYNCED ${Math.floor(h / 24)} D AGO`;
}

/** Short status for a provider without numbers to show. */
export function emptyLabel(p: ProviderUsage): string {
  switch (p.status) {
    case "notFound":
      return "CLI NOT FOUND";
    case "error":
      return "UNAVAILABLE";
    default:
      return "NO READING YET";
  }
}

/** A window that crossed `alertAt` or the limit, for one-time toasts. */
export function alertKey(provider: UsageProvider, kind: "session" | "weekly", w: LimitWindow, prefs: UsagePrefs) {
  if (w.usedPercent >= 100) return `${provider}:${kind}:${w.resetsAt}:limit`;
  if (w.usedPercent >= prefs.alertAt) return `${provider}:${kind}:${w.resetsAt}:alert`;
  return null;
}
