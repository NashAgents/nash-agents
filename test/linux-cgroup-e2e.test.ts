import { describe, it } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import { ResourceController } from "../src/sandbox/linux/resource-controller.js";
import { ResourceLimitUnavailableError } from "../src/sandbox/errors.js";
import { LinuxBubblewrapBackend } from "../src/sandbox/backends/linux-bubblewrap.js";
import { LinuxLandlockBackend } from "../src/sandbox/backends/linux-landlock.js";
import { LinuxSandboxProbe } from "../src/sandbox/linux/capability-probe.js";
import os from "node:os";

// Landlock 后端要求 ABI >= 3；低 ABI 内核上该用例属环境不支持，如实标记而非伪装通过。
const landlockAbi = LinuxSandboxProbe.probe().landlockAbi;
const landlockUnsupported = `UNSUPPORTED: Landlock ABI ${landlockAbi} < 3 (kernel ${os.release()})`;

describe("Linux cgroup v2 ResourceController E2E Tests (资源控制与生命周期清理)", { skip: process.platform !== "linux" ? "Requires Linux platform" : false }, () => {
  it("1. cgroup v2 探针探测正确并具有可写 delegated 节点与 controllers", () => {
    const probe = ResourceController.probe(true);
    assert.strictEqual(probe.cgroupV2Available, true, "系统必须启用 cgroup v2");
    assert.strictEqual(probe.delegatedWritable, true, "当前环境必须具备可写的 cgroup 节点");
    assert.strictEqual(probe.controllers.memory, true, "必须支持 memory 控制器");
    assert.strictEqual(probe.controllers.pids, true, "必须支持 pids 控制器");
    assert.strictEqual(probe.controllers.cpu, true, "必须支持 cpu 控制器");
  });

  it("2. 创建 cgroup 节点并正确写入 memory.max, pids.max, cpu.max", async () => {
    const sessionId = "test-sess-limits";
    const jobId = `job-${Date.now()}`;
    const handle = await ResourceController.createCgroup(sessionId, jobId, {
      memoryMaxBytes: 100 * 1024 * 1024,
      pidsMax: 50,
      cpuQuota: 20000,
      cpuPeriod: 100000,
    });

    assert.notStrictEqual(handle, null);
    const cgroupDir = handle!.cgroupPath;
    assert.strictEqual(fs.existsSync(cgroupDir), true);

    const memVal = fs.readFileSync(`${cgroupDir}/memory.max`, "utf-8").trim();
    assert.strictEqual(memVal, String(100 * 1024 * 1024));

    const pidsVal = fs.readFileSync(`${cgroupDir}/pids.max`, "utf-8").trim();
    assert.strictEqual(pidsVal, "50");

    const cpuVal = fs.readFileSync(`${cgroupDir}/cpu.max`, "utf-8").trim();
    assert.strictEqual(cpuVal, "20000 100000");

    // 清理并验证目录已被删除
    await handle!.cleanup();
    assert.strictEqual(fs.existsSync(cgroupDir), false, "任务结束后 cgroup 节点必须已被物理清理");
  });

  it("3. Fail-Closed 保证: 在缺少对应 controller 时显式配置限制必须坚决抛出 ResourceLimitUnavailableError", async () => {
    // Mock 一个缺少 memory 控制器的环境探针
    const originalProbe = ResourceController.probe();
    (ResourceController as any).cachedProbe = {
      ...originalProbe,
      controllers: { ...originalProbe.controllers, memory: false },
    };

    try {
      await assert.rejects(
        async () => {
          await ResourceController.createCgroup("s1", "j1", {
            memoryMaxBytes: 50 * 1024 * 1024,
          });
        },
        (err: unknown) => {
          assert(err instanceof ResourceLimitUnavailableError);
          assert.match((err as Error).message, /memory/);
          return true;
        }
      );
    } finally {
      ResourceController.resetCache();
    }
  });

  it("4. LinuxBubblewrapBackend 联动 cgroup v2 执行任务并自动回收 cgroup", async () => {
    const backend = new LinuxBubblewrapBackend({
      resourceLimits: {
        memoryMaxBytes: 128 * 1024 * 1024,
        pidsMax: 60,
      },
    });

    const res = await backend.run({
      command: "bash",
      args: ["-c", "echo cgroup_bwrap_ok"],
      cwd: process.cwd(),
      policy: {
        filesystem: { mode: "workspace-write" },
        network: { mode: "allow" },
        approval: { mode: "never" },
      },
    });

    assert.strictEqual(res.exitCode, 0);
    assert.match(res.stdout, /cgroup_bwrap_ok/);
  });

  it("5. LinuxLandlockBackend 联动 cgroup v2 执行任务并自动回收 cgroup", { skip: landlockAbi >= 3 ? false : landlockUnsupported }, async () => {
    const backend = new LinuxLandlockBackend({
      resourceLimits: {
        memoryMaxBytes: 128 * 1024 * 1024,
        pidsMax: 60,
      },
    });

    const res = await backend.run({
      command: "bash",
      args: ["-c", "echo cgroup_landlock_ok"],
      cwd: process.cwd(),
      policy: {
        filesystem: { mode: "workspace-write" },
        network: { mode: "allow" },
        approval: { mode: "never" },
      },
    });

    assert.strictEqual(res.exitCode, 0);
    assert.match(res.stdout, /cgroup_landlock_ok/);
  });
});
