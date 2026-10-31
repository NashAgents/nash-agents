import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { PassThrough } from "node:stream";
import { InputManager } from "../src/cli/input-manager.js";
import { CliPresenter } from "../src/presentation/cli-presenter.js";
import { EventBus } from "../src/observability/event-bus.js";
import { AgentRegistry } from "../src/agent/agent-registry.js";
import { AgentTranscriptProjection } from "../src/presentation/agent-transcript-projection.js";
import {
  InputAttachmentManager,
  probeImageDimensions,
  formatBytesHuman,
} from "../src/cli/input-attachments.js";
import { TerminalInputParser } from "../src/cli/terminal-input-parser.js";

describe("Agent Running Input, Clipboard & Vision Attachments (Terminal Parity)", () => {
  it("1.1 probeImageDimensions 准确识别 PNG 宽高等元数据", () => {
    // 构造一个合法的 100x200 PNG 最小头 Buffer
    const buf = Buffer.alloc(32);
    buf[0] = 0x89;
    buf[1] = 0x50;
    buf[2] = 0x4e;
    buf[3] = 0x47;
    buf[4] = 0x0d;
    buf[5] = 0x0a;
    buf[6] = 0x1a;
    buf[7] = 0x0a;
    buf.writeUInt32BE(100, 16);
    buf.writeUInt32BE(200, 20);

    const probed = probeImageDimensions(buf);
    assert.equal(probed.mimeType, "image/png");
    assert.equal(probed.width, 100);
    assert.equal(probed.height, 200);
  });

  it("1.2 InputAttachmentManager 识别合法图片文件并生成徽标", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nash-test-img-"));
    const imgPath = path.join(tmpDir, "screenshot.png");
    const buf = Buffer.alloc(32);
    buf[0] = 0x89;
    buf[1] = 0x50;
    buf[2] = 0x4e;
    buf[3] = 0x47;
    buf[4] = 0x0d;
    buf[5] = 0x0a;
    buf[6] = 0x1a;
    buf[7] = 0x0a;
    buf.writeUInt32BE(1920, 16);
    buf.writeUInt32BE(1080, 20);
    fs.writeFileSync(imgPath, buf);

    try {
      const manager = new InputAttachmentManager();
      const placeholder = manager.tryRegisterImage(imgPath);
      assert.ok(placeholder, "应该成功注册图片");
      assert.ok(placeholder.includes("[Image: screenshot.png (1920x1080, 32B)]"));

      // 转换为多模态消息
      const content = manager.toMessageContent(`请帮我分析这张图片 ${placeholder}`);
      assert.ok(Array.isArray(content), "应转换为多模态数组");
      assert.equal(content.length, 2);
      assert.equal(content[0].type, "text");
      assert.equal(content[0].text, "请帮我分析这张图片");
      assert.equal(content[1].type, "image_url");
      assert.ok(content[1].image_url.url.startsWith("data:image/png;base64,"));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("1.3 InputAttachmentManager 自动将多行文本折叠为 [Pasted text (X lines)] 占位符并在提交时还原", () => {
    const manager = new InputAttachmentManager();
    const longText = "line 1\nline 2\nline 3\nline 4\nline 5";
    assert.ok(manager.shouldCollapse(longText));

    const placeholder = manager.registerPastedBlock(longText);
    assert.equal(placeholder, "[Pasted text (5 lines)]");

    const inputWithOtherText = `请分析以下代码：\n${placeholder}\n请给出修改方案。`;
    const expanded = manager.expandText(inputWithOtherText);
    assert.equal(
      expanded,
      `请分析以下代码：\n${longText}\n请给出修改方案。`
    );
  });

  it("2.1 Agent 运行态 (running-main) 下打字实时通知 Presenter 且可见", () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const mgr = new InputManager({ input: input as any, output: output as any, isTTY: true });

    let latestDraft = "";
    let latestCursor = 0;
    mgr.startNavigationMode({
      onComposerChange: (draft, cursor) => {
        latestDraft = draft;
        latestCursor = cursor ?? 0;
      },
    }, "running-main");

    // 用户在 running-main 期间键入字符 "hello"
    input.write("hello");

    assert.equal(latestDraft, "hello");
    assert.equal(latestCursor, 5);

    // 用户在 running-main 期间按退格键
    input.write("\x7f");
    assert.equal(latestDraft, "hell");
    assert.equal(latestCursor, 4);

    mgr.close();
  });

  it("2.2 Agent 运行态下 Bracketed Paste 长文本自动折叠为 [Pasted text N lines]", () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const mgr = new InputManager({ input: input as any, output: output as any, isTTY: true });

    let latestDraft = "";
    mgr.startNavigationMode({
      onComposerChange: (draft) => {
        latestDraft = draft;
      },
    }, "running-main");

    // 终端下发 Bracketed Paste 多行内容
    input.write("\x1b[200~const a = 1;\nconst b = 2;\nconst c = 3;\x1b[201~");

    assert.ok(
      latestDraft.includes("[Pasted text (3 lines)]"),
      `实际呈现为: ${latestDraft}`
    );

    // 用户在折叠块后按 Backspace，应整块删除占位符
    input.write("\x7f");
    assert.equal(latestDraft, "");

    mgr.close();
  });

  it("3.1 运行中插入 Steer / Queue 消息立即在当前界面 Transcript 历史中可见并带有样式", () => {
    const eventBus = new EventBus();
    const agentRegistry = new AgentRegistry({ eventBus });
    const output = new PassThrough();

    const presenter = new CliPresenter({
      eventBus,
      agentRegistry,
      isTTY: true,
      stdout: output as any,
    });

    presenter.startRun("First Task");

    const mainProj = presenter.getProjection("main");
    // 验证初始状态只有首次 User 消息
    const initialLines = mainProj.getDisplayLines(80);
    assert.ok(initialLines.some((l) => l.includes("First Task")));

    // 用户在运行过程中通过 addUserMessageToTranscript 插入 Steer 消息
    presenter.addUserMessageToTranscript("请跳过测试直接打包", "main", "steer");

    const updatedLines = mainProj.getDisplayLines(80);
    assert.ok(
      updatedLines.some((l) => l.includes("User (steer) >") && l.includes("请跳过测试直接打包")),
      `Transcript 应包含橙黄色 User (steer) > 标记，实际输出为:\n${updatedLines.join("\n")}`
    );

    // 用户在运行过程中插入 Queue 消息
    presenter.addUserMessageToTranscript("等会儿顺便帮我重构一下 config", "main", "queue");
    const queueLines = mainProj.getDisplayLines(80);
    assert.ok(
      queueLines.some((l) => l.includes("User (queued) >") && l.includes("等会儿顺便帮我重构一下 config")),
      `Transcript 应包含粉紫色 User (queued) > 标记，实际输出为:\n${queueLines.join("\n")}`
    );

    presenter.stopRun();
  });

  it("3.2 Transcript 历史长文本折叠机制 (超过 6 行自动折叠，Ctrl+O 展开全量)", () => {
    const proj = new AgentTranscriptProjection("main");
    const longInput = "line 1\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7\nline 8\nline 9\nline 10";
    proj.addUserMessage(longInput);

    // 默认紧凑时间线视口
    const compactLines = proj.getDisplayLines(80);
    assert.ok(
      compactLines.some((l) => l.includes("lines hidden · Ctrl+O to expand")),
      `默认时间线应展示折叠指示行: ${compactLines.join("\n")}`
    );

    // 切换至详细视图 (Ctrl+O)
    proj.toggleDetailedView();
    const detailedLines = proj.getDisplayLines(80);
    assert.ok(
      !detailedLines.some((l) => l.includes("lines hidden")),
      "详细视图下应展开全部行，不出现折叠占位"
    );
    assert.ok(detailedLines.some((l) => l.includes("line 10")));
  });
});
