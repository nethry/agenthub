import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/form";
import { checkForUpdates, openUpdateDialog, saveUpdatePrefs } from "@/features/updates/actions";
import { useUpdates } from "@/features/updates/store";
import { useNow } from "@/lib/hooks";
import { cn, relativeAgo } from "@/lib/utils";
import { Panel, Row } from "./parts";

/** Settings › General: version, Check now, and the automatic-check switch. */
export function UpdatesPanel({ version }: { version: string | null }) {
  const { state, info, error, checkedAt, prefs } = useUpdates();
  const now = useNow(30_000);
  const pending = state === "available" || state === "downloading" || state === "ready";
  const status =
    state === "checking"
      ? "Checking…"
      : state === "ready"
        ? `v${info?.version} is downloaded. Restart to install it.`
        : state === "downloading"
          ? `Downloading v${info?.version}…`
          : state === "available"
            ? `v${info?.version} is available.`
            : state === "error"
              ? (error ?? "The last check failed.")
              : checkedAt
                ? `Up to date · checked ${relativeAgo(checkedAt, now)}`
                : version
                  ? `You have v${version}.`
                  : "";

  return (
    <Panel>
      <span className="label-caps text-[12px] text-muted">
        Updates <span className="text-accent">//</span>
      </span>
      <div className="flex items-center gap-3">
        <span className={cn("min-w-0 flex-1 text-[12.5px] leading-[18px]", state === "error" ? "text-danger-soft" : pending ? "text-fg" : "text-body")} role={state === "error" ? "alert" : undefined}>
          {status}
        </span>
        {pending ? (
          <Button size="sm" variant="primary" onClick={openUpdateDialog}>
            {state === "ready" ? "Restart…" : "Details"}
          </Button>
        ) : (
          <Button size="sm" disabled={state === "checking"} onClick={() => void checkForUpdates()}>
            Check now
          </Button>
        )}
      </div>
      <Row label="Check automatically" hint="At start and once a day. Updates are never installed or restarted without your say-so.">
        <Switch checked={prefs.autoCheck} onChange={(v) => void saveUpdatePrefs({ autoCheck: v })} label="Check for updates automatically" />
      </Row>
      {prefs.skipped && (
        <div className="flex items-center gap-3 border-t border-line pt-3.5 text-[12px] text-muted">
          <span className="flex-1">You skipped v{prefs.skipped}. A newer version still shows up.</span>
          <button type="button" onClick={() => void saveUpdatePrefs({ skipped: null })} className="border-0 bg-transparent p-0 font-mono text-[10.5px] text-accent hover:text-accent-hover">
            STOP SKIPPING
          </button>
        </div>
      )}
    </Panel>
  );
}
