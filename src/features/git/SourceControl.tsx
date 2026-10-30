import { useEffect, useState, type KeyboardEvent, type ReactNode } from "react";
import { AlertTriangle, Check, GitBranch, Minus, PanelLeftClose, Plus, RefreshCw, Undo2 } from "lucide-react";
import { openFile } from "@/app/actions";
import { updateWorkspace, useApp } from "@/app/store";
import { Button, IconButton } from "@/components/ui/button";
import { useNow } from "@/lib/hooks";
import type { GitEntry, GitStatus } from "@/lib/types";
import { basename, cn, dirname } from "@/lib/utils";
import {
  abortOperation,
  askDiscard,
  cancelAbort,
  cancelGitOperation,
  commit,
  continueOperation,
  discardFile,
  fetchRemotes,
  pull,
  pullAndPush,
  push,
  refreshStatus,
  saveAllForGit,
  setBanner,
  setMessage,
  setTrailer,
  stageAll,
  stageAllAndCommit,
  stageFiles,
  toggleAmend,
  trustFolder,
  unstageAll,
  unstageFiles,
} from "./actions";
import {
  branchLabel,
  commitBlocker,
  discardCopy,
  files,
  groups,
  letter,
  LETTER_TITLE,
  LETTER_TONE,
  OPERATION_LABEL,
  shortHash,
  stagedAgents,
  subjectLength,
  syncLine,
  type Area,
} from "./model";
import { projectGit, useGit, type ProjectGit } from "./store";

/** `FILES | SOURCE CONTROL (n)` at the top of the Editor sidebar. */
export function SidebarSwitch({ projectId }: { projectId: string }) {
  const side = useApp((s) => s.workspaces[projectId]?.sidebar ?? "files");
  const count = useGit((s) => s.projects[projectId]?.status?.entries.length ?? 0);
  const tab = (id: "files" | "scm", label: string, extra?: ReactNode) => (
    <button
      type="button"
      role="tab"
      aria-selected={side === id}
      onClick={() => updateWorkspace(projectId, { sidebar: id })}
      className={cn(
        "flex h-[30px] items-center justify-center gap-1.5 border-0 font-display text-[11.5px] font-bold tracking-[0.14em] uppercase transition-colors duration-200",
        id === "files" ? "flex-1" : "flex-[1.5] border-l border-line",
        side === id ? "bg-accent/12 text-accent shadow-[inset_0_-2px_0_#4DA3FF]" : "bg-transparent text-muted hover:text-fg",
      )}
    >
      {label}
      {extra}
    </button>
  );
  return (
    <div role="tablist" aria-label="Sidebar" className="mx-2.5 mt-2.5 flex shrink-0 border border-line">
      {tab("files", "Files")}
      {tab(
        "scm",
        "Source control",
        count > 0 && <span className="flex h-4 min-w-4 items-center justify-center bg-accent px-1 font-mono text-[9.5px] font-normal tracking-normal text-on-accent">{count}</span>,
      )}
    </div>
  );
}

/** Editor sidebar › Source control: sync, commit box, conflicts, staged and unstaged changes. */
export function SourceControl({ projectId, width }: { projectId: string; width: number }) {
  const g = useGit((s) => projectGit(s, projectId));
  useEffect(() => {
    void refreshStatus(projectId);
  }, [projectId]);
  return <SourceControlView projectId={projectId} width={width} g={g} />;
}

/** The sidebar for one project's git state (read once by `SourceControl`, passed down). */
export function SourceControlView({ projectId, width, g }: { projectId: string; width: number; g: ProjectGit }) {
  const s = g.status;

  return (
    <section aria-label="Source control" style={{ width }} className="hud flex shrink-0 flex-col border border-line bg-surface">
      <SidebarSwitch projectId={projectId} />
      {!s ? (
        <p className="m-0 px-3.5 py-4 font-mono text-[10.5px] text-muted">READING GIT STATUS…</p>
      ) : s.state !== "ok" ? (
        <NotARepo projectId={projectId} status={s} g={g} />
      ) : (
        <Repo projectId={projectId} status={s} g={g} />
      )}
    </section>
  );
}

