import { resolveNashHome } from "../config/data-home.js";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  generateProjectId,
  getProjectDisplayName,
  generateProjectDirectoryName,
  normalizeProjectRoot,
  assertSafeProjectDir,
} from "./project-id.js";

/**
 * 项目元数据结构定义
 */
export interface ProjectMetadata {
  projectId: string;
  projectRoot: string;
  createdAt: string; // ISO 8601
  lastUsedAt: string; // ISO 8601
  displayName?: string; // 人类可读名称 (例如 nash-agents)
  directoryName?: string; // 文件系统目录名 (例如 nash-agents__7d6b2ebd)
  customName?: string;
}

/**
 * 统一项目上下文接口 (通过依赖注入传递，拒绝全局单例)
 */
export interface ProjectContext {
  /**
   * 当前代码项目的稳定唯一 ID (16位十六进制哈希)
   */
  readonly projectId: string;

  /**
   * 规范化后的项目物理真实路径
   */
  readonly projectRoot: string;

  /**
   * 人类可读的项目展示名称 (如 nash-agents)
   */
  readonly displayName: string;

  /**
   * 文件系统中的目录名称 (如 nash-agents__7d6b2ebd)
   */
  readonly directoryName: string;

  /**
   * Nash 用户主目录 (默认 ~/.nash-agents，可用 NASH_HOME 覆盖)
   */
  readonly nashHome: string;

  /**
   * 当前项目的专用目录 (NASH_HOME/projects/<directoryName>，默认 ~/.nash-agents)
   */
  readonly projectDir: string;

  /**
   * 当前项目的持久化会话目录 (NASH_HOME/projects/<directoryName>/sessions，默认 ~/.nash-agents)
   */
  readonly sessionsDir: string;

  /**
   * 当前项目的 Spill 溢出产物目录 (NASH_HOME/projects/<directoryName>/spill)
   */
  readonly spillDir: string;

  /**
   * 项目元数据文件路径 (NASH_HOME/projects/<directoryName>/metadata.json)
   */
  readonly metadataPath: string;

  /**
   * 当前项目的 Memory 专用目录 (NASH_HOME/projects/<directoryName>/memory)
   */
  readonly memoryDir: string;

  /**
   * 当前项目的 Skills 专用目录 (NASH_HOME/projects/<directoryName>/skills)
   */
  readonly skillsDir: string;

  /**
   * 获取或重新读取当前项目元数据
   */
  getMetadata(): Promise<ProjectMetadata>;

  /**
   * 刷新/更新最后使用时间 (lastUsedAt)
   */
  touch(): Promise<void>;
}

export interface ResolveProjectContextOptions {
  /**
   * 项目物理根目录（默认使用 process.cwd()）
   */
  projectRoot?: string;

  /**
   * Nash 全局数据目录（默认使用 ~/.nash，用于单测或自定义路径隔离）
   */
  nashHome?: string;
}

/**
 * 跨文件系统安全复制目录
 */
async function copyDirRecursive(src: string, dest: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      await copyDirRecursive(srcPath, destPath);
    } else if (entry.isFile()) {
      await fs.copyFile(srcPath, destPath);
    }
  }
}

/**
 * 解析并初始化指定项目的 ProjectContext。
 * 自动建立 NASH_HOME/projects/<displayName>__<shortHash>/ 下的目录与 metadata.json。
 * 支持从旧的纯 Hash 目录安全幂等迁移。
 */
