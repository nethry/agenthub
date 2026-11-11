// Renderers for agent activity items. Everything here is a typed domain item
// (`ChatItem`), never raw protocol output; command output is untrusted text.
import { memo, useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, ChevronRight, FileText, Lock, Play, Shield } from "lucide-react";
import { openFile, prefillTerminal } from "@/app/actions";
import { Button } from "@/components/ui/button";
import { SavePlanButton } from "@/features/backlog/ChatLinks";
import type { ChatItem, Conversation, Decision, ItemBody, PermissionRequest, PlanStep, ToolKind } from "@/lib/types";
import { ipc } from "@/lib/ipc";
import { basename, cn, dirname } from "@/lib/utils";
import { copyText, implementPlan, openChange, planMarkdown, respondApproval, setDraft } from "./actions";
import { ChatMarkdown } from "./ChatMarkdown";
import { CHIP, ENGINE_LABEL, formatBytes, modeAvailability, POLICY_LABEL } from "./models";
import { draftKey, useChat } from "./store";

type Body<K extends ItemBody["kind"]> = Extract<ItemBody, { kind: K }>;

const TOOL_LABEL: Record<ToolKind, { label: string; color: string }> = {
  read: { label: "READ", color: "text-accent" },
  search: { label: "SEARCH", color: "text-accent" },
  edit: { label: "EDIT", color: "text-agent" },
  delete: { label: "DELETE", color: "text-danger" },
  move: { label: "MOVE", color: "text-agent" },
  run: { label: "RUN", color: "text-accent" },
  think: { label: "THINK", color: "text-plan" },
  fetch: { label: "FETCH", color: "text-warn" },
  mcp: { label: "MCP", color: "text-tag" },
  other: { label: "TOOL", color: "text-muted" },
};

/** Strips ANSI/VT escape sequences from terminal-ish output before showing it as text. */
export function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g, "");
}

export function Chip({ kind, small }: { kind: keyof typeof CHIP; small?: boolean }) {
  const c = CHIP[kind];
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-chip border font-display font-bold tracking-[0.14em] whitespace-nowrap uppercase",
        // Graphite: a subtle filled badge instead of the bordered HUD chip.
        "graphite:border-transparent! graphite:bg-[color-mix(in_srgb,currentColor_14%,transparent)] graphite:font-semibold",
        small ? "h-4 px-1 text-[9.5px]" : "h-5 px-1.5 text-[11px]",
        c.live && "live-glow",
      )}
      style={{ borderColor: c.border, color: c.color }}
    >
      {c.label}
    </span>
  );
}

// ---------- tool rows ----------

export function ToolRow({ item }: { item: ChatItem }) {
  const b = item.body as Body<"tool">;
  const t = TOOL_LABEL[b.tool];
  const failed = item.status === "failed" || item.status === "declined";
  return (
    <div className="flex items-center gap-2.5 px-2.5 py-[5px] font-mono text-[11.5px] leading-[18px]">
      <span className={cn("w-[52px] shrink-0", failed ? "text-danger" : t.color)}>{t.label}</span>
      <span className={cn("min-w-0 flex-1 truncate", failed ? "text-muted line-through" : "text-term")} title={b.title}>
        {b.title}
      </span>
      {item.status === "running" ? (
        <span className="text-muted">…</span>
      ) : (
        (b.result || b.detail) && <span className="max-w-[40%] shrink-0 truncate text-muted uppercase">{b.result ?? b.detail}</span>
      )}
    </div>
  );
}

/** Consecutive tool rows, shown as one Activity block. */
export function ActivityBlock({ items }: { items: ChatItem[] }) {
  const running = items.some((i) => i.status === "running");
  return (
    <div className="border border-line-dim bg-well/60">
      <div className="flex items-center gap-2.5 border-b border-line-dim px-2.5 py-[7px]">
        <span className="label-caps text-[10.5px] text-muted">Activity</span>
        <span className="flex-1" />
        <span className="font-mono text-[10px] text-muted">
          {items.length} STEP{items.length === 1 ? "" : "S"}
          {running ? " · RUNNING" : ""}
        </span>
      </div>
      <div className="flex flex-col py-0.5">
        {items.map((i) => (
          <ToolRow key={i.id} item={i} />
        ))}
      </div>
    </div>
  );
}

