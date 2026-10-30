// Test helpers (not bundled: only imported by *.test.ts).

import type { AgentEvent, Decision } from "./protocol.js";
import { AsyncQueue } from "./queue.js";
import { Turn, type TurnTransport } from "./turn.js";

export interface ApprovalCall {
  params: any;
  answer: (decision: Decision) => void;
}

/** Records events and lets the test answer approvals. */
export class FakeTransport implements TurnTransport {
  events: AgentEvent[] = [];
  approvals: ApprovalCall[] = [];
  /** When set, approvals are answered at once. */
  auto?: Decision;

  notify(method: string, params: any): void {
    if (method === "turn/event") this.events.push(params.event);
  }

  request<T>(method: string, params: any): Promise<T> {
    if (method !== "turn/approval") return Promise.reject(new Error(`unexpected ${method}`));
    return new Promise<T>((resolve) => {
      const answer = (decision: Decision) => resolve({ decision } as T);
      this.approvals.push({ params, answer });
      if (this.auto) answer(this.auto);
    });
  }

  types(): string[] {
    return this.events.map((e) => e.type);
  }

  done(): AgentEvent | undefined {
    return this.events.find((e) => e.type === "done");
  }
}

export function newTurn(transport: FakeTransport, id = "t1", conversationId = "c1"): Turn {
  return new Turn(id, conversationId, transport);
}

/** A scripted stand-in for the Claude Agent SDK's Query. */
export class FakeQuery {
  readonly out = new AsyncQueue<any>();
  readonly prompts: any[] = [];
  interrupted = 0;
  closed = false;

  constructor(
    readonly options: any,
    prompt: AsyncIterable<any> | string,
  ) {
    if (typeof prompt !== "string") {
      void (async () => {
        for await (const m of prompt) this.prompts.push(m);
      })();
    }
  }

  emit(msg: any): void {
    this.out.push(msg);
  }

  /** Ends the stream like a process exit (optionally with an error). */
  fail(error?: Error): void {
    this.failure = error;
    this.out.end();
  }
  private failure?: Error;

  async interrupt(): Promise<undefined> {
    this.interrupted++;
    return undefined;
  }

  close(): void {
    this.closed = true;
    this.out.end();
  }

  async supportedModels(): Promise<any[]> {
    return [{ value: "default", displayName: "Default", description: "" }, { value: "opus", displayName: "Opus", description: "" }];
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<any> {
    for await (const m of this.out) yield m;
    if (this.failure) throw this.failure;
  }

  /** Calls the PreToolUse hook like the CLI does. */
  preToolUse(name: string, input: unknown, id: string): Promise<any> {
    const hook = this.options.hooks.PreToolUse[0].hooks[0];
    return hook({ hook_event_name: "PreToolUse", tool_name: name, tool_input: input, tool_use_id: id, session_id: "s", transcript_path: "", cwd: "" }, id, {
      signal: new AbortController().signal,
    });
  }
}

export async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 5));
  }
}
