import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import type { SkillMetadata, SkillScope } from "./types.js";
import { parseSkillMarkdown } from "./frontmatter.js";
import { assertSafeSkillPath } from "./skill-paths.js";

interface CacheEntry {
  mtime: number;
  metadata: SkillMetadata[];
}

/**
 * 集中管理 Global 与 Project Skills 发现与元数据注册的 Registry
 */
export class SkillRegistry {
  private readonly globalDir: string;
  private readonly projectDir?: string;

  private globalCache: CacheEntry | null = null;
  private projectCache: CacheEntry | null = null;

  constructor(options: { globalDir: string; projectDir?: string }) {
    this.globalDir = path.resolve(options.globalDir);
    if (options.projectDir) {
      this.projectDir = path.resolve(options.projectDir);
    }
  }

  /**
   * 扫描指定目录获取 Skill Level 1 元数据列表
   */
  private async scanDirectory(
    dirPath: string,
    scope: SkillScope
  ): Promise<SkillMetadata[]> {
    if (!fsSync.existsSync(dirPath)) {
      return [];
    }

    assertSafeSkillPath(path.dirname(dirPath), dirPath);

    const items = await fs.readdir(dirPath, { withFileTypes: true });
    const result: SkillMetadata[] = [];

    for (const item of items) {
      if (!item.isDirectory()) continue;
      const skillName = item.name;

      // 忽略隐藏目录 (如 .observations.jsonl 所在)
      if (skillName.startsWith(".")) continue;

      const skillDir = path.join(dirPath, skillName);
      const skillMdPath = path.join(skillDir, "SKILL.md");

      if (!fsSync.existsSync(skillMdPath)) continue;

      try {
        const raw = await fs.readFile(skillMdPath, "utf-8");
        // 检查 references 与 scripts 子目录
        const refDir = path.join(skillDir, "references");
        const scriptDir = path.join(skillDir, "scripts");
        const hasReferences = fsSync.existsSync(refDir);
        const hasScripts = fsSync.existsSync(scriptDir);

        const definition = parseSkillMarkdown(raw, {
          name: skillName,
          scope,
          directoryPath: skillDir,
          skillFilePath: skillMdPath,
          hasReferences,
          hasScripts,
        });

        result.push(definition.metadata);
      } catch {
        // 忽略解析损坏的单条 Skill
      }
    }

    return result;
  }

  /**
   * 获取所有可用 Skills 的 Level 1 元数据 (Project Skill 同名覆盖 Global Skill)
   */
  async getAllMetadata(): Promise<SkillMetadata[]> {
    // 1. 扫描 Global
    let globalSkills: SkillMetadata[] = [];
    if (fsSync.existsSync(this.globalDir)) {
      try {
        const stat = await fs.stat(this.globalDir);
        if (this.globalCache && this.globalCache.mtime === stat.mtimeMs) {
          globalSkills = this.globalCache.metadata;
        } else {
          globalSkills = await this.scanDirectory(this.globalDir, "global");
          this.globalCache = { mtime: stat.mtimeMs, metadata: globalSkills };
        }
      } catch {}
    }

    // 2. 扫描 Project
    let projectSkills: SkillMetadata[] = [];
    if (this.projectDir && fsSync.existsSync(this.projectDir)) {
      try {
        const stat = await fs.stat(this.projectDir);
        if (this.projectCache && this.projectCache.mtime === stat.mtimeMs) {
          projectSkills = this.projectCache.metadata;
        } else {
          projectSkills = await this.scanDirectory(this.projectDir, "project");
          this.projectCache = { mtime: stat.mtimeMs, metadata: projectSkills };
        }
      } catch {}
    }

    // 3. 优先级合并：Project 覆盖 Global 同名 Skill
    const mergedMap = new Map<string, SkillMetadata>();
    for (const g of globalSkills) {
      mergedMap.set(g.name, g);
    }
    for (const p of projectSkills) {
      mergedMap.set(p.name, p); // 覆盖同名
    }

    return Array.from(mergedMap.values());
  }

  /**
   * 按名称查找单个 Skill 的元数据
   */
  async findMetadata(name: string): Promise<SkillMetadata | undefined> {
    const all = await this.getAllMetadata();
    return all.find((s) => s.name.toLowerCase() === name.toLowerCase());
  }

  /**
   * 清除缓存
   */
  clearCache(): void {
    this.globalCache = null;
    this.projectCache = null;
  }
}
