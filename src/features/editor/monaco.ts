// Monaco is bundled locally (no CDN) and themed to Midnight HUD.
import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import JsonWorker from "monaco-editor/language/json/json.worker?worker";
import CssWorker from "monaco-editor/language/css/css.worker?worker";
import HtmlWorker from "monaco-editor/language/html/html.worker?worker";
import TsWorker from "monaco-editor/language/typescript/ts.worker?worker";

declare global {
  interface Window {
    MonacoEnvironment?: monaco.Environment;
  }
}

self.MonacoEnvironment = {
  getWorker(_id: string, label: string) {
    if (label === "json") return new JsonWorker();
    if (label === "css" || label === "scss" || label === "less") return new CssWorker();
    if (label === "html" || label === "handlebars" || label === "razor") return new HtmlWorker();
    if (label === "typescript" || label === "javascript") return new TsWorker();
    return new EditorWorker();
  },
};

// Project files are opened without their node_modules/types, so semantic
// errors would be noise. Keep syntax errors.
for (const defaults of [monaco.typescript.typescriptDefaults, monaco.typescript.javascriptDefaults]) {
  defaults.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: false });
}

monaco.editor.defineTheme("midnight-hud", {
  base: "vs-dark",
  inherit: true,
  rules: [
    { token: "", foreground: "DCEBFF" },
    { token: "keyword", foreground: "B79CFF" },
    { token: "storage", foreground: "B79CFF" },
    { token: "string", foreground: "7CF5B8" },
    { token: "string.escape", foreground: "A6EEFA" },
    { token: "comment", foreground: "6E86A0" },
    { token: "number", foreground: "FFB547" },
    { token: "type", foreground: "FFB547" },
    { token: "type.identifier", foreground: "FFB547" },
    { token: "identifier.function", foreground: "4DA3FF" },
    { token: "delimiter", foreground: "A3B8CF" },
    { token: "tag", foreground: "4DA3FF" },
    { token: "attribute.name", foreground: "B79CFF" },
    { token: "attribute.value", foreground: "7CF5B8" },
    { token: "key", foreground: "4DA3FF" },
    { token: "string.key.json", foreground: "4DA3FF" },
    { token: "string.value.json", foreground: "7CF5B8" },
    { token: "variable", foreground: "DCEBFF" },
    { token: "regexp", foreground: "FF9AAB" },
  ],
  colors: {
    "editor.background": "#03060A",
    "editor.foreground": "#DCEBFF",
    "editorLineNumber.foreground": "#4C627A",
    "editorLineNumber.activeForeground": "#A3B8CF",
    "editorCursor.foreground": "#4DA3FF",
    "editor.lineHighlightBackground": "#4DA3FF12",
    "editor.lineHighlightBorder": "#00000000",
    "editor.selectionBackground": "#4DA3FF40",
    "editor.inactiveSelectionBackground": "#4DA3FF22",
    "editor.findMatchBackground": "#FFB54755",
    "editor.findMatchHighlightBackground": "#FFB54728",
    "editorGutter.background": "#03060A",
    "editorIndentGuide.background1": "#12202F",
    "editorIndentGuide.activeBackground1": "#1C3049",
    "editorWhitespace.foreground": "#1C3049",
    "editorWidget.background": "#0A111A",
    "editorWidget.border": "#1C3049",
    "editorSuggestWidget.background": "#0A111A",
    "editorSuggestWidget.border": "#1C3049",
    "editorSuggestWidget.selectedBackground": "#4DA3FF22",
    "editorHoverWidget.background": "#0A111A",
    "editorHoverWidget.border": "#1C3049",
    "input.background": "#03060A",
    "input.border": "#1C3049",
    "focusBorder": "#4DA3FF",
    "scrollbarSlider.background": "#1C304999",
    "scrollbarSlider.hoverBackground": "#3A4F69",
    "scrollbarSlider.activeBackground": "#4DA3FF66",
    "editorOverviewRuler.border": "#00000000",
    "editorBracketMatch.background": "#4DA3FF22",
    "editorBracketMatch.border": "#4DA3FF66",
    "editorError.foreground": "#FF5470",
    "editorWarning.foreground": "#FFB547",
  },
});

export function languageFor(path: string): string {
  const name = path.split("/").pop() ?? path;
  const lower = name.toLowerCase();
  const ext = lower.includes(".") ? lower.slice(lower.lastIndexOf(".")) : "";
  for (const lang of monaco.languages.getLanguages()) {
    if (lang.filenames?.some((f) => f.toLowerCase() === lower)) return lang.id;
  }
  if (ext) {
    for (const lang of monaco.languages.getLanguages()) {
      if (lang.extensions?.includes(ext)) return lang.id;
    }
  }
  return "plaintext";
}

export function languageLabel(id: string): string {
  const lang = monaco.languages.getLanguages().find((l) => l.id === id);
  return (lang?.aliases?.[0] ?? id).toUpperCase();
}

export { monaco };
