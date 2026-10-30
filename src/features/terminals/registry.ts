// xterm.js instances live here, outside React, so switching projects or views
// never loses scrollback. React components only attach/detach the DOM node.
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { openUrl } from "@tauri-apps/plugin-opener";
import "@xterm/xterm/css/xterm.css";
import { ipc } from "@/lib/ipc";
import { safeExternalUrl } from "@/lib/utils";
import { get } from "@/app/store";

export const TERMINAL_THEME: ITheme = {
  background: "#03060A",
  foreground: "#BCD0E6",
  cursor: "#4DA3FF",
  cursorAccent: "#03060A",
  selectionBackground: "rgba(77, 163, 255, 0.32)",
  black: "#0A111A",
  red: "#FF5470",
  green: "#3DF5A0",
  yellow: "#FFB547",
  blue: "#4DA3FF",
  magenta: "#B79CFF",
  cyan: "#5CD6F0",
  white: "#BCD0E6",
  brightBlack: "#4C627A",
  brightRed: "#FF9AAB",
  brightGreen: "#7CF5B8",
  brightYellow: "#FFD08A",
  brightBlue: "#A8D1FF",
  brightMagenta: "#D4C4FF",
  brightCyan: "#A6EEFA",
  brightWhite: "#DCEBFF",
};

interface Entry {
  term: Terminal;
  fit: FitAddon;
  el: HTMLDivElement;
  opened: boolean;
  lastSize: { cols: number; rows: number } | null;
}

const entries = new Map<string, Entry>();

/** Windows build of the host, so xterm matches ConPTY's resize and reflow behavior. */
let windowsBuild: number | null = null;

export function setWindowsBuild(build: number | null) {
  windowsBuild = build;
  for (const e of entries.values()) e.term.options.windowsPty = windowsPty();
}

function windowsPty() {
  return windowsBuild ? { backend: "conpty" as const, buildNumber: windowsBuild } : {};
}

/** Shortcuts the app handles globally; xterm must not swallow them. */
function isAppShortcut(e: KeyboardEvent): boolean {
  const k = e.key.toLowerCase();
  if (e.ctrlKey && !e.shiftKey && !e.altKey && (k === "k" || k === "," || k === "o")) return true;
  if (e.ctrlKey && e.shiftKey && (k === "n" || k === "w" || e.code === "Backquote")) return true;
  if (e.altKey && !e.ctrlKey && /^Digit[1-9]$/.test(e.code)) return true;
  if (e.ctrlKey && !e.shiftKey && /^Digit[1-9]$/.test(e.code)) return true;
  if (e.shiftKey && k === "escape") return true;
  return false;
}

function create(id: string): Entry {
  const prefs = get().terminalPrefs;
  const term = new Terminal({
    fontFamily: '"JetBrains Mono", ui-monospace, monospace',
    fontSize: prefs.fontSize,
    lineHeight: 1.45,
    scrollback: prefs.scrollback,
    cursorBlink: true,
    cursorStyle: "block",
    allowTransparency: true,
    theme: TERMINAL_THEME,
    // ConPTY repaints with its own resize semantics; without this, growing a
    // pane pulls scrollback into view and the next repaint lands misaligned.
    windowsPty: windowsPty(),
    // Terminal output is untrusted: no proposed APIs, links opened via allow-list only.
    allowProposedApi: false,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(
    new WebLinksAddon((_e, uri) => {
      const safe = safeExternalUrl(uri);
      if (safe) void openUrl(safe);
    }),
  );

  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== "keydown") return true;
    if (isAppShortcut(e)) return false;
    const k = e.key.toLowerCase();
    const copy = () => {
      const sel = term.getSelection();
      if (sel) void navigator.clipboard.writeText(sel);
    };
    const paste = () => {
      void navigator.clipboard.readText().then((t) => t && term.paste(t));
    };
    if (e.ctrlKey && e.shiftKey && k === "c") {
      copy();
      return false;
    }
    if (e.ctrlKey && e.shiftKey && k === "v") {
      paste();
      return false;
    }
    // Windows Terminal convention: Ctrl+C copies when text is selected.
    if (e.ctrlKey && !e.shiftKey && k === "c" && term.hasSelection()) {
      copy();
      term.clearSelection();
      return false;
    }
    if (e.ctrlKey && !e.shiftKey && k === "v") {
      paste();
      return false;
    }
    return true;
  });

  term.onData((data) => void ipc.write(id, data).catch(() => {}));

  const el = document.createElement("div");
  el.className = "xterm-host";
  const entry: Entry = { term, fit, el, opened: false, lastSize: null };
  entries.set(id, entry);
  return entry;
}

