import { AnimatePresence, motion } from "motion/react";
import { ChevronDown, Columns2, Maximize2, PanelLeftOpen, PanelsTopLeft, Plus, Square, SquareTerminal } from "lucide-react";
import { set, setView, updateWorkspace, useApp } from "./store";
import { Button, IconButton } from "@/components/ui/button";
import { Splitter } from "@/components/ui/splitter";
import { useActiveSession } from "@/features/terminals/useActiveSession";
import { NewSessionMenu } from "@/features/terminals/NewSessionMenu";
import { ChatView } from "@/features/chat/ChatView";
import { newChat, toggleChatFocus } from "@/features/chat/actions";
import { engineOn, needsAttention } from "@/features/chat/models";
import { useChat } from "@/features/chat/store";
import { EditorPane } from "@/features/editor/EditorPane";
import { FileTree } from "@/features/explorer/FileTree";
import { BranchChip } from "@/features/git/BranchChip";
import { SourceControl } from "@/features/git/SourceControl";
import { OverviewDashboard } from "@/features/overview/OverviewDashboard";
import { TerminalsView } from "@/features/terminals/TerminalsView";
import { defaultWorkspace, type PaneLayout, type View } from "@/lib/types";
import { cn } from "@/lib/utils";

const VIEWS: { id: View; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "chat", label: "Chat" },
  { id: "editor", label: "Code" },
  { id: "terminals", label: "Terminals" },
];

/** General: chats that belong to no project. Only the Chat tab. */
export function GeneralWorkspace() {
  return (
    <main className="flex min-w-0 flex-1 flex-col">
      <WorkspaceHeader projectId={null} name="Ask" path="Conversations not linked to a project" view="chat" layout="single" />
      <ChatView projectId={null} projectName="Ask" />
    </main>
  );
}

export function Workspace({ projectId }: { projectId: string }) {
  const project = useApp((s) => s.projects.find((p) => p.id === projectId));
  const ws = useApp((s) => s.workspaces[projectId]) ?? defaultWorkspace();
  if (!project) return null;

  return (
    <main className="flex min-w-0 flex-1 flex-col">
      <WorkspaceHeader projectId={projectId} name={project.name} path={project.path} view={ws.view} layout={ws.layout} />
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={`${projectId}:${ws.view}`}
          className="flex min-h-0 flex-1 flex-col"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
        >
          {ws.view === "overview" && <OverviewDashboard projectId={projectId} />}
          {ws.view === "chat" && <ChatView projectId={projectId} projectName={project.name} />}
          {ws.view === "editor" && (
            <div className="flex min-h-0 flex-1 flex-col pt-4">
              <WorkArea projectId={projectId} />
            </div>
          )}
          {ws.view === "terminals" && <TerminalsView projectId={projectId} layout={ws.layout} />}
        </motion.div>
      </AnimatePresence>
    </main>
  );
}

function WorkArea({ projectId }: { projectId: string }) {
  const ws = useApp((s) => s.workspaces[projectId]) ?? defaultWorkspace();
  return (
    <div className="flex min-h-0 flex-1 gap-2.5 pr-5 pb-4 pl-6">
      {ws.filesCollapsed ? (
        <div className="flex shrink-0 flex-col border border-line bg-surface">
          <IconButton aria-label="Show files panel" size={34} onClick={() => updateWorkspace(projectId, { filesCollapsed: false })}>
            <PanelLeftOpen className="size-4" />
          </IconButton>
        </div>
      ) : (
        <>
          {ws.sidebar === "scm" ? <SourceControl projectId={projectId} width={ws.explorerWidth} /> : <FileTree projectId={projectId} width={ws.explorerWidth} />}
          <Splitter
            label="Resize sidebar"
            side="left"
            value={ws.explorerWidth}
            min={180}
            max={480}
            onChange={(v) => updateWorkspace(projectId, { explorerWidth: v })}
          />
        </>
      )}
      <EditorPane projectId={projectId} />
    </div>
  );
}

