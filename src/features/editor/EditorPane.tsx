import { useEffect, useReducer, useRef, useState, type ReactNode } from "react";
import { Code2, Columns2, Eye, FileCode2, X } from "lucide-react";
import { openFile, requestCloseFile } from "@/app/actions";
import { openConversation } from "@/features/chat/actions";
import { GitStatusReadout } from "@/features/git/BranchChip";
import { fileKey, get, set, useApp } from "@/app/store";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/form";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuTrigger } from "@/components/ui/menu";
import { errorKind, errorMessage } from "@/lib/ipc";
import { basename, cn } from "@/lib/utils";
import { MONACO_THEME } from "@/app/themePalettes";
import { monaco, languageLabel } from "./monaco";
import {
  ENCODINGS,
  cursorInfo,
  encodingLabel,
  getMeta,
  keepLocalChanges,
  loadFile,
  reloadFromDisk,
  reopenWithEncoding,
  saveFile,
  type FileError,
  type FileMeta,
} from "./models";
import { effectiveMdView, isMarkdownPath, type MdView } from "./markdown";
import { MarkdownPreview } from "./MarkdownPreview";

const MD_VIEWS = [
  { id: "code", label: "Code", Icon: Code2 },
  { id: "split", label: "Split", Icon: Columns2 },
  { id: "preview", label: "Preview", Icon: Eye },
] as const;

function setMdView(key: string, view: MdView) {
  set((s) => {
    const next = { ...s.mdView };
    if (view === "preview") delete next[key];
    else next[key] = view;
    return { mdView: next };
  });
}

