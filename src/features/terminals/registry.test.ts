import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  write: vi.fn().mockResolvedValue(undefined),
  readText: vi.fn<() => Promise<string>>(),
  keyHandler: undefined as ((event: KeyboardEvent) => boolean) | undefined,
  onData: undefined as ((data: string) => void) | undefined,
  paste: vi.fn<(text: string) => void>(),
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    loadAddon() {}
    attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean) {
      mocks.keyHandler = handler;
    }
    onData(handler: (data: string) => void) { mocks.onData = handler; }
    paste(text: string) { mocks.paste(text); }
    dispose() {}
  },
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class {} }));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: class {} }));
vi.mock("@xterm/addon-webgl", () => ({ WebglAddon: class {} }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("@/lib/ipc", () => ({ ipc: { write: mocks.write } }));
vi.mock("@/app/store", () => ({
  get: () => ({ terminalPrefs: { fontSize: 14, scrollback: 1000 }, themeKey: "hud" }),
}));

const { ensure, dispose } = await import("./registry");

function keyEvent(type: string, shiftKey: boolean) {
  return Object.assign(new Event(type, { cancelable: true }), {
    key: "v", code: "KeyV", ctrlKey: true, shiftKey, altKey: false, metaKey: false,
  }) as KeyboardEvent;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("navigator", { clipboard: { readText: mocks.readText } });
  vi.stubGlobal("document", { createElement: () => ({ className: "", remove() {} }) });
  mocks.paste.mockImplementation((text) => mocks.onData?.(text));
  ensure("paste-test");
});

afterEach(() => {
  dispose("paste-test");
  vi.unstubAllGlobals();
});

describe("terminal paste shortcuts", () => {
  it.each([false, true])("cancels native paste before reading the clipboard (shift=%s)", async (shiftKey) => {
    let resolveClipboard!: (text: string) => void;
    mocks.readText.mockImplementation(() => new Promise((resolve) => { resolveClipboard = resolve; }));
    const event = keyEvent("keydown", shiftKey);

    expect(mocks.keyHandler!(event)).toBe(false);
    // Model the browser default action separately from xterm's handler result.
    // Without preventDefault, native paste and the async read both send input.
    if (!event.defaultPrevented) mocks.onData!("clipboard text");
    expect(event.defaultPrevented).toBe(true);
    expect(mocks.readText).toHaveBeenCalledTimes(1);
    expect(mocks.write).not.toHaveBeenCalled();

    resolveClipboard("clipboard text");
    await Promise.resolve();
    expect(mocks.paste).toHaveBeenCalledExactlyOnceWith("clipboard text");
    expect(mocks.write).toHaveBeenCalledExactlyOnceWith("paste-test", "clipboard text");

    expect(mocks.keyHandler!(keyEvent("keyup", shiftKey))).toBe(true);
    expect(mocks.readText).toHaveBeenCalledTimes(1);
  });

  it("keeps two intentional pastes of identical text", async () => {
    mocks.readText.mockResolvedValue("same text");
    mocks.keyHandler!(keyEvent("keydown", false));
    await Promise.resolve();
    mocks.keyHandler!(keyEvent("keydown", false));
    await Promise.resolve();
    expect(mocks.write).toHaveBeenCalledTimes(2);
    expect(mocks.write).toHaveBeenNthCalledWith(1, "paste-test", "same text");
    expect(mocks.write).toHaveBeenNthCalledWith(2, "paste-test", "same text");
  });
});