const LAYOUTS: { id: PaneLayout; label: string; icon: React.ReactNode }[] = [
  { id: "single", label: "Single pane", icon: <Square className="size-4" /> },
  { id: "columns", label: "Two columns", icon: <Columns2 className="size-4" /> },
  { id: "two-over-one", label: "Two over one", icon: <PanelsTopLeft className="size-4" /> },
];

function WorkspaceHeader({
  projectId,
  name,
  path,
  view,
  layout,
}: {
  projectId: string | null;
  name: string;
  path: string;
  view: View;
  layout: PaneLayout;
}) {
  const active = useActiveSession(projectId);
  const attention = useChat((s) => s.conversations.filter((c) => c.projectId === projectId && needsAttention(c) && engineOn(s.engines, c.engine)).length);
  const focus = useChat((s) => s.focus);
  const views = projectId ? VIEWS : VIEWS.filter((v) => v.id === "chat");

  return (
    <div className="flex h-12 shrink-0 items-center gap-3.5 border-b border-line bg-[rgba(5,8,13,0.85)] pr-3.5 pl-5">
      <h1 className="glow-text m-0 max-w-[40%] shrink-0 truncate font-display text-[20px] font-bold tracking-[0.14em] uppercase">{name}</h1>
      <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-muted" title={path}>
        {path}
      </span>
      {projectId && <BranchChip projectId={projectId} />}

      <div role="tablist" aria-label="Workspace view" className="flex border border-line">
        {views.map((v, i) => {
          const selected = v.id === view;
          return (
            <button
              key={v.id}
              role="tab"
              aria-selected={selected}
              onClick={() => projectId && setView(projectId, v.id)}
              className={cn(
                "flex h-[30px] items-center gap-2 border-0 px-3.5 font-display text-[13px] tracking-[0.14em] uppercase transition-colors duration-200",
                i > 0 && "border-l border-line",
                selected ? "bg-accent/12 font-bold text-accent shadow-[inset_0_-2px_0_#4DA3FF]" : "bg-transparent font-semibold text-muted hover:text-fg",
              )}
            >
              {v.label}
              {v.id === "chat" && attention > 0 && (
                <span className="flex h-[15px] min-w-[15px] items-center justify-center bg-warn px-[3px] font-mono text-[9px] tracking-normal text-on-accent" title={`${attention} need you`}>
                  {attention}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {projectId && view === "terminals" && (
        <div className="flex items-center gap-2">
          <div role="group" aria-label="Layout" className="flex border border-line">
            {LAYOUTS.map((l, i) => (
              <IconButton
                key={l.id}
                aria-label={l.label}
                aria-pressed={layout === l.id}
                active={layout === l.id}
                size={32}
                style={{ height: 30 }}
                className={cn(i > 0 && "border-l border-line")}
                onClick={() => updateWorkspace(projectId, { layout: l.id })}
              >
                {l.icon}
              </IconButton>
            ))}
          </div>
          <NewSessionMenu projectId={projectId}>
            <Button className="pr-2.5 pl-3">
              <SquareTerminal className="size-4" />
              New terminal
              <ChevronDown className="size-3.5 text-muted" />
            </Button>
          </NewSessionMenu>
          <IconButton aria-label="Terminal focus mode" bordered size={30} disabled={!active} onClick={() => active && set({ focusSessionId: active.id })}>
            <Maximize2 className="size-4" />
          </IconButton>
        </div>
      )}

      {view === "chat" && (
        <IconButton
          aria-label="Chat focus mode (Ctrl Shift F)"
          aria-pressed={focus}
          active={focus}
          bordered
          size={30}
          onClick={toggleChatFocus}
        >
          <Maximize2 className="size-4" />
        </IconButton>
      )}
      {projectId && view === "overview" && (
        <Button
          variant="primary"
          onClick={() => {
            setView(projectId, "chat");
            newChat(projectId);
          }}
        >
          <Plus className="size-4" />
          New chat
        </Button>
      )}
    </div>
  );
}
