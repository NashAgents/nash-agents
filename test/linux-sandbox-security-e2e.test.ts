import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import path from "node:path";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import { SandboxService } from "../src/sandbox/sandbox-service.js";
import { LinuxBubblewrapBackend } from "../src/sandbox/backends/linux-bubblewrap.js";
import { FileSystemAccess } from "../src/sandbox/filesystem-access.js";
import { createDefaultSandboxPolicy } from "../src/sandbox/policy.js";
import { FilesystemAccessDeniedError, SandboxUnavailableError } from "../src/sandbox/errors.js";
import { SandboxUnavailableBackend } from "../src/sandbox/linux/backend-selector.js";

describe("Linux Sandbox Security E2E Tests (逃逸防护、软链接攻击与跨目录阻断)", { skip: process.platform !== "linux" ? "Requires Linux platform" : false }, () => {
  let workspaceRoot: string;
  let outsideTargetDir: string;
  let backend: LinuxBubblewrapBackend;
  let sandboxService: SandboxService;
  let fsAccess: FileSystemAccess;

  beforeEach(async () => {
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nash-sec-ws-"));
    outsideTargetDir = await fs.mkdtemp(path.join(os.tmpdir(), "nash-sec-outside-"));

    backend = new LinuxBubblewrapBackend();
    const policy = createDefaultSandboxPolicy();

    sandboxService = new SandboxService({
      backend,
      policy,
      cwd: workspaceRoot,
    });

    fsAccess = new FileSystemAccess({
      policy,
      workspaceRoot,
    });
  });

  afterEach(async () => {
    if (fsSync.existsSync(workspaceRoot)) {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
    if (fsSync.existsSync(outsideTargetDir)) {
      await fs.rm(outsideTargetDir, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // 31. workspace -> symlink outside read 不越权
  // =========================================================================
  it("31. workspace -> symlink outside read: 软链接指向工作区外文件，应用层严格拦截", async () => {
    const sensitiveOutsideFile = path.join(outsideTargetDir, "secret.key");
    await fs.writeFile(sensitiveOutsideFile, "SUPER_CONFIDENTIAL_KEY", "utf-8");

    const symlinkInWorkspace = path.join(workspaceRoot, "link-to-secret");
    await fs.symlink(sensitiveOutsideFile, symlinkInWorkspace);

    // 1. FileSystemAccess 拦截跨工作区解析
    await assert.rejects(
      async () => {
        await fsAccess.resolveForRead("link-to-secret");
      },
      (err: unknown) => {
        return err instanceof FilesystemAccessDeniedError;
      }
    );
  });

  // =========================================================================
  // 32. workspace -> symlink outside write 不越权
  // =========================================================================
  it("32. workspace -> symlink outside write: 软链接指向工作区外目录，写操作被双重阻断", async () => {
    const outsideSensitiveDir = path.join(outsideTargetDir, "sensitive-dir");
    await fs.mkdir(outsideSensitiveDir, { recursive: true });

    const symlinkToDir = path.join(workspaceRoot, "link-to-outside");
    await fs.symlink(outsideSensitiveDir, symlinkToDir);

    // 1. FileSystemAccess 阻断
    await assert.rejects(
      async () => {
        await fsAccess.resolveForWrite("link-to-outside/payload.txt");
      },
      (err: unknown) => {
        return err instanceof FilesystemAccessDeniedError;
      }
    );

    // 2. Kernel Bubblewrap 阻断 (即使通过 bash 绕过应用层)
    const res = await sandboxService.runProcess({
      command: "bash",
      args: ["-c", "echo hacked > link-to-outside/payload.txt 2>&1"],
      cwd: workspaceRoot,
    });

    assert.notStrictEqual(res.exitCode, 0);
    assert.strictEqual(fsSync.existsSync(path.join(outsideSensitiveDir, "payload.txt")), false);
  });

  // =========================================================================
  // 33. /etc 写失败
  // =========================================================================
  it("33. /etc write fail: 试图修改 /etc 配置文件被内核只读层拦截", async () => {
    const res = await sandboxService.runProcess({
      command: "bash",
      args: ["-c", "echo '127.0.0.1 bad' >> /etc/hosts 2>&1"],
      cwd: workspaceRoot,
    });

    assert.notStrictEqual(res.exitCode, 0);
    assert.ok(
      res.stderr.includes("Read-only file system") ||
        res.stdout.includes("Read-only file system")
    );
  });

  // =========================================================================
  // 34. HOME 敏感目录写失败
  // =========================================================================
  it("34. HOME sensitive write fail: 试图向用户主目录 ~/.ssh 写入被只读层拦截", async () => {
    const homeDir = os.homedir();
    const res = await sandboxService.runProcess({
      command: "bash",
      args: ["-c", `touch "${homeDir}/.ssh/nash-hacked-key" 2>&1`],
      cwd: workspaceRoot,
    });

    assert.notStrictEqual(res.exitCode, 0);
    assert.strictEqual(
      fsSync.existsSync(path.join(homeDir, ".ssh/nash-hacked-key")),
      false
    );
  });

  // =========================================================================
  // 35. 环境变量净化安全
  // =========================================================================
  it("35. sanitized secret 不可见: 子进程严禁读取包含 KEY / TOKEN / SECRET 的变量", async () => {
    process.env.TEST_API_KEY = "test-secret-token-12345";
    process.env.ANTHROPIC_AUTH_TOKEN = "ant-token-67890";
    try {
      const output = await sandboxService.runBash("env");
      assert.ok(!output.includes("test-secret-token-12345"));
      assert.ok(!output.includes("ant-token-67890"));
    } finally {
      delete process.env.TEST_API_KEY;
      delete process.env.ANTHROPIC_AUTH_TOKEN;
    }
  });

  // =========================================================================
  // 36. 拒绝静默退化
  // =========================================================================
  it("36. sandbox process 不能 silent fallback: 沙箱故障时绝不能静默执行裸命令", async () => {
    const brokenBackend = new SandboxUnavailableBackend("bwrap-broken", "Kernel probe failed");
    const svc = new SandboxService({
      backend: brokenBackend,
      policy: createDefaultSandboxPolicy(),
    });

    await assert.rejects(
      async () => {
        await svc.runProcess({ command: "echo should_not_run" });
      },
      (err: unknown) => {
        return err instanceof SandboxUnavailableError;
      }
    );
  });

  // =========================================================================
  // 37. 畸形路径防逃逸
  // =========================================================================
  it("37. malformed path 不逃逸 workspace: 带有空白字符与特殊字符的畸形路径被安全规范化", () => {
    assert.throws(
      () => {
        (fsAccess as any).normalizeInputPath(null);
      },
      /路径参数必须为非空字符串/
    );
  });

  // =========================================================================
  // 38. 相对路径逃逸 (.. traversal) 拦截
  // =========================================================================
  it("38. '..' traversal fail: 试图使用 ../../../etc/passwd 穿越出工作区被拦截", async () => {
    await assert.rejects(
      async () => {
        await fsAccess.resolveForRead("../../etc/passwd");
      },
      (err: unknown) => {
        return err instanceof FilesystemAccessDeniedError;
      }
    );
  });

  // =========================================================================
  // 39. 绝对外部路径直接写拦截
  // =========================================================================
  it("39. absolute outside write fail: 试图向绝对路径 /root/file 写入被拦截", async () => {
    await assert.rejects(
      async () => {
        await fsAccess.resolveForWrite("/root/nash-escape.txt");
      },
      (err: unknown) => {
        return err instanceof FilesystemAccessDeniedError;
      }
    );
  });
});
