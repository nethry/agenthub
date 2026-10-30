// In-app fan-out of file-system changes: the backend watcher's `fs-changed`
// events plus changes AgentHub made itself (so the tree updates at once).
import type { FsChange } from "@/lib/types";

type Listener = (change: FsChange) => void;
const listeners = new Set<Listener>();

export function onFsChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function emitFsChange(change: FsChange) {
  for (const l of listeners) l(change);
}
