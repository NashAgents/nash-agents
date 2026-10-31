import type { ScheduledTaskRecord, ScheduledTaskRunRecord } from "../storage/cluster-store.js";

export class ScheduleAdmissionError extends Error {
  constructor(message: string) { super(message); this.name = "ScheduleAdmissionError"; }
}

/** Called inside the store's atomic admission boundary, before any external dispatch. */
export function decideScheduleAdmission(task: ScheduledTaskRecord, candidate: ScheduledTaskRunRecord,
  existing: ScheduledTaskRunRecord | null, unsettled: ScheduledTaskRunRecord[], force = false
): { run: ScheduledTaskRunRecord; admitted: boolean } {
  if (!Number.isSafeInteger(task.maxConcurrency) || task.maxConcurrency < 1) throw new ScheduleAdmissionError("Invalid schedule concurrency limit");
  if (existing && existing.scheduledTaskId !== task.id) throw new ScheduleAdmissionError("Scheduled run ownership mismatch");
  if (existing && existing.status !== "queued") return { run: existing, admitted: false };
  const active = unsettled.filter(r => r.id !== candidate.id && ["running", "outcome_unknown"].includes(r.status));
  const blocked = active.some(r => r.status === "outcome_unknown") || !force && active.length >= (task.concurrencyPolicy === "ALLOW_CONCURRENT" ? Math.max(1, task.maxConcurrency) : 1);
  const run = structuredClone(existing ?? candidate);
  if (!task.enabled && !run.metrics?.isManual) {
    run.status = "skipped";
    run.skipReason = "schedule_disabled";
    run.completedAt = Date.now();
    return { run, admitted: false };
  }
  if (!blocked) {
    run.status = "running";
    run.startedAt = Date.now();
    return { run, admitted: true };
  }
  if (existing) return { run, admitted: false };
  if (task.concurrencyPolicy === "QUEUE" && unsettled.filter(r => r.status === "queued").length < 5) {
    run.status = "queued";
  } else {
    run.status = "skipped";
    run.skipReason = active.some(r => r.status === "outcome_unknown") ? "outcome_unknown" : "concurrency_skip";
    run.completedAt = Date.now();
  }
  return { run, admitted: false };
}
