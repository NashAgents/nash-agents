import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";

import {
  createDefaultSandboxPolicy,
  cloneSandboxPolicy,
  FileSystemAccess,
  SandboxService,
  MacOsSeatbeltBackend,
  buildSandboxEnvironment,
  SandboxUnavailableError,
  FilesystemAccessDeniedError,
  ApprovalDeniedError,
  type SandboxPolicy,
  type SandboxBackend,
  type SandboxProcessRequest,
  type SandboxProcessResult,
} from "../src/sandbox/index.js";
import {
  ApprovalService,
  type ApprovalProvider,
  type ApprovalRequest,
  type ApprovalDecision,
} from "../src/approval/index.js";
import {
  createReadFileTool,
  createWriteFileTool,
  createEditFileTool,
  createListFilesTool,
  createGrepSearchTool,
  createBashTool,
  createDefaultToolRegistry,
  ToolExecutor,
} from "../src/tools/index.js";

describe("Unified Sandbox & Security Architecture", () => {
  let tempWorkspace: string;
  let outsideDir: string;
  let sharedHttpServer: http.Server;
  let sharedHttpPort: number;

  before(async () => {
    tempWorkspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "ts-agent-sandbox-ws-")
    );
    outsideDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "ts-agent-sandbox-out-")
    );

    await new Promise<void>((resolve) => {
      sharedHttpServer = http.createServer((req, res) => {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("server-network-ok");
      });
      sharedHttpServer.listen(0, "127.0.0.1", () => {
        const addr = sharedHttpServer.address();
        if (addr && typeof addr === "object") {
          sharedHttpPort = addr.port;
        }
        resolve();
      });
    });
  });

  after(async () => {
    await fs.rm(tempWorkspace, { recursive: true, force: true });
    await fs.rm(outsideDir, { recursive: true, force: true });
    await new Promise<void>((resolve) => {
      sharedHttpServer.close(() => resolve());
    });
  });

  // ==========================================
  // 一、Filesystem 维度安全测试 (用例 1 ~ 6)
  // ==========================================
  describe("1. Filesystem Access Control", () => {
    it("1. read-only 可以读取 workspace 内文件", async () => {
      const filePath = path.join(tempWorkspace, "sample.txt");
      await fs.writeFile(filePath, "line 1\nline 2\n", "utf-8");

      const policy: SandboxPolicy = {
        filesystem: { mode: "read-only" },
        network: { mode: "deny" },
        approval: { mode: "never" },
      };
      const fsAccess = new FileSystemAccess({
        workspaceRoot: tempWorkspace,
        policy,
      });
      const readTool = createReadFileTool(fsAccess);

      const output = await readTool.execute({ path: "sample.txt" });
      assert.match(String(output), /line 1/);
      assert.match(String(output), /line 2/);
    });

    it("2. read-only 无法执行 write_file", async () => {
      const policy: SandboxPolicy = {
        filesystem: { mode: "read-only" },
        network: { mode: "deny" },
        approval: { mode: "never" },
      };
      const fsAccess = new FileSystemAccess({
        workspaceRoot: tempWorkspace,
        policy,
      });
      const writeTool = createWriteFileTool(fsAccess);

      await assert.rejects(
        async () => {
          await writeTool.execute({
            path: "forbidden.txt",
            content: "should fail",
          });
        },
        (err: unknown) => {
          assert(err instanceof FilesystemAccessDeniedError);
          assert.equal(err.operation, "write");
          return true;
        }
      );
    });

    it("3. read-only 无法执行 edit_file", async () => {
      const policy: SandboxPolicy = {
        filesystem: { mode: "read-only" },
        network: { mode: "deny" },
        approval: { mode: "never" },
      };
      const fsAccess = new FileSystemAccess({
        workspaceRoot: tempWorkspace,
        policy,
      });
      const editTool = createEditFileTool(fsAccess);

      await assert.rejects(
        async () => {
          await editTool.execute({
            path: "sample.txt",
            old_text: "line 1",
            new_text: "modified line 1",
          });
        },
        (err: unknown) => {
          assert(err instanceof FilesystemAccessDeniedError);
          assert.equal(err.operation, "write");
          return true;
        }
      );
    });

    it("4. workspace-write 可写 workspace 内文件", async () => {
      const policy: SandboxPolicy = {
        filesystem: { mode: "workspace-write" },
        network: { mode: "deny" },
        approval: { mode: "never" },
      };
      const fsAccess = new FileSystemAccess({
        workspaceRoot: tempWorkspace,
        policy,
      });
      const writeTool = createWriteFileTool(fsAccess);

      const result = await writeTool.execute({
        path: "allowed.txt",
        content: "hello workspace",
      });
      assert.match(String(result), /成功写入文件/);

      const written = await fs.readFile(
        path.join(tempWorkspace, "allowed.txt"),
        "utf-8"
      );
      assert.equal(written, "hello workspace");
    });

    it("5. workspace-write 无法写 workspace 外部文件", async () => {
      const policy: SandboxPolicy = {
        filesystem: { mode: "workspace-write" },
        network: { mode: "deny" },
        approval: { mode: "never" },
      };
      const fsAccess = new FileSystemAccess({
        workspaceRoot: tempWorkspace,
        policy,
      });
      const writeTool = createWriteFileTool(fsAccess);

      await assert.rejects(
        async () => {
          await writeTool.execute({
            path: "../escape.txt",
            content: "escape content",
          });
        },
        (err: unknown) => {
          assert(err instanceof FilesystemAccessDeniedError);
          assert.equal(err.operation, "write");
          return true;
        }
      );
    });

    it("6. danger-full-access 能突破 workspace 限制写入外部文件", async () => {
      const targetOutsideFile = path.join(outsideDir, "danger-write.txt");
      const policy: SandboxPolicy = {
        filesystem: { mode: "danger-full-access" },
        network: { mode: "deny" },
        approval: { mode: "never" },
      };
      const fsAccess = new FileSystemAccess({
        workspaceRoot: tempWorkspace,
        policy,
      });
      const writeTool = createWriteFileTool(fsAccess);

      const result = await writeTool.execute({
        path: targetOutsideFile,
        content: "danger content",
      });
      assert.match(String(result), /成功写入文件/);

      const written = await fs.readFile(targetOutsideFile, "utf-8");
      assert.equal(written, "danger content");
    });
  });

  // ==========================================
  // 二、Process 维度沙箱测试 (用例 7 ~ 10)
  // ==========================================
  describe("2. Process Sandbox Enforcement (macOS Seatbelt)", { skip: process.platform !== "darwin" ? "Seatbelt requires macOS" : false }, () => {
    it("7. workspace-write 下 bash 可以修改 workspace 内文件", async () => {
      const policy: SandboxPolicy = {
        filesystem: { mode: "workspace-write" },
        network: { mode: "deny" },
        approval: { mode: "never" },
      };
      const sandboxService = new SandboxService({
        policy,
        cwd: tempWorkspace,
      });

      const output = await sandboxService.runBash(
        'echo "written from bash" > bash-inside.txt && cat bash-inside.txt',
        { cwd: tempWorkspace }
      );
      assert.match(output, /written from bash/);

      const content = await fs.readFile(
        path.join(tempWorkspace, "bash-inside.txt"),
        "utf-8"
      );
      assert.equal(content.trim(), "written from bash");
    });

    it("8. workspace-write 下 bash 无法修改 workspace 外文件", async () => {
      const outsideTarget = path.join(outsideDir, "bash-outside-fail.txt");
      const policy: SandboxPolicy = {
        filesystem: { mode: "workspace-write" },
        network: { mode: "deny" },
        approval: { mode: "never" },
      };
      const sandboxService = new SandboxService({
        policy,
        cwd: tempWorkspace,
      });

      const output = await sandboxService.runBash(
        `echo "should fail" > "${outsideTarget}"`,
        { cwd: tempWorkspace }
      );

      // Seatbelt 会真实阻断并输出 Operation not permitted，退出码为 1
      assert.match(output, /(Operation not permitted|退出码: 1)/);
      assert.equal(fsSync.existsSync(outsideTarget), false);
    });

    it("9. read-only 下 bash 无法修改 workspace 内文件", async () => {
      const policy: SandboxPolicy = {
        filesystem: { mode: "read-only" },
        network: { mode: "deny" },
        approval: { mode: "never" },
      };
      const sandboxService = new SandboxService({
        policy,
        cwd: tempWorkspace,
      });

      const output = await sandboxService.runBash(
        'echo "fail in readonly" > readonly-fail.txt',
        { cwd: tempWorkspace }
      );

      assert.match(output, /(Operation not permitted|退出码: 1)/);
      assert.equal(
        fsSync.existsSync(path.join(tempWorkspace, "readonly-fail.txt")),
        false
      );
    });

    it("10. bash 启动的子进程 (如 Node.js) 仍然受到沙箱安全限制", async () => {
      const outsideChildTarget = path.join(outsideDir, "child-fail.txt");
      const policy: SandboxPolicy = {
        filesystem: { mode: "workspace-write" },
        network: { mode: "deny" },
        approval: { mode: "never" },
      };
      const sandboxService = new SandboxService({
        policy,
        cwd: tempWorkspace,
      });

      const script = `node -e 'require("fs").writeFileSync("${outsideChildTarget}", "fail")'`;
      const output = await sandboxService.runBash(script, {
        cwd: tempWorkspace,
      });

      assert.match(output, /(EPERM|Operation not permitted|退出码: 1)/);
      assert.equal(fsSync.existsSync(outsideChildTarget), false);
    });
  });

  // ==========================================
  // 三、Network 维度安全测试 (用例 11 ~ 12)
  // ==========================================
  describe("3. Network Policy Enforcement (deny & allow)", { skip: process.platform !== "darwin" ? "Seatbelt network enforcement requires macOS" : false }, () => {
    it("11. network=deny 时网络请求被 OS 沙箱阻断失败", async () => {
      const policy: SandboxPolicy = {
        filesystem: { mode: "workspace-write" },
        network: { mode: "deny" },
        approval: { mode: "never" },
      };
      const sandboxService = new SandboxService({
        policy,
        cwd: tempWorkspace,
      });

      // 使用 Node.js 客户端直接连接本地测试服务器端口
      const clientScript = `node -e '
const http = require("http");
const req = http.get("http://127.0.0.1:${sharedHttpPort}", (res) => {
  res.on("data", (d) => process.stdout.write(d));
});
req.on("error", (e) => {
  process.stderr.write("CLIENT_ERROR:" + (e.code || e.message));
  process.exit(1);
});
'`;
      const output = await sandboxService.runBash(clientScript, {
        cwd: tempWorkspace,
      });

      // 应当由于 network* 被阻断而抛出 EPERM，且拿不到服务器返回内容
      assert.match(output, /(CLIENT_ERROR:EPERM|Operation not permitted|退出码: 1)/);
      assert.doesNotMatch(output, /server-network-ok/);
    });

    it("12. network=allow 时网络请求能够成功建立", async () => {
      const policy: SandboxPolicy = {
        filesystem: { mode: "workspace-write" },
        network: { mode: "allow" },
        approval: { mode: "never" },
      };
      const sandboxService = new SandboxService({
        policy,
        cwd: tempWorkspace,
      });

      const clientScript = `node -e '
const http = require("http");
http.get("http://127.0.0.1:${sharedHttpPort}", (res) => {
  res.on("data", (d) => process.stdout.write(d));
});
'`;
      const output = await sandboxService.runBash(clientScript, {
        cwd: tempWorkspace,
      });

      assert.match(output, /server-network-ok/);
      assert.doesNotMatch(output, /退出码/);
    });
  });

  // ==========================================
  // 四、Approval 机制测试 (用例 13 ~ 17)
  // ==========================================
  describe("4. Approval & Escalation Lifecycle", () => {
    it("13. workspace 外访问被拒后触发 approval 提示", async () => {
      let asked = false;
      let requestedCapability = "";

      const mockProvider: ApprovalProvider = {
        async askApproval(req: ApprovalRequest): Promise<ApprovalDecision> {
          asked = true;
          requestedCapability = req.capability;
          return "deny";
        },
      };

      const approvalService = new ApprovalService(mockProvider);
      const policy = createDefaultSandboxPolicy(); // approval: ask
      const fsAccess = new FileSystemAccess({
        workspaceRoot: tempWorkspace,
        policy,
        approvalService,
      });
      const writeTool = createWriteFileTool(fsAccess);

      await assert.rejects(
        async () => {
          await writeTool.execute({
            path: "../outside-file.txt",
            content: "data",
          });
        },
        (err: unknown) => {
          assert(err instanceof ApprovalDeniedError);
          return true;
        }
      );

      assert.equal(asked, true);
      assert.equal(requestedCapability, "filesystem-outside-workspace");
    });

    it("14. 用户 allow-once 后当前操作成功", async () => {
      const outsideFile = path.join(outsideDir, "allow-once-test.txt");

      const mockProvider: ApprovalProvider = {
        async askApproval(): Promise<ApprovalDecision> {
          return "allow-once";
        },
      };

      const approvalService = new ApprovalService(mockProvider);
      const policy = createDefaultSandboxPolicy();
      const fsAccess = new FileSystemAccess({
        workspaceRoot: tempWorkspace,
        policy,
        approvalService,
      });
      const writeTool = createWriteFileTool(fsAccess);

      const result = await writeTool.execute({
        path: outsideFile,
        content: "approved once data",
      });

      assert.match(String(result), /成功写入文件/);
      const content = await fs.readFile(outsideFile, "utf-8");
      assert.equal(content, "approved once data");
    });

    it("15. 下一次相同操作仍需要重新 approval (不会全局永久放行)", async () => {
      let approvalCount = 0;
      const outsideFile = path.join(outsideDir, "allow-once-repeat.txt");

      const mockProvider: ApprovalProvider = {
        async askApproval(): Promise<ApprovalDecision> {
          approvalCount++;
          return "allow-once";
        },
      };

      const approvalService = new ApprovalService(mockProvider);
      const policy = createDefaultSandboxPolicy();
      const fsAccess = new FileSystemAccess({
        workspaceRoot: tempWorkspace,
        policy,
        approvalService,
      });
      const writeTool = createWriteFileTool(fsAccess);

      // 第一次调用
      await writeTool.execute({ path: outsideFile, content: "first" });
      assert.equal(approvalCount, 1);

      // 第二次调用相同路径，必须再次审批！
      await writeTool.execute({ path: outsideFile, content: "second" });
      assert.equal(approvalCount, 2);
    });

    it("16. 用户 deny 后不执行任何写操作", async () => {
      const outsideFile = path.join(outsideDir, "deny-test.txt");

      const mockProvider: ApprovalProvider = {
        async askApproval(): Promise<ApprovalDecision> {
          return "deny";
        },
      };

      const approvalService = new ApprovalService(mockProvider);
      const policy = createDefaultSandboxPolicy();
      const fsAccess = new FileSystemAccess({
        workspaceRoot: tempWorkspace,
        policy,
        approvalService,
      });
      const writeTool = createWriteFileTool(fsAccess);

      await assert.rejects(
        async () => {
          await writeTool.execute({
            path: outsideFile,
            content: "deny content",
          });
        },
        (err: unknown) => {
          assert(err instanceof ApprovalDeniedError);
          return true;
        }
      );

      assert.equal(fsSync.existsSync(outsideFile), false);
    });

    it("17. approval=never 时绝不向用户询问，直接抛出安全异常", async () => {
      let asked = false;
      const mockProvider: ApprovalProvider = {
        async askApproval(): Promise<ApprovalDecision> {
          asked = true;
          return "allow-once";
        },
      };

      const approvalService = new ApprovalService(mockProvider);
      const policy: SandboxPolicy = {
        filesystem: { mode: "workspace-write" },
        network: { mode: "deny" },
        approval: { mode: "never" },
      };
      const fsAccess = new FileSystemAccess({
        workspaceRoot: tempWorkspace,
        policy,
        approvalService,
      });
      const writeTool = createWriteFileTool(fsAccess);

      await assert.rejects(
        async () => {
          await writeTool.execute({
            path: "../never-ask.txt",
            content: "data",
          });
        },
        (err: unknown) => {
          assert(err instanceof FilesystemAccessDeniedError);
          return true;
        }
      );

      assert.equal(asked, false);
    });

    it("17b. 网络访问被阻断后触发 network approval，用户允许后单次重试成功", { skip: process.platform !== "darwin" ? "Requires macOS Seatbelt socket blocking" : false }, async () => {
      let asked = false;
      let requestedCapability = "";

      const mockProvider: ApprovalProvider = {
        async askApproval(req: ApprovalRequest): Promise<ApprovalDecision> {
          asked = true;
          requestedCapability = req.capability;
          return "allow-once"; // 允许单次放行网络
        },
      };

      const approvalService = new ApprovalService(mockProvider);
      const policy = createDefaultSandboxPolicy(); // network: deny, approval: ask
      const sandboxService = new SandboxService({
        policy,
        approvalService,
        cwd: tempWorkspace,
      });

      const clientScript = `node -e '
const http = require("http");
http.get("http://127.0.0.1:${sharedHttpPort}", (res) => {
  res.on("data", (d) => process.stdout.write(d));
});
'`;

      const output = await sandboxService.runBash(clientScript, {
        cwd: tempWorkspace,
      });

      assert.equal(asked, true);
      assert.equal(requestedCapability, "network");
      assert.match(output, /server-network-ok/);
    });

    it("17c. 网络访问被阻断后触发 network approval，用户拒绝后不重试", { skip: process.platform !== "darwin" ? "Requires macOS Seatbelt socket blocking" : false }, async () => {
      let asked = false;

      const mockProvider: ApprovalProvider = {
        async askApproval(): Promise<ApprovalDecision> {
          asked = true;
          return "deny"; // 用户拒绝放行
        },
      };

      const approvalService = new ApprovalService(mockProvider);
      const policy = createDefaultSandboxPolicy();
      const sandboxService = new SandboxService({
        policy,
        approvalService,
        cwd: tempWorkspace,
      });

      const clientScript = `node -e '
const http = require("http");
http.get("http://127.0.0.1:${sharedHttpPort}", (res) => {
  res.on("data", (d) => process.stdout.write(d));
}).on("error", (e) => {
  process.stderr.write("NET_ERR:" + (e.code || e.message));
  process.exit(1);
});
'`;

      const output = await sandboxService.runBash(clientScript, {
        cwd: tempWorkspace,
      });

      assert.equal(asked, true);
      assert.match(output, /(NET_ERR:EPERM|Operation not permitted|退出码: 1)/);
      assert.doesNotMatch(output, /server-network-ok/);
    });
  });

  // ==========================================
  // 五、Environment 环境变量隔离测试 (用例 18 ~ 19)
  // ==========================================
  describe("5. Environment Isolation", () => {
    it("18. bash 中不能直接读取 DEEPSEEK_API_KEY 等敏感私密凭据", async () => {
      const originalKey = process.env.DEEPSEEK_API_KEY;
      process.env.DEEPSEEK_API_KEY = "sk-test-22a78359a707cfe7b4dken";

      try {
        const policy = createDefaultSandboxPolicy();
        const sandboxService = new SandboxService({
          policy,
          cwd: tempWorkspace,
        });

        const output = await sandboxService.runBash(
          'echo "KEY_VALUE:$DEEPSEEK_API_KEY"',
          { cwd: tempWorkspace }
        );

        assert.equal(output.trim(), "KEY_VALUE:");
      } finally {
        if (originalKey === undefined) {
          delete process.env.DEEPSEEK_API_KEY;
        } else {
          process.env.DEEPSEEK_API_KEY = originalKey;
        }
      }
    });

    it("19. PATH、HOME 等基础运行环境变量仍可正常使用", async () => {
      const sanitized = buildSandboxEnvironment();
      assert.ok(sanitized.PATH, "PATH 应该存在");
      assert.ok(sanitized.HOME, "HOME 应该存在");
      assert.equal(sanitized.DEEPSEEK_API_KEY, undefined);

      const policy = createDefaultSandboxPolicy();
      const sandboxService = new SandboxService({
        policy,
        cwd: tempWorkspace,
      });

      const output = await sandboxService.runBash("which echo && echo $SHELL", {
        cwd: tempWorkspace,
      });
      assert.match(output, /echo/);
    });
  });

  // ==========================================
  // 六、Fail Closed 铁律测试 (用例 20 ~ 21)
  // ==========================================
  describe("6. Fail Closed Enforcement", () => {
    it("20. 模拟 Seatbelt backend 不存在时抛出 SandboxUnavailableError", async () => {
      const unavailableBackend: SandboxBackend = {
        name: "mock-unavailable",
        isAvailable: () => false,
        run: async () => {
          throw new Error("Should not be called");
        },
      };

      const policy = createDefaultSandboxPolicy();
      const sandboxService = new SandboxService({
        backend: unavailableBackend,
        policy,
        cwd: tempWorkspace,
      });

      await assert.rejects(
        async () => {
          await sandboxService.runProcess({
            command: "bash",
            args: ["-lc", "echo test"],
          });
        },
        (err: unknown) => {
          assert(err instanceof SandboxUnavailableError);
          return true;
        }
      );
    });

    it("21. 确认绝不会静默 fallback 到裸 bash 执行", async () => {
      let executedBareProcess = false;

      const unavailableBackend: SandboxBackend = {
        name: "mock-unavailable",
        isAvailable: () => false,
        run: async () => {
          executedBareProcess = true;
          return { stdout: "", stderr: "", exitCode: 0 };
        },
      };

      const policy: SandboxPolicy = {
        filesystem: { mode: "workspace-write" },
        network: { mode: "deny" },
        approval: { mode: "never" },
      };

      const sandboxService = new SandboxService({
        backend: unavailableBackend,
        policy,
        cwd: tempWorkspace,
      });

      const bashTool = createBashTool(sandboxService);

      await assert.rejects(
        async () => {
          await bashTool.execute({ command: "echo 'danger bare process'" });
        },
        (err: unknown) => {
          assert(err instanceof SandboxUnavailableError);
          return true;
        }
      );

      assert.equal(executedBareProcess, false);
    });
  });

  // ==========================================
  // 七、真实 E2E 全链路场景测试 (E2E 测试 1 ~ 6)
  // ==========================================
  describe("7. Real End-to-End Scenarios", () => {
    it("E2E 测试 1: Agent 在 workspace 中创建文件 -> 期望成功", async () => {
      const policy = createDefaultSandboxPolicy();
      const fsAccess = new FileSystemAccess({
        workspaceRoot: tempWorkspace,
        policy,
      });
      const sandboxService = new SandboxService({
        policy,
        cwd: tempWorkspace,
      });
      const registry = createDefaultToolRegistry({
        fsAccess,
        sandboxService,
      });
      const executor = new ToolExecutor(registry);

      const res = await executor.execute("write_file", {
        path: "e2e-target.txt",
        content: "e2e test content",
      });

      assert.equal(res.success, true);
      assert.match(res.output, /成功写入文件/);

      const created = await fs.readFile(
        path.join(tempWorkspace, "e2e-target.txt"),
        "utf-8"
      );
      assert.equal(created, "e2e-test content".replace("-", " "));
    });

    it("E2E 测试 2: 尝试创建 ../outside.txt -> 拒绝 approval，确认文件不存在", async () => {
      const targetOutside = path.join(tempWorkspace, "..", "outside-e2e.txt");
      // 确保测试前文件不存在
      if (fsSync.existsSync(targetOutside)) {
        fsSync.unlinkSync(targetOutside);
      }

      const mockProvider: ApprovalProvider = {
        async askApproval(): Promise<ApprovalDecision> {
          return "deny"; // 拒绝 approval
        },
      };
      const approvalService = new ApprovalService(mockProvider);

      const policy = createDefaultSandboxPolicy();
      const fsAccess = new FileSystemAccess({
        workspaceRoot: tempWorkspace,
        policy,
        approvalService,
      });
      const sandboxService = new SandboxService({
        policy,
        approvalService,
        cwd: tempWorkspace,
      });
      const registry = createDefaultToolRegistry({
        fsAccess,
        sandboxService,
      });
      const executor = new ToolExecutor(registry);

      const res = await executor.execute("write_file", {
        path: "../outside-e2e.txt",
        content: "forbidden data",
      });

      assert.equal(res.success, false);
      assert.match(res.output, /拒绝/);
      assert.equal(fsSync.existsSync(targetOutside), false);
    });

    it("E2E 测试 3: 再次执行相同操作 -> 允许一次，确认放行成功创建", async () => {
      const targetOutside = path.join(tempWorkspace, "..", "outside-e2e.txt");

      const mockProvider: ApprovalProvider = {
        async askApproval(): Promise<ApprovalDecision> {
          return "allow-once"; // 允许一次
        },
      };
      const approvalService = new ApprovalService(mockProvider);

      const policy = createDefaultSandboxPolicy();
      const fsAccess = new FileSystemAccess({
        workspaceRoot: tempWorkspace,
        policy,
        approvalService,
      });
      const sandboxService = new SandboxService({
        policy,
        approvalService,
        cwd: tempWorkspace,
      });
      const registry = createDefaultToolRegistry({
        fsAccess,
        sandboxService,
      });
      const executor = new ToolExecutor(registry);

      const res = await executor.execute("write_file", {
        path: "../outside-e2e.txt",
        content: "allowed once content",
      });

      assert.equal(res.success, true);
      assert.match(res.output, /成功写入文件/);
      assert.equal(fsSync.existsSync(targetOutside), true);

      // 清理
      fsSync.unlinkSync(targetOutside);
    });

    it("E2E 测试 4: 默认 network=deny 下 bash 执行网络请求 -> 确认 OS sandbox 真正阻断", { skip: process.platform !== "darwin" ? "Requires macOS Seatbelt" : false }, async () => {
      const policy = createDefaultSandboxPolicy();
      const sandboxService = new SandboxService({
        policy,
        cwd: tempWorkspace,
      });
      const registry = createDefaultToolRegistry({
        sandboxService,
      });
      const executor = new ToolExecutor(registry);

      const command = `node -e '
const http = require("http");
http.get("http://127.0.0.1:${sharedHttpPort}", (res) => {
  res.on("data", (d) => process.stdout.write(d));
}).on("error", (e) => {
  process.stderr.write("DENIED:" + (e.code || e.message));
  process.exit(1);
});
'`;

      const res = await executor.execute("bash", { command });

      // 结果应该报告阻断信息
      assert.match(res.output, /(DENIED:EPERM|Operation not permitted|退出码: 1)/);
      assert.doesNotMatch(res.output, /server-network-ok/);
    });

    it("E2E 测试 5: 临时 network=allow -> 确认网络约束解除", { skip: process.platform !== "darwin" ? "Requires macOS Seatbelt" : false }, async () => {
      const policy = createDefaultSandboxPolicy();
      policy.network.mode = "allow"; // 临时放行网络

      const sandboxService = new SandboxService({
        policy,
        cwd: tempWorkspace,
      });
      const registry = createDefaultToolRegistry({
        sandboxService,
      });
      const executor = new ToolExecutor(registry);

      const command = `node -e '
const http = require("http");
http.get("http://127.0.0.1:${sharedHttpPort}", (res) => {
  res.on("data", (d) => process.stdout.write(d));
});
'`;

      const res = await executor.execute("bash", { command });
      assert.equal(res.success, true);
      assert.match(res.output, /server-network-ok/);
    });

    it("E2E 测试 6: bash 中 echo $DEEPSEEK_API_KEY -> 确认 Harness API Key 没有泄漏", async () => {
      const originalKey = process.env.DEEPSEEK_API_KEY;
      process.env.DEEPSEEK_API_KEY = "secret-deepseek-key-123456789";

      try {
        const policy = createDefaultSandboxPolicy();
        const sandboxService = new SandboxService({
          policy,
          cwd: tempWorkspace,
        });
        const registry = createDefaultToolRegistry({
          sandboxService,
        });
        const executor = new ToolExecutor(registry);

        const res = await executor.execute("bash", {
          command: 'echo "LEAK_CHECK:$DEEPSEEK_API_KEY"',
        });

        assert.equal(res.success, true);
        assert.equal(res.output.trim(), "LEAK_CHECK:");
        assert.doesNotMatch(res.output, /secret-deepseek-key/);
      } finally {
        if (originalKey === undefined) {
          delete process.env.DEEPSEEK_API_KEY;
        } else {
          process.env.DEEPSEEK_API_KEY = originalKey;
        }
      }
    });
  });

  // ==========================================
  // 八、Settings 配置加载测试
  // ==========================================
  describe("8. Settings Configuration", () => {
    it("正确解析 settings.json 中的 full 预设", async () => {
      const { loadSandboxPolicyFromSettings } = await import(
        "../src/config/settings.js"
      );
      const testSettingsPath = path.join(tempWorkspace, "custom-settings.json");
      await fs.writeFile(
        testSettingsPath,
        JSON.stringify({
          sandbox: {
            preset: "full",
          },
        }),
        "utf-8"
      );

      const policy = loadSandboxPolicyFromSettings(testSettingsPath);
      assert.equal(policy.filesystem.mode, "danger-full-access");
      assert.equal(policy.network.mode, "allow");
      // full 预设的产品契约：放开逐次打断，而不是放开确定性安全边界。
      assert.equal(policy.approval.mode, "auto-grant");

      // 该预设不得削弱确定性硬拦截：即使审查模型被关闭，硬拦截仍然拒绝执行。
      const { PreToolSecurityMonitor } = await import("../src/security/security-monitor.js");
      const monitor = new PreToolSecurityMonitor({ enabled: false });
      const decision = await monitor.evaluateToolCall({
        toolName: "bash",
        toolArgs: { command: "rm -rf / --no-preserve-root" },
        rawArgs: JSON.stringify({ command: "rm -rf / --no-preserve-root" }),
        argsFingerprint: "fp-full-preset-hard-block",
        agentIdentity: { agentId: "main" },
        userAuthorizationContext: { userIntent: "test" },
      });
      assert.equal(decision.verdict, "BLOCK");
      assert.equal(decision.isHardBlock, true);
    });

    it("正确解析细粒度覆盖配置", async () => {
      const { loadSandboxPolicyFromSettings } = await import(
        "../src/config/settings.js"
      );
      const testSettingsPath = path.join(tempWorkspace, "override-settings.json");
      await fs.writeFile(
        testSettingsPath,
        JSON.stringify({
          sandbox: {
            filesystem: "read-only",
            network: "allow",
            approval: "ask",
          },
        }),
        "utf-8"
      );

      const policy = loadSandboxPolicyFromSettings(testSettingsPath);
      assert.equal(policy.filesystem.mode, "read-only");
      assert.equal(policy.network.mode, "allow");
      assert.equal(policy.approval.mode, "ask");
    });
  });
});
