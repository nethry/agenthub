// Pure mapping of Copilot runtime permission requests and tool events.

import { absPath, displayPath } from "./claude-tools.js";
import type { ItemBody, PermissionRequest, ToolKind } from "./protocol.js";
import { truncate } from "./protocol.js";

/**
 * Read-only built-in tools allowed in Plan mode (names from the runtime's own
 * read-only agent definitions). Anything else isn't even offered to the model.
 */
export const PLAN_TOOL_NAMES = ["view", "glob", "grep", "rg"];
export const PLAN_TOOLS = PLAN_TOOL_NAMES.map((n) => `builtin:${n}`);
const SHELL_TOOLS = new Set(["bash", "powershell", "shell", "read_bash", "write_bash", "stop_bash", "read_powershell", "write_powershell", "stop_powershell"]);
const EDIT_TOOLS = new Set(["create", "edit", "str_replace", "str_replace_editor", "apply_patch", "write", "insert"]);

/** The `approve-for-session` payload the runtime accepts for this request, if any. */
export type SessionApproval = { approval?: Record<string, unknown>; domain?: string };

export interface MappedPermission {
  request: PermissionRequest;
  session?: SessionApproval;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).host || undefined;
  } catch {
    return undefined;
  }
}

function json(v: unknown, max = 600): string | undefined {
  if (v === undefined) return undefined;
  try {
    return truncate(JSON.stringify(v), max);
  } catch {
    return undefined;
  }
}

export function copilotPermission(req: any, cwd: string): MappedPermission {
  const managed = req?.managedApprovalRequired === true;
  const withManaged = (m: MappedPermission): MappedPermission => {
    if (!managed) return m;
    const note = "Your organization requires approval for this.";
    return { request: { ...m.request, canAllowSession: false, detail: m.request.detail ? `${m.request.detail}\n${note}` : note } };
  };
  const intention = str(req?.intention);
  switch (req?.kind) {
    case "shell": {
      const canSession = req.canOfferSessionApproval === true;
      const ids = Array.isArray(req.commands) ? req.commands.map((c: any) => String(c?.identifier ?? "")).filter(Boolean) : [];
      return withManaged({
        request: { kind: "command", title: "Run a command", command: String(req.fullCommandText ?? ""), paths: [], detail: intention, canAllowSession: canSession && ids.length > 0 },
        session: canSession && ids.length > 0 ? { approval: { kind: "commands", commandIdentifiers: ids } } : undefined,
      });
    }
    case "write": {
      const file = str(req.resolvedPath) ?? str(req.fileName) ?? "";
      const paths = new Set<string>();
      for (const e of Array.isArray(req.fileEdits) ? req.fileEdits : []) {
        for (const p of [e?.before?.path, e?.after?.path]) if (str(p)) paths.add(absPath(cwd, p));
      }
      const main = file ? absPath(cwd, file) : undefined;
      if (main) paths.delete(main);
      const canSession = req.canOfferSessionApproval === true;
      return withManaged({
        request: { kind: "write", title: file ? `Edit ${displayPath(cwd, file)}` : "Edit a file", path: main, paths: [...paths], detail: intention, canAllowSession: canSession },
        session: canSession ? { approval: { kind: "write" } } : undefined,
      });
    }
    case "read": {
      const file = str(req.resolvedPath) ?? str(req.path) ?? "";
      return withManaged({
        request: { kind: "read", title: file ? `Read ${displayPath(cwd, file)}` : "Read a file", path: file ? absPath(cwd, file) : undefined, paths: [], detail: intention, canAllowSession: true },
        session: { approval: { kind: "read" } },
      });
    }
    case "url": {
      const url = String(req.url ?? "");
      const host = hostOf(url);
      return withManaged({
        request: { kind: "network", title: `Fetch ${host ?? "a web page"}`, paths: [], detail: truncate(url, 500), canAllowSession: Boolean(host) },
        session: host ? { domain: host } : undefined,
      });
    }
    case "mcp": {
      const server = String(req.serverName ?? "");
      const tool = String(req.toolName ?? "");
      return withManaged({
        request: { kind: "mcp", title: `Use MCP tool ${server}${req.toolTitle || tool ? ` › ${req.toolTitle || tool}` : ""}`, paths: [], detail: json(req.args), canAllowSession: Boolean(server) },
        session: server ? { approval: { kind: "mcp", serverName: server, toolName: tool || null } } : undefined,
      });
    }
    case "memory":
      return withManaged({
        request: { kind: "other", title: "Save a memory", paths: [], detail: truncate(String(req.fact ?? ""), 500), canAllowSession: true },
        session: { approval: { kind: "memory" } },
      });
    case "custom-tool": {
      const tool = String(req.toolName ?? "");
      return withManaged({
        request: { kind: "other", title: `Use ${tool || "a custom tool"}`, paths: [], detail: json(req.args), canAllowSession: Boolean(tool) },
        session: tool ? { approval: { kind: "custom-tool", toolName: tool } } : undefined,
      });
    }
    default:
      return withManaged({
        request: { kind: "other", title: `Allow ${String(req?.kind ?? "an operation")}${str(req?.toolName) ? ` (${req.toolName})` : ""}`, paths: [], detail: intention, canAllowSession: false },
      });
  }
}

export function isShellTool(name: string, data?: any): boolean {
  return SHELL_TOOLS.has(name) || Boolean(data?.shellToolInfo);
}

function toolKind(name: string, data: any): ToolKind {
  if (data?.mcpServerName) return "mcp";
  if (name === "view") return "read";
  if (name === "glob" || name === "grep" || name === "rg") return "search";
  if (EDIT_TOOLS.has(name)) return "edit";
  if (name === "web_fetch" || name === "fetch" || name === "web_search") return "fetch";
  if (name === "task" || name === "read_agent") return "think";
  return "other";
}

/** Item for a `tool.execution_start` event. */
export function copilotBody(data: any, cwd: string): ItemBody {
  const name = String(data?.toolName ?? "tool");
  const args = data?.arguments && typeof data.arguments === "object" ? data.arguments : {};
  if (isShellTool(name, data)) {
    const command = str(args.command) ?? str(data?.shellToolInfo?.displayCommand) ?? name;
    return { kind: "command", command, cwd, output: "" };
  }
  const path = str(args.path) ?? str(args.file_path) ?? str(args.fileName);
  let title = str(data?.toolTitle) ?? name;
  if (!data?.toolTitle && path) title = `${name} ${displayPath(cwd, path)}`;
  return { kind: "tool", tool: toolKind(name, data), title: truncate(title, 200), detail: path ? undefined : json(data?.arguments, 300) };
}
