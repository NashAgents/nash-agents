import path from "node:path";
import fsSync from "node:fs";

/**
 * 规范化 Windows 扩展长路径前缀 (\\?\) 与盘符大写
 */
function normalizeWindowsDrivePath(p: string): string {
  let clean = p;
  if (clean.startsWith("\\\\?\\UNC\\")) {
    clean = "\\\\" + clean.slice(8);
  } else if (clean.startsWith("\\\\?\\")) {
    clean = clean.slice(4);
  }
  // 统一盘符大写 (如 c:\ -> C:\)
  return clean.replace(/^[a-zA-Z]:/, (m) => m.toUpperCase());
}

/**
 * 解析并获取规范化真实物理绝对路径（自动解析符号链接，处理未创建文件的祖先目录）
 */
export function resolveCanonicalPhysicalPath(rawPath: string): string {
  const resolve = (input: string, hops: number): string => {
    if (hops > 40) {
      const error = new Error("Too many symbolic links while resolving path") as NodeJS.ErrnoException;
      error.code = "ELOOP";
      throw error;
    }
    try { return fsSync.realpathSync.native(input); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = path.dirname(input);
    if (parent === input) return input;
    const candidate = path.join(resolve(parent, hops), path.basename(input));
    try {
      if (fsSync.lstatSync(candidate).isSymbolicLink()) {
        return resolve(path.resolve(path.dirname(candidate), fsSync.readlinkSync(candidate)), hops + 1);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return candidate;
  };
  const canonical = resolve(path.resolve(rawPath), 0);
  return process.platform === "win32" ? normalizeWindowsDrivePath(canonical) : canonical;
}

/**
 * 细粒度物理文件路径互斥锁管理器 (KeyedMutex)
 *
 * 铁律：
 * 1. 同一物理文件路径在同一时刻只允许一个写操作进入“版本比对 -> 写入物理磁盘 -> 更新观测版本”临界区；
 * 2. 必须基于真实物理 Canonical Path（解析符号链接与真实大小写）锁定，绝不仅使用词法字符串；
 * 3. 不同的物理文件路径互不影响，保持高并发并行。
 */
export class FileLockManager {
  private readonly locks = new Map<string, Promise<void>>();

  /**
   * 在指定物理文件路径的互斥锁保护下执行原子操作
   */
  async withLock<T>(filePath: string, action: () => Promise<T>): Promise<T> {
    const canonicalPath = resolveCanonicalPhysicalPath(filePath);
    const lockKey = process.platform === "win32" ? canonicalPath.toLowerCase() : canonicalPath;

    // 获取当前路径已有的等待链，或者初始的已就绪 Promise
    const currentLock = this.locks.get(lockKey) ?? Promise.resolve();

    let releaseLock!: () => void;
    const nextLock = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });

    // 级联排队，当前操作必须等待前序操作完成
    this.locks.set(lockKey, nextLock);

    try {
      await currentLock;
      return await action();
    } finally {
      releaseLock();
      // 若当前锁即为队列末尾，清理 Map 防止内存泄漏
      if (this.locks.get(lockKey) === nextLock) {
        this.locks.delete(lockKey);
      }
    }
  }

  /**
   * 查看指定文件当前是否处于锁定状态（自动转换为物理 Canonical 路径判定）
   */
  isLocked(filePath: string): boolean {
    const canonicalPath = resolveCanonicalPhysicalPath(filePath);
    const lockKey = process.platform === "win32" ? canonicalPath.toLowerCase() : canonicalPath;
    return this.locks.has(lockKey);
  }

  /**
   * 清空所有锁
   */
  clear(): void {
    this.locks.clear();
  }
}

/**
 * 全局共享的默认文件锁管理器
 */
export const defaultFileLockManager = new FileLockManager();
