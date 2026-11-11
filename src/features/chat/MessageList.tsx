import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowDown } from "lucide-react";
import { useApp } from "@/app/store";
import type { ChatMessage, Conversation } from "@/lib/types";
import { AssistantMessage, UserMessage } from "./ChatMessage";
import { isGenerating, useChat } from "./store";

const EMPTY: ChatMessage[] = [];
/** Within this many px of the end counts as "at the bottom". */
const STICKY_PX = 48;
/** The skeleton shows only when loading takes longer than this. */
const SKELETON_AFTER_MS = 150;

/**
 * The transcript. Follows new text and activity while the user is at the
 * bottom; scrolling up pauses that and shows Jump to latest.
 */
export function MessageList({ conv }: { conv: Conversation }) {
  const messages = useChat((s) => s.messages[conv.id] ?? EMPTY);
  const loaded = useChat((s) => !!s.messages[conv.id]);
  const generating = useChat((s) => isGenerating(s, conv.id));
  const omitted = useChat((s) => s.omitted[conv.id] ?? 0);
  const cwd = useApp((s) => (conv.projectId ? (s.projects.find((p) => p.id === conv.projectId)?.path ?? null) : null));
  const scrollRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    if (loaded) return;
    const t = setTimeout(() => setSlow(true), SKELETON_AFTER_MS);
    return () => clearTimeout(t);
  }, [loaded]);

  const toBottom = useCallback((smooth = false) => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
    stick.current = true;
    setAtBottom(true);
  }, []);

  useLayoutEffect(() => {
    stick.current = true;
    toBottom();
  }, [conv.id, loaded, toBottom]);

  const last = messages[messages.length - 1];
  useLayoutEffect(() => {
    if (stick.current) toBottom();
  }, [messages.length, last?.content, last?.status, last?.items.length, last?.items, toBottom]);

  useEffect(() => {
    if (generating) toBottom();
  }, [generating, toBottom]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < STICKY_PX;
    stick.current = bottom;
    if (bottom !== atBottom) setAtBottom(bottom);
  };

  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");

  return (
    <div className="relative min-h-0 flex-1">
      <div ref={scrollRef} onScroll={onScroll} className="h-full overflow-y-auto px-7 pt-6 pb-3" role="log" aria-live="polite" aria-busy={generating}>
        <div className="mx-auto flex max-w-[760px] flex-col gap-5">
          {!loaded && slow && (
            <div aria-busy="true" aria-label="Loading conversation" className="flex flex-col gap-[18px]">
              <div className="flex justify-end">
                <div className="skel h-10 w-[46%]" />
              </div>
              <div className="flex gap-3.5">
                <div className="skel size-7 shrink-0" />
                <div className="flex flex-1 flex-col gap-2">
                  <div className="skel h-2.5 w-[90%]" />
                  <div className="skel h-2.5 w-[76%]" />
                  <div className="skel mt-1.5 h-16 w-full" />
                </div>
              </div>
              <span className="font-mono text-[10px] text-muted">RESTORING CONVERSATION…</span>
            </div>
          )}
          {conv.status === "interrupted" && loaded && (
            <p className="m-0 flex items-center gap-3 font-mono text-[10.5px] text-warn">
              <span className="h-px flex-1 bg-warn/30" />
              AGENTHUB CLOSED DURING THE LAST TURN · NOTHING RE-RAN
              <span className="h-px flex-1 bg-warn/30" />
            </p>
          )}
          {omitted > 0 && (
            <p className="m-0 flex items-center gap-3 font-mono text-[10px] text-muted">
              <span className="h-px flex-1 bg-line" />
              {omitted} EARLIER MESSAGE{omitted === 1 ? "" : "S"} NOT SENT WITH THE LAST QUESTION · CONTEXT LIMIT
              <span className="h-px flex-1 bg-line" />
            </p>
          )}
          {messages.map((m) => (
            <div key={m.id} className="rise">
              {m.role === "user" ? (
                <UserMessage message={m} />
              ) : (
                <AssistantMessage message={m} conv={conv} cwd={cwd} canRegenerate={!generating && m.id === lastAssistant?.id && m === last} />
              )}
            </div>
          ))}
        </div>
      </div>
      {!atBottom && (
        <button
          type="button"
          onClick={() => toBottom(true)}
          className="absolute bottom-3 left-1/2 flex h-7 -translate-x-1/2 items-center gap-1.5 border border-accent/50 bg-overlay/97 px-3 font-mono text-[10.5px] text-accent hud:shadow-[0_0_14px_rgba(77,163,255,0.2)] hover:text-accent-hover"
        >
          <ArrowDown className="size-3" />
          JUMP TO LATEST
        </button>
      )}
    </div>
  );
}
