import { useEffect, useState } from "react";
import { closeSession, refreshPresets, spawnCustom } from "@/app/actions";
import { set, toast, useApp } from "@/app/store";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { ArgsInput, Field, Input, Select } from "@/components/ui/form";
import { StatusDot } from "@/components/ui/status";
import { useNow } from "@/lib/hooks";
import { errorMessage, ipc } from "@/lib/ipc";
import { uptime } from "@/lib/utils";

const close = () => set({ dialog: null });

export function EndSessionDialog({ sessionId }: { sessionId: string }) {
  const s = useApp((st) => st.sessions[sessionId]);
  const now = useNow();
  if (!s) return null;
  return (
    <Dialog
      open
      tone="danger"
      onClose={close}
      eyebrow="✕ TERMINATE PROCESS"
      title={`End ${s.title}?`}
      description="The process is still running. Closing this session terminates it and its child processes."
      footer={
        <>
          <Button variant="outline" onClick={close}>
            Cancel
          </Button>
          <Button variant="danger" autoFocus onClick={() => void closeSession(sessionId)}>
            End session
          </Button>
        </>
      }
    >
      <div className="flex items-center gap-2.5 border border-line bg-well px-3 py-2.5 font-mono text-[12px] text-term">
        <StatusDot status={s.status} activity={s.activity} />
        <span className="min-w-0 flex-1 truncate">&gt; {s.commandLine}</span>
        <span className="text-muted">
          {s.pid != null && `PID ${s.pid} · `}
          {uptime(s.startedAt, now, true)}
        </span>
      </div>
    </Dialog>
  );
}

/** Run any command in the active project; optionally keep it as a preset. */
export function CustomCommandDialog() {
  const projectId = useApp((s) => s.activeProjectId);
  const shells = useApp((s) => s.shells);
  const [name, setName] = useState("");
  const [exe, setExe] = useState("");
  const [args, setArgs] = useState<string[]>([]);
  const [shell, setShell] = useState("direct");
  const [save, setSave] = useState(false);
  const resolved = useResolved(shell === "wsl" ? "" : exe);

  const run = async () => {
    if (!projectId || !exe.trim()) return;
    if (save) {
      try {
        await ipc.savePreset({
          displayName: name.trim() || exe.trim(),
          executable: exe.trim(),
          args,
          shellProfile: shell,
          workingDir: null,
          enabled: true,
        });
        await refreshPresets();
      } catch (e) {
        toast(errorMessage(e), "danger");
        return;
      }
    }
    close();
    await spawnCustom(projectId, exe.trim(), args, shell, name.trim() || undefined);
  };

  return (
    <Dialog
      open
      onClose={close}
      title="Custom command"
      width={520}
      footer={
        <>
          <label className="mr-auto flex items-center gap-2 text-[12px] text-body">
            <input type="checkbox" checked={save} onChange={(e) => setSave(e.target.checked)} className="accent-accent" />
            Save as preset
          </label>
          <Button variant="outline" onClick={close}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!exe.trim() || !projectId} onClick={() => void run()}>
            Run
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        <Field label="Display name" htmlFor="cc-name">
          <Input id="cc-name" value={name} placeholder="Optional" onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Executable" htmlFor="cc-exe" hint={<ResolveHint exe={exe} resolved={resolved} wsl={shell === "wsl"} />}>
          <Input id="cc-exe" mono autoFocus value={exe} placeholder="pnpm" onChange={(e) => setExe(e.target.value)} />
        </Field>
        <Field label="Arguments" htmlFor="cc-args" hint="Each argument is passed to the process as-is, never joined into a shell string.">
          <ArgsInput id="cc-args" value={args} onChange={setArgs} />
        </Field>
        <Field label="Run through" htmlFor="cc-shell">
          <Select id="cc-shell" value={shell} onChange={(e) => setShell(e.target.value)}>
            <option value="direct">Direct (no shell)</option>
            {shells
              .filter((s) => s.available)
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                  {s.preview ? " (preview)" : ""}
                </option>
              ))}
          </Select>
        </Field>
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

export function useResolved(exe: string): string | null | undefined {
  const [resolved, setResolved] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    if (!exe.trim()) {
      setResolved(undefined);
      return;
    }
    const t = window.setTimeout(() => {
      void ipc.resolveExecutable(exe).then(setResolved).catch(() => setResolved(null));
    }, 250);
    return () => window.clearTimeout(t);
  }, [exe]);
  return resolved;
}

export function ResolveHint({ exe, resolved, wsl }: { exe: string; resolved: string | null | undefined; wsl?: boolean }) {
  if (wsl) return <>Resolved inside WSL when the session starts.</>;
  if (!exe.trim() || resolved === undefined) return <>A name on PATH or a full path.</>;
  if (resolved === null) return <span className="text-danger-soft">Not found on PATH</span>;
  return (
    <span className="flex items-center gap-1.5">
      <svg viewBox="0 0 24 24" aria-hidden="true" className="size-[13px] text-run">
        <path d="M20 6 9 17l-5-5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="square" />
      </svg>
      Resolves to <span className="truncate font-mono">{resolved}</span>
    </span>
  );
}
