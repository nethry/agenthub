import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UpdateInfo, UpdateProgress } from "@/lib/types";

// The backend is mocked: these tests cover the update flows only.
const ipcMock = vi.hoisted(() => ({
  updateCheck: vi.fn(),
  updateDownload: vi.fn(),
  updateDownloaded: vi.fn(),
  updateInstall: vi.fn(),
  setSetting: vi.fn(),
}));
const listeners = vi.hoisted(() => ({ available: null as null | ((i: UpdateInfo) => void) }));

vi.mock("@/lib/ipc", () => ({
  ipc: ipcMock,
  onUpdateAvailable: (cb: (i: UpdateInfo) => void) => {
    listeners.available = cb;
    return Promise.resolve(() => {});
  },
  // The fake channel just carries the handler, so tests can push progress.
  updateChannel: (onProgress: (p: UpdateProgress) => void) => ({ onProgress }),
  errorMessage: (e: unknown) => (e && typeof e === "object" && "message" in e ? String((e as { message: string }).message) : String(e)),
}));

const actions = await import("./actions");
const { getUpdates, initialUpdatesState, setUpdates } = await import("./store");
const { useApp } = await import("@/app/store");

const info = (version: string, notes: string | null = "- fixes"): UpdateInfo => ({ version, currentVersion: "0.1.0", notes, date: null });

beforeEach(() => {
  vi.clearAllMocks();
  setUpdates(initialUpdatesState(), true);
  useApp.setState({ dialog: null, toasts: [] });
  ipcMock.setSetting.mockResolvedValue(undefined);
  ipcMock.updateDownloaded.mockResolvedValue(null);
});

describe("update flows", () => {
  it("a manual check announces a newer version, or says it is up to date", async () => {
    ipcMock.updateCheck.mockResolvedValueOnce(info("0.2.0"));
    await actions.checkForUpdates();
    expect(getUpdates()).toMatchObject({ state: "available", info: { version: "0.2.0" } });
    expect(getUpdates().checkedAt).not.toBeNull();

    setUpdates(initialUpdatesState(), true);
    ipcMock.updateCheck.mockResolvedValueOnce(null);
    await actions.checkForUpdates();
    expect(getUpdates().state).toBe("idle");
    expect(useApp.getState().toasts.at(-1)?.message).toMatch(/up to date/);
  });

  it("shows a failed check as an error, then goes back", async () => {
    ipcMock.updateCheck.mockRejectedValueOnce({ message: "Couldn't check for updates: offline" });
    await actions.checkForUpdates();
    expect(getUpdates()).toMatchObject({ state: "error", error: "Couldn't check for updates: offline" });
    actions.dismissUpdateError();
    expect(getUpdates().state).toBe("idle");
  });

  it("downloads with progress, and only then is it ready (nothing installs by itself)", async () => {
    setUpdates({ state: "available", info: info("0.2.0") });
    let pushed: ((p: UpdateProgress) => void) | undefined;
    ipcMock.updateDownload.mockImplementation(async (channel: { onProgress: (p: UpdateProgress) => void }) => {
      pushed = channel.onProgress;
      pushed({ downloaded: 50, total: 100 });
      expect(getUpdates()).toMatchObject({ state: "downloading", progress: { downloaded: 50, total: 100 } });
      return info("0.2.0");
    });
    await actions.downloadUpdate();
    expect(getUpdates()).toMatchObject({ state: "ready", progress: null });
    expect(ipcMock.updateInstall).not.toHaveBeenCalled();
  });

  it("won't start a download without an announced update", async () => {
    await actions.downloadUpdate();
    expect(ipcMock.updateDownload).not.toHaveBeenCalled();
  });

  it("skipping a version saves it and hides that version, but a newer one shows", async () => {
    await actions.startUpdateEvents();
    setUpdates({ state: "available", info: info("0.2.0") });
    useApp.setState({ dialog: { type: "update" } });
    await actions.skipVersion();
    expect(ipcMock.setSetting).toHaveBeenCalledWith("updates", JSON.stringify({ autoCheck: true, skipped: "0.2.0" }));
    expect(getUpdates().state).toBe("idle");
    expect(useApp.getState().dialog).toBeNull();

    listeners.available?.(info("0.2.0"));
    expect(getUpdates().state).toBe("idle");
    listeners.available?.(info("0.3.0"));
    expect(getUpdates()).toMatchObject({ state: "available", info: { version: "0.3.0" } });
  });

  it("a manual check shows a skipped version again, and the daily event never resets a download", async () => {
    await actions.saveUpdatePrefs({ skipped: "0.2.0" });
    ipcMock.updateCheck.mockResolvedValue(info("0.2.0"));
    await actions.checkForUpdates();
    expect(getUpdates().state).toBe("available");

    await actions.startUpdateEvents();
    setUpdates({ state: "ready", info: info("0.2.0") });
    listeners.available?.(info("0.2.0"));
    expect(getUpdates().state).toBe("ready");
  });

  it("picks up an update downloaded earlier in this run", async () => {
    ipcMock.updateDownloaded.mockResolvedValue(info("0.2.0"));
    const mod = await import("./actions");
    // `startUpdateEvents` only attaches once per app run; a fresh module instance checks again.
    vi.resetModules();
    const fresh = await import("./actions");
    const { getUpdates: freshState } = await import("./store");
    await fresh.startUpdateEvents();
    expect(mod).toBeDefined();
    expect(freshState().state).toBe("ready");
  });

  it("shows an install failure instead of closing silently", async () => {
    setUpdates({ state: "ready", info: info("0.2.0") });
    ipcMock.updateInstall.mockRejectedValueOnce({ message: "Couldn't install the update: access denied" });
    await actions.installAndRestart();
    expect(getUpdates()).toMatchObject({ state: "error", error: "Couldn't install the update: access denied" });
  });
});
