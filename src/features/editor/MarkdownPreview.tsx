import { useEffect, useRef, useState, type MouseEvent } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { ImageOff, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/form";
import { toast } from "@/app/store";
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
  tools = false,
}: {
  projectId: string;
  path: string;
  text: string;
  className?: string;
  tools?: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [headings, setHeadings] = useState<{ id: string; text: string }[]>([]);
  useEffect(() => {
    if (!tools) return;
    setHeadings(Array.from(scrollRef.current?.querySelectorAll<HTMLElement>("[data-anchor]") ?? []).map((el) => ({ id: el.dataset.anchor!, text: el.textContent ?? "" })));
  }, [text, tools]);

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

  return (<>
    {tools && <div className="shrink-0 border-b border-line px-2 py-1.5">
      <Select aria-label="Jump to document heading" value="" disabled={!headings.length} className="h-7 w-full min-w-0 text-[12px]" onChange={(e) => scrollRef.current?.querySelector(`[data-anchor="${CSS.escape(e.target.value)}"]`)?.scrollIntoView({ block: "start" })}>
        <option value="">{headings.length ? "Jump to heading…" : "No headings in this document"}</option>
        {headings.map((h) => <option key={h.id} value={h.id}>{h.text}</option>)}
      </Select>
    </div>}
    <div
      ref={scrollRef}
      tabIndex={0}
      role="document"
      aria-label={`Preview of ${path}`}
      onClick={onClick}
      className={cn("overflow-auto bg-well px-8 py-6 outline-none select-text", className)}
    >
      <div className="md-preview mx-auto max-w-[780px]">
        <Markdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={tools ? overviewComponents : components}>
          {text}
        </Markdown>
      </div>
    </div>
  </>);
}

function CopyableCode({ children }: { children?: React.ReactNode }) {
  const code = useRef<HTMLPreElement>(null);
  return <div>
    <div className="flex justify-end"><Button size="sm" aria-label="Copy code block" onClick={() => {
      void navigator.clipboard.writeText(code.current?.textContent ?? "").then(() => toast("Code copied")).catch(() => toast("Couldn't copy code", "danger"));
    }}><Copy className="size-3" /> Copy</Button></div>
    <pre ref={code}>{children}</pre>
  </div>;
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

const overviewComponents: Components = { ...components, pre: CopyableCode };
