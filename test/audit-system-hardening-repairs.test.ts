import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemoryStore } from "../src/memory/memory-store.js";
import { ApprovalService } from "../src/approval/approval-service.js";
import { acceptsOrigin } from "../src/cluster/coordinator/web-security.js";
import { TerminalMarkdownRenderer } from "../src/presentation/terminal-markdown-renderer.js";
import stringWidth from "string-width";
import stripAnsi from "strip-ansi";

function temporaryDir(t: TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nash-system-repair-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("System Hardening Repairs Suite", async (t) => {
  await t.test("1. 幽灵记忆防御：index.json 为空时，绝不重新导入外部旧 MEMORY.md", async (t2) => {
    const dir = temporaryDir(t2);
    // 模拟磁盘上遗留旧的 MEMORY.md
    fs.writeFileSync(
      path.join(dir, "MEMORY.md"),
      "# Nash Global Memory\n\n## architecture\n- [Old Ghost](old.md) - Old ghost memory that was deleted\n",
      "utf-8"
    );
    // 同时写入空数组 index.json 表示记忆已被清空
    fs.writeFileSync(path.join(dir, "index.json"), "[]", "utf-8");

    const store = new MemoryStore({
      storageDir: dir,
      scope: "project",
      displayName: "Test Project",
    });

    const entries = await store.loadEntries();
    assert.equal(entries.length, 0, "明确清空记忆后，index.json=[] 绝不能让旧 MEMORY.md 幽灵复活");
  });

  await t.test("2. ApprovalService 单步预授权机制 (grantPreApproved / consumePreApproved)", async () => {
    const service = new ApprovalService({
      askApproval: async () => "deny",
    });

    // 未授权前应被 provider 判定为 deny
    const denied = await service.requestApproval({
      capability: "filesystem-write",
      target: "src/secret.ts",
      reason: "high risk write",
      agentId: "agent-1",
    });
    assert.equal(denied, "deny");

    // 注册通配预授权
    service.grantPreApproved("agent-1::*", 5000);

    // 第一次调用应当命中单步预授权直接放行
    const approved = await service.requestApproval({
      capability: "filesystem-write",
      target: "src/secret.ts",
      reason: "high risk write",
      agentId: "agent-1",
    });
    assert.equal(approved, "allow-once", "首发调用命中预授权放行");

    // 第二次调用预授权已被单次消耗，应重新 Fail-Closed 判定
    const nextCall = await service.requestApproval({
      capability: "filesystem-write",
      target: "src/secret.ts",
      reason: "high risk write",
      agentId: "agent-1",
    });
    assert.equal(nextCall, "deny", "预授权单次消耗后自动作废");
  });

  await t.test("3. Web 安全：acceptsOrigin 针对不匹配 Referer 进行安全阻断", async () => {
    const fakeReqWithBadReferer: any = {
      headers: {
        host: "127.0.0.1:18443",
        referer: "http://malicious-website.com/attack.html",
      },
      socket: { encrypted: false },
    };

    const allowed = acceptsOrigin(fakeReqWithBadReferer, ["http://127.0.0.1:18443"]);
    assert.equal(allowed, false, "非受信的跨域 Referer 必须被安全阻断");

    const fakeReqWithGoodReferer: any = {
      headers: {
        host: "127.0.0.1:18443",
        referer: "http://127.0.0.1:18443/workspace",
      },
      socket: { encrypted: false },
    };
    const valid = acceptsOrigin(fakeReqWithGoodReferer, ["http://127.0.0.1:18443"]);
    assert.equal(valid, true, "同源合法的 Referer 应予放行");
  });

  await t.test("4. 终端表格渲染：极窄视口下物理行宽绝不溢出 maxWidth", async () => {
    const tableMd = `| Col1 | Col2 | Col3 | Col4 | Col5 | Col6 | Col7 | Col8 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| Val1 | Val2 | Val3 | Val4 | Val5 | Val6 | Val7 | Val8 |`;

    const narrowMaxWidth = 35;
    const lines = TerminalMarkdownRenderer.render(tableMd, { maxWidth: narrowMaxWidth });

    assert.ok(lines.length > 0, "表格应成功渲染行");
    for (const line of lines) {
      const displayWidth = stringWidth(stripAnsi(line));
      assert.ok(
        displayWidth <= narrowMaxWidth,
        `物理行宽 (${displayWidth}) 绝对不能超过视口 maxWidth (${narrowMaxWidth})，当前行: ${line}`
      );
    }
  });
});
