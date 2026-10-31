import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  HookManager,
  type AgentHookContext,
  type ModelHookContext,
  type ToolHookContext,
} from "../src/middleware/index.js";
import {
  ToolRegistry,
  ToolExecutor,
  defineTool,
  type Tool,
} from "../src/tools/index.js";
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
} from "../src/model/chat-completions-client.js";

describe("Enterprise 3-Tier Lifecycle Hook System", () => {
  // 1. 测试全部 9 种 Hook 的注册与链式调用 API
  it("1. 应该支持所有 9 种生命周期 Hook 的注册、获取与链式调用", () => {
    const manager = new HookManager();

    const noop = () => {};
    manager
      .beforeAgentRun(noop)
      .afterAgentRun(noop)
      .onAgentError(noop)
      .beforeModelCall(noop)
      .afterModelCall(noop)
      .onModelError(noop)
      .beforeToolExecute(noop)
      .afterToolExecute(noop)
      .onToolError(noop);

    assert.equal(manager.getHooks("beforeAgentRun").length, 1);
    assert.equal(manager.getHooks("afterAgentRun").length, 1);
    assert.equal(manager.getHooks("onAgentError").length, 1);
    assert.equal(manager.getHooks("beforeModelCall").length, 1);
    assert.equal(manager.getHooks("afterModelCall").length, 1);
    assert.equal(manager.getHooks("onModelError").length, 1);
    assert.equal(manager.getHooks("beforeToolExecute").length, 1);
    assert.equal(manager.getHooks("afterToolExecute").length, 1);
    assert.equal(manager.getHooks("onToolError").length, 1);
  });

  // 2. 测试严格 FIFO 先进先出顺序执行
  it("2. 应该严格按照 FIFO 注册顺序同步/异步执行 Hook 队列", async () => {
    const manager = new HookManager();
    const executionOrder: number[] = [];

    manager.beforeAgentRun(() => {
      executionOrder.push(1);
    });
    manager.beforeAgentRun(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      executionOrder.push(2);
    });
    manager.beforeAgentRun(() => {
      executionOrder.push(3);
    });

    const context: AgentHookContext = {
      userInput: "test",
      messages: [],
      metadata: {},
    };

    await manager.execute("beforeAgentRun", context);

    assert.deepEqual(executionOrder, [1, 2, 3]);
  });

  // 3. 测试异步 Promise 钩子执行等待
  it("3. 应该正确等待异步 Hook 执行完成之后再继续后续逻辑", async () => {
    const manager = new HookManager();
    let state = "initial";

    manager.beforeToolExecute(async (ctx) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      state = "async_updated";
      ctx.metadata.updatedByHook = true;
    });

    const context: ToolHookContext = {
      toolName: "test_tool",
      rawArgs: {},
      metadata: {},
    };

    await manager.execute("beforeToolExecute", context);

    assert.equal(state, "async_updated");
    assert.equal(context.metadata.updatedByHook, true);
  });

  // 4. 测试 beforeAgentRun 异常阻断
  it("4. beforeAgentRun 抛出异常时应向上冒泡并阻断后续执行", async () => {
    const manager = new HookManager();
    const records: string[] = [];

    manager.beforeAgentRun(() => {
      records.push("hook1");
      throw new Error("Agent 启动拦截异常");
    });
    manager.beforeAgentRun(() => {
      records.push("hook2");
    });

    const context: AgentHookContext = {
      userInput: "hi",
      messages: [],
      metadata: {},
    };

    await assert.rejects(
      async () => {
        await manager.execute("beforeAgentRun", context);
      },
      {
        name: "Error",
        message: "Agent 启动拦截异常",
      }
    );

    assert.deepEqual(records, ["hook1"]);
  });

  // 5. 测试 beforeToolExecute 基于结构化 parsedArgs 审查与阻断
  it("5. beforeToolExecute 应该能获取已解析的 parsedArgs，并在安全审查不通过时阻断工具执行", async () => {
    const manager = new HookManager();
    const registry = new ToolRegistry();

    let toolExecuted = false;
    const testTool: Tool<{ command: string }> = defineTool({
      name: "bash",
      execute({ command }) {
        toolExecuted = true;
        return `executed: ${command}`;
      },
    });
    registry.register(testTool);

    let capturedParsedArgs: Record<string, unknown> | undefined;

    // SecurityPolicy 示例：检查结构化参数中的危险命令
    manager.beforeToolExecute((ctx) => {
      capturedParsedArgs = ctx.parsedArgs;
      if (
        ctx.toolName === "bash" &&
        typeof ctx.parsedArgs?.command === "string" &&
        ctx.parsedArgs.command.includes("rm -rf")
      ) {
        throw new Error("SecurityPolicyViolation: 禁止执行高危危险命令");
      }
    });

    const executor = new ToolExecutor(registry, manager);

    // 传入高危参数，验证被 beforeToolExecute 成功拦截阻断
    await assert.rejects(
      async () => {
        await executor.execute("bash", JSON.stringify({ command: "rm -rf /" }));
      },
      {
        name: "Error",
        message: "SecurityPolicyViolation: 禁止执行高危危险命令",
      }
    );

    assert.equal(toolExecuted, false);
    assert.deepEqual(capturedParsedArgs, { command: "rm -rf /" });
  });

  // 6. 测试 afterToolExecute 获取完整 ToolResult 与 metadata
  it("6. afterToolExecute 应该能获取到完整的 ToolResult 与透传 metadata", async () => {
    const manager = new HookManager();
    const registry = new ToolRegistry();

    const echoTool: Tool<{ message: string }> = defineTool({
      name: "echo",
      execute({ message }) {
        return `echo: ${message}`;
      },
    });
    registry.register(echoTool);

    let capturedResult: unknown;
    let capturedMeta: unknown;
    let capturedArgsInAfter: unknown;

    manager.beforeToolExecute((ctx) => {
      ctx.metadata.traceId = "trace-1001";
    });

    manager.afterToolExecute((ctx) => {
      capturedResult = ctx.result;
      capturedMeta = ctx.metadata;
      capturedArgsInAfter = ctx.parsedArgs;
    });

    const executor = new ToolExecutor(registry, manager);
    const res = await executor.execute("echo", { message: "hello" });

    assert.equal(res.success, true);
    assert.equal(res.output, "echo: hello");
    assert.ok(capturedResult);
    assert.deepEqual(capturedMeta, { traceId: "trace-1001" });
    assert.deepEqual(capturedArgsInAfter, { message: "hello" });
  });

  // 7. 测试工具执行抛出异常时触发 onToolError
  it("7. 工具执行抛出异常时应触发 onToolError 钩子", async () => {
    const manager = new HookManager();
    const registry = new ToolRegistry();

    const failTool: Tool = defineTool({
      name: "fail_tool",
      execute() {
        throw new Error("底层数据库连接断开");
      },
    });
    registry.register(failTool);

    let errorCaptured: Error | undefined;
    manager.onToolError((ctx) => {
      errorCaptured = ctx.error;
    });

    const executor = new ToolExecutor(registry, manager);
    const result = await executor.execute("fail_tool", {});

    assert.equal(result.success, false);
    assert.ok(result.error?.includes("底层数据库连接断开"));
    assert.ok(errorCaptured);
    assert.equal(errorCaptured?.message, "底层数据库连接断开");
  });

  // 8. 测试工具入参反序列化与格式错误触发 onToolError
  it("8. 工具参数非法（非 Object 或 JSON 语法错误）时应触发 onToolError 钩子且不触发 beforeToolExecute", async () => {
    const manager = new HookManager();
    const registry = new ToolRegistry();

    const sampleTool: Tool = defineTool({
      name: "sample",
      execute(args) {
        return args;
      },
    });
    registry.register(sampleTool);

    const errors: string[] = [];
    let beforeToolExecuteCalled = false;

    manager.beforeToolExecute(() => {
      beforeToolExecuteCalled = true;
    });

    manager.onToolError((ctx) => {
      if (ctx.error) {
        errors.push(ctx.error.message);
      }
    });

    const executor = new ToolExecutor(registry, manager);

    // 8.1 传入无效 JSON
    const jsonRes = await executor.execute("sample", "{ broken json");
    assert.equal(jsonRes.success, false);

    // 8.2 传入非 Object 类型
    const arrayRes = await executor.execute("sample", "[1, 2, 3]");
    assert.equal(arrayRes.success, false);

    assert.equal(errors.length, 2);
    assert.ok(errors[0].includes("JSON"));
    assert.ok(errors[1].includes("InvalidArgumentsType"));
    assert.equal(beforeToolExecuteCalled, false);
  });

  // 9. 测试调用未注册工具时触发 onToolError
  it("9. 调用未注册工具时应触发 onToolError 钩子并返回标准化错误结果", async () => {
    const manager = new HookManager();
    const registry = new ToolRegistry();

    let capturedError: Error | undefined;
    let beforeToolExecuteCalled = false;

    manager.beforeToolExecute(() => {
      beforeToolExecuteCalled = true;
    });

    manager.onToolError((ctx) => {
      capturedError = ctx.error;
    });

    const executor = new ToolExecutor(registry, manager);
    const res = await executor.execute("non_existent_tool", {});

    assert.equal(res.success, false);
    assert.equal(res.error, "ToolNotFound: non_existent_tool");
    assert.equal(capturedError?.message, "ToolNotFound: non_existent_tool");
    assert.equal(beforeToolExecuteCalled, false);
  });

  // 10. 测试错误 Hook 防递归保护机制
  it("10. 错误 Hook 应该具备防递归保护机制，防止嵌套循环调用", async () => {
    const manager = new HookManager();
    let invokeCount = 0;

    manager.onAgentError(async (ctx) => {
      invokeCount++;
      // 模拟在错误回调中再次触发同类错误 Hook
      await manager.execute("onAgentError", ctx);
    });

    const context: AgentHookContext = {
      userInput: "test",
      messages: [],
      error: new Error("Test Error"),
      metadata: {},
    };

    await manager.execute("onAgentError", context);

    // 防递归保护应保证仅执行一次，避免死锁
    assert.equal(invokeCount, 1);
  });

  // 11. 测试 metadata 跨生命周期透传
  it("11. metadata 应能在生命周期各阶段之间安全传递与共享", async () => {
    const manager = new HookManager();

    manager.beforeModelCall((ctx) => {
      ctx.metadata.startTime = 123456789;
      ctx.metadata.requestId = "req-abc";
    });

    manager.afterModelCall((ctx) => {
      ctx.metadata.endTime = 123456799;
    });

    const request: ChatCompletionRequest = {
      model: "gpt-4o",
      messages: [{ role: "user", content: "hello" }],
    };

    const context: ModelHookContext = {
      request,
      metadata: {},
    };

    await manager.execute("beforeModelCall", context);
    await manager.execute("afterModelCall", context);

    assert.equal(context.metadata.startTime, 123456789);
    assert.equal(context.metadata.requestId, "req-abc");
    assert.equal(context.metadata.endTime, 123456799);
  });

  // 12. 测试 Model 级生命周期 Hook 触发 (beforeModelCall, afterModelCall, onModelError)
  it("12. Model 层 Hook 应该能完整捕获请求、响应与异常", async () => {
    const manager = new HookManager();

    let capturedReq: ChatCompletionRequest | undefined;
    let capturedResp: ChatCompletionResponse | undefined;
    let capturedErr: Error | undefined;

    manager.beforeModelCall((ctx) => {
      capturedReq = ctx.request;
    });
    manager.afterModelCall((ctx) => {
      capturedResp = ctx.response;
    });
    manager.onModelError((ctx) => {
      capturedErr = ctx.error;
    });

    const req: ChatCompletionRequest = {
      model: "mock-model",
      messages: [{ role: "user", content: "hi" }],
    };

    const successContext: ModelHookContext = {
      request: req,
      metadata: {},
    };

    await manager.execute("beforeModelCall", successContext);
    successContext.response = {
      id: "resp-1",
      choices: [
        {
          index: 0,
          finish_reason: "stop",
          message: { role: "assistant", content: "hello!" },
        },
      ],
    };
    await manager.execute("afterModelCall", successContext);

    assert.deepEqual(capturedReq, req);
    assert.equal(capturedResp?.id, "resp-1");

    // 测试异常场景
    const failContext: ModelHookContext = {
      request: req,
      error: new Error("Model rate limit exceeded"),
      metadata: {},
    };
    await manager.execute("onModelError", failContext);
    assert.equal(capturedErr?.message, "Model rate limit exceeded");
  });

  // 13. 测试 afterToolExecute 抛出异常时向外冒泡
  it("13. afterToolExecute 钩子中抛出异常应向外冒泡", async () => {
    const manager = new HookManager();
    const registry = new ToolRegistry();

    const pingTool: Tool = defineTool({
      name: "ping",
      execute() {
        return "pong";
      },
    });
    registry.register(pingTool);

    manager.afterToolExecute(() => {
      throw new Error("afterToolExecute 校验失败");
    });

    const executor = new ToolExecutor(registry, manager);

    await assert.rejects(
      async () => {
        await executor.execute("ping", {});
      },
      {
        name: "Error",
        message: "afterToolExecute 校验失败",
      }
    );
  });

  // 14. 测试 Hook 清空 (clear) 功能
  it("14. HookManager 应支持按名称或全量清空已注册的 Hook", () => {
    const manager = new HookManager();
    manager.beforeAgentRun(() => {});
    manager.afterAgentRun(() => {});
    manager.beforeToolExecute(() => {});

    assert.equal(manager.getHooks("beforeAgentRun").length, 1);
    assert.equal(manager.getHooks("afterAgentRun").length, 1);
    assert.equal(manager.getHooks("beforeToolExecute").length, 1);

    // 单独清空 beforeAgentRun
    manager.clear("beforeAgentRun");
    assert.equal(manager.getHooks("beforeAgentRun").length, 0);
    assert.equal(manager.getHooks("afterAgentRun").length, 1);

    // 全量清空
    manager.clear();
    assert.equal(manager.getHooks("afterAgentRun").length, 0);
    assert.equal(manager.getHooks("beforeToolExecute").length, 0);
  });

  // 15. 测试通用 register 与 execute 调度
  it("15. HookManager 支持使用通用 register 和 execute 统一调度", async () => {
    const manager = new HookManager();
    const logs: string[] = [];

    manager.register("beforeModelCall", (ctx) => {
      logs.push(`model:${ctx.request.model}`);
    });

    const context: ModelHookContext = {
      request: {
        model: "deepseek-chat",
        messages: [{ role: "user", content: "ping" }],
      },
      metadata: {},
    };

    await manager.execute("beforeModelCall", context);

    assert.deepEqual(logs, ["model:deepseek-chat"]);
  });
});
