import { describe, expect, it } from "vitest";
import { parseAppearance, resolveTheme, themeFamily, themeMode, THEME_PREFS } from "./theme";
import { GRAPHITE_EDITOR, SWATCH, TERMINAL_THEMES, THEME_KEYS, type ThemeKey } from "./themePalettes";

// Vitest blanks CSS imports (even `?raw`), so read the file itself. The app's
// tsconfig has no Node types, hence the untyped import.
const fs = (await import("node:fs" as string)) as { readFileSync(path: URL, encoding: "utf8"): string };
const css = fs.readFileSync(new URL("../styles/globals.css", import.meta.url), "utf8");

/** `--color-*` declarations of the first block whose selector starts with `selector`. */
function block(selector: string): Record<string, string> {
  const at = css.indexOf(`${selector} {`);
  expect(at, selector).toBeGreaterThanOrEqual(0);
  const body = css.slice(css.indexOf("{", at) + 1, css.indexOf("}", at));
  return Object.fromEntries([...body.matchAll(/--color-([\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
}

const TOKENS: Record<ThemeKey, Record<string, string>> = {
  hud: block("@theme"),
  "graphite-dark": block('[data-theme="graphite"][data-mode="dark"]'),
  "graphite-light": block('[data-theme="graphite"][data-mode="light"]'),
};

describe("theme resolution", () => {
  it("maps every choice to a theme, Graphite system following Windows", () => {
    expect(resolveTheme("midnight-hud", true)).toBe("hud");
    expect(resolveTheme("midnight-hud", false)).toBe("hud");
    expect(resolveTheme("graphite-dark", false)).toBe("graphite-dark");
    expect(resolveTheme("graphite-light", true)).toBe("graphite-light");
    expect(resolveTheme("graphite-system", true)).toBe("graphite-dark");
    expect(resolveTheme("graphite-system", false)).toBe("graphite-light");
    expect(THEME_PREFS).toHaveLength(4);
  });

  it("splits a theme into the family and mode set on <html>", () => {
    expect([themeFamily("hud"), themeMode("hud")]).toEqual(["hud", "dark"]);
    expect([themeFamily("graphite-dark"), themeMode("graphite-dark")]).toEqual(["graphite", "dark"]);
    expect([themeFamily("graphite-light"), themeMode("graphite-light")]).toEqual(["graphite", "light"]);
  });

  it("reads the saved setting and falls back to Midnight HUD", () => {
    expect(parseAppearance(JSON.stringify({ theme: "graphite-light" }))).toEqual({ theme: "graphite-light" });
    expect(parseAppearance(undefined)).toEqual({ theme: "midnight-hud" });
    expect(parseAppearance("{not json")).toEqual({ theme: "midnight-hud" });
    expect(parseAppearance(JSON.stringify({ theme: "neon" }))).toEqual({ theme: "midnight-hud" });
    expect(parseAppearance("null")).toEqual({ theme: "midnight-hud" });
  });
});

describe("theme palettes", () => {
  it("Graphite re-maps every colour token Midnight HUD defines", () => {
    const hud = Object.keys(TOKENS.hud);
    for (const key of ["graphite-dark", "graphite-light"] as const) {
      expect(hud.filter((t) => !(t in TOKENS[key])), key).toEqual([]);
    }
  });

  it("previews, Monaco and xterm use the same colours as the CSS tokens", () => {
    for (const key of THEME_KEYS) {
      const t = TOKENS[key];
      const s = SWATCH[key];
      expect([s.ground, s.surface, s.well, s.line, s.accent, s.accentFill, s.fg, s.muted], key).toEqual([
        t.ground,
        t.surface,
        t.well,
        t.line,
        t.accent,
        t["accent-fill"],
        t.fg,
        t.muted,
      ]);
      expect(TERMINAL_THEMES[key].background?.toLowerCase(), key).toBe(t.well);
    }
    for (const key of ["graphite-dark", "graphite-light"] as const) {
      expect(GRAPHITE_EDITOR[key].background.toLowerCase(), key).toBe(TOKENS[key].well);
    }
  });

  it("every terminal theme has the full ANSI palette", () => {
    const names = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"];
    const ansi = [...names, ...names.map((n) => `bright${n[0].toUpperCase()}${n.slice(1)}`)];
    for (const key of THEME_KEYS) {
      const theme = TERMINAL_THEMES[key] as Record<string, string | undefined>;
      expect(ansi.filter((n) => !theme[n]), key).toEqual([]);
    }
  });
});