// ---------- commands ----------

export const CommandCard = memo(function CommandCard({ item, projectId }: { item: ChatItem; projectId: string | null }) {
  const b = item.body as Body<"command">;
  const running = item.status === "running";
  const [open, setOpen] = useState(false);
  const failed = item.status === "failed" || (b.exitCode != null && b.exitCode !== 0);
  const declined = item.status === "declined" || item.status === "cancelled";
  const output = stripAnsi(b.output);
  return (
    <div className="border border-line bg-well">
      <div className="flex items-center gap-2 border-b border-line-dim pr-1.5">
        <button
          type="button"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          className="flex h-[34px] min-w-0 flex-1 items-center gap-2.5 border-0 bg-transparent px-2.5 text-left font-mono text-[12px]"
        >
          <ChevronRight className={cn("size-[13px] shrink-0 text-muted transition-transform duration-200", open && "rotate-90")} />
          <span className="text-muted">$</span>
          <span className="min-w-0 truncate text-fg" title={b.command}>
            {b.command}
          </span>
          <span className="flex-1" />
          {running ? (
            <Chip kind="running" small />
          ) : declined ? (
            <span className="font-mono text-[10px] text-muted">DENIED</span>
          ) : (
            <span
              className={cn("inline-flex h-[18px] items-center border px-1.5 font-display text-[10px] font-bold tracking-[0.14em] uppercase", failed ? "border-danger/55 text-danger" : "border-run/50 text-run")}
            >
              {failed ? `Exit ${b.exitCode ?? "?"}` : "Passed"}
            </span>
          )}
          {b.durationMs != null && <span className="text-[10.5px] text-muted">{(b.durationMs / 1000).toFixed(1)} S</span>}
        </button>
        {projectId && (
          <button
            type="button"
            title="Open a terminal with this command typed in (not run)"
            onClick={() => void prefillTerminal(projectId, b.command)}
            className="border-0 bg-transparent px-1.5 font-mono text-[10.5px] text-accent hover:text-accent-hover"
          >
            OPEN IN TERMINAL
          </button>
        )}
      </div>
      {open && (
        <pre className="m-0 max-h-[320px] overflow-auto px-3 py-2.5 font-mono text-[11.5px] leading-[18px] whitespace-pre-wrap text-term select-text">
          {output || (running ? "Waiting for output…" : "No output.")}
        </pre>
      )}
    </div>
  );
});

// ---------- approvals ----------

const KIND_TITLE: Record<PermissionRequest["kind"], string> = {
  read: "read a file",
  write: "change files",
  delete: "delete files",
  command: "run a command",
  network: "use the network",
  mcp: "call an MCP tool",
  other: "use a tool",
};

const DECISION_LABEL: Record<Decision, string> = {
  allow_once: "APPROVED ONCE",
  allow_session: "ALLOWED FOR THIS SESSION",
  deny: "DENIED",
  cancel: "CANCELLED",
};