function NotARepo({ projectId, status, g }: { projectId: string; status: GitStatus; g: ProjectGit }) {
  const busy = g.busy;
  const text =
    status.state === "none"
      ? "This project folder isn't in a Git repository. Run git init or clone in a terminal, then come back."
      : status.state === "unsafe"
        ? `Git doesn't trust this folder: it belongs to another user or drive. Trusting it adds ${status.trustPath} to your global safe.directory list.`
        : (status.message ?? "Git isn't installed.");
  return (
    <div className="flex flex-col gap-3 px-3.5 py-4">
      <span className="label-caps text-[11.5px] text-muted">{status.state === "no_git" ? "Git not found" : status.state === "unsafe" ? "Untrusted folder" : "Not a Git repository"}</span>
      <p className="m-0 text-[12.5px] leading-[19px] text-body">{text}</p>
      <div className="flex flex-wrap gap-2">
        {status.state === "unsafe" && status.trustPath && (
          <Button size="sm" variant="primary" disabled={!!busy} onClick={() => void trustFolder(projectId, status.trustPath!)}>
            Trust this folder
          </Button>
        )}
        <Button size="sm" onClick={() => void refreshStatus(projectId)}>
          Check again
        </Button>
      </div>
    </div>
  );
}

function Repo({ projectId, status: s, g }: { projectId: string; status: GitStatus; g: ProjectGit }) {
  const now = useNow(30_000);
  const gr = groups(s.entries);
  const detached = s.head.detached;
  const pushLabel = !s.upstream && !detached ? "Publish" : "Push";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-col gap-2 border-b border-line px-2.5 pt-2.5 pb-2">
        <div className="flex gap-1.5">
          <div
            title={detached ? "Detached HEAD" : "Current branch"}
            className={cn("flex h-[30px] min-w-0 flex-1 items-center gap-2 border bg-surface px-2.5 font-mono text-[12px]", detached ? "border-warn/55 text-warn" : "border-line")}
          >
            <GitBranch className="size-3.5 shrink-0" />
            <span className="truncate">{branchLabel(s)}</span>
          </div>
          <IconButton aria-label="Fetch from all remotes" title="Fetch from all remotes" bordered size={30} disabled={!!g.busy} onClick={() => void fetchRemotes(projectId)}>
            <RefreshCw className={cn("size-3.5", g.busy === "fetch" && "animate-[spin_0.9s_linear_infinite]")} />
          </IconButton>
          <IconButton aria-label="Collapse sidebar" size={30} onClick={() => updateWorkspace(projectId, { filesCollapsed: true })}>
            <PanelLeftClose className="size-3.5" />
          </IconButton>
        </div>
        <div className="flex gap-1.5">
          <SyncButton
            label="Pull"
            count={`↓${s.behind}`}
            title={s.upstream ? `Pull from ${s.upstream} (rebase, keeps your uncommitted work)` : "Publish the branch first"}
            tone={s.behind > 0 ? "text-warn" : undefined}
            spinning={g.busy === "pull"}
            disabled={!!g.busy || !s.upstream || detached}
            onClick={() => void pull(projectId)}
          />
          <SyncButton
            label={pushLabel}
            count={s.upstream ? `↑${s.ahead}` : ""}
            title={pushLabel === "Publish" ? (s.remotes.length ? `Push this branch to ${s.remotes.includes("origin") ? "origin" : s.remotes[0]} and track it` : "This repository has no remote") : `Push to ${s.upstream}`}
            tone={s.ahead > 0 ? "text-accent" : undefined}
            spinning={g.busy === "push" || g.busy === "publish"}
            disabled={!!g.busy || detached || (pushLabel === "Publish" && !s.remotes.length)}
            onClick={() => void push(projectId)}
          />
        </div>
        <span className={cn("truncate font-mono text-[10px]", s.upstreamGone ? "text-warn" : "text-muted")} title={s.upstream ?? undefined}>
          {syncLine(s, now)}
        </span>
        {g.busy && g.busy !== "commit" && (
          <span className="flex items-center gap-2 font-mono text-[10px] text-accent">
            <span className="min-w-0 flex-1 truncate">{(g.progress ?? `${g.busy.toUpperCase()}…`).toUpperCase()}</span>
            {(g.busy === "fetch" || g.busy === "pull" || g.busy === "push" || g.busy === "publish") && (
              <button type="button" onClick={() => cancelGitOperation(projectId)} className="border-0 bg-transparent p-0 font-mono text-[10px] text-muted hover:text-fg">
                CANCEL
              </button>
            )}
          </span>
        )}
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto py-2.5">
        {g.banner && <Banner projectId={projectId} g={g} />}
        {s.operation && <OperationBanner projectId={projectId} status={s} g={g} conflicts={gr.conflicts.length} />}
        {s.truncated && (
          <p className="m-0 px-3 text-[12px] text-warn">Only the first 50,000 changes are listed. Add build output to .gitignore.</p>
        )}
        <CommitBox projectId={projectId} status={s} g={g} />
        {gr.conflicts.length > 0 && (
          <FileList projectId={projectId} g={g} area="conflicts" title={`Conflicts · ${gr.conflicts.length}`} entries={gr.conflicts} status={s} />
        )}
        <FileList
          projectId={projectId}
          g={g}
          area="staged"
          title={`Staged changes · ${gr.staged.length}`}
          entries={gr.staged}
          status={s}
          action={gr.staged.length > 0 && { label: "UNSTAGE ALL", run: () => void unstageAll(projectId) }}
          empty={s.entries.length > 0 ? "Nothing staged. Click + on a file to stage it." : null}
        />
        <FileList
          projectId={projectId}
          g={g}
          area="changes"
          title={`Changes · ${gr.changes.length}`}
          entries={gr.changes}
          status={s}
          action={gr.changes.length > 0 && { label: "STAGE ALL", run: () => void stageAll(projectId) }}
          empty={
            s.entries.length === 0 ? (
              <span className="flex items-center gap-2 text-run">
                <Check className="size-3.5" />
                Working tree clean
              </span>
            ) : null
          }
        />
      </div>
    </div>
  );
}

