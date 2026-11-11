import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, Eye, EyeOff, FolderOpen, RotateCcw, Trash2, X } from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { prefillTerminal } from "@/app/actions";
import { toast, useApp } from "@/app/store";
import { Button, IconButton } from "@/components/ui/button";
import { FieldLabel, Input, Select, Switch } from "@/components/ui/form";
import { useNow } from "@/lib/hooks";
import { errorMessage, ipc } from "@/lib/ipc";
import type { ApprovalPolicy, ChatProvider, EngineId, EngineInfo, ProviderStatus } from "@/lib/types";
import { cn, relativeAgo } from "@/lib/utils";
import { ensureChatLoaded, recheckEngines, setChatPrefs, setEngineEnabled } from "@/features/chat/actions";
import {
  AGENT_ENGINES,
  AGENT_MODES,
  API_ENGINES,
  DEFAULT_MODEL,
  ENGINE_LABEL,
  engineOn,
  ENGINE_VIA,
  isValidModelId,
  MODE_META,
  MODE_ORDER,
  modelsFor,
  POLICY_HINT,
  POLICY_LABEL,
  POLICY_ORDER,
  PROBE_LABEL,
  PROBE_TONE,
  PROVIDER_LABEL,
  PROVIDER_ORDER,
} from "@/features/chat/models";
import { setChat, useChat } from "@/features/chat/store";
import { Header } from "./parts";

const ANTHROPIC_MAX = { min: 256, max: 128000 };
const TONE: Record<string, string> = { run: "border-run/45 text-run", warn: "border-warn/55 text-warn", danger: "border-danger/55 text-danger", muted: "border-line-strong text-muted" };

/**
 * How to install or sign in to each runtime. Terminal commands are only
 * prefilled, never run for you; `googleSignIn` runtimes sign in from here.
 */
const SETUP: Record<string, { install: string | null; signIn: string | null; googleSignIn?: boolean; hint: string }> = {
  "claude-code": {
    install: "npm install -g @anthropic-ai/claude-code",
    signIn: null,
    hint: "Runs through the Claude Agent SDK with your Anthropic API key (add it under Direct API). Uses the installed Claude Code if found, else the SDK's own copy. Needs Node.js 20.19+.",
  },
  codex: { install: "npm install -g @openai/codex", signIn: "codex login", hint: "Uses Codex's own sign-in (ChatGPT plan or API key)." },
  "gemini-cli": {
    install: "npm install -g @google/gemini-cli",
    signIn: null,
    hint: "Uses your Gemini API key (add it under Gemini API below). Personal Google accounts can't sign in to Gemini CLI any more: use Antigravity.",
  },
  antigravity: {
    install: null,
    signIn: null,
    googleSignIn: true,
    hint: "Google's Antigravity ACP server, signed in with your Google account. Download it from the Agent Client Protocol registry (antigravity-acp), unzip it, then add its folder to PATH or choose agy_acp_server here.",
  },
  "copilot-cli": { install: "npm install -g @github/copilot", signIn: "copilot", hint: "Run copilot in a terminal, then /login. Needs a Copilot subscription." },
};

const OFF_NOTE = "Turned off. AgentHub doesn't check or start it, and its chats, models and usage are hidden until you turn it back on. Nothing is deleted.";

function setStatus(status: ProviderStatus) {
  setChat((s) => ({ providers: { ...s.providers, [status.provider]: status } }));
  void ipc.chatEngines().then((engines) => setChat({ engines })).catch(() => {});
}