export function ensure(id: string): Entry {
  return entries.get(id) ?? create(id);
}

export function write(id: string, data: string) {
  ensure(id).term.write(data);
}

export function has(id: string) {
  return entries.has(id);
}

/** Move the terminal's DOM node into `host` and size it. */
export function attach(id: string, host: HTMLElement, fontSize?: number) {
  const entry = ensure(id);
  if (entry.el.parentElement !== host) host.appendChild(entry.el);
  if (!entry.opened) {
    entry.term.open(entry.el);
    entry.opened = true;
    loadWebgl(entry);
  }
  const size = fontSize ?? get().terminalPrefs.fontSize;
  if (entry.term.options.fontSize !== size) entry.term.options.fontSize = size;
  fit(id);
  if (pendingFocus === id) {
    pendingFocus = null;
    entry.term.focus();
  }
}

/**
 * GPU renderer, as in VS Code. Unlike the DOM renderer it draws block and box
 * characters itself, so logos and borders stay seamless at any line height.
 * Falls back to the DOM renderer if WebGL is unavailable or the context is lost.
 */
function loadWebgl(entry: Entry) {
  try {
    const webgl = new WebglAddon();
    webgl.onContextLoss(() => webgl.dispose());
    entry.term.loadAddon(webgl);
  } catch {
    // No WebGL: keep the DOM renderer.
  }
}

export function detach(id: string, host: HTMLElement) {
  const entry = entries.get(id);
  if (entry && entry.el.parentElement === host) host.removeChild(entry.el);
}

/** Fit to the host and tell the PTY about the new size. */
export function fit(id: string) {
  const entry = entries.get(id);
  if (!entry || !entry.opened || !entry.el.isConnected) return;
  const { clientWidth, clientHeight } = entry.el;
  if (clientWidth < 20 || clientHeight < 20) return;
  try {
    entry.fit.fit();
  } catch {
    return;
  }
  const { cols, rows } = entry.term;
  if (!entry.lastSize || entry.lastSize.cols !== cols || entry.lastSize.rows !== rows) {
    entry.lastSize = { cols, rows };
    void ipc.resize(id, cols, rows).catch(() => {});
  }
}

export function focus(id: string) {
  entries.get(id)?.term.focus();
}

let pendingFocus: string | null = null;

/** Focus now if the terminal is on screen, otherwise as soon as it mounts. */
export function requestFocus(id: string) {
  const e = entries.get(id);
  if (e?.opened && e.el.isConnected) e.term.focus();
  else pendingFocus = id;
}

export function size(id: string): { cols: number; rows: number } {
  const e = entries.get(id);
  return e?.lastSize ?? { cols: 120, rows: 34 };
}

export function dispose(id: string) {
  const e = entries.get(id);
  if (!e) return;
  e.term.dispose();
  e.el.remove();
  entries.delete(id);
}

export function applyPrefs() {
  const prefs = get().terminalPrefs;
  for (const [id, e] of entries) {
    e.term.options.scrollback = prefs.scrollback;
    e.term.options.fontSize = prefs.fontSize;
    fit(id);
  }
}

/**
 * xterm measures cells and rasterizes glyphs with whatever font is loaded at
 * that moment, so a late web font leaves misaligned cells. Load it before the
 * first terminal opens, and rebuild glyphs if a weight arrives later.
 */
export async function loadFonts() {
  const fonts = document.fonts;
  await Promise.all(["400", "700"].map((w) => fonts.load(`${w} 14px "JetBrains Mono"`).catch(() => [])));
  fonts.addEventListener("loadingdone", () => {
    for (const [id, e] of entries) {
      if (!e.opened) continue;
      e.term.clearTextureAtlas();
      e.lastSize = null;
      fit(id);
    }
  });
}
