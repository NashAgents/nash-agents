import type { ScheduledTaskRecord, ScheduledTaskRunRecord } from "./cluster-store.js";

// Shared row decoding keeps page queries and execution queries consistent.
export function decodeScheduledTask(r: Record<string, any>): ScheduledTaskRecord {
  return {
      id: r.id,
      name: r.name,
      description: r.description,
      enabled: Boolean(r.enabled),
      triggerType: r.trigger_type,
      cronExpression: r.cron_expression ?? undefined,
      intervalMs: r.interval_ms ? Number(r.interval_ms) : undefined,
      runAt: r.run_at ? Number(r.run_at) : undefined,
      timezone: r.timezone,
      targetType: r.target_type,
      taskConfig: typeof r.task_config === "object" ? r.task_config : {},
      graphConfig: typeof r.graph_config === "object" ? r.graph_config : {},
      concurrencyPolicy: r.concurrency_policy,
      misfirePolicy: r.misfire_policy,
      maxConcurrency: Number(r.max_concurrency),
      lastRunAt: r.last_run_at ? Number(r.last_run_at) : undefined,
      lastRunStatus: r.last_run_status ?? undefined,
      nextRunAt: r.next_run_at ? Number(r.next_run_at) : undefined,
      runCount: Number(r.run_count),
      createdBy: r.created_by,
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at),
    };
}

export function decodeScheduledRun(r: Record<string, any>): ScheduledTaskRunRecord {
  return {
      id: r.id,
      scheduledTaskId: r.scheduled_task_id,
      targetType: r.target_type,
      taskId: r.task_id ?? undefined,
      graphId: r.graph_id ?? undefined,
      triggerTime: Number(r.trigger_time),
      startedAt: Number(r.started_at),
      completedAt: r.completed_at ? Number(r.completed_at) : undefined,
      status: r.status,
      skipReason: r.skip_reason ?? undefined,
      error: r.error ?? undefined,
      resultSummary: r.result_summary ?? undefined,
      metrics: typeof r.metrics === "object" ? r.metrics : {},
      createdAt: Number(r.created_at),
    };
}
