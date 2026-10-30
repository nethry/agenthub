import { MotionConfig } from "motion/react";
import { useApp } from "./store";
import { useGlobalShortcuts } from "./shortcuts";
import { TitleBar } from "./TitleBar";
import { GeneralWorkspace, Workspace } from "./Workspace";
import { Dialogs, Toasts } from "./Dialogs";
import { ProjectRail } from "@/features/projects/ProjectRail";
import { Welcome } from "@/features/projects/Welcome";
import { FocusMode } from "@/features/terminals/FocusMode";
import { CommandPalette } from "@/features/palette/CommandPalette";
import { SettingsScreen } from "@/features/settings/SettingsScreen";

export function App() {
  useGlobalShortcuts();
  const ready = useApp((s) => s.ready);
  const screen = useApp((s) => s.screen);
  const focusSessionId = useApp((s) => s.focusSessionId);
  const activeProjectId = useApp((s) => s.activeProjectId);
  const workspace = useApp((s) => s.workspace);
  const hasProjects = useApp((s) => s.projects.length > 0);

  let body: React.ReactNode;
  if (!ready) {
    body = (
      <div className="flex flex-1 items-center justify-center font-mono text-[11px] text-muted">
        <span className="text-accent">▸</span>&nbsp;INITIALIZING…
      </div>
    );
  } else if (screen === "settings") {
    body = <SettingsScreen />;
  } else {
    body = (
      <div className="flex min-h-0 flex-1">
        <ProjectRail />
        {workspace === "general" ? (
          <GeneralWorkspace />
        ) : hasProjects && activeProjectId ? (
          <Workspace projectId={activeProjectId} />
        ) : (
          <Welcome />
        )}
      </div>
    );
  }

  return (
    <MotionConfig reducedMotion="user">
      <div className="gridbg flex h-full flex-col bg-ground">
        {ready && focusSessionId ? (
          <FocusMode sessionId={focusSessionId} />
        ) : (
          <>
            <TitleBar search={ready} />
            {body}
          </>
        )}
      </div>
      {ready && (
        <>
          <CommandPalette />
          <Dialogs />
        </>
      )}
      <Toasts />
    </MotionConfig>
  );
}
