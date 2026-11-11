import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { useApp } from "@/app/store";
import { copyText } from "./actions";
import { highlight, languageBadge } from "./highlight";

/** Fenced code in an answer: language label, copy action, Monaco colors. */
export function CodeBlock({ code, lang }: { code: string; lang: string }) {
  // Colorized markup belongs to one theme; recolor after a switch.
  const theme = useApp((s) => s.themeKey);
  const [colored, setColored] = useState<{ code: string; theme: string; html: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    let live = true;
    // While an answer streams the code changes every frame; highlight once it settles.
    const t = setTimeout(() => {
      highlight(code, lang)
        .then((html) => live && html !== null && setColored({ code, theme, html }))
        .catch(() => {});
    }, 180);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [code, lang, theme]);

  useEffect(() => () => clearTimeout(copyTimer.current), []);

  const onCopy = async () => {
    if (!(await copyText(code))) return;
    setCopied(true);
    clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopied(false), 1500);
  };

  // Highlighted markup only while it matches the current text.
  const html = colored && colored.code === code && colored.theme === theme ? colored.html : null;

  return (
    <figure className="chat-code m-0 border border-line bg-well">
      <figcaption className="flex h-8 items-center gap-2.5 border-b border-line pr-1.5 pl-3 font-mono text-[10.5px] text-muted">
        <span className="text-accent">{languageBadge(lang)}</span>
        <span className="flex-1" />
        <button
          type="button"
          onClick={() => void onCopy()}
          aria-label={copied ? "Code copied" : "Copy code"}
          className="flex h-6 items-center gap-1.5 border-0 bg-transparent px-2 font-mono text-[10.5px] text-muted transition-colors duration-200 hover:text-fg"
        >
          {copied ? (
            <span className="flex items-center gap-1.5 text-run">
              <Check className="icon-strong size-3" />
              COPIED
            </span>
          ) : (
            <>
              <Copy className="size-[13px]" />
              COPY
            </>
          )}
        </button>
      </figcaption>
      {html !== null ? (
        <pre className="chat-code-body">
          {/* Monaco escapes the text while building this markup (see highlight.ts). */}
          <code dangerouslySetInnerHTML={{ __html: html }} />
        </pre>
      ) : (
        <pre className="chat-code-body">
          <code>{code}</code>
        </pre>
      )}
    </figure>
  );
}
