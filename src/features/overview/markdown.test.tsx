import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/app/actions", () => ({ openFile: vi.fn() }));
import { MarkdownView } from "@/features/editor/MarkdownPreview";

it("adds document navigation and copy controls without turning instructions into executable actions", () => {
  const html = renderToStaticMarkup(<MarkdownView projectId="p" path="README.md" tools text={'# Build\n\n```sh\npnpm build\n```\n\n# Build'} />);
  expect(html).toContain('aria-label="Jump to document heading"');
  expect(html).toContain('data-anchor="build"');
  expect(html).toContain('data-anchor="build-1"');
  expect(html).toContain('aria-label="Copy code block"');
  expect(html).toContain("pnpm build");
  expect(html).not.toContain("Run command");
});

it("retains safe Markdown rendering when Overview tools are enabled", () => {
  const html = renderToStaticMarkup(<MarkdownView projectId="p" path="README.md" tools text={'<script>alert(1)</script>\n\n![remote](https://example.com/image.png)\n\n[unsafe](javascript:alert(1))'} />);
  expect(html).not.toMatch(/<(script|img)\b/);
  expect(html).not.toContain('href="javascript:');
  expect(html).toContain("md-image");
});
