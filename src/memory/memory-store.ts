import { randomUUID } from "node:crypto";
import { withPersistenceLock, PersistenceLockError } from "../filesystem/persistence-lock.js";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import type { MemoryEntry, MemoryScope } from "./types.js";
import { assertSafeMemoryPath } from "./memory-paths.js";
import {
  renderMemoryMarkdown,
  renderCategoryMarkdown,
  parseMarkdownToEntries,
} from "./memory-renderer.js";

export interface MemoryStoreOptions {
  /**
   * 存储目录路径 (绝对路径)
   */
  storageDir: string;

  /**
   * 作用域
   */
  scope: MemoryScope;

  /**
   * 人类可读项目/全局标题
   */
  displayName?: string;
}

/**
 * 结构化 Memory 持久化存储器
 */
export class MemoryStore {
  readonly storageDir: string;
  readonly scope: MemoryScope;
  readonly displayName: string;

  private readonly indexPath: string;
  private readonly memoryMdPath: string;

  private writePromise: Promise<void> = Promise.resolve();
  private cachedEntries: MemoryEntry[] | null = null;
  private cachedMtime: number = 0;

  constructor(options: MemoryStoreOptions) {
    this.storageDir = path.resolve(options.storageDir);
    this.scope = options.scope;
    this.displayName = options.displayName ?? (this.scope === "global" ? "Global Memory" : "Project Memory");

    this.indexPath = path.join(this.storageDir, "index.json");
    this.memoryMdPath = path.join(this.storageDir, "MEMORY.md");

    assertSafeMemoryPath(path.dirname(this.storageDir), this.storageDir);
  }

  private async ensureDir(): Promise<void> {
    if (!fsSync.existsSync(this.storageDir)) {
      await fs.mkdir(this.storageDir, { recursive: true });
    }
  }

  /**
   * 加载当前所有 Memory 条目（包含 active 与 deprecated）
   * 具备 Fail-Safe 兼容导入机制：若 index.json 不存在，自动尝试从 MEMORY.md 或 ~/.nash/memory.md 恢复
   */
  async loadEntries(): Promise<MemoryEntry[]> {
    if (!fsSync.existsSync(this.indexPath)) {
      // 兼容导入探测：检查同目录下 MEMORY.md 或上一级的 memory.md
      const imported = await this.tryIngestExternalMarkdown();
      if (imported.length > 0) {
        await this.saveEntries(imported);
        return [...imported];
      }

      this.cachedEntries = [];
      this.cachedMtime = 0;
      return [];
    }

    try {
      const stat = await fs.stat(this.indexPath);
      if (this.cachedEntries && stat.mtimeMs === this.cachedMtime) {
        return structuredClone(this.cachedEntries);
      }

      const raw = await fs.readFile(this.indexPath, "utf-8");
      const parsed = JSON.parse(raw) as MemoryEntry[];
      if (Array.isArray(parsed) && parsed.length > 0) {
        this.cachedEntries = parsed;
        this.cachedMtime = stat.mtimeMs;
        return structuredClone(parsed);
      } else if (Array.isArray(parsed) && parsed.length === 0) {
        // index.json 存在且为空数组，说明记忆已被明确清空或本身为空，绝不重新导入外部旧数据造成幽灵复活
        this.cachedEntries = [];
        this.cachedMtime = stat.mtimeMs;
        return [];
      }
    } catch (error) {
      throw new PersistenceLockError(`Memory index unreadable; existing data preserved: ${String(error)}`);
    }
    throw new PersistenceLockError("Memory index must be an array");
  }

