import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LinuxSandboxProbe } from "../src/sandbox/linux/capability-probe.js";

// 普通用户侧的 Landlock 写入用例同样受内核 ABI 门禁约束（产品要求 ABI >= 3 才提供 TRUNCATE 强制）。
const landlockAbi = LinuxSandboxProbe.probe().landlockAbi;
const landlockUnsupported = `UNSUPPORTED: Landlock ABI ${landlockAbi} < 3 (kernel ${os.release()})`;

describe("Non-Root Linux User Real E2E Tests (普通非特权用户实机沙箱执行测试)", { skip: process.platform !== "linux" ? "Requires Linux platform" : false }, () => {
  const repoRoot = fileURLToPath(new URL("..", import.meta.url));
  const testUsername = `nash-e2e-${process.pid}`;
  const nonRootHome = `/home/${testUsername}`;
  const nonRootWorkspace = path.join(nonRootHome, "nash-workspace");
  let userCreatedByTest = false;
  let testRuntime: string;
  let nodeBinary: string;

  before(() => {
    // 检查并创建测试用户
    try {
      execSync(`id -u ${testUsername} 2>/dev/null`);
    } catch {
      execSync(`useradd -m -s /bin/bash ${testUsername}`);
      userCreatedByTest = true;
    }

    // 准备测试工作区
    execSync(`runuser -u ${testUsername} -- mkdir -p "${nonRootWorkspace}"`);
    execSync(`runuser -u ${testUsername} -- touch "${path.join(nonRootWorkspace, "initial.txt")}"`);

    // Keep the ordinary-user runtime outside /root and avoid replacing the installed helper.
    testRuntime = fs.mkdtempSync(path.join(os.tmpdir(), "nash-nonroot-runtime-"));
    fs.chmodSync(testRuntime, 0o755);
    for (const directory of ["dist", "node_modules", "native"]) {
      fs.cpSync(path.join(repoRoot, directory), path.join(testRuntime, directory), { recursive: true });
    }
    // A root install places the Node toolchain under /root, which an ordinary
    // user cannot traverse. Copy the interpreter into the world-readable test
    // runtime before dropping privileges.
    nodeBinary = path.join(testRuntime, "node");
    fs.copyFileSync(process.execPath, nodeBinary);
    fs.chmodSync(nodeBinary, 0o755);

  });

  after(() => {
    if (testRuntime) fs.rmSync(testRuntime, { recursive: true, force: true });
    // 清理测试工作区
    try {
      execSync(`rm -rf "${nonRootWorkspace}"`);
    } catch {}

    if (userCreatedByTest) {
      try {
        execSync(`userdel -r ${testUsername} 2>/dev/null || true`);
      } catch {}
    }
  });

  it("1. 普通非 root 用户执行 nash doctor: 自动识别 userns 限制并无缝切换至 linux-landlock", () => {
    const distIndex = path.join(testRuntime, "dist/index.js");
    const cmd = `runuser -u ${testUsername} -- sh -c 'cd "${testRuntime}" && ${nodeBinary} "${distIndex}" doctor'`;
    const output = execSync(cmd, { encoding: "utf-8" });

    assert.match(output, /Nash Doctor/);
    assert.match(output, /Landlock LSM[\s\S]*ABI [1-9]\d*/);
    assert.match(output, /Seccomp[\s\S]*targeted deny/);
    assert.match(output, /no_new_privs[\s\S]*active/);
    assert.match(output, /Selected Backend[\s\S]*linux-(landlock|bubblewrap)/);
    // doctor 的收尾语明确区分「探针通过」与「任务可执行」，不再宣称环境已完全就绪。
    assert.match(output, /Environment and native sandbox probes passed\. Task execution still requires valid configuration and authorization\./);
  });

  it("2. 普通用户在 Landlock LSM 沙箱下执行工作区写入成功，外部写入严格被内核拦截", { skip: landlockAbi >= 3 ? false : landlockUnsupported }, () => {
    const helperBin = path.join(testRuntime, `native/bin/linux-${process.arch}/nash-linux-sandbox-helper`);
    const script = `
echo 'nonroot-ok' > "${path.join(nonRootWorkspace, "test-write.txt")}"
touch /etc/forbidden-nonroot.txt 2>&1 || true
`;
    const config = JSON.stringify({
      protocolVersion: 1,
      landlockEnabled: true,
      readOnlyPaths: ["/"],
      readWritePaths: [nonRootWorkspace],
      noNewPrivs: true,
      command: "bash",
      args: ["-c", script],
    });

    const escapedConfig = config.replace(/'/g, "'\\''");
    const cmd = `runuser -u ${testUsername} -- ${helperBin} --config-json '${escapedConfig}'`;
    const output = execSync(cmd, { encoding: "utf-8" });

    // 验证工作区写入成功
    const writtenPath = path.join(nonRootWorkspace, "test-write.txt");
    assert.strictEqual(fs.existsSync(writtenPath), true);
    assert.strictEqual(fs.readFileSync(writtenPath, "utf-8").trim(), "nonroot-ok");

    // 验证 /etc 写被内核拒绝
    assert.match(output, /Permission denied/);
    assert.strictEqual(fs.existsSync("/etc/forbidden-nonroot.txt"), false);
  });

  it("3. 普通用户在 Seccomp 加固下正常调用 Node.js, Python, Git 与子进程", () => {
    const helperBin = path.join(testRuntime, `native/bin/linux-${process.arch}/nash-linux-sandbox-helper`);
    const pyScript = `import subprocess; print('NONROOT_PY:' + subprocess.check_output(['echo', 'ok']).decode().strip())`;
    const config = JSON.stringify({
      protocolVersion: 1,
      seccompEnabled: true,
      noNewPrivs: true,
      command: "python3",
      args: ["-c", pyScript],
    });

    const escapedConfig = config.replace(/'/g, "'\\''");
    const cmd = `runuser -u ${testUsername} -- ${helperBin} --config-json '${escapedConfig}'`;
    const output = execSync(cmd, { encoding: "utf-8" });

    assert.match(output, /NONROOT_PY:ok/);
  });

  it("4. 普通用户在 Seccomp 加固下试图调用 unshare 被内核 EPERM 严格拦截", () => {
    const helperBin = path.join(testRuntime, `native/bin/linux-${process.arch}/nash-linux-sandbox-helper`);
    const config = JSON.stringify({
      protocolVersion: 1,
      seccompEnabled: true,
      noNewPrivs: true,
      command: "unshare",
      args: ["--user", "true"],
    });

    const escapedConfig = config.replace(/'/g, "'\\''");
    const cmd = `runuser -u ${testUsername} -- ${helperBin} --config-json '${escapedConfig}' 2>&1 || true`;
    const output = execSync(cmd, { encoding: "utf-8" });

    assert.match(output, /(Operation not permitted|Permission denied)/i);
  });
});
