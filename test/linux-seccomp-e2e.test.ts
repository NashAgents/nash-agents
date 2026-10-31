import { describe, it } from "node:test";
import assert from "node:assert";
import { LinuxBubblewrapBackend } from "../src/sandbox/backends/linux-bubblewrap.js";
import { LinuxLandlockBackend } from "../src/sandbox/backends/linux-landlock.js";
import { LinuxSandboxHelperManager } from "../src/sandbox/linux/sandbox-helper.js";

describe("Linux Seccomp Hardening & no_new_privs E2E Tests (系统调用拦截与运行时兼容性)", { skip: process.platform !== "linux" ? "Requires Linux platform" : false }, () => {
  it("1. Native Helper 版本握手与能力探针正常", () => {
    const isAvail = LinuxSandboxHelperManager.isAvailable();
    assert.strictEqual(isAvail, true, "LinuxSandboxHelper 必须可用");

    const info = LinuxSandboxHelperManager.getVersionInfo();
    assert.strictEqual(info?.protocolVersion, 1);
    assert.strictEqual(info?.seccomp, true);
    assert.strictEqual(info?.noNewPrivs, true);
  });

  it("2. Seccomp 拦截 mount 系统调用，返回 EPERM (Operation not permitted)", async () => {
    const backend = new LinuxBubblewrapBackend();
    const res = await backend.run({
      command: "mount",
      args: ["-t", "tmpfs", "none", "/tmp"],
      cwd: process.cwd(),
      policy: {
        filesystem: { mode: "workspace-write" },
        network: { mode: "allow" },
        approval: { mode: "never" },
      },
    });

    assert.notStrictEqual(res.exitCode, 0);
    assert.match(res.stderr + res.stdout, /(permission denied|Operation not permitted)/i);
  });

  it("3. Seccomp 拦截 unshare 系统调用，返回 EPERM (Operation not permitted)", async () => {
    const backend = new LinuxBubblewrapBackend();
    const res = await backend.run({
      command: "unshare",
      args: ["--user", "true"],
      cwd: process.cwd(),
      policy: {
        filesystem: { mode: "workspace-write" },
        network: { mode: "allow" },
        approval: { mode: "never" },
      },
    });

    assert.notStrictEqual(res.exitCode, 0);
    assert.match(res.stderr + res.stdout, /(Operation not permitted|permission denied)/i);
  });

  it("4. no_new_privs 确保子进程不可获取新特权 (验证 /proc/self/status)", async () => {
    const backend = new LinuxBubblewrapBackend();
    const res = await backend.run({
      command: "bash",
      args: ["-c", "grep NoNewPrivs /proc/self/status"],
      cwd: process.cwd(),
      policy: {
        filesystem: { mode: "workspace-write" },
        network: { mode: "allow" },
        approval: { mode: "never" },
      },
    });

    assert.strictEqual(res.exitCode, 0);
    assert.match(res.stdout, /NoNewPrivs:\s*1/);
  });

  it("5. Seccomp 兼容性: Node.js worker_threads 与 child_process 正常工作", async () => {
    const backend = new LinuxBubblewrapBackend();
    const script = `
const { Worker, isMainThread } = require("worker_threads");
const { execSync } = require("child_process");

if (isMainThread) {
  const out = execSync("echo node_subproc_ok").toString().trim();
  const worker = new Worker("console.log('worker_ok:' + (1+1))", { eval: true });
  worker.on("exit", () => {
    console.log(out);
  });
}
`;
    const res = await backend.run({
      command: "node",
      args: ["-e", script],
      cwd: process.cwd(),
      policy: {
        filesystem: { mode: "workspace-write" },
        network: { mode: "allow" },
        approval: { mode: "never" },
      },
    });

    assert.strictEqual(res.exitCode, 0);
    assert.match(res.stdout, /worker_ok:2/);
    assert.match(res.stdout, /node_subproc_ok/);
  });

  it("6. Seccomp 兼容性: Python 解释器与 subprocess 正常工作", async () => {
    const backend = new LinuxBubblewrapBackend();
    const script = `
import subprocess
out = subprocess.check_output(["echo", "python_subproc_ok"]).decode().strip()
print("PY_RESULT:" + out)
`;
    const res = await backend.run({
      command: "python3",
      args: ["-c", script],
      cwd: process.cwd(),
      policy: {
        filesystem: { mode: "workspace-write" },
        network: { mode: "allow" },
        approval: { mode: "never" },
      },
    });

    assert.strictEqual(res.exitCode, 0);
    assert.match(res.stdout, /PY_RESULT:python_subproc_ok/);
  });

  it("7. Seccomp 兼容性: Git 与 npm 基础命令正常执行", async () => {
    const backend = new LinuxBubblewrapBackend();
    const [gitRes, npmRes] = await Promise.all([
      backend.run({
        command: "git",
        args: ["--version"],
        cwd: process.cwd(),
        policy: {
          filesystem: { mode: "workspace-write" },
          network: { mode: "allow" },
          approval: { mode: "never" },
        },
      }),
      backend.run({
        command: "npm",
        args: ["--version"],
        cwd: process.cwd(),
        policy: {
          filesystem: { mode: "workspace-write" },
          network: { mode: "allow" },
          approval: { mode: "never" },
        },
      }),
    ]);

    assert.strictEqual(gitRes.exitCode, 0);
    assert.match(gitRes.stdout, /git version/i);

    assert.strictEqual(npmRes.exitCode, 0);
    assert.match(npmRes.stdout, /\d+\.\d+\.\d+/);
  });
});
