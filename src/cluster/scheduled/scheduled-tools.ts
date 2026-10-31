/**
 * Nash Cluster Coordinator 定时调度管理工具集
 *
 * 供 Coordinator Main Agent 在多轮自然语言会话中自主识别并调用：
 * - create_scheduled_task: 创建定时或周期任务
 * - list_scheduled_tasks: 查询当前定时任务计划
 * - get_scheduled_task: 查看特定任务的配置与状态
 * - update_scheduled_task: 修改定时任务的时间或目标
 * - pause_scheduled_task: 暂停定时任务
 * - resume_scheduled_task: 恢复定时任务
 * - delete_scheduled_task: 删除定时任务
 * - run_scheduled_task_now: 立即执行一次定时任务 (不破坏周期)
 * - get_scheduled_task_history: 查看定时任务的历史执行记录
 */

import { randomUUID } from "node:crypto";
import type { Tool, ToolExecutionContext } from "../../tools/tool.js";
import type {
  IClusterStore,
  ScheduledTaskRecord,
  ScheduleTriggerType,
  ScheduledTargetType,
  ScheduleConcurrencyPolicy,
  ScheduleMisfirePolicy,
  ScheduledTaskRunStatus,
} from "../storage/cluster-store.js";
import type { ScheduleTriggerEngine } from "./schedule-trigger-engine.js";
import { isValidCronExpression } from "./cron-parser.js";
import { ScheduleTriggerEngine as EngineHelper } from "./schedule-trigger-engine.js";

export interface ScheduledToolsOptions {
  store: IClusterStore;
  engine: ScheduleTriggerEngine;
  coordinatorNodeId: string;
}

/**
 * 1. 创建定时计划
 */
export class CreateScheduledTaskTool implements Tool {
  readonly name = "create_scheduled_task";
  readonly description =
    "创建一个持久化的定时或周期性调度任务（如每天9点检查节点资源、每小时同步状态等）。支持 Cron 表达式、固定时间间隔或一次性未来时间。到期后由 Coordinator 自动调度 Worker 执行，绝不阻塞当前 AgentLoop。";

  readonly parameters = {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "定时任务简短名称，例如 '每日腾讯云服务巡检' 或 'WSL2字幕项目监控'",
      },
      description: {
        type: "string",
        description: "任务详细描述与背景说明",
      },
      triggerType: {
        type: "string",
        enum: ["cron", "interval", "once"],
        description: "触发类型：cron (标准Cron表达式), interval (固定间隔毫秒数), once (指定未来时间戳运行一次)",
      },
      cronExpression: {
        type: "string",
        description: "5段式 Cron 表达式（如 '0 9 * * *' 代表每天上午9点，'*/30 * * * *' 代表每30分钟，支持 '@hourly', '@daily', '@weekly'）",
      },
      intervalMs: {
        type: "number",
        description: "固定时间间隔（毫秒），例如 3600000 代表每小时执行一次",
      },
      runAt: {
        type: "number",
        description: "一次性执行的目标未来毫秒时间戳",
      },
      timezone: {
        type: "string",
        description: "时区名称，例如 'Asia/Shanghai' 或 'UTC'，默认 'UTC'",
      },
      targetType: {
        type: "string",
        enum: ["single_task", "graph"],
        description: "执行目标类型：single_task (单节点执行任务) 或 graph (分布式多节点 DAG 任务图)",
      },
      goal: {
        type: "string",
        description: "任务的核心执行目标与要求指令（非常关键，Worker 或 DAG 将依此目标执行）",
      },
      prompt: {
        type: "string",
        description: "任务的补充自然语言提示或具体约束上下文",
      },
      nodeId: {
        type: "string",
        description: "目标 Worker 节点 ID（若用户明确指定了在某个机器如 WSL2 / Mac / Tencent 执行，请严格填写对应 nodeId）",
      },
      projectId: {
        type: "string",
        description: "目标项目 ID，例如 'offline-subtitles' 或 'nash-agent'",
      },
      concurrencyPolicy: {
        type: "string",
        enum: ["SKIP_IF_RUNNING", "QUEUE", "ALLOW_CONCURRENT"],
        description: "并发策略：SKIP_IF_RUNNING (默认：若上一次未结束则跳过本次), QUEUE (排队执行), ALLOW_CONCURRENT (允许并发)",
      },
    },
    required: ["name", "triggerType", "goal"],
  };

  constructor(private readonly options: ScheduledToolsOptions) {}

  async execute(args: any, context?: ToolExecutionContext): Promise<any> {
    if (!args.name || !args.goal || !args.triggerType) {
      throw new Error("Missing required fields: name, triggerType, goal");
    }

    if (args.triggerType === "cron") {
      if (!args.cronExpression || !isValidCronExpression(args.cronExpression)) {
        throw new Error(`Invalid or missing cronExpression: '${args.cronExpression}'`);
      }
    } else if (args.triggerType === "interval") {
      if (!args.intervalMs || args.intervalMs <= 0) {
        throw new Error(`Invalid or missing intervalMs: ${args.intervalMs}`);
      }
    } else if (args.triggerType === "once") {
      if (!args.runAt || args.runAt <= Date.now()) {
        throw new Error(`Invalid runAt timestamp: must be in the future`);
      }
    }

    const id = `sched-${randomUUID()}`;
    const now = Date.now();
    const taskRecord: ScheduledTaskRecord = {
      id,
      name: args.name,
      description: args.description || "",
      enabled: true,
      triggerType: args.triggerType as ScheduleTriggerType,
      cronExpression: args.cronExpression,
      intervalMs: args.intervalMs,
      runAt: args.runAt,
      timezone: args.timezone || "UTC",
      targetType: (args.targetType as ScheduledTargetType) || "single_task",
      taskConfig: {
        goal: args.goal,
        prompt: args.prompt,
        nodeId: args.nodeId,
        projectId: args.projectId,
      },
      concurrencyPolicy: (args.concurrencyPolicy as ScheduleConcurrencyPolicy) || "SKIP_IF_RUNNING",
      misfirePolicy: "RUN_ONCE_IMMEDIATELY",
      maxConcurrency: 1,
      runCount: 0,
      createdBy: "coordinator",
      createdAt: now,
      updatedAt: now,
    };

    // 计算初次触发时间
    const nextRun = EngineHelper.calculateNextRunTime(taskRecord, now);
    taskRecord.nextRunAt = nextRun;

    await this.options.store.saveScheduledTask?.(taskRecord);
    await this.options.engine.reschedule();

    return {
      success: true,
      scheduledTaskId: id,
      name: taskRecord.name,
      triggerType: taskRecord.triggerType,
      cronExpression: taskRecord.cronExpression,
      nextRunAt: nextRun ? new Date(nextRun).toISOString() : "none",
      nextRunAtTimestamp: nextRun,
      targetNodeId: args.nodeId ?? "auto-routed",
      status: "active",
      message: `已成功创建持久化定时任务 '${args.name}'。下次计划执行时间: ${nextRun ? new Date(nextRun).toLocaleString() : "待定"}`,
    };
  }
}

