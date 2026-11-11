// Applies the app theme everywhere at once: the document tokens, Monaco (and
// with it chat code blocks), xterm and the native window. Pure resolution
// lives in ./theme, colour data for non-CSS consumers in ./themePalettes.
import { getCurrentWindow } from "@tauri-apps/api/window";
import { errorMessage, ipc } from "@/lib/ipc";
import { defaultAppearancePrefs, type AppearancePrefs } from "@/lib/types";
import { monaco } from "@/features/editor/monaco";
import * as terms from "@/features/terminals/registry";
import { clearHighlightCache } from "@/features/chat/highlight";
import { get, set, toast } from "./store";
import {
  applyDocumentTheme,
  cacheThemePref,
  cachedThemePref,
  onSystemThemeChange,
  parseAppearance,
  resolveTheme,
  systemPrefersDark,
  themeMode,
} from "./theme";
import { MONACO_THEME, SWATCH, type ThemeKey } from "./themePalettes";

function apply(prefs: AppearancePrefs) {
  const key = resolveTheme(prefs.theme, systemPrefersDark());
  const changed = key !== get().themeKey;
  if (changed) clearHighlightCache();
  set({ appearance: prefs, themeKey: key });
  applyDocumentTheme(key);
  monaco.editor.setTheme(MONACO_THEME[key]);
  if (changed) terms.applyTheme();
  cacheThemePref(prefs.theme);
  syncWindow(prefs, key);
}

/** Native window background (seen while resizing) and theme; "system" lets Windows decide. */
function syncWindow(prefs: AppearancePrefs, key: ThemeKey) {
  try {
    const win = getCurrentWindow();
    void win.setTheme(prefs.theme === "graphite-system" ? null : themeMode(key)).catch(() => {});
    void win.setBackgroundColor(SWATCH[key].ground).catch(() => {});
  } catch {
    // Not running inside Tauri (tests, a plain browser).
  }
}

let unwatch: (() => void) | null = null;

/**
 * Before the first render: apply the theme cached from the last run, so a
 * Graphite user doesn't see Midnight HUD flash while settings load.
 */
export function initAppearance() {
  const cached = cachedThemePref();
  apply(cached ? { ...defaultAppearancePrefs, theme: cached } : defaultAppearancePrefs);
  unwatch?.();
  unwatch = onSystemThemeChange(() => {
    if (get().appearance.theme === "graphite-system") apply(get().appearance);
  });
}

/** Bootstrap: the saved `appearance` setting wins over the first-paint cache. */
export function loadAppearance(raw: string | undefined) {
  apply(parseAppearance(raw));
}

export async function setAppearancePrefs(patch: Partial<AppearancePrefs>) {
  const next = { ...get().appearance, ...patch };
  apply(next);
  await ipc
    .setSetting("appearance", JSON.stringify(next))
    .catch((e) => toast(`Couldn't save the theme: ${errorMessage(e)}`, "danger"));
}
