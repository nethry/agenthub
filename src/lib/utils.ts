import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Two-letter badge for a project name: "billing-api" → "BA", "agenthub" → "AG". */
export function initials(name: string): string {
  const parts = name.split(/[\s\-_.]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

/** Stable badge tone for a project, derived from its id. */
export const BADGE_TONES = ["accent", "warn", "run", "tag", "neutral"] as const;
export type BadgeTone = (typeof BADGE_TONES)[number];
export function badgeTone(id: string): BadgeTone {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return BADGE_TONES[h % BADGE_TONES.length];
}

export function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Uptime readout: `T+hh:mm:ss`, or `T+hh:mm` when `short`. */
export function uptime(startedAt: number, now: number, short = false): string {
  const s = Math.max(0, Math.floor((now - startedAt) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return short ? `T+${pad2(h)}:${pad2(m)}` : `T+${pad2(h)}:${pad2(m)}:${pad2(s % 60)}`;
}

export function relativeAgo(ts: number, now: number): string {
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.floor(h / 24);
  return d === 1 ? "yesterday" : `${d} days ago`;
}

export function basename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

export function dirname(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

/** Absolute path for a project-relative `/` path, using the root's separator. */
export function joinPath(root: string, rel: string): string {
  if (!rel) return root;
  const sep = root.includes("\\") ? "\\" : "/";
  return root.replace(/[\\/]+$/, "") + sep + rel.split("/").join(sep);
}

/**
 * Fuzzy subsequence match. Returns a score (higher is better) and matched
 * character indices for highlighting, or null when `query` doesn't match.
 */
export function fuzzyMatch(query: string, text: string): { score: number; indices: number[] } | null {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (!q) return { score: 0, indices: [] };
  const direct = t.indexOf(q);
  if (direct !== -1) {
    const indices = Array.from({ length: q.length }, (_, i) => direct + i);
    const boundary = direct === 0 || /[\s/\\\-_.]/.test(t[direct - 1]);
    return { score: 1000 - direct + (boundary ? 200 : 0) - t.length * 0.1, indices };
  }
  const indices: number[] = [];
  let ti = 0;
  let score = 0;
  let prev = -2;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found === -1) return null;
    score += found === prev + 1 ? 15 : 1;
    if (found === 0 || /[\s/\\\-_.]/.test(t[found - 1])) score += 10;
    indices.push(found);
    prev = found;
    ti = found + 1;
  }
  return { score: score - t.length * 0.1, indices };
}

/** Allow only http(s) links to leave the app. */
export function safeExternalUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}
