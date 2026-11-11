// Colour data for the parts of a theme that CSS can't reach: Monaco, xterm,
// the native window background and the Settings preview cards. The UI tokens
// themselves live in src/styles/globals.css; theme.test.ts checks they agree.
import type { ITheme } from "@xterm/xterm";

/** A resolved theme: Midnight HUD, or Graphite in one of its modes. */
export type ThemeKey = "hud" | "graphite-dark" | "graphite-light";

export const THEME_KEYS: ThemeKey[] = ["hud", "graphite-dark", "graphite-light"];

/** Colours a preview card (and the window background) needs. Same values as the CSS tokens. */
export interface Swatch {
  ground: string;
  surface: string;
  well: string;
  line: string;
  accent: string;
  accentFill: string;
  fg: string;
  muted: string;
}

export const SWATCH: Record<ThemeKey, Swatch> = {
  hud: {
    ground: "#05080d",
    surface: "#0a111a",
    well: "#03060a",
    line: "#1c3049",
    accent: "#4da3ff",
    accentFill: "#4da3ff",
    fg: "#dcebff",
    muted: "#8aa0b8",
  },
  "graphite-dark": {
    ground: "#16171a",
    surface: "#1c1d21",
    well: "#131416",
    line: "#2c2e34",
    accent: "#7fb0ea",
    accentFill: "#3570b8",
    fg: "#d5d8de",
    muted: "#888e99",
  },
  "graphite-light": {
    ground: "#eef0f3",
    surface: "#f7f8fa",
    well: "#f7f8fa",
    line: "#d9dde3",
    accent: "#245fa6",
    accentFill: "#2f6db8",
    fg: "#272a31",
    muted: "#656b76",
  },
};

export const MONACO_THEME: Record<ThemeKey, string> = {
  hud: "midnight-hud",
  "graphite-dark": "graphite-dark",
  "graphite-light": "graphite-light",
};

/** Graphite syntax and editor colours (design canvas `--syn-*`, `--bg-*`, `--border*`). */
export interface GraphiteEditorPalette {
  text: string;
  comment: string;
  keyword: string;
  string: string;
  number: string;
  fn: string;
  type: string;
  operator: string;
  tag: string;
  attr: string;
  punct: string;
  regexp: string;
  background: string;
  lineNumber: string;
  lineNumberActive: string;
  cursor: string;
  lineHighlight: string;
  selection: string;
  selectionInactive: string;
  find: string;
  findHighlight: string;
  border: string;
  borderSubtle: string;
  borderStrong: string;
  widget: string;
  focus: string;
  danger: string;
  warning: string;
}

export const GRAPHITE_EDITOR: Record<Exclude<ThemeKey, "hud">, GraphiteEditorPalette> = {
  "graphite-dark": {
    text: "#D5D8DE",
    comment: "#7A808A",
    keyword: "#C59BE0",
    string: "#9CC58A",
    number: "#D9A66C",
    fn: "#82B1E8",
    type: "#E0C27A",
    operator: "#A7ADB8",
    tag: "#E58C8C",
    attr: "#D9A66C",
    punct: "#8E949E",
    regexp: "#E58C8C",
    background: "#131416",
    lineNumber: "#5A5F69",
    lineNumberActive: "#A0A5AF",
    cursor: "#7FB0EA",
    lineHighlight: "#26282D",
    selection: "#24344A",
    selectionInactive: "#1F2A3A",
    find: "#D3A24A55",
    findHighlight: "#D3A24A28",
    border: "#2C2E34",
    borderSubtle: "#222328",
    borderStrong: "#3A3D45",
    widget: "#2A2B31",
    focus: "#6FA3E6",
    danger: "#E06A6A",
    warning: "#D3A24A",
  },
  "graphite-light": {
    text: "#23262C",
    comment: "#676D77",
    keyword: "#7D3FB0",
    string: "#3C7A2A",
    number: "#A1560E",
    fn: "#1F5FA8",
    type: "#8A5F0E",
    operator: "#555B66",
    tag: "#B23A3A",
    attr: "#A1560E",
    punct: "#5E646E",
    regexp: "#B23A3A",
    background: "#F7F8FA",
    lineNumber: "#A2A8B1",
    lineNumberActive: "#4F5560",
    cursor: "#245FA6",
    lineHighlight: "#E8EBEF",
    selection: "#CCDDF2",
    selectionInactive: "#DCE8F7",
    find: "#8A5F0E33",
    findHighlight: "#8A5F0E1A",
    border: "#D9DDE3",
    borderSubtle: "#E4E7EB",
    borderStrong: "#C3C9D1",
    widget: "#FFFFFF",
    focus: "#2F6DB8",
    danger: "#B83A3A",
    warning: "#8A5F0E",
  },
};

/** xterm palettes. The viewport is transparent, so `background` matches the `well` token. */
export const TERMINAL_THEMES: Record<ThemeKey, ITheme> = {
  hud: {
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
  },
  "graphite-dark": {
    background: "#131416",
    foreground: "#D5D8DE",
    cursor: "#7FB0EA",
    cursorAccent: "#131416",
    selectionBackground: "#24344A",
    black: "#2A2B31",
    red: "#E06A6A",
    green: "#5FB07F",
    yellow: "#D3A24A",
    blue: "#6FA3E6",
    magenta: "#B48EDB",
    cyan: "#5DBDB8",
    white: "#C3C7CE",
    brightBlack: "#5A5F69",
    brightRed: "#EE8A8A",
    brightGreen: "#7CC79A",
    brightYellow: "#E2B96A",
    brightBlue: "#8DB8EE",
    brightMagenta: "#C9A8E8",
    brightCyan: "#7FD0CB",
    brightWhite: "#E6E8EC",
  },
  "graphite-light": {
    background: "#F7F8FA",
    foreground: "#272A31",
    cursor: "#245FA6",
    cursorAccent: "#F7F8FA",
    selectionBackground: "#CCDDF2",
    black: "#23262C",
    red: "#B83A3A",
    green: "#2C7A4B",
    yellow: "#8A5F0E",
    blue: "#2F6DB8",
    magenta: "#7D3FB0",
    cyan: "#1F7F7A",
    white: "#C3C9D1",
    brightBlack: "#6B717C",
    brightRed: "#C04444",
    brightGreen: "#2F8150",
    brightYellow: "#946512",
    brightBlue: "#2C68B0",
    brightMagenta: "#8A4CC0",
    brightCyan: "#197570",
    brightWhite: "#F7F8FA",
  },
};
