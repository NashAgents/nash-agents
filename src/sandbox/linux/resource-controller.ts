import fs from "node:fs";
import path from "node:path";
import { ResourceLimitUnavailableError } from "../errors.js";

export interface ResourceLimits {
  /**
   * 内存硬上限（字节）
   */
  memoryMaxBytes?: number;

  /**
   * 最大进程/线程数 (PID 限制，防 fork-bomb)
   */
  pidsMax?: number;

  /**
   * CPU 配额微秒数 (相对于 cpuPeriod)
   */
  cpuQuota?: number;

  /**
   * CPU 周期微秒数 (默认 100,000 即 100ms)
   */
  cpuPeriod?: number;
}

export interface CgroupProbeResult {
  cgroupV2Available: boolean;
  delegatedWritable: boolean;
  baseCgroupPath?: string;
  controllers: {
    memory: boolean;
    pids: boolean;
    cpu: boolean;
  };
  hasCgroupKill: boolean;
}

export interface CgroupHandle {
  cgroupPath: string;
  addProcess(pid: number): Promise<void>;
  kill(): Promise<void>;
  cleanup(): Promise<void>;
}

/**
 * Linux cgroup v2 资源控制器 (ResourceController)
 *
 * 核心设计目标：
 * 1. 独立于沙箱后端的资源约束组件 (CPU, Memory, PIDs)；
 * 2. 严格践行 Fail-Closed 铁律：当调用方配置了资源限制而宿主环境不支持时坚决抛出 ResourceLimitUnavailableError；
 * 3. 支持 root 及普通用户 delegated cgroup；
 * 4. 具备确定性的 cgroup.kill 与目录物理清理生命周期，绝不泄漏脏 cgroup 节点。
 */
export class ResourceController {
  private static cachedProbe?: CgroupProbeResult;

  /**
   * 探测当前系统 cgroup v2 与控制器的支持情况
   */
  static probe(force = false): CgroupProbeResult {
    if (this.cachedProbe && !force) {
      return this.cachedProbe;
    }

    if (process.platform !== "linux") {
      const result: CgroupProbeResult = {
        cgroupV2Available: false,
        delegatedWritable: false,
        controllers: { memory: false, pids: false, cpu: false },
        hasCgroupKill: false,
      };
      this.cachedProbe = result;
      return result;
    }

    const cgroupMount = "/sys/fs/cgroup";
    const controllersFile = path.join(cgroupMount, "cgroup.controllers");

    if (!fs.existsSync(controllersFile)) {
      const result: CgroupProbeResult = {
        cgroupV2Available: false,
        delegatedWritable: false,
        controllers: { memory: false, pids: false, cpu: false },
        hasCgroupKill: false,
      };
      this.cachedProbe = result;
      return result;
    }

    let controllersStr = "";
    try {
      controllersStr = fs.readFileSync(controllersFile, "utf-8");
    } catch {
      controllersStr = "";
    }

    const controllers = {
      memory: controllersStr.includes("memory"),
      pids: controllersStr.includes("pids"),
      cpu: controllersStr.includes("cpu"),
    };

    // 寻找可写的 base cgroup
    let baseCgroupPath: string | undefined;
    let delegatedWritable = false;

    // 1. 优先尝试系统根 cgroup
    try {
      const testDir = path.join(cgroupMount, `.nash-probe-${process.pid}`);
      fs.mkdirSync(testDir);
      fs.rmdirSync(testDir);
      baseCgroupPath = cgroupMount;
      delegatedWritable = true;
    } catch {
      // 2. 尝试从 /proc/self/cgroup 获取自身所属 delegated slice
      try {
        const selfCgroup = fs.readFileSync("/proc/self/cgroup", "utf-8");
        for (const line of selfCgroup.split("\n")) {
          const parts = line.split(":");
          if (parts.length >= 3 && parts[1] === "") {
            const relPath = parts.slice(2).join(":").trim();
            const candPath = path.join(cgroupMount, relPath);
            if (fs.existsSync(candPath)) {
              const testDir = path.join(candPath, `.nash-probe-${process.pid}`);
              fs.mkdirSync(testDir);
              fs.rmdirSync(testDir);
              baseCgroupPath = candPath;
              delegatedWritable = true;
              break;
            }
          }
        }
      } catch {}
    }

    const hasCgroupKill = fs.existsSync(path.join(cgroupMount, "cgroup.kill"));

    const result: CgroupProbeResult = {
      cgroupV2Available: true,
      delegatedWritable,
      baseCgroupPath,
      controllers,
      hasCgroupKill,
    };

    this.cachedProbe = result;
    return result;
  }

  /**
   * 为指定的任务创建独立的 cgroup 并写入资源限制
   */
  static async createCgroup(sessionId: string, jobId: string, limits?: ResourceLimits): Promise<CgroupHandle | null> {
    return this.createCgroupSync(sessionId, jobId, limits);
  }

