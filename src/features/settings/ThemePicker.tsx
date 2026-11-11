// Settings › Appearance › Theme: one card per theme with a small preview.
import { useRef, type KeyboardEvent } from "react";
import { Check } from "lucide-react";
import { setAppearancePrefs } from "@/app/appearance";
import { useApp } from "@/app/store";
import { SWATCH, type Swatch, type ThemeKey } from "@/app/themePalettes";
import { THEME_PREFS } from "@/app/theme";
import type { ThemePref } from "@/lib/types";
import { cn } from "@/lib/utils";

export const THEME_OPTIONS: Record<ThemePref, { label: string; note: string; preview: ThemeKey[] }> = {
  "midnight-hud": { label: "Midnight HUD", note: "Dark, square corners, glow on active state", preview: ["hud"] },
  "graphite-light": { label: "Graphite light", note: "Calm greys for long sessions", preview: ["graphite-light"] },
  "graphite-dark": { label: "Graphite dark", note: "Calm greys, low glare", preview: ["graphite-dark"] },
  "graphite-system": { label: "Graphite system", note: "Follows Windows light or dark", preview: ["graphite-light", "graphite-dark"] },
};

/** A miniature workspace in the theme's own colours, independent of the active theme. */
function Preview({ swatch: s, rounded }: { swatch: Swatch; rounded: boolean }) {
  const r = rounded ? 3 : 0;
  return (
    <span aria-hidden="true" className="flex min-w-0 flex-1 gap-1.5 p-2" style={{ background: s.ground }}>
      <span className="flex w-[28%] flex-col gap-1">
        <span className="h-2.5" style={{ background: s.surface, borderLeft: `2px solid ${s.accent}` }} />
        <span className="h-1.5 w-4/5" style={{ background: s.line, borderRadius: r }} />
        <span className="h-1.5 w-3/5" style={{ background: s.line, borderRadius: r }} />
      </span>
      <span className="flex flex-1 flex-col gap-1 p-1.5" style={{ background: s.surface, borderRadius: r, border: `1px solid ${s.line}` }}>
        <span className="h-1.5 w-3/4" style={{ background: s.fg, borderRadius: r, opacity: 0.8 }} />
        <span className="h-1.5 w-1/2" style={{ background: s.muted, borderRadius: r, opacity: 0.7 }} />
        <span className="flex-1" style={{ background: s.well, borderRadius: r }} />
        <span className="h-2 w-6 self-end" style={{ background: s.accentFill, borderRadius: r }} />
      </span>
    </span>
  );
}

export function ThemePickerView({ value, onChange }: { value: ThemePref; onChange: (v: ThemePref) => void }) {
  const refs = useRef<Partial<Record<ThemePref, HTMLButtonElement | null>>>({});

  const onKeyDown = (e: KeyboardEvent) => {
    const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const i = THEME_PREFS.indexOf(value);
    const next = THEME_PREFS[(i + step + THEME_PREFS.length) % THEME_PREFS.length];
    onChange(next);
    refs.current[next]?.focus();
  };

  return (
    <div role="radiogroup" aria-label="Theme" className="grid grid-cols-2 gap-3 sm:grid-cols-4" onKeyDown={onKeyDown}>
      {THEME_PREFS.map((pref) => {
        const o = THEME_OPTIONS[pref];
        const on = pref === value;
        return (
          <button
            key={pref}
            ref={(el) => {
              refs.current[pref] = el;
            }}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            onClick={() => onChange(pref)}
            className={cn(
              "flex min-w-0 flex-col overflow-hidden rounded-card border bg-well text-left transition-colors duration-200",
              on
                ? "border-accent/60 hud:shadow-[0_0_12px_rgba(77,163,255,0.25)] graphite:border-accent graphite:shadow-[0_0_0_3px_var(--color-accent-subtle)]"
                : "border-line hover:border-line-strong",
            )}
          >
            <span className="flex h-[76px] border-b border-line">
              {o.preview.map((k) => (
                <Preview key={k} swatch={SWATCH[k]} rounded={k !== "hud"} />
              ))}
            </span>
            <span className="flex items-start gap-2 px-2.5 py-2">
              <span
                className={cn(
                  "mt-0.5 flex size-3.5 shrink-0 items-center justify-center border graphite:rounded-full",
                  on ? "border-accent-fill bg-accent-fill text-on-accent" : "border-line-strong",
                )}
              >
                {on && <Check className="icon-strong size-2.5" />}
              </span>
              <span className="flex min-w-0 flex-col">
                <span className="text-[13px] font-semibold text-fg">{o.label}</span>
                <span className="text-[11.5px] leading-4 text-muted">{o.note}</span>
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

export function ThemePicker() {
  const value = useApp((s) => s.appearance.theme);
  return <ThemePickerView value={value} onChange={(theme) => void setAppearancePrefs({ theme })} />;
}
