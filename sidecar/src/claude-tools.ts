// Pure mapping of Claude Code tool calls to AgentHub permission requests,
// item bodies and plans.

import { isAbsolute, relative, resolve } from "node:path";
import type { ItemBody, PermissionRequest, PlanStep, ToolKind } from "./protocol.js";
import { truncate } from "./protocol.js";

export const READ_TOOLS = ["Read", "Glob", "Grep"] as const;
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const COMMAND_TOOLS = new Set(["Bash", "PowerShell"]);

/**
 * Built-in tools that would change the session's permission mode, need a UI
 * AgentHub doesn't have, or schedule work outside the turn. Removed in Agent mode.
 */
export const AGENT_DISALLOWED_TOOLS = [
  "EnterPlanMode",
  "ExitPlanMode",
  "AskUserQuestion",
  "EnterWorktree",
  "ExitWorktree",
  "CronCreate",
  "CronDelete",
  "CronList",
  "ScheduleWakeup",
  "RemoteTrigger",
  "PushNotification",
  "SendUserFile",
  "SendUserMessage",
  "OfferChromeSetup",
  "ShowOnboardingRolePicker",
  "ShareOnboardingGuide",
];

type Input = Record<string, unknown>;

const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);

export function absPath(cwd: string, p: string): string {
  return isAbsolute(p) ? resolve(p) : resolve(cwd, p);
}

/** Path for display: project-relative when inside the project. */
export function displayPath(cwd: string, p: string): string {
  const abs = absPath(cwd, p);
  const rel = relative(cwd, abs);
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel.replace(/\\/g, "/") : abs;
}

function filePathOf(name: string, input: Input): string | undefined {
  return name === "NotebookEdit" ? str(input.notebook_path) : str(input.file_path);
}

function mcpTitle(name: string): string {
  const [, server, ...rest] = name.split("__");
  return `Use MCP tool ${server ?? "?"}${rest.length ? ` › ${rest.join("__")}` : ""}`;
}

function inputDetail(input: Input): string | undefined {
  try {
    const s = JSON.stringify(input);
    return s && s !== "{}" ? truncate(s, 600) : undefined;
  } catch {
    return undefined;
  }
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).host || undefined;
  } catch {
    return undefined;
  }
}

/** What AgentHub's policy decides on. Paths are absolute. */
export function permissionFor(name: string, rawInput: unknown, cwd: string): PermissionRequest {
  const input = (rawInput && typeof rawInput === "object" ? rawInput : {}) as Input;
  const base = { paths: [] as string[], canAllowSession: true };
  if (name === "Read") {
    const p = str(input.file_path);
    return { ...base, kind: "read", title: p ? `Read ${displayPath(cwd, p)}` : "Read a file", path: p ? absPath(cwd, p) : undefined };
  }
  if (name === "Glob" || name === "Grep") {
    const p = absPath(cwd, str(input.path) ?? ".");
    const pattern = str(input.pattern) ?? "";
    return { ...base, kind: "read", title: `${name === "Glob" ? "Find files" : "Search"} ${truncate(pattern, 80)}`.trim(), path: p };
  }
  if (WRITE_TOOLS.has(name)) {
    const p = filePathOf(name, input);
    return {
      ...base,
      kind: "write",
      title: p ? `${name === "Write" ? "Write" : "Edit"} ${displayPath(cwd, p)}` : "Edit a file",
      path: p ? absPath(cwd, p) : undefined,
    };
  }
  if (COMMAND_TOOLS.has(name)) {
    const command = str(input.command) ?? "";
    return { ...base, kind: "command", title: "Run a command", command, detail: str(input.description) };
  }
  if (name === "WebFetch") {
    const url = str(input.url) ?? "";
    return { ...base, kind: "network", title: `Fetch ${hostOf(url) ?? "a web page"}`, detail: truncate(url, 500) };
  }
  if (name === "WebSearch") {
    return { ...base, kind: "network", title: "Search the web", detail: truncate(str(input.query) ?? "", 300) };
  }
  if (name.startsWith("mcp__")) {
    return { ...base, kind: "mcp", title: mcpTitle(name), detail: inputDetail(input) };
  }
  if (name === "TodoWrite") {
    return { ...base, kind: "other", title: "Update the task list", detail: inputDetail(input) };
  }
  return { ...base, kind: "other", title: `Use ${name}`, detail: inputDetail(input) };
}

/**
 * What an "allow for this session" answer covers: the same tool on the same
 * target (exact command, file or host).
 */
export function grantKey(name: string, rawInput: unknown, cwd: string): string {
  const input = (rawInput && typeof rawInput === "object" ? rawInput : {}) as Input;
  const req = permissionFor(name, input, cwd);
  if (req.kind === "command") return `${name}\u0000${req.command ?? ""}`;
  if (req.kind === "read" || req.kind === "write") return `${name}\u0000${(req.path ?? "").toLowerCase()}`;
  if (name === "WebFetch") return `${name}\u0000${hostOf(str(input.url) ?? "") ?? ""}`;
  return name;
}

function toolKind(name: string): ToolKind {
  if (name === "Read") return "read";
  if (name === "Glob" || name === "Grep") return "search";
  if (WRITE_TOOLS.has(name)) return "edit";
  if (name === "WebFetch" || name === "WebSearch") return "fetch";
  if (name.startsWith("mcp__")) return "mcp";
  if (name === "Agent" || name === "Task") return "think";
  return "other";
}

/** Item for a tool call; `undefined` for TodoWrite (it becomes a plan). */
export function bodyFor(name: string, rawInput: unknown, cwd: string): ItemBody | undefined {
  if (name === "TodoWrite") return undefined;
  const input = (rawInput && typeof rawInput === "object" ? rawInput : {}) as Input;
  if (COMMAND_TOOLS.has(name)) return { kind: "command", command: str(input.command) ?? "", cwd, output: "" };
  const req = permissionFor(name, input, cwd);
  let title = req.title;
  let detail: string | undefined;
  if (name === "Agent" || name === "Task") {
    title = `Run a subagent${str(input.description) ? `: ${truncate(str(input.description)!, 80)}` : ""}`;
  } else if (name === "WebFetch" || name === "WebSearch") {
    detail = req.detail;
  } else if (req.kind === "mcp" || req.kind === "other") {
    detail = req.detail;
  }
  return { kind: "tool", tool: toolKind(name), title, detail };
}

export function planFrom(rawInput: unknown): PlanStep[] | undefined {
  const todos = (rawInput as { todos?: unknown })?.todos;
  if (!Array.isArray(todos)) return undefined;
  const steps: PlanStep[] = [];
  for (const t of todos) {
    const text = str((t as Input)?.content);
    if (!text) continue;
    const s = (t as Input).status;
    steps.push({ text, status: s === "completed" || s === "in_progress" ? s : "pending" });
  }
  return steps;
}

/** Text of a tool_result `content` (string or content blocks). */
export function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === "object" && (b as Input).type === "text" ? String((b as Input).text ?? "") : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/** "Exit code 2\n..." in a failed Bash result. */
export function exitCodeOf(text: string): number | undefined {
  const m = /^Exit code (-?\d+)/m.exec(text);
  return m ? Number(m[1]) : undefined;
}
