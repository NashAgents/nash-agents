import type { SessionSummary } from "../context/types.js";
import stripAnsi from "strip-ansi";
import { truncateToDisplayWidth } from "./terminal-renderer.js";

export type ResumeSession = SessionSummary & { isLegacy?: boolean; sourceSessionsDir?: string };

/** Search and selection state for the full-screen resume view. */
export class SessionPicker {
  readonly sessions: ResumeSession[];
  readonly currentSessionId: string;
  query = "";
  selectedIndex = 0;

  constructor(sessions: ResumeSession[], currentSessionId: string) {
    this.sessions = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt);
    this.currentSessionId = currentSessionId;
  }

  get matches(): ResumeSession[] {
    const query = this.query.trim().toLocaleLowerCase();
    if (!query) return this.sessions;
    return this.sessions.filter((session) =>
      [session.sessionId, session.title, session.firstUserPrompt, session.lastUserPrompt]
        .some((value) => value?.toLocaleLowerCase().includes(query))
    );
  }

  setQuery(query: string): void {
    this.query = query;
    this.selectedIndex = 0;
  }

  move(delta: number): void {
    const count = this.matches.length;
    if (count) this.selectedIndex = Math.max(0, Math.min(count - 1, this.selectedIndex + delta));
  }

  get selected(): ResumeSession | undefined {
    return this.matches[this.selectedIndex];
  }

  render(columns: number, rows: number): string[] {
    const width = Math.max(20, columns - 2);
    const matches = this.matches;
    const roomy = rows >= 15;
    const itemHeight = roomy ? 2 : 1;
    const pageSize = Math.max(1, Math.floor((rows - 6) / itemHeight));
    const start = Math.min(Math.max(0, this.selectedIndex - pageSize + 1), Math.max(0, matches.length - pageSize));
    const visible = matches.slice(start, start + pageSize);
    const lines = [
      "\x1b[1m\x1b[36mResume a session\x1b[0m",
      truncateToDisplayWidth(`\x1b[90m${matches.length} of ${this.sessions.length} sessions · newest first · current marked ●\x1b[0m`, width),
      "",
    ];

    if (!visible.length) lines.push("  No matches. Try a prompt or session ID.");
    for (let i = 0; i < visible.length; i++) {
      const session = visible[i];
      const selected = start + i === this.selectedIndex;
      const current = session.sessionId === this.currentSessionId;
      const title = stripAnsi(session.title || session.firstUserPrompt || "(Empty session)").replace(/[\x00-\x1f\x7f]/g, " ");
      const marker = selected ? "\x1b[36m>\x1b[0m" : " ";
      const currentLabel = current ? " \x1b[32m● current\x1b[0m" : "";
      const legacyLabel = session.isLegacy ? " \x1b[33mlegacy\x1b[0m" : "";
      lines.push(truncateToDisplayWidth(`${marker}${currentLabel}${legacyLabel} \x1b[1m${title.replace(/\s+/g, " ").trim()}\x1b[0m`, Math.min(width, 94)));
      if (roomy) {
        const date = new Date(session.updatedAt).toLocaleString("zh-CN", { hour12: false });
        lines.push(truncateToDisplayWidth(`    \x1b[90m${date} · ${session.messageCount} messages · ${session.sessionId}\x1b[0m`, width));
      }
    }
    while (lines.length < rows - 3) lines.push("");
    lines.push(truncateToDisplayWidth(`\x1b[90m↑↓ choose · PgUp/PgDn page · type to search · Enter resume · Esc cancel\x1b[0m`, width));
    lines.push(truncateToDisplayWidth(`\x1b[36mSearch\x1b[0m > ${this.query}`, width));
    return lines.slice(0, rows);
  }
}
