import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import dotenv from "dotenv";
import { runAgentLoop } from "../src/runtime/agent-loop.js";
import { SandboxService } from "../src/sandbox/sandbox-service.js";
import { FileSystemAccess } from "../src/sandbox/filesystem-access.js";
import { createDefaultToolRegistry } from "../src/tools/index.js";
import { createDefaultSandboxPolicy } from "../src/sandbox/policy.js";
import { PreToolSecurityMonitor } from "../src/security/security-monitor.js";
import { WindowsSandboxProbe } from "../src/sandbox/windows/capability-probe.js";
import { resolveProjectContext } from "../src/project/project-context.js";

// 加载环境变量中的 API Key
dotenv.config();

describe("Windows Native Sandbox — Real AgentLoop End-to-End Acceptance (Scenario T)", {
  skip: process.platform !== "win32" || !process.env.DEEPSEEK_API_KEY ? "Requires Windows and DEEPSEEK_API_KEY" : false
}, () => {
  it("场景 T：完整真实 AgentLoop — 真实模型分析代码、编辑修复、Windows 原生沙箱运行测试并交付最终成果", async () => {
    const tempWs = await fs.mkdtemp(path.join(os.tmpdir(), "nash-agentloop-e2e-"));
    const testHome = await fs.mkdtemp(path.join(os.tmpdir(), "nash-agentloop-home-"));

    try {
      // 1. 初始化待修复的源码与测试用例
      const mathSrc = `
export function add(a, b) {
  // BUG: 错误地写成了减法
  return a - b;
}
`.trim();

      const testSrc = `
import { add } from './math.js';
import assert from 'node:assert/strict';

assert.equal(add(10, 20), 30);
console.log('AGENT_E2E_MATH_SUCCESS');
`.trim();

      await fs.writeFile(path.join(tempWs, "math.js"), mathSrc, "utf-8");
      await fs.writeFile(path.join(tempWs, "test.js"), testSrc, "utf-8");

      // 2. 组装具备 Windows 原生安全沙箱的工具链与运行时
      const policy = {
        filesystem: { mode: "workspace-write" as const },
        network: { mode: "deny" as const },
        approval: { mode: "never" as const },
      };

      const sandboxService = new SandboxService({ policy, cwd: tempWs });
      const fsAccess = new FileSystemAccess({ policy, workspaceRoot: tempWs });
      const toolRegistry = createDefaultToolRegistry({ sandboxService, fsAccess });

      // 验证原生沙箱能力就绪
      const probe = WindowsSandboxProbe.probe();
      assert.equal(probe.filesystemIsolationAvailable, true);
      assert.equal(probe.networkIsolationAvailable, true);

      // 记录工具调用追踪
      const executedTools: string[] = [];
      let agentVerifiedTest = false;
      const userPrompt = "当前工作区的 math.js 中加法函数有错误。请先阅读 math.js，修复加法函数为正确的 a + b，然后通过 bash 工具执行 `node test.js` 进行验证。验证输出包含 AGENT_E2E_MATH_SUCCESS 后，简要向我汇报修复完成。";

      // 3. 运行完整真实 AgentLoop
      const projectContext = await resolveProjectContext({ projectRoot: tempWs, nashHome: testHome });
      const finalAnswer = await runAgentLoop(userPrompt, {
        projectContext,
        maxSteps: 8,
        tools: toolRegistry.getAll(),
        sandboxService,
        onToolCallStart: (toolName) => {
          executedTools.push(toolName);
        },
        onToolCallEnd: (toolName, result) => {
          if (toolName === "bash" && result.success && result.output.includes("AGENT_E2E_MATH_SUCCESS")) agentVerifiedTest = true;
        },
      });

      console.log("AgentLoop Final Answer:\n", finalAnswer);
      console.log("Executed Tools Chain:\n", executedTools);

      // 4. 严格断言执行成果
      assert.ok(typeof finalAnswer === "string" && finalAnswer.length > 0);
      assert.ok(executedTools.length >= 2);
      assert.equal(agentVerifiedTest, true, "The AgentLoop itself must run a successful sandboxed test; host-side verification cannot substitute");

      // 验证 math.js 物理文件已被正确修改
      const updatedMath = await fs.readFile(path.join(tempWs, "math.js"), "utf-8");
      assert.match(updatedMath, /return\s+a\s*\+\s*b/);

      // 确认宿主能够成功执行修复后的测试脚本
      const verifyRes = await sandboxService.runProcess({
        command: "node.exe",
        args: ["test.js"],
        cwd: tempWs,
      });
      assert.equal(verifyRes.exitCode, 0);
      assert.match(verifyRes.stdout, /AGENT_E2E_MATH_SUCCESS/);

    } finally {
      // 5. 即用即删，严禁残留
      if (fsSync.existsSync(tempWs)) {
        await fs.rm(tempWs, { recursive: true, force: true });
      }
      await fs.rm(testHome, { recursive: true, force: true });
    }
  });
});
