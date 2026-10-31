import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { InputManager, TerminalUI } from "../src/cli/index.js";
import { CliApprovalProvider } from "../src/approval/cli-approval.js";

describe("CLI Input Subsystem Real E2E Verification Scenarios", () => {
  test("E2E 1: 一次性粘贴 3 行中英文混合 Prompt，完整捕获为单一 User Message 而非提前截断", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const manager = new InputManager({ input, output, isTTY: true });

    const rawPrompt =
      "For the code present, we get this error:\n“result”的类型为“未知”。\nFix it, verify, and then give a concise explanation.";

    const promise = manager.readUserMessage("Nash > ");
    // 模拟终端 Bracketed Paste 序列下发
    input.write(`\x1b[200~${rawPrompt}\x1b[201~\r`);

    const result = await promise;
    assert.strictEqual(
      result,
      rawPrompt,
      "Agent 必须收到完整的 3 行文本，包含中文双引号及所有换行"
    );
    assert.strictEqual(result.split("\n").length, 3);
    manager.close();
  });

  test("E2E 2: 粘贴 3 行 Prompt 后触发 Sandbox Approval，确认第二、三行未被 Approval 误消费", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let outputText = "";
    output.on("data", (chunk) => {
      outputText += chunk.toString();
    });

    const manager = new InputManager({ input, output, isTTY: true });
    const provider = new CliApprovalProvider({ inputManager: manager });

    // 1. 用户粘贴 3 行 Prompt 并敲击回车提交
    const rawPrompt =
      "For the code present, we get this error:\n“result”的类型为“未知”。\nFix it, verify, and then give a concise explanation.";
    const userMsgPromise = manager.readUserMessage("Nash > ");
    input.write(`\x1b[200~${rawPrompt}\x1b[201~\r`);
    const receivedUserMsg = await userMsgPromise;
    assert.strictEqual(receivedUserMsg, rawPrompt);

    // 2. 模拟 Agent 执行过程中触发沙箱网络提权审批
    const approvalPromise = provider.askApproval({
      capability: "network",
      reason: "命令因沙箱网络隔离规则 (network: deny) 阻断失败，请求临时开启一次网络访问权限",
      target: "npm test",
    });

    // 验证 Approval 处于等待状态（未被残留文本自动解析为拒绝）
    let approvalResolved = false;
    approvalPromise.then(() => {
      approvalResolved = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.strictEqual(
      approvalResolved,
      false,
      "Approval 必须处于等待状态，绝不能被此前粘贴残留的第 2、3 行自动消费"
    );

    // 3. 用户此时交互式输入 'y' 放行
    input.write("y\r");
    const decision = await approvalPromise;
    assert.strictEqual(decision, "allow-once");

    manager.close();
  });

  test("E2E 3: Approval 输入非 y/n 字符（如 hello）提示重新输入，随后输入 y 放行", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let outputText = "";
    output.on("data", (chunk) => {
      outputText += chunk.toString();
    });

    const manager = new InputManager({ input, output, isTTY: true });
    const provider = new CliApprovalProvider({ inputManager: manager });

    const approvalPromise = provider.askApproval({
      capability: "filesystem-outside-workspace",
      reason: "Write outside workspace",
      target: "/tmp/data.log",
    });

    // 用户误输入 'hello'
    input.write("hello\r");
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.ok(
      outputText.includes("Please enter y or n."),
      "必须输出友好提示要求重新输入"
    );

    // 再次输入 'y'
    input.write("y\r");
    const decision = await approvalPromise;
    assert.strictEqual(decision, "allow-once");

    manager.close();
  });

  test("E2E 4: 中文多行 Prompt + 英文错误堆栈混合粘贴完整保留格式", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const manager = new InputManager({ input, output, isTTY: true });

    const mixedPrompt = [
      "调试以下错误并给出修复：",
      "TypeError: Cannot read properties of undefined (reading 'status')",
      "    at Object.<anonymous> (/workspace/src/app.ts:42:15)",
      "    at Module._compile (node:internal/modules/cjs/loader:1469:14)",
      "请在不修改原有架构的前提下修复。",
    ].join("\n");

    const promise = manager.readUserMessage("Nash > ");
    input.write(`\x1b[200~${mixedPrompt}\x1b[201~\r`);

    const result = await promise;
    assert.strictEqual(result, mixedPrompt);
    assert.strictEqual(result.split("\n").length, 5);

    manager.close();
  });
});
