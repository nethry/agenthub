import type { ProbeResult, TurnStartParams } from "./protocol.js";
import type { Turn } from "./turn.js";

export interface Engine {
  probe(executable?: string): Promise<ProbeResult>;
  /** Runs the turn in the background; the turn ends with exactly one `done`. */
  startTurn(params: TurnStartParams, turn: Turn): void;
  closeSession(conversationId: string): Promise<void>;
  shutdown(): Promise<void>;
}

/** Log line for stderr. Never pass prompts, file contents, keys or tokens here. */
export function log(message: string): void {
  try {
    process.stderr.write(`[sidecar] ${message}\n`);
  } catch {
    // stderr closed
  }
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** A promise that resolves after `ms`, or with the value. */
export function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => T): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => resolve(onTimeout()), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}
