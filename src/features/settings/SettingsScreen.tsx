import { useEffect, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { rescanShells, setDefaultShell, setEditorPrefs, setTerminalPrefs, setUsagePrefs } from "@/app/actions";
import { set, useApp, type SettingsSection } from "@/app/store";
import { Button } from "@/components/ui/button";
import { Field, Kbd, Select, Switch } from "@/components/ui/form";
import { ipc } from "@/lib/ipc";
import type { AppInfo } from "@/lib/types";
import { cn } from "@/lib/utils";
import { PresetsSection } from "./PresetsSection";
import { AiIntegrationsSection, ChatSection } from "./AiIntegrationsSection";
import { GitSection } from "./GitSection";
import { UpdatesPanel } from "./UpdatesPanel";
import { Header, Panel, Row } from "./parts";
import { ThemePicker } from "./ThemePicker";

const SECTIONS: { id: SettingsSection; label: string }[] = [
  { id: "general", label: "General" },
  { id: "appearance", label: "Appearance" },
  { id: "ai", label: "AI integrations" },
  { id: "chat", label: "Chat" },
  { id: "editor", label: "Editor" },
  { id: "git", label: "Git" },
  { id: "terminals", label: "Terminals & shells" },
  { id: "shortcuts", label: "Keyboard shortcuts" },
];

export function SettingsScreen() {
  const section = useApp((s) => s.settingsSection);
  return (
    <div className="flex min-h-0 flex-1">
      <nav
        aria-label="Settings"
        className="flex w-[232px] shrink-0 flex-col gap-0.5 border-r border-line bg-ground/85 px-2.5 py-3.5 font-display text-[13px] font-semibold tracking-[0.12em] uppercase"
      >
        <button
          onClick={() => set({ screen: "workspace" })}
          className="mb-2 flex items-center gap-2 border-0 bg-transparent p-2 text-left text-muted uppercase hover:text-fg"
        >
          <ArrowLeft className="size-4" />
          Back to workspace
        </button>
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            aria-current={s.id === section ? "page" : undefined}
            onClick={() => set({ settingsSection: s.id })}
            className={cn(
              "border px-2.5 py-2 text-left uppercase transition-colors duration-200",
              s.id === section ? "border-accent/45 bg-accent/10 text-accent" : "border-transparent bg-transparent text-term hover:text-fg",
            )}
          >
            {s.label}
          </button>
        ))}
      </nav>
      <main className="min-w-0 flex-1 overflow-auto px-10 py-8">
        {section === "ai" && <AiIntegrationsSection />}
        {section === "chat" && <ChatSection />}
        {section === "general" && <GeneralSection />}
        {section === "appearance" && <AppearanceSection />}
        {section === "terminals" && (
          <div className="flex flex-col gap-10">
            <ShellsSection />
            <PresetsSection />
          </div>
        )}
        {section === "editor" && <EditorSection />}
        {section === "git" && <GitSection />}
        {section === "shortcuts" && <ShortcutsSection />}
      </main>
    </div>
  );
}