  /**
   * 探测并尝试导入外部散落的 Markdown 记忆 (如 ~/.nash/memory.md 或手写 MEMORY.md)
   */
  private async tryIngestExternalMarkdown(): Promise<MemoryEntry[]> {
    const candidatePaths: string[] = [];

    // 1. 同级 MEMORY.md
    if (fsSync.existsSync(this.memoryMdPath)) {
      candidatePaths.push(this.memoryMdPath);
    }

    // 2. 若为 global store (~/.nash/memory/)，探测上一级 ~/.nash/memory.md
    if (this.scope === "global") {
      const parentMemoryMd = path.join(path.dirname(this.storageDir), "memory.md");
      if (fsSync.existsSync(parentMemoryMd)) {
        candidatePaths.push(parentMemoryMd);
      }
    }

    for (const candPath of candidatePaths) {
      try {
        const text = await fs.readFile(candPath, "utf-8");
        if (text && text.trim().length > 0) {
          const parsed = parseMarkdownToEntries(text, { scope: this.scope });
          if (parsed.length > 0) {
            return parsed;
          }
        }
      } catch {}
    }

    return [];
  }

  /**
   * 保存并原子写盘（串行化写操作，同时更新 index.json、MEMORY.md 与分类 md 文件）
   */
  async saveEntries(entries: MemoryEntry[]): Promise<void> {
    return this.persistEntries(entries);
  }

  private async persistEntries(entries: MemoryEntry[], removedIds: readonly string[] = []): Promise<void> {
    await this.updateEntries(current => {
      const removed = new Set(removedIds);
      const entryMap = new Map(current.filter(e => !removed.has(e.id)).map(e => [e.id, e]));
      for (const entry of entries) entryMap.set(entry.id, structuredClone(entry));
      current.splice(0, current.length, ...entryMap.values());
    });
  }

  /** Runs the complete read/modify/write transaction under the cross-process directory lock. */
  async updateEntries<T>(update: (entries: MemoryEntry[]) => T): Promise<T> {
    const nextWrite = this.writePromise.then(() => withPersistenceLock(this.storageDir, async () => {
      await this.ensureDir();
      let merged: MemoryEntry[] = [];
      try {
        const raw = await fs.readFile(this.indexPath, "utf-8");
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) throw new PersistenceLockError("Memory index must be an array");
        merged = parsed;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw new PersistenceLockError(`Memory index unreadable; refusing overwrite: ${String(error)}`);
        }
      }
      const result = update(merged);

      const writeAtomic = async (file: string, content: string) => {
        const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
        try {
          await fs.writeFile(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx", flush: true });
          await fs.rename(temporary, file);
        } finally { await fs.rm(temporary, { force: true }); }
      };
      await writeAtomic(this.indexPath, JSON.stringify(merged, null, 2));
      await writeAtomic(this.memoryMdPath, renderMemoryMarkdown(merged, `Nash ${this.displayName}`));
      for (const kind of ["architecture", "environment", "preference", "lesson"] as const) {
        await writeAtomic(path.join(this.storageDir, `${kind}.md`), renderCategoryMarkdown(kind, merged));
      }

      this.cachedEntries = structuredClone(merged);
      try {
        const stat = await fs.stat(this.indexPath);
        this.cachedMtime = stat.mtimeMs;
      } catch {}
      return result;
    }));

    this.writePromise = nextWrite.then(() => {}, () => {});
    return nextWrite;
  }

  /**
   * 插入或更新单个条目
   */
  async upsertEntry(entry: MemoryEntry): Promise<void> {
    await this.loadEntries();
    await this.persistEntries([entry]);
  }

  /** 将指定条目标记为废弃，读取与更新受同一事务保护。 */
  async deprecateEntry(id: string): Promise<boolean> {
    await this.loadEntries();
    return this.updateEntries(entries => {
      const target = entries.find(e => e.id === id);
      if (!target) return false;
      target.deprecated = true;
      target.updatedAt = new Date().toISOString();
      return true;
    });
  }

  /** 物理删除条目，删除结果以锁内最新索引为准。 */
  async removeEntry(id: string): Promise<boolean> {
    await this.loadEntries();
    return this.updateEntries(entries => {
      const index = entries.findIndex(e => e.id === id);
      if (index < 0) return false;
      entries.splice(index, 1);
      return true;
    });
  }

  /**
   * 清除当前缓存
   */
  clearCache(): void {
    this.cachedEntries = null;
    this.cachedMtime = 0;
  }
}