  static createCgroupSync(
    sessionId: string,
    jobId: string,
    limits?: ResourceLimits
  ): CgroupHandle | null {
    const hasAnyLimit =
      limits &&
      (limits.memoryMaxBytes !== undefined ||
        limits.pidsMax !== undefined ||
        limits.cpuQuota !== undefined);

    const probe = this.probe();

    // Fail-Closed 检查：如果用户显式请求了限制，但环境不支持，坚决报错
    if (hasAnyLimit) {
      if (!probe.cgroupV2Available) {
        throw new ResourceLimitUnavailableError(
          "配置了资源限制，但系统未启用 cgroup v2 (Fail-Closed)。"
        );
      }
      if (!probe.delegatedWritable || !probe.baseCgroupPath) {
        throw new ResourceLimitUnavailableError(
          "配置了资源限制，但当前运行用户无权在 cgroup v2 中创建控制组 (Fail-Closed)。"
        );
      }
      if (limits.memoryMaxBytes !== undefined && !probe.controllers.memory) {
        throw new ResourceLimitUnavailableError(
          "配置了 memoryMaxBytes，但 cgroup v2 中缺少 'memory' 控制器 (Fail-Closed)。"
        );
      }
      if (limits.pidsMax !== undefined && !probe.controllers.pids) {
        throw new ResourceLimitUnavailableError(
          "配置了 pidsMax，但 cgroup v2 中缺少 'pids' 控制器 (Fail-Closed)。"
        );
      }
      if (limits.cpuQuota !== undefined && !probe.controllers.cpu) {
        throw new ResourceLimitUnavailableError(
          "配置了 cpuQuota，但 cgroup v2 中缺少 'cpu' 控制器 (Fail-Closed)。"
        );
      }
    }

    // 若未配置任何限制且环境不可用，安全返回 null
    if (!hasAnyLimit || !probe.delegatedWritable || !probe.baseCgroupPath) {
      return null;
    }

    const safeSession = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
    const safeJob = jobId.replace(/[^a-zA-Z0-9_-]/g, "_");
    const targetCgroupPath = path.join(probe.baseCgroupPath, "nash", safeSession, safeJob);

    // 确保父目录并启用 subtree_control
    const nashBase = path.join(probe.baseCgroupPath, "nash");
    const sessionBase = path.join(nashBase, safeSession);

    const enableSubtree = (dir: string) => {
      const subtreeFile = path.join(dir, "cgroup.subtree_control");
      if (fs.existsSync(subtreeFile)) {
        try {
          fs.writeFileSync(subtreeFile, "+memory +pids +cpu");
        } catch {}
      }
    };

    try {
      enableSubtree(probe.baseCgroupPath);
      if (!fs.existsSync(nashBase)) {
        fs.mkdirSync(nashBase, { recursive: true });
      }
      enableSubtree(nashBase);

      if (!fs.existsSync(sessionBase)) {
        fs.mkdirSync(sessionBase, { recursive: true });
      }
      enableSubtree(sessionBase);

      if (!fs.existsSync(targetCgroupPath)) {
        fs.mkdirSync(targetCgroupPath, { recursive: true });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new ResourceLimitUnavailableError(`创建 cgroup 节点失败: ${msg}`);
    }

    // 写入资源限制项
    try {
      if (limits.memoryMaxBytes !== undefined) {
        fs.writeFileSync(
          path.join(targetCgroupPath, "memory.max"),
          String(limits.memoryMaxBytes)
        );
        const oomGroupPath = path.join(targetCgroupPath, "memory.oom.group");
        if (fs.existsSync(oomGroupPath)) {
          fs.writeFileSync(oomGroupPath, "1");
        }
      }

      if (limits.pidsMax !== undefined) {
        fs.writeFileSync(
          path.join(targetCgroupPath, "pids.max"),
          String(limits.pidsMax)
        );
      }

      if (limits.cpuQuota !== undefined) {
        const period = limits.cpuPeriod ?? 100_000;
        fs.writeFileSync(
          path.join(targetCgroupPath, "cpu.max"),
          `${limits.cpuQuota} ${period}`
        );
      }
    } catch (err: unknown) {
      // 清理已创建的目录
      try {
        fs.rmdirSync(targetCgroupPath);
      } catch {}
      const msg = err instanceof Error ? err.message : String(err);
      throw new ResourceLimitUnavailableError(`写入 cgroup 控制参数失败: ${msg}`);
    }

    return {
      cgroupPath: targetCgroupPath,

      async addProcess(pid: number): Promise<void> {
        const procsFile = path.join(targetCgroupPath, "cgroup.procs");
        fs.writeFileSync(procsFile, String(pid));
      },

      async kill(): Promise<void> {
        const killFile = path.join(targetCgroupPath, "cgroup.kill");
        if (fs.existsSync(killFile)) {
          try {
            fs.writeFileSync(killFile, "1");
          } catch {}
        }
      },

      async cleanup(): Promise<void> {
        // 先确保 kill
        const killFile = path.join(targetCgroupPath, "cgroup.kill");
        if (fs.existsSync(killFile)) {
          try {
            fs.writeFileSync(killFile, "1");
          } catch {}
        }

        // 短暂等待进程退出后删除该节点
        for (let i = 0; i < 5; i++) {
          try {
            if (fs.existsSync(targetCgroupPath)) {
              fs.rmdirSync(targetCgroupPath);
            }
            break;
          } catch {
            await new Promise((r) => setTimeout(r, 50));
          }
        }
      },
    };
  }

  /**
   * 重置探针缓存
   */
  static resetCache(): void {
    this.cachedProbe = undefined;
  }
}
