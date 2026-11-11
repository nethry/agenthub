import { beforeEach, describe, expect, it, vi } from "vitest";

// Monaco, xterm and the window are mocked: these tests cover the theme flow only.
const ipcMock = vi.hoisted(() => ({ setSetting: vi.fn() }));
const monacoMock = vi.hoisted(() => ({ setTheme: vi.fn() }));
const termsMock = vi.hoisted(() => ({ applyTheme: vi.fn() }));
const highlightMock = vi.hoisted(() => ({ clearHighlightCache: vi.fn() }));

vi.mock("@/lib/ipc", () => ({ ipc: ipcMock, errorMessage: (e: unknown) => String(e) }));
vi.mock("@/features/editor/monaco", () => ({ monaco: { editor: monacoMock } }));
vi.mock("@/features/terminals/registry", () => termsMock);
vi.mock("@/features/chat/highlight", () => highlightMock);
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => {
    throw new Error("not in Tauri");
  },
}));

const { loadAppearance, setAppearancePrefs } = await import("./appearance");
const { useApp } = await import("./store");

beforeEach(() => {
  vi.clearAllMocks();
  ipcMock.setSetting.mockResolvedValue(undefined);
  useApp.setState({ appearance: { theme: "midnight-hud" }, themeKey: "hud", toasts: [] });
});

describe("appearance", () => {
  it("switching applies the theme everywhere and saves the setting", async () => {
    await setAppearancePrefs({ theme: "graphite-light" });
    expect(useApp.getState().appearance).toEqual({ theme: "graphite-light" });
    expect(useApp.getState().themeKey).toBe("graphite-light");
    expect(monacoMock.setTheme).toHaveBeenCalledWith("graphite-light");
    expect(termsMock.applyTheme).toHaveBeenCalledTimes(1);
    expect(highlightMock.clearHighlightCache).toHaveBeenCalledTimes(1);
    expect(ipcMock.setSetting).toHaveBeenCalledWith("appearance", JSON.stringify({ theme: "graphite-light" }));
  });

  it("re-applying the same theme leaves terminals and code blocks alone", async () => {
    await setAppearancePrefs({ theme: "midnight-hud" });
    expect(monacoMock.setTheme).toHaveBeenCalledWith("midnight-hud");
    expect(termsMock.applyTheme).not.toHaveBeenCalled();
    expect(highlightMock.clearHighlightCache).not.toHaveBeenCalled();
  });

  it("a failed save keeps the theme and says so", async () => {
    ipcMock.setSetting.mockRejectedValue(new Error("disk full"));
    await setAppearancePrefs({ theme: "graphite-dark" });
    expect(useApp.getState().themeKey).toBe("graphite-dark");
    expect(useApp.getState().toasts.at(-1)?.tone).toBe("danger");
  });

  it("the saved setting is applied at startup without saving it again", () => {
    loadAppearance(JSON.stringify({ theme: "graphite-dark" }));
    expect(useApp.getState().themeKey).toBe("graphite-dark");
    expect(ipcMock.setSetting).not.toHaveBeenCalled();
  });
});
