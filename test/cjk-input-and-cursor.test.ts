import { describe, it } from "node:test";
import assert from "node:assert";
import { EventEmitter } from "node:events";
import stringWidth from "string-width";
import { InputManager } from "../src/cli/input-manager.js";

/**
 * 模拟可控的 TTY Stdin 与 Stdout
 */
class MockTtyStream extends EventEmitter {
  isTTY = true;
  written: string[] = [];

  write(chunk: any): boolean {
    this.written.push(String(chunk));
    return true;
  }

  setEncoding(_enc: string): void {}
  setRawMode(_mode: boolean): void {}

  getOutputText(): string {
    return this.written.join("");
  }

  clearWritten(): void {
    this.written = [];
  }
}

describe("CJK Input & Terminal Cursor Subsystem", () => {
  describe("1. Terminal Display Width & ANSI Stripping", () => {
    it("1.1 纯英文字符串宽度应等于字符长度", () => {
      assert.strictEqual(stringWidth("abc123"), 6);
    });

    it("1.2 中文 (CJK) 字符宽度应为 2 列", () => {
      assert.strictEqual(stringWidth("创建"), 4);
      assert.strictEqual(stringWidth("你好世界"), 8);
    });

    it("1.3 Emoji 与 ZWJ 序列宽度应为 2 列", () => {
      assert.strictEqual(stringWidth("😀"), 2);
      assert.strictEqual(stringWidth("👨‍💻"), 2);
    });

    it("1.4 ANSI 彩色 Prompt 宽度应仅计算可见字符宽度，不包含转义序列", () => {
      const coloredPrompt = "\x1b[36mNash > \x1b[0m";
      assert.strictEqual(stringWidth(coloredPrompt), 7);
    });
  });

  describe("2. Interactive Line Editing & Backspace Erase Integrity", () => {
    it("2.1 ASCII 输入与退格应正确擦除并更新 buffer", async () => {
      const mockInput = new MockTtyStream();
      const mockOutput = new MockTtyStream();
      const manager = new InputManager({
        input: mockInput as any,
        output: mockOutput as any,
        isTTY: true,
      });

      const messagePromise = manager.readUserMessage("Nash > ");

      // 输入 "abc" -> Backspace -> 回车
      mockInput.emit("data", "abc\x7f\r");

      const result = await messagePromise;
      assert.strictEqual(result, "ab");

      manager.close();
    });

    it("2.2 中文输入后按 Backspace 应彻底清除 2 列宽度，绝无幽灵字符残影", async () => {
      const mockInput = new MockTtyStream();
      const mockOutput = new MockTtyStream();
      const manager = new InputManager({
        input: mockInput as any,
        output: mockOutput as any,
        isTTY: true,
      });

      const messagePromise = manager.readUserMessage("Nash > ");

      // 输入 "创建 是" -> 退格两次 -> 回车
      mockInput.emit("data", "创建 是\x7f\x7f\r");

      const result = await messagePromise;
      assert.strictEqual(result, "创建");

      // 验证终端重绘输出中使用了 \x1b[K 清除行尾且光标位置正确
      const outputText = mockOutput.getOutputText();
      assert.ok(outputText.includes("\x1b[K"));

      manager.close();
    });

    it("2.3 多个连续中文字符连续退格至空行应无残影", async () => {
      const mockInput = new MockTtyStream();
      const mockOutput = new MockTtyStream();
      const manager = new InputManager({
        input: mockInput as any,
        output: mockOutput as any,
        isTTY: true,
      });

      const messagePromise = manager.readUserMessage("Nash > ");

      // 输入 "你好世界" -> 退格 4 次 -> 输入 "OK" -> 回车
      mockInput.emit("data", "你好世界\x7f\x7f\x7f\x7fOK\r");

      const result = await messagePromise;
      assert.strictEqual(result, "OK");

      manager.close();
    });

    it("2.4 中英混合输入与中间位置编辑", async () => {
      const mockInput = new MockTtyStream();
      const mockOutput = new MockTtyStream();
      const manager = new InputManager({
        input: mockInput as any,
        output: mockOutput as any,
        isTTY: true,
      });

      const messagePromise = manager.readUserMessage("Nash > ");

      // 输入 "abc你好123"
      // 光标向左移动 4 次（到 '好' 与 '1' 之间，再到 '你' 与 '好' 之间，即 abc你|好123）
      // 然后按退格删除 '你'
      // 最终应变为 "abc好123"
      mockInput.emit(
        "data",
        "abc你好123\x1b[D\x1b[D\x1b[D\x1b[D\x7f\r"
      );

      const result = await messagePromise;
      assert.strictEqual(result, "abc好123");

      manager.close();
    });

    it("2.5 Emoji (😀) 与复杂组合字符 (é, 👨‍💻) 退格应整块删除", async () => {
      const mockInput = new MockTtyStream();
      const mockOutput = new MockTtyStream();
      const manager = new InputManager({
        input: mockInput as any,
        output: mockOutput as any,
        isTTY: true,
      });

      const messagePromise = manager.readUserMessage("Nash > ");

      // 输入 "😀测试👨‍💻" -> 退格删除 👨‍💻 -> 回车
      mockInput.emit("data", "😀测试👨‍💻\x7f\r");

      const result = await messagePromise;
      assert.strictEqual(result, "😀测试");

      manager.close();
    });

    it("2.6 Delete 键 (\x1b[3~) 应正确删除光标所在处的字形", async () => {
      const mockInput = new MockTtyStream();
      const mockOutput = new MockTtyStream();
      const manager = new InputManager({
        input: mockInput as any,
        output: mockOutput as any,
        isTTY: true,
      });

      const messagePromise = manager.readUserMessage("Nash > ");

      // 输入 "abc你好" -> Home (\x1b[H) -> Delete 键删除 'a' -> 回车
      mockInput.emit("data", "abc你好\x1b[H\x1b[3~\r");

      const result = await messagePromise;
      assert.strictEqual(result, "bc你好");

      manager.close();
    });

    it("2.7 Ctrl+A (Home) 与 Ctrl+E (End) 导航", async () => {
      const mockInput = new MockTtyStream();
      const mockOutput = new MockTtyStream();
      const manager = new InputManager({
        input: mockInput as any,
        output: mockOutput as any,
        isTTY: true,
      });

      const messagePromise = manager.readUserMessage("Nash > ");

      // 输入 "world" -> Ctrl+A -> 输入 "hello " -> Ctrl+E -> 输入 "!" -> 回车
      mockInput.emit("data", "world\x01hello \x05!\r");

      const result = await messagePromise;
      assert.strictEqual(result, "hello world!");

      manager.close();
    });

    it("2.8 Ctrl+W 单词退格与 Ctrl+U 整行清空", async () => {
      const mockInput = new MockTtyStream();
      const mockOutput = new MockTtyStream();
      const manager = new InputManager({
        input: mockInput as any,
        output: mockOutput as any,
        isTTY: true,
      });

      const messagePromise = manager.readUserMessage("Nash > ");

      // 输入 "git commit -m" -> Ctrl+W -> 输入 "push" -> 回车
      mockInput.emit("data", "git commit -m\x17push\r");

      const result = await messagePromise;
      assert.strictEqual(result, "git commit push");

      manager.close();
    });
  });

  describe("3. Bracketed Paste & Non-TTY Stability", () => {
    it("3.1 Bracketed Paste 多行中文内容完整接收且不提前提交", async () => {
      const mockInput = new MockTtyStream();
      const mockOutput = new MockTtyStream();
      const manager = new InputManager({
        input: mockInput as any,
        output: mockOutput as any,
        isTTY: true,
      });

      const messagePromise = manager.readUserMessage("Nash > ");

      // 模拟粘贴块：\x1b[200~ 第一行\n第二行中文 \x1b[201~
      mockInput.emit(
        "data",
        "\x1b[200~第一行测试\n第二行中文描述\x1b[201~\r"
      );

      const result = await messagePromise;
      assert.strictEqual(result, "第一行测试\n第二行中文描述");

      manager.close();
    });
  });
});
