import http from "node:http";
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import path from "node:path";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import { spawn } from "node:child_process";

describe("Global CLI Nash Real E2E Tests (全局 nash 命令行端到端测试)", { skip: process.platform !== "linux" ? "Requires Linux platform" : false }, () => {
  let testWorkspace: string;

  beforeEach(async () => {
    testWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "nash-cli-e2e-"));
  });

  afterEach(async () => {
    // 遵守临时文件即用即删铁律
    const outsideTestFile = "/etc/nash-test";
    if (fsSync.existsSync(outsideTestFile)) {
      try {
        await fs.unlink(outsideTestFile);
      } catch {}
    }
    if (fsSync.existsSync(testWorkspace)) {
      await fs.rm(testWorkspace, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // 1. 全局 nash /status 真实输出校验
  // =========================================================================
  it("CLI E2E 1: 全局 nash 命令执行 /status 正确显示 Backend 为 linux-bubblewrap", async () => {
    const nashBin = path.resolve(process.cwd(), "dist/index.js");

    const child = spawn("node", [nashBin], {
      cwd: testWorkspace,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      output += chunk.toString();
    });

    // 发送 /status 并退出
    child.stdin.write("/status\nexit\n");
    child.stdin.end();

    const exitCode = await new Promise<number>((resolve) => {
      child.on("close", (code) => resolve(code ?? 0));
    });

    assert.strictEqual(exitCode, 0);
    const cleanOutput = output.replace(/\x1b\[[0-9;]*m/g, "");
    assert.ok(cleanOutput.includes("linux-bubblewrap"), "必须显示当前后端为 linux-bubblewrap");
    assert.ok(cleanOutput.includes("workspace-write"));
    assert.ok(cleanOutput.includes("deny"));
  });

  // =========================================================================
  // 2. 在当前 workspace 创建 linux-sandbox-test.txt 成功
  // =========================================================================
  it("CLI E2E 2: 在当前工作区执行写入命令创建 linux-sandbox-test.txt 成功", async () => {
    const testFileName = "linux-sandbox-test.txt";
    const testFilePath = path.join(testWorkspace, testFileName);

    // 载入现有的 SandboxService 直接以真实全局策略运行命令
    const { SandboxService } = await import("../src/sandbox/sandbox-service.js");
    const { createDefaultSandboxPolicy } = await import("../src/sandbox/policy.js");

    const svc = new SandboxService({
      policy: createDefaultSandboxPolicy(),
      cwd: testWorkspace,
    });

    await svc.runBash(`echo "nash-linux-e2e-pass" > "${testFileName}"`);

    assert.strictEqual(fsSync.existsSync(testFilePath), true, "linux-sandbox-test.txt 必须成功创建");
    const content = await fs.readFile(testFilePath, "utf-8");
    assert.strictEqual(content.trim(), "nash-linux-e2e-pass");

    // 清理该测试文件
    await fs.unlink(testFilePath);
  });

  // =========================================================================
  // 3. 试图向 /etc/nash-test 写入被严格拦截
  // =========================================================================
  it("CLI E2E 3: 试图向 /etc/nash-test 写入被内核沙箱与策略拦截，文件绝未创建", async () => {
    const { SandboxService } = await import("../src/sandbox/sandbox-service.js");
    const { createDefaultSandboxPolicy } = await import("../src/sandbox/policy.js");

    const svc = new SandboxService({
      policy: createDefaultSandboxPolicy(),
      cwd: testWorkspace,
    });

    const res = await svc.runProcess({
      command: "bash",
      args: ["-c", "touch /etc/nash-test 2>&1"],
      cwd: testWorkspace,
    });

    assert.notStrictEqual(res.exitCode, 0, "向 /etc 写入必须以非零退出码失败");
    assert.ok(
      res.stderr.includes("Read-only file system") ||
        res.stdout.includes("Read-only file system"),
      "必须产生内核级只读文件系统阻断"
    );
    assert.strictEqual(fsSync.existsSync("/etc/nash-test"), false, "/etc/nash-test 绝对不能被创建");
  });

  // =========================================================================
  // 4. Sandbox network: deny 下执行 curl 严格失败，allow-once 审批放行后成功
  // =========================================================================
  it("CLI E2E 4: network: deny 下 curl 必失败；触发审批 allow-once 临时放行后成功", async (t) => {
    const { SandboxService } = await import("../src/sandbox/sandbox-service.js");
    const { ApprovalService } = await import("../src/approval/approval-service.js");

    let approvalPrompted = false;
    let allowedOnce = false;

    const mockApprovalProvider = {
      async askApproval(req: any) {
        approvalPrompted = true;
        allowedOnce = true;
        return "allow-once" as const;
      },
    };

    const approvalService = new ApprovalService({
      provider: mockApprovalProvider,
    });

    const svc = new SandboxService({
      policy: {
        filesystem: { mode: "workspace-write" },
        network: { mode: "deny" },
        approval: { mode: "ask" },
      },
      approvalService,
      cwd: testWorkspace,
    });

    const server = http.createServer((_req, response) => response.end("APPROVED_NETWORK_OK"));
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
    const port = (server.address() as { port: number }).port;
    const res = await svc.runProcess({
      command: "curl",
      args: ["-s", "--connect-timeout", "5", `http://127.0.0.1:${port}`],
      requiresNetwork: true,
      cwd: testWorkspace,
    });

    // 验证审批流程
    assert.strictEqual(approvalPrompted, true, "network: deny 受到真实阻断后必须触发审批");
    assert.strictEqual(allowedOnce, true, "审批必须返回 allow-once");
    assert.strictEqual(res.exitCode, 0, "放行后受控真实连接成功");
    assert.match(res.stdout, /APPROVED_NETWORK_OK/);
  });
});
