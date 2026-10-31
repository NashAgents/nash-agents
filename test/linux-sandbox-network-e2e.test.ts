import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import http from "node:http";
import path from "node:path";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import { SandboxService } from "../src/sandbox/sandbox-service.js";
import { LinuxBubblewrapBackend } from "../src/sandbox/backends/linux-bubblewrap.js";

describe("Linux Sandbox Network E2E Tests (网络隔离与连通性验证)", { skip: process.platform !== "linux" ? "Requires Linux platform" : false }, () => {
  let workspaceRoot: string;
  let backend: LinuxBubblewrapBackend;
  let mockServer: http.Server;
  let serverPort: number;

  beforeEach(async () => {
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nash-linux-net-"));
    backend = new LinuxBubblewrapBackend();

    // 启动本地 HTTP 监听服务，用于网络测试
    await new Promise<void>((resolve) => {
      mockServer = http.createServer((req, res) => {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("NASH_NETWORK_OK");
      });
      mockServer.listen(0, "127.0.0.1", () => {
        const addr = mockServer.address() as any;
        serverPort = addr.port;
        resolve();
      });
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      mockServer.close(() => resolve());
    });
    if (fsSync.existsSync(workspaceRoot)) {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // 26. deny + curl 失败
  // =========================================================================
  it("26. deny + curl: 在 network: deny 模式下，curl 外部请求被内核网络命名空间隔离阻断", async () => {
    const svc = new SandboxService({
      backend,
      policy: {
        filesystem: { mode: "workspace-write" },
        network: { mode: "deny" },
        approval: { mode: "never" },
      },
      cwd: workspaceRoot,
    });

    const res = await svc.runProcess({
      command: "curl",
      args: ["-s", "--connect-timeout", "2", `http://127.0.0.1:${serverPort}`],
    });

    assert.notStrictEqual(res.exitCode, 0);
  });

  // =========================================================================
  // 27. deny + node fetch 失败
  // =========================================================================
  it("27. deny + node fetch: 在 network: deny 模式下，Node.js fetch 发起 HTTP 连接失败", async () => {
    const svc = new SandboxService({
      backend,
      policy: {
        filesystem: { mode: "workspace-write" },
        network: { mode: "deny" },
        approval: { mode: "never" },
      },
      cwd: workspaceRoot,
    });

    const res = await svc.runProcess({
      command: "node",
      args: [
        "-e",
        `fetch('http://127.0.0.1:${serverPort}').then(() => console.log('FETCH_SUCCESS')).catch(err => { console.error('FETCH_BLOCKED: ' + err.message); process.exit(42); })`,
      ],
    });

    assert.strictEqual(res.exitCode, 42, "fetch 应该被捕获并以退出码 42 结束");
    assert.ok(res.stderr.includes("FETCH_BLOCKED"));
    assert.ok(!res.stdout.includes("FETCH_SUCCESS"));
  });

  // =========================================================================
  // 28. deny + python socket 失败
  // =========================================================================
  it("28. deny + python socket: 在 network: deny 模式下，Python 底层 socket.connect 失败", async () => {
    const svc = new SandboxService({
      backend,
      policy: {
        filesystem: { mode: "workspace-write" },
        network: { mode: "deny" },
        approval: { mode: "never" },
      },
      cwd: workspaceRoot,
    });

    const pythonScript = `
import socket, sys
try:
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(2.0)
    s.connect(('127.0.0.1', ${serverPort}))
    print('SOCKET_SUCCESS')
except Exception as e:
    print('SOCKET_BLOCKED: ' + str(e), file=sys.stderr)
    sys.exit(43)
`;

    const res = await svc.runProcess({
      command: "python3",
      args: ["-c", pythonScript],
    });

    assert.strictEqual(res.exitCode, 43, "Python socket.connect 应该被阻断并以退出码 43 结束");
    assert.ok(res.stderr.includes("SOCKET_BLOCKED"));
    assert.ok(!res.stdout.includes("SOCKET_SUCCESS"));
  });

  // =========================================================================
  // 29. allow + curl 成功
  // =========================================================================
  it("29. allow + curl: 在 network: allow 模式下，curl 能够正常访问网络", async () => {
    const svc = new SandboxService({
      backend,
      policy: {
        filesystem: { mode: "workspace-write" },
        network: { mode: "allow" },
        approval: { mode: "never" },
      },
      cwd: workspaceRoot,
    });

    const res = await svc.runProcess({
      command: "curl",
      args: ["-s", "--connect-timeout", "5", `http://127.0.0.1:${serverPort}`],
    });

    assert.strictEqual(res.exitCode, 0);
    assert.ok(res.stdout.includes("NASH_NETWORK_OK"));
  });

  // =========================================================================
  // 30. allow + node fetch 成功
  // =========================================================================
  it("30. allow + node fetch: 在 network: allow 模式下，Node.js fetch 能正常完成请求", async () => {
    const svc = new SandboxService({
      backend,
      policy: {
        filesystem: { mode: "workspace-write" },
        network: { mode: "allow" },
        approval: { mode: "never" },
      },
      cwd: workspaceRoot,
    });

    const res = await svc.runProcess({
      command: "node",
      args: [
        "-e",
        `fetch('http://127.0.0.1:${serverPort}').then(r => r.text()).then(t => console.log('GOT: ' + t))`,
      ],
    });

    assert.strictEqual(res.exitCode, 0);
    assert.ok(res.stdout.includes("GOT: NASH_NETWORK_OK"));
  });

  // =========================================================================
  // 31. 结构化先验网络能力审批与生命周期
  // =========================================================================
  it("31. 结构化网络审批: 未声明时内核断网且零审批骚扰; 声明 requires_network 主动审批 allow-once 成功且下次恢复", async () => {
    const { createBashTool } = await import("../src/tools/bash.js");
    const { ApprovalService } = await import("../src/approval/approval-service.js");

    let approvalCount = 0;
    let requestedCap = "";

    const approvalService = new ApprovalService({
      async askApproval(req: any) {
        approvalCount++;
        requestedCap = req.capability;
        return "allow-once" as const;
      },
    });

    const svc = new SandboxService({
      backend,
      policy: {
        filesystem: { mode: "workspace-write" },
        network: { mode: "deny" },
        approval: { mode: "ask" },
      },
      approvalService,
      cwd: workspaceRoot,
    });

    const bash = createBashTool(svc);

    // 阶段 1: 盲跑命令（未声明 requires_network）-> 直接失败，退出码非零，零审批触发
    const res1 = await bash.execute({
      command: `curl -s --connect-timeout 2 http://127.0.0.1:${serverPort} || exit 6`,
    });
    assert.strictEqual(approvalCount, 0, "普通未授权命令失败时绝不弹窗骚扰");
    assert.equal((res1 as { success: boolean }).success, false);
    assert.match((res1 as { output: string }).output, /\(退出码: 6\)/);

    // 阶段 2: 显式结构化声明 requires_network: true -> 主动触发审批放行
    const res2 = await bash.execute({
      command: `curl -s --connect-timeout 5 http://127.0.0.1:${serverPort}`,
      requires_network: true,
    });
    assert.strictEqual(approvalCount, 1, "显式声明 requires_network 时必须触发结构化网络审批");
    assert.strictEqual(requestedCap, "network");
    assert.match(String(res2), /NASH_NETWORK_OK/);

    // 阶段 3: 下一次调用未声明网络权限 -> 自动恢复为 deny，再次被阻断
    const res3 = await bash.execute({
      command: `curl -s --connect-timeout 2 http://127.0.0.1:${serverPort} || exit 6`,
    });
    assert.strictEqual(approvalCount, 1, "后续未声明网络权限的调用绝不复用放行状态");
    assert.equal((res3 as { success: boolean }).success, false);
    assert.match((res3 as { output: string }).output, /\(退出码: 6\)/);
  });
});
