// Backlog rules without React or IPC: labels, ordering, the AI actions and
// the prompts they prefill, status suggestions and screenshot limits.
import type { BacklogItem, BacklogKind, BacklogPriority, BacklogPurpose, BacklogStatus, ChatMode, Conversation } from "@/lib/types";

/** Same as the backend (`backlog::MAX_ITEM_IMAGES`, `chat::images`). */
export const MAX_ITEM_IMAGES = 8;
export const SCREENSHOT_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
export const MAX_SCREENSHOT_BYTES = 5 * 1024 * 1024;
/** Screenshots one `backlog_add_images` call takes (the chat image limit). */
export const SCREENSHOTS_PER_ADD = 4;

export const KIND_LABEL: Record<BacklogKind, string> = { feature: "Feature", bug: "Bug" };
const PREFIX: Record<BacklogKind, string> = { feature: "FEAT", bug: "BUG" };
export const PRIORITY_LABEL: Record<BacklogPriority, string> = { low: "Low", normal: "Normal", high: "High" };
export const PRIORITIES: BacklogPriority[] = ["high", "normal", "low"];

/** Board order: work in progress first, closed items last. */
export const STATUS_ORDER: BacklogStatus[] = ["in_progress", "review", "planned", "open", "done", "dropped"];
export const CLOSED: BacklogStatus[] = ["done", "dropped"];

const STATUS_LABEL: Record<BacklogStatus, Record<BacklogKind, string>> = {
  open: { feature: "Idea", bug: "Reported" },
  planned: { feature: "Planned", bug: "Diagnosed" },
  in_progress: { feature: "In progress", bug: "In progress" },
  review: { feature: "Review", bug: "Review" },
  done: { feature: "Done", bug: "Fixed" },
  dropped: { feature: "Won't do", bug: "Won't fix" },
};

/** Group headings, where both kinds share one list. */
const GROUP_LABEL: Record<BacklogStatus, string> = {
  open: "New",
  planned: "Planned",
  in_progress: "In progress",
  review: "Review",
  done: "Done",
  dropped: "Won't do",
};

export const statusLabel = (kind: BacklogKind, status: BacklogStatus) => STATUS_LABEL[status][kind];
export const groupLabel = (status: BacklogStatus, kind: BacklogKind | "all") => (kind === "all" ? GROUP_LABEL[status] : statusLabel(kind, status));
export const itemKey = (item: Pick<BacklogItem, "kind" | "seq">) => `${PREFIX[item.kind]}-${item.seq}`;

/** Text color per status (always shown with its label). */
export const STATUS_TONE: Record<BacklogStatus, string> = {
  open: "text-muted",
  planned: "text-plan",
  in_progress: "text-agent",
  review: "text-warn",
  done: "text-run",
  dropped: "text-dim",
};

export const BODY_TEMPLATE: Record<BacklogKind, string> = {
  feature: "## Goal\n\n\n## Acceptance criteria\n\n- \n\n## Notes\n",
  bug: "## Steps to reproduce\n\n1. \n\n## Expected\n\n\n## Actual\n\n\n## Environment\n",
};

// ---------- filtering ----------

export interface BacklogFilter {
  kind: BacklogKind | "all";
  query: string;
  showClosed: boolean;
}

export const defaultFilter = (): BacklogFilter => ({ kind: "all", query: "", showClosed: false });

const PRIORITY_RANK: Record<BacklogPriority, number> = { high: 0, normal: 1, low: 2 };

export function matches(item: BacklogItem, f: BacklogFilter): boolean {
  if (f.kind !== "all" && item.kind !== f.kind) return false;
  if (!f.showClosed && CLOSED.includes(item.status)) return false;
  const q = f.query.trim().toLowerCase();
  if (!q) return true;
  return itemKey(item).toLowerCase().includes(q) || item.title.toLowerCase().includes(q) || item.body.toLowerCase().includes(q);
}

/** Visible items grouped by status (board order), by priority then newest within a group. */
export function groupItems(items: BacklogItem[], f: BacklogFilter): { status: BacklogStatus; items: BacklogItem[] }[] {
  const shown = items.filter((i) => matches(i, f));
  return STATUS_ORDER.map((status) => ({
    status,
    items: shown.filter((i) => i.status === status).sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || b.seq - a.seq),
  })).filter((g) => g.items.length > 0);
}