function SyncButton(p: { label: string; count: string; title: string; tone?: string; spinning: boolean; disabled: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      title={p.title}
      disabled={p.disabled}
      onClick={p.onClick}
      className={cn(
        "flex h-7 flex-1 items-center justify-center gap-1.5 border border-line bg-accent/[0.05] font-display text-[12px] font-semibold tracking-[0.12em] uppercase transition-colors duration-200 hover:border-accent/60 disabled:cursor-not-allowed disabled:opacity-45",
        p.tone,
      )}
    >
      {p.spinning && <RefreshCw className="size-3 animate-[spin_0.9s_linear_infinite]" />}
      {p.label}
      {p.count && <span className="font-mono text-[10.5px] tracking-normal">{p.count}</span>}
    </button>
  );
}

function Banner({ projectId, g }: { projectId: string; g: ProjectGit }) {
  const b = g.banner;
  const busy = g.busy;
  const [open, setOpen] = useState(false);
  if (!b) return null;
  return (
    <div
      role="alert"
      className={cn("mx-2.5 flex flex-col gap-2 border px-3 py-2.5 text-[12.5px] leading-[18px]", b.tone === "danger" ? "border-danger/50 bg-danger/[0.06]" : "hud hud-warn border-warn/50 bg-warn/[0.05]")}
    >
      <span>
        <span className={cn("font-semibold", b.tone === "danger" ? "text-danger" : "text-warn")}>{b.title}</span> <span className="text-body">{b.text}</span>
      </span>
      {b.detail && (
        <>
          <button type="button" onClick={() => setOpen((v) => !v)} className="self-start border-0 bg-transparent p-0 font-mono text-[10px] text-muted hover:text-fg">
            {open ? "HIDE GIT OUTPUT" : "SHOW GIT OUTPUT"}
          </button>
          {open && <pre className="m-0 max-h-[160px] overflow-auto bg-well p-2 font-mono text-[10.5px] leading-[16px] whitespace-pre-wrap text-term">{b.detail}</pre>}
        </>
      )}
      <div className="flex gap-1.5">
        {b.action === "pullAndPush" && (
          <Button size="sm" variant="primary" disabled={!!busy} onClick={() => void pullAndPush(projectId)}>
            Pull &amp; push
          </Button>
        )}
        {b.action === "saveAll" && (
          <Button size="sm" variant="primary" onClick={() => void saveAllForGit(projectId)}>
            Save all
          </Button>
        )}
        <Button size="sm" onClick={() => setBanner(projectId, null)}>
          Dismiss
        </Button>
      </div>
    </div>
  );
}