export async function resolveProjectContext(
  options?: ResolveProjectContextOptions
): Promise<ProjectContext> {
  const canonicalRoot = normalizeProjectRoot(options?.projectRoot);
  const projectId = generateProjectId(canonicalRoot);
  const displayName = getProjectDisplayName(canonicalRoot);
  const nashHome = options?.nashHome ?? resolveNashHome();
  const projectsRoot = path.join(nashHome, "projects");

  if (!fsSync.existsSync(projectsRoot)) {
    await fs.mkdir(projectsRoot, { recursive: true });
  }

  // 1. 计算期望的人类可读目录名与路径
  const desiredDirName = generateProjectDirectoryName(canonicalRoot, projectId);
  const desiredProjectDir = path.join(projectsRoot, desiredDirName);
  assertSafeProjectDir(projectsRoot, desiredProjectDir);

  let resolvedProjectDir = desiredProjectDir;
  let resolvedDirName = desiredDirName;

  // 2. 检查期望目录是否已经存在
  if (fsSync.existsSync(desiredProjectDir)) {
    // 目录已存在，验证 metadata
    const metaPath = path.join(desiredProjectDir, "metadata.json");
    let isSameProject = true;
    if (fsSync.existsSync(metaPath)) {
      try {
        const raw = await fs.readFile(metaPath, "utf-8");
        const existingMeta = JSON.parse(raw) as ProjectMetadata;
        if (existingMeta.projectId && existingMeta.projectId !== projectId) {
          isSameProject = false;
        }
      } catch {
        // metadata 损坏时按同一目录复用
      }
    }

    if (!isSameProject) {
      // 发生同名短哈希冲突，延长至完整 16 位哈希作为目录后缀
      const fallbackDirName = `${displayName}__${projectId}`;
      const fallbackProjectDir = path.join(projectsRoot, fallbackDirName);
      assertSafeProjectDir(projectsRoot, fallbackProjectDir);
      resolvedProjectDir = fallbackProjectDir;
      resolvedDirName = fallbackDirName;
    }
  } else {
    // 3. 期望新目录不存在，检查是否存在旧的纯 Hash 目录 (NASH_HOME/projects/<projectId>)
    const oldProjectDir = path.join(projectsRoot, projectId);
    if (fsSync.existsSync(oldProjectDir)) {
      const oldMetaPath = path.join(oldProjectDir, "metadata.json");
      let canMigrate = true;

      if (fsSync.existsSync(oldMetaPath)) {
        try {
          const raw = await fs.readFile(oldMetaPath, "utf-8");
          const oldMeta = JSON.parse(raw) as ProjectMetadata;
          if (oldMeta.projectId && oldMeta.projectId !== projectId) {
            canMigrate = false;
          }
        } catch {
          // 容错允许迁移
        }
      }

      if (canMigrate) {
        // 执行安全幂等迁移 (旧纯 Hash 目录 -> 新人类可读目录)
        try {
          await fs.rename(oldProjectDir, desiredProjectDir);
        } catch (err: unknown) {
          const nodeErr = err as { code?: string };
          if (nodeErr && nodeErr.code === "EXDEV") {
            await copyDirRecursive(oldProjectDir, desiredProjectDir);
            await fs.rm(oldProjectDir, { recursive: true, force: true });
          } else if (nodeErr && nodeErr.code === "ENOENT") {
            // 竞争状态下其他进程可能已重命名，直接使用 desiredProjectDir
          } else {
            throw err;
          }
        }
      }
    }
  }

  const projectDir = resolvedProjectDir;
  const sessionsDir = path.join(projectDir, "sessions");
  const spillDir = path.join(projectDir, "spill");
  const memoryDir = path.join(projectDir, "memory");
  const skillsDir = path.join(projectDir, "skills");
  const metadataPath = path.join(projectDir, "metadata.json");

  // 确保目录结构存在
  if (!fsSync.existsSync(sessionsDir)) {
    await fs.mkdir(sessionsDir, { recursive: true });
  }
  if (!fsSync.existsSync(spillDir)) {
    await fs.mkdir(spillDir, { recursive: true });
  }
  if (!fsSync.existsSync(memoryDir)) {
    await fs.mkdir(memoryDir, { recursive: true });
  }
  if (!fsSync.existsSync(skillsDir)) {
    await fs.mkdir(skillsDir, { recursive: true });
  }

  const now = new Date().toISOString();

  // 读取或创建 metadata.json
  let metadata: ProjectMetadata;
  if (fsSync.existsSync(metadataPath)) {
    try {
      const raw = await fs.readFile(metadataPath, "utf-8");
      metadata = JSON.parse(raw) as ProjectMetadata;
      metadata.lastUsedAt = now;
      metadata.projectRoot = canonicalRoot;
      metadata.displayName = displayName;
      metadata.directoryName = resolvedDirName;
    } catch {
      metadata = {
        projectId,
        projectRoot: canonicalRoot,
        displayName,
        directoryName: resolvedDirName,
        createdAt: now,
        lastUsedAt: now,
      };
    }
  } else {
    metadata = {
      projectId,
      projectRoot: canonicalRoot,
      displayName,
      directoryName: resolvedDirName,
      createdAt: now,
      lastUsedAt: now,
    };
  }

  await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2), "utf-8");

  return {
    projectId,
    projectRoot: canonicalRoot,
    displayName,
    directoryName: resolvedDirName,
    nashHome,
    projectDir,
    sessionsDir,
    spillDir,
    metadataPath,
    memoryDir,
    skillsDir,
    async getMetadata(): Promise<ProjectMetadata> {
      if (fsSync.existsSync(metadataPath)) {
        try {
          const raw = await fs.readFile(metadataPath, "utf-8");
          return JSON.parse(raw) as ProjectMetadata;
        } catch {
          // fallback
        }
      }
      return metadata;
    },
    async touch(): Promise<void> {
      const current = await (this as ProjectContext).getMetadata();
      current.lastUsedAt = new Date().toISOString();
      await fs.writeFile(metadataPath, JSON.stringify(current, null, 2), "utf-8");
    },
  };
}
