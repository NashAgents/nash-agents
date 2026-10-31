import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import {
  InputManager,
  TerminalUI,
  InputBusyError,
} from "../src/cli/index.js";
import { CliApprovalProvider } from "../src/approval/cli-approval.js";

describe("Unified Terminal Input Manager & CLI Input Subsystem", () => {
  let input: PassThrough;
  let output: PassThrough;
  let outputBuffer: string;
  let manager: InputManager;

  beforeEach(() => {
    input = new PassThrough();
    output = new PassThrough();
    outputBuffer = "";
    output.on("data", (chunk: Buffer | string) => {
      outputBuffer += chunk.toString();
    });

    manager = new InputManager({
      input,
      output,
      isTTY: true,
    });
  });

  afterEach(() => {
    manager.close();
  });

  test("1. 单行输入 + Enter 正常提交", async () => {
    const promise = manager.readUserMessage();
    input.write("hello world\r");
    const result = await promise;
    assert.strictEqual(result, "hello world");
  });

  test("2. Bracketed Paste: 输入多行文本在结束前不会在 line1 后提前提交", async () => {
    const promise = manager.readUserMessage();
    input.write("\x1b[200~line1\nline2\nline3\x1b[201~");

    let resolved = false;
    promise.then(() => {
      resolved = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.strictEqual(
      resolved,
      false,
      "在没有收到最终提交 Enter 前，多行粘贴不应提前触发 resolve"
    );

    // 随后用户敲击回车提交
    input.write("\r");
    const result = await promise;
    assert.strictEqual(result, "line1\nline2\nline3");
  });

  test("3. Paste 结束后 Enter 一次返回完整多行内容", async () => {
    const promise = manager.readUserMessage();
    input.write("\x1b[200~alpha\nbeta\ngamma\x1b[201~\r");
    const result = await promise;
    assert.strictEqual(result, "alpha\nbeta\ngamma");
  });

  test("4. 中文多行粘贴与特殊字符解析正确", async () => {
    const chinesePrompt =
      "For the code present, we get this error:\n“result”的类型为“未知”。\nFix it, verify, and then give a concise explanation.";
    const promise = manager.readUserMessage();
    input.write(`\x1b[200~${chinesePrompt}\x1b[201~\r`);
    const result = await promise;
    assert.strictEqual(result, chinesePrompt);
  });

  test("5. Paste 文本最后自带 newline 不会提前错误提交", async () => {
    const promise = manager.readUserMessage();
    input.write("\x1b[200~line1\nline2\n\x1b[201~");

    let resolved = false;
    promise.then(() => {
      resolved = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.strictEqual(resolved, false);

    input.write("\r");
    const result = await promise;
    assert.strictEqual(result, "line1\nline2\n");
  });

  test("6. Paste 之后 stdin 缓冲区干净，后续读取不残留第二、第三行", async () => {
    const promise1 = manager.readUserMessage();
    input.write("\x1b[200~first\nsecond\nthird\x1b[201~\r");
    const result1 = await promise1;
    assert.strictEqual(result1, "first\nsecond\nthird");

    // 第二次读取新的用户指令
    const promise2 = manager.readUserMessage();
    input.write("clean new command\r");
    const result2 = await promise2;
    assert.strictEqual(result2, "clean new command");
  });

  test("7. User Message 完成后才允许进入 Approval，且 Approval 不会误消费前序输入", async () => {
    const promise1 = manager.readUserMessage();
    input.write("\x1b[200~error occurred\nplease retry\x1b[201~\r");
    const userMsg = await promise1;
    assert.strictEqual(userMsg, "error occurred\nplease retry");

    // 紧接着发起 Approval 请求
    const approvalPromise = manager.askYesNo("Allow network? [y/N] ");
    assert.strictEqual(manager.getInteractionMode(), "approval");

    input.write("y\r");
    const allowed = await approvalPromise;
    assert.strictEqual(allowed, true);
    assert.strictEqual(manager.getInteractionMode(), "idle");
  });

  test("8. Approval y / Y / yes / YES 正确判定为 true", async () => {
    const positiveInputs = ["y", "Y", "yes", "YES", "  y  ", "  YES "];
    for (const val of positiveInputs) {
      const p = manager.askYesNo("Allow once? [y/N] ");
      input.write(`${val}\r`);
      const res = await p;
      assert.strictEqual(res, true, `Expected "${val}" to resolve to true`);
    }
  });

  test("9. Approval n / N / no / NO 正确判定为 false", async () => {
    const negativeInputs = ["n", "N", "no", "NO", "  n  ", " NO  "];
    for (const val of negativeInputs) {
      const p = manager.askYesNo("Allow once? [y/N] ");
      input.write(`${val}\r`);
      const res = await p;
      assert.strictEqual(res, false, `Expected "${val}" to resolve to false`);
    }
  });

  test("10. Approval 空输入回车返回默认值 (默认 false，或 options.defaultValue)", async () => {
    const p1 = manager.askYesNo("Allow once? [y/N] ");
    input.write("\r");
    const res1 = await p1;
    assert.strictEqual(res1, false);

    const p2 = manager.askYesNo("Allow once? [y/N] ", { defaultValue: true });
    input.write("\r");
    const res2 = await p2;
    assert.strictEqual(res2, true);
  });

  test("11. Approval 输入非法字符（如 hello）不应直接返回 false，应提示重新输入 y/n 并等待", async () => {
    const p = manager.askYesNo("Allow once? [y/N] ");
    input.write("hello\r");

    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.ok(
      outputBuffer.includes("Please enter y or n."),
      "应在终端输出重新输入 y or n 的提示"
    );
    assert.strictEqual(
      manager.getInteractionMode(),
      "approval",
      "应继续保持在 approval 模式等待有效输入"
    );

    // 用户随后输入正确的 'y'
    input.write("y\r");
    const res = await p;
    assert.strictEqual(res, true);
  });

  test("12. 禁止 readUserMessage 和 askYesNo 并发读取，应抛出 InputBusyError", async () => {
    const promise1 = manager.readUserMessage();

    await assert.rejects(async () => {
      await manager.askYesNo("Allow? [y/N] ");
    }, InputBusyError);

    await assert.rejects(async () => {
      await manager.readUserMessage();
    }, InputBusyError);

    input.write("finish current read\r");
    const result1 = await promise1;
    assert.strictEqual(result1, "finish current read");
  });

  test("13. Ctrl+C 正确触发中断回调并还原终端", async () => {
    let interrupted = false;
    let terminalReset = false;

    const testInput = new PassThrough();
    const testOutput = new PassThrough();
    testOutput.on("data", (c) => {
      if (c.toString().includes("\x1b[?2004l")) {
        terminalReset = true;
      }
    });

    const customManager = new InputManager({
      input: testInput,
      output: testOutput,
      isTTY: true,
      onInterrupt: () => {
        interrupted = true;
      },
    });

    const p = customManager.readUserMessage().catch(() => {});
    testInput.write("\x03"); // ETX (Ctrl+C)

    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.strictEqual(interrupted, true, "应触发 onInterrupt 回调");
    assert.strictEqual(terminalReset, true, "应向终端输出 \\x1b[?2004l 关闭 Bracketed Paste");

    customManager.close();
    await p;
  });

  test("14. close() 正确关闭 Bracketed Paste 模式并重置状态", () => {
    let resetEmitted = false;
    const testInput = new PassThrough();
    const testOutput = new PassThrough();
    testOutput.on("data", (chunk) => {
      if (chunk.toString().includes("\x1b[?2004l")) {
        resetEmitted = true;
      }
    });

    const m = new InputManager({
      input: testInput,
      output: testOutput,
      isTTY: true,
    });

    m.close();
    assert.strictEqual(resetEmitted, true);
    assert.strictEqual(m.isTerminated(), true);
    assert.strictEqual(testInput.readableFlowing, false, "关闭后须暂停 stdin，避免进程滞留并要求第二次 Ctrl+C");
  });

  test("15. 非 TTY: 多行 stdin 管道流一次性读取为完整 User Message", async () => {
    const nonTtyInput = new PassThrough();
    const nonTtyOutput = new PassThrough();

    const nonTtyManager = new InputManager({
      input: nonTtyInput,
      output: nonTtyOutput,
      isTTY: false,
    });

    const readPromise = nonTtyManager.readUserMessage();
    nonTtyInput.write("multi\nline\npiped\ninput\n");
    nonTtyInput.end();

    const message = await readPromise;
    assert.strictEqual(message, "multi\nline\npiped\ninput\n");

    // 管道流结束后再次读取返回 exit 供 REPL 退出
    const nextMsg = await nonTtyManager.readUserMessage();
    assert.strictEqual(nextMsg, "exit");

    nonTtyManager.close();
  });

  test("16. exit / quit 正常工作", async () => {
    const p1 = manager.readUserMessage();
    input.write("exit\r");
    assert.strictEqual(await p1, "exit");

    const p2 = manager.readUserMessage();
    input.write("quit\r");
    assert.strictEqual(await p2, "quit");
  });

  test("17. 多行内容中包含 exit 单词时不应被误判定为退出命令", async () => {
    const multilineWithError =
      "Error: Child process exited with exit status 1\nPlease analyze and fix it.\nexit was called.";
    const p = manager.readUserMessage();
    input.write(`\x1b[200~${multilineWithError}\x1b[201~\r`);
    const message = await p;

    assert.strictEqual(message, multilineWithError);
    const trimmedLower = message.trim().toLowerCase();
    assert.notStrictEqual(
      trimmedLower,
      "exit",
      "多行内容包含 exit 不应等于单纯的 'exit' 命令"
    );
    assert.notStrictEqual(
      trimmedLower,
      "quit",
      "多行内容不应等于单纯的 'quit' 命令"
    );
  });

  test("18. CliApprovalProvider 通过依赖注入调用 InputManager 且返回正确 Decision", async () => {
    const provider = new CliApprovalProvider({
      inputManager: manager,
    });

    const askPromise = provider.askApproval({
      capability: "network",
      reason: "npm test requires network access",
      target: "npm test",
    });

    input.write("y\r");
    const decision = await askPromise;
    assert.strictEqual(decision, "allow-once");

    const askPromise2 = provider.askApproval({
      capability: "filesystem-outside-workspace",
      reason: "Access external path",
      target: "/etc/passwd",
    });

    input.write("n\r");
    const decision2 = await askPromise2;
    assert.strictEqual(decision2, "deny");
  });

  test("19. restoreTerminal 在多次切换交互模式后依然能可靠下发鼠标追踪禁用序列", async () => {
    const customIn = new PassThrough();
    (customIn as any).isTTY = true;
    (customIn as any).setRawMode = () => {};
    let written = "";
    const customOut = new PassThrough();
    customOut.on("data", (chunk) => {
      written += chunk.toString("utf8");
    });
    (customOut as any).isTTY = true;

    // 显式配置 enableMouseReporting: true 进行鼠标模式与恢复生命周期测试
    const mgr = new InputManager({
      input: customIn as any,
      output: customOut as any,
      isTTY: true,
      enableMouseReporting: true,
    });

    // 1. 开启导航模式并切换模式
    mgr.startNavigationMode({}, "running-main");
    assert.ok(written.includes("\x1b[?1000h\x1b[?1002h\x1b[?1006h"), "显式配置时应开启 SGR 鼠标报告");

    // 2. 模拟打断并触发 restoreTerminal
    customIn.write("\x03");
    assert.ok(written.includes("\x1b[?1000l"), "第一次打断应关闭鼠标报告");

    // 3. 再次切换到 session-ready（重新激活鼠标报告）
    written = "";
    mgr.setInteractionMode("session-ready");
    assert.ok(written.includes("\x1b[?1000h\x1b[?1002h\x1b[?1006h"), "重回 session-ready 应重新开启鼠标报告");

    // 4. close 必须能可靠下发全套禁用序列，不受历史 isRestored 影响
    written = "";
    mgr.close();
    assert.ok(
      written.includes("\x1b[?1000l") && written.includes("\x1b[?1006l"),
      "close() 时必须可靠输出鼠标禁用序列"
    );
  });

  test("20. 快速双击 Ctrl+C (Fast Double Ctrl+C) 立即触发退出", async () => {
    const customIn = new PassThrough();
    (customIn as any).isTTY = true;
    (customIn as any).setRawMode = () => {};
    const customOut = new PassThrough();
    (customOut as any).isTTY = true;

    let submittedText = "";
    const mgr = new InputManager({
      input: customIn as any,
      output: customOut as any,
      isTTY: true,
    });

    mgr.startNavigationMode(
      {
        onComposerSubmit: (text) => {
          submittedText = text;
        },
      },
      "running-main"
    );

    // 模拟快速双击 Ctrl+C（在 10ms 间隔内输入两次 \x03）
    customIn.write("\x03");
    await new Promise((r) => setTimeout(r, 10));
    customIn.write("\x03");

    assert.strictEqual(submittedText, "exit", "双击 Ctrl+C 应立即触发 exit 提交");
    mgr.close();
  });

  test("21. 空闲态下草稿仅含残存鼠标控制序列时 Ctrl+C 能够单次直接退出", async () => {
    const customIn = new PassThrough();
    (customIn as any).isTTY = true;
    (customIn as any).setRawMode = () => {};
    const customOut = new PassThrough();
    (customOut as any).isTTY = true;

    let submittedText = "";
    const mgr = new InputManager({
      input: customIn as any,
      output: customOut as any,
      isTTY: true,
    });

    mgr.startNavigationMode(
      {
        onComposerSubmit: (text) => {
          submittedText = text;
        },
      },
      "session-ready"
    );

    // 模拟由于终端事件未解析导致的残存鼠标控制字符
    customIn.write("^[[<0;59;16M");
    // 单次按下 Ctrl+C
    customIn.write("\x03");

    assert.strictEqual(submittedText, "exit", "残存控制序列不应阻碍单次 Ctrl+C 退出");
    mgr.close();
  });

  test("22. 空闲页面有草稿时单次 Ctrl+C 直接退出", () => {
    const customIn = new PassThrough();
    (customIn as any).isTTY = true;
    (customIn as any).setRawMode = () => {};
    const customOut = new PassThrough();
    let submittedText = "";
    const mgr = new InputManager({ input: customIn as any, output: customOut as any, isTTY: true });
    mgr.startNavigationMode({ onComposerSubmit: (text) => { submittedText = text; } }, "session-ready");
    customIn.write("未完成的草稿");
    customIn.write("\x03");
    assert.strictEqual(submittedText, "exit");
    mgr.close();
  });

  test("23. 主任务结束后在子代理详情页单次 Ctrl+C 直接退出", () => {
    const customIn = new PassThrough();
    (customIn as any).isTTY = true;
    (customIn as any).setRawMode = () => {};
    const customOut = new PassThrough();
    let submittedText = "";
    const mgr = new InputManager({ input: customIn as any, output: customOut as any, isTTY: true });
    mgr.startNavigationMode({
      isRunActive: () => false,
      onComposerSubmit: (text) => { submittedText = text; },
    }, "agent-detail");
    customIn.write("\x03");
    assert.strictEqual(submittedText, "exit");
    mgr.close();
  });

  test("24. 会话选择器在空闲时单次 Ctrl+C 直接退出", () => {
    const customIn = new PassThrough();
    (customIn as any).isTTY = true;
    (customIn as any).setRawMode = () => {};
    const customOut = new PassThrough();
    let submittedText = "";
    const mgr = new InputManager({ input: customIn as any, output: customOut as any, isTTY: true });
    mgr.startNavigationMode({
      isRunActive: () => false,
      onResumeCancel: () => mgr.setInteractionMode("session-ready"),
      onComposerSubmit: (text) => { submittedText = text; },
    }, "session-picker");
    customIn.write("\x03");
    assert.strictEqual(submittedText, "exit");
    mgr.close();
  });
});
