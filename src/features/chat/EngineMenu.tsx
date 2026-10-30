import { useEffect, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { ChevronDown, ChevronUp } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import type { EngineId, EngineInfo } from "@/lib/types";
import { cn } from "@/lib/utils";
import { chooseEngine, composerConfig, openAiSettings, recheckEngines } from "./actions";
import {
  AGENT_MODES,
  chatEngines,
  ENGINE_LABEL,
  engineOn,
  ENGINE_PROVIDER,
  ENGINE_VIA,
  isAgent,
  isValidModelId,
  MODE_META,
  modelLabel,
  modelsFor,
  PROBE_LABEL,
  PROBE_TONE,
} from "./models";
import { setChat, useChat } from "./store";

const TONE: Record<string, string> = { run: "text-run", warn: "text-warn", danger: "text-danger-soft", muted: "text-muted" };

/** Engine availability: the probe for agents; key status for APIs. */
function availability(info: EngineInfo | undefined, engine: EngineId): { label: string; tone: string; usable: boolean } {
  const state = info?.probe.state ?? "unknown";
  return { label: PROBE_LABEL[state], tone: TONE[PROBE_TONE[state]], usable: state === "ready" || state === "unknown" || (!isAgent(engine) && state !== "key_missing" && state !== "key_invalid") };
}

/**
 * Engine and model picker in the composer (Ctrl /). A project offers only
 * coding agents (local runtimes, Plan/Agent); General only direct APIs (Ask).
 */
export function EngineMenu({ projectId }: { projectId: string | null }) {
  const open = useChat((s) => s.menuOpen);
  const engines = useChat((s) => s.engines);
  const prefs = useChat((s) => s.prefs);
  const cfg = useChat(useShallow((s) => composerConfig(s, projectId)));
  const hasMessages = useChat((s) => (cfg.conversation ? (s.messages[cfg.conversation.id]?.length ?? 0) > 0 : false));
  const [focusEngine, setFocusEngine] = useState<EngineId>(cfg.engine);
  const [custom, setCustom] = useState("");
  const inProject = projectId !== null;

  useEffect(() => {
    if (open) {
      setFocusEngine(cfg.engine);
      setCustom("");
    }
  }, [open, cfg.engine]);

  const info = (e: EngineId) => engines.find((x) => x.engine === e);
  const shown = chatEngines(inProject).filter((e) => engineOn(engines, e));
  const focusOn = engineOn(engines, focusEngine) && chatEngines(inProject).includes(focusEngine);
  const models = focusOn ? modelsFor(focusEngine, info(focusEngine), prefs) : [];
  const bound = !!cfg.conversation && hasMessages && isAgent(cfg.engine);
  const lockNote = bound
    ? `This chat is bound to ${ENGINE_LABEL[cfg.engine]}. Picking another engine starts a new chat; runtime sessions don't move between engines.`
    : cfg.conversation && hasMessages && !isAgent(cfg.engine)
      ? inProject
        ? "This chat uses a direct API from before project chats moved to coding agents. Picking an agent starts a new chat."
        : "Direct APIs switch in place; this chat keeps its history."
      : null;

  const engineRow = (e: EngineId) => {
    const a = availability(info(e), e);
    const selected = e === focusEngine;
    const modes = (info(e)?.capabilities.modes ?? AGENT_MODES)
      .filter((m) => AGENT_MODES.includes(m))
      .map((m) => MODE_META[m].label.toUpperCase())
      .join(" · ");
    return (
      <button
        key={e}
        type="button"
        aria-pressed={selected}
        onClick={() => setFocusEngine(e)}
        className={cn(
          "flex items-center gap-2.5 border-0 px-2 py-[7px] text-left transition-colors duration-150",
          selected ? "bg-accent/10 shadow-[inset_0_0_0_1px_rgba(77,163,255,0.45)]" : "bg-transparent hover:bg-accent/5",
        )}
      >
        <span className={cn("size-1.5 shrink-0", isAgent(e) ? "bg-agent" : "bg-accent")} />
        <span className="flex min-w-0 flex-1 flex-col gap-px">
          <span className="text-[13px] font-medium">{ENGINE_LABEL[e]}</span>
          <span className="truncate font-mono text-[10px] text-muted">
            {ENGINE_VIA[e]}
            {isAgent(e) ? ` · ${modes}` : ""}
          </span>
        </span>
        <span className={cn("font-mono text-[9.5px]", a.tone)}>{a.label}</span>
      </button>
    );
  };

  const pick = (model: string) => {
    chooseEngine(focusEngine, model, projectId);
  };
  const focusInfo = info(focusEngine);
  const focusAvail = availability(focusInfo, focusEngine);

  return (
    <Popover.Root open={open} onOpenChange={(o) => setChat({ menuOpen: o })}>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-haspopup="dialog"
          aria-expanded={open}
          title="Engine and model (Ctrl /)"
          className={cn(
            "flex h-7 max-w-[300px] items-center gap-2 border pr-2 pl-2.5 text-[12px] transition-colors duration-200",
            open ? "border-accent bg-accent/12 shadow-[0_0_10px_rgba(77,163,255,0.25)]" : "border-line bg-accent/[0.06] hover:border-line-strong",
          )}
        >
          <span className={cn("size-1.5 shrink-0", isAgent(cfg.engine) ? "bg-agent" : "bg-accent")} />
          <span className="truncate">{ENGINE_LABEL[cfg.engine]}</span>
          <span className="truncate font-mono text-[10px] text-muted">{modelLabel(cfg.model)}</span>
          {open ? <ChevronUp className="size-[13px] text-accent" /> : <ChevronDown className="size-[13px] text-muted" />}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="top"
          align="start"
          sideOffset={8}
          collisionPadding={12}
          aria-label="Choose engine and model"
          className="hud z-50 w-[420px] border border-accent/45 bg-[rgba(10,17,26,0.98)] shadow-[0_0_40px_rgba(77,163,255,0.14),0_18px_48px_rgba(0,0,0,0.6)] outline-none data-[state=open]:animate-[menu-in_160ms_ease-out]"
        >
          <div className="flex items-center px-3 pt-2.5 pb-1">
            <span className="label-caps text-[11.5px] text-muted">{inProject ? "Coding agents · local" : "Direct API"}</span>
            <span className="flex-1" />
            <span className="font-mono text-[9.5px] text-muted">{inProject ? "PLAN · AGENT" : "ANSWERS ONLY · NO FILE TOOLS"}</span>
          </div>
          {shown.length > 0 ? (
            <div className="flex flex-col gap-0.5 px-1.5">{shown.map(engineRow)}</div>
          ) : (
            <p className="m-0 px-3 pt-1 pb-3 text-[12.5px] leading-[18px] text-muted">
              {inProject ? "All coding agents are turned off." : "All direct APIs are turned off."} Turn one on in Settings › AI integrations.
            </p>
          )}

          {focusOn && (
            <div className="mt-1.5 flex flex-col gap-2 border-t border-line px-3 py-2.5">
              <div className="flex items-center gap-2">
                <span className="label-caps text-[11.5px] text-muted">Model · {ENGINE_LABEL[focusEngine]}</span>
                <span className="flex-1" />
                {focusInfo?.probe.message && !focusAvail.usable && (
                  <span className="truncate font-mono text-[10px] text-warn" title={focusInfo.probe.message}>
                    {focusInfo.probe.message}
                  </span>
                )}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {models.map((m) => {
                  const sel = focusEngine === cfg.engine && m.id === cfg.model;
                  return (
                    <button
                      key={m.id}
                      type="button"
                      aria-pressed={sel}
                      title={m.hint ?? m.id}
                      onClick={() => pick(m.id)}
                      className={cn(
                        "h-[26px] border px-2.5 text-[12px] disabled:opacity-50",
                        sel ? "border-accent/55 bg-accent/14 text-accent" : "border-line bg-transparent text-term hover:border-line-strong",
                      )}
                    >
                      {m.label}
                    </button>
                  );
                })}
              </div>
              <form
                className="flex gap-1.5"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (isValidModelId(custom)) pick(custom.trim());
                }}
              >
                <label htmlFor="custom-model" className="sr-only">
                  Custom model ID
                </label>
                <input
                  id="custom-model"
                  value={custom}
                  onChange={(e) => setCustom(e.target.value)}
                  placeholder="Other model ID"
                  spellCheck={false}
                  autoComplete="off"
                  className="h-[26px] min-w-0 flex-1 border border-line bg-well px-2 font-mono text-[11.5px] outline-none placeholder:text-dim focus:border-accent"
                />
                <button
                  type="submit"
                  disabled={!isValidModelId(custom)}
                  className="h-[26px] border border-line px-2.5 font-display text-[11.5px] font-semibold tracking-[0.12em] uppercase disabled:opacity-40"
                >
                  Use
                </button>
              </form>
              {ENGINE_PROVIDER[focusEngine] === undefined && focusInfo && focusInfo.capabilities.notes[0] && (
                <p className="m-0 text-[11.5px] leading-[17px] text-muted">{focusInfo.capabilities.notes[0]}</p>
              )}
            </div>
          )}
          {lockNote && <p className="m-0 px-3 pb-2.5 text-[11.5px] leading-[17px] text-muted">{lockNote}</p>}
          <div className="flex h-[34px] items-center border-t border-line bg-well px-3 font-mono text-[10px] text-muted">
            <span>CAPABILITIES ARE PROBED AT STARTUP</span>
            <button type="button" onClick={() => void recheckEngines()} className="ml-3 border-0 bg-transparent p-0 font-mono text-[10px] text-accent hover:text-accent-hover">
              RECHECK
            </button>
            <span className="flex-1" />
            <button type="button" onClick={openAiSettings} className="border-0 bg-transparent p-0 font-mono text-[10px] text-accent hover:text-accent-hover">
              MANAGE →
            </button>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
