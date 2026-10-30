import { describe, expect, it } from "vitest";
import { createSlugger, effectiveMdView, isMarkdownPath, resolveMdLink } from "./markdown";

describe("effectiveMdView", () => {
  it("opens Markdown in preview unless another view was chosen", () => {
    expect(effectiveMdView("README.md", undefined)).toBe("preview");
    expect(effectiveMdView("README.md", "code")).toBe("code");
    expect(effectiveMdView("docs/a.md", "split")).toBe("split");
  });

  it("keeps other files in code view", () => {
    expect(effectiveMdView("src/main.ts", undefined)).toBe("code");
    expect(effectiveMdView("src/main.ts", "split")).toBe("code");
  });
});

describe("isMarkdownPath", () => {
  it("matches Markdown extensions case-insensitively", () => {
    expect(isMarkdownPath("README.md")).toBe(true);
    expect(isMarkdownPath("docs/Guide.MARKDOWN")).toBe(true);
    expect(isMarkdownPath("src/main.ts")).toBe(false);
    expect(isMarkdownPath("md")).toBe(false);
  });
});

describe("resolveMdLink", () => {
  it("resolves relative links against the file's folder", () => {
    expect(resolveMdLink("docs/guide.md", "setup.md")).toEqual({ kind: "file", path: "docs/setup.md" });
    expect(resolveMdLink("docs/guide.md", "./a/b.md#intro")).toEqual({ kind: "file", path: "docs/a/b.md" });
    expect(resolveMdLink("docs/guide.md", "../README.md")).toEqual({ kind: "file", path: "README.md" });
    expect(resolveMdLink("docs/guide.md", "/src/my%20file.ts")).toEqual({ kind: "file", path: "src/my file.ts" });
  });

  it("refuses to climb above the project root", () => {
    expect(resolveMdLink("README.md", "../secret.txt")).toBeNull();
    expect(resolveMdLink("docs/a.md", "../../x.md")).toBeNull();
  });

  it("only lets http(s) leave the app", () => {
    expect(resolveMdLink("a.md", "https://example.com/x")).toEqual({ kind: "external", url: "https://example.com/x" });
    expect(resolveMdLink("a.md", "javascript:alert(1)")).toBeNull();
    expect(resolveMdLink("a.md", "file:///C:/Windows")).toBeNull();
    expect(resolveMdLink("a.md", "C:\\Windows\\win.ini")).toBeNull();
  });

  it("treats fragments as in-document anchors", () => {
    expect(resolveMdLink("a.md", "#Getting-Started")).toEqual({ kind: "anchor", id: "getting-started" });
  });
});

describe("createSlugger", () => {
  it("builds GitHub-style slugs and numbers repeats", () => {
    const slug = createSlugger();
    expect(slug("Getting Started!")).toBe("getting-started");
    expect(slug("Getting Started")).toBe("getting-started-1");
    expect(slug("MVP — Phase 1")).toBe("mvp--phase-1");
  });
});
