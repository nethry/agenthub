// Code block highlighting with Monaco's tokenizer (already bundled for the
// editor) instead of a second highlighter. Monaco is imported lazily so this
// module stays testable without a DOM.

interface LanguageLike {
  id: string;
  aliases?: string[];
  extensions?: string[];
}

const ALIASES: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  py: "python",
  rs: "rust",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  ps: "powershell",
  ps1: "powershell",
  pwsh: "powershell",
  yml: "yaml",
  md: "markdown",
  cs: "csharp",
  "c#": "csharp",
  "c++": "cpp",
  kt: "kotlin",
  rb: "ruby",
  golang: "go",
  dockerfile: "dockerfile",
  jsonc: "json",
  html: "html",
  xml: "xml",
  toml: "ini",
};

const LABELS: Record<string, string> = {
  typescript: "TYPESCRIPT",
  javascript: "JAVASCRIPT",
  python: "PYTHON",
  rust: "RUST",
  shell: "SHELL",
  powershell: "POWERSHELL",
  csharp: "C#",
  cpp: "C++",
};

/** Fence info string → Monaco language id, or null for plain text. */
export function resolveLanguage(tag: string, languages: LanguageLike[]): string | null {
  const t = tag.trim().toLowerCase();
  if (!t) return null;
  const want = ALIASES[t] ?? t;
  const lang =
    languages.find((l) => l.id === want) ??
    languages.find((l) => l.aliases?.some((a) => a.toLowerCase() === want)) ??
    languages.find((l) => l.extensions?.includes(`.${t}`));
  return lang?.id ?? null;
}

/** Header label for a fence tag: `ts` → `TYPESCRIPT`, none → `TEXT`. */
export function languageBadge(tag: string): string {
  const t = tag.trim().toLowerCase();
  if (!t) return "TEXT";
  const id = ALIASES[t] ?? t;
  return LABELS[id] ?? t.toUpperCase();
}

const cache = new Map<string, string>();
const CACHE_LIMIT = 300;

/**
 * Drops cached markup: Monaco's token classes index into the active theme's
 * colour map, so HTML colorized under another theme would show wrong colours.
 */
export function clearHighlightCache() {
  cache.clear();
}

/**
 * Highlighted HTML for a code block, or null when the language is unknown.
 * Monaco builds the markup from the text itself and escapes it, so the
 * result is safe to insert even though the code is untrusted.
 */
export async function highlight(code: string, tag: string): Promise<string | null> {
  const { monaco } = await import("@/features/editor/monaco");
  const id = resolveLanguage(tag, monaco.languages.getLanguages());
  if (!id) return null;
  const key = `${id}\u0000${code}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  // Token colours come from the active theme, which app/appearance.ts sets at startup.
  const html = await monaco.editor.colorize(code, id, { tabSize: 2 });
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
  cache.set(key, html);
  return html;
}
