import { describe, expect, it } from "vitest";
import { defaultChatPrefs, type Conversation, type EngineInfo } from "@/lib/types";
import {
  chatModes,
  conversationsIn,
  dateGroup,
  defaultModelFor,
  ENGINE_LABEL,
  engineOn,
  ENGINE_ORDER,
  fitMode,
  isAgent,
  isValidModelId,
  listTime,
  matchesSearch,
  modeAvailability,
  modelsFor,
  needsAttention,
  needsModeConfirm,
  newChatEngine,
  shortModelLabel,
  statusChip,
  sumUsage,
  usageLine,
  visibleConversations,
} from "./models";

const info = (engine: EngineInfo["engine"], modes: EngineInfo["capabilities"]["modes"], state: EngineInfo["probe"]["state"] = "ready", models: EngineInfo["probe"]["models"] = []): EngineInfo => ({
  engine,
  label: engine,
  kind: engine.endsWith("-api") ? "api" : "agent",
  enabled: true,
  capabilities: {
    modes,
    unsupported: (["ask", "plan", "agent"] as const).filter((m) => !modes.includes(m)).map((m) => [m, `no ${m}`]),
    tools: true,
    fileRead: true,
    fileWrite: true,
    commands: true,
    approvals: true,
    sessionResume: true,
    modelDiscovery: true,
    usage: true,
    images: true,
    notes: [],
  },
  probe: { engine, state, message: null, path: null, version: null, account: null, models, probedAt: 1 },
});

const conv = (patch: Partial<Conversation>): Conversation => ({
  id: "c",
  projectId: "p",
  title: "Fix the flaky resize test",
  engine: "codex",
  model: "gpt-6.1-sol",
  mode: "agent",
  policy: "ask",
  status: "idle",
  runtimeSessionId: null,
  createdAt: 0,
  updatedAt: 0,
  ...patch,
});

describe("modes", () => {
  it("disables what the engine can't enforce, with its reason", () => {
    const codex = info("codex", ["plan", "agent"]);
    const gemini = info("gemini-cli", ["ask", "plan"]);
    expect(modeAvailability("gemini-cli", "agent", gemini, true)).toEqual({ ok: false, reason: "no agent" });
    expect(modeAvailability("codex", "plan", codex, true).ok).toBe(true);
    expect(modeAvailability("codex", "plan", codex, false)).toEqual({ ok: false, reason: "Coding agents work inside a project." });
    expect(modeAvailability("openai-api", "agent", undefined, true).ok).toBe(false);
    expect(fitMode("codex", "ask", codex, true)).toBe("plan");
  });

  it("keeps projects to coding agents in Plan/Agent and General to direct APIs in Ask", () => {
    const claude = info("claude-code", ["ask", "plan", "agent"]);
    expect(modeAvailability("claude-code", "ask", claude, true)).toMatchObject({ ok: false, reason: expect.stringContaining("Use Ask") });
    expect(modeAvailability("openai-api", "ask", info("openai-api", ["ask"]), true).ok).toBe(false);
    expect(modeAvailability("openai-api", "ask", info("openai-api", ["ask"]), false).ok).toBe(true);
    expect(fitMode("claude-code", "ask", claude, true)).toBe("plan");
    expect(chatModes(true)).toEqual(["plan", "agent"]);
    expect(chatModes(false)).toEqual(["ask"]);
    // An old default of a direct API for project chats falls back to an agent.
    const engines = [claude, info("openai-api", ["ask"])];
    expect(newChatEngine({ ...defaultChatPrefs, defaultEngine: "openai-api" }, engines, true)).toBe("claude-code");
  });

  it("escalation to Agent always needs confirmation", () => {
    expect(needsModeConfirm("plan", "agent")).toBe(true);
    expect(needsModeConfirm("ask", "agent")).toBe(true);
    expect(needsModeConfirm("agent", "plan")).toBe(false);
  });
});

