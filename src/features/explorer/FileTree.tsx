import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import {
  ChevronDown,
  ChevronRight,
  ClipboardCopy,
  File,
  FilePlus,
  FolderOpen,
  FolderPlus,
  PanelLeftClose,
  Pencil,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { createEntry, openFile, renameEntry, requestDeleteEntry, toggleDir } from "@/app/actions";
import { fileKey, toast, updateWorkspace, useApp } from "@/app/store";
import { IconButton } from "@/components/ui/button";
import { SectionLabel } from "@/components/ui/form";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/menu";
import { GitStatusLetter, useTreeLetters } from "@/features/git/treeLetters";
import { SidebarSwitch } from "@/features/git/SourceControl";
import { errorMessage, ipc } from "@/lib/ipc";
import type { DirEntry } from "@/lib/types";
import { basename, cn, dirname, joinPath } from "@/lib/utils";
import { onFsChange } from "./fsEvents";

const CODE_EXT = /\.(tsx?|jsx?|mjs|cjs|rs|py|go|java|kt|cs|cpp|cc|c|h|hpp|swift|rb|php|lua|sh|ps1|vue|svelte|css|scss|html?)$/i;
const DATA_EXT = /\.(json|jsonc|toml|ya?ml|lock|ini|env|xml)$/i;

function fileTone(name: string) {
  if (CODE_EXT.test(name)) return "text-accent";
  if (DATA_EXT.test(name)) return "text-warn";
  return "text-muted";
}

type Listing = { entries: DirEntry[] } | { error: string };
type Target = { path: string; isDir: boolean };
type Editing = { kind: "create"; parent: string; isDir: boolean } | { kind: "rename"; path: string };

export function FileTree({ projectId, width }: { projectId: string; width: number }) {
  const expanded = useApp((s) => s.workspaces[projectId]?.expandedDirs ?? []);
  const activeFile = useApp((s) => s.workspaces[projectId]?.activeFile ?? null);
  const root = useApp((s) => s.projects.find((p) => p.id === projectId)?.path ?? "");
  const dirty = useApp((s) => s.dirty);
  const aiChanged = useApp((s) => s.aiChanged);
  const letters = useTreeLetters(projectId);
  const [dirs, setDirs] = useState<Record<string, Listing>>({});
  const [target, setTarget] = useState<Target>({ path: "", isDir: true });
  const [editing, setEditing] = useState<Editing | null>(null);
  const dirsRef = useRef(dirs);
  dirsRef.current = dirs;

  const load = useCallback(
    async (dir: string) => {
      try {
        const entries = await ipc.listDir(projectId, dir);
        setDirs((d) => ({ ...d, [dir]: { entries } }));
      } catch (e) {
        setDirs((d) => ({ ...d, [dir]: { error: errorMessage(e) } }));
      }
    },
    [projectId],
  );

  useEffect(() => {
    setDirs({});
    setEditing(null);
  }, [projectId]);

  useEffect(() => {
    for (const dir of ["", ...expanded]) if (!dirs[dir]) void load(dir);
  }, [expanded, dirs, load]);

  // Reload only the loaded folders a change touches.
  useEffect(
    () =>
      onFsChange((change) => {
        if (change.projectId !== projectId) return;
        const loaded = Object.keys(dirsRef.current);
        const affected = change.overflow
          ? loaded
          : loaded.filter((d) => change.paths.some((p) => dirname(p) === d || p === d));
        for (const d of new Set(affected)) void load(d);
      }),
    [projectId, load],
  );

  const refresh = () => {
    for (const dir of Object.keys(dirs)) void load(dir);
  };

  const startCreate = (parent: string, isDir: boolean) => {
    if (parent && !expanded.includes(parent)) toggleDir(projectId, parent);
    setEditing({ kind: "create", parent, isDir });
  };

  const commit = async (value: string) => {
    const edit = editing;
    setEditing(null);
    const name = value.trim();
    if (!edit || !name) return;
    if (edit.kind === "create") await createEntry(projectId, edit.parent, name, edit.isDir);
    else if (name !== basename(edit.path)) await renameEntry(projectId, edit.path, name);
  };

  const copy = (text: string) =>
    void navigator.clipboard.writeText(text).then(
      () => toast(`Copied ${text}`),
      () => toast("Couldn't copy to the clipboard", "danger"),
    );

  const targetFrom = (el: EventTarget | null): Target => {
    const row = (el as HTMLElement | null)?.closest?.<HTMLElement>("[data-entry-path]");
    return row ? { path: row.dataset.entryPath!, isDir: row.dataset.entryDir === "true" } : { path: "", isDir: true };
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement).tagName === "INPUT") return;
    const t = targetFrom(e.target);
    if (!t.path) return;
    if (e.key === "F2") {
      e.preventDefault();
      setEditing({ kind: "rename", path: t.path });
    } else if (e.key === "Delete") {
      e.preventDefault();
      requestDeleteEntry(projectId, t.path, t.isDir);
    }
  };

  const editRow = (depth: number, initial: string, isDir: boolean) => (
    <NameInput
      key="__edit"
      depth={depth}
      isDir={isDir}
      initial={initial}
      onCommit={(v) => void commit(v)}
      onCancel={() => setEditing(null)}
    />
  );

  const renderDir = (dir: string, depth: number): React.ReactNode => {
    const listing = dirs[dir];
    const creating = editing?.kind === "create" && editing.parent === dir ? editRow(depth, "", editing.isDir) : null;
    if (!listing) return <Row depth={depth} muted>Loading…</Row>;
    if ("error" in listing)
      return (
        <Row depth={depth} muted>
          <span className="text-danger-soft">{listing.error}</span>
        </Row>
      );
    if (listing.entries.length === 0 && depth > 0 && !creating) return <Row depth={depth} muted>Empty</Row>;
    return [
      creating,
      ...listing.entries.map((e) => {
        if (editing?.kind === "rename" && editing.path === e.path) return editRow(depth, e.name, e.isDir);
        if (e.isDir) {
          const open = expanded.includes(e.path);
          const Chevron = open ? ChevronDown : ChevronRight;
          return (
            <div key={e.path} role="treeitem" aria-expanded={open} aria-selected={false}>
              <button
                data-entry-path={e.path}
                data-entry-dir="true"
                onClick={() => toggleDir(projectId, e.path)}
                style={{ paddingLeft: 4 + depth * 16 }}
                className={cn(
                  "flex h-[26px] w-full items-center gap-1.5 border-0 bg-transparent pr-2 text-left hover:bg-accent/5",
                  target.path === e.path && "bg-accent/5",
                  !open && "text-term",
                )}
              >
                <Chevron className="size-[13px] shrink-0 text-muted" />
                <span className="truncate">{e.name}</span>
              </button>
              {open && <div role="group">{renderDir(e.path, depth + 1)}</div>}
            </div>
          );
        }
        const active = e.path === activeFile;
        const isDirty = !!dirty[fileKey(projectId, e.path)];
        const byAgent = !!aiChanged[fileKey(projectId, e.path)];
        return (
          <button
            key={e.path}
            role="treeitem"
            aria-selected={active}
            data-entry-path={e.path}
            data-entry-dir="false"
            onClick={() => openFile(projectId, e.path)}
            title={e.path}
            style={{ paddingLeft: 23 + depth * 16 }}
            className={cn(
              "flex h-[26px] w-full items-center gap-1.5 border-0 pr-2 text-left",
              active ? "bg-accent/10 hud:shadow-[inset_0_0_0_1px_rgba(77,163,255,0.35)]" : "bg-transparent text-term hover:bg-accent/5",
            )}
          >
            <File className={cn("size-[13px] shrink-0", fileTone(e.name))} />
            <span className="min-w-0 flex-1 truncate">{e.name}</span>
            {byAgent && (
              <span className="border border-agent/50 px-1 font-mono text-[9.5px] text-agent" title="Changed by an agent in this session">
                AI
              </span>
            )}
            {isDirty && (
              <span className="font-mono text-[11px] text-warn" title="Unsaved changes">
                ●
              </span>
            )}
            <GitStatusLetter letter={letters[e.path]} />
          </button>
        );
      }),
    ];
  };

  const here = target.isDir ? target.path : dirname(target.path);

  return (
    <section aria-label="Files" style={{ width }} className="hud flex shrink-0 flex-col border border-line bg-surface">
      <SidebarSwitch projectId={projectId} />
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-line pr-2 pl-3">
        <SectionLabel index="01">Files</SectionLabel>
        <div className="flex">
          <IconButton aria-label="New file" size={24} onClick={() => startCreate("", false)}>
            <FilePlus className="size-3.5" />
          </IconButton>
          <IconButton aria-label="New folder" size={24} onClick={() => startCreate("", true)}>
            <FolderPlus className="size-3.5" />
          </IconButton>
          <IconButton aria-label="Refresh files" size={24} onClick={refresh}>
            <RefreshCw className="size-3.5" />
          </IconButton>
          <IconButton
            aria-label="Collapse files panel"
            size={24}
            onClick={() => updateWorkspace(projectId, { filesCollapsed: true })}
          >
            <PanelLeftClose className="size-3.5" />
          </IconButton>
        </div>
      </div>
      <ContextMenu onOpenChange={(open) => !open && setTarget({ path: "", isDir: true })}>
        <ContextMenuTrigger asChild>
          <div
            role="tree"
            aria-label="Project files"
            onContextMenu={(e: MouseEvent) => setTarget(targetFrom(e.target))}
            onKeyDown={onKeyDown}
            className="min-h-0 flex-1 overflow-auto p-1.5 text-[12.5px]"
          >
            {renderDir("", 0)}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuLabel>{target.path ? basename(target.path) : "Project root"}</ContextMenuLabel>
          <ContextMenuItem icon={<FilePlus className="size-4" />} onSelect={() => startCreate(here, false)}>
            New file
          </ContextMenuItem>
          <ContextMenuItem icon={<FolderPlus className="size-4" />} onSelect={() => startCreate(here, true)}>
            New folder
          </ContextMenuItem>
          {target.path && (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem
                icon={<Pencil className="size-4" />}
                hint="F2"
                onSelect={() => setEditing({ kind: "rename", path: target.path })}
              >
                Rename
              </ContextMenuItem>
              <ContextMenuItem
                icon={<Trash2 className="size-4" />}
                hint="DEL"
                danger
                onSelect={() => requestDeleteEntry(projectId, target.path, target.isDir)}
              >
                Delete
              </ContextMenuItem>
            </>
          )}
          <ContextMenuSeparator />
          <ContextMenuItem icon={<ClipboardCopy className="size-4" />} onSelect={() => copy(joinPath(root, target.path))}>
            Copy path
          </ContextMenuItem>
          {target.path && (
            <ContextMenuItem icon={<ClipboardCopy className="size-4" />} onSelect={() => copy(target.path)}>
              Copy relative path
            </ContextMenuItem>
          )}
          <ContextMenuItem
            icon={<FolderOpen className="size-4" />}
            onSelect={() =>
              void revealItemInDir(joinPath(root, target.path)).catch((e) => toast(errorMessage(e), "danger"))
            }
          >
            Reveal in Explorer
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </section>
  );
}