/** Settings › AI integrations: local coding-agent runtimes, direct-API keys, what each mode may do. */
export function AiIntegrationsSection() {
  const loaded = useChat((s) => s.loaded);
  useEffect(() => {
    void ensureChatLoaded();
  }, []);
  return (
    <div className="flex flex-col gap-[22px]">
      <div className="flex items-end gap-4">
        <Header
          tag="AI INTEGRATIONS"
          title="AI integrations"
          body="Coding agents run locally in your project folder. Direct APIs answer questions only. Capabilities below are detected, not configured. Turn off what you don't use: it's hidden everywhere and never started."
        />
        <span className="flex-1" />
        <Button onClick={() => void recheckEngines()}>
          <RotateCcw className="size-3.5" />
          Recheck all
        </Button>
      </div>
      {loaded && (
        <>
          <AgentsTable />
          <section aria-labelledby="api-h" className="flex max-w-[1100px] flex-col gap-3">
            <div className="flex items-center gap-2.5">
              <h2 id="api-h" className="m-0 font-display text-[14px] font-bold tracking-[0.14em] uppercase">
                Direct API
              </h2>
              <span className="inline-flex h-5 items-center border border-accent/50 px-1.5 font-display text-[11px] font-bold tracking-[0.14em] text-accent uppercase">Ask only</span>
              <span className="font-mono text-[10px] text-muted">NO FILE OR TOOL ACCESS · AVAILABLE IN GENERAL</span>
            </div>
            <div className="grid grid-cols-[repeat(auto-fit,minmax(min(420px,100%),1fr))] items-start gap-4">
              {PROVIDER_ORDER.map((p) => (
                <ProviderCard key={p} provider={p} />
              ))}
            </div>
            <p className="m-0 text-[12px] leading-[18px] text-muted">
              Keys are written to Windows Credential Manager only — never to AgentHub's database, logs or exported settings. The UI only
              ever shows the last four characters.
            </p>
          </section>
          <div className="grid max-w-[1100px] grid-cols-[repeat(auto-fit,minmax(min(460px,100%),1fr))] items-start gap-4">
            <CapabilityMatrix />
            <DefaultPolicy />
          </div>
        </>
      )}
    </div>
  );
}

function AgentsTable() {
  const engines = useChat((s) => s.engines);
  const now = useNow(60_000);
  const on = engines.filter((e) => e.kind === "agent" && e.enabled);
  const probedAt = Math.max(0, ...on.map((e) => e.probe.probedAt ?? 0));
  return (
    <section aria-labelledby="agents-h" className="hud flex max-w-[1100px] flex-col border border-line bg-surface">
      <div className="flex items-center gap-2.5 border-b border-line px-4 py-3">
        <h2 id="agents-h" className="m-0 font-display text-[14px] font-bold tracking-[0.14em] uppercase">
          Coding agents · local
        </h2>
        <span className="font-mono text-[10px] text-muted">
          {engines.length > 0 && on.length === 0 ? "ALL TURNED OFF" : probedAt > 0 ? `PROBED ${relativeAgo(probedAt, now).toUpperCase()}` : "CHECKING…"}
        </span>
      </div>
      {AGENT_ENGINES.map((e, i) => (
        <AgentRow key={e} info={engines.find((x) => x.engine === e)} engine={e} first={i === 0} />
      ))}
      <p className="m-0 border-t border-line-dim px-4 py-2.5 text-[12px] leading-[18px] text-muted">
        AgentHub starts runtimes with argument lists in your project folder — never through a shell string — and answers every
        permission request with your approval policy. Agent sessions are separate from terminals; you can still run any of these CLIs
        yourself in a terminal.
      </p>
    </section>
  );
}

