import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { LinuxLandlockBackend } from "../src/sandbox/backends/linux-landlock.js";
import { LinuxBackendSelector } from "../src/sandbox/linux/backend-selector.js";
import { LinuxSandboxProbe } from "../src/sandbox/linux/capability-probe.js";
import { SandboxUnavailableError } from "../src/sandbox/errors.js";

// 产品安全契约：Landlock 至少 ABI 3 才提供文件截断 (TRUNCATE) 的强制能力，
// 低于该版本的内核上后端必须 Fail-Closed。这里按实测 ABI 如实标记 UNSUPPORTED，
// 同时用「门禁」用例验证低 ABI 内核确实被拒绝，避免把不支持伪装成通过。
const probe = LinuxSandboxProbe.probe();
const landlockAbi = probe.landlockAbi;
const landlockSupported = probe.landlockAvailable && landlockAbi >= 3;
const unsupported = probe.landlockAvailable
  ? `UNSUPPORTED: Landlock ABI ${landlockAbi} < 3 (kernel ${os.release()}) — 缺少 TRUNCATE 强制能力，后端按契约 Fail-Closed`
  : `UNSUPPORTED: 内核未启用 Landlock LSM (kernel ${os.release()})`;

describe("Linux Landlock LSM Kernel E2E Tests (内核 LSM 限制与网络阻断验证)", { skip: process.platform !== "linux" ? "Requires Linux platform" : false }, () => {
  let testWorkspace: string;

  before(() => {
    testWorkspace = path.join(os.tmpdir(), `nash-landlock-test-${Date.now()}`);
    fs.mkdirSync(testWorkspace, { recursive: true });
    fs.writeFileSync(path.join(testWorkspace, "file.txt"), "initial content\n");
  });

  after(() => {
    try {
      fs.rmSync(testWorkspace, { recursive: true, force: true });
    } catch {}
  });

  it("0. ABI 门禁: 仅有 ABI >= 3 的内核才报告可用，其余必须 Fail-Closed 拒绝执行", async () => {
    const backend = new LinuxLandlockBackend();
    // 无论内核是否支持，后端报告的可用性都必须与实测能力严格一致，不能虚报。
    assert.strictEqual(backend.isAvailable(), landlockSupported, `实测 ABI ${landlockAbi} / LSM ${probe.landlockAvailable} 与可用性必须一致`);
    if (!landlockSupported) {
      await assert.rejects(
        () => backend.run({
          command: "true", args: [], cwd: os.tmpdir(),
          policy: { filesystem: { mode: "read-only" }, network: { mode: "allow" }, approval: { mode: "never" } },
        }),
        (error: unknown) => error instanceof SandboxUnavailableError,
        "低于 ABI 3 的内核必须抛出 SandboxUnavailableError（Fail-Closed），不得静默降级"
      );
    }
  });

  it("1. Landlock backend 可用性与能力特征检查", { skip: landlockSupported ? false : unsupported }, () => {
    const backend = new LinuxLandlockBackend();
    const isAvail = backend.isAvailable();
    assert.strictEqual(isAvail, true, `在 Landlock ABI >= 3 的内核上 Landlock 必须可用（实测 ABI ${landlockAbi}）`);

    const caps = backend.getCapabilities();
    assert.strictEqual(caps.filesystemIsolation, true);
    assert.strictEqual(caps.networkIsolation, true, "结合 Seccomp socket 过滤提供 networkIsolation");
    assert.strictEqual(caps.syscallFiltering, true);
    assert.strictEqual(caps.noNewPrivileges, true);
  });

  it("2. workspace-write: 工作区内正常修改与新建文件，外部写操作被内核 Landlock 拦截", { skip: landlockSupported ? false : unsupported }, async () => {
    const backend = new LinuxLandlockBackend();
    const req = {
      command: "bash",
      args: [
        "-c",
        `echo 'new-content' > file.txt && echo 'written' && (touch /etc/landlock-forbidden 2>&1 || true)`,
      ],
      cwd: testWorkspace,
      policy: {
        filesystem: { mode: "workspace-write" as const },
        network: { mode: "allow" as const },
        approval: { mode: "never" as const },
      },
    };

    const res = await backend.run(req);
    assert.strictEqual(res.exitCode, 0);
    assert.match(res.stdout, /written/);

    const updated = fs.readFileSync(path.join(testWorkspace, "file.txt"), "utf-8");
    assert.strictEqual(updated.trim(), "new-content");

    // 验证 /etc 写被阻断
    assert.match(res.stdout + res.stderr, /Permission denied/);
    assert.strictEqual(fs.existsSync("/etc/landlock-forbidden"), false);
  });

  it("3. read-only: 工作区自身的所有写操作被内核 Landlock 严格拦截", { skip: landlockSupported ? false : unsupported }, async () => {
    const backend = new LinuxLandlockBackend();
    const req = {
      command: "bash",
      args: ["-c", `echo 'ro-fail' > file.txt`],
      cwd: testWorkspace,
      policy: {
        filesystem: { mode: "read-only" as const },
        network: { mode: "allow" as const },
        approval: { mode: "never" as const },
      },
    };

    const res = await backend.run(req);
    assert.notStrictEqual(res.exitCode, 0, "只读模式下向工作区写入必须退出非零");
    assert.match(res.stderr, /Permission denied/i);
  });

  it("4. scopedWritePaths: 仅白名单子目录允许写入，工作区其它目录被严格阻断", { skip: landlockSupported ? false : unsupported }, async () => {
    const backend = new LinuxLandlockBackend();
    const allowedDir = path.join(testWorkspace, "allowed");
    const blockedDir = path.join(testWorkspace, "blocked");
    fs.mkdirSync(allowedDir, { recursive: true });
    fs.mkdirSync(blockedDir, { recursive: true });

    const req = {
      command: "bash",
      args: [
        "-c",
        `echo 'ok' > allowed/test.txt && (echo 'fail' > blocked/test.txt 2>&1 || true)`,
      ],
      cwd: testWorkspace,
      scopedWritePaths: [allowedDir],
      policy: {
        filesystem: { mode: "workspace-write" as const },
        network: { mode: "allow" as const },
        approval: { mode: "never" as const },
      },
    };

    const res = await backend.run(req);
    assert.strictEqual(res.exitCode, 0);
    assert.strictEqual(fs.existsSync(path.join(allowedDir, "test.txt")), true);
    assert.strictEqual(fs.existsSync(path.join(blockedDir, "test.txt")), false);
  });

  it("5. network: deny: 真实系统调用验证 (socket AF_INET / AF_INET6 均遭 Seccomp 拦截报 EPERM，AF_UNIX 放行)", { skip: landlockSupported ? false : unsupported }, async () => {
    const backend = new LinuxLandlockBackend();

    // 测试 Python 分别创建 AF_UNIX (放行)、AF_INET (拦截且 errno=EPERM) 与 AF_INET6 (拦截且 errno=EPERM)
    const script = `
import socket, errno

# 1. AF_UNIX 本地通信 -> 必须成功
try:
    s_u = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    print("UNIX_OK:True")
    s_u.close()
except Exception as e:
    print("UNIX_FAIL:" + str(e))

# 2. AF_INET IPv4 网络通信 -> 必须返回 EPERM
try:
    s_i = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    print("INET_UNEXPECTED_OK")
    s_i.close()
except OSError as e:
    print("INET_EPERM:" + str(e.errno == errno.EPERM))

# 3. AF_INET6 IPv6 网络通信 -> 必须返回 EPERM
try:
    s_i6 = socket.socket(socket.AF_INET6, socket.SOCK_STREAM)
    print("INET6_UNEXPECTED_OK")
    s_i6.close()
except OSError as e:
    print("INET6_EPERM:" + str(e.errno == errno.EPERM))
`;

    const req = {
      command: "python3",
      args: ["-c", script],
      cwd: testWorkspace,
      policy: {
        filesystem: { mode: "workspace-write" as const },
        network: { mode: "deny" as const },
        approval: { mode: "never" as const },
      },
    };

    const res = await backend.run(req);
    assert.strictEqual(res.exitCode, 0);
    assert.match(res.stdout, /UNIX_OK:True/);
    assert.match(res.stdout, /INET_EPERM:True/);
    assert.match(res.stdout, /INET6_EPERM:True/);
    assert.doesNotMatch(res.stdout, /INET_UNEXPECTED_OK/);
    assert.doesNotMatch(res.stdout, /INET6_UNEXPECTED_OK/);
  });

  it("6. no_new_privs: 子进程在 /proc/self/status 中确认 NoNewPrivs: 1", { skip: landlockSupported ? false : unsupported }, async () => {
    const backend = new LinuxLandlockBackend();
    const req = {
      command: "bash",
      args: ["-c", "grep NoNewPrivs /proc/self/status"],
      cwd: testWorkspace,
      policy: {
        filesystem: { mode: "workspace-write" as const },
        network: { mode: "allow" as const },
        approval: { mode: "never" as const },
      },
    };

    const res = await backend.run(req);
    assert.strictEqual(res.exitCode, 0);
    assert.match(res.stdout, /NoNewPrivs:\s*1/);
  });

  it("7. Fallback Selector: 当强制 Bubblewrap 不可用时，自动优雅降级选择 LinuxLandlockBackend", { skip: landlockSupported ? false : unsupported }, () => {
    // 模拟 Bubblewrap 不可用
    const selected = LinuxBackendSelector.select(
      {
        filesystem: { mode: "workspace-write" },
        network: { mode: "allow" },
        approval: { mode: "never" },
      },
      { forceBackend: "landlock" }
    );

    assert.strictEqual(selected.name, "linux-landlock");
    assert.strictEqual(selected.isAvailable(), true);
  });
});
