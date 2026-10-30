import { useEffect, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Plus } from "lucide-react";
import { refreshPresets } from "@/app/actions";
import { set, toast, useApp } from "@/app/store";
import { Button } from "@/components/ui/button";
import { ArgsInput, Field, FieldLabel, Input, Select, Switch } from "@/components/ui/form";
import { Availability } from "@/components/ui/status";
import { ResolveHint, useResolved } from "@/features/terminals/SessionDialogs";
import { errorMessage, ipc } from "@/lib/ipc";
import type { Preset, PresetInput } from "@/lib/types";
import { cn, pad2 } from "@/lib/utils";

const blank = (): PresetInput => ({
  displayName: "",
  executable: "",
  args: [],
  shellProfile: "direct",
  workingDir: null,
  enabled: true,
});

export function PresetsSection() {
  const presets = useApp((s) => s.presets);
  const selectedId = useApp((s) => s.settingsPresetId);
  const selected = presets.find((p) => p.id === selectedId) ?? null;
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (!selectedId && !creating && presets[0]) set({ settingsPresetId: presets[0].id });
  }, [selectedId, creating, presets]);

  const toggle = async (p: Preset, enabled: boolean) => {
    try {
      await ipc.savePreset({ ...p, enabled });
      await refreshPresets();
    } catch (e) {
      toast(errorMessage(e), "danger");
    }
  };

  return (
    <div className="flex max-w-[1080px] flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1.5">
          <span className="font-mono text-[11px] text-accent">▸ CONFIG // COMMANDS</span>
          <h1 className="glow-text m-0 font-display text-[30px] font-bold tracking-[0.1em] uppercase">Saved commands</h1>
          <p className="m-0 text-[13px] text-body">
            Commands you start in a project terminal with one click or Alt 1–9. They run as ordinary terminal sessions in the project root by default. AI agents run in Chat.
          </p>
        </div>
        <Button
          onClick={() => {
            setCreating(true);
            set({ settingsPresetId: null });
          }}
        >
          <Plus className="size-4 text-accent" />
          Custom command
        </Button>
      </div>

      <div className="flex flex-wrap items-start gap-5">
        <div className="flex min-w-0 flex-[1_1_380px] flex-col border border-line bg-surface">
          {presets.length === 0 && <div className="px-3.5 py-3 text-muted">No presets yet.</div>}
          {presets.map((p, i) => {
            const on = p.id === selectedId && !creating;
            return (
              <div
                key={p.id}
                className={cn(
                  "flex items-center gap-3 px-3.5 py-3",
                  i > 0 && "border-t border-line",
                  on && "bg-accent/8 shadow-[inset_0_0_0_1px_rgba(77,163,255,0.45)]",
                )}
              >
                <button
                  className="flex min-w-0 flex-1 flex-col gap-[3px] border-0 bg-transparent p-0 text-left"
                  onClick={() => {
                    setCreating(false);
                    set({ settingsPresetId: p.id });
                  }}
                >
                  <span className={cn("truncate font-semibold", !p.enabled && "text-term")}>
                    {p.displayName}
                  </span>
                  <span className="truncate font-mono text-[11px] text-muted">
                    &gt; {[p.executable, ...p.args].join(" ")}
                  </span>
                </button>
                <Availability found={!!p.resolvedPath} wsl={p.shellProfile === "wsl"} />
                <Switch checked={p.enabled} label={`Enable ${p.displayName}`} onChange={(v) => void toggle(p, v)} />
              </div>
            );
          })}
        </div>

        {creating ? (
          <PresetForm
            key="new"
            index={presets.length + 1}
            initial={blank()}
            onDone={(id) => {
              setCreating(false);
              set({ settingsPresetId: id });
            }}
            onCancel={() => setCreating(false)}
          />
        ) : selected ? (
          <PresetForm
            key={selected.id}
            index={presets.indexOf(selected) + 1}
            initial={selected}
            onDone={() => {}}
            onCancel={() => {}}
          />
        ) : null}
      </div>
    </div>
  );
}