function AgentRow({ info, engine, first }: { info: EngineInfo | undefined; engine: EngineId; first: boolean }) {
  const projectId = useApp((s) => s.activeProjectId);
  const [busy, setBusy] = useState(false);
  const state = info?.probe.state ?? "unknown";
  const setup = SETUP[engine];
  const modes = info?.capabilities.modes ?? [];

  const browse = async () => {
    const picked = await openDialog({ multiple: false, directory: false, title: `Choose the ${ENGINE_LABEL[engine]} executable` });
    if (typeof picked !== "string") return;
    setBusy(true);
    try {
      setChat({ engines: await ipc.chatSetEnginePath(engine, picked) });
    } catch (e) {
      toast(errorMessage(e), "danger");
    } finally {
      setBusy(false);
    }
  };
  const clearPath = async () => setChat({ engines: await ipc.chatSetEnginePath(engine, null).catch(() => getEngines()) });

  const [signingIn, setSigningIn] = useState(false);
  const [signInError, setSignInError] = useState<string | null>(null);
  const signIn = async () => {
    setSigningIn(true);
    setSignInError(null);
    try {
      setChat({ engines: await ipc.chatEngineSignIn(engine) });
      toast(`${ENGINE_LABEL[engine]} is signed in`);
    } catch (e) {
      setSignInError(errorMessage(e));
      setChat({ engines: await getEngines().catch(() => []) });
    } finally {
      setSigningIn(false);
    }
  };

  const enabled = info?.enabled ?? true;
  const row = cn("grid grid-cols-[minmax(150px,1fr)_120px_minmax(180px,1.4fr)_auto] items-start gap-3 px-4 py-3", !first && "border-t border-line-dim");
  const name = (
    <span className="flex items-center gap-2.5">
      <Switch checked={enabled} onChange={(v) => void setEngineEnabled(engine, v)} label={`Use ${ENGINE_LABEL[engine]}`} />
      <span className="font-semibold">{ENGINE_LABEL[engine]}</span>
    </span>
  );

  if (!enabled) {
    return (
      <div className={row}>
        <div className="flex flex-col gap-1">
          {name}
          <span className="font-mono text-[10.5px] text-muted">{ENGINE_VIA[engine]}</span>
        </div>
        <div>
          <span className={cn("inline-flex h-5 items-center border px-1.5 font-display text-[11px] font-bold tracking-[0.14em] uppercase", TONE.muted)}>Off</span>
        </div>
        <span className="text-[12px] leading-[17px] text-muted">{OFF_NOTE}</span>
        <span />
      </div>
    );
  }

  return (
    <div className={row}>
      <div className="flex flex-col gap-1">
        {name}
        <span className="font-mono text-[10.5px] text-muted">{ENGINE_VIA[engine]}</span>
        <span className="font-mono text-[11px]">
          {AGENT_MODES.map((m, i) => (
            <span key={m} title={modes.includes(m) ? MODE_META[m].hint : info?.capabilities.unsupported.find(([x]) => x === m)?.[1]}>
              {i > 0 && <span className="text-muted"> · </span>}
              <span style={{ color: modes.includes(m) ? MODE_META[m].color : undefined }} className={modes.includes(m) ? "" : "text-dim line-through"}>
                {MODE_META[m].label.toUpperCase()}
              </span>
            </span>
          ))}
        </span>
      </div>
      <div className="flex flex-col items-start gap-1">
        <span className={cn("inline-flex h-5 items-center border px-1.5 font-display text-[11px] font-bold tracking-[0.14em] uppercase", TONE[PROBE_TONE[state]])}>
          {PROBE_LABEL[state]}
        </span>
        {info?.probe.version && <span className="font-mono text-[10px] text-muted">{info.probe.version}</span>}
        {info?.probe.account && <span className="text-[12px] text-body">{info.probe.account}</span>}
      </div>
      <div className="flex min-w-0 flex-col gap-1">
        <span className="truncate font-mono text-[11px] text-muted" title={info?.probe.path ?? undefined}>
          {info?.probe.path ?? (state === "not_found" ? "Not found on PATH" : "—")}
        </span>
        {info?.probe.message && state !== "ready" && <span className="text-[12px] text-warn">{info.probe.message}</span>}
        {signingIn && <span className="text-[12px] text-body">Finish signing in in your browser. AgentHub waits up to 5 minutes.</span>}
        {signInError && (
          <span role="alert" className="flex items-center gap-1.5 text-[12px] text-danger-soft">
            <AlertTriangle className="size-[13px]" />
            {signInError}
          </span>
        )}
        <span className="text-[12px] leading-[17px] text-muted">{setup.hint}</span>
        {(info?.capabilities.notes ?? []).slice(1).map((n) => (
          <span key={n} className="text-[11.5px] leading-[16px] text-muted">
            · {n}
          </span>
        ))}
      </div>
      <div className="flex flex-col items-end gap-1.5">
        <div className="flex gap-1.5">
          <Button size="sm" disabled={busy} onClick={() => void recheckEngines(engine)}>
            Recheck
          </Button>
          <IconButton aria-label={`Choose the ${ENGINE_LABEL[engine]} executable`} bordered size={26} onClick={() => void browse()}>
            <FolderOpen className="size-3.5" />
          </IconButton>
        </div>
        {info?.probe.path && (
          <button type="button" onClick={() => void clearPath()} className="border-0 bg-transparent p-0 font-mono text-[10px] text-muted hover:text-fg">
            USE PATH LOOKUP
          </button>
        )}
        {state === "not_found" && setup.install && projectId && (
          <button type="button" onClick={() => void prefillTerminal(projectId, setup.install!)} className="border-0 bg-transparent p-0 font-mono text-[10px] text-accent hover:text-accent-hover">
            INSTALL IN A TERMINAL →
          </button>
        )}
        {state === "sign_in_needed" && setup.googleSignIn && !signingIn && (
          <Button variant="primary" size="sm" onClick={() => void signIn()}>
            Sign in with Google
          </Button>
        )}
        {signingIn && (
          <Button variant="outline" size="sm" onClick={() => void ipc.chatEngineCancelSignIn(engine).catch(() => {})}>
            Cancel sign-in
          </Button>
        )}
        {state === "sign_in_needed" && setup.signIn && projectId && (
          <Button variant="primary" size="sm" onClick={() => void prefillTerminal(projectId, setup.signIn!)}>
            Sign in in terminal
          </Button>
        )}
      </div>
    </div>
  );
}

