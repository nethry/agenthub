import { memo, type MouseEvent } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { ImageOff } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { cn, safeExternalUrl } from "@/lib/utils";
import { CodeBlock } from "./CodeBlock";

const remarkPlugins = [remarkGfm];

interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: { className?: unknown };
  children?: HastNode[];
}

function textOf(node: HastNode | undefined): string {
  if (!node) return "";
  if (node.type === "text") return node.value ?? "";
  return (node.children ?? []).map(textOf).join("");
}

/** `language-ts` → `ts`. */
export function fenceLanguage(className: unknown): string {
  const list = Array.isArray(className) ? className : typeof className === "string" ? className.split(" ") : [];
  const cls = list.find((c): c is string => typeof c === "string" && c.startsWith("language-"));
  return cls ? cls.slice("language-".length) : "";
}

const components: Components = {
  pre: ({ node }) => {
    const code = (node as HastNode | undefined)?.children?.find((c) => c.tagName === "code");
    return <CodeBlock code={textOf(code).replace(/\n$/, "")} lang={fenceLanguage(code?.properties?.className)} />;
  },
  a: ({ href, children }) => (
    <a href={href} title={href}>
      {children}
    </a>
  ),
  // Images would need a network fetch; show what they are instead.
  img: ({ src, alt }) => (
    <span className="md-image" title={typeof src === "string" ? src : undefined}>
      <ImageOff className="size-3.5" />
      {alt || "Image"}
    </span>
  ),
};

/** Only http(s) links leave the app, through the system browser. */
function onClick(e: MouseEvent) {
  const a = (e.target as HTMLElement).closest("a");
  if (!a) return;
  e.preventDefault();
  const url = safeExternalUrl(a.getAttribute("href") ?? "");
  if (url) void openUrl(url);
}

/**
 * Renders an answer. Model output is untrusted: raw HTML isn't rendered
 * (react-markdown without rehype-raw), images aren't fetched, and only http(s)
 * links open, in the browser.
 */
export const ChatMarkdown = memo(function ChatMarkdown({ text, streaming }: { text: string; streaming?: boolean }) {
  return (
    <div className={cn("chat-md select-text", streaming && "is-streaming")} onClick={onClick}>
      <Markdown remarkPlugins={remarkPlugins} components={components}>
        {text}
      </Markdown>
    </div>
  );
});