/** A pull (or a terminal) left a rebase/merge waiting: fix files in the editor, then Continue or Abort. */
function OperationBanner({ projectId, status: s, g, conflicts }: { projectId: string; status: GitStatus; g: ProjectGit; conflicts: number }) {
  const op = s.operation!;
  const label = OPERATION_LABEL[op.kind];
  const step = op.step && op.total ? ` · step ${op.step} of ${op.total}` : "";
  const hard = s.entries.some((e) => e.conflict && (e.conflict !== "UU" && e.conflict !== "AA"));
  return (
    <div role="alert" className="hud hud-warn mx-2.5 flex flex-col gap-2 border border-warn/50 bg-warn/[0.05] px-3 py-2.5">
      <span className="label-caps text-[11.5px] text-warn">
        {op.kind === "rebase" ? "Pull stopped" : `${label} stopped`}
        {step}
      </span>
      <p className="m-0 text-[12.5px] leading-[18px] text-body">
        {conflicts > 0
          ? `${files(conflicts)} conflict. Fix the conflict markers in the editor, stage the files, then Continue — or Abort to go back.`
          : `Conflicts are staged. Continue to finish the ${label}.`}
        {hard && " Some conflicts (a file deleted on one side, or binary) are easier to resolve in a terminal."}
      </p>
      {g.confirmAbort && (
        <p className="m-0 text-[12px] text-danger-soft">
          Abort the {label}? Your branch goes back to where it was before; conflict fixes so far are lost.
        </p>
      )}
      <div className="flex gap-1.5">
        {!g.confirmAbort && (
          <Button size="sm" variant="primary" disabled={!!g.busy || conflicts > 0} title={conflicts > 0 ? "Stage the fixed files first" : undefined} onClick={() => void continueOperation(projectId)}>
            {g.busy === "continue" ? "Continuing…" : "Continue"}
          </Button>
        )}
        <Button size="sm" variant={g.confirmAbort ? "danger" : "outline"} className={g.confirmAbort ? undefined : "border-danger/55 text-danger"} disabled={!!g.busy} onClick={() => void abortOperation(projectId)}>
          {g.confirmAbort ? `Abort ${label}` : "Abort"}
        </Button>
        {g.confirmAbort && (
          <Button size="sm" onClick={() => cancelAbort(projectId)}>
            Keep going
          </Button>
        )}
      </div>
    </div>
  );
}

