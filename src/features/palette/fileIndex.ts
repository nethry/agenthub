// Cached project file lists for the palette's file search. Invalidated by
// file-system changes; the timeout is only a fallback if watching failed.
import { ipc } from "@/lib/ipc";

const FALLBACK_TTL_MS = 5 * 60_000;
const cache = new Map<string, Promise<string[]>>();

export function indexFor(projectId: string): Promise<string[]> {
  let p = cache.get(projectId);
  if (!p) {
    p = ipc.indexFiles(projectId).catch(() => []);
    cache.set(projectId, p);
    const mine = p;
    setTimeout(() => cache.get(projectId) === mine && cache.delete(projectId), FALLBACK_TTL_MS);
  }
  return p;
}

export function invalidateFileIndex(projectId: string) {
  cache.delete(projectId);
}
