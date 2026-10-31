import { describe, it } from "node:test";
import assert from "node:assert";
import { PassThrough } from "node:stream";
import { InputManager } from "../src/cli/input-manager.js";

describe("Keyboard Navigation Mode Matrix (各交互模式下 ↑ / ↓ 与滚轮语义路由隔离测试)", () => {
  it("1. Main View (running-main & session-ready): ↑/↓ 移动 Agent 高亮，鼠标滚轮/PgUp/PgDn 滚动 Transcript", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const manager = new InputManager({ input, output, isTTY: true });

    let selectUp = 0;
    let selectDown = 0;
    let scrollUp = 0;
    let scrollDown = 0;
    let pageUp = 0;
    let pageDown = 0;
    let homeCount = 0;
    let endCount = 0;
    let enterOpened = 0;

    manager.startNavigationMode({
      onKeyUp: () => { selectUp++; },
      onKeyDown: () => { selectDown++; },
      onMouseWheelUp: () => { scrollUp++; },
      onMouseWheelDown: () => { scrollDown++; },
      onPageUp: () => { pageUp++; },
      onPageDown: () => { pageDown++; },
      onHome: () => { homeCount++; },
      onEnd: () => { endCount++; },
      onKeyEnter: () => { enterOpened++; },
    }, "running-main");

    try {
      // 1.1 ↑ 和 ↓ 必须严格触发 onKeyUp / onKeyDown (切换 selectedAgentId)
      input.write("\x1b[A"); // arrow-up
      input.write("\x1b[B"); // arrow-down
      await new Promise((r) => setTimeout(r, 5));
      assert.strictEqual(selectUp, 1, "Main View 下 ↑ 必须切换上一个 Agent");
      assert.strictEqual(selectDown, 1, "Main View 下 ↓ 必须切换下一个 Agent");
      assert.strictEqual(scrollUp, 0, "Main View 下 ↑ 绝不能触发滚动 Transcript");
      assert.strictEqual(scrollDown, 0, "Main View 下 ↓ 绝不能触发滚动 Transcript");

      // 1.2 鼠标滚轮向上/向下滚动 -> 严格触发 onMouseWheelUp / onMouseWheelDown，不改变 Agent 选中
      input.write("\x1b[<64;10;10M"); // mouse wheel up
      input.write("\x1b[<65;10;10M"); // mouse wheel down
      await new Promise((r) => setTimeout(r, 5));
      assert.strictEqual(scrollUp, 1, "鼠标滚轮向上滚动 Main Transcript");
      assert.strictEqual(scrollDown, 1, "鼠标滚轮向下滚动 Main Transcript");
      assert.strictEqual(selectUp, 1, "鼠标滚轮绝不改变 Agent 选中");
      assert.strictEqual(selectDown, 1, "鼠标滚轮绝不改变 Agent 选中");

      // 1.3 PgUp / PgDn / Home / End -> 翻页与顶部/底部滚动 Transcript
      input.write("\x1b[5~"); // PageUp
      input.write("\x1b[6~"); // PageDown
      input.write("\x1b[H");  // Home
      input.write("\x1b[F");  // End
      await new Promise((r) => setTimeout(r, 5));
      assert.strictEqual(pageUp, 1, "PgUp 翻页 Transcript");
      assert.strictEqual(pageDown, 1, "PgDn 翻页 Transcript");
      assert.strictEqual(homeCount, 1, "Home 回到 Transcript 顶部");
      assert.strictEqual(endCount, 1, "End 回到 Transcript 底部");

      // 1.4 回车且 composer 为空 -> 触发 onKeyEnter 打开高亮 Agent
      input.write("\r");
      await new Promise((r) => setTimeout(r, 5));
      assert.strictEqual(enterOpened, 1, "Composer 为空时按 Enter 打开选中 Agent");
    } finally {
      manager.close();
    }
  });

  it("2. Agent Detail 视图: ↑/↓ 支持选择 Agent 列表，滚轮上下滚动当前 Agent 的 Transcript", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const manager = new InputManager({ input, output, isTTY: true });

    let selectUp = 0;
    let selectDown = 0;
    let scrollUp = 0;
    let scrollDown = 0;

    manager.startNavigationMode({
      onKeyUp: () => { selectUp++; },
      onKeyDown: () => { selectDown++; },
      onMouseWheelUp: () => { scrollUp++; },
      onMouseWheelDown: () => { scrollDown++; },
    }, "agent-detail");

    try {
      // 2.1 在 agent-detail 模式下，↑ 和 ↓ 用于切换/选择 Agent
      input.write("\x1b[A"); // arrow-up
      input.write("\x1b[B"); // arrow-down
      await new Promise((r) => setTimeout(r, 5));
      assert.strictEqual(selectUp, 1, "Agent Detail 下 ↑ 支持选择上一个 Agent");
      assert.strictEqual(selectDown, 1, "Agent Detail 下 ↓ 支持选择下一个 Agent");

      // 2.2 SGR 鼠标滚轮用于滚动当前 Agent Transcript
      input.write("\x1b[<64;10;10M");
      input.write("\x1b[<65;10;10M");
      await new Promise((r) => setTimeout(r, 5));
      assert.strictEqual(scrollUp, 1, "Agent Detail 下滚轮向上滚动该 Agent Transcript");
      assert.strictEqual(scrollDown, 1, "Agent Detail 下滚轮向下滚动该 Agent Transcript");
    } finally {
      manager.close();
    }
  });

  it("3. Structured Decision 视图: ↑/↓ 切换决策选项 (onDecisionKeyUp / onDecisionKeyDown)", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const manager = new InputManager({ input, output, isTTY: true });

    let selectUp = 0;
    let selectDown = 0;
    let decisionUp = 0;
    let decisionDown = 0;

    manager.startNavigationMode({
      onKeyUp: () => { selectUp++; },
      onKeyDown: () => { selectDown++; },
      onDecisionKeyUp: () => { decisionUp++; },
      onDecisionKeyDown: () => { decisionDown++; },
    }, "structured-decision");

    try {
      input.write("\x1b[A"); // arrow-up
      input.write("\x1b[B"); // arrow-down
      await new Promise((r) => setTimeout(r, 5));
      assert.strictEqual(decisionUp, 1, "Structured Decision 下 ↑ 切换上一个决策选项");
      assert.strictEqual(decisionDown, 1, "Structured Decision 下 ↓ 切换下一个决策选项");
      assert.strictEqual(selectUp, 0, "Structured Decision 下绝不触发 Agent 切换");
      assert.strictEqual(selectDown, 0, "Structured Decision 下绝不触发 Agent 切换");
    } finally {
      manager.close();
    }
  });

  it("4. Plan Revision 模式: ↑/↓ 不用于切换 Agent", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const manager = new InputManager({ input, output, isTTY: true });

    let selectUp = 0;
    let selectDown = 0;

    manager.startNavigationMode({
      onKeyUp: () => { selectUp++; },
      onKeyDown: () => { selectDown++; },
    }, "plan-revision");

    try {
      input.write("\x1b[A");
      input.write("\x1b[B");
      await new Promise((r) => setTimeout(r, 5));
      assert.strictEqual(selectUp, 0, "Plan Revision 模式下 ↑ 绝不切换 Agent");
      assert.strictEqual(selectDown, 0, "Plan Revision 模式下 ↓ 绝不切换 Agent");
    } finally {
      manager.close();
    }
  });
});
