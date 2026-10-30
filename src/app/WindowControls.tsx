import { getCurrentWindow } from "@tauri-apps/api/window";
import { Minus, Square, X } from "lucide-react";
import { requestQuit } from "./actions";

export function WindowControls({ height = 40 }: { height?: number }) {
  const win = getCurrentWindow();
  const cls =
    "flex w-[46px] items-center justify-center border-0 bg-transparent text-muted transition-colors duration-200 hover:bg-accent/8 hover:text-fg";
  return (
    <div className="flex" style={{ height }}>
      <button aria-label="Minimize" title="Minimize" className={cls} onClick={() => void win.minimize()}>
        <Minus className="size-4" />
      </button>
      <button aria-label="Maximize" title="Maximize" className={cls} onClick={() => void win.toggleMaximize()}>
        <Square className="size-[13px]" />
      </button>
      <button
        aria-label="Close"
        title="Close"
        className={`${cls} hover:bg-danger/80! hover:text-on-danger!`}
        onClick={requestQuit}
      >
        <X className="size-4" />
      </button>
    </div>
  );
}
