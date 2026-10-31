import { runAgentLoop } from "../src/runtime/agent-loop.js";

interface VerificationScenario {
  name: string;
  prompt: string;
  expectedTools: string[];
}

async function runVerification() {
  console.log("==================================================");
  console.log("          Agent 实际工具调用端到端验证            ");
  console.log("==================================================\n");

  // 测试 1: 查看目录并读取文件
  console.log("--------------------------------------------------");
  console.log("测试 1: 查看 src/tools 目录有哪些文件，然后读取 registry.ts");
  console.log("--------------------------------------------------");
  const toolCalls1: string[] = [];
  const response1 = await runAgentLoop(
    "查看 src/tools 目录有哪些文件，然后读取 registry.ts。",
    {
      onToolCallStart: (toolName, rawArgs) => {
        toolCalls1.push(toolName);
        console.log(`[工具调用] ${toolName} -> ${typeof rawArgs === "string" ? rawArgs : JSON.stringify(rawArgs)}`);
      },
    }
  );
  console.log(`\n=> 工具调用链: ${toolCalls1.join(" -> ")}`);
  console.log(`=> 模型最终回复:\n${response1.trim()}\n`);

  // 测试 2: 搜索文本
  console.log("--------------------------------------------------");
  console.log("测试 2: 搜索项目中所有出现 ToolExecutor 的地方");
  console.log("--------------------------------------------------");
  const toolCalls2: string[] = [];
  const response2 = await runAgentLoop(
    "搜索项目中所有出现 ToolExecutor 的地方。",
    {
      onToolCallStart: (toolName, rawArgs) => {
        toolCalls2.push(toolName);
        console.log(`[工具调用] ${toolName} -> ${typeof rawArgs === "string" ? rawArgs : JSON.stringify(rawArgs)}`);
      },
    }
  );
  console.log(`\n=> 工具调用链: ${toolCalls2.join(" -> ")}`);
  console.log(`=> 模型最终回复:\n${response2.trim()}\n`);

  // 测试 3: 分段读取大文件
  console.log("--------------------------------------------------");
  console.log("测试 3: 读取一个超过 300 行的文件 test/test-filesystem-tools.ts，并分析 250-320 行");
  console.log("--------------------------------------------------");
  const toolCalls3: { tool: string; args: any }[] = [];
  const response3 = await runAgentLoop(
    "读取超过 300 行的文件 test/test-filesystem-tools.ts，并分析其 250 到 320 行的内容。",
    {
      onToolCallStart: (toolName, rawArgs) => {
        let parsed = rawArgs;
        if (typeof rawArgs === "string") {
          try {
            parsed = JSON.parse(rawArgs);
          } catch {}
        }
        toolCalls3.push({ tool: toolName, args: parsed });
        console.log(`[工具调用] ${toolName} -> ${typeof rawArgs === "string" ? rawArgs : JSON.stringify(rawArgs)}`);
      },
    }
  );
  console.log(`\n=> 工具调用链: ${toolCalls3.map(t => `${t.tool}(${JSON.stringify(t.args)})`).join(" -> ")}`);
  console.log(`=> 模型最终回复:\n${response3.trim()}\n`);

  // 测试 4: 确定性编辑文件
  console.log("--------------------------------------------------");
  console.log("测试 4: 修改某个测试文件 test/fixtures/demo-target.ts 中的唯一一段文本");
  console.log("--------------------------------------------------");
  const toolCalls4: string[] = [];
  const response4 = await runAgentLoop(
    "修改测试文件 test/fixtures/demo-target.ts 中的唯一文本 'AGENT_VERIFY_UNIQUE_TARGET_STRING_2026' 为 'AGENT_VERIFY_MODIFIED_STRING_SUCCESS'，并在必要时验证修改结果。",
    {
      onToolCallStart: (toolName, rawArgs) => {
        toolCalls4.push(toolName);
        console.log(`[工具调用] ${toolName} -> ${typeof rawArgs === "string" ? rawArgs : JSON.stringify(rawArgs)}`);
      },
    }
  );
  console.log(`\n=> 工具调用链: ${toolCalls4.join(" -> ")}`);
  console.log(`=> 模型最终回复:\n${response4.trim()}\n`);

  console.log("==================================================");
  console.log("🎉 全部 4 组 Agent 实际场景验证完成！");
  console.log("==================================================");
}

runVerification().catch((err) => {
  console.error("Agent 验证运行出错:", err);
  process.exit(1);
});