function PresetForm({
  index,
  initial,
  onDone,
  onCancel,
}: {
  index: number;
  initial: PresetInput;
  onDone: (id: string) => void;
  onCancel: () => void;
}) {
  const shells = useApp((s) => s.shells);
  const [form, setForm] = useState<PresetInput>(initial);
  const [subfolder, setSubfolder] = useState(!!initial.workingDir);
  const resolved = useResolved(form.shellProfile === "wsl" ? "" : form.executable);
  const patch = (p: Partial<PresetInput>) => setForm((f) => ({ ...f, ...p }));
  const changed = JSON.stringify(form) !== JSON.stringify(initial) || subfolder !== !!initial.workingDir;

  const save = async () => {
    try {
      const saved = await ipc.savePreset({ ...form, workingDir: subfolder ? form.workingDir : null });
      await refreshPresets();
      toast(`Saved ${saved.displayName}`);
      onDone(saved.id);
    } catch (e) {
      toast(errorMessage(e), "danger");
    }
  };

  const remove = async () => {
    if (!form.id) return;
    try {
      await ipc.deletePreset(form.id);
      await refreshPresets();
      set({ settingsPresetId: null });
    } catch (e) {
      toast(errorMessage(e), "danger");
    }
  };

  const browse = async () => {
    const picked = await openDialog({
      multiple: false,
      directory: false,
      title: "Choose executable",
      filters: [{ name: "Programs", extensions: ["exe", "cmd", "bat", "com", "ps1"] }],
    });
    if (typeof picked === "string") patch({ executable: picked });
  };

  return (
    <form
      aria-label="Edit command"
      className="hud flex min-w-0 flex-[1_1_460px] flex-col gap-[18px] border border-line bg-surface p-5"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className="flex items-baseline justify-between">
        <h2 className="m-0 font-display text-[18px] font-bold tracking-[0.12em] uppercase">
          {form.displayName || "New command"}
        </h2>
        <span className="font-mono text-[10.5px] text-muted">COMMAND {pad2(index)}</span>
      </div>

      <Field label="Display name" htmlFor="p-name">
        <Input id="p-name" value={form.displayName} onChange={(e) => patch({ displayName: e.target.value })} />
      </Field>

      <Field
        label="Executable"
        htmlFor="p-exe"
        hint={<ResolveHint exe={form.executable} resolved={resolved} wsl={form.shellProfile === "wsl"} />}
      >
        <div className="flex gap-2">
          <Input
            id="p-exe"
            mono
            value={form.executable}
            placeholder="claude"
            onChange={(e) => patch({ executable: e.target.value })}
            className="flex-1"
          />
          <Button onClick={() => void browse()}>Browse</Button>
        </div>
      </Field>

      <Field label="Arguments" htmlFor="p-arg" hint="Each argument is passed to the process as-is, never joined into a shell string.">
        <ArgsInput id="p-arg" value={form.args} onChange={(args) => patch({ args })} />
      </Field>

      <div className="grid grid-cols-2 gap-3.5">
        <Field label="Shell profile" htmlFor="p-shell">
          <Select id="p-shell" value={form.shellProfile} onChange={(e) => patch({ shellProfile: e.target.value })}>
            <option value="direct">Direct (no shell)</option>
            {shells.map((s) => (
              <option key={s.id} value={s.id} disabled={!s.available}>
                {s.name}
                {s.preview ? " (preview)" : ""}
                {!s.available ? " — not installed" : ""}
              </option>
            ))}
          </Select>
        </Field>
        <fieldset className="m-0 flex flex-col gap-1.5 border-0 p-0">
          <FieldLabel as="legend">Working directory</FieldLabel>
          <label className="flex h-[22px] items-center gap-2">
            <input type="radio" name="cwd" checked={!subfolder} onChange={() => setSubfolder(false)} className="m-0 accent-accent" />
            Project root
          </label>
          <label className="flex h-[22px] items-center gap-2">
            <input type="radio" name="cwd" checked={subfolder} onChange={() => setSubfolder(true)} className="m-0 accent-accent" />
            Subfolder…
          </label>
          {subfolder && (
            <Input
              aria-label="Subfolder relative to the project root"
              mono
              placeholder="packages/web"
              value={form.workingDir ?? ""}
              onChange={(e) => patch({ workingDir: e.target.value })}
            />
          )}
        </fieldset>
      </div>

      <div className="flex items-center gap-2 border-t border-line pt-3.5">
        {form.id && (
          <Button variant="danger-ghost" className="px-3" onClick={() => void remove()}>
            Delete command
          </Button>
        )}
        
        <span className="flex-1" />
        <Button
          variant="outline"
          onClick={() => {
            setForm(initial);
            setSubfolder(!!initial.workingDir);
            onCancel();
          }}
        >
          Cancel
        </Button>
        <Button variant="primary" type="submit" disabled={!changed || !form.displayName.trim() || !form.executable.trim()}>
          Save command
        </Button>
      </div>
    </form>
  );
}
