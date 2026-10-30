import { closeFile } from "@/app/actions";
import { set, useApp } from "@/app/store";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { basename } from "@/lib/utils";
import { saveFile } from "./models";

export function UnsavedDialog({ projectId, path }: { projectId: string; path: string }) {
  const projectName = useApp((s) => s.projects.find((p) => p.id === projectId)?.name ?? "this project");
  const close = () => set({ dialog: null });
  return (
    <Dialog
      open
      tone="warn"
      onClose={close}
      eyebrow="▲ CAUTION"
      title={`Save changes to ${basename(path)}?`}
      description={`You edited this file in ${projectName}. If you close it without saving, the changes are lost.`}
      footer={
        <>
          <Button variant="danger-ghost" className="mr-auto px-2.5" onClick={() => closeFile(projectId, path)}>
            Don't save
          </Button>
          <Button variant="outline" onClick={close}>
            Cancel
          </Button>
          <Button
            variant="primary"
            autoFocus
            onClick={async () => {
              if (await saveFile(projectId, path)) closeFile(projectId, path);
            }}
          >
            Save
          </Button>
        </>
      }
    />
  );
}
