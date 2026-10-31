import cp from "node:child_process";

/**
 * 跨平台进程树终止器抽象 (ProcessTreeTerminator)
 *
 * 架构规范：
 * 1. 业务层与底层系统调用彻底解耦，绝不将 platform 相关的系统调用硬编码进 JobManager；
 * 2. POSIX (macOS, Linux): 基于 detached 独立会话进程组 (-pid / PGID) 广播信号，防止 node/vitest/python 孙进程泄漏为孤儿；
 * 3. Windows: 优先通过 taskkill /F /T /PID 彻底击毙整个子孙进程树，回退到普通单进程 kill；
 * 4. Fail-safe: 捕获 ESRCH (进程已退出) 等无害信号异常，提供回退单进程直接 kill 保底。
 */
export interface ProcessTreeTerminator {
  terminate(pid: number, signal?: NodeJS.Signals): void;
}

export class PosixProcessTreeTerminator implements ProcessTreeTerminator {
  terminate(pid: number, signal: NodeJS.Signals = "SIGTERM"): void {
    if (!pid || pid <= 0) return;
    try {
      // 在 POSIX 且 detached: true 模式下，pid 即为独立进程组 ID (PGID)
      process.kill(-pid, signal);
    } catch (err: unknown) {
      // The child PID can be visible before its detached process group exists.
      // ESRCH for the group therefore does not prove that the child has exited.
      try { process.kill(pid, signal); } catch {}
    }
  }
}

export class WindowsProcessTreeTerminator implements ProcessTreeTerminator {
  terminate(pid: number, signal: NodeJS.Signals = "SIGTERM"): void {
    if (!pid || pid <= 0) return;
    try {
      // 在 Windows 上使用 taskkill /F /T /PID 递归终止目标进程及其派生的所有子进程树
      cp.execFileSync("taskkill.exe", ["/F", "/T", "/PID", String(pid)], {
        stdio: ["ignore", "ignore", "ignore"],
        windowsHide: true,
      });
    } catch {
      // 若 taskkill 失败或目标已退出，回退到普通单进程 kill
      try {
        process.kill(pid, signal);
      } catch {}
    }
  }
}

/**
 * 依赖注入工厂：根据当前宿主操作系统自动构造对应的 ProcessTreeTerminator
 */
export function createDefaultProcessTreeTerminator(): ProcessTreeTerminator {
  if (process.platform === "win32") {
    return new WindowsProcessTreeTerminator();
  }
  return new PosixProcessTreeTerminator();
}
