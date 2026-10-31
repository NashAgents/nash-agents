import * as crypto from "node:crypto";
import type {
  WorkflowMeta,
  WorkflowAgentOptions,
  WorkflowContext,
} from "./types.js";
import { WorkflowCancelledError, WorkflowExecutionError } from "./errors.js";
import type { SubAgentRuntime } from "../agent/subagent-runtime.js";
import type { ConcurrencyController } from "../concurrency/concurrency-controller.js";
import type { EventBus } from "../observability/event-bus.js";

export interface WorkflowRuntimeOptions {
  subAgentRuntime: SubAgentRuntime;
  concurrencyController: ConcurrencyController;
  eventBus?: EventBus;
  projectId?: string;
  sessionId?: string;
}

/**
 * WorkflowRuntime - 确定性多 Agent 流水线与分支编排引擎
 *
 * 铁律：
 * 1. 结构化控制流：parallel / pipeline / agent / phase；
 * 2. 绝不走 Task Scheduler，由工作流逻辑直接驱动；
 * 3. 严格受并发与深度控制 (ConcurrencyController) 约束。
 */
export class WorkflowRuntime {
  private readonly subAgentRuntime: SubAgentRuntime;
  private readonly concurrencyController: ConcurrencyController;
  private readonly eventBus?: EventBus;
  private readonly projectId: string;
  private readonly sessionId: string;

  constructor(options: WorkflowRuntimeOptions) {
    this.subAgentRuntime = options.subAgentRuntime;
    this.concurrencyController = options.concurrencyController;
    this.eventBus = options.eventBus;
    this.projectId = options.projectId ?? "default-project";
    this.sessionId = options.sessionId ?? "default-session";
  }

  /**
   * 执行一个 Workflow
   *
   * @param name - 工作流名称
   * @param orchestrator - 编排执行函数
   * @param options - 选项（取消信号、元数据）
   */
  async execute<T>(
    name: string,
    orchestrator: (ctx: WorkflowContext) => Promise<T>,
    options?: {
      signal?: AbortSignal;
      meta?: WorkflowMeta;
    }
  ): Promise<T> {
    const workflowId = `wf-${crypto.randomUUID().slice(0, 8)}`;
    let currentPhase: string | undefined;

    this.emitEvent("workflow.started", {
      workflowId,
      name,
      meta: options?.meta,
    });

    const checkAborted = () => {
      if (options?.signal?.aborted) {
        throw new WorkflowCancelledError(
          typeof options.signal.reason === "string"
            ? options.signal.reason
            : "User aborted"
        );
      }
    };

    checkAborted();

    const ctx: WorkflowContext = {
      phase: (title: string) => {
        checkAborted();
        currentPhase = title;
      },

      log: (message: string) => {
        checkAborted();
      },

      agent: async <TRes = string>(
        prompt: string,
        opts?: WorkflowAgentOptions
      ): Promise<TRes> => {
        checkAborted();

        const result = await this.subAgentRuntime.spawn(prompt, {
          ...opts,
          name: opts?.label ?? opts?.name,
        });

        checkAborted();

        if (!result.success) {
          throw new WorkflowExecutionError(
            `Agent '${result.agentId}' 执行失败: ${result.error?.message}`,
            result.error
          );
        }

        if (opts?.schema) {
          try {
            return JSON.parse(result.output) as TRes;
          } catch {
            return result.output as unknown as TRes;
          }
        }

        return result.output as unknown as TRes;
      },

      parallel: async <TItem>(
        thunks: Array<() => Promise<TItem>>
      ): Promise<TItem[]> => {
        checkAborted();
        return await Promise.all(
          thunks.map(async (thunk) => {
            checkAborted();
            return await thunk();
          })
        );
      },

      pipeline: async <TIn, TOut>(
        items: TIn[],
        ...stages: Array<
          (item: any, originalItem: TIn, index: number) => Promise<any>
        >
      ): Promise<TOut[]> => {
        checkAborted();

        // pipeline 模式：每个 item 独立流经所有 stage，彼此无屏障等待
        const itemPromises = items.map(async (originalItem, index) => {
          let current: any = originalItem;
          for (const stage of stages) {
            checkAborted();
            current = await stage(current, originalItem, index);
          }
          return current as TOut;
        });

        return await Promise.all(itemPromises);
      },

      workflow: async <TSub = any>(
        childName: string,
        childRunner: (childCtx: WorkflowContext) => Promise<TSub>
      ): Promise<TSub> => {
        checkAborted();
        return await this.execute(childName, childRunner, {
          signal: options?.signal,
        });
      },
    };

    try {
      const result = await orchestrator(ctx);
      this.emitEvent("workflow.completed", {
        workflowId,
        name,
      });
      return result;
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.emitEvent("workflow.failed", {
        workflowId,
        name,
        error: error.message,
      });
      throw error;
    }
  }

  private emitEvent(type: string, data: Record<string, unknown>): void {
    if (this.eventBus) {
      this.eventBus.emit({
        id: crypto.randomUUID(),
        type: type as any,
        timestamp: new Date().toISOString(),
        projectId: this.projectId,
        sessionId: this.sessionId,
        data,
      });
    }
  }
}
