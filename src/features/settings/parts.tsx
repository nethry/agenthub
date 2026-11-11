// Building blocks shared by the settings sections.
import type { ReactNode } from "react";

export function Header({ tag, title, body }: { tag: string; title: string; body: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="font-mono text-[11px] text-accent graphite:hidden">▸ CONFIG // {tag}</span>
      <h1 className="glow-text m-0 font-display text-[30px] font-bold tracking-[0.1em] uppercase graphite:text-[24px] graphite:font-semibold">
        {title}
      </h1>
      <p className="m-0 text-[13px] text-body">{body}</p>
    </div>
  );
}

export function Panel({ children }: { children: ReactNode }) {
  return <div className="hud flex max-w-[720px] flex-col gap-[18px] border border-line bg-surface p-5">{children}</div>;
}

export function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-6">
      <div className="flex flex-col gap-0.5">
        <span className="font-semibold">{label}</span>
        {hint && <span className="text-[12px] text-muted">{hint}</span>}
      </div>
      {children}
    </div>
  );
}
