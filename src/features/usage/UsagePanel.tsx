import { useMemo, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { RefreshCw } from "lucide-react";
import { openSettings, refreshUsage } from "@/app/actions";
import { useApp } from "@/app/store";
import { ENGINE_LABEL, sumUsage, usageLine } from "@/features/chat/models";
import { useChat } from "@/features/chat/store";
import { useNow } from "@/lib/hooks";
import type { ChatMessage, EngineId, LimitWindow, ProviderUsage, UsagePrefs } from "@/lib/types";
import { cn } from "@/lib/utils";
import { PROVIDERS, current, emptyLabel, isExpired, level, pctText, resetText, syncedText, type Level, type UsageProvider } from "./format";

const FILL: Record<Level, string> = { normal: "var(--color-accent)", warn: "var(--color-warn)", limit: "var(--color-danger)" };
const TEXT: Record<Level, string> = { normal: "text-fg", warn: "text-warn", limit: "text-danger" };

/** Segmented bar: top = 5-hour session, bottom = weekly in compact places. */
function Meter({ label, w, lvl, size }: { label: string; w: LimitWindow | null; lvl: Level; size: "sm" | "lg" }) {
  const pct = w ? Math.min(100, Math.max(0, w.usedPercent)) : 0;
  const seg = size === "lg" ? "transparent 0 10px, var(--color-surface) 10px 12px" : "transparent 0 7px, var(--color-surface) 7px 9px";
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={w ? Math.round(w.usedPercent) : undefined}
      aria-valuetext={w ? pctText(w) : "No current reading"}
      className={size === "lg" ? "h-2.5" : "h-1.5"}
      style={{
        background: `repeating-linear-gradient(90deg, ${seg}), linear-gradient(90deg, ${FILL[lvl]} ${pct}%, var(--color-track) ${pct}%)`,
      }}
    />
  );
}

/** Codex conversations with a turn running now. */
function useUsedBy(_provider: UsageProvider): number {
  return useChat((s) => s.conversations.filter((c) => c.engine === "codex" && !!s.requests[c.id]).length);
}

/**
 * Usage of the engine the chat is set to, next to the composer: Codex's plan
 * windows (top bar = 5-hour session, bottom = weekly; opens the details),
 * else the tokens and cost this chat's answers reported.
 */
export function ChatUsage({ engine, conversationId }: { engine: EngineId; conversationId: string | null }) {
  const provider = PROVIDERS.find((p) => p.engine === engine);
  return provider ? <PlanUsage provider={provider} /> : <ChatTokens engine={engine} conversationId={conversationId} />;
}

const NO_MESSAGES: ChatMessage[] = [];

function ChatTokens({ engine, conversationId }: { engine: EngineId; conversationId: string | null }) {
  const messages = useChat((s) => (conversationId ? s.messages[conversationId] : undefined) ?? NO_MESSAGES);
  const line = useMemo(() => usageLine(sumUsage(messages.map((m) => m.usage))), [messages]);
  return (
    <span
      title={`${ENGINE_LABEL[engine]} has no plan limits AgentHub can read. These are the totals its answers in this chat reported.`}
      className="font-mono text-[10px] text-muted"
    >
      {line ? `THIS CHAT · ${line}` : "NO USAGE YET"}
    </span>
  );
}

