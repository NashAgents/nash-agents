import { resolveNashHome } from "../../config/data-home.js";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";
import type { SpillPolicy } from "../types.js";
import { LocalSpillStore } from "./local-spill-store.js";
import { DEFAULT_SPILL_POLICY } from "./spill-policy.js";
import { generateProjectDirectoryName, normalizeProjectRoot } from "../../project/project-id.js";

export interface SpillGcOptions {
  baseDir?: string;
  policy?: Partial<SpillPolicy>;
  spillStore?: LocalSpillStore;
}

export interface SpillGcRunOptions {
  /**
   * 活跃中的 Session ID 列表，GC 绝不删除活跃 Session 的任何 Artifact
   */
  activeSessionIds?: string[];

  /**
   * 是否强制忽略 retentionDays 清理超出配额的旧数据
   */
  force?: boolean;
}

export interface SpillGcResult {
  deletedArtifacts: number;
  freedBytes: number;
  remainingGlobalBytes: number;
}

export class SpillGc {
  private readonly baseDir: string;
  private readonly policy: SpillPolicy;
  private readonly spillStore: LocalSpillStore;

  constructor(options?: SpillGcOptions) {
    if (options?.baseDir) {
      this.baseDir = options.baseDir;
    } else {
      const canonicalCwd = normalizeProjectRoot(process.cwd());
      const dirName = generateProjectDirectoryName(canonicalCwd);
      this.baseDir = path.join(resolveNashHome(), "projects", dirName);
    }

    this.policy = {
      ...DEFAULT_SPILL_POLICY,
      ...options?.policy,
    };
    this.spillStore =
      options?.spillStore ??
      new LocalSpillStore({
        baseDir: this.baseDir,
        policy: this.policy,
      });
  }

  async run(options?: SpillGcRunOptions): Promise<SpillGcResult> {
    const activeSet = new Set(options?.activeSessionIds ?? []);
    const now = Date.now();
    const retentionMs = this.policy.retentionDays * 24 * 60 * 60 * 1000;

    let deletedCount = 0;
    let freedBytes = 0;

    const allArtifacts = await this.spillStore.list();

    // 1. 第一阶段：清理非活跃且超过 retentionDays 的过期 Session 数据
    for (const art of allArtifacts) {
      if (activeSet.has(art.sessionId)) {
        continue; // 活跃 Session 绝不静默删除
      }

      const ageMs = now - art.createdAt;
      if (ageMs > retentionMs || (options?.force && !activeSet.has(art.sessionId))) {
        const deleted = await this.spillStore.delete(art.id);
        if (deleted) {
          deletedCount++;
          freedBytes += art.bytes;
        }
      }
    }

    // 2. 第二阶段：如果全局总大小依然超过 maxGlobalBytes，从最旧的非活跃 Session Artifact 开始清理
    let currentGlobalBytes = await this.spillStore.getGlobalBytes();
    if (currentGlobalBytes > this.policy.maxGlobalBytes) {
      const remainingArtifacts = (await this.spillStore.list()).filter(
        (a) => !activeSet.has(a.sessionId)
      );

      // 按创建时间升序排列（最旧的在前面）
      remainingArtifacts.sort((a, b) => a.createdAt - b.createdAt);

      for (const art of remainingArtifacts) {
        if (currentGlobalBytes <= this.policy.maxGlobalBytes) {
          break;
        }
        const deleted = await this.spillStore.delete(art.id);
        if (deleted) {
          deletedCount++;
          freedBytes += art.bytes;
          currentGlobalBytes -= art.bytes;
        }
      }
    }

    // 清理可能产生的空 session 目录
    await this.cleanupEmptySessionDirs();

    const finalGlobalBytes = await this.spillStore.getGlobalBytes();

    return {
      deletedArtifacts: deletedCount,
      freedBytes,
      remainingGlobalBytes: finalGlobalBytes,
    };
  }

  private async cleanupEmptySessionDirs(): Promise<void> {
    const spillRoot = path.join(this.baseDir, "spill");
    if (!fsSync.existsSync(spillRoot)) {
      return;
    }

    const sessionDirs = await fs.readdir(spillRoot);
    for (const sDir of sessionDirs) {
      const sPath = path.join(spillRoot, sDir);
      const stat = await fs.stat(sPath);
      if (stat.isDirectory()) {
        const files = await fs.readdir(sPath);
        if (files.length === 0) {
          try {
            await fs.rmdir(sPath);
          } catch {
            // ignore
          }
        }
      }
    }
  }
}
