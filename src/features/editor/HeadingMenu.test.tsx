import { expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// Render the open portal inline for server-side inspection; keep Radix's real menu/items.
vi.mock("@radix-ui/react-dropdown-menu", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@radix-ui/react-dropdown-menu")>();
  return {
    ...actual,
    Root: ({ children }: { children: ReactNode }) => <actual.Root open>{children}</actual.Root>,
    Portal: ({ children }: { children: ReactNode }) => <>{children}</>,
  };
});

import { HeadingMenu } from "./HeadingMenu";

it("renders a long outline as a bounded, scrollable app menu instead of a native popup", () => {
  const headings = Array.from({ length: 100 }, (_, i) => ({ id: `section-${i}`, text: `Section ${i}` }));
  const html = renderToStaticMarkup(<HeadingMenu headings={headings} onSelect={() => {}} />);
  expect(html).not.toMatch(/<(select|option)\b/);
  expect(html).toContain('aria-haspopup="menu"');
  expect(html).toContain('role="menu"');
  expect(html.match(/role="menuitem"/g)).toHaveLength(100);
  expect(html).toContain("Section 99");
  expect(html).toContain("overflow-y-auto");
  expect(html).toContain("max-height:min(320px, var(--radix-dropdown-menu-content-available-height))");
  expect(html).toContain("max-width:var(--radix-dropdown-menu-content-available-width)");
  expect(html).toContain("bg-overlay");
});

it("disables navigation when the document has no headings", () => {
  const html = renderToStaticMarkup(<HeadingMenu headings={[]} onSelect={() => {}} />);
  expect(html).toMatch(/<button[^>]*disabled=""/);
  expect(html).toContain("No headings in this document");
});
