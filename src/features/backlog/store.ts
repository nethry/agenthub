// Backlog UI state. SQLite (via the backend) is the source of truth; this
// store caches each project's items and what the Backlog view shows.
import { create } from "zustand";
import type { BacklogItem, BacklogKind } from "@/lib/types";
import { defaultFilter, type BacklogFilter } from "./model";

/** What the detail pane shows: an item, or the form for a new one. */
export type Selection = { item: string } | { create: BacklogKind } | null;

export interface BacklogState {
  /** Items per project id (newest first, as the backend lists them). */
  items: Record<string, BacklogItem[]>;
  loading: Record<string, boolean>;
  selection: Record<string, Selection>;
  filter: Record<string, BacklogFilter>;
  /** Item ids whose suggestion the user dismissed, with the suggested status. */
  dismissed: Record<string, string>;
  /** A failed action, shown in the detail pane. */
  error: string | null;
}

export const initialBacklogState = (): BacklogState => ({
  items: {},
  loading: {},
  selection: {},
  filter: {},
  dismissed: {},
  error: null,
});

export const useBacklog = create<BacklogState>(initialBacklogState);
export const setBacklog = useBacklog.setState;
export const getBacklog = useBacklog.getState;

const NO_ITEMS: BacklogItem[] = [];
export const itemsOf = (s: BacklogState, projectId: string) => s.items[projectId] ?? NO_ITEMS;
export const filterOf = (s: BacklogState, projectId: string) => s.filter[projectId] ?? defaultFilter();

/** The item a conversation was started from, if its project's backlog is loaded. */
export function itemForConversation(s: BacklogState, projectId: string | null, conversationId: string): BacklogItem | null {
  if (!projectId) return null;
  return itemsOf(s, projectId).find((i) => i.links.some((l) => l.conversationId === conversationId)) ?? null;
}
