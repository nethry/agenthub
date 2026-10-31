import type { Conversation, EngineInfo, SessionInfo } from "@/lib/types";
import { conversationsIn, needsAttention, visibleConversations } from "@/features/chat/models";

export function overviewChat(projectId: string, all: Conversation[], engines: EngineInfo[], selected: string | null | undefined, requests: Record<string, string>) {
  const list = conversationsIn(visibleConversations(all, engines), projectId);
  const conversation = list.find((c) => c.id === selected)
    ?? list.find((c) => !!requests[c.id] || c.status === "running" || c.status === "waiting_for_approval")
    ?? list[0];
  return { conversation, attention: list.filter((c) => c.id !== conversation?.id && needsAttention(c)) };
}

/** Preserve pane positions when focus changes; replace the first for a newly selected session. */
export function overviewSessions(sessions: SessionInfo[], pinned: string[], active: string | null): string[] {
  const valid = new Set(sessions.map((s) => s.id));
  let ids = [...new Set(pinned)].filter((id) => valid.has(id)).slice(0, 2);
  if (active && valid.has(active) && !ids.includes(active)) ids = [active, ...ids].slice(0, 2);
  for (const s of sessions) if (ids.length < 2 && !ids.includes(s.id)) ids.push(s.id);
  return ids;
}

export function rootReadme(paths: string[]): string | null {
  return paths.filter((p) => /^readme\.(md|markdown|mdown|mkd)$/i.test(p))
    .sort((a, b) => Number(!/^readme\.md$/i.test(a)) - Number(!/^readme\.md$/i.test(b)) || a.localeCompare(b))[0] ?? null;
}
