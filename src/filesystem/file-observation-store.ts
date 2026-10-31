import * as crypto from "node:crypto";
import path from "node:path";
import { createReadStream } from "node:fs";

/**
 * FileObservationStore - 管理各 Agent 对文件的已观测版本快照 (SHA-256)
 *
 * 铁律：
 * 1. 使用 SHA-256 哈希作为文件内容的确定性版本标识，严禁仅使用不可靠的 mtime 或 size；
 * 2. 精确记录每个 Agent 在执行 read_file 时的 observedHash；
 * 3. 在写入时用于比对版本，拦截陈旧版本覆盖 (Stale Write)。
 */
export class FileObservationStore {
  private readonly store = new Map<string, Map<string, string>>(); // agentId -> (canonicalPath -> hash)

  /**
   * 计算字符串或 Buffer 的 SHA-256 哈希值
   */
  static computeHash(content: string | Buffer): string {
    return crypto.createHash("sha256").update(content).digest("hex");
  }

  /**
   * 计算指定文件的物理磁盘 SHA-256 哈希值
   */
  static async computeFileHash(filePath: string): Promise<string | undefined> {
    try {
      const hash = crypto.createHash("sha256");
      for await (const chunk of createReadStream(filePath)) hash.update(chunk);
      return hash.digest("hex");
    } catch {
      return undefined;
    }
  }

  /**
   * 记录某个 Agent 观测到的文件哈希
   */
  recordObservation(
    agentId: string,
    canonicalPath: string,
    contentOrHash: string | Buffer
  ): string {
    const normalized = path.resolve(canonicalPath);
    let agentMap = this.store.get(agentId);
    if (!agentMap) {
      agentMap = new Map<string, string>();
      this.store.set(agentId, agentMap);
    }

    const hash =
      typeof contentOrHash === "string" && contentOrHash.length === 64 && /^[0-9a-f]+$/i.test(contentOrHash)
        ? contentOrHash
        : FileObservationStore.computeHash(contentOrHash);

    agentMap.set(normalized, hash);
    return hash;
  }

  /**
   * 获取某个 Agent 最近一次观测到的文件哈希
   */
  getLastObservation(agentId: string, canonicalPath: string): string | undefined {
    const normalized = path.resolve(canonicalPath);
    return this.store.get(agentId)?.get(normalized);
  }

  /**
   * 移除特定 Agent 的观测记录
   */
  clearAgent(agentId: string): void {
    this.store.delete(agentId);
  }

  /**
   * 清空所有记录
   */
  clear(): void {
    this.store.clear();
  }
}

/**
 * 默认共享的全局单例 FileObservationStore（亦支持在 FileSystemAccess 中注入独立实例）
 */
export const defaultFileObservationStore = new FileObservationStore();
