// Pure helpers for the Markdown preview (no Monaco import, so they're testable).
import { safeExternalUrl } from "@/lib/utils";

export type MdView = "code" | "split" | "preview";

const MD_EXT = /\.(md|markdown|mdown|mkd|mdx)$/i;

export function isMarkdownPath(path: string): boolean {
  return MD_EXT.test(path);
}

/** View for a file: Markdown defaults to preview, everything else is code. */
export function effectiveMdView(path: string, saved: MdView | undefined): MdView {
  return isMarkdownPath(path) ? (saved ?? "preview") : "code";
}

export type MdLink =
  | { kind: "external"; url: string }
  | { kind: "file"; path: string }
  | { kind: "anchor"; id: string };

/**
 * Resolves a link in the Markdown file at `fromPath` (project-relative, `/`
 * separated). Relative links become project-relative paths and may not climb
 * above the root; `/x` is taken from the root, as on GitHub. Only http(s)
 * leaves the app. Returns null for anything else.
 */
export function resolveMdLink(fromPath: string, href: string): MdLink | null {
  const raw = href.trim();
  if (!raw) return null;
  if (raw.startsWith("#")) return { kind: "anchor", id: safeDecode(raw.slice(1)).toLowerCase() };
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith("//")) {
    const url = safeExternalUrl(raw);
    return url ? { kind: "external", url } : null;
  }
  const target = safeDecode(raw.replace(/[?#].*$/, "")).replace(/\\/g, "/");
  if (!target) return null;
  const base = target.startsWith("/") ? [] : fromPath.split("/").slice(0, -1);
  const parts = [...base];
  for (const seg of target.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (parts.length === 0) return null;
      parts.pop();
    } else {
      parts.push(seg);
    }
  }
  return parts.length ? { kind: "file", path: parts.join("/") } : null;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** GitHub-style heading slugs; repeated headings get `-1`, `-2`, … */
export function createSlugger() {
  const seen = new Map<string, number>();
  return (text: string): string => {
    const base = text
      .toLowerCase()
      .trim()
      .replace(/[^\p{L}\p{N}\s_-]/gu, "")
      .replace(/\s/g, "-");
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n === 0 ? base : `${base}-${n}`;
  };
}

interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

function textOf(node: HastNode): string {
  if (node.type === "text") return node.value ?? "";
  return (node.children ?? []).map(textOf).join("");
}

/**
 * Rehype plugin: tags headings with `data-anchor` (not `id`, so file content
 * can't clash with app element ids) for in-document `#links`.
 */
export function rehypeHeadingAnchors() {
  return (tree: HastNode) => {
    const slug = createSlugger();
    const walk = (node: HastNode) => {
      if (node.type === "element" && /^h[1-6]$/.test(node.tagName ?? "")) {
        node.properties = { ...node.properties, dataAnchor: slug(textOf(node)) };
      }
      node.children?.forEach(walk);
    };
    walk(tree);
  };
}
