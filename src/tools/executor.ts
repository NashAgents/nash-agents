import type { ToolRegistry } from "./registry.js";
import type { ToolCall } from "../model/chat-completions-client.js";
import type { HookManager } from "../middleware/hook-manager.js";
import type { ToolHookContext } from "../middleware/hook-context.js";
import type { ToolExecutionContext } from "./tool.js";

/**
 * 判断值是否为普通对象（非 null、非数组的 Object 键值对）
 */
function isPlainObject(val: unknown): val is Record<string, unknown> {
  return typeof val === "object" && val !== null && !Array.isArray(val);
}

/**
 * 标准化工具执行结果
 */
export interface ToolResult {
  /**
   * 执行是否成功
   */
  success: boolean;

  /**
   * 工具最终输出内容（字符串，用于塞回 messages）
   */
  output: string;

  /**
   * 错误描述（若失败）
   */
  error?: string;

  /**
   * 工具执行耗时（毫秒）
   */
  executionTimeMs?: number;
  interrupted?: boolean;
  exitCode?: number | null;
}

/**
 * 工具执行结果消息（兼容 OpenAI Tool Message 结构）
 */
export interface ToolExecutionResponse {
  role: "tool";
  tool_call_id: string;
  content: string;
  result: ToolResult;
}

/**
 * 工具执行器（ToolExecutor）
 *
 * 确定性的工具执行层：负责寻址、入参解析、类型校验、Hook 拦截、业务执行及异常捕获。
 *
 * 核心执行流程：
 * 1. 工具寻址 (Tool lookup)
 * 2. 入参反序列化与类型校验 (Argument parsing & validation)
 * 3. 触发 beforeToolExecute Hook（提供已解析的 parsedArgs 供 SecurityPolicy / 权限策略审查）
 * 4. 调用具体工具业务执行逻辑 (Tool.execute)
 * 5. 触发 afterToolExecute Hook
 * 6. 各阶段异常安全捕获并分发至 onToolError
 */
export class ToolExecutor {
  constructor(
    private readonly registry: ToolRegistry,
    private readonly hookManager?: HookManager
  ) {}