export const PermissionCard = memo(function PermissionCard({ item, conv, cwd }: { item: ChatItem; conv: Conversation; cwd: string | null }) {
  const b = item.body as Body<"permission">;
  const r = b.request;
  const pending = item.status === "pending" && !b.decision;
  const ref = useRef<HTMLDivElement>(null);
  // Approvals take focus (role=alertdialog).
  useEffect(() => {
    if (pending) ref.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, [pending]);

  if (!pending) {
    const allowed = b.decision === "allow_once" || b.decision === "allow_session";
    return (
      <div
        className={cn("flex items-center gap-2.5 font-mono text-[10.5px]", allowed ? "text-muted" : "text-danger")}
        title={b.reason ?? undefined}
      >
        <Shield className="size-3.5 shrink-0" />
        <span className="min-w-0 truncate">
          {b.decision ? DECISION_LABEL[b.decision] : "EXPIRED"}
          {b.auto ? " · BY POLICY" : ""} · {r.command ?? r.title}
        </span>
        {b.auto && b.reason && <span className="hidden shrink-0 text-muted xl:inline">({b.reason.toUpperCase()})</span>}
      </div>
    );
  }

  const answer = (d: Decision) => void respondApproval(item.id, d);
  const paths = [r.path, ...r.paths].filter((p, i, a): p is string => !!p && a.indexOf(p) === i);
  return (
    <div
      ref={ref}
      role="alertdialog"
      aria-label="Permission required"
      className="hud hud-warn rise border border-warn/55 bg-warn/[0.05] hud:shadow-[0_0_24px_rgba(255,181,71,0.08)]"
    >
      <div className="flex items-center gap-2.5 border-b border-warn/20 px-3.5 py-2.5">
        <Shield className="size-4 text-warn" />
        <span className="label-caps text-[11.5px] text-warn">Permission required</span>
        <span className="flex-1" />
        <span className="font-mono text-[10px] text-muted">POLICY · {POLICY_LABEL[conv.policy].toUpperCase()}</span>
      </div>
      <div className="flex flex-col gap-2.5 px-3.5 pt-3 pb-3.5">
        <span className="text-[13.5px]">
          {ENGINE_LABEL[conv.engine]} wants to {KIND_TITLE[r.kind]}
          {cwd && (
            <>
              {" "}in <span className="border border-line bg-raised px-1 font-mono text-[12px] text-accent-hover">{cwd}</span>
            </>
          )}
        </span>
        {r.command ? (
          <div className="border border-line bg-well px-3 py-2 font-mono text-[12.5px] break-all text-fg">
            <span className="text-muted">$</span> {r.command}
          </div>
        ) : (
          <div className="border border-line bg-well px-3 py-2 font-mono text-[12px] text-fg">{r.title}</div>
        )}
        {paths.length > 0 && (
          <div className="flex flex-col gap-0.5 font-mono text-[11px] text-term">
            {paths.slice(0, 6).map((p) => (
              <span key={p} className="truncate" title={p}>
                {p}
              </span>
            ))}
            {paths.length > 6 && <span className="text-muted">+{paths.length - 6} MORE</span>}
          </div>
        )}
        {r.detail && <span className="font-mono text-[10.5px] text-muted uppercase">{r.detail}</span>}
        <div className="mt-0.5 flex flex-wrap items-center gap-2">
          <Button variant="primary" size="sm" onClick={() => answer("allow_once")}>
            Approve once
          </Button>
          {r.canAllowSession && (
            <Button size="sm" onClick={() => answer("allow_session")}>
              Allow for this session
            </Button>
          )}
          <Button size="sm" variant="outline" className="border-danger/55 text-danger" onClick={() => answer("deny")}>
            Deny
          </Button>
          <Button size="sm" variant="ghost" onClick={() => answer("cancel")}>
            Cancel task
          </Button>
          <span className="flex-1" />
          {r.kind === "command" && r.command && conv.projectId && (
            <button
              type="button"
              onClick={() => {
                answer("deny");
                void prefillTerminal(conv.projectId!, r.command!);
              }}
              className="border-0 bg-transparent p-0 font-mono text-[10.5px] text-accent hover:text-accent-hover"
            >
              RUN IT YOURSELF IN A TERMINAL →
            </button>
          )}
        </div>
      </div>
    </div>
  );
});

// ---------- plans ----------

export function PlanCard({ item, conv }: { item: ChatItem; conv: Conversation }) {
  const b = item.body as Body<"plan">;
  const engines = useChat((s) => s.engines);
  const canAgent =
    conv.mode === "plan" && modeAvailability(conv.engine, "agent", engines.find((e) => e.engine === conv.engine), !!conv.projectId).ok;
  return <PlanView steps={b.steps} explanation={b.explanation} conv={conv} canImplement={canAgent} />;
}

export function PlanView({ steps, explanation, conv, canImplement }: { steps: PlanStep[]; explanation: string | null; conv: Conversation; canImplement: boolean }) {
  const [copied, setCopied] = useState(false);
  const done = steps.filter((s) => s.status === "completed").length;
  return (
    <section aria-label="Plan" className="hud hud-plan border border-plan/45 bg-plan/[0.04]">
      <div className="flex items-center gap-2.5 border-b border-plan/20 px-3.5 py-3">
        <span className="inline-flex h-5 items-center border border-plan/60 px-1.5 font-display text-[11px] font-bold tracking-[0.14em] text-plan uppercase">
          Plan
        </span>
        <span className="font-semibold">{explanation?.split("\n")[0]?.slice(0, 90) || "Plan"}</span>
        <span className="flex-1" />
        <span className="font-mono text-[10.5px] text-muted">
          {steps.length} STEP{steps.length === 1 ? "" : "S"}
          {done ? ` · ${done} DONE` : ""}
        </span>
      </div>
      <ol className="m-0 flex list-none flex-col gap-3 px-3.5 pt-3 pb-1 text-[13px] leading-5">
        {steps.map((s, i) => (
          <li key={i} className="flex gap-3">
            <span
              className={cn(
                "flex size-[22px] shrink-0 items-center justify-center border font-mono text-[11px]",
                s.status === "completed" ? "border-run/50 text-run" : s.status === "in_progress" ? "border-agent/60 text-agent" : "border-plan/50 text-plan",
              )}
            >
              {s.status === "completed" ? <Check className="size-3" /> : i + 1}
            </span>
            <span className={cn(s.status === "completed" ? "text-muted line-through" : "text-body")}>{s.text}</span>
          </li>
        ))}
      </ol>
      <div className="flex flex-wrap gap-2 p-3.5">
        {canImplement && (
          <Button variant="primary" size="sm" onClick={() => implementPlan(conv.projectId)}>
            <Play className="size-3.5 fill-current" />
            Implement in Agent mode
          </Button>
        )}
        <Button
          size="sm"
          onClick={() =>
            void copyText(planMarkdown(steps, explanation)).then((ok) => {
              if (ok) {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }
            })
          }
        >
          {copied ? "Copied" : "Copy as Markdown"}
        </Button>
        <SavePlanButton conv={conv} plan={() => planMarkdown(steps, explanation)} />
        <Button
          size="sm"
          onClick={() => {
            const key = draftKey(conv.projectId ?? "general", conv.id);
            setDraft(key, "Revise the plan: ");
            requestAnimationFrame(() => document.getElementById("chat-composer")?.focus());
          }}
        >
          Revise plan
        </Button>
      </div>
    </section>
  );
}

// ---------- file changes ----------

export function FileChangesCard({ items, conv }: { items: ChatItem[]; conv: Conversation }) {
  return (
    <div className="border border-line bg-surface">
      <div className="flex items-center gap-2.5 border-b border-line-dim px-2.5 py-2">
        <span className="label-caps text-[10.5px] text-muted">
          Changes · {items.length} file{items.length === 1 ? "" : "s"}
        </span>
        <span className="flex-1" />
        <Button size="sm" onClick={() => openChange(items[0].id)}>
          Review
        </Button>
      </div>
      {items.map((i) => (
        <FileChangeRow key={i.id} item={i} conv={conv} />
      ))}
    </div>
  );
}

export function FileChangeRow({ item, conv }: { item: ChatItem; conv: Conversation }) {
  const b = item.body as Body<"file_change">;
  const reverted = b.state === "reverted";
  return (
    <div className="flex items-center gap-2.5 px-2.5 py-1.5 text-[12.5px] hover:bg-accent/5">
      <FileText className={cn("size-[13px] shrink-0", reverted ? "text-muted" : "text-agent")} />
      <span className={cn("shrink-0", reverted && "text-muted line-through")}>{basename(b.path)}</span>
      <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-muted">{dirname(b.path)}</span>
      {b.change !== "modify" && <span className="font-mono text-[10px] text-muted uppercase">{b.change === "add" ? "NEW" : "DELETED"}</span>}
      {reverted && <span className="border border-line-strong px-1 font-display text-[9.5px] font-bold tracking-[0.14em] text-muted uppercase">Reverted</span>}
      {b.state === "kept" && <span className="font-mono text-[10px] text-muted">KEPT</span>}
      <span className="font-mono text-[11px] text-run">+{b.additions}</span>
      <span className="font-mono text-[11px] text-danger">−{b.deletions}</span>
      <button type="button" onClick={() => openChange(item.id)} className="border-0 bg-transparent p-0 font-mono text-[10.5px] text-accent hover:text-accent-hover">
        DIFF
      </button>
      {conv.projectId && !reverted && b.change !== "delete" && (
        <button
          type="button"
          onClick={() => openFile(conv.projectId!, b.path)}
          className="border-0 bg-transparent p-0 font-mono text-[10.5px] text-accent hover:text-accent-hover"
        >
          OPEN
        </button>
      )}
    </div>
  );
}

// ---------- system & thinking ----------

export function SystemDivider({ item }: { item: ChatItem }) {
  const b = item.body as Body<"system">;
  const tone = b.tone === "danger" ? "text-danger" : b.tone === "warn" ? "text-warn" : "text-agent";
  const line = b.tone === "danger" ? "bg-danger/30" : b.tone === "warn" ? "bg-warn/30" : "bg-agent/30";
  if (b.text.length > 90) {
    return (
      <div role="status" className={cn("flex gap-2.5 border px-3 py-2 text-[12.5px] leading-[19px]", b.tone === "warn" ? "border-warn/40 bg-warn/[0.05]" : "border-line")}>
        <AlertTriangle className={cn("mt-0.5 size-3.5 shrink-0", tone)} />
        <span className="text-body">{b.text}</span>
      </div>
    );
  }
  return (
    <div role="status" className={cn("flex items-center gap-2.5 font-mono text-[10.5px] uppercase", tone)}>
      <span className={cn("h-px flex-1", line)} />
      {b.text}
      <span className={cn("h-px flex-1", line)} />
    </div>
  );
}

export function ThinkingBlock({ item }: { item: ChatItem }) {
  const b = item.body as Body<"thinking">;
  const [open, setOpen] = useState(false);
  return (
    <div className="border-l border-plan/40 pl-3">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex items-center gap-1.5 border-0 bg-transparent p-0 font-mono text-[10.5px] text-plan"
      >
        <ChevronRight className={cn("size-3 transition-transform duration-200", open && "rotate-90")} />
        THINKING{item.status === "running" ? "…" : ""}
      </button>
      {open && (
        <div className="mt-1.5 text-[12.5px] text-muted">
          <ChatMarkdown text={b.text} />
        </div>
      )}
    </div>
  );
}

export function AttachmentChip({ item }: { item: ChatItem }) {
  const b = item.body as Body<"attachment">;
  return (
    <span
      className="inline-flex h-[22px] items-center gap-1.5 border border-line px-2 font-mono text-[10.5px] text-accent-hover"
      title={b.truncated ? `${b.path} (only the first part was sent)` : b.path}
    >
      <FileText className="size-3" />
      {b.path} · ATTACHED{b.truncated ? " · TRUNCATED" : ""}
    </span>
  );
}

/** A pasted image of a sent message; its bytes come from the backend on demand. */
export function ImageAttachment({ item }: { item: ChatItem }) {
  const b = item.body as Body<"image">;
  const [src, setSrc] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    let stale = false;
    ipc
      .chatImage(item.id)
      .then((url) => !stale && setSrc(url))
      .catch(() => !stale && setMissing(true));
    return () => {
      stale = true;
    };
  }, [item.id]);
  return (
    <span title={`${b.name} · ${formatBytes(b.size)} · sent with the message`} className="flex h-[72px] min-w-[72px] items-center justify-center border border-line bg-well">
      {src ? (
        <img src={src} alt={b.name} className="h-full max-w-[180px] object-contain" />
      ) : (
        <span className="px-2 font-mono text-[10px] text-muted">{missing ? "IMAGE NOT STORED" : "IMAGE"}</span>
      )}
    </span>
  );
}

export function ReadOnlyBadge({ text }: { text: string }) {
  return (
    <div className="flex items-center gap-2.5 border border-line-dim bg-well/60 px-2.5 py-2 font-mono text-[11px] text-muted">
      <Lock className="size-[13px] text-plan" />
      <span className="text-plan">READ-ONLY</span>
      <span>{text}</span>
    </div>
  );
}
