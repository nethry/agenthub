import { useEffect, useRef, useState, type MouseEvent } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { ImageOff } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { openFile } from "@/app/actions";
import { cn } from "@/lib/utils";
import type { monaco } from "./monaco";
import { rehypeHeadingAnchors, resolveMdLink } from "./markdown";

const remarkPlugins = [remarkGfm];
const rehypePlugins = [rehypeHeadingAnchors];

/**
 * Renders the live (possibly unsaved) model as Markdown. File content is
 * untrusted: raw HTML is not rendered, images aren't fetched, and links go
 * through `resolveMdLink`.
 */
export function MarkdownPreview({
  projectId,
  path,
  model,
  className,
}: {
  projectId: string;
  path: string;
  model: monaco.editor.ITextModel;
  className?: string;
}) {
  const [text, setText] = useState(() => model.getValue());

  useEffect(() => {
    setText(model.getValue());
    let timer: ReturnType<typeof setTimeout> | undefined;
    const d = model.onDidChangeContent(() => {
      clearTimeout(timer);
      timer = setTimeout(() => setText(model.getValue()), 150);
    });
    return () => {
      clearTimeout(timer);
      d.dispose();
    };
  }, [model]);

  return <MarkdownView projectId={projectId} path={path} text={text} className={className} />;
}

/** Renders Markdown text from `path` with the same safety rules as `MarkdownPreview`. */
export function MarkdownView({
  projectId,
  path,
  text,
  className,
}: {
  projectId: string;
  path: string;
  text: string;
  className?: string;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);

  const onClick = (e: MouseEvent) => {
    const a = (e.target as HTMLElement).closest("a");
    if (!a) return;
    e.preventDefault();
    const link = resolveMdLink(path, a.getAttribute("href") ?? "");
    if (!link) return;
    if (link.kind === "external") void openUrl(link.url);
    else if (link.kind === "file") openFile(projectId, link.path);
    else
      scrollRef.current
        ?.querySelector(`[data-anchor="${CSS.escape(link.id)}"]`)
        ?.scrollIntoView({ block: "start" });
  };

  return (
    <div
      ref={scrollRef}
      tabIndex={0}
      role="document"
      aria-label={`Preview of ${path}`}
      onClick={onClick}
      className={cn("overflow-auto bg-well px-8 py-6 outline-none select-text", className)}
    >
      <div className="md-preview mx-auto max-w-[780px]">
        <Markdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={components}>
          {text}
        </Markdown>
      </div>
    </div>
  );
}

const components: Components = {
  a: ({ href, children }) => (
    <a href={href} title={href}>
      {children}
    </a>
  ),
  // Images would need a network or file fetch; show what they are instead.
  img: ({ src, alt }) => (
    <span className="md-image" title={typeof src === "string" ? src : undefined}>
      <ImageOff className="size-3.5" />
      {alt || "Image"}
    </span>
  ),
};
