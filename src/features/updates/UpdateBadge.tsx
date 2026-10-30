import { Download } from "lucide-react";
import { cn } from "@/lib/utils";
import { openUpdateDialog } from "./actions";
import { updatePending, useUpdates } from "./store";

/** Title bar: shows while a version is waiting; opens the update dialog. */
export function UpdateBadge() {
  const state = useUpdates((s) => s.state);
  const version = useUpdates((s) => s.info?.version);
  if (!updatePending({ state })) return null;
  const label = state === "ready" ? "Restart to update" : state === "downloading" ? "Downloading update" : `Update available: v${version}`;
  return (
    <button
      type="button"
      onClick={openUpdateDialog}
      title={label}
      aria-label={label}
      className={cn(
        "flex h-7 shrink-0 items-center gap-1.5 border px-2.5 font-display text-[12px] font-bold tracking-[0.14em] uppercase transition-colors duration-200",
        state === "ready" ? "border-run/55 bg-run/10 text-run hover:bg-run/15" : "border-accent/50 bg-accent/10 text-accent hover:bg-accent/15",
      )}
    >
      <Download className={cn("size-3.5", state === "downloading" && "animate-pulse")} />
      {state === "ready" ? "Restart" : state === "downloading" ? "Updating" : "Update"}
    </button>
  );
}

/** A dot for the Settings button while a version is waiting. */
export function UpdateDot() {
  const state = useUpdates((s) => s.state);
  if (!updatePending({ state })) return null;
  return <span aria-hidden="true" className="absolute top-[7px] right-[7px] size-[7px] bg-accent shadow-[0_0_6px_#4DA3FF]" />;
}
