import type { SpawnSubAgentOptions } from "../agent/subagent-runtime.js";

/**
 * Workflow Phase 阶段元数据
 */
export interface WorkflowPhaseMeta {
  title: string;
  detail?: string;
}

/**
 * Workflow 元信息声明
 */
export interface WorkflowMeta {
  name: string;
  description: string;
  phases?: WorkflowPhaseMeta[];
}

/**
 * Workflow Agent 调用选项
 */
export interface WorkflowAgentOptions extends SpawnSubAgentOptions {
  label?: string;
  phase?: string;
  schema?: Record<string, unknown>;
  isolation?: "shared" | "worktree";
}

/**
 * Workflow 执行上下文对象（暴露给脚本或编排执行函数）
 */
export interface WorkflowContext {
  /**
   * 派生并运行一个 Agent
   */
  agent: <T = string>(prompt: string, opts?: WorkflowAgentOptions) => Promise<T>;

  /**
   * 并发执行多个 thunk 任务，返回全部结果的数组 (Barrier 模式)
   */
  parallel: <T>(thunks: Array<() => Promise<T>>) => Promise<T[]>;

  /**
   * 流水线执行 (Pipeline 模式)：将 items 中的每个元素独立穿透各个 stage
   */
  pipeline: <TIn, TOut>(
    items: TIn[],
    ...stages: Array<(item: any, originalItem: TIn, index: number) => Promise<any>>
  ) => Promise<TOut[]>;

  /**
   * 标记当前处于的 Phase
   */
  phase: (title: string) => void;

  /**
   * 记录进展日志
   */
  log: (message: string) => void;

  /**
   * 嵌套运行另一个子 Workflow
   */
  workflow: <T = any>(
    name: string,
    runner: (ctx: WorkflowContext) => Promise<T>
  ) => Promise<T>;
}