/**
 * 2. 查询定时计划列表
 */
export class ListScheduledTasksTool implements Tool {
  readonly name = "list_scheduled_tasks";
  readonly description = "查询当前系统中的所有定时调度任务及其运行状态、下一次触发时间和最近执行结果。";
  readonly parameters = {
    type: "object",
    properties: {
      enabledOnly: {
        type: "boolean",
        description: "是否只查询已启用的任务，默认 false 返回全部",
      },
    },
  };

  constructor(private readonly options: ScheduledToolsOptions) {}

  async execute(args: any): Promise<any> {
    const filter = args?.enabledOnly ? { enabled: true } : undefined;
    const tasks = (await this.options.store.listScheduledTasks?.(filter)) ?? [];

    return {
      total: tasks.length,
      tasks: tasks.map((t) => ({
        id: t.id,
        name: t.name,
        enabled: t.enabled,
        triggerType: t.triggerType,
        cronExpression: t.cronExpression,
        intervalMs: t.intervalMs,
        targetType: t.targetType,
        goal: t.taskConfig?.goal,
        nodeId: t.taskConfig?.nodeId,
        nextRunAt: t.nextRunAt ? new Date(t.nextRunAt).toISOString() : null,
        lastRunAt: t.lastRunAt ? new Date(t.lastRunAt).toISOString() : null,
        lastRunStatus: t.lastRunStatus,
        runCount: t.runCount,
      })),
    };
  }
}

/**
 * 3. 获取单项定时任务详情
 */
export class GetScheduledTaskTool implements Tool {
  readonly name = "get_scheduled_task";
  readonly description = "获取特定定时任务的完整配置、目标约束及执行统计。";
  readonly parameters = {
    type: "object",
    properties: {
      scheduledTaskId: {
        type: "string",
        description: "定时任务 ID (如 sched-xxx)",
      },
    },
    required: ["scheduledTaskId"],
  };

  constructor(private readonly options: ScheduledToolsOptions) {}

  async execute(args: any): Promise<any> {
    const task = await this.options.store.getScheduledTask?.(args.scheduledTaskId);
    if (!task) {
      throw new Error(`Scheduled task '${args.scheduledTaskId}' not found`);
    }
    return task;
  }
}

/**
 * 4. 修改定时计划
 */