/** Items still closed off by the filter (for the "N done" hint). */
export const closedCount = (items: BacklogItem[], kind: BacklogKind | "all") =>
  items.filter((i) => CLOSED.includes(i.status) && (kind === "all" || i.kind === kind)).length;

// ---------- AI actions ----------

export interface PurposeMeta {
  label: string;
  mode: ChatMode;
  hint: string;
}

export const PURPOSE: Record<BacklogPurpose, PurposeMeta> = {
  plan: { label: "Plan", mode: "plan", hint: "Plan mode: the agent reads the project and plans; it doesn't change files." },
  investigate: { label: "Investigate", mode: "plan", hint: "Plan mode: the agent finds the root cause and proposes a fix; it doesn't change files." },
  implement: { label: "Implement", mode: "agent", hint: "Agent mode: the agent changes files, with your approvals." },
  fix: { label: "Fix", mode: "agent", hint: "Agent mode: the agent changes files, with your approvals." },
};

export const actionsFor = (kind: BacklogKind): BacklogPurpose[] => (kind === "feature" ? ["plan", "implement"] : ["investigate", "fix"]);

/** The instruction prefilled in the composer; the item itself goes as context. */
export function actionPrompt(item: BacklogItem, purpose: BacklogPurpose): string {
  const ref = `${itemKey(item)} “${item.title}”`;
  switch (purpose) {
    case "plan":
      return `Plan the implementation of ${ref}. Read the relevant code first. Take the other backlog items into account: avoid conflicts, reuse shared groundwork and call out ordering dependencies.`;
    case "investigate":
      return `Investigate ${ref}: find the root cause in the code, then propose a fix and a regression test. Don't change files yet.`;
    case "implement":
      return `Implement ${ref}${item.plan ? " following its saved plan" : ""}. Keep the change focused and add or update tests.`;
    case "fix":
      return `Fix ${ref}${item.plan ? " following its saved plan" : ""}. Find the root cause, fix it and add a regression test.`;
  }
}

/** Starting Implement or Fix moves an item that isn't being worked on yet to In progress. */
export const startsWork = (purpose: BacklogPurpose, status: BacklogStatus) =>
  (purpose === "implement" || purpose === "fix") && (status === "open" || status === "planned");

// ---------- suggestions ----------

export interface Suggestion {
  status: BacklogStatus;
  text: string;
}

/**
 * A status change AgentHub suggests (never applies): Planned once a plan is
 * saved, Review once the latest Implement/Fix chat completed. Done is always
 * the user's call.
 */
export function suggestion(item: BacklogItem, conversations: Pick<Conversation, "id" | "status">[]): Suggestion | null {
  if (item.status === "open" && item.plan) {
    return { status: "planned", text: "A plan is saved." };
  }
  if (item.status === "in_progress") {
    const work = item.links.filter((l) => l.purpose === "implement" || l.purpose === "fix");
    const last = work[work.length - 1];
    const conv = last && conversations.find((c) => c.id === last.conversationId);
    if (conv?.status === "completed") return { status: "review", text: "The agent finished its turn. Review the changes." };
  }
  return null;
}

// ---------- screenshots ----------

export function screenshotPasteError(files: { type: string; size: number }[], have: number): string | null {
  if (have + files.length > MAX_ITEM_IMAGES) return `An item keeps up to ${MAX_ITEM_IMAGES} screenshots. Remove one first.`;
  if (files.some((f) => !SCREENSHOT_TYPES.includes(f.type))) return "Paste PNG, JPEG, GIF or WebP images.";
  if (files.some((f) => f.size > MAX_SCREENSHOT_BYTES)) return `Screenshots can be up to ${MAX_SCREENSHOT_BYTES / (1024 * 1024)} MB each.`;
  return null;
}

/** The screenshots a chat message takes: the newest, at most `max`. */
export const screenshotsForMessage = <T extends { createdAt: number }>(images: T[], max: number): T[] =>
  [...images].sort((a, b) => b.createdAt - a.createdAt).slice(0, max);
