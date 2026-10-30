import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { AlertTriangle, ArrowUp, FileText, Shield, X } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { indexFor } from "@/features/palette/fileIndex";
import { ChatUsage } from "@/features/usage/UsagePanel";
import { cn, fuzzyMatch } from "@/lib/utils";
import { attachFile, composerConfig, cyclePolicy, detachFile, detachImage, engineInfo, openAiSettings, pasteImages, requestMode, sendMessage, setDraft, stopGenerating } from "./actions";
import { EngineMenu } from "./EngineMenu";
import { AGENT_MODES, formatBytes, isAgent, MODE_META, modeAvailability, POLICY_HINT, POLICY_LABEL } from "./models";
import { draftKey, isGenerating, useChat, type PendingImage } from "./store";
import { workspaceKey } from "./models";

const LINE = 22;
const MAX_LINES = 8;
const EMPTY: string[] = [];
const NO_IMAGES: PendingImage[] = [];

/**
 * Message input. Enter sends and Shift+Enter adds a line (or Ctrl+Enter, per
 * Settings › Chat); grows to 8 lines, then scrolls. Draft and attachments are
 * kept per chat. While a turn runs, Stop replaces Send.
 */
export function Composer({ projectId, hero = false }: { projectId: string | null; hero?: boolean }) {
  const cfg = useChat(useShallow((s) => composerConfig(s, projectId)));
  const ws = workspaceKey(projectId);
  const key = draftKey(ws, cfg.conversation?.id ?? null);
  const draft = useChat((s) => s.drafts[key] ?? "");
  const attachments = useChat((s) => s.attachments[key] ?? EMPTY);
  const images = useChat((s) => s.images[key] ?? NO_IMAGES);
  const generating = useChat((s) => isGenerating(s, cfg.conversation?.id ?? null));
  const sendKey = useChat((s) => s.prefs.sendKey);
  const error = useChat((s) => s.composerError);
  const info = useChat((s) => engineInfo(s, cfg.engine));
  const confirming = useChat((s) => !!s.modeConfirm);
  const ref = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, LINE * MAX_LINES + 18)}px`;
  }, [draft, hero]);

  useLayoutEffect(() => {
    ref.current?.focus();
  }, [cfg.conversation?.id]);

  const canSend = !generating && draft.trim().length > 0 && !confirming;
  const send = () => {
    if (canSend) void sendMessage(draft, projectId);
  };
  const agent = isAgent(cfg.engine);
  // A project chat made before Ask moved to General keeps showing its mode.
  const modes = cfg.mode === "ask" ? ["ask" as const, ...AGENT_MODES] : AGENT_MODES;
  const placeholder = generating
    ? "Working… you can type your next message"
    : cfg.mode === "agent"
      ? "Describe the change — the agent edits files with your approval"
      : cfg.mode === "plan"
        ? "What should the agent analyze and plan?"
        : "Ask anything";

  return (
    <div className={cn("flex w-full flex-col gap-2", hero && "max-w-[760px]")}>
      {error && (
        <div role="alert" className="flex items-start gap-2 border border-danger/45 bg-danger/[0.06] px-3 py-2 text-[12.5px]">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-danger" />
          <span className="flex-1">{error}</span>
          {/(Settings › AI integrations|API key|installed|signed in)/.test(error) && (
            <button type="button" onClick={openAiSettings} className="label-caps border-0 bg-transparent p-0 text-[11.5px] font-bold text-accent hover:text-accent-hover">
              Open →
            </button>
          )}
        </div>
      )}
      <div
        className={cn(
          "hud border bg-surface transition-[border-color] duration-200",
          cfg.mode === "agent" ? "border-agent/45" : cfg.mode === "plan" ? "border-plan/40" : "border-line focus-within:border-accent/60",
        )}
      >
        {(attachments.length > 0 || images.length > 0) && (
          <div className="flex flex-wrap gap-1.5 px-3 pt-2.5">
            {images.map((img) => (
              <span
                key={img.id}
                title={`${img.name} · ${formatBytes(img.size)} · sent with your message`}
                className="inline-flex h-[22px] items-center gap-1.5 border border-line pr-1 pl-0.5 font-mono text-[10.5px] text-accent-hover"
              >
                <img src={img.url} alt="" className="size-[18px] object-cover" />
                {img.name} · {formatBytes(img.size)}
                <button type="button" aria-label={`Remove ${img.name}`} onClick={() => detachImage(key, img.id)} className="flex border-0 bg-transparent p-0.5 text-muted hover:text-fg">
                  <X className="size-3" />
                </button>
              </span>
            ))}
            {attachments.map((p) => (
              <span key={p} className="inline-flex h-[22px] items-center gap-1.5 border border-line pr-1 pl-2 font-mono text-[10.5px] text-accent-hover">
                <FileText className="size-3" />
                {p}
                <button type="button" aria-label={`Remove ${p}`} onClick={() => detachFile(key, p)} className="flex border-0 bg-transparent p-0.5 text-muted hover:text-fg">
                  <X className="size-3" />
                </button>
              </span>
            ))}
          </div>
        )}
        <label htmlFor="chat-composer" className="sr-only">
          Message
        </label>
        <textarea
          id="chat-composer"
          ref={ref}
          rows={hero ? 2 : 1}
          value={draft}
          placeholder={placeholder}
          onChange={(e) => setDraft(key, e.target.value)}
          onPaste={(e) => {
            const files = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith("image/"));
            if (files.length === 0) return;
            // Keep any text that came with it (e.g. from a document); a bare image only attaches.
            if (!e.clipboardData.getData("text/plain")) e.preventDefault();
            void pasteImages(key, files, projectId);
          }}
          onKeyDown={(e) => {
            if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
            const sends = sendKey === "enter" ? !e.shiftKey && !e.ctrlKey : e.ctrlKey;
            if (sends) {
              e.preventDefault();
              send();
            }
          }}
          className="block w-full resize-none border-0 bg-transparent px-3.5 pt-3 pb-1 text-[14px] leading-[22px] outline-none placeholder:text-dim"
        />
        <div className="flex flex-wrap items-center gap-2 pt-1.5 pr-2.5 pb-2.5 pl-3">
          <EngineMenu projectId={projectId} />
          {/* General is always Ask, so it shows no mode picker. */}
          {projectId && (
            <div role="radiogroup" aria-label="Mode" className="flex border border-line">
              {modes.map((m, i) => {
                const avail = modeAvailability(cfg.engine, m, info, true);
                const sel = cfg.mode === m;
                const mm = MODE_META[m];
                return (
                  <button
                    key={m}
                    type="button"
                    role="radio"
                    aria-checked={sel}
                    aria-disabled={!avail.ok}
                    title={avail.ok ? mm.hint : avail.reason}
                    onClick={() => avail.ok && !sel && requestMode(m, projectId)}
                    className={cn(
                      "h-7 border-0 px-[11px] font-display text-[12px] font-bold tracking-[0.14em] uppercase transition-colors duration-200",
                      i > 0 && "border-l border-line",
                      sel ? "" : !avail.ok ? "cursor-not-allowed bg-transparent text-dim" : "bg-transparent text-muted hover:text-fg",
                    )}
                    style={sel ? { color: mm.color, background: `${mm.color}24`, boxShadow: `inset 0 -2px 0 ${mm.color}` } : undefined}
                  >
                    {mm.label}
                  </button>
                );
              })}
            </div>
          )}
          {agent && cfg.mode === "agent" && (
            <button
              type="button"
              onClick={() => void cyclePolicy(projectId)}
              title={`${POLICY_HINT[cfg.policy]} Click to change.`}
              className="flex h-7 max-w-[260px] items-center gap-1.5 border border-warn/40 bg-warn/[0.05] px-2 text-[11.5px] text-warn"
            >
              <Shield className="size-[13px] shrink-0" />
              <span className="truncate">{POLICY_LABEL[cfg.policy]}</span>
            </button>
          )}
          {projectId && <AttachButton projectId={projectId} draftKey={key} />}
          <span className="flex-1" />
          <ChatUsage engine={cfg.engine} conversationId={cfg.conversation?.id ?? null} />
          {generating && cfg.conversation ? (
            <button
              type="button"
              onClick={() => stopGenerating(cfg.conversation!.id)}
              title="Stop (Esc)"
              className="flex h-[30px] items-center gap-2 border border-danger/60 bg-danger/[0.08] px-3 font-display text-[12.5px] font-bold tracking-[0.14em] text-danger uppercase"
            >
              <span className="size-[9px] bg-danger" />
              Stop
            </button>
          ) : (
            <button
              type="button"
              aria-label="Send"
              title={`Send (${sendKey === "enter" ? "Enter" : "Ctrl Enter"})`}
              disabled={!canSend}
              onClick={send}
              className="chamfer flex h-[30px] w-[38px] items-center justify-center border-0 bg-accent text-on-accent transition-opacity duration-200 hover:bg-accent-hover disabled:opacity-40"
            >
              <ArrowUp className="icon-strong size-4" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** `@`: attach project files to the message (the only way files reach Ask mode). */
function AttachButton({ projectId, draftKey: key }: { projectId: string; draftKey: string }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [files, setFiles] = useState<string[]>([]);
  useEffect(() => {
    if (open) void indexFor(projectId).then(setFiles);
  }, [open, projectId]);
  const results = useMemo(() => {
    const q = query.trim();
    if (!q) return files.slice(0, 40);
    return files
      .map((f) => ({ f, m: fuzzyMatch(q, f) }))
      .filter((x) => x.m)
      .sort((a, b) => b.m!.score - a.m!.score)
      .slice(0, 40)
      .map((x) => x.f);
  }, [files, query]);
  return (
    <Popover.Root
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setQuery("");
      }}
    >
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label="Attach a project file (@)"
          title="Attach a project file (@)"
          className="flex size-7 items-center justify-center border border-line bg-transparent font-mono text-[13px] text-muted hover:border-line-strong hover:text-fg"
        >
          @
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="top"
          align="start"
          sideOffset={8}
          collisionPadding={12}
          className="hud z-50 w-[380px] border border-accent/45 bg-surface shadow-[0_18px_48px_rgba(0,0,0,0.6)] outline-none"
        >
          <div className="border-b border-line p-2">
            <label htmlFor="attach-q" className="sr-only">
              Search project files
            </label>
            <input
              id="attach-q"
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search files to attach"
              className="h-[30px] w-full border border-line bg-well px-2.5 text-[12px] outline-none placeholder:text-dim focus:border-accent"
            />
          </div>
          <div role="listbox" aria-label="Project files" className="max-h-[280px] overflow-y-auto p-1">
            {results.map((f) => (
              <button
                key={f}
                type="button"
                role="option"
                aria-selected={false}
                onClick={() => {
                  attachFile(key, f);
                  setOpen(false);
                }}
                className="flex w-full items-center gap-2 border-0 bg-transparent px-2 py-1.5 text-left font-mono text-[11.5px] text-term hover:bg-accent/10"
              >
                <FileText className="size-3 shrink-0 text-accent" />
                <span className="truncate">{f}</span>
              </button>
            ))}
            {results.length === 0 && <p className="m-0 px-2 py-2 text-[12px] text-muted">No matching files.</p>}
          </div>
          <p className="m-0 border-t border-line px-3 py-2 font-mono text-[10px] text-muted">THE FILE'S TEXT IS SENT WITH YOUR MESSAGE · UP TO 8 FILES · PASTE IMAGES WITH CTRL V</p>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