function CommitBox({ projectId, status: s, g }: { projectId: string; status: GitStatus; g: ProjectGit }) {
  const gr = groups(s.entries);
  const agents = stagedAgents(s.ai, gr.staged);
  const blocker = commitBlocker(s, gr, g.amend);
  const len = subjectLength(g.msg);
  const branch = s.head.detached ? "HEAD" : (s.head.branch ?? "HEAD");
  const amendAllowed = !s.headPushed && !s.head.unborn;
  const committing = g.busy === "commit";
  const blocked = !!blocker || committing || !!g.busy;
  const label = committing ? "Committing…" : g.amend ? `Amend ${shortHash(s.head.oid)}` : `Commit ${files(gr.staged.length)} to ${branch}`;

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && e.ctrlKey) {
      e.preventDefault();
      void commit(projectId, e.shiftKey);
    }
  };

  return (
    <div className="mx-2.5 flex flex-col gap-2">
      <div className={cn("hud flex flex-col border bg-surface", g.msgErr ? "border-danger/60" : "border-line focus-within:border-accent/60")}>
        <label htmlFor={`commit-${projectId}`} className="sr-only">
          Commit message
        </label>
        <textarea
          id={`commit-${projectId}`}
          rows={3}
          value={g.msg}
          placeholder={`Message (Ctrl Enter to commit on ${branch})`}
          onChange={(e) => setMessage(projectId, e.target.value)}
          onKeyDown={onKey}
          className="block w-full resize-y border-0 bg-transparent px-2.5 pt-2 font-mono text-[12px] leading-[18px] outline-none placeholder:text-dim"
        />
        <div className="flex h-6 items-center justify-end px-2.5">
          <span className={cn("font-mono text-[9.5px]", len > 72 ? "text-warn" : "text-dim")} title="Subject line length (72 recommended)">
            {len}/72
          </span>
        </div>
      </div>
      {g.msgErr && (
        <span role="alert" className="font-mono text-[10.5px] text-danger">
          {g.msgErr}
        </span>
      )}
      <Check2
        checked={g.amend}
        disabled={!amendAllowed}
        onChange={() => void toggleAmend(projectId)}
        label="Amend last commit"
        note={s.head.unborn ? "NO COMMITS YET" : amendAllowed ? shortHash(s.head.oid) : "LAST COMMIT IS PUSHED"}
      />
      {agents.length > 0 && (
        <Check2
          checked={g.trailer}
          onChange={() => setTrailer(projectId, !g.trailer)}
          label="Add AI co-author trailer"
          note={agents.map((a) => a.engineLabel.toUpperCase()).join(", ")}
          noteTone="text-agent"
          title={agents.map((a) => `Co-authored-by: ${a.engineLabel}`).join("\n")}
        />
      )}
      <div className="flex h-8 gap-px">
        <button
          type="button"
          disabled={blocked}
          onClick={() => void commit(projectId)}
          className="chamfer flex-1 truncate border-0 bg-accent px-3 font-display text-[12.5px] font-bold tracking-[0.14em] text-on-accent uppercase transition-[filter] duration-200 hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-45"
        >
          {label}
        </button>
        <button
          type="button"
          title="Commit & push (Ctrl Shift Enter)"
          disabled={blocked || s.head.detached}
          onClick={() => void commit(projectId, true)}
          className="w-[84px] border-0 bg-accent font-display text-[12.5px] font-bold tracking-[0.14em] text-on-accent uppercase hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-45"
        >
          &amp; Push
        </button>
      </div>
      {committing ? (
        <span className="flex items-center gap-2 font-mono text-[10px] text-accent">
          <RefreshCw className="size-3 animate-[spin_0.9s_linear_infinite]" />
          <span className="truncate">{g.progress ? `HOOK · ${g.progress.toUpperCase()}` : "COMMITTING · HOOKS RUN IF THE REPOSITORY HAS ANY"}</span>
        </span>
      ) : (
        blocker && (
          <span className="text-[11.5px] leading-[16px] text-muted">
            {blocker}
            {blocker === "Nothing staged yet." && (
              <>
                {" "}
                <button type="button" onClick={() => void stageAllAndCommit(projectId)} className="border-0 bg-transparent p-0 font-mono text-[10.5px] text-accent hover:text-accent-hover">
                  STAGE ALL &amp; COMMIT
                </button>
              </>
            )}
          </span>
        )
      )}
    </div>
  );
}

function Check2(p: { checked: boolean; disabled?: boolean; onChange: () => void; label: string; note: string; noteTone?: string; title?: string }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={p.checked}
      aria-disabled={p.disabled}
      title={p.title}
      onClick={p.onChange}
      className={cn("flex items-center gap-2 border-0 bg-transparent p-0 text-left text-[12px]", p.disabled ? "text-dim" : "text-body hover:text-fg")}
    >
      <span className={cn("size-3 shrink-0 border", p.checked ? "border-accent bg-accent shadow-[inset_0_0_0_2px_#0A111A]" : "border-line-strong")} />
      <span>{p.label}</span>
      <span className={cn("ml-auto truncate font-mono text-[9.5px]", p.noteTone ?? "text-muted")}>{p.note}</span>
    </button>
  );
}

function FileList(p: {
  projectId: string;
  g: ProjectGit;
  area: Area;
  title: string;
  entries: GitEntry[];
  status: GitStatus;
  action?: false | { label: string; run: () => void };
  empty?: ReactNode;
}) {
  return (
    <section aria-label={p.title} className="flex flex-col">
      <div className="flex h-6 items-center px-3.5">
        <span className={cn("label-caps text-[11px]", p.area === "conflicts" ? "text-danger" : "text-muted")}>{p.title}</span>
        <span className="flex-1" />
        {p.action && (
          <button type="button" onClick={p.action.run} className="border-0 bg-transparent p-0 font-mono text-[10px] text-accent hover:text-accent-hover">
            {p.action.label}
          </button>
        )}
      </div>
      {p.entries.map((e) => (
        <ChangeRow key={`${p.area}:${e.path}`} projectId={p.projectId} ask={p.g.ask} entry={e} area={p.area} status={p.status} />
      ))}
      {p.entries.length === 0 && p.empty && <p className="m-0 px-3.5 py-1 text-[12px] leading-[17px] text-muted">{p.empty}</p>}
    </section>
  );
}

