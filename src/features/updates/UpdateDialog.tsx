import { set } from "@/app/store";
import { interruptions, useRunningWork } from "@/app/work";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { ChatMarkdown } from "@/features/chat/ChatMarkdown";
import { cn } from "@/lib/utils";
import { dismissUpdateError, downloadUpdate, installAndRestart, skipVersion } from "./actions";
import { useUpdates } from "./store";

const mb = (n: number) => `${(n / (1024 * 1024)).toFixed(1)} MB`;

/** Update available → downloading → ready to restart. Installing only starts from the confirmed restart step. */
export function UpdateDialog() {
  const { state, info, progress, error } = useUpdates();
  const work = useRunningWork();
  const close = () => set({ dialog: null });
  const lines = interruptions(work, "Restarting");
  const v = info?.version ?? "";

  if (state === "error") {
    return (
      <Dialog
        open
        tone="danger"
        onClose={close}
        title="The update didn't work"
        description={error ?? "Something went wrong."}
        footer={
          <>
            <Button variant="outline" onClick={close}>
              Close
            </Button>
            <Button variant="secondary" onClick={dismissUpdateError}>
              Back
            </Button>
          </>
        }
      />
    );
  }

  if (state === "ready") {
    const saveFirst = async () => {
      const { saveAll } = await import("@/features/editor/models");
      if (await saveAll()) await installAndRestart();
    };
    return (
      <Dialog
        open
        tone={lines.length ? "warn" : "accent"}
        onClose={close}
        title={`Restart to update to v${v}`}
        description={
          lines.length
            ? `The update is downloaded and checked. ${lines.join(" ")} Projects and layout are restored next time.`
            : "The update is downloaded and checked. AgentHub closes and opens again on the new version; projects and layout are restored."
        }
        footer={
          <>
            <Button variant="outline" onClick={close}>
              Later
            </Button>
            {work.unsaved > 0 && (
              <Button variant="secondary" onClick={() => void saveFirst()}>
                Save all and restart
              </Button>
            )}
            <Button variant={lines.length ? "danger" : "primary"} onClick={() => void installAndRestart()}>
              {work.unsaved > 0 ? "Restart without saving" : lines.length ? "Restart and end sessions" : "Restart and update"}
            </Button>
          </>
        }
      />
    );
  }

  if (state === "downloading") {
    const pct = progress?.total ? Math.min(100, Math.round((progress.downloaded / progress.total) * 100)) : null;
    return (
      <Dialog
        open
        onClose={close}
        title={`Downloading v${v}`}
        description="You can keep working. AgentHub restarts only when you say so."
        footer={
          <Button variant="outline" onClick={close}>
            Hide
          </Button>
        }
      >
        <div className="flex flex-col gap-1.5">
          <div
            role="progressbar"
            aria-label="Download progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={pct ?? undefined}
            className="h-2 border border-line bg-well"
          >
            <div
              className={cn("h-full bg-accent hud:shadow-[0_0_8px_#4DA3FF] transition-[width] duration-200", pct === null && "w-1/3 animate-pulse")}
              style={pct === null ? undefined : { width: `${pct}%` }}
            />
          </div>
          <span className="font-mono text-[10.5px] text-muted">
            {pct === null ? `${mb(progress?.downloaded ?? 0)} DOWNLOADED` : `${pct}% · ${mb(progress?.downloaded ?? 0)} OF ${mb(progress?.total ?? 0)}`}
          </span>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog
      open
      onClose={close}
      width={560}
      title={`Update available · v${v}`}
      description={`You have v${info?.currentVersion ?? "?"}. Downloading doesn't restart AgentHub.`}
      footer={
        <>
          <Button variant="outline" onClick={close}>
            Later
          </Button>
          <Button variant="secondary" onClick={() => void skipVersion()}>
            Skip this version
          </Button>
          <Button variant="primary" onClick={() => void downloadUpdate()}>
            Download
          </Button>
        </>
      }
    >
      {info?.notes ? (
        <div className="max-h-[260px] overflow-y-auto border border-line bg-well px-3.5 py-3 text-[12.5px]">
          <ChatMarkdown text={info.notes} />
        </div>
      ) : (
        <p className="m-0 text-[12.5px] text-muted">This release has no notes.</p>
      )}
    </Dialog>
  );
}
