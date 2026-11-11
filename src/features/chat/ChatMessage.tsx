import { memo, useState, type ReactNode } from "react";
import { AlertTriangle, Check, Copy, RotateCcw } from "lucide-react";
import { set as setApp } from "@/app/store";
import { BacklogContextChip, SavePlanButton } from "@/features/backlog/ChatLinks";
import type { ChatItem, ChatMessage as Message, Conversation } from "@/lib/types";
import { cn } from "@/lib/utils";
import { copyText, openAiSettings, recheckEngines, regenerate } from "./actions";
import { ChatMarkdown } from "./ChatMarkdown";
import {
  ActivityBlock,
  AttachmentChip,
  ImageAttachment,
  CommandCard,
  FileChangesCard,
  PermissionCard,
  PlanCard,
  SystemDivider,
  ThinkingBlock,
} from "./items";
import { clockTime, ENGINE_LABEL, errorTitle, isAgent, KEY_ERRORS, modelLabel, RUNTIME_ERRORS, usageLine, wordCount } from "./models";
import { setChat } from "./store";

export function HexMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={cn("fill-none stroke-accent", className)} strokeWidth={1.5}>
      <polygon points="12 2 21 7 21 17 12 22 3 17 3 7" />
      <circle cx="12" cy="12" r="3.5" />
    </svg>
  );
}

export function GeneratingDots({ className }: { className?: string }) {
  return (
    <span className="flex gap-[3px]" aria-hidden="true">
      <span className={cn("gen-dot size-1 bg-accent", className)} />
      <span className={cn("gen-dot size-1 bg-accent", className)} />
      <span className={cn("gen-dot size-1 bg-accent", className)} />
    </span>
  );
}

function ActionButton({ label, icon, onClick, children }: { label: string; icon: ReactNode; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="flex h-[26px] items-center gap-1.5 border-0 bg-transparent px-1.5 font-mono text-[10.5px] text-muted transition-colors duration-200 hover:text-fg"
    >
      {icon}
      {children}
    </button>
  );
}

function CopyAction({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <ActionButton
      label={label}
      icon={copied ? <Check className="icon-strong size-3.5 text-run" /> : <Copy className="size-3.5" />}
      onClick={() =>
        void copyText(text).then((ok) => {
          if (!ok) return;
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        })
      }
    >
      {copied ? <span className="text-run">COPIED</span> : "COPY"}
    </ActionButton>
  );
}

export const UserMessage = memo(function UserMessage({ message }: { message: Message }) {
  const attachments = message.items.filter((i) => i.body.kind === "attachment");
  const images = message.items.filter((i) => i.body.kind === "image");
  const context = message.items.find((i) => i.body.kind === "backlog_context");
  return (
    <div className="group flex flex-col items-end gap-1.5">
      {context?.body.kind === "backlog_context" && <BacklogContextChip label={context.body.label} text={context.body.text} />}
      {images.length > 0 && (
        <div className="flex flex-wrap justify-end gap-1.5">
          {images.map((i) => (
            <ImageAttachment key={i.id} item={i} />
          ))}
        </div>
      )}
      {attachments.length > 0 && (
        <div className="flex flex-wrap justify-end gap-1.5">
          {attachments.map((i) => (
            <AttachmentChip key={i.id} item={i} />
          ))}
        </div>
      )}
      <div className="flex items-start gap-1.5">
        <span className="opacity-0 transition-opacity duration-200 group-focus-within:opacity-100 group-hover:opacity-100">
          <CopyAction text={message.content} label="Copy message" />
        </span>
        <div className="max-w-[560px] border border-line bg-raised px-4 py-3 text-[14px] leading-[22px] break-words whitespace-pre-wrap select-text group-hover:border-dash">
          {message.content}
        </div>
      </div>
    </div>
  );
});

type Block =
  | { kind: "item"; item: ChatItem }
  | { kind: "activity"; items: ChatItem[] }
  | { kind: "changes"; items: ChatItem[] };

/** Groups consecutive tool rows into Activity blocks; file changes go to one card at the end. */
export function blocksOf(items: ChatItem[]): Block[] {
  const out: Block[] = [];
  const changes: ChatItem[] = [];
  for (const item of items) {
    if (item.body.kind === "file_change") {
      changes.push(item);
      continue;
    }
    if (item.body.kind === "attachment" || item.body.kind === "image" || item.body.kind === "backlog_context") continue;
    if (item.body.kind === "text" && !item.body.text.trim()) continue;
    const last = out[out.length - 1];
    if (item.body.kind === "tool") {
      if (last?.kind === "activity") last.items.push(item);
      else out.push({ kind: "activity", items: [item] });
    } else {
      out.push({ kind: "item", item });
    }
  }
  if (changes.length) out.push({ kind: "changes", items: changes });
  return out;
}