/** Inline name field for creating or renaming. Enter commits, Esc cancels, blur commits. */
function NameInput({
  depth,
  isDir,
  initial,
  onCommit,
  onCancel,
}: {
  depth: number;
  isDir: boolean;
  initial: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  const mountedAt = useRef(performance.now());
  useEffect(() => {
    const input = ref.current;
    if (!input) return;
    // Select the name without its extension, like most file managers. Again on
    // the next frame, after a closing menu has settled focus.
    const dot = isDir ? -1 : initial.lastIndexOf(".");
    const select = () => {
      input.focus();
      input.setSelectionRange(0, dot > 0 ? dot : initial.length);
    };
    select();
    const raf = requestAnimationFrame(select);
    return () => cancelAnimationFrame(raf);
  }, [initial, isDir]);
  const finish = (commit: boolean) => {
    if (done.current) return;
    done.current = true;
    if (commit) onCommit(ref.current?.value ?? "");
    else onCancel();
  };
  return (
    <div style={{ paddingLeft: (isDir ? 4 : 23) + depth * 16 }} className="flex h-[26px] items-center gap-1.5 pr-2">
      {isDir ? (
        <ChevronRight className="size-[13px] shrink-0 text-muted" />
      ) : (
        <File className="size-[13px] shrink-0 text-muted" />
      )}
      <input
        ref={ref}
        defaultValue={initial}
        aria-label={initial ? `New name for ${initial}` : isDir ? "New folder name" : "New file name"}
        spellCheck={false}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            finish(true);
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            finish(false);
          }
        }}
        onBlur={() => {
          // A menu that just closed can steal focus once; take it back.
          if (performance.now() - mountedAt.current < 250) ref.current?.focus();
          else finish(true);
        }}
        className="h-[22px] min-w-0 flex-1 border border-accent/60 bg-well px-1.5 font-sans text-[12.5px] text-fg hud:shadow-[0_0_8px_rgba(77,163,255,0.25)] outline-none"
      />
    </div>
  );
}

function Row({ depth, muted, children }: { depth: number; muted?: boolean; children: React.ReactNode }) {
  return (
    <div style={{ paddingLeft: 23 + depth * 16 }} className={cn("flex h-[26px] items-center truncate", muted && "text-muted")}>
      {children}
    </div>
  );
}
