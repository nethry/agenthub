import { useEffect, useState } from "react";
import { FileText } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { openFile, showSession, spawnShell } from "@/app/actions";
import { setView, useApp, useSessions } from "@/app/store";
import { Button } from "@/components/ui/button";
import { StatusChip } from "@/components/ui/status";
import { ensureChatLoaded, newChat, openConversation } from "@/features/chat/actions";
import { Chip } from "@/features/chat/items";
import { conversationsIn, ENGINE_LABEL, engineOn, listTime, MODE_META, needsAttention, statusChip, visibleConversations } from "@/features/chat/models";
import { useChat } from "@/features/chat/store";
import { onFsChange } from "@/features/explorer/fsEvents";
import { useNow } from "@/lib/hooks";
import { ipc } from "@/lib/ipc";
import type { ChangedFile, Conversation } from "@/lib/types";
import { basename, cn, dirname } from "@/lib/utils";

/** Project overview: conversations, AI activity, recently changed files, terminals. */
export function OverviewDashboard({ projectId }: { projectId: string }) {
  useEffect(() => {
    void ensureChatLoaded();
  }, []);
  return (
    <div className="min-h-0 flex-1 overflow-auto px-5 py-[18px]">
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(440px,100%),1fr))] items-start gap-3.5">
        <ConversationsPanel projectId={projectId} />
        <div className="flex flex-col gap-3.5">
          <ActivityPanel projectId={projectId} />
          <ChangedFilesPanel projectId={projectId} />
          <TerminalsPanel projectId={projectId} />
        </div>
      </div>
    </div>
  );
}

function Panel({ label, tone, action, children }: { label: string; tone?: "warn"; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section aria-label={label} className={cn("hud border border-line bg-surface", tone === "warn" && "hud-warn")}>
      <div className="flex h-10 items-center gap-2.5 border-b border-line px-3">
        <span className="label-caps text-[11.5px] text-muted">{label}</span>
        <span className="flex-1" />
        {action}
      </div>
      {children}
    </section>
  );
}

function ConversationsPanel({ projectId }: { projectId: string }) {
  const all = useChat((s) => s.conversations);
  const engines = useChat((s) => s.engines);
  const requests = useChat((s) => s.requests);
  const now = useNow(60_000);
  const list = conversationsIn(visibleConversations(all, engines), projectId);
  return (
    <Panel
      label={`Conversations · ${list.length}`}
      action={
        <Button
          size="sm"
          onClick={() => {
            setView(projectId, "chat");
            newChat(projectId);
          }}
        >
          New chat
        </Button>
      }
    >
      {list.slice(0, 12).map((c) => {
        const chip = statusChip(c, !!requests[c.id]);
        return (
          <button
            key={c.id}
            type="button"
            onClick={() => openConversation(c.id)}
            className="flex w-full items-center gap-2.5 border-0 border-b border-line-dim bg-transparent px-3 py-2.5 text-left hover:bg-accent/5"
          >
            <span className="size-1.5 shrink-0" style={{ background: MODE_META[c.mode].color }} />
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="truncate text-[13px]">{c.title}</span>
              <span className="truncate font-mono text-[10px] text-muted uppercase">
                {MODE_META[c.mode].label} · {ENGINE_LABEL[c.engine]} · {listTime(c.updatedAt, now)}
              </span>
            </span>
            {chip && <Chip kind={chip} small />}
          </button>
        );
      })}
      {list.length === 0 && <p className="m-0 px-3 py-3.5 text-[12.5px] text-muted">No conversations in this project yet.</p>}
    </Panel>
  );
}

