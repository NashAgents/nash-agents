import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { ClusterEnvelope } from "../protocol/types.js";

export class ExecutionJournalError extends Error {
  constructor(message: string) { super(message); this.name = "ExecutionJournalError"; }
}

export interface ExecutionRecord {
  taskId: string;
  runId: string;
  terminal?: ClusterEnvelope;
  confirmed?: boolean;
  inboundMessageIds?: string[];
}

/** 先落盘认领再执行；进程崩溃后无法证明完成的运行不得自动重入。 */
export class ExecutionJournal {
  constructor(readonly directory: string) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  }

  eventPath(taskId: string): string { return this.file(taskId).replace(/\.json$/, ".events.json"); }

  private file(taskId: string): string {
    return path.join(this.directory, `${crypto.createHash("sha256").update(taskId).digest("hex")}.json`);
  }

  get(taskId: string): ExecutionRecord | undefined {
    try { return JSON.parse(fs.readFileSync(this.file(taskId), "utf8")) as ExecutionRecord; }
    catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw err; }
  }

  claim(taskId: string, runId: string): boolean {
    try { fs.writeFileSync(this.file(taskId), JSON.stringify({ taskId, runId }), { flag: "wx", mode: 0o600, flush: true }); return true; }
    catch (err) { if ((err as NodeJS.ErrnoException).code === "EEXIST") return false; throw err; }
  }

  recordInbound(taskId: string, messageId: string): boolean {
    const record = this.get(taskId);
    if (!record || record.terminal) return false;
    if (record.inboundMessageIds?.includes(messageId)) return false;
    record.inboundMessageIds = [...(record.inboundMessageIds ?? []), messageId];
    this.write(record);
    return true;
  }

  confirm(taskId: string, runId: string): void {
    const record = this.get(taskId);
    if (!record?.terminal || record.runId !== runId) return;
    record.confirmed = true;
    this.write(record);
  }

  private write(record: ExecutionRecord): void {
    const file = this.file(record.taskId);
    const temporary = `${file}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(record), { mode: 0o600, flush: true });
      fs.renameSync(temporary, file);
    } finally { fs.rmSync(temporary, { force: true }); }
  }

  finish(envelope: ClusterEnvelope): void {
    const p = envelope.payload as { taskId: string; runId: string };
    const record = this.get(p.taskId);
    if (!record || record.runId !== p.runId) throw new ExecutionJournalError("Execution journal identity mismatch");
    this.write({ ...record, terminal: envelope });
  }

  list(): ExecutionRecord[] {
    return fs.readdirSync(this.directory).filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
      .map((name) => JSON.parse(fs.readFileSync(path.join(this.directory, name), "utf8")) as ExecutionRecord);
  }
}