/**
 * One answer. `canRegenerate` is true only for the last answer of a chat that
 * isn't working; regenerate (and Retry) replace it, never add a second one.
 */
export const AssistantMessage = memo(function AssistantMessage({
  message,
  conv,
  canRegenerate,
  cwd,
}: {
  message: Message;
  conv: Conversation;
  canRegenerate: boolean;
  cwd: string | null;
}) {
  const streaming = message.status === "streaming";
  const err = message.error;
  const failed = message.status === "error" && !!err;
  const engine = message.engine ?? conv.engine;
  const agent = isAgent(engine);
  const retry = () => void regenerate(message.conversationId);
  const blocks = blocksOf(message.items);
  const hasItems = blocks.length > 0;
  const usage = usageLine(message.usage);

  return (
    <article aria-label={streaming ? "Assistant message, working" : "Assistant message"} aria-busy={streaming || undefined} className="flex gap-3.5">
      <span
        aria-hidden="true"
        className={cn(
          "flex size-7 shrink-0 items-center justify-center border",
          agent ? "border-agent/60" : "border-accent/60",
          streaming && (agent ? "live-glow border-agent" : "border-accent hud:shadow-[0_0_12px_rgba(77,163,255,0.35)]"),
          failed && !message.content && !hasItems && "border-danger/60",
        )}
      >
        <HexMark className={cn("size-4", agent && "stroke-agent")} />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-3 text-[14px] leading-[23px]">
        <div className="flex h-7 items-center gap-2.5">
          <span className={cn("font-display text-[12px] font-bold tracking-[0.14em] uppercase", agent ? "text-agent" : "text-accent")}>
            {ENGINE_LABEL[engine]}
          </span>
          {message.model && <span className="font-mono text-[10.5px] text-muted">{modelLabel(message.model)}</span>}
          {streaming ? (
            <span className="flex items-center gap-1.5 font-mono text-[10.5px] text-muted">
              {agent ? "WORKING" : "STREAMING"} <GeneratingDots className={agent ? "bg-agent" : undefined} />
            </span>
          ) : (
            <span className="font-mono text-[10.5px] text-muted">{clockTime(message.createdAt)}</span>
          )}
        </div>

        {streaming && !message.content && !hasItems && (
          <div className="flex flex-col gap-[7px] pt-1" aria-label="Waiting for the first words">
            <div className="skel h-[9px] w-[92%]" />
            <div className="skel h-[9px] w-[78%]" />
            <div className="skel h-[9px] w-[40%]" />
          </div>
        )}

        {hasItems
          ? blocks.map((b, i) => {
              if (b.kind === "activity") return <ActivityBlock key={b.items[0].id} items={b.items} />;
              if (b.kind === "changes") return <FileChangesCard key="changes" items={b.items} conv={conv} />;
              const it = b.item;
              const lastText = streaming && i === blocks.length - 1;
              switch (it.body.kind) {
                case "text":
                  return <ChatMarkdown key={it.id} text={it.body.text} streaming={lastText} />;
                case "thinking":
                  return <ThinkingBlock key={it.id} item={it} />;
                case "command":
                  return <CommandCard key={it.id} item={it} projectId={conv.projectId} />;
                case "permission":
                  return <PermissionCard key={it.id} item={it} conv={conv} cwd={cwd} />;
                case "plan":
                  return <PlanCard key={it.id} item={it} conv={conv} />;
                case "system":
                  return <SystemDivider key={it.id} item={it} />;
                case "error":
                  return (
                    <p key={it.id} role="alert" className="m-0 text-[12.5px] text-danger">
                      {it.body.error.message}
                    </p>
                  );
                default:
                  return null;
              }
            })
          : message.content && (
              <div className={cn(failed && "opacity-80")}>
                <ChatMarkdown text={message.content} streaming={streaming} />
              </div>
            )}

        {failed && !message.content && !hasItems && <ErrorCard message={message} conv={conv} onRetry={canRegenerate ? retry : undefined} />}

        {failed && (message.content || hasItems) && (
          <div role="alert" className="flex items-center gap-2.5 border border-danger/50 bg-danger/[0.06] px-2.5 py-2 text-[12px]">
            <AlertTriangle className="size-3.5 text-danger" />
            <span className="flex-1">
              {err.kind === "network" || err.kind === "interrupted" || err.kind === "timeout"
                ? `${agent ? "Stopped" : `Connection lost after ${wordCount(message.content)} words`}. ${err.message}`
                : err.message}
              {agent && " Changes made so far are kept."}
            </span>
            {canRegenerate && (
              <button
                type="button"
                onClick={retry}
                className="h-6 border border-line bg-transparent px-2 font-display text-[11px] font-bold tracking-[0.12em] uppercase hover:border-line-strong"
              >
                Retry
              </button>
            )}
          </div>
        )}

        {message.status === "complete" && err?.kind === "truncated" && (
          <p className="m-0 flex items-center gap-2 font-mono text-[10.5px] text-warn">
            <AlertTriangle className="size-3.5" />
            {err.message.toUpperCase()}
          </p>
        )}

        {!streaming && (message.status !== "error" || message.content || hasItems) && (
          <div className="-ml-1.5 flex items-center gap-0.5">
            {message.status === "stopped" && (
              <span className="mr-2 ml-1.5 flex items-center gap-2 font-mono text-[10.5px] text-muted">
                <span className="size-[7px] bg-muted" />
                STOPPED BY YOU{agent ? " · PARTIAL CHANGES KEPT" : ""}
              </span>
            )}
            {message.content && <CopyAction text={message.content} label="Copy answer" />}
            {message.content && conv.mode === "plan" && <SavePlanButton conv={conv} plan={() => message.content} compact />}
            {canRegenerate && !failed && (
              <ActionButton label="Regenerate answer" icon={<RotateCcw className="size-3.5" />} onClick={retry}>
                {agent ? "RUN AGAIN" : "REGENERATE"}
              </ActionButton>
            )}
            <span className="flex-1" />
            {usage && <span className="font-mono text-[10px] text-muted">{usage}</span>}
          </div>
        )}
      </div>
    </article>
  );
});

