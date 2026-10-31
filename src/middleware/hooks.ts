import type {
  AgentHookContext,
  ModelHookContext,
  ToolHookContext,
} from "./hook-context.js";

/**
 * Hook 执行函数签名：支持同步与异步 Promise 返回
 */
export type HookFn<TContext> = (context: TContext) => void | Promise<void>;

// --- 1. Agent 顶层生命周期 Hook ---
export type BeforeAgentRunHook = HookFn<AgentHookContext>;
export type AfterAgentRunHook = HookFn<AgentHookContext>;
export type OnAgentErrorHook = HookFn<AgentHookContext>;

// --- 2. Model 模型调用层生命周期 Hook ---
export type BeforeModelCallHook = HookFn<ModelHookContext>;
export type AfterModelCallHook = HookFn<ModelHookContext>;
export type OnModelErrorHook = HookFn<ModelHookContext>;

// --- 3. Tool 工具执行层生命周期 Hook ---
export type BeforeToolExecuteHook = HookFn<ToolHookContext>;
export type AfterToolExecuteHook = HookFn<ToolHookContext>;
export type OnToolErrorHook = HookFn<ToolHookContext>;

/**
 * 9 大生命周期钩子名称映射表
 */
export interface HookMap {
  beforeAgentRun: BeforeAgentRunHook;
  afterAgentRun: AfterAgentRunHook;
  onAgentError: OnAgentErrorHook;
  beforeModelCall: BeforeModelCallHook;
  afterModelCall: AfterModelCallHook;
  onModelError: OnModelErrorHook;
  beforeToolExecute: BeforeToolExecuteHook;
  afterToolExecute: AfterToolExecuteHook;
  onToolError: OnToolErrorHook;
}

/**
 * 支持的 Hook 类型枚举/字面量联合类型
 */
export type HookName = keyof HookMap;
