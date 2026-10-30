import { useLayoutEffect, useRef } from "react";
import * as terms from "./registry";
import { cn } from "@/lib/utils";

/** Hosts a backend-owned session's xterm instance. Unmounting never ends the process. */
export function TerminalView({
  sessionId,
  fontSize,
  autoFocus,
  className,
}: {
  sessionId: string;
  fontSize?: number;
  autoFocus?: boolean;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const host = ref.current;
    if (!host) return;
    terms.attach(sessionId, host, fontSize);
    if (autoFocus) terms.focus(sessionId);
    let raf = 0;
    let timer = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      window.clearTimeout(timer);
      raf = requestAnimationFrame(() => {
        timer = window.setTimeout(() => terms.fit(sessionId), 60);
      });
    });
    ro.observe(host);
    return () => {
      ro.disconnect();
      cancelAnimationFrame(raf);
      window.clearTimeout(timer);
      terms.detach(sessionId, host);
    };
  }, [sessionId, fontSize, autoFocus]);

  return (
    <div
      ref={ref}
      className={cn("scan min-h-0 min-w-0 flex-1 overflow-hidden bg-well", className)}
      onMouseDown={() => requestAnimationFrame(() => terms.focus(sessionId))}
    />
  );
}