async function getEngines() {
  return ipc.chatEngines();
}

function StateChip({ status }: { status: ProviderStatus | undefined }) {
  const base = "inline-flex items-center gap-1.5 border px-[7px] py-px font-display text-[11px] font-bold tracking-[0.14em]";
  if (!status?.hasKey) return <span className={cn(base, "border-line-strong text-muted")}><span className="size-[5px] border border-muted" />NO KEY</span>;
  switch (status.state) {
    case "ok":
      return <span className={cn(base, "border-run/45 bg-run/8 text-run")}><span className="size-[5px] bg-run hud:shadow-[0_0_6px_#3DF5A0]" />CONNECTED</span>;
    case "invalid":
      return <span className={cn(base, "border-danger/50 bg-danger/8 text-danger")}><X className="icon-strong size-[11px]" />KEY INVALID</span>;
    case "error":
      return <span className={cn(base, "border-warn/50 bg-warn/8 text-warn")}><AlertTriangle className="size-[11px]" />NOT VERIFIED</span>;
    default:
      return <span className={cn(base, "border-line-strong text-muted")}><span className="size-[5px] bg-muted" />KEY SAVED</span>;
  }
}

const KEY_PLACEHOLDER: Record<ChatProvider, string> = { anthropic: "Paste key (sk-ant-…)", openai: "Paste key (sk-…)", gemini: "Paste key (AIza…)" };
const PROVIDER_ENGINE: Record<ChatProvider, EngineId> = { anthropic: "anthropic-api", openai: "openai-api", gemini: "gemini-api" };
/** Coding agents that run on a direct-API key. */
const KEY_SHARED_WITH: Partial<Record<ChatProvider, EngineId>> = { anthropic: "claude-code", gemini: "gemini-cli" };