/** What needs the user or is running now. */
function ActivityPanel({ projectId }: { projectId: string }) {
  const items = useChat(
    useShallow((s) =>
      s.conversations.filter(
        (c) => c.projectId === projectId && engineOn(s.engines, c.engine) && (needsAttention(c) || !!s.requests[c.id] || c.status === "running"),
      ),
    ),
  );
  const describe = (c: Conversation): { text: string; action: string; color: string; live: boolean } => {
    switch (c.status) {
      case "waiting_for_approval":
        return { text: `${ENGINE_LABEL[c.engine]} is waiting for your approval.`, action: "Review", color: "#FFB547", live: false };
      case "failed":
        return { text: `${ENGINE_LABEL[c.engine]} stopped with an error.`, action: "Open", color: "#FF5470", live: false };
      case "interrupted":
        return { text: "AgentHub closed during this turn. Nothing re-ran.", action: "Resume", color: "#FFB547", live: false };
      default:
        return { text: `${ENGINE_LABEL[c.engine]} is working.`, action: "Watch", color: "#38E1FF", live: true };
    }
  };
  return (
    <Panel label="AI activity" tone="warn">
      {items.map((c) => {
        const d = describe(c);
        return (
          <div key={c.id} className="flex items-center gap-2.5 border-b border-line-dim px-3 py-2.5">
            <span className={cn("size-[7px] shrink-0", d.live && "live-glow")} style={{ background: d.color }} />
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="truncate text-[13px]">{c.title}</span>
              <span className="text-[12px] text-body">{d.text}</span>
            </span>
            <Button size="sm" onClick={() => openConversation(c.id)}>
              {d.action}
            </Button>
          </div>
        );
      })}
      {items.length === 0 && <p className="m-0 px-3 py-3.5 text-[12.5px] text-muted">Nothing running. Agents that need you show up here.</p>}
    </Panel>
  );
}

function ChangedFilesPanel({ projectId }: { projectId: string }) {
  const [all, setFiles] = useState<ChangedFile[]>([]);
  const engines = useChat((s) => s.engines);
  const files = all.filter((f) => engineOn(engines, f.engine));
  // Reload when a turn ends here (conversation status changes) or files change.
  const version = useChat((s) => s.conversations.filter((c) => c.projectId === projectId).map((c) => `${c.id}:${c.status}:${c.updatedAt}`).join("|"));
  useEffect(() => {
    let stale = false;
    const load = () =>
      void ipc
        .chatChangedFiles(projectId)
        .then((f) => !stale && setFiles(f))
        .catch(() => {});
    load();
    const off = onFsChange((c) => c.projectId === projectId && load());
    return () => {
      stale = true;
      off();
    };
  }, [projectId, version]);
  return (
    <Panel label="Recently changed files">
      {files.slice(0, 8).map((f) => (
        <button
          key={f.path}
          type="button"
          onClick={() => (f.state === "reverted" ? openConversation(f.conversationId) : openFile(projectId, f.path))}
          title={f.path}
          className="flex w-full items-center gap-2.5 border-0 bg-transparent px-3 py-2 text-left text-[12.5px] hover:bg-accent/5"
        >
          <FileText className={cn("size-[13px] shrink-0", f.state === "reverted" ? "text-muted" : "text-agent")} />
          <span className={cn("shrink-0", f.state === "reverted" && "text-muted line-through")}>{basename(f.path)}</span>
          <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-muted">{dirname(f.path)}</span>
          <span className="font-mono text-[10px] text-agent uppercase">{f.state === "reverted" ? "REVERTED" : `AI · ${ENGINE_LABEL[f.engine]}`}</span>
        </button>
      ))}
      {files.length === 0 && <p className="m-0 px-3 py-3.5 text-[12.5px] text-muted">No recent changes by agents.</p>}
    </Panel>
  );
}

function TerminalsPanel({ projectId }: { projectId: string }) {
  const sessions = useSessions(projectId);
  const live = useApp((s) => Object.values(s.sessions).filter((x) => x.projectId === projectId).length);
  return (
    <Panel label={`Terminals · ${live}`} action={<Button size="sm" onClick={() => void spawnShell(projectId)}>New terminal</Button>}>
      {sessions.map((s) => (
        <button
          key={s.id}
          type="button"
          onClick={() => showSession(s.id)}
          className="flex w-full items-center gap-2.5 border-0 bg-transparent px-3 py-2 text-left text-[12.5px] hover:bg-accent/5"
        >
          <span className="min-w-0 flex-1 truncate">{s.title}</span>
          <span className="max-w-[45%] truncate font-mono text-[10px] text-muted">{s.commandLine}</span>
          <StatusChip session={s} variant="inline" />
        </button>
      ))}
      {sessions.length === 0 && <p className="m-0 px-3 py-3.5 text-[12.5px] text-muted">No terminals. Shells and your own commands run here; agents run in Chat.</p>}
    </Panel>
  );
}
