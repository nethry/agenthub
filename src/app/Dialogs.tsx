import { AnimatePresence, motion } from "motion/react";
import { X } from "lucide-react";
import { set, useApp } from "./store";
import { interruptions, useRunningWork } from "./work";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { AddProjectDialog, CreateProjectDialog, RemoveProjectDialog } from "@/features/projects/ProjectDialogs";
import { CustomCommandDialog, EndSessionDialog } from "@/features/terminals/SessionDialogs";
import { UnsavedDialog } from "@/features/editor/UnsavedDialog";
import { DeleteEntryDialog } from "@/features/explorer/DeleteEntryDialog";
import { DeleteChatDialog, RevertAllDialog } from "@/features/chat/DeleteChatDialog";
import { UpdateDialog } from "@/features/updates/UpdateDialog";
import { deleteItem } from "@/features/backlog/actions";
import { DeleteBacklogItemDialog } from "@/features/backlog/ItemDetail";
import { ipc } from "@/lib/ipc";
import { saveAllAndQuit } from "./actions";
import { cn } from "@/lib/utils";

export function Dialogs() {
  const dialog = useApp((s) => s.dialog);
  if (!dialog) return null;
  switch (dialog.type) {
    case "addProject":
      return <AddProjectDialog initialPath={dialog.path} />;
    case "createProject":
      return <CreateProjectDialog />;
    case "removeProject":
      return <RemoveProjectDialog projectId={dialog.projectId} />;
    case "endSession":
      return <EndSessionDialog sessionId={dialog.sessionId} />;
    case "unsaved":
      return <UnsavedDialog projectId={dialog.projectId} path={dialog.path} />;
    case "deleteEntry":
      return <DeleteEntryDialog projectId={dialog.projectId} path={dialog.path} isDir={dialog.isDir} />;
    case "deleteChat":
      return <DeleteChatDialog conversationId={dialog.conversationId} />;
    case "deleteBacklogItem":
      return (
        <DeleteBacklogItemDialog
          itemId={dialog.itemId}
          onClose={() => set({ dialog: null })}
          onDelete={() => {
            set({ dialog: null });
            void deleteItem(dialog.itemId);
          }}
        />
      );
    case "revertAll":
      return <RevertAllDialog conversationId={dialog.conversationId} itemIds={dialog.itemIds} />;
    case "customCommand":
      return <CustomCommandDialog />;
    case "quit":
      return <QuitDialog />;
    case "update":
      return <UpdateDialog />;
  }
}

function QuitDialog() {
  const projects = useApp((s) => s.projects);
  const { sessions: live, unsaved, turns, gitOps } = useRunningWork();
  const close = () => set({ dialog: null });
  const byProject = projects
    .map((p) => ({ name: p.name, titles: live.filter((s) => s.projectId === p.id).map((s) => s.title) }))
    .filter((p) => p.titles.length);

  const title =
    turns > 0 && live.length === 0
      ? `Quit with ${turns} agent turn${turns === 1 ? "" : "s"} running?`
      : live.length > 0
      ? `Quit with ${live.length} session${live.length === 1 ? "" : "s"} running?`
      : unsaved > 0
        ? `Quit with ${unsaved} unsaved file${unsaved === 1 ? "" : "s"}?`
        : `Quit while ${gitOps === 1 ? "a Git operation runs" : "Git operations run"}?`;
  const body = [...interruptions({ sessions: live, turns, unsaved, gitOps }, "Quitting"), "Projects and layout are restored next time."].join(" ");

  return (
    <Dialog
      open
      tone="danger"
      onClose={close}
      title={title}
      description={body}
      footer={
        <>
          <Button variant="outline" onClick={close}>
            Cancel
          </Button>
          {unsaved > 0 && (
            <Button variant="secondary" onClick={() => void saveAllAndQuit()}>
              Save all and quit
            </Button>
          )}
          <Button variant="danger" onClick={() => void ipc.quit()}>
            {unsaved === 0 ? "Quit and end sessions" : "Quit without saving"}
          </Button>
        </>
      }
    >
      {byProject.length > 0 && (
        <div className="flex flex-col gap-1.5 border border-line bg-well px-3 py-2.5 text-[12px]">
          {byProject.map((p) => (
            <div key={p.name} className="flex gap-2">
              <span className="w-[92px] shrink-0 truncate font-mono text-muted">{p.name}</span>
              <span className="text-term">{p.titles.join(", ")}</span>
            </div>
          ))}
        </div>
      )}
    </Dialog>
  );
}

export function Toasts() {
  const toasts = useApp((s) => s.toasts);
  return (
    <div aria-live="polite" className="pointer-events-none fixed right-4 bottom-4 z-[60] flex w-[380px] flex-col gap-2">
      <AnimatePresence initial={false}>
        {toasts.map((t) => (
          <motion.div
            key={t.id}
            layout
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className={cn(
              "hud pointer-events-auto flex items-start gap-3 border bg-surface px-3.5 py-3 text-[12.5px] hud:shadow-[0_16px_48px_rgba(0,0,0,0.5)] graphite:shadow-(--shadow-pop)",
              t.tone === "danger" ? "hud-danger border-danger/50" : t.tone === "warn" ? "hud-warn border-warn/50" : "border-accent/40",
            )}
          >
            <span
              className={cn(
                "font-mono text-[10.5px]",
                t.tone === "danger" ? "text-danger" : t.tone === "warn" ? "text-warn" : "text-accent",
              )}
            >
              {t.tone === "danger" ? "✕" : t.tone === "warn" ? "▲" : "▸"}
            </span>
            <span className="min-w-0 flex-1 break-words text-body">{t.message}</span>
            <button
              aria-label="Dismiss"
              className="border-0 bg-transparent p-0 text-muted hover:text-fg"
              onClick={() => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== t.id) }))}
            >
              <X className="size-3.5" />
            </button>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