function ErrorCard({ message, conv, onRetry }: { message: Message; conv: Conversation; onRetry?: () => void }) {
  const err = message.error!;
  const keyProblem = KEY_ERRORS.includes(err.kind);
  const runtimeProblem = RUNTIME_ERRORS.includes(err.kind);
  const engine = message.engine ?? conv.engine;
  return (
    <div role="alert" className="hud hud-danger rise flex flex-col border border-danger/50 bg-danger/[0.05]">
      <div className="flex items-center gap-2.5 border-b border-danger/20 px-3.5 py-2.5">
        <AlertTriangle className="size-4 text-danger" />
        <span className="font-display text-[12px] font-bold tracking-[0.14em] text-danger uppercase">{errorTitle(engine, err)}</span>
        <span className="flex-1" />
        <span className="font-mono text-[10px] text-muted">MESSAGE KEPT</span>
      </div>
      <div className="flex flex-col gap-2.5 px-3.5 pt-3 pb-3.5">
        <span className="text-[13px] leading-5 text-fg">
          {err.message}
          {err.kind === "rate_limited" && err.retryAfter ? ` Try again in ${err.retryAfter} s.` : ""}
        </span>
        <div className="flex flex-wrap gap-1.5">
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="flex h-7 items-center gap-1.5 border border-line bg-accent/[0.06] px-2.5 font-display text-[12px] font-semibold tracking-[0.12em] uppercase hover:border-line-strong"
            >
              <RotateCcw className="size-[13px]" />
              Retry
            </button>
          )}
          {runtimeProblem && (
            <button
              type="button"
              onClick={() => void recheckEngines(engine)}
              className="h-7 border border-line bg-transparent px-2.5 font-display text-[12px] font-semibold tracking-[0.12em] uppercase hover:border-line-strong"
            >
              Recheck
            </button>
          )}
          {(keyProblem || runtimeProblem) && (
            <button
              type="button"
              onClick={openAiSettings}
              className="h-7 border border-line bg-transparent px-2.5 font-display text-[12px] font-semibold tracking-[0.12em] uppercase hover:border-line-strong"
            >
              AI integrations
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              setApp({ dialog: null });
              setChat({ menuOpen: true });
            }}
            className="h-7 border border-accent/50 bg-accent/12 px-2.5 font-display text-[12px] font-bold tracking-[0.12em] text-accent uppercase hover:bg-accent/20"
          >
            {isAgent(engine) ? "Other engine" : "Switch model"}
          </button>
        </div>
      </div>
    </div>
  );
}
