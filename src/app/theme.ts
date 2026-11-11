// Theme resolution and the document side of applying a theme. Pure enough to
// run before React renders (main.tsx) and in tests; Monaco, xterm and the
// native window are switched by `app/appearance.ts`.
import { defaultAppearancePrefs, type AppearancePrefs, type ThemePref } from "@/lib/types";
import type { ThemeKey } from "./themePalettes";

export const THEME_PREFS: ThemePref[] = ["midnight-hud", "graphite-light", "graphite-dark", "graphite-system"];

/** First-paint cache of the theme choice; the `appearance` setting stays the source of truth. */
const CACHE_KEY = "agenthub.theme";

const isThemePref = (v: unknown): v is ThemePref => typeof v === "string" && (THEME_PREFS as string[]).includes(v);

/** The `appearance` setting; anything unknown falls back to Midnight HUD. */
export function parseAppearance(raw: string | undefined | null): AppearancePrefs {
  if (!raw) return defaultAppearancePrefs;
  try {
    const v = JSON.parse(raw) as Partial<AppearancePrefs> | null;
    return { ...defaultAppearancePrefs, theme: isThemePref(v?.theme) ? v.theme : defaultAppearancePrefs.theme };
  } catch {
    return defaultAppearancePrefs;
  }
}

export function resolveTheme(pref: ThemePref, systemDark: boolean): ThemeKey {
  switch (pref) {
    case "midnight-hud":
      return "hud";
    case "graphite-dark":
      return "graphite-dark";
    case "graphite-light":
      return "graphite-light";
    case "graphite-system":
      return systemDark ? "graphite-dark" : "graphite-light";
  }
}

export const themeFamily = (key: ThemeKey): "hud" | "graphite" => (key === "hud" ? "hud" : "graphite");
export const themeMode = (key: ThemeKey): "dark" | "light" => (key === "graphite-light" ? "light" : "dark");

const DARK_QUERY = "(prefers-color-scheme: dark)";

export function systemPrefersDark(): boolean {
  return typeof matchMedia === "function" ? matchMedia(DARK_QUERY).matches : true;
}

/** Calls `cb` when Windows switches between light and dark. */
export function onSystemThemeChange(cb: () => void): () => void {
  if (typeof matchMedia !== "function") return () => {};
  const mq = matchMedia(DARK_QUERY);
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
}

/** Sets the theme on <html>; every token and the `hud:` / `graphite:` variants follow. */
export function applyDocumentTheme(key: ThemeKey) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.dataset.theme = themeFamily(key);
  root.dataset.mode = themeMode(key);
  root.style.colorScheme = themeMode(key);
}

export function cachedThemePref(): ThemePref | null {
  try {
    const v = localStorage.getItem(CACHE_KEY);
    return isThemePref(v) ? v : null;
  } catch {
    return null;
  }
}

export function cacheThemePref(pref: ThemePref) {
  try {
    localStorage.setItem(CACHE_KEY, pref);
  } catch {
    // Storage can be unavailable; the next launch just starts on the saved setting.
  }
}