function ChangeRow({ projectId, ask, entry: e, area, status }: { projectId: string; ask: ProjectGit["ask"]; entry: GitEntry; area: Area; status: GitStatus }) {
  const L = letter(e, area);
  const ai = status.ai.find((a) => a.path === e.path);
  const name = basename(e.path);
  const dir = dirname(e.path);
  const deleted = L === "D";
  const open = () => {
    if (e.projectPath && !deleted) openFile(projectId, e.projectPath);
  };
  const asking = ask?.path === e.path && ((ask.kind === "discard" && area === "changes") || (ask.kind === "markers" && area === "conflicts"));
  const copy = discardCopy(e);

  return (
    <div className="mx-1.5 flex flex-col">
      <div className="group flex h-[30px] items-center gap-2 px-2 hover:bg-accent/5">
        <span className={cn("w-3 shrink-0 font-mono text-[11px]", LETTER_TONE[L] ?? "text-muted")} title={LETTER_TITLE[L]}>
          {L}
        </span>
        <button
          type="button"
          onClick={open}
          disabled={!e.projectPath || deleted}
          title={e.origPath ? `${e.origPath} → ${e.path}` : e.path}
          className="flex min-w-0 flex-1 items-baseline gap-1.5 border-0 bg-transparent p-0 text-left disabled:cursor-default"
        >
          <span className={cn("shrink-0 truncate text-[12.5px]", deleted ? "text-muted line-through" : "text-fg")}>{name}</span>
          <span className="min-w-0 truncate font-mono text-[10px] text-muted">{dir}</span>
        </button>
        {ai && (
          <span className="shrink-0 border border-agent/50 px-1 font-mono text-[9.5px] text-agent" title={`Changed by ${ai.engineLabel} in Chat`}>
            AI
          </span>
        )}
        {e.partiallyStaged && area !== "conflicts" && (
          <span className="shrink-0 font-mono text-[9.5px] text-warn" title="Some changes are staged, some aren't">
            PART
          </span>
        )}
        <span className="flex shrink-0 gap-0.5 opacity-60 group-focus-within:opacity-100 group-hover:opacity-100">
          {area === "changes" && (
            <IconButton aria-label={e.untracked ? `Delete untracked ${name}` : `Discard changes to ${name}`} title={e.untracked ? "Delete untracked file" : "Discard changes"} size={24} onClick={() => askDiscard(projectId, e.path)}>
              <Undo2 className="size-3.5" />
            </IconButton>
          )}
          {area === "staged" ? (
            <IconButton aria-label={`Unstage ${name}`} title="Unstage" size={24} onClick={() => void unstageFiles(projectId, [e.path])}>
              <Minus className="size-3.5" />
            </IconButton>
          ) : (
            <IconButton aria-label={`Stage ${name}`} title={area === "conflicts" ? "Mark as fixed (stage)" : "Stage"} size={24} onClick={() => void stageFiles(projectId, [e.path])}>
              <Plus className="size-3.5" />
            </IconButton>
          )}
        </span>
      </div>
      {asking && (
        <div role="alertdialog" aria-label={ask.kind === "discard" ? "Confirm discard" : "Confirm staging with conflict markers"} className="mx-2 mb-1 flex flex-col gap-2 border border-danger/50 bg-danger/[0.05] px-2.5 py-2">
          <span className="flex items-start gap-1.5 text-[12px] leading-[17px] text-body">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-danger" />
            {ask.kind === "discard" ? copy.text : `${name} still has conflict markers (<<<<<<<). Stage it anyway?`}
          </span>
          <div className="flex justify-end gap-1.5">
            <Button size="sm" onClick={() => askDiscard(projectId, null)}>
              Cancel
            </Button>
            {ask.kind === "discard" ? (
              <Button size="sm" variant="danger" onClick={() => void discardFile(projectId, e.path)}>
                {copy.action}
              </Button>
            ) : (
              <Button size="sm" variant="primary" onClick={() => void stageFiles(projectId, [e.path], true)}>
                Stage anyway
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
