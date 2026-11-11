import * as Dropdown from "@radix-ui/react-dropdown-menu";
import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MenuItem } from "@/components/ui/menu";

/** Keep long document outlines inside the webview, rather than a native select popup. */
export function HeadingMenu({ headings, onSelect }: {
  headings: { id: string; text: string }[];
  onSelect: (id: string) => void;
}) {
  return <Dropdown.Root>
    <Dropdown.Trigger asChild>
      <Button aria-label="Jump to document heading" disabled={!headings.length} size="sm" className="h-7 w-full min-w-0 justify-between">
        <span className="truncate">{headings.length ? "Jump to heading…" : "No headings in this document"}</span>
        <ChevronDown className="size-3.5 shrink-0" />
      </Button>
    </Dropdown.Trigger>
    <Dropdown.Portal>
      <Dropdown.Content
        aria-label="Document headings"
        align="start"
        sideOffset={4}
        collisionPadding={8}
        className="z-50 overflow-y-auto rounded-card border border-line-strong bg-overlay p-1.5 text-fg outline-none graphite:shadow-(--shadow-pop)"
        style={{
          width: "var(--radix-dropdown-menu-trigger-width)",
          maxWidth: "var(--radix-dropdown-menu-content-available-width)",
          maxHeight: "min(320px, var(--radix-dropdown-menu-content-available-height))",
        }}
      >
        {headings.map((heading) => <MenuItem key={heading.id} onSelect={() => onSelect(heading.id)}>{heading.text}</MenuItem>)}
      </Dropdown.Content>
    </Dropdown.Portal>
  </Dropdown.Root>;
}
