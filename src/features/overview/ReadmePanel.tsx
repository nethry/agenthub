import { useEffect, useRef, useState } from "react";
import { BookOpen, PanelLeftClose, RefreshCw } from "lucide-react";
import { openFile } from "@/app/actions";
import { fileKey, updateWorkspace, useApp } from "@/app/store";
import { Button, IconButton } from "@/components/ui/button";
import { Select } from "@/components/ui/form";
import { MarkdownView } from "@/features/editor/MarkdownPreview";
import { isMarkdownPath } from "@/features/editor/markdown";
import { getMeta } from "@/features/editor/models";
import { onFsChange } from "@/features/explorer/fsEvents";
import { indexFor } from "@/features/palette/fileIndex";
import { errorMessage, ipc } from "@/lib/ipc";
import { rootReadme } from "./model";

const PREVIEW_LIMIT = 512_000;

export function ReadmePanel({ projectId, onCollapse }: { projectId: string; onCollapse: () => void }) {
  const selected = useApp((s) => s.workspaces[projectId]?.overviewDocument ?? null);
  const [root, setRoot] = useState<string | null>(null);
  const [documents, setDocuments] = useState<string[]>([]);
  const [discoverError, setDiscoverError] = useState<string | null>(null);
  const [discovering, setDiscovering] = useState(true);
  const [revision, setRevision] = useState(0);
  const path = selected ?? root;
  const currentPath = useRef(path);
  currentPath.current = path;
  const dirty = useApp((s) => !!s.dirty[fileKey(projectId, path ?? "")]);
  const diskState = useApp((s) => s.diskState[fileKey(projectId, path ?? "")]);
  const open = useApp((s) => !!path && !!s.workspaces[projectId]?.openFiles.includes(path));
  const [preview, setPreview] = useState<{ path: string; text: string; error: string | null } | null>(null);

  useEffect(() => {
    let stale = false;
    let sequence = 0;
    const load = async () => {
      const ticket = ++sequence;
      try {
        const entries = await ipc.listDir(projectId, "");
        if (stale || ticket !== sequence) return;
        const paths = entries.filter((e) => !e.isDir && isMarkdownPath(e.path)).map((e) => e.path);
        setRoot(rootReadme(paths));
        setDocuments((old) => [...new Set([...paths, ...old])].sort());
        setDiscoverError(null);
      } catch (e) {
        if (!stale && ticket === sequence) setDiscoverError(errorMessage(e));
      } finally {
        if (!stale && ticket === sequence) setDiscovering(false);
      }
    };
    void load();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = onFsChange((change) => {
      if (change.projectId !== projectId) return;
      const relevant = change.overflow || change.paths.some((p) =>
        p === "" || p === currentPath.current || currentPath.current?.startsWith(p + "/") || (!p.includes("/") && isMarkdownPath(p)));
      if (!relevant) return;
      clearTimeout(timer);
      timer = setTimeout(() => { void load(); setRevision((v) => v + 1); }, 200);
    });
    return () => { stale = true; off(); clearTimeout(timer); };
  }, [projectId]);

  useEffect(() => {
    if (!path) return;
    let stale = false;
    let unsubscribe: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const publish = (text: string) => {
      if (!stale) setPreview({ path, text: text.length > PREVIEW_LIMIT ? "" : text, error: text.length > PREVIEW_LIMIT ? "This document is too large for the compact preview. Open it in the editor." : null });
    };
    const meta = getMeta(projectId, path);
    if (meta && !meta.model.isDisposed()) {
      publish(meta.model.getValue());
      const listener = meta.model.onDidChangeContent(() => {
        clearTimeout(timer);
        timer = setTimeout(() => { if (!meta.model.isDisposed()) publish(meta.model.getValue()); }, 150);
      });
      unsubscribe = () => listener.dispose();
    } else {
      // Keep the current preview mounted during watcher refreshes to preserve scroll position.
      void ipc.readFile(projectId, path).then((file) => publish(file.content)).catch((e) => {
        if (!stale) setPreview({ path, text: "", error: errorMessage(e) });
      });
    }
    return () => { stale = true; unsubscribe?.(); clearTimeout(timer); };
  }, [projectId, path, revision, dirty, open]);

  // Fetch the broader file index only when the user opens the document selector.
  const discoverDocuments = () => {
    void indexFor(projectId).then((paths) => setDocuments(paths.filter(isMarkdownPath).sort()));
  };
  const choices = [...new Set([...(path ? [path] : []), ...documents])];
  const current = preview?.path === path ? preview : null;
  return <>
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-2 py-2">
      <BookOpen className="size-4 shrink-0 text-accent" />
      <Select aria-label="Project instructions document" value={path ?? ""} onFocus={discoverDocuments} onChange={(e) => updateWorkspace(projectId, { overviewDocument: e.target.value || null })} className="h-7 min-w-0 flex-1 text-[12px]">
        {!path && <option value="">Choose a Markdown document</option>}
        {choices.map((p) => <option key={p} value={p}>{p}</option>)}
      </Select>
      <Button size="sm" disabled={!path} onClick={() => path && openFile(projectId, path)}>Open in editor</Button>
      <IconButton size={28} aria-label="Hide instructions" onClick={onCollapse}><PanelLeftClose className="size-4" /></IconButton>
    </div>
    {(dirty || diskState) && <p role="status" className="m-0 shrink-0 border-b border-line px-3 py-1.5 text-[11px] text-warn">{diskState === "deleted" ? "Deleted on disk. Showing the editor buffer." : diskState === "changed" ? "Changed on disk. Showing your editor content; resolve in the editor." : "Preview includes unsaved editor changes."}</p>}
    {!path ? <div className="flex flex-1 flex-col items-center justify-center gap-2 p-5 text-center text-[12px] text-muted">
      <BookOpen className="size-8" />
      <p>{discovering ? "Looking for a README…" : discoverError ? `Couldn't read project documents: ${discoverError}` : "No root README found. Choose another Markdown document above."}</p>
    </div> : !current ? <p role="status" className="p-4 text-[12px] text-muted">Loading instructions…</p> : current.error ? <div className="flex flex-col items-start gap-3 p-4">
      <p role="alert" className="m-0 text-[12px] text-muted">{current.error}</p>
      <Button size="sm" onClick={() => setRevision((v) => v + 1)}><RefreshCw className="size-3.5" /> Retry</Button>
      {selected && <Button size="sm" onClick={() => updateWorkspace(projectId, { overviewDocument: null })}>Use project README</Button>}
    </div> : <MarkdownView key={path} projectId={projectId} path={path} text={current.text} tools className="min-h-0 flex-1 px-4 py-3" />}
  </>;
}