export function EditorPane({ projectId }: { projectId: string }) {
  const openFiles = useApp((s) => s.workspaces[projectId]?.openFiles ?? []);
  const activeFile = useApp((s) => s.workspaces[projectId]?.activeFile ?? null);
  const dirty = useApp((s) => s.dirty);
  const prefs = useApp((s) => s.editorPrefs);
  const activeKey = activeFile ? fileKey(projectId, activeFile) : null;
  const savedView = useApp((s) => (activeKey ? s.mdView[activeKey] : undefined));
  const diskState = useApp((s) => (activeKey ? s.diskState[activeKey] : undefined));
  const aiBy = useApp((s) => (activeKey ? s.aiChanged[activeKey] : undefined));
  const [confirmLoad, setConfirmLoad] = useState(false);
  const [, rerender] = useReducer((n: number) => n + 1, 0);

  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const shownRef = useRef<string | null>(null);
  const [error, setError] = useState<FileError | null>(null);
  const [cursor, setCursor] = useState({ line: 1, col: 1, eol: "LF" });
  const [language, setLanguage] = useState("plaintext");
  const [loaded, setLoaded] = useState<string | null>(null);

  // One editor instance per pane; files swap models in and out.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const editor = monaco.editor.create(host, {
      model: null,
      // Monaco themes are global; app/appearance.ts switches all editors at once.
      theme: MONACO_THEME[get().themeKey],
      fontFamily: '"JetBrains Mono", ui-monospace, monospace',
      fontSize: prefs.fontSize,
      lineHeight: 21,
      minimap: { enabled: prefs.minimap },
      wordWrap: prefs.wordWrap ? "on" : "off",
      automaticLayout: true,
      scrollBeyondLastLine: false,
      renderLineHighlight: "all",
      padding: { top: 4 },
      fontLigatures: false,
      cursorSmoothCaretAnimation: "off",
      smoothScrolling: false,
      tabSize: 2,
      fixedOverflowWidgets: true,
      lineNumbersMinChars: 4,
      overviewRulerBorder: false,
    });
    editorRef.current = editor;
    const d = editor.onDidChangeCursorPosition(() => {
      const path = shownRef.current;
      setCursor(cursorInfo(path ? getMeta(projectId, path) : undefined, editor));
    });
    return () => {
      const path = shownRef.current;
      const meta = path ? getMeta(projectId, path) : undefined;
      if (meta) meta.viewState = editor.saveViewState();
      d.dispose();
      editor.dispose();
      editorRef.current = null;
      shownRef.current = null;
    };
    // Prefs are applied by the effect below; recreate only per project.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  useEffect(() => {
    editorRef.current?.updateOptions({
      fontSize: prefs.fontSize,
      minimap: { enabled: prefs.minimap },
      wordWrap: prefs.wordWrap ? "on" : "off",
    });
  }, [prefs]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const prev = shownRef.current;
    if (prev === activeFile) return;
    if (prev) {
      const meta = getMeta(projectId, prev);
      if (meta) meta.viewState = editor.saveViewState();
    }
    shownRef.current = activeFile;
    setError(null);
    setLoaded(null);
    if (!activeFile) {
      editor.setModel(null);
      return;
    }
    let cancelled = false;
    loadFile(projectId, activeFile)
      .then((meta) => !cancelled && attach(meta, true))
      .catch((e) => {
        if (cancelled) return;
        editor.setModel(null);
        setError({ kind: errorKind(e), message: errorMessage(e) });
      });
    return () => {
      cancelled = true;
    };
    // `attach` only touches refs and state setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, activeFile]);

  /** Show a loaded file, if it's still the one the pane wants. */
  function attach(meta: FileMeta, restore: boolean) {
    const editor = editorRef.current;
    if (!editor || shownRef.current !== meta.path) return;
    if (editor.getModel() !== meta.model) editor.setModel(meta.model);
    editor.updateOptions({ readOnly: meta.readOnly });
    if (restore && meta.viewState) editor.restoreViewState(meta.viewState);
    setError(null);
    setLanguage(meta.model.getLanguageId());
    setCursor(cursorInfo(meta, editor));
    setLoaded(meta.path);
    rerender();
    // A hidden editor must not take keystrokes.
    if (effectiveMdView(meta.path, get().mdView[meta.key]) !== "preview") editor.focus();
  }

  const reopen = async (encoding: string) => {
    if (!activeFile) return;
    try {
      const meta = await reopenWithEncoding(projectId, activeFile, encoding);
      if (meta) attach(meta, false);
    } catch (e) {
      setError({ kind: errorKind(e), message: errorMessage(e) });
    }
  };

  const meta = activeFile ? getMeta(projectId, activeFile) : undefined;
  const isDirty = activeFile ? !!dirty[fileKey(projectId, activeFile)] : false;
  const crumbs = activeFile ? activeFile.split("/") : [];
  const markdown = !!activeFile && isMarkdownPath(activeFile);
  const mdView: MdView = activeFile ? effectiveMdView(activeFile, savedView) : "code";
  const previewMeta = markdown && !error && loaded === activeFile ? meta : undefined;

  return (
    <section aria-label="Editor" className="hud flex min-w-0 flex-1 flex-col border border-line bg-surface">
      <div role="tablist" aria-label="Open files" className="flex h-9 shrink-0 items-stretch overflow-x-auto border-b border-line">
        {openFiles.map((path) => {
          const selected = path === activeFile;
          const fileDirty = !!dirty[fileKey(projectId, path)];
          return (
            <div
              key={path}
              className={cn(
                "group flex shrink-0 items-center border-r border-line",
                selected ? "bg-well shadow-[inset_0_2px_0_var(--color-accent)]" : "text-muted hover:text-fg",
              )}
            >
              <button
                role="tab"
                aria-selected={selected}
                title={path}
                onClick={() => openFile(projectId, path)}
                onAuxClick={(e) => e.button === 1 && requestCloseFile(projectId, path)}
                className="flex h-full items-center gap-2 border-0 bg-transparent pr-1 pl-3.5 text-[12.5px]"
              >
                {basename(path)}
                {fileDirty && (
                  <span aria-label="Unsaved changes" className="size-1.5 bg-warn hud:shadow-[0_0_6px_#FFB547]" />
                )}
              </button>
              <button
                aria-label={`Close ${basename(path)}`}
                onClick={() => requestCloseFile(projectId, path)}
                className={cn(
                  "mr-1.5 flex size-5 items-center justify-center border-0 bg-transparent text-muted hover:text-fg",
                  !selected && "opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
                )}
              >
                <X className="size-3" />
              </button>
            </div>
          );
        })}
      </div>

      <div className="flex h-7 shrink-0 items-center gap-1.5 overflow-hidden bg-well px-3.5 font-mono text-[11px] whitespace-nowrap text-muted">
        {crumbs.map((c, i) => (
          <span key={i} className="flex items-center gap-1.5">
            {i > 0 && <span className="text-accent">/</span>}
            <span className={i === crumbs.length - 1 ? "text-fg" : undefined}>{c}</span>
          </span>
        ))}
        {markdown && activeKey && (
          <div role="group" aria-label="Markdown view" className="ml-auto flex shrink-0 border border-line">
            {MD_VIEWS.map(({ id, label, Icon }) => {
              const on = mdView === id;
              return (
                <button
                  key={id}
                  aria-pressed={on}
                  title={`${label} view`}
                  onClick={() => setMdView(activeKey, id)}
                  className={cn(
                    "flex h-5 items-center gap-1 border-0 px-2 text-[10.5px] uppercase transition-colors duration-200",
                    on ? "bg-accent/10 text-accent hud:shadow-[inset_0_0_0_1px_rgb(77_163_255/0.45)]" : "bg-transparent text-muted hover:text-fg",
                  )}
                >
                  <Icon className="size-3" />
                  {label}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {activeFile && diskState && (
        <div
          role="status"
          className="flex shrink-0 items-center gap-3 border-b border-warn/40 bg-warn/8 px-3.5 py-1.5 text-[12.5px]"
        >
          <span className="font-mono text-[10.5px] text-warn">▲</span>
          <span className="min-w-0 flex-1 text-body">
            {diskState === "changed"
              ? aiBy
                ? `An agent changed ${basename(activeFile)} on disk while you have unsaved edits. Nothing has been overwritten.`
                : `${basename(activeFile)} changed on disk while you were editing it.`
              : `${basename(activeFile)} was deleted on disk. Saving creates it again.`}
          </span>
          {diskState === "changed" ? (
            <>
              <Button size="sm" variant="secondary" onClick={() => keepLocalChanges(projectId, activeFile)}>
                Keep my edits
              </Button>
              {confirmLoad ? (
                <Button
                  size="sm"
                  variant="danger"
                  onClick={() => {
                    setConfirmLoad(false);
                    void reloadFromDisk(projectId, activeFile);
                  }}
                >
                  Discard my edits & load
                </Button>
              ) : (
                <Button size="sm" variant="outline" onClick={() => setConfirmLoad(true)}>
                  {aiBy ? "Load agent version" : "Reload from disk"}
                </Button>
              )}
              {aiBy && (
                <button
                  type="button"
                  onClick={() => openConversation(aiBy)}
                  className="border-0 bg-transparent p-0 font-mono text-[10.5px] text-accent hover:text-accent-hover"
                >
                  OPEN CONVERSATION
                </button>
              )}
            </>
          ) : (
            <Button size="sm" variant="outline" onClick={() => requestCloseFile(projectId, activeFile)}>
              Close file
            </Button>
          )}
        </div>
      )}

      <div className="relative min-h-0 flex-1 bg-well">
        <div
          ref={hostRef}
          className={cn(
            "absolute inset-y-0 left-0",
            mdView === "split" ? "right-1/2" : "right-0",
            (!activeFile || error || mdView === "preview") && "invisible",
          )}
        />
        {previewMeta && mdView !== "code" && (
          <MarkdownPreview
            key={previewMeta.key}
            projectId={projectId}
            path={previewMeta.path}
            model={previewMeta.model}
            className={cn("absolute inset-y-0 right-0", mdView === "split" ? "left-1/2 border-l border-line" : "left-0")}
          />
        )}
        {!activeFile && (
          <div className="scan absolute inset-0 flex flex-col items-center justify-center gap-3 text-muted">
            <FileCode2 className="size-6 text-accent" />
            <span className="font-mono text-[11px]">SELECT A FILE IN THE EXPLORER</span>
            <span className="flex items-center gap-1.5 font-mono text-[10.5px]">
              <Kbd>CTRL K</Kbd> THEN <Kbd>@</Kbd> TO SEARCH FILES
            </span>
          </div>
        )}
        {activeFile && error && (
          <div className="scan absolute inset-0 flex flex-col items-center justify-center gap-2 p-6 text-center">
            <span className="font-mono text-[11px] text-warn">▲ CAN'T OPEN IN EDITOR</span>
            <span className="max-w-[420px] text-body">{error.message}</span>
            {(error.kind === "encoding" || error.kind === "binary") && (
              <EncodingMenu
                onPick={(id) => void reopen(id)}
                trigger={
                  <Button size="sm" className="mt-2">
                    Reopen with encoding…
                  </Button>
                }
              />
            )}
          </div>
        )}
      </div>

      <div className="flex h-[26px] shrink-0 items-center gap-4 border-t border-line px-3.5 font-mono text-[10.5px] text-muted">
        <GitStatusReadout projectId={projectId} />
        {isDirty ? (
          <button
            className="border-0 bg-transparent p-0 text-warn hover:brightness-110"
            onClick={() => activeFile && void saveFile(projectId, activeFile)}
            title="Save with Ctrl+S"
          >
            ● UNSAVED · CTRL S
          </button>
        ) : activeFile && meta ? (
          <span>SAVED</span>
        ) : null}
        {activeFile && meta && !error && meta.readOnly && (
          <span className="border border-line-strong px-1.5 text-body" title="Files over 5 MB open read-only">
            READ-ONLY
          </span>
        )}
        <span className="flex-1" />
        {activeFile && meta && !error && (
          <>
            <span>
              LN {cursor.line} COL {cursor.col}
            </span>
            <span>{languageLabel(language)}</span>
            <EncodingMenu
              current={meta.encoding}
              disabled={isDirty}
              onPick={(id) => void reopen(id)}
              trigger={
                <button
                  className="border-0 bg-transparent p-0 font-mono text-[10.5px] text-muted hover:text-fg"
                  title="Reopen with a different encoding"
                >
                  {encodingLabel(meta.encoding, meta.hasBom)}
                </button>
              }
            />
            <span>{cursor.eol}</span>
          </>
        )}
      </div>
    </section>
  );
}

function EncodingMenu({
  trigger,
  current,
  disabled,
  onPick,
}: {
  trigger: ReactNode;
  current?: string;
  disabled?: boolean;
  onPick: (id: string) => void;
}) {
  return (
    <Menu>
      <MenuTrigger asChild>{trigger}</MenuTrigger>
      <MenuContent side="top" align="end" width={280}>
        <MenuLabel>{disabled ? "Save or discard changes first" : "Reopen with encoding"}</MenuLabel>
        {ENCODINGS.map((e) => (
          <MenuItem
            key={e.id}
            disabled={disabled}
            hint={e.id === current ? "CURRENT" : undefined}
            onSelect={() => onPick(e.id)}
          >
            {e.label}
          </MenuItem>
        ))}
      </MenuContent>
    </Menu>
  );
}
