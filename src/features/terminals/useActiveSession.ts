import { useApp, workspaceOf } from "@/app/store";
import type { SessionInfo } from "@/lib/types";

/** The project's active terminal session, if any. */
export function useActiveSession(projectId: string | null): SessionInfo | null {
  return useApp((s) => {
    if (!projectId) return null;
    const id = s.workspaces[projectId]?.activeSessionId ?? workspaceOf(projectId).activeSessionId;
    return (id && s.sessions[id]) || null;
  });
}
