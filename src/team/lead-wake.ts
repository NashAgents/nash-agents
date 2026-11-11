import type { TeamRuntime } from "./team-runtime.js";

/** Coalesces idle wakeups without consuming mailbox messages. Owned by the CLI session loop. */
export class LeadWake {
  private closed = false;
  private readonly attempted = new Map<string, string>();
  private readonly unsubscribe: () => void;

  constructor(private readonly team: TeamRuntime, private readonly agentId: string, private readonly currentSession: () => string, private readonly wake: () => void) {
    this.unsubscribe = team.onCompletion((agentId, sessionId) => {
      if (!this.closed && agentId === this.agentId && sessionId === this.currentSession()) this.wake();
    });
  }

  take(): boolean {
    if (this.closed) return false;
    const session = this.currentSession();
    const ids = this.team.mailbox.pendingNotificationIds(this.agentId, session).sort();
    if (!ids.length) return false;
    const fingerprint = JSON.stringify(ids);
    if (this.attempted.get(session) === fingerprint) return false;
    this.attempted.set(session, fingerprint);
    return true;
  }

  close(): void {
    this.closed = true;
    this.unsubscribe();
  }
}
