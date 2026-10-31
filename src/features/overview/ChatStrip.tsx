import { useEffect } from "react";
import { MessageSquare, ArrowUpRight } from "lucide-react";
import { setView } from "@/app/store";
import { Button } from "@/components/ui/button";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu";
import { ensureChatLoaded, newChat, openConversation } from "@/features/chat/actions";
import { Chip } from "@/features/chat/items";
import { ENGINE_LABEL, MODE_META, needsAttention, statusChip, workspaceKey } from "@/features/chat/models";
import { useChat } from "@/features/chat/store";
import { overviewChat } from "./model";

export function ChatStrip({ projectId }: { projectId: string }) {
  const all = useChat((s) => s.conversations);
  const engines = useChat((s) => s.engines);
  const selected = useChat((s) => s.active[workspaceKey(projectId)]);
  const requests = useChat((s) => s.requests);
  const loaded = useChat((s) => s.loaded);
  useEffect(() => { void ensureChatLoaded(); }, []);
  const { conversation: c, attention } = overviewChat(projectId, all, engines, selected, requests);
  const chip = c ? statusChip(c, !!requests[c.id] && !needsAttention(c)) : null;
  return (
    <section aria-label="Project Chat status" className="hud flex min-w-0 shrink-0 flex-wrap items-center gap-2 border border-line bg-surface px-3 py-2">
      <MessageSquare className="size-4 shrink-0 text-accent" />
      {c ? <button type="button" onClick={() => openConversation(c.id)} className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1 border-0 bg-transparent text-left hover:text-accent" title={`Open chat: ${c.title}`}>
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">{c.title}</span>
        <span className="text-[11px] text-muted">{ENGINE_LABEL[c.engine]} · {MODE_META[c.mode].label}</span>
        {chip ? <Chip kind={chip} small /> : <span className="text-[11px] text-muted">Idle</span>}
        <span className="label-caps flex items-center gap-1 text-[11px] text-accent">Open chat <ArrowUpRight className="size-3.5" /></span>
      </button> : <span className="flex-1 text-[12px] text-muted">{loaded ? "No conversation in this project yet." : "Loading conversations…"}</span>}
      {attention.length > 0 && <Menu><MenuTrigger asChild><Button size="sm" className="text-warn">{attention.length} need attention</Button></MenuTrigger><MenuContent width={300}>
        {attention.map((item) => <MenuItem key={item.id} onSelect={() => openConversation(item.id)}><span className="truncate">{item.title}</span><Chip kind={statusChip(item, false)!} small /></MenuItem>)}
      </MenuContent></Menu>}
      <Button size="sm" disabled={!loaded} onClick={() => { newChat(projectId); setView(projectId, "chat"); }}>New chat</Button>
    </section>
  );
}
