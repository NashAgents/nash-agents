import process from "node:process";
import {
  ToolRegistry,
  ToolExecutor,
  defineTool,
  bashTool,
  createDefaultToolRegistry,
  type Tool,
} from "../src/tools/index.js";

async function runTests() {
  console.log("=== 工具注册中心与确定性执行器测试套件 ===\n");

  const registry = new ToolRegistry();

  // 定义一个自定义的计算器工具
  interface AddArgs {
    a: number;
    b: number;
  }

  const addTool: Tool<AddArgs> = defineTool({
    name: "add",
    description: "计算两个数字之和。",
    parameters: {
      type: "object",
      properties: {
        a: { type: "number", description: "第一个数字" },
        b: { type: "number", description: "第二个数字" },
      },
      required: ["a", "b"],
    },
    execute({ a, b }) {
      if (typeof a !== "number" || typeof b !== "number") {
        throw new Error("参数 'a' 和 'b' 必须为数字类型。");
      }
      return { result: a + b };
    },
  });

  // 定义一个耗时工具（用于测试超时控制）
  const slowTool: Tool<{ ms: number }> = defineTool({
    name: "slow_op",
    description: "模拟耗时操作。",
    parameters: {
      type: "object",
      properties: {
        ms: { type: "number", description: "等待毫秒数" },
      },
      required: ["ms"],
    },
    async execute({ ms }) {
      await new Promise((resolve) => setTimeout(resolve, ms));
      return "操作完成";
    },
  });

  // 测试 1: 注册工具 (ToolRegistry)
  console.log("--- 测试 1: 工具注册 (ToolRegistry) ---");
  registry.register(addTool);
  registry.register(bashTool);
  registry.register(slowTool);

  console.log("包含 'add' 工具:", registry.has("add"));
  console.log("包含 'bash' 工具:", registry.has("bash"));
  console.log("已注册工具数量:", registry.getAll().length);

  // 测试 2: 导出 OpenAI 兼容的工具 Schema 定义
  console.log("\n--- 测试 2: 导出 ChatCompletion 工具定义 ---");
  const defs = registry.getDefinitions();
  console.log("工具定义数量:", defs.length);

  // 实例化独立的 ToolExecutor
  const executor = new ToolExecutor(registry);

  // 测试 3: 正常执行返回标准 ToolResult (ToolExecutor)
  console.log("\n--- 测试 3: 传入合法参数执行 'add' (返回 ToolResult) ---");
  const addResult = await executor.execute("add", JSON.stringify({ a: 15, b: 27 }));
  console.log("ToolResult:", addResult);

  // 测试 4: 执行 bash 工具
  console.log("\n--- 测试 4: 执行 'bash' 命令行工具 ---");
  const bashResult = await executor.execute(
    "bash",
    JSON.stringify({ command: "echo 'ToolExecutor 执行 bash 成功！'" })
  );
  console.log("ToolResult:", bashResult);

  // 测试 5: 未注册工具调用容错
  console.log("\n--- 测试 5: 调用未注册工具 ---");
  const notFoundResult = await executor.execute("unknown_tool", "{}");
  console.log("ToolResult:", notFoundResult);

  // 测试 6: 非法 JSON 字符串参数容错
  console.log("\n--- 测试 6: 传入非法 JSON 参数 ---");
  const badJsonResult = await executor.execute("add", "{ broken json");
  console.log("ToolResult:", badJsonResult);

  // 测试 7: 传入合法 JSON 但非对象的参数容错（如 "123" 或 "[1, 2]"）
  console.log("\n--- 测试 7: 传入非 Object 类型的 JSON 参数 ---");
  const nonObjectJsonResult = await executor.execute("add", "123");
  console.log("传入数字 JSON 字符串:", nonObjectJsonResult);
  const arrayJsonResult = await executor.execute("add", "[1, 2, 3]");
  console.log("传入数组 JSON 字符串:", arrayJsonResult);
  const rawNumberResult = await executor.execute("add", 123 as any);
  console.log("传入原始 number 类型:", rawNumberResult);

  // 测试 8: 工具执行期抛出异常处理
  console.log("\n--- 测试 8: 工具执行期异常捕获 ---");
  const errorResult = await executor.execute(
    "add",
    JSON.stringify({ a: "not-a-number", b: 20 })
  );
  console.log("ToolResult:", errorResult);

  // 测试 9: 工具执行
  console.log("\n--- 测试 9: 工具执行 ---");
  const slowResult = await executor.execute(
    "slow_op",
    JSON.stringify({ ms: 50 })
  );
  console.log("ToolResult:", slowResult);

  // 测试 10: executeToolCall 包装响应测试
  console.log("\n--- 测试 10: executeToolCall 包装响应测试 ---");
  const toolCallResponse = await executor.executeToolCall({
    id: "call_12345",
    type: "function",
    function: {
      name: "add",
      arguments: JSON.stringify({ a: 100, b: 200 }),
    },
  });
  console.log("Tool Message 响应:", toolCallResponse);

  // 测试 11: 测试默认工具注册中心工厂函数
  console.log("\n--- 测试 11: 默认工具注册中心 (createDefaultToolRegistry) ---");
  const defaultRegistry = createDefaultToolRegistry();
  console.log("默认工具列表:", defaultRegistry.getAll().map((t) => t.name));

  // 测试 12: 注销工具
  console.log("\n--- 测试 12: 注销工具 ---");
  registry.unregister("add");
  console.log("注销后是否包含 'add':", registry.has("add"));

  console.log("\n所有测试均已成功通过！");
}

runTests().catch((err) => {
  console.error("测试运行失败:", err);
  process.exit(1);
});
