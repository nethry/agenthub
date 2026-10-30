// Newline-delimited JSON-RPC 2.0 over a pair of streams (stdin/stdout in
// production). Requests from either side may be in flight concurrently.

import { createInterface } from "node:readline";
import type { Readable } from "node:stream";

export type Handler = (params: any) => Promise<unknown> | unknown;

export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

/** Thrown to pending requests once the other side is gone. */
export class RpcClosed extends Error {
  constructor() {
    super("The connection to AgentHub closed");
  }
}

interface Pending {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
}

export class Rpc {
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private handlers = new Map<string, Handler>();
  private closed = false;
  private closeListeners: (() => void)[] = [];

  constructor(
    input: Readable,
    private readonly write: (line: string) => void,
  ) {
    const rl = createInterface({ input, crlfDelay: Infinity });
    rl.on("line", (line) => this.onLine(line));
    rl.on("close", () => this.close());
  }

  on(method: string, handler: Handler): void {
    this.handlers.set(method, handler);
  }

  onClose(listener: () => void): void {
    this.closeListeners.push(listener);
  }

  get isClosed(): boolean {
    return this.closed;
  }

  notify(method: string, params: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  /** Waits for the answer as long as it takes (approvals wait for the user). */
  request<T = any>(method: string, params: unknown): Promise<T> {
    if (this.closed) return Promise.reject(new RpcClosed());
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  private send(msg: unknown): void {
    if (this.closed) return;
    try {
      this.write(`${JSON.stringify(msg)}\n`);
    } catch {
      this.close();
    }
  }

  private onLine(line: string): void {
    const text = line.trim();
    if (!text) return;
    let msg: any;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object") return;
    const hasId = msg.id !== undefined && msg.id !== null;
    if (typeof msg.method === "string") {
      if (hasId) void this.onRequest(msg.id, msg.method, msg.params);
      else void this.onNotification(msg.method, msg.params);
      return;
    }
    if (hasId && typeof msg.id === "number") {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new RpcError(Number(msg.error.code) || 0, String(msg.error.message ?? "Unknown error")));
      else p.resolve(msg.result);
    }
  }

  private async onRequest(id: unknown, method: string, params: unknown): Promise<void> {
    const handler = this.handlers.get(method);
    if (!handler) {
      this.send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown method ${method}` } });
      return;
    }
    try {
      const result = await handler(params ?? {});
      this.send({ jsonrpc: "2.0", id, result: result ?? {} });
    } catch (e) {
      const code = e instanceof RpcError ? e.code : -32603;
      const message = e instanceof Error ? e.message : String(e);
      this.send({ jsonrpc: "2.0", id, error: { code, message } });
    }
  }

  private async onNotification(method: string, params: unknown): Promise<void> {
    const handler = this.handlers.get(method);
    if (!handler) return;
    try {
      await handler(params ?? {});
    } catch {
      // notifications have no answer
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) p.reject(new RpcClosed());
    this.pending.clear();
    for (const l of this.closeListeners) {
      try {
        l();
      } catch {
        // ignore
      }
    }
  }
}