function GeneralSection() {
  const shells = useApp((s) => s.shells);
  const defaultShell = useApp((s) => s.defaultShell);
  const [info, setInfo] = useState<AppInfo | null>(null);
  useEffect(() => {
    void ipc.appInfo().then(setInfo).catch(() => {});
  }, []);
  return (
    <div className="flex flex-col gap-6">
      <Header tag="GENERAL" title="General" body="Defaults for new sessions and where AgentHub keeps its own data." />
      <Panel>
        <Field label="Default shell" htmlFor="g-shell" hint="Used by New terminal and Ctrl+Shift+`.">
          <Select id="g-shell" value={defaultShell} onChange={(e) => void setDefaultShell(e.target.value)} className="max-w-[320px]">
            {shells
              .filter((s) => s.available)
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
          </Select>
        </Field>
        <div className="flex flex-col gap-1 border-t border-line pt-3.5 text-[12px] leading-[18px] text-muted">
          <span>
            Projects, chats, saved commands and layout are stored locally in{" "}
            <span className="font-mono break-all text-term">{info?.dataDir ?? "…"}</span>.
          </span>
          <span>Terminal output and credentials are never written to AgentHub's database. Quitting ends running terminals and agent turns.</span>
          {info && <span className="font-mono">AGENTHUB v{info.version} · {info.platform.toUpperCase()}</span>}
        </div>
      </Panel>
      <UpdatesPanel version={info?.version ?? null} />
      <UsageLimitsPanel />
    </div>
  );
}

function UsageLimitsPanel() {
  const prefs = useApp((s) => s.usagePrefs);
  return (
    <Panel>
      <span className="label-caps text-[12px] text-muted">
        Usage limits <span className="text-accent">//</span>
      </span>
      <Row label="Warn at" hint="Meters turn amber from here.">
        <Select
          aria-label="Warn at"
          value={prefs.warnAt}
          onChange={(e) => {
            const warnAt = Number(e.target.value);
            void setUsagePrefs({ warnAt, alertAt: Math.max(prefs.alertAt, warnAt) });
          }}
        >
          {[50, 60, 70, 75, 80, 85, 90].map((n) => (
            <option key={n} value={n}>
              {n}%
            </option>
          ))}
        </Select>
      </Row>
      <Row label="Alert at" hint="One notification per window when usage passes this.">
        <Select aria-label="Alert at" value={prefs.alertAt} onChange={(e) => void setUsagePrefs({ alertAt: Number(e.target.value) })}>
          {[80, 85, 90, 95, 98, 100]
            .filter((n) => n >= prefs.warnAt)
            .map((n) => (
              <option key={n} value={n}>
                {n}%
              </option>
            ))}
        </Select>
      </Row>
      <p className="m-0 border-t border-line pt-3.5 text-[12px] leading-[18px] text-muted">
        OpenAI (Codex) plan windows come from <span className="font-mono text-term">codex app-server</span>, which uses Codex's own sign-in;
        AgentHub checks every 5 minutes, when you open the details, and live while a Codex chat runs. Claude Agent uses an API key (no
        plan windows) and Gemini reports none — their token usage shows under each answer.
      </p>
    </Panel>
  );
}

function AppearanceSection() {
  const term = useApp((s) => s.terminalPrefs);
  const reduced = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  return (
    <div className="flex flex-col gap-6">
      <Header tag="APPEARANCE" title="Appearance" body="Theme for the whole app. Changes apply instantly and are saved for this computer." />
      <Panel>
        <div className="flex flex-col gap-2.5">
          <span className="font-semibold">Theme</span>
          <ThemePicker />
        </div>
        <div className="border-t border-line" />
        <Row label="Motion" hint="Follows the Windows “Animation effects” setting.">
          <span className="font-mono text-[12px] text-muted">{reduced ? "REDUCED" : "FULL · 180–280 MS"}</span>
        </Row>
        <div className="border-t border-line" />
        <Row label="Terminal font size" hint="JetBrains Mono. Focus mode always uses 14 px.">
          <Select
            aria-label="Terminal font size"
            value={term.fontSize}
            onChange={(e) => void setTerminalPrefs({ fontSize: Number(e.target.value) })}
          >
            {[11, 12, 13, 14, 15, 16].map((n) => (
              <option key={n} value={n}>
                {n} px
              </option>
            ))}
          </Select>
        </Row>
        <Row label="Terminal scrollback" hint="Lines kept per session while AgentHub runs.">
          <Select
            aria-label="Terminal scrollback"
            value={term.scrollback}
            onChange={(e) => void setTerminalPrefs({ scrollback: Number(e.target.value) })}
          >
            {[1000, 5000, 10000, 25000].map((n) => (
              <option key={n} value={n}>
                {n.toLocaleString()}
              </option>
            ))}
          </Select>
        </Row>
      </Panel>
    </div>
  );
}

function ShellsSection() {
  const shells = useApp((s) => s.shells);
  const defaultShell = useApp((s) => s.defaultShell);
  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-end justify-between">
        <Header tag="TERMINALS" title="Terminals & shells" body="Shells AgentHub found on this machine. Terminals are for shells and your own commands; AI agents run in Chat." />
        <Button onClick={() => void rescanShells()}>Rescan</Button>
      </div>
      <div className="flex max-w-[720px] flex-col border border-line bg-surface">
        {shells.map((s, i) => (
          <div key={s.id} className={cn("flex items-center gap-3 px-3.5 py-3", i > 0 && "border-t border-line")}>
            <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
              <span className="font-semibold">
                {s.name}
                {s.preview && <span className="ml-2 border border-warn px-[5px] font-mono text-[10px] text-warn">PREVIEW</span>}
              </span>
              <span className="truncate font-mono text-[11px] text-muted">{s.path ?? "Not installed"}</span>
            </span>
            {s.id === defaultShell && <span className="font-mono text-[10.5px] text-muted">DEFAULT</span>}
            <span
              className={cn(
                "font-display text-[11px] font-bold tracking-[0.14em] uppercase",
                s.available ? "text-run" : "text-danger-soft",
              )}
            >
              {s.available ? "Online" : "Not found"}
            </span>
            {s.available && s.id !== defaultShell && (
              <Button size="sm" onClick={() => void setDefaultShell(s.id)}>
                Make default
              </Button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function EditorSection() {
  const prefs = useApp((s) => s.editorPrefs);
  return (
    <div className="flex flex-col gap-6">
      <Header tag="EDITOR" title="Editor" body="Monaco editor preferences for all projects." />
      <Panel>
        <Row label="Font size" hint="JetBrains Mono.">
          <Select aria-label="Editor font size" value={prefs.fontSize} onChange={(e) => void setEditorPrefs({ fontSize: Number(e.target.value) })}>
            {[11, 12, 12.5, 13, 14, 15, 16].map((n) => (
              <option key={n} value={n}>
                {n} px
              </option>
            ))}
          </Select>
        </Row>
        <Row label="Word wrap">
          <Switch checked={prefs.wordWrap} label="Word wrap" onChange={(v) => void setEditorPrefs({ wordWrap: v })} />
        </Row>
        <Row label="Minimap">
          <Switch checked={prefs.minimap} label="Minimap" onChange={(v) => void setEditorPrefs({ minimap: v })} />
        </Row>
      </Panel>
    </div>
  );
}

export const SHORTCUTS: [string, string][] = [
  ["Command palette / search chats, files, commands", "CTRL K"],
  ["Palette from the editor: files / commands", "CTRL P / CTRL SHIFT P"],
  ["Explorer: rename / delete", "F2 / DEL"],
  ["Settings", "CTRL ,"],
  ["Open existing folder as project", "CTRL O"],
  ["Create new project folder", "CTRL SHIFT N"],
  ["Chat: new chat", "CTRL N"],
  ["Chat: engine and model", "CTRL /"],
  ["Chat: toggle conversation list", "CTRL B"],
  ["Chat: focus mode", "CTRL SHIFT F"],
  ["Chat: send / new line", "ENTER / SHIFT ENTER"],
  ["Chat: stop the turn", "ESC"],
  ["New terminal (default shell)", "CTRL SHIFT `"],
  ["Run saved command 1–9", "ALT 1–9"],
  ["Close active terminal", "CTRL SHIFT W"],
  ["Save file", "CTRL S"],
  ["Terminal copy / paste", "CTRL SHIFT C / V"],
  ["Terminal focus mode: switch session", "CTRL 1–9"],
  ["Exit terminal focus mode", "SHIFT ESC"],
  ["Palette: open in focus mode", "CTRL ↵"],
];

function ShortcutsSection() {
  return (
    <div className="flex flex-col gap-6">
      <Header tag="KEYS" title="Keyboard shortcuts" body="Shortcuts work everywhere, including inside terminals and the editor." />
      <div className="flex max-w-[720px] flex-col border border-line bg-surface">
        {SHORTCUTS.map(([label, keys], i) => (
          <div key={label} className={cn("flex items-center justify-between px-3.5 py-2.5", i > 0 && "border-t border-line")}>
            <span>{label}</span>
            <Kbd>{keys}</Kbd>
          </div>
        ))}
      </div>
    </div>
  );
}