function PlanUsage({ provider: p }: { provider: (typeof PROVIDERS)[number] }) {
  const usage = useApp((s) => s.usage);
  const prefs = useApp((s) => s.usagePrefs);
  const now = useNow(30_000);
  const [open, setOpen] = useState(false);
  if (!usage) return null;
  const data = usage[p.id];
  const session = current(data.session, now);
  const weekly = current(data.weekly, now);
  const sl = session ? level(session.usedPercent, prefs) : "normal";
  const wl = weekly ? level(weekly.usedPercent, prefs) : "normal";
  const label =
    session || weekly
      ? `${p.name} ${session ? pctText(session) : "—"} session, ${weekly ? pctText(weekly) : "—"} weekly`
      : `${p.name} ${emptyLabel(data).toLowerCase()}`;
  return (
    <Popover.Root
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) refreshUsage();
      }}
    >
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label={`Usage limits: ${label}`}
          title="Usage limits (5-hour session / weekly)"
          className="flex h-7 items-center gap-1.5 border border-line bg-transparent px-2 font-mono text-[10.5px] text-fg hover:border-line-strong"
        >
          <span className="text-muted">{p.cli.toUpperCase()}</span>
          {data.session || data.weekly ? (
            <>
              <span className="flex w-[30px] flex-col gap-0.5">
                <span className="h-[3px]" style={{ background: `linear-gradient(90deg, ${FILL[sl]} ${session?.usedPercent ?? 0}%, var(--color-track) ${session?.usedPercent ?? 0}%)` }} />
                <span className="h-[3px]" style={{ background: `linear-gradient(90deg, ${FILL[wl]} ${weekly?.usedPercent ?? 0}%, var(--color-track) ${weekly?.usedPercent ?? 0}%)` }} />
              </span>
              <span>
                <span className={session ? TEXT[sl] : "text-muted"}>{session ? Math.round(session.usedPercent) : "—"}</span>
                <span className="text-muted">/</span>
                <span className={weekly ? TEXT[wl] : "text-muted"}>{weekly ? Math.round(weekly.usedPercent) : "—"}</span>
              </span>
            </>
          ) : (
            <span className="text-muted">—</span>
          )}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content side="top" align="end" sideOffset={8} collisionPadding={12} className="z-50 outline-none data-[state=open]:animate-[menu-in_180ms_ease-out]">
          <UsageDetails provider={p} onConfigure={() => setOpen(false)} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** 01 // Usage detail of one provider: opened from its meter. */
function UsageDetails({ provider: p, onConfigure }: { provider: (typeof PROVIDERS)[number]; onConfigure: () => void }) {
  const usage = useApp((s) => s.usage);
  const prefs = useApp((s) => s.usagePrefs);
  const now = useNow(1000);
  if (!usage) return null;
  const latest = usage[p.id].syncedAt;
  return (
    <div
      role="dialog"
      aria-labelledby="usage-title"
      className="hud flex w-[520px] max-w-[calc(100vw-24px)] flex-col border border-accent/45 bg-overlay/97 hud:shadow-[0_0_50px_rgba(77,163,255,0.14),0_24px_64px_rgba(0,0,0,0.6)] graphite:shadow-(--shadow-pop)"
    >
      <div className="flex items-center justify-between border-b border-line px-[18px] py-3.5">
        <h2 id="usage-title" className="m-0 font-display text-[18px] font-bold tracking-[0.12em] uppercase">
          Usage limits
        </h2>
        <span className="flex items-center gap-2.5 font-mono text-[10.5px] text-muted">
          {usage.refreshing ? "SYNCING…" : syncedText(latest, now)}
          <button
            aria-label="Refresh usage"
            title="Refresh usage"
            disabled={usage.refreshing}
            onClick={refreshUsage}
            className="flex size-[26px] items-center justify-center border border-line bg-transparent text-accent hover:border-line-strong disabled:opacity-60"
          >
            <RefreshCw className={cn("size-3.5", usage.refreshing && "animate-[spin_1s_linear_infinite]")} />
          </button>
        </span>
      </div>

      <ProviderDetail provider={p.id} name={p.name} cli={p.cli} data={usage[p.id]} prefs={prefs} now={now} />

      <p className="m-0 border-t border-line px-[18px] py-3 text-[12px] leading-[18px] text-muted">
        Claude Agent runs on an Anthropic API key, which has no plan windows; Gemini doesn't report quota windows. Their token
        usage (and cost, when reported) appears under each answer in Chat.
      </p>
      <div className="flex h-10 items-center justify-between border-t border-line bg-well px-[18px] font-mono text-[10.5px] text-muted">
        <span>
          WARN AT {prefs.warnAt}% · ALERT AT {prefs.alertAt}%
        </span>
        <button
          onClick={() => {
            onConfigure();
            openSettings("general");
          }}
          className="border-0 bg-transparent p-0 font-mono text-[10.5px] text-accent hover:text-accent-hover"
        >
          CONFIGURE →
        </button>
      </div>
    </div>
  );
}

