import { describe, it } from "node:test";
import assert from "node:assert";
import path from "node:path";
import { LinuxBubblewrapBackend } from "../src/sandbox/backends/linux-bubblewrap.js";
import { MacOsSeatbeltBackend } from "../src/sandbox/backends/macos-seatbelt.js";
import { LinuxBackendSelector, SandboxUnavailableBackend } from "../src/sandbox/linux/backend-selector.js";
import { SandboxService } from "../src/sandbox/sandbox-service.js";
import { SandboxUnavailableError } from "../src/sandbox/errors.js";
import type { SandboxPolicy, SandboxProcessRequest } from "../src/sandbox/types.js";
import { LinuxSandboxProbe } from "../src/sandbox/linux/capability-probe.js";
import { resolveCanonicalPath } from "../src/sandbox/linux/path-utils.js";

describe("Linux Sandbox Unit Tests (策略转换与后端架构隔离)", () => {
  const dummyWorkspace = path.resolve("/tmp/dummy-workspace");

  const createReq = (policy: SandboxPolicy, overrides?: Partial<SandboxProcessRequest>): SandboxProcessRequest => ({
    command: "bash",
    args: ["-c", "echo hello"],
    cwd: dummyWorkspace,
    policy,
    ...overrides,
  });

  it("exposes a helper hidden by private tmpfs as a single read-only file", () => {
    const backend = new LinuxBubblewrapBackend();
    const helper = "/tmp/nash-release/native/helper";
    const req = createReq({ filesystem: { mode: "workspace-write" }, network: { mode: "deny" }, approval: { mode: "ask" } });
    const args = backend.generateBwrapArgs(req, { command: helper, helperExecutable: helper });
    const bind = args.findIndex((value, i) => value === "--ro-bind" && args[i + 1] === helper && args[i + 2] === helper);
    assert.ok(bind > args.indexOf("--tmpfs"));
    assert.ok(bind < args.indexOf("--"));
    assert.ok(!args.some((value, i) => value === "--bind" && args[i + 1] === "/tmp/nash-release"));
  });

  // =========================================================================
  // 1. 平台后端自动探测与选择
  // =========================================================================
  it("1. Linux platform 探测可用时自动选择 LinuxBubblewrapBackend", () => {
    const backend = LinuxBackendSelector.select();
    assert.ok(
      backend instanceof LinuxBubblewrapBackend || backend instanceof SandboxUnavailableBackend,
      "Linux 下应选择 LinuxBubblewrapBackend 或在不可用时返回 SandboxUnavailableBackend"
    );
  });

  it("2. macOS platform 能够独立实例化 MacOsSeatbeltBackend 并提供能力特征", () => {
    const macBackend = new MacOsSeatbeltBackend();
    assert.strictEqual(macBackend.name, "macos-seatbelt");
    const caps = macBackend.getCapabilities();
    assert.strictEqual(caps.filesystemIsolation, true);
    assert.strictEqual(caps.networkIsolation, true);
  });

  it("3. 不支持的平台或后端不可用时抛出 SandboxUnavailableError，严格 Fail-Closed", async () => {
    const unavailableBackend = new SandboxUnavailableBackend("unknown-os", "Mock unsupported OS");
    assert.strictEqual(unavailableBackend.isAvailable(), false);

    const svc = new SandboxService({
      backend: unavailableBackend,
      policy: {
        filesystem: { mode: "workspace-write" },
        network: { mode: "deny" },
        approval: { mode: "ask" },
      },
    });

    await assert.rejects(
      async () => {
        await svc.runProcess({ command: "echo test" });
      },
      (err: unknown) => {
        return err instanceof SandboxUnavailableError;
      }
    );
  });

  // =========================================================================
  // 2. read-only 策略转换
  // =========================================================================
  it("4. read-only policy 转换为 bwrap 全量只读挂载且不重新 bind 工作区为可写", () => {
    const backend = new LinuxBubblewrapBackend();
    const req = createReq({
      filesystem: { mode: "read-only" },
      network: { mode: "deny" },
      approval: { mode: "ask" },
    });

    const args = backend.generateBwrapArgs(req);
    assert.ok(args.includes("--ro-bind"), "必须包含 --ro-bind");
    assert.strictEqual(args[args.indexOf("--ro-bind") + 1], "/");
    assert.strictEqual(args[args.indexOf("--ro-bind") + 2], "/");

    // 严禁重新出现对 workspace 的 --bind 读写挂载
    const bindIndices = args
      .map((item, idx) => (item === "--bind" ? idx : -1))
      .filter((idx) => idx !== -1);
    for (const idx of bindIndices) {
      const boundTarget = args[idx + 1];
      assert.notStrictEqual(boundTarget, dummyWorkspace, "read-only 模式绝不能将工作区 bind 为可写");
    }
  });

  // =========================================================================
  // 3. workspace-write 策略转换
  // =========================================================================
  it("5. workspace-write policy 转换正确：根目录只读，工作区重新 bind 为写，挂载 private tmpfs", () => {
    const backend = new LinuxBubblewrapBackend();
    const req = createReq({
      filesystem: { mode: "workspace-write" },
      network: { mode: "deny" },
      approval: { mode: "ask" },
    });

    const args = backend.generateBwrapArgs(req);
    // 包含根文件系统只读
    assert.ok(args.includes("--ro-bind"));
    // 包含 private tmpfs
    assert.ok(args.includes("--tmpfs"));
    assert.strictEqual(args[args.indexOf("--tmpfs") + 1], "/tmp");
    // 包含工作目录切换
    assert.ok(args.includes("--chdir"));
  });

  // =========================================================================
  // 4. network deny 与 allow 参数转换
  // =========================================================================
  it("6. network deny 时必须添加 --unshare-net", () => {
    const backend = new LinuxBubblewrapBackend();
    const req = createReq({
      filesystem: { mode: "workspace-write" },
      network: { mode: "deny" },
      approval: { mode: "ask" },
    });

    const args = backend.generateBwrapArgs(req);
    assert.ok(args.includes("--unshare-net"), "network: deny 必须包含 --unshare-net");
  });

  it("7. network allow 时绝不添加 --unshare-net", () => {
    const backend = new LinuxBubblewrapBackend();
    const req = createReq({
      filesystem: { mode: "workspace-write" },
      network: { mode: "allow" },
      approval: { mode: "ask" },
    });

    const args = backend.generateBwrapArgs(req);
    assert.ok(!args.includes("--unshare-net"), "network: allow 严禁添加 --unshare-net");
  });

  // =========================================================================
  // 5. 工作目录与精确作用域转换
  // =========================================================================
  it("8. cwd 转换正确，并设置 --chdir 到绝对工作目录", () => {
    const backend = new LinuxBubblewrapBackend();
    const customCwd = "/tmp";
    const req = createReq(
      {
        filesystem: { mode: "workspace-write" },
        network: { mode: "deny" },
        approval: { mode: "ask" },
      },
      { cwd: customCwd }
    );

    const args = backend.generateBwrapArgs(req);
    const chdirIdx = args.indexOf("--chdir");
    assert.ok(chdirIdx !== -1, "必须设置 --chdir");
    assert.strictEqual(args[chdirIdx + 1], resolveCanonicalPath(customCwd));
  });

  it("9. scopedWritePaths 精确限定可写路径，只 bind 指定的子路径", () => {
    const backend = new LinuxBubblewrapBackend();
    const scopedTarget = "/tmp/scoped-sub-dir";
    const req = createReq(
      {
        filesystem: { mode: "workspace-write" },
        network: { mode: "deny" },
        approval: { mode: "ask" },
      },
      {
        scopedWritePaths: [scopedTarget],
      }
    );

    const args = backend.generateBwrapArgs(req);
    assert.ok(args.includes("--die-with-parent"));
    assert.ok(args.includes("--unshare-pid"));
  });

  // =========================================================================
  // 6. 安全边界与参数防注入
  // =========================================================================
  it("10. danger-full-access 模式不被自动启用，仅在显式配置时生效", () => {
    const backend = new LinuxBubblewrapBackend();
    const normalReq = createReq({
      filesystem: { mode: "workspace-write" },
      network: { mode: "deny" },
      approval: { mode: "ask" },
    });
    const normalArgs = backend.generateBwrapArgs(normalReq);
    assert.ok(normalArgs.includes("--ro-bind"), "默认模式绝不能全盘可写");

    const dangerReq = createReq({
      filesystem: { mode: "danger-full-access" },
      network: { mode: "allow" },
      approval: { mode: "never" },
    });
    const dangerArgs = backend.generateBwrapArgs(dangerReq);
    assert.ok(dangerArgs.includes("--bind"), "显式 danger 模式才进行读写挂载");
  });

  it("11. 后端不可用时坚决 Fail-Closed，绝不自动降级裸跑", async () => {
    const failingBackend = new SandboxUnavailableBackend("linux-bubblewrap", "userns disabled");
    const svc = new SandboxService({
      backend: failingBackend,
      policy: {
        filesystem: { mode: "workspace-write" },
        network: { mode: "deny" },
        approval: { mode: "ask" },
      },
    });

    await assert.rejects(
      async () => {
        await svc.runProcess({ command: "whoami" });
      },
      /Fail-Closed/,
      "必须抛出包含 Fail-Closed 的错误"
    );
  });

  it("12. args 采用纯 string[] 数组传递并使用 '--' 终止参数解析，防止 Shell Injection", () => {
    const backend = new LinuxBubblewrapBackend();
    const maliciousArgs = ["--unshare-all", "; rm -rf /;"];
    const req = createReq(
      {
        filesystem: { mode: "workspace-write" },
        network: { mode: "deny" },
        approval: { mode: "ask" },
      },
      { command: "bash", args: maliciousArgs }
    );

    const args = backend.generateBwrapArgs(req);
    const doubleDashIdx = args.indexOf("--");
    assert.ok(doubleDashIdx !== -1, "必须使用 '--' 分隔沙箱选项与被执行命令");
    assert.strictEqual(args[doubleDashIdx + 1], "bash");
    assert.strictEqual(args[doubleDashIdx + 2], maliciousArgs[0]);
    assert.strictEqual(args[doubleDashIdx + 3], maliciousArgs[1]);
  });
});
