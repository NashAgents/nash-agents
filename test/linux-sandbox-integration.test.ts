import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import path from "node:path";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import { SandboxService } from "../src/sandbox/sandbox-service.js";
import { LinuxBubblewrapBackend } from "../src/sandbox/backends/linux-bubblewrap.js";
import { createDefaultSandboxPolicy } from "../src/sandbox/policy.js";

describe("Linux Sandbox Integration Tests (真实 bwrap 隔离行为)", { skip: process.platform !== "linux" ? "Requires Linux platform" : false }, () => {
  let workspaceRoot: string;
  let sandboxService: SandboxService;
  let backend: LinuxBubblewrapBackend;

  beforeEach(async () => {
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nash-linux-int-"));
    backend = new LinuxBubblewrapBackend();
    sandboxService = new SandboxService({
      backend,
      policy: createDefaultSandboxPolicy(),
      cwd: workspaceRoot,
    });
  });

  afterEach(async () => {
    if (fsSync.existsSync(workspaceRoot)) {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // 13. 工作区文件读取
  // =========================================================================
  it("13. read workspace succeeds: 工作区内已有文件在沙箱内可正常读取", async () => {
    const testFile = path.join(workspaceRoot, "sample.txt");
    await fs.writeFile(testFile, "hello nash linux sandbox", "utf-8");

    const result = await sandboxService.runBash("cat sample.txt");
    assert.ok(result.includes("hello nash linux sandbox"));
  });

  // =========================================================================
  // 14. workspace-write 工作区写入成功
  // =========================================================================
  it("14. write workspace succeeds in workspace-write: 工作区内正常修改与新建文件", async () => {
    await sandboxService.runBash("echo 'created by agent' > agent-output.txt");

    const hostContent = await fs.readFile(
      path.join(workspaceRoot, "agent-output.txt"),
      "utf-8"
    );
    assert.strictEqual(hostContent.trim(), "created by agent");
  });

  // =========================================================================
  // 15. read-only 工作区写失败
  // =========================================================================
  it("15. write workspace fails in read-only: 只读模式下工作区内写操作被内核严格阻断", async () => {
    const readOnlyPolicy = {
      filesystem: { mode: "read-only" as const },
      network: { mode: "deny" as const },
      approval: { mode: "ask" as const },
    };

    const res = await sandboxService.runProcess({
      command: "bash",
      args: ["-c", "echo test > forbidden.txt 2>&1"],
      policy: readOnlyPolicy,
      cwd: workspaceRoot,
    });

    assert.notStrictEqual(res.exitCode, 0);
    assert.ok(
      res.stderr.includes("Read-only file system") ||
        res.stdout.includes("Read-only file system"),
      "必须产生 Read-only file system 阻断报错"
    );
    assert.strictEqual(fsSync.existsSync(path.join(workspaceRoot, "forbidden.txt")), false);
  });

  // =========================================================================
  // 16. 工作区外写失败
  // =========================================================================
  it("16. outside write fails: 试图在 /etc 或宿主根目录写入被内核阻断", async () => {
    const res = await sandboxService.runProcess({
      command: "bash",
      args: ["-c", "touch /etc/nash-malicious-test 2>&1"],
      cwd: workspaceRoot,
    });

    assert.notStrictEqual(res.exitCode, 0);
    assert.ok(
      res.stderr.includes("Read-only file system") ||
        res.stdout.includes("Read-only file system")
    );
    assert.strictEqual(fsSync.existsSync("/etc/nash-malicious-test"), false);
  });

  // =========================================================================
  // 17. 工作区内创建深层子目录成功
  // =========================================================================
  it("17. create directory workspace succeeds: 工作区内可创建深层嵌套目录及文件", async () => {
    await sandboxService.runBash("mkdir -p src/modules/auth && echo 'export const auth = 1;' > src/modules/auth/index.ts");

    const hostFile = path.join(workspaceRoot, "src/modules/auth/index.ts");
    assert.ok(fsSync.existsSync(hostFile));
    const content = await fs.readFile(hostFile, "utf-8");
    assert.ok(content.includes("export const auth = 1;"));
  });

  // =========================================================================
  // 18. /tmp 可写
  // =========================================================================
  it("18. /tmp writable: 沙箱内允许向 /tmp 写入临时数据", async () => {
    const res = await sandboxService.runBash(
      "echo 'temp file' > /tmp/nash-agent-temp.txt && cat /tmp/nash-agent-temp.txt"
    );
    assert.ok(res.includes("temp file"));
  });

  // =========================================================================
  // 19. 宿主 /tmp 不被污染
  // =========================================================================
  it("19. host /tmp 不被普通 sandbox 写污染: private tmpfs 隔离宿主临时目录", async () => {
    const randomName = `nash-private-tmp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.txt`;
    await sandboxService.runBash(`echo 'secret tmp' > /tmp/${randomName}`);

    // 宿主直接查看 /tmp 下该文件是否存在
    const hostTmpFile = path.join("/tmp", randomName);
    assert.strictEqual(
      fsSync.existsSync(hostTmpFile),
      false,
      "宿主 /tmp 严禁出现沙箱内生成的临时文件 (private tmpfs)"
    );
  });

  // =========================================================================
  // 20. cwd 正确
  // =========================================================================
  it("20. cwd 正确: 子进程默认工作目录严格等于请求的 workspace", async () => {
    const res = await sandboxService.runBash("pwd");
    // 解析软链接真实路径比较
    const canonicalWorkspace = fsSync.realpathSync(workspaceRoot);
    assert.ok(res.includes(canonicalWorkspace) || res.includes(workspaceRoot));
  });

  // =========================================================================
  // 21. 环境变量安全清洗 (Secret 不可见)
  // =========================================================================
  it("21. environment sanitization: 宿主敏感变量在沙箱内严格不可见", async () => {
    // 注入宿主敏感环境变量
    process.env.DEEPSEEK_API_KEY = "sk-test-b253dec3faa045827264fcf345";
    process.env.OPENAI_API_KEY = "sk-openai-secret-67890";
    process.env.GITHUB_TOKEN = "ghp_testa77719cf99e8ecab0cken";

    try {
      const envOutput = await sandboxService.runBash("env");
      assert.ok(!envOutput.includes("sk-test-b253dec3faa045827264fcf345"), "DEEPSEEK_API_KEY 绝不能暴露给子进程");
      assert.ok(!envOutput.includes("sk-openai-secret-67890"), "OPENAI_API_KEY 绝不能暴露");
      assert.ok(!envOutput.includes("ghp_testa77719cf99e8ecab0cken"), "GITHUB_TOKEN 绝不能暴露");
      assert.ok(!envOutput.includes("DEEPSEEK_API_KEY="));
    } finally {
      delete process.env.DEEPSEEK_API_KEY;
      delete process.env.OPENAI_API_KEY;
      delete process.env.GITHUB_TOKEN;
    }
  });

  // =========================================================================
  // 22. Node.js 可执行且功能完整
  // =========================================================================
  it("22. Node executable works: 沙箱内 Node.js 运行正常并能执行 JS 代码", async () => {
    const res = await sandboxService.runBash("node -e 'console.log(1 + 2 + 3)'");
    assert.ok(res.includes("6"));
  });

  // =========================================================================
  // 23. Python 可执行且功能完整
  // =========================================================================
  it("23. Python executable works: 沙箱内 Python 运行正常并能执行脚本", async () => {
    const res = await sandboxService.runBash("python3 -c 'print(\"nash-python-\" + str(10 * 10))'");
    assert.ok(res.includes("nash-python-100"));
  });

  // =========================================================================
  // 24. git 只读命令运行正常
  // =========================================================================
  it("24. git read operations work: git 命令在沙箱内可正常输出版本与执行", async () => {
    const res = await sandboxService.runBash("git --version");
    assert.ok(res.includes("git version"));
  });

  // =========================================================================
  // 25. npm 基础命令运行正常
  // =========================================================================
  it("25. npm basic command works: npm 基础命令在沙箱内能正常执行", async () => {
    const res = await sandboxService.runBash("npm --version");
    assert.ok(/^[0-9]+\.[0-9]+\.[0-9]+/.test(res.trim()));
  });
});
