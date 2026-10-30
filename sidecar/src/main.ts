// Entry point: `node sidecar/dist/main.mjs`. stdout carries only JSON-RPC
// messages; everything else goes to stderr (never prompts, keys or tokens).

import { ClaudeEngine } from "./claude.js";
import { CopilotEngine } from "./copilot.js";
import { log } from "./engine.js";
import { Rpc } from "./rpc.js";
import { serve } from "./server.js";

// Keep stdout clean even if a dependency logs.
console.log = console.error;
console.info = console.error;
console.debug = console.error;
console.warn = console.error;

const [major, minor] = process.versions.node.split(".").map(Number);
if (!(major > 22 || (major === 22 && minor >= 12) || (major === 20 && minor >= 19))) {
  log(`Node.js ${process.versions.node} is too old (needs 20.19+ or 22.12+)`);
  process.exit(3);
}

const write = (line: string) => {
  process.stdout.write(line);
};
const rpc = new Rpc(process.stdin, write);
process.stdout.on("error", () => rpc.close());

serve(rpc, {
  engines: { "claude-code": new ClaudeEngine(), "copilot-cli": new CopilotEngine() },
  exit: (code) => process.exit(code),
});

process.on("uncaughtException", (e) => log(`uncaught: ${e instanceof Error ? e.name : "error"}`));
process.on("unhandledRejection", () => log("unhandled rejection"));