function ProviderCard({ provider }: { provider: ChatProvider }) {
  const status = useChat((s) => s.providers[provider]);
  const prefs = useChat((s) => s.prefs);
  const info = useChat((s) => s.engines.find((e) => e.engine === PROVIDER_ENGINE[provider]));
  const now = useNow(30_000);
  const [replacing, setReplacing] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [busy, setBusy] = useState<"save" | "test" | "remove" | "models" | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The key stays in the DOM input only (uncontrolled), never in React state.
  const keyRef = useRef<HTMLInputElement>(null);
  const [showKey, setShowKey] = useState(false);
  const [customDraft, setCustomDraft] = useState("");
  const [listed, setListed] = useState<string[] | null>(null);

  const engine = PROVIDER_ENGINE[provider];
  const label = PROVIDER_LABEL[provider];
  const id = `p-${provider}`;
  const enabled = info?.enabled ?? true;
  // The key stays editable while an agent that runs on it is on.
  const sharedWith = KEY_SHARED_WITH[provider];
  const sharedOn = useChat((s) => !!sharedWith && engineOn(s.engines, sharedWith));
  const needsKey = enabled || sharedOn;
  const invalid = needsKey && status?.state === "invalid";
  const editing = !status?.hasKey || replacing || invalid;
  const model = prefs.models[engine] ?? DEFAULT_MODEL[engine];
  const custom = prefs.customModels[engine] ?? [];

  const save = async () => {
    const key = keyRef.current?.value ?? "";
    if (!key.trim()) {
      setError("Paste an API key first.");
      return;
    }
    setBusy("save");
    setError(null);
    try {
      const st = await ipc.chatSaveKey(provider, key, model);
      if (keyRef.current) keyRef.current.value = "";
      setShowKey(false);
      setStatus(st);
      setReplacing(false);
      if (st.state !== "ok") setError(st.message);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const test = async () => {
    setBusy("test");
    setError(null);
    try {
      const st = await ipc.chatTestConnection(provider, model);
      setStatus(st);
      if (st.state !== "ok") setError(st.message);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    setBusy("remove");
    try {
      setStatus(await ipc.chatRemoveKey(provider));
      setError(null);
      setConfirmRemove(false);
      toast(`${label} key removed from Windows Credential Manager`);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const listModels = async () => {
    setBusy("models");
    setError(null);
    try {
      setListed((await ipc.chatApiModels(provider)).map((m) => m.id));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const models = modelsFor(engine, info, prefs);
  const options = [...models.map((m) => m.id), ...(listed ?? []).filter((x) => !models.some((m) => m.id === x))];
  const addCustom = () => {
    const v = customDraft.trim();
    if (!isValidModelId(v)) {
      setError("Model IDs use letters, digits and - _ . : / @ (up to 128 characters).");
      return;
    }
    setError(null);
    setCustomDraft("");
    setChatPrefs({
      customModels: { ...prefs.customModels, [engine]: custom.includes(v) ? custom : [...custom, v] },
      models: { ...prefs.models, [engine]: v },
    });
  };

  const okLine =
    status?.hasKey && !editing
      ? [
          `ENDS IN …${status.keyHint ?? "????"}`,
          status.state === "ok" && status.checkedAt ? `VERIFIED ${relativeAgo(status.checkedAt, now).toUpperCase()}` : null,
          status.state === "ok" && status.message && status.message !== "Connected" ? status.message.toUpperCase() : null,
        ]
          .filter(Boolean)
          .join(" · ")
      : null;
  const shownError = error ?? (invalid || status?.state === "error" ? status?.message : null);

  const removeControl = confirmRemove ? (
    <>
      <Button variant="danger" disabled={busy !== null} onClick={() => void remove()}>
        Remove key
      </Button>
      <Button variant="outline" onClick={() => setConfirmRemove(false)}>
        Keep
      </Button>
    </>
  ) : (
    <IconButton aria-label={`Remove ${label} key`} bordered size={34} className="text-danger-soft hover:text-danger" onClick={() => setConfirmRemove(true)}>
      <Trash2 className="size-4" />
    </IconButton>
  );

  return (
    <section aria-labelledby={id} className={cn("hud flex flex-col gap-4 border bg-surface p-5", invalid ? "hud-danger border-danger/50" : "border-line")}>
      <div className="flex items-center gap-2.5">
        <Switch checked={enabled} onChange={(v) => void setEngineEnabled(engine, v)} label={`Use ${ENGINE_LABEL[engine]}`} />
        <h3 id={id} className="m-0 flex-1 font-display text-[18px] font-bold tracking-[0.12em] uppercase">
          {ENGINE_LABEL[engine]}
        </h3>
        {needsKey ? (
          <StateChip status={status} />
        ) : (
          <span className={cn("inline-flex h-5 items-center border px-1.5 font-display text-[11px] font-bold tracking-[0.14em] uppercase", TONE.muted)}>Off</span>
        )}
      </div>
      {enabled && provider === "anthropic" && <p className="m-0 -mt-2 text-[12px] text-muted">Also used by Claude Agent (Claude Agent SDK).</p>}
      {!enabled && (
        <p className="m-0 -mt-2 text-[12px] leading-[18px] text-muted">
          {sharedOn && sharedWith
            ? `Turned off for chats: its chats and models are hidden. The key stays here because ${ENGINE_LABEL[sharedWith]} runs on it.`
            : "Turned off: its chats and models are hidden and it's never called. A saved key stays in Windows Credential Manager."}
        </p>
      )}

      {needsKey && (
        <div className="flex flex-col gap-1.5">
          <FieldLabel htmlFor={`${id}-key`}>{editing && status?.hasKey ? "New API key" : "API key"}</FieldLabel>
          {editing ? (
            <div className="flex gap-2">
              <div className="relative min-w-0 flex-1">
                <input
                  id={`${id}-key`}
                  ref={keyRef}
                  type={showKey ? "text" : "password"}
                  placeholder={KEY_PLACEHOLDER[provider]}
                  autoComplete="off"
                  spellCheck={false}
                  aria-invalid={!!shownError || undefined}
                  aria-describedby={shownError ? `${id}-err` : undefined}
                  onKeyDown={(e) => e.key === "Enter" && void save()}
                  className={cn(
                    "h-[34px] w-full border bg-well pr-[38px] pl-2.5 font-mono text-[12px] outline-none transition-[border-color,box-shadow] duration-200 placeholder:text-dim focus:border-accent hud:focus:shadow-[0_0_12px_rgba(77,163,255,0.3)] graphite:focus:shadow-[0_0_0_3px_var(--color-accent-subtle)]",
                    shownError ? "border-danger hud:shadow-[0_0_10px_rgba(255,84,112,0.25)]" : "border-line",
                  )}
                />
                <IconButton aria-label={showKey ? "Hide key" : "Show key"} size={30} className="absolute top-0.5 right-0.5" onClick={() => setShowKey((v) => !v)}>
                  {showKey ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </IconButton>
              </div>
              <Button variant="primary" disabled={busy !== null} onClick={() => void save()}>
                {busy === "save" ? "Testing…" : "Save & test"}
              </Button>
              {replacing && !invalid && (
                <Button variant="outline" onClick={() => setReplacing(false)}>
                  Cancel
                </Button>
              )}
              {invalid && removeControl}
            </div>
          ) : (
            <div className="flex gap-2">
              <input
                id={`${id}-key`}
                readOnly
                value={`••••••••••••••••${status?.keyHint ?? ""}`}
                aria-label={`${label} API key, ends in ${status?.keyHint ?? "unknown"}`}
                className="h-[34px] min-w-0 flex-1 border border-line bg-well px-2.5 font-mono text-[12px] tracking-[0.1em] text-body outline-none"
              />
              <Button onClick={() => setReplacing(true)}>Replace</Button>
              {removeControl}
            </div>
          )}
          {confirmRemove && <span className="text-[12px] text-danger-soft">Chats can't use {label} until you add a key again. Your chats stay.</span>}
          {shownError ? (
            <span id={`${id}-err`} role="alert" className="flex items-center gap-1.5 text-[12px] text-danger-soft">
              <AlertTriangle className="size-[13px]" />
              {shownError}
            </span>
          ) : (
            okLine && <span className="font-mono text-[10.5px] text-muted">{okLine}</span>
          )}
        </div>
      )}

      {enabled && (
        <>
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <FieldLabel htmlFor={`${id}-model`}>Default model</FieldLabel>
              <Select id={`${id}-model`} value={model} onChange={(e) => setChatPrefs({ models: { ...prefs.models, [engine]: e.target.value } })}>
                {options.map((m) => (
                  <option key={m} value={m}>
                    {models.find((x) => x.id === m)?.label ?? m}
                  </option>
                ))}
              </Select>
            </div>
            <div className="flex items-end gap-2">
              <Button variant="outline" className="h-[34px] flex-1" disabled={!status?.hasKey || busy !== null} onClick={() => void test()}>
                <Check className="size-3.5 text-run" />
                {busy === "test" ? "Testing…" : "Test"}
              </Button>
              <Button variant="outline" className="h-[34px] flex-1" disabled={!status?.hasKey || busy !== null} onClick={() => void listModels()}>
                {busy === "models" ? "Loading…" : listed ? `${listed.length} models` : "List models"}
              </Button>
            </div>
            <div className="flex flex-col gap-1.5">
              <FieldLabel htmlFor={`${id}-custom`}>Add model ID</FieldLabel>
              <div className="flex gap-2">
                <Input id={`${id}-custom`} mono value={customDraft} onChange={(e) => setCustomDraft(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addCustom()} className="flex-1" />
                <Button onClick={addCustom} disabled={!customDraft.trim()}>
                  Add
                </Button>
              </div>
            </div>
            {provider === "anthropic" && (
              <div className="flex flex-col gap-1.5">
                <FieldLabel htmlFor={`${id}-max`}>Max output tokens</FieldLabel>
                <MaxTokensInput id={`${id}-max`} />
              </div>
            )}
          </div>

          {custom.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="font-mono text-[10.5px] text-muted">CUSTOM:</span>
              {custom.map((m) => (
                <span key={m} className="inline-flex h-[22px] items-center gap-1 border border-accent/40 bg-accent/8 pr-1 pl-2 font-mono text-[12px]">
                  {m}
                  <button
                    type="button"
                    aria-label={`Remove model ${m}`}
                    className="flex size-[18px] items-center justify-center border-0 bg-transparent p-0 text-muted hover:text-fg"
                    onClick={() =>
                      setChatPrefs({
                        customModels: { ...prefs.customModels, [engine]: custom.filter((x) => x !== m) },
                        models: model === m ? { ...prefs.models, [engine]: DEFAULT_MODEL[engine] } : prefs.models,
                      })
                    }
                  >
                    <X className="size-3" />
                  </button>
                </span>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}

function MaxTokensInput({ id }: { id: string }) {
  const value = useChat((s) => s.prefs.anthropic.maxTokens);
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const n = Math.round(Number(draft));
    if (!Number.isFinite(n)) return setDraft(String(value));
    const clamped = Math.min(ANTHROPIC_MAX.max, Math.max(ANTHROPIC_MAX.min, n));
    setDraft(String(clamped));
    if (clamped !== value) setChatPrefs({ anthropic: { maxTokens: clamped } });
  };
  return (
    <Input
      id={id}
      mono
      inputMode="numeric"
      value={draft}
      onChange={(e) => setDraft(e.target.value.replace(/[^\d]/g, ""))}
      onBlur={commit}
      onKeyDown={(e) => e.key === "Enter" && commit()}
      title={`${ANTHROPIC_MAX.min}–${ANTHROPIC_MAX.max}. A longer answer stops at this limit.`}
    />
  );
}

const MATRIX: [string, [boolean | string, boolean | string, boolean | string]][] = [
  ["Answer, explain, write code in chat", [true, true, true]],
  ["Read files you @-attach", [true, true, true]],
  ["Search & read project files on its own", [false, "read-only", true]],
  ["Edit, create, delete files", [false, false, "per policy"]],
  ["Run commands / tools", [false, false, "per policy"]],
  ["Ask chats · direct APIs", [true, false, false]],
  ["Project chats · coding agents", [false, true, true]],
];

function CapabilityMatrix() {
  return (
    <section aria-labelledby="matrix-h" className="hud border border-line bg-surface">
      <h2 id="matrix-h" className="m-0 border-b border-line px-4 py-3 font-display text-[14px] font-bold tracking-[0.14em] uppercase">
        What each mode may do
      </h2>
      <table className="w-full border-collapse text-[12.5px]">
        <thead>
          <tr>
            <th className="label-caps border-b border-line px-4 py-2 text-left text-[11px] text-muted">Capability</th>
            {MODE_ORDER.map((m) => (
              <th key={m} className="label-caps border-b border-line px-2.5 py-2 text-left text-[11px]" style={{ color: MODE_META[m].color }}>
                {MODE_META[m].label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {MATRIX.map(([cap, vals]) => (
            <tr key={cap}>
              <td className="border-b border-line-dim px-4 py-2">{cap}</td>
              {vals.map((v, i) => (
                <td key={i} className={cn("border-b border-line-dim px-2.5 py-2", v === true ? "text-run" : v === false ? "text-muted" : "text-warn")}>
                  {v === true ? "✓" : v === false ? "—" : `✓ ${v}`}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="m-0 px-4 py-2.5 text-[12px] leading-[18px] text-muted">
        AgentHub enforces these limits itself on every permission request, whatever a runtime's own modes promise. A mode a runtime can't
        keep within these rules is unavailable for it, with the reason shown.
      </p>
    </section>
  );
}

function DefaultPolicy() {
  const policy = useChat((s) => s.prefs.defaultPolicy);
  return (
    <section aria-labelledby="policy-h" className="hud hud-warn border border-line bg-surface">
      <h2 id="policy-h" className="m-0 border-b border-line px-4 py-3 font-display text-[14px] font-bold tracking-[0.14em] uppercase">
        Default approval policy
      </h2>
      <div role="radiogroup" aria-labelledby="policy-h" className="flex flex-col gap-2 p-4">
        {POLICY_ORDER.map((p) => (
          <PolicyOption key={p} value={p} selected={policy === p} />
        ))}
        <p className="m-0 text-[12px] leading-[18px] text-muted">
          Applies to new Agent conversations; each conversation can change its own policy from the composer. Approvals are never
          remembered beyond a session.
        </p>
      </div>
    </section>
  );
}

function PolicyOption({ value, selected }: { value: ApprovalPolicy; selected: boolean }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={() => setChatPrefs({ defaultPolicy: value })}
      className={cn("flex gap-2.5 border px-2.5 py-2 text-left", selected ? "border-warn/55 bg-warn/[0.05]" : "border-line bg-transparent hover:border-line-strong")}
    >
      <span className={cn("mt-[3px] size-3 shrink-0 border", selected ? "border-warn bg-warn shadow-[inset_0_0_0_3px_var(--color-surface)]" : "border-line-strong")} />
      <span className="flex flex-col gap-0.5">
        <span className="font-semibold">{POLICY_LABEL[value]}</span>
        <span className="text-[12px] text-body">{POLICY_HINT[value]}</span>
      </span>
    </button>
  );
}

// ---------- Settings › Chat ----------

function Segmented<T extends string>({ label, value, options, onChange, mono }: { label: string; value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; mono?: boolean }) {
  return (
    <div role="radiogroup" aria-label={label} className="flex border border-line">
      {options.map((o, i) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(o.value)}
            className={cn(
              "h-[30px] border-0 px-3.5 uppercase transition-colors duration-200",
              mono ? "font-mono text-[11px]" : "font-display text-[12px] font-bold tracking-[0.14em]",
              i > 0 && "border-l border-line",
              on ? "bg-accent/12 text-accent shadow-[inset_0_-2px_0_var(--color-accent)]" : "bg-transparent text-muted hover:text-fg",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

function Line({ title, hint, children, first }: { title: string; hint: string; children: React.ReactNode; first?: boolean }) {
  return (
    <div className={cn("flex items-center gap-4 px-[18px] py-3", !first && "border-t border-line")}>
      <span className="flex flex-1 flex-col gap-0.5">
        <span className="font-semibold">{title}</span>
        <span className="text-[12px] text-muted">{hint}</span>
      </span>
      {children}
    </div>
  );
}

export function ChatSection() {
  const prefs = useChat((s) => s.prefs);
  const engines = useChat((s) => s.engines);
  // Turned-off engines are left out, except the current default (marked off).
  const choices = (list: EngineId[], current: EngineId) => list.filter((e) => e === current || engineOn(engines, e));
  const choiceLabel = (e: EngineId) => `${ENGINE_LABEL[e]}${engineOn(engines, e) ? "" : " · off"}`;
  const loaded = useChat((s) => s.loaded);
  useEffect(() => {
    void ensureChatLoaded();
  }, []);
  return (
    <div className="flex flex-col gap-6">
      <Header tag="CHAT" title="Chat" body="Defaults for new conversations. Each conversation keeps its own engine, model, mode and policy." />
      {loaded && (
        <section className="flex max-w-[860px] flex-col border border-line bg-surface">
          <Line first title="Engine for new project chats" hint="A coding agent; new project chats start in Plan. Falls back to another ready agent when this one isn't available.">
            <Select aria-label="Engine for new project chats" value={prefs.defaultEngine} onChange={(e) => setChatPrefs({ defaultEngine: e.target.value as EngineId })} className="w-[220px]">
              {choices(AGENT_ENGINES, prefs.defaultEngine).map((e) => (
                <option key={e} value={e}>
                  {choiceLabel(e)}
                </option>
              ))}
            </Select>
          </Line>
          <Line title="Engine for Ask chats" hint="Ask chats have no project folder, so only direct APIs.">
            <Select
              aria-label="Engine for Ask chats"
              value={prefs.defaultGeneralEngine}
              onChange={(e) => setChatPrefs({ defaultGeneralEngine: e.target.value as EngineId })}
              className="w-[220px]"
            >
              {choices(API_ENGINES, prefs.defaultGeneralEngine).map((e) => (
                <option key={e} value={e}>
                  {choiceLabel(e)}
                </option>
              ))}
            </Select>
          </Line>
          <Line title="Send message with" hint="The other combination inserts a new line.">
            <Segmented
              label="Send key"
              mono
              value={prefs.sendKey}
              options={[
                { value: "enter", label: "Enter" },
                { value: "ctrlEnter", label: "Ctrl+Enter" },
              ]}
              onChange={(v) => setChatPrefs({ sendKey: v })}
            />
          </Line>
          <p className="m-0 border-t border-line px-[18px] py-3 text-[12px] leading-[18px] text-muted">
            Conversations, messages and agent activity are stored locally in AgentHub's database. Direct APIs receive only the
            conversation text and files you attach. Coding agents work in their project folder within the mode and approval policy you
            choose; their own session data stays in each runtime's usual place.
          </p>
        </section>
      )}
    </div>
  );
}