export class UpdateScheduledTaskTool implements Tool {
  readonly name = "update_scheduled_task";
  readonly description = "更新已有定时任务的时间周期、目标说明或配置参数。当用户说'将刚才那个任务改成每天10点'时调用。";
  readonly parameters = {
    type: "object",
    properties: {
      scheduledTaskId: {
        type: "string",
        description: "定时任务 ID",
      },
      name: { type: "string", description: "新名称" },
      cronExpression: { type: "string", description: "新 Cron 表达式" },
      intervalMs: { type: "number", description: "新时间间隔 (毫秒)" },
      goal: { type: "string", description: "新目标指令" },
      prompt: { type: "string", description: "新提示词" },
      nodeId: { type: "string", description: "新目标节点 ID" },
    },
    required: ["scheduledTaskId"],
  };

  constructor(private readonly options: ScheduledToolsOptions) {}

  async execute(args: any): Promise<any> {
    const existing = await this.options.store.getScheduledTask?.(args.scheduledTaskId);
    if (!existing) {
      throw new Error(`Scheduled task '${args.scheduledTaskId}' not found`);
    }

    const patch: Partial<ScheduledTaskRecord> = {};
    if (args.name) patch.name = args.name;
    if (args.cronExpression) {
      if (!isValidCronExpression(args.cronExpression)) {
        throw new Error(`Invalid cronExpression: ${args.cronExpression}`);
      }
      patch.cronExpression = args.cronExpression;
      patch.triggerType = "cron";
    }
    if (args.intervalMs) {
      patch.intervalMs = args.intervalMs;
      patch.triggerType = "interval";
    }
    if (args.goal || args.prompt || args.nodeId) {
      patch.taskConfig = {
        ...existing.taskConfig,
        goal: args.goal || existing.taskConfig?.goal || "",
        prompt: args.prompt !== undefined ? args.prompt : existing.taskConfig?.prompt,
        nodeId: args.nodeId !== undefined ? args.nodeId : existing.taskConfig?.nodeId,
      };
    }

    // 重新推算下一次触发时间
    const merged = { ...existing, ...patch };
    const nextRun = EngineHelper.calculateNextRunTime(merged);
    patch.nextRunAt = nextRun;

    const updated = await this.options.store.updateScheduledTask?.(args.scheduledTaskId, patch);
    await this.options.engine.reschedule();

    return {
      success: true,
      updatedTask: updated,
      message: `已成功更新定时任务 '${updated?.name}'。下次触发时间: ${nextRun ? new Date(nextRun).toLocaleString() : "待定"}`,
    };
  }
}

/**
 * 5. 暂停定时任务
 */
export class PauseScheduledTaskTool implements Tool {
  readonly name = "pause_scheduled_task";
  readonly description = "暂停一个正在启用的定时任务，暂停后到期将不会自动执行，但配置和历史仍予保留。";
  readonly parameters = {
    type: "object",
    properties: {
      scheduledTaskId: { type: "string", description: "定时任务 ID" },
    },
    required: ["scheduledTaskId"],
  };

  constructor(private readonly options: ScheduledToolsOptions) {}

  async execute(args: any): Promise<any> {
    const updated = await this.options.store.updateScheduledTask?.(args.scheduledTaskId, {
      enabled: false,
    });
    if (!updated) {
      throw new Error(`Scheduled task '${args.scheduledTaskId}' not found`);
    }
    await this.options.engine.reschedule();
    return {
      success: true,
      scheduledTaskId: args.scheduledTaskId,
      name: updated.name,
      status: "paused",
      message: `已暂停定时任务 '${updated.name}'。`,
    };
  }
}

/**
 * 6. 恢复定时任务
 */
export class ResumeScheduledTaskTool implements Tool {
  readonly name = "resume_scheduled_task";
  readonly description = "重新启用已被暂停的定时任务，并自动对齐并计算下一个周期的触发时间。";
  readonly parameters = {
    type: "object",
    properties: {
      scheduledTaskId: { type: "string", description: "定时任务 ID" },
    },
    required: ["scheduledTaskId"],
  };

  constructor(private readonly options: ScheduledToolsOptions) {}

  async execute(args: any): Promise<any> {
    const existing = await this.options.store.getScheduledTask?.(args.scheduledTaskId);
    if (!existing) {
      throw new Error(`Scheduled task '${args.scheduledTaskId}' not found`);
    }

    const nextRun = EngineHelper.calculateNextRunTime(existing);
    const updated = await this.options.store.updateScheduledTask?.(args.scheduledTaskId, {
      enabled: true,
      nextRunAt: nextRun,
    });
    await this.options.engine.reschedule();
    return {
      success: true,
      scheduledTaskId: args.scheduledTaskId,
      name: updated?.name,
      status: "active",
      nextRunAt: nextRun ? new Date(nextRun).toLocaleString() : null,
      message: `已成功恢复定时任务 '${updated?.name}'。下次触发时间: ${nextRun ? new Date(nextRun).toLocaleString() : "待定"}`,
    };
  }
}

