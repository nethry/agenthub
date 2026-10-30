import { useEffect } from "react";
import { FolderOpen } from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Button, IconButton } from "@/components/ui/button";
import { Switch } from "@/components/ui/form";
import { loadGitInfo, saveGitPrefs, setGitPath } from "@/features/git/actions";
import { useGit } from "@/features/git/store";
import { cn } from "@/lib/utils";
import { Header, Panel, Row } from "./parts";

/** Settings › Git: which git runs, and the co-author trailer default. */
export function GitSection() {
  const info = useGit((s) => s.info);
  const prefs = useGit((s) => s.prefs);
  useEffect(() => {
    void loadGitInfo();
  }, []);

  const browse = async () => {
    const picked = await openDialog({ multiple: false, directory: false, title: "Choose git.exe" });
    if (typeof picked === "string") await setGitPath(picked);
  };

  return (
    <div className="flex flex-col gap-6">
      <Header
        tag="GIT"
        title="Git"
        body="Source control in the Editor runs your installed Git in the project folder. Sign-in goes through Git Credential Manager; AgentHub stores no Git passwords or tokens."
      />
      <Panel>
        <div className="flex items-start gap-4">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="font-semibold">Git executable</span>
            <span className="truncate font-mono text-[11.5px] text-muted" title={info?.path ?? undefined}>
              {info?.path ?? "Not found on PATH"}
            </span>
            {info?.version && <span className="font-mono text-[10.5px] text-muted">{info.version.toUpperCase()}</span>}
            {info?.reason && <span className="text-[12px] text-warn">{info.reason}</span>}
          </div>
          <span
            className={cn(
              "inline-flex h-5 shrink-0 items-center border px-1.5 font-display text-[11px] font-bold tracking-[0.14em] uppercase",
              !info ? "border-line-strong text-muted" : info.ok ? "border-run/45 text-run" : "border-danger/55 text-danger",
            )}
          >
            {!info ? "Checking…" : info.ok ? "Ready" : "Not found"}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={() => void loadGitInfo(true)}>
            Recheck
          </Button>
          <IconButton aria-label="Choose git.exe" bordered size={26} onClick={() => void browse()}>
            <FolderOpen className="size-3.5" />
          </IconButton>
          {info?.overridden && (
            <button type="button" onClick={() => void setGitPath(null)} className="border-0 bg-transparent p-0 font-mono text-[10px] text-muted hover:text-fg">
              USE PATH LOOKUP
            </button>
          )}
          <span className="text-[12px] text-muted">Needs Git 2.41 or newer (Git for Windows).</span>
        </div>
      </Panel>
      <Panel>
        <Row label="Add AI co-author trailer" hint="When staged files include changes an agent made in Chat, commits get “Co-authored-by: <agent>”. You can turn it off per commit.">
          <Switch checked={prefs.coAuthorTrailer} onChange={(v) => void saveGitPrefs({ coAuthorTrailer: v })} label="Add AI co-author trailer" />
        </Row>
        <p className="m-0 border-t border-line pt-3.5 text-[12px] leading-[18px] text-muted">
          Pull fetches, then rebases your local commits onto the upstream and keeps uncommitted work (autostash). Push never forces; a
          rejected push offers Pull &amp; push. Agents never commit or push: you review, stage and commit their changes.
        </p>
      </Panel>
    </div>
  );
}
