import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// The picker's flow pulls in Monaco and xterm; the view only needs the options.
vi.mock("@/app/appearance", () => ({ setAppearancePrefs: vi.fn() }));
const { ThemePickerView } = await import("./ThemePicker");

describe("theme picker", () => {
  it("offers the four themes as one radio group with the current one checked", () => {
    const html = renderToStaticMarkup(<ThemePickerView value="graphite-dark" onChange={() => {}} />);
    expect(html).toContain('role="radiogroup"');
    expect(html.match(/role="radio"/g)).toHaveLength(4);
    expect(html.match(/aria-checked="true"/g)).toHaveLength(1);
    for (const label of ["Midnight HUD", "Graphite light", "Graphite dark", "Graphite system"]) expect(html).toContain(label);
    expect(html).toMatch(/aria-checked="true" tabindex="0"[^>]*>(?:(?!<\/button>).)*Graphite dark/);
  });
});
