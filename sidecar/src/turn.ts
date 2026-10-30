// One AgentHub turn: emits events to Rust, asks Rust for approvals, and
// guarantees exactly one `done`.

import type { AgentEvent, Decision, Outcome, PermissionRequest } from "./protocol.js";

export interface TurnTransport {
  notify(method: string, params: unknown): void;
  request<T = any>(method: string, params: unknown): Promise<T>;
}

const DECISIONS: readonly Decision[] = ["allow_once", "allow_session", "deny", "cancel"];

export class Turn {
  private finished = false;
  private doneListeners: ((o: Outcome) => void)[] = [];
  private pendingApprovals = new Set<(d: Decision) => void>();
  /** Set by the engine: how to stop the runtime for this turn. */
  onInterrupt?: () => void;
  interrupted = false;

  constructor(
    readonly id: string,
    readonly conversationId: string,
    private readonly transport: TurnTransport,
  ) {}

  get isDone(): boolean {
    return this.finished;
  }

  emit(event: AgentEvent): void {
    if (this.finished) return;
    if (event.type === "done") {
      this.done(event.outcome);
      return;
    }
    this.transport.notify("turn/event", { turnId: this.id, event });
  }

  done(outcome: Outcome): void {
    if (this.finished) return;
    this.transport.notify("turn/event", { turnId: this.id, event: { type: "done", outcome } });
    this.finished = true;
    for (const resolve of this.pendingApprovals) resolve("cancel");
    this.pendingApprovals.clear();
    for (const l of this.doneListeners) {
      try {
        l(outcome);
      } catch {
        // ignore
      }
    }
  }

  onDone(listener: (o: Outcome) => void): void {
    this.doneListeners.push(listener);
  }

  /**
   * Asks AgentHub (its policy, or the user) and waits as long as that takes.
   * Anything unexpected is a denial; a finished turn answers `cancel`.
   */
  approval(key: string, request: PermissionRequest): Promise<Decision> {
    if (this.finished || this.interrupted) return Promise.resolve("cancel");
    return new Promise<Decision>((resolve) => {
      let settled = false;
      const settle = (d: Decision) => {
        if (settled) return;
        settled = true;
        this.pendingApprovals.delete(settle);
        resolve(d);
      };
      this.pendingApprovals.add(settle);
      this.transport.request("turn/approval", { turnId: this.id, key, request }).then(
        (r: any) => settle(DECISIONS.includes(r?.decision) ? r.decision : "deny"),
        () => settle("deny"),
      );
    });
  }

  interrupt(): void {
    if (this.finished || this.interrupted) return;
    this.interrupted = true;
    for (const resolve of [...this.pendingApprovals]) resolve("cancel");
    if (this.onInterrupt) this.onInterrupt();
    else this.done({ type: "cancelled" });
  }
}