/**
 * 7. 删除定时任务
 */
export class DeleteScheduledTaskTool implements Tool {
  readonly name = "delete_scheduled_task";
  readonly description = "永久删除指定的定时调度任务定义。";
  readonly parameters = {
    type: "object",
    properties: {
      scheduledTaskId: { type: "string", description: "定时任务 ID" },
    },
    required: ["scheduledTaskId"],
  };

  constructor(private readonly options: ScheduledToolsOptions) {}

  async execute(args: any): Promise<any> {
    const deleted = await this.options.store.deleteScheduledTask?.(args.scheduledTaskId);
    if (!deleted) {
      throw new Error(`Scheduled task '${args.scheduledTaskId}' not found or already deleted`);
    }
    await this.options.engine.reschedule();
    return {
      success: true,
      scheduledTaskId: args.scheduledTaskId,
      message: `已永久删除定时任务 '${args.scheduledTaskId}'。`,
    };
  }
}

/**
 * 8. 立即运行一次 (run_now)
 */
export class RunScheduledTaskNowTool implements Tool {
  readonly name = "run_scheduled_task_now";
  readonly description = "手动立即执行一次指定的定时任务。该操作触发一次额外执行，绝不会改变任务原有的下次自然周期触发时间。";
  readonly parameters = {
    type: "object",
    properties: {
      scheduledTaskId: { type: "string", description: "定时任务 ID" },
      force: {
        type: "boolean",
        description: "是否强制执行（即无视并发限制立即派发），默认 false",
      },
    },
    required: ["scheduledTaskId"],
  };

  constructor(private readonly options: ScheduledToolsOptions) {}

  async execute(args: any): Promise<any> {
    const run = await this.options.engine.runNow(args.scheduledTaskId, Boolean(args.force));
    return {
      success: true,
      scheduledTaskId: args.scheduledTaskId,
      runId: run.id,
      taskId: run.taskId,
      graphId: run.graphId,
      status: run.status,
      message: `已触发任务立即执行。执行 Run ID: ${run.id}${run.taskId ? `，关联 Task ID: ${run.taskId}` : ""}`,
    };
  }
}

/**
 * 9. 查询历史执行记录
 */
export class GetScheduledTaskHistoryTool implements Tool {
  readonly name = "get_scheduled_task_history";
  readonly description = "查看指定定时任务的历史触发执行记录、运行状态、耗时及输出摘要。";
  readonly parameters = {
    type: "object",
    properties: {
      scheduledTaskId: { type: "string", description: "定时任务 ID" },
      status: {
        type: "string",
        enum: ["running", "completed", "failed", "skipped"],
        description: "过滤执行状态",
      },
      limit: { type: "number", description: "返回条数限制，默认 20" },
    },
    required: ["scheduledTaskId"],
  };

  constructor(private readonly options: ScheduledToolsOptions) {}

  async execute(args: any): Promise<any> {
    const runs = (await this.options.store.listScheduledTaskRuns?.(args.scheduledTaskId, {
      status: args.status as ScheduledTaskRunStatus,
      limit: args.limit ?? 20,
    })) ?? [];

    return {
      scheduledTaskId: args.scheduledTaskId,
      totalRuns: runs.length,
      history: runs.map((r) => ({
        runId: r.id,
        taskId: r.taskId,
        graphId: r.graphId,
        triggerTime: new Date(r.triggerTime).toISOString(),
        startedAt: new Date(r.startedAt).toISOString(),
        completedAt: r.completedAt ? new Date(r.completedAt).toISOString() : null,
        durationMs: r.completedAt ? r.completedAt - r.startedAt : null,
        status: r.status,
        skipReason: r.skipReason,
        error: r.error,
        resultSummary: r.resultSummary,
      })),
    };
  }
}

/**
 * 工厂函数：创建全部 9 个定时调度工具
 */
export function createScheduledAgentTools(options: ScheduledToolsOptions): Tool[] {
  return [
    new CreateScheduledTaskTool(options),
    new ListScheduledTasksTool(options),
    new GetScheduledTaskTool(options),
    new UpdateScheduledTaskTool(options),
    new PauseScheduledTaskTool(options),
    new ResumeScheduledTaskTool(options),
    new DeleteScheduledTaskTool(options),
    new RunScheduledTaskNowTool(options),
    new GetScheduledTaskHistoryTool(options),
  ];
}
