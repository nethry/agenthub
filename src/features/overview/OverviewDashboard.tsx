import { useEffect, useRef, useState } from "react";
import { PanelLeftOpen, PanelRightOpen } from "lucide-react";
import { updateWorkspace, useApp } from "@/app/store";
import { Button } from "@/components/ui/button";
import { Splitter } from "@/components/ui/splitter";
import { defaultWorkspace } from "@/lib/types";
import { ReadmePanel } from "./ReadmePanel";
import { TerminalDock } from "./TerminalDock";
import { ChatStrip } from "./ChatStrip";

/** Instructions and live shells; AI work opens in the dedicated Chat view. */
export function OverviewDashboard({ projectId }: { projectId: string }) {
  const ws = useApp((s) => s.workspaces[projectId]) ?? defaultWorkspace();
  const host = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    setWidth(el.clientWidth);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const compact = width > 0 && width < 680;
  const readmeHidden = ws.overviewReadmeCollapsed;
  const terminalsHidden = ws.overviewTerminalsCollapsed && !readmeHidden;
  const available = Math.max(0, width - 24);
  const ratio = Number.isFinite(ws.overviewReadmeWidth) ? ws.overviewReadmeWidth : 55;
  const readmeWidth = Math.max(300, Math.min(available - 320, available * ratio / 100));
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2.5 p-3">
      <ChatStrip projectId={projectId} />
      {(readmeHidden || terminalsHidden) && <div className="flex shrink-0 gap-2">
        {readmeHidden && <Button size="sm" onClick={() => updateWorkspace(projectId, { overviewReadmeCollapsed: false })}><PanelLeftOpen className="size-4" /> Show instructions</Button>}
        {terminalsHidden && <Button size="sm" onClick={() => updateWorkspace(projectId, { overviewTerminalsCollapsed: false })}><PanelRightOpen className="size-4" /> Show terminals</Button>}
      </div>}
      <div ref={host} className="flex min-h-0 min-w-0 flex-1 gap-3" style={{ flexDirection: compact ? "column" : "row" }}>
        {!readmeHidden && <section aria-label="Project instructions" className="hud flex min-h-0 min-w-0 flex-col border border-line bg-surface" style={{ width: !compact && !terminalsHidden ? readmeWidth : undefined, flex: compact || terminalsHidden ? 1 : undefined }}>
          <ReadmePanel key={projectId} projectId={projectId} onCollapse={() => updateWorkspace(projectId, { overviewReadmeCollapsed: true, overviewTerminalsCollapsed: false })} />
        </section>}
        {!readmeHidden && !terminalsHidden && !compact && <Splitter label="Resize instructions and terminals" side="left" value={readmeWidth} min={300} max={Math.max(300, available - 320)} onChange={(v) => updateWorkspace(projectId, { overviewReadmeWidth: available ? v / available * 100 : 55 })} />}
        {!terminalsHidden && <TerminalDock key={projectId} projectId={projectId} />}
      </div>
      {compact && !readmeHidden && !terminalsHidden && <span className="shrink-0 text-[11px] text-muted">Hide instructions for more terminal space.</span>}
    </div>
  );
}
