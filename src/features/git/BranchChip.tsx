import { useEffect } from "react";
import { GitBranch } from "lucide-react";
import { setView, updateWorkspace } from "@/app/store";
import { cn } from "@/lib/utils";
import { refreshStatus } from "./actions";
import { branchLabel, OPERATION_LABEL } from "./model";
import { useGit } from "./store";

/** Opens the Editor with Source control showing. */
export function showSourceControl(projectId: string) {
  setView(projectId, "editor");
  updateWorkspace(projectId, { sidebar: "scm", filesCollapsed: false });
}

/** Workspace header: `⑂ main ↓1 ↑2`, amber when detached or stopped mid-operation. */
export function BranchChip({ projectId }: { projectId: string }) {
  const status = useGit((s) => s.projects[projectId]?.status ?? null);
  useEffect(() => {
    void refreshStatus(projectId);
  }, [projectId]);
  if (!status || status.state !== "ok") return null;
  const warn = status.head.detached || !!status.operation;
  return (
    <button
      type="button"
      onClick={() => showSourceControl(projectId)}
      title={status.operation ? `${OPERATION_LABEL[status.operation.kind]} in progress · open Source control` : "Open Source control"}
      className={cn(
        "flex h-6 max-w-[260px] shrink-0 items-center gap-1.5 border px-2 font-mono text-[11px] transition-colors duration-200 hover:border-accent/60",
        warn ? "border-warn/55 text-warn" : "border-line text-fg",
      )}
    >
      <GitBranch className="size-3.5 shrink-0" />
      <span className="truncate">{branchLabel(status)}</span>
      {status.upstream && (
        <span className="shrink-0 text-muted">
          ↓{status.behind} ↑{status.ahead}
        </span>
      )}
    </button>
  );
}

/** Editor status bar: branch, sync counts and an operation git stopped in. */
export function GitStatusReadout({ projectId }: { projectId: string }) {
  const status = useGit((s) => s.projects[projectId]?.status ?? null);
  if (!status || status.state !== "ok") return null;
  return (
    <button
      type="button"
      onClick={() => showSourceControl(projectId)}
      title="Source control"
      className={cn("flex min-w-0 items-center gap-3 border-0 bg-transparent p-0 font-mono text-[10.5px] hover:text-fg", status.head.detached ? "text-warn" : "text-muted")}
    >
      <span className="truncate">⑂ {branchLabel(status)}</span>
      {status.upstream && (
        <span className="shrink-0">
          ↓{status.behind} ↑{status.ahead}
        </span>
      )}
      {status.operation && <span className="shrink-0 text-warn">{status.operation.kind === "rebase" ? "REBASING" : `${OPERATION_LABEL[status.operation.kind].toUpperCase()} IN PROGRESS`}</span>}
    </button>
  );
}
