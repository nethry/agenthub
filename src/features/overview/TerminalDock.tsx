import { useEffect } from "react";
import { Maximize2, PanelRightClose, Rows2, SquareTerminal } from "lucide-react";
import { focusSession } from "@/app/actions";
import { setView, updateWorkspace, useApp, useSessions } from "@/app/store";
import { Button, IconButton } from "@/components/ui/button";
import { Select } from "@/components/ui/form";
import { NewSessionMenu } from "@/features/terminals/NewSessionMenu";
import { Pane } from "@/features/terminals/TerminalsView";
import { defaultWorkspace } from "@/lib/types";
import { overviewSessions } from "./model";

export function TerminalDock({ projectId }: { projectId: string }) {
  const sessions = useSessions(projectId);
  const ws = useApp((s) => s.workspaces[projectId]) ?? defaultWorkspace();
  const ids = overviewSessions(sessions, ws.overviewSessionIds, ws.activeSessionId);
  const signature = ids.join("|");
  useEffect(() => {
    if (signature !== ws.overviewSessionIds.join("|")) updateWorkspace(projectId, { overviewSessionIds: ids });
  }, [projectId, signature, ws.overviewSessionIds]);
  const visible = ws.overviewSplit ? ids : [ids.includes(ws.activeSessionId ?? "") ? ws.activeSessionId! : ids[0]].filter(Boolean);
  return (
    <section aria-label="Overview terminals" className="hud flex min-h-0 min-w-0 flex-1 flex-col border border-line bg-surface">
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-line px-2 py-2">
        <SquareTerminal className="size-4 text-accent" />
        <span className="label-caps mr-auto text-[11px] text-muted">Terminals · {sessions.length}</span>
        <NewSessionMenu projectId={projectId}><Button size="sm">New terminal</Button></NewSessionMenu>
        <IconButton bordered size={28} aria-label="Show two terminal panes" aria-pressed={ws.overviewSplit} active={ws.overviewSplit} disabled={sessions.length < 2} onClick={() => updateWorkspace(projectId, { overviewSplit: !ws.overviewSplit })}><Rows2 className="size-4" /></IconButton>
        <IconButton size={28} aria-label="Expand to Terminals view" onClick={() => setView(projectId, "terminals")}><Maximize2 className="size-4" /></IconButton>
        <IconButton size={28} aria-label="Hide terminals (keep sessions running)" onClick={() => updateWorkspace(projectId, { overviewTerminalsCollapsed: true, overviewReadmeCollapsed: false })}><PanelRightClose className="size-4" /></IconButton>
      </div>
      {sessions.length === 0 ? <div className="flex flex-1 flex-col items-center justify-center gap-3 p-5 text-center">
        <SquareTerminal className="size-8 text-muted" />
        <p className="m-0 text-[13px]">Run your app beside its instructions.</p>
        <p className="m-0 max-w-[280px] text-[12px] text-muted">Start a shell or a saved command. Sessions keep running when you leave Overview.</p>
        <NewSessionMenu projectId={projectId}><Button variant="primary">New terminal</Button></NewSessionMenu>
      </div> : <div className="grid min-h-0 flex-1 gap-2 p-2" style={{ gridTemplateRows: `repeat(${visible.length}, minmax(0, 1fr))` }}>
        {visible.map((id, slot) => {
          const session = sessions.find((s) => s.id === id)!;
          return <div key={id} className="flex min-h-0 min-w-0 flex-col gap-1">
            <Select aria-label={`Terminal in pane ${slot + 1}`} value={id} className="h-7 w-full min-w-0 text-[12px]" onChange={(e) => {
              const next = e.target.value;
              const other = visible.find((v) => v !== id);
              const pair = slot === 0 ? [next, next === other ? id : other ?? ids.find((v) => v !== next)] : [next === other ? id : other, next];
              updateWorkspace(projectId, { overviewSessionIds: pair.filter((v): v is string => !!v) });
              focusSession(next);
            }}>
              {sessions.map((s) => <option key={s.id} value={s.id}>{s.title} · {s.status === "running" ? (s.activity ?? "running") : s.status}</option>)}
            </Select>
            <Pane session={session} active={ws.activeSessionId === id} compact />
          </div>;
        })}
      </div>}
    </section>
  );
}
