import { useState } from "react";
import { deleteEntry } from "@/app/actions";
import { fileKey, set, useApp } from "@/app/store";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { basename } from "@/lib/utils";

export function DeleteEntryDialog({ projectId, path, isDir }: { projectId: string; path: string; isDir: boolean }) {
  const unsaved = useApp(
    (s) =>
      (s.workspaces[projectId]?.openFiles ?? []).filter(
        (f) => (f === path || f.startsWith(path + "/")) && s.dirty[fileKey(projectId, f)],
      ).length,
  );
  const [busy, setBusy] = useState(false);
  const close = () => set({ dialog: null });
  const name = basename(path);
  const what = isDir ? "folder and everything in it" : "file";
  const unsavedText =
    unsaved > 0
      ? ` ${unsaved} open file${unsaved === 1 ? " has" : "s have"} unsaved changes; ${unsaved === 1 ? "it stays" : "they stay"} open so you can save a copy.`
      : "";
  return (
    <Dialog
      open
      tone="danger"
      onClose={close}
      title={`Delete ${name}?`}
      description={`This ${what} moves to the Recycle Bin, where you can restore it.${unsavedText}`}
      footer={
        <>
          <Button variant="outline" onClick={close}>
            Cancel
          </Button>
          <Button
            variant="danger"
            autoFocus
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              if (!(await deleteEntry(projectId, path))) setBusy(false);
            }}
          >
            Move to Recycle Bin
          </Button>
        </>
      }
    >
      <div className="border border-line bg-well px-3 py-2.5 font-mono text-[12px] break-all text-term">{path}</div>
    </Dialog>
  );
}