  /**
   * 执行指定的工具，返回确定性的标准化 ToolResult
   *
   * @param name - 工具名称
   * @param rawArguments - 模型生成的原始参数（JSON 字符串或对象）
   */
  async execute(name: string, rawArguments: unknown, executionContext?: ToolExecutionContext): Promise<ToolResult> {
    const startTime = performance.now();
    const tool = this.registry.get(name);

    const context: ToolHookContext = {
      toolName: name,
      rawArgs: rawArguments,
      tool,
      metadata: {},
    };

    // 1. 工具寻址校验
    if (!tool) {
      const available =
        this.registry
          .getAll()
          .map((t) => t.name)
          .join(", ") || "无";
      const error = new Error(`ToolNotFound: ${name}`);
      context.error = error;

      if (this.hookManager) {
        await this.hookManager.execute("onToolError", context);
      }

      const result: ToolResult = {
        success: false,
        output: `Error: 工具 '${name}' 不受支持。当前可用工具: ${available}。`,
        error: `ToolNotFound: ${name}`,
        executionTimeMs: performance.now() - startTime,
      };
      context.result = result;
      return result;
    }

    // 2. 参数反序列化
    let parsed: unknown;
    if (typeof rawArguments === "string") {
      const trimmed = rawArguments.trim();
      if (trimmed === "") {
        parsed = {};
      } else {
        try {
          parsed = JSON.parse(trimmed);
        } catch (err: unknown) {
          const parseError =
            err instanceof Error ? err : new Error(String(err));
          context.error = parseError;

          if (this.hookManager) {
            await this.hookManager.execute("onToolError", context);
          }

          const result: ToolResult = {
            success: false,
            output: `Error: 解析工具 '${name}' 的参数失败: ${parseError.message}`,
            error: `JSONParseError: ${parseError.message}`,
            executionTimeMs: performance.now() - startTime,
          };
          context.result = result;
          return result;
        }
      }
    } else {
      parsed = rawArguments ?? {};
    }

    // 3. 入参校验（必须为键值对对象）
    if (!isPlainObject(parsed)) {
      const actualType = Array.isArray(parsed) ? "array" : typeof parsed;
      const typeError = new Error(
        `InvalidArgumentsType: expected object, got ${actualType}`
      );
      context.error = typeError;

      if (this.hookManager) {
        await this.hookManager.execute("onToolError", context);
      }

      const result: ToolResult = {
        success: false,
        output: `Error: 工具 '${name}' 的参数必须是一个键值对对象 (JSON Object)，实际收到: ${actualType}。`,
        error: `InvalidArgumentsType: expected object, got ${actualType}`,
        executionTimeMs: performance.now() - startTime,
      };
      context.result = result;
      return result;
    }

    // 绑定已解析且校验通过的结构化参数
    context.parsedArgs = parsed;

    // 4. 触发 beforeToolExecute 生命周期钩子（携带结构化 parsedArgs，若抛出异常直接向上冒泡中断执行）
    if (this.hookManager) {
      await this.hookManager.execute("beforeToolExecute", context);
    }

    // 5. 调用具体工具业务执行逻辑
    let result: ToolResult;
    try {
      executionContext?.signal?.throwIfAborted();
      const rawOutput = await tool.execute(parsed, executionContext);
      if (!(isPlainObject(rawOutput) && rawOutput.interrupted === true)) executionContext?.signal?.throwIfAborted();

      let formattedOutput: string;
      if (typeof rawOutput === "string") {
        formattedOutput = rawOutput;
      } else if (rawOutput === undefined || rawOutput === null) {
        formattedOutput = "(无输出)";
      } else if (typeof rawOutput === "object") {
        formattedOutput = JSON.stringify(rawOutput, null, 2);
      } else {
        formattedOutput = String(rawOutput);
      }

      result = isPlainObject(rawOutput) && typeof rawOutput.success === "boolean"
        ? { ...rawOutput, success: rawOutput.success, output: typeof rawOutput.output === "string" ? rawOutput.output : formattedOutput, executionTimeMs: performance.now() - startTime }
        : { success: true, output: formattedOutput, executionTimeMs: performance.now() - startTime };
      context.result = result;
    } catch (err: unknown) {
      const executionError =
        err instanceof Error ? err : new Error(String(err));
      context.error = executionError;

      if (this.hookManager) {
        await this.hookManager.execute("onToolError", context);
      }

      const isPermissionDenied =
        executionError.name === "ApprovalDeniedError" ||
        executionError.name === "FilesystemAccessDeniedError" ||
        (executionError as any).code === "PERMISSION_DENIED";

      const errorCode = isPermissionDenied ? "PERMISSION_DENIED" : `ExecutionError: ${executionError.message}`;
      const outputMsg = isPermissionDenied
        ? `PERMISSION_DENIED: ${executionError.message} 请根据当前允许的权限边界调整方案 (Replan) 或使用已有上下文。`
        : `Error: 执行工具 '${name}' 时发生异常: ${executionError.message}`;

      result = {
        success: false,
        output: outputMsg,
        error: errorCode,
        executionTimeMs: performance.now() - startTime,
        interrupted: executionContext?.signal?.aborted || undefined,
      };
      context.result = result;
      return result;
    }

    // 6. 触发 afterToolExecute 钩子（若异常直接向外抛出）
    if (this.hookManager) {
      await this.hookManager.execute("afterToolExecute", context);
    }

    return result;
  }

  /**
   * 处理大模型的 ToolCall 并返回标准的 Tool Message 响应
   *
   * @param toolCall - 模型返回的工具调用对象
   */
  async executeToolCall(toolCall: ToolCall, executionContext?: ToolExecutionContext): Promise<ToolExecutionResponse> {
    const result = await this.execute(
      toolCall.function.name,
      toolCall.function.arguments,
      executionContext
    );

    return {
      role: "tool",
      tool_call_id: toolCall.id,
      content: result.output,
      result,
    };
  }
}