function ProviderDetail({
  provider,
  name,
  cli,
  data,
  prefs,
  now,
}: {
  provider: UsageProvider;
  name: string;
  cli: string;
  data: ProviderUsage;
  prefs: UsagePrefs;
  now: number;
}) {
  const usedBy = useUsedBy(provider);
  const hasNumbers = data.session || data.weekly;
  const stale = data.syncedAt && now - data.syncedAt > 15 * 60_000;
  return (
    <div className="flex flex-col gap-3.5 p-[18px]">
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-display text-[16px] font-bold tracking-[0.12em] uppercase">
          {name}
          {data.plan && <span className="ml-2 font-mono text-[10.5px] font-normal tracking-normal text-muted">{data.plan.toUpperCase()}</span>}
        </span>
        <span className="font-mono text-[10.5px] text-muted">
          {usedBy > 0 ? `USED BY: ${cli.toUpperCase()} ×${usedBy}` : "NOT IN USE"}
        </span>
      </div>
      {data.message && (
        <p className={cn("m-0 text-[12.5px] leading-[19px]", hasNumbers ? "text-warn" : "text-body")}>
          {hasNumbers && "▲ "}
          {data.message}
          {data.status === "notFound" && (
            <>
              {" "}
              <button
                onClick={() => openSettings("ai")}
                className="border-0 bg-transparent p-0 text-accent hover:text-accent-hover"
              >
                Open AI integrations
              </button>
            </>
          )}
        </p>
      )}
      {hasNumbers && (
        <>
          <WindowDetail label="Current session · 5h" name={`${name} session usage`} w={data.session} prefs={prefs} now={now} />
          <WindowDetail label="Weekly" name={`${name} weekly usage`} w={data.weekly} prefs={prefs} now={now} />
          {stale && (
            <span className="font-mono text-[10.5px] text-muted">
              LAST READING {syncedText(data.syncedAt, now).replace("SYNCED ", "")}
            </span>
          )}
        </>
      )}
    </div>
  );
}

function WindowDetail({
  label,
  name,
  w,
  prefs,
  now,
}: {
  label: string;
  name: string;
  w: LimitWindow | null;
  prefs: UsagePrefs;
  now: number;
}) {
  const live = current(w, now);
  const lvl = live ? level(live.usedPercent, prefs) : "normal";
  let note: React.ReactNode;
  if (!w) note = <span className="text-muted">NO READING FOR THIS WINDOW</span>;
  else if (isExpired(w, now)) note = <span className="text-muted">WINDOW RESET · WAITING FOR A NEW READING</span>;
  else if (lvl === "limit") note = <span className="text-danger">▲ LIMIT REACHED · {resetText(w.resetsAt, now, true)}</span>;
  else if (lvl === "warn")
    note = (
      <span className="text-warn">
        ▲ ABOVE {prefs.warnAt}% · {resetText(w.resetsAt, now)}
      </span>
    );
  else note = <span className="text-muted">{resetText(w.resetsAt, now)}</span>;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between">
        <span className="font-display text-[12px] font-semibold tracking-[0.14em] text-body uppercase">{label}</span>
        <span
          className={cn(
            "font-mono text-[20px]",
            !live ? "text-muted" : lvl === "normal" ? "text-accent" : TEXT[lvl],
            lvl === "warn" && "hud:[text-shadow:0_0_10px_rgba(255,181,71,0.45)]",
            lvl === "limit" && "hud:[text-shadow:0_0_10px_rgba(255,84,112,0.45)]",
          )}
        >
          {live ? pctText(live) : "—"}
        </span>
      </div>
      <Meter label={name} w={live} lvl={lvl} size="lg" />
      <span className="font-mono text-[10.5px]">{note}</span>
    </div>
  );
}
