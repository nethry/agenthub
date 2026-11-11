import { useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { addProject, createProject, pickFolder, removeProject } from "@/app/actions";
import { useProjectBacklog } from "@/features/backlog/actions";
import { useBacklog } from "@/features/backlog/store";
import { useChat } from "@/features/chat/store";
import { saveAll } from "@/features/editor/models";
import { isLive, sessionsFor, set, useApp } from "@/app/store";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input } from "@/components/ui/form";
import { basename } from "@/lib/utils";

const close = () => set({ dialog: null });

export function AddProjectDialog({ initialPath }: { initialPath?: string }) {
  const [path, setPath] = useState(initialPath ?? "");
  const [name, setName] = useState(initialPath ? basename(initialPath) : "");
  const [nameTouched, setNameTouched] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!nameTouched) setName(path ? basename(path.replace(/[\\/]+$/, "")) : "");
  }, [path, nameTouched]);

  const browse = async () => {
    const picked = await pickFolder("Choose a project folder");
    if (picked) setPath(picked);
  };

  const submit = async () => {
    if (!path.trim()) return;
    setBusy(true);
    await addProject(path.trim(), name.trim() || undefined);
    setBusy(false);
  };

  return (
    <Dialog
      open
      onClose={close}
      title="Add project"
      footer={
        <>
          <Button variant="outline" onClick={close}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!path.trim() || busy} onClick={submit}>
            Add project
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field label="Folder" htmlFor="ap-path">
          <div className="flex gap-2">
            <Input id="ap-path" mono autoFocus value={path} onChange={(e) => setPath(e.target.value)} className="flex-1" />
            <Button onClick={browse}>Browse</Button>
          </div>
        </Field>
        <Field label="Name" htmlFor="ap-name">
          <Input
            id="ap-name"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setNameTouched(true);
            }}
          />
        </Field>
        <p className="m-0 text-[12px] leading-[18px] text-muted">AgentHub reads and writes files only inside this folder.</p>
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

export function CreateProjectDialog() {
  const [parent, setParent] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const sep = parent.includes("/") && !parent.includes("\\") ? "/" : "\\";
  const target = parent && name ? `${parent.replace(/[\\/]+$/, "")}${sep}${name.trim()}` : "";

  const submit = async () => {
    if (!parent || !name.trim()) return;
    setBusy(true);
    await createProject(parent, name.trim());
    setBusy(false);
  };

  return (
    <Dialog
      open
      onClose={close}
      title="Create new folder"
      footer={
        <>
          <Button variant="outline" onClick={close}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!parent || !name.trim() || busy} onClick={submit}>
            Create project
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field label="Location" htmlFor="cp-parent">
          <div className="flex gap-2">
            <Input id="cp-parent" mono value={parent} onChange={(e) => setParent(e.target.value)} className="flex-1" />
            <Button
              onClick={async () => {
                const p = await pickFolder("Choose where to create the folder");
                if (p) setParent(p);
              }}
            >
              Browse
            </Button>
          </div>
        </Field>
        <Field label="Folder name" htmlFor="cp-name">
          <Input id="cp-name" autoFocus value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <p className="m-0 font-mono text-[12px] leading-[18px] text-muted">{target || "Pick a location and a name."}</p>
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

export function RemoveProjectDialog({ projectId }: { projectId: string }) {
  const project = useApp((s) => s.projects.find((p) => p.id === projectId));
  const running = useApp((s) => sessionsFor(s, projectId).filter(isLive).length);
  const unsaved = useApp(
    useShallow((s) =>
      Object.keys(s.dirty)
        .filter((k) => k.startsWith(projectId + ":"))
        .map((k) => k.slice(projectId.length + 1)),
    ),
  );
  const [busy, setBusy] = useState(false);
  const chats = useChat((st) => st.conversations.filter((c) => c.projectId === projectId).length);
  useProjectBacklog(projectId);
  const backlog = useBacklog((st) => st.items[projectId]?.length ?? 0);
  if (!project) return null;
  const chatsText = chats === 0 ? "" : ` Its ${chats} chat${chats === 1 ? "" : "s"} move${chats === 1 ? "s" : ""} to Ask, where agents can't run.`;
  const backlogText =
    backlog === 0 ? "" : ` Its ${backlog} backlog item${backlog === 1 ? "" : "s"} and ${backlog === 1 ? "its" : "their"} screenshots are deleted from AgentHub.`;
  const sessionsText =
    running === 0 ? "" : ` and ${running} running session${running === 1 ? "" : "s"} will be ended`;
  const unsavedText =
    unsaved.length === 0
      ? ""
      : ` ${unsaved.length} open file${unsaved.length === 1 ? " has" : "s have"} unsaved changes that will be lost unless you save first.`;
  return (
    <Dialog
      open
      tone="danger"
      onClose={close}
      title={`Remove ${project.name} from AgentHub?`}
      description={`The folder and its files stay on disk. Its saved layout is forgotten${sessionsText}.${chatsText}${backlogText}${unsavedText}`}
      footer={
        <>
          <Button variant="outline" onClick={close}>
            Cancel
          </Button>
          {unsaved.length > 0 && (
            <Button
              variant="secondary"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                if (await saveAll(projectId)) await removeProject(projectId);
                setBusy(false);
              }}
            >
              Save all and remove
            </Button>
          )}
          <Button variant="danger" disabled={busy} onClick={() => void removeProject(projectId)}>
            {unsaved.length > 0 ? "Discard and remove" : "Remove project"}
          </Button>
        </>
      }
    >
      <div className="border border-line bg-well px-3 py-2.5 font-mono text-[12px] break-all text-term">{project.path}</div>
      {unsaved.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-1 border border-warn/40 bg-well px-3 py-2.5 font-mono text-[12px] text-warn">
          {unsaved.map((f) => (
            <li key={f} className="truncate" title={f}>
              ● {f}
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}
