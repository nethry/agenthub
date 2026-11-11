import { FolderOpen, FolderPlus } from "lucide-react";
import { openFolderAsProject, openSettings } from "@/app/actions";
import { useEffect } from "react";
import { ensureChatLoaded, recheckEngines } from "@/features/chat/actions";
import { PROBE_LABEL } from "@/features/chat/models";
import { useChat } from "@/features/chat/store";
import { set } from "@/app/store";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/form";
import { cn } from "@/lib/utils";

export function Welcome() {
  const engines = useChat((s) => s.engines);
  const agents = engines.filter((e) => e.kind === "agent" && e.enabled);
  const ready = agents.filter((e) => e.probe.state === "ready").length;
  useEffect(() => {
    void ensureChatLoaded();
  }, []);

  return (
    <main className="relative flex min-w-0 flex-1 overflow-x-hidden overflow-y-auto px-16 pt-[88px] pb-8">
      <Reticle />
      <div className="relative flex w-full max-w-[620px] flex-col gap-[34px]">
        <div className="flex flex-col gap-3">
          <span className="font-mono text-[11px] tracking-[0.08em] text-accent">▸ SYSTEM READY · 0 PROJECTS</span>
          <h1 className="m-0 font-display text-[44px] leading-[46px] font-bold tracking-[0.06em] uppercase hud:[text-shadow:0_0_22px_rgba(77,163,255,0.45)]">
            Add your first project
          </h1>
          <p className="m-0 max-w-[500px] text-[14px] leading-[22px] text-pretty text-body">
            Point AgentHub at a folder on disk. Its files, terminals and layout stay together, and nothing leaves your
            machine.
          </p>
        </div>

        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(260px,100%),1fr))] gap-3">
          <ActionCard
            primary
            icon={<FolderOpen className="size-[22px]" />}
            title="Open existing folder"
            body="Register a repository you already have"
            kbd="CTRL O"
            onClick={() => void openFolderAsProject()}
          />
          <ActionCard
            icon={<FolderPlus className="size-[22px]" />}
            title="Create new folder"
            body="Start an empty project in a location you pick"
            kbd="CTRL SHIFT N"
            onClick={() => set({ dialog: { type: "createProject" } })}
          />
        </div>

        <section aria-labelledby="agents-h" className="flex flex-col gap-2.5">
          <div className="flex items-baseline justify-between">
            <h2 id="agents-h" className="m-0 font-display text-[13px] font-bold tracking-[0.16em] uppercase">
              Connect AI{" "}
              <span className="text-accent">
                // {ready} of {agents.length} coding agents ready
              </span>
            </h2>
            <Button variant="link" size="sm" onClick={() => void recheckEngines()}>
              Recheck
            </Button>
          </div>
          <div className="flex flex-col border border-line bg-overlay/90">
            {agents.map((e, i) => (
              <div key={e.engine} className={cn("flex items-center gap-3 px-3.5 py-[11px]", i > 0 && "border-t border-line")}>
                <span className="w-[130px] shrink-0 truncate font-semibold">{e.label}</span>
                <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-muted" title={e.probe.path ?? e.probe.message ?? undefined}>
                  {e.probe.path ?? e.probe.message ?? ""}
                </span>
                <span className={cn("font-display text-[11px] font-bold tracking-[0.14em]", e.probe.state === "ready" ? "text-run" : e.probe.state === "sign_in_needed" ? "text-warn" : "text-muted")}>
                  {PROBE_LABEL[e.probe.state]}
                </span>
              </div>
            ))}
            <div className="flex items-center gap-3 border-t border-line px-3.5 py-[11px]">
              <span className="flex-1 text-[12.5px] text-body">Or add an API key — OpenAI, Anthropic or Gemini · Ask only</span>
              <Button size="sm" onClick={() => openSettings("ai")}>
                Add key
              </Button>
            </div>
          </div>
          <p className="m-0 text-[12px] leading-[18px] text-muted">
            You can skip this — Chat works with any one of them, and you can change it later in Settings › AI integrations. Coding
            agents run in Chat with your approval; terminals stay plain shells.
          </p>
        </section>

        <div className="flex gap-5 font-mono text-[10.5px] text-muted">
          <span className="flex items-center gap-1.5">
            <Kbd className="px-[5px] py-0">CTRL K</Kbd>COMMAND PALETTE
          </span>
          <span className="flex items-center gap-1.5">
            <Kbd className="px-[5px] py-0">CTRL ,</Kbd>SETTINGS
          </span>
        </div>
      </div>
    </main>
  );
}

function ActionCard({
  primary,
  icon,
  title,
  body,
  kbd,
  onClick,
}: {
  primary?: boolean;
  icon: React.ReactNode;
  title: string;
  body: string;
  kbd: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "hud flex flex-col items-start gap-3.5 border p-5 text-left transition-colors duration-200",
        primary
          ? "border-accent/60 bg-accent/7 hud:shadow-[0_0_26px_rgba(77,163,255,0.16),inset_0_0_30px_rgba(77,163,255,0.06)] hover:bg-accent/10"
          : "border-line bg-surface hover:border-accent/45",
      )}
    >
      <span className="text-accent">{icon}</span>
      <span className="flex flex-col gap-1">
        <span className="font-display text-[17px] font-bold tracking-[0.12em] uppercase">{title}</span>
        <span className="text-[12px] leading-[18px] text-body">{body}</span>
      </span>
      <Kbd className={primary ? "border-accent/45 text-accent" : undefined}>{kbd}</Kbd>
    </button>
  );
}

function Reticle() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 400 400"
      className="pointer-events-none absolute top-20 -right-[60px] size-[560px] fill-none stroke-accent opacity-55"
    >
      <circle cx="200" cy="200" r="190" strokeOpacity="0.18" strokeWidth="1" />
      <circle cx="200" cy="200" r="160" strokeOpacity="0.35" strokeWidth="1" strokeDasharray="2 6" />
      <circle cx="200" cy="200" r="120" strokeOpacity="0.5" strokeWidth="2" strokeDasharray="120 40 30 40" />
      <circle cx="200" cy="200" r="86" strokeOpacity="0.25" strokeWidth="10" strokeDasharray="4 4" />
      <circle cx="200" cy="200" r="54" strokeOpacity="0.7" strokeWidth="1.5" />
      <polygon points="200 166 230 183 230 217 200 234 170 217 170 183" strokeOpacity="0.9" strokeWidth="1.5" />
      <path d="M200 0v40M200 360v40M0 200h40M360 200h40" strokeOpacity="0.4" />
    </svg>
  );
}