describe("engines and models", () => {
  it("picks a ready engine for the workspace kind", () => {
    const engines = [info("claude-code", ["ask", "plan", "agent"], "not_found"), info("codex", ["plan", "agent"]), info("anthropic-api", ["ask"], "key_missing"), info("openai-api", ["ask"])];
    expect(newChatEngine(defaultChatPrefs, engines, true)).toBe("codex");
    expect(newChatEngine(defaultChatPrefs, engines, false)).toBe("openai-api");
  });

  it("skips turned-off engines and hides their chats", () => {
    const off = (e: EngineInfo): EngineInfo => ({ ...e, enabled: false });
    const engines = [off(info("claude-code", ["ask", "plan", "agent"])), info("codex", ["plan", "agent"]), off(info("anthropic-api", ["ask"])), info("openai-api", ["ask"])];
    expect(engineOn(engines, "claude-code")).toBe(false);
    expect(engineOn(engines, "codex")).toBe(true);
    expect(engineOn([], "claude-code")).toBe(true);
    expect(newChatEngine(defaultChatPrefs, engines, true)).toBe("codex");
    expect(newChatEngine(defaultChatPrefs, engines, false)).toBe("openai-api");
    const allOff = ENGINE_ORDER.map((e) => off(info(e, ["ask"])));
    expect(newChatEngine(defaultChatPrefs, allOff, true)).toBe(defaultChatPrefs.defaultEngine);
    const list = [conv({ id: "a", engine: "claude-code" }), conv({ id: "b", engine: "codex" })];
    expect(visibleConversations(list, engines).map((c) => c.id)).toEqual(["b"]);
  });

  it("prefers probed models, then the catalog, plus custom IDs", () => {
    const prefs = { ...defaultChatPrefs, customModels: { codex: ["my-model"] } };
    const probed = info("codex", ["plan", "agent"], "ready", [{ id: "gpt-x", label: "GPT X", isDefault: true }]);
    expect(modelsFor("codex", probed, prefs).map((m) => m.id)).toEqual(["gpt-x", "my-model"]);
    expect(defaultModelFor("codex", probed, defaultChatPrefs)).toBe("gpt-x");
    expect(modelsFor("gemini-api", undefined, defaultChatPrefs)[0].id).toBe("gemini-3.8-flash");
    expect(shortModelLabel("claude-opus-5-5")).toBe("OPUS 5.5");
    expect(isValidModelId("models/gemini-3.8-flash")).toBe(true);
    expect(isValidModelId("bad id")).toBe(false);
  });

  it("treats Antigravity as a coding agent with the runtime's own default model", () => {
    expect(isAgent("antigravity")).toBe(true);
    expect(ENGINE_LABEL.antigravity).toBe("Antigravity");
    expect(modeAvailability("antigravity", "plan", undefined, false)).toEqual({ ok: false, reason: "Coding agents work inside a project." });
    expect(defaultModelFor("antigravity", undefined, defaultChatPrefs)).toBe("default");
    const probed = info("antigravity", ["ask", "plan", "agent"], "ready", [{ id: "gemini-x", label: "Gemini X", isDefault: true }]);
    expect(modelsFor("antigravity", probed, defaultChatPrefs).map((m) => m.id)).toEqual(["gemini-x"]);
    expect(defaultModelFor("antigravity", probed, defaultChatPrefs)).toBe("gemini-x");
  });
});

describe("status chips", () => {
  it("maps conversation status to the design's chips", () => {
    expect(statusChip(conv({}), true)).toBe("running");
    expect(statusChip(conv({ engine: "openai-api" }), true)).toBe("streaming");
    expect(statusChip(conv({ status: "waiting_for_approval" }), false)).toBe("approval");
    expect(statusChip(conv({ status: "interrupted" }), false)).toBe("interrupted");
    expect(statusChip(conv({ status: "failed" }), false)).toBe("error");
    expect(statusChip(conv({ status: "completed" }), false)).toBe("done");
    expect(statusChip(conv({ status: "completed", engine: "openai-api" }), false)).toBeNull();
    expect(needsAttention(conv({ status: "waiting_for_approval" }))).toBe(true);
    expect(needsAttention(conv({ status: "completed" }))).toBe(false);
  });
});

describe("conversation list", () => {
  it("separates General from projects and searches title, model and engine", () => {
    const list = [conv({ id: "a", projectId: null, updatedAt: 1 }), conv({ id: "b", updatedAt: 3 }), conv({ id: "c", updatedAt: 2 })];
    expect(conversationsIn(list, null).map((c) => c.id)).toEqual(["a"]);
    expect(conversationsIn(list, "p").map((c) => c.id)).toEqual(["b", "c"]);
    expect(matchesSearch(conv({}), "resize")).toBe(true);
    expect(matchesSearch(conv({}), "codex")).toBe(true);
    expect(matchesSearch(conv({}), "gemini")).toBe(false);
  });

  it("formats list times", () => {
    const now = new Date(2026, 9, 27, 14, 0).getTime();
    expect(dateGroup(now - 60_000, now)).toBe("Today");
    expect(listTime(new Date(2026, 9, 27, 9, 5).getTime(), now)).toBe("09:05");
    expect(listTime(new Date(2026, 9, 26, 9, 5).getTime(), now)).toBe("YESTERDAY");
  });
});

describe("usage line", () => {
  it("shows only what the engine reported", () => {
    expect(usageLine(null)).toBeNull();
    expect(usageLine({ inputTokens: 1880, outputTokens: 141, costUsd: null })).toBe("1,880 IN · 141 OUT");
    expect(usageLine({ inputTokens: null, outputTokens: null, costUsd: 0.0021 })).toBe("$0.0021 REPORTED");
  });

  it("totals a chat's reported usage without inventing a cost", () => {
    expect(sumUsage([null, null])).toBeNull();
    expect(
      sumUsage([
        { inputTokens: 100, outputTokens: 20, costUsd: null },
        null,
        { inputTokens: 50, outputTokens: null, costUsd: null },
      ]),
    ).toEqual({ inputTokens: 150, outputTokens: 20, costUsd: null });
  });
});
