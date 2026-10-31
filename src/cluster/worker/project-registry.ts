import { resolveNashHome } from "../../config/data-home.js";
import { withPersistenceLockSync, atomicWriteFileSync } from "../../filesystem/persistence-lock.js";
import { generateProjectId } from "../../project/project-id.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export interface RegisteredProject {
  projectId: string;
  name: string;
  canonicalPath: string;
  allowedCapabilities?: string[];
  registeredAt: number;
}

export interface ProjectRegistryOptions {
  customDir?: string;
}

/**
 * ProjectRegistry 管理 Worker 本地授权执行的安全项目目录
 * 存储于 NASH_HOME/cluster-projects.json（默认 ~/.nash-agents）
 * 严格使用 fs.realpath 校验物理路径，彻底杜绝路径穿越与符号链接逃逸
 */
export class ProjectRegistryError extends Error {
  constructor(message: string) { super(message); this.name = "ProjectRegistryError"; }
}

export class ProjectRegistry {
  private readonly storagePath: string;
  private readonly projects = new Map<string, RegisteredProject>();

  constructor(options?: ProjectRegistryOptions) {
    const baseDir = options?.customDir ?? resolveNashHome();
    if (!fs.existsSync(baseDir)) {
      try {
        fs.mkdirSync(baseDir, { recursive: true, mode: 0o700 });
      } catch {}
    }
    this.storagePath = path.join(baseDir, "cluster-projects.json");
    this.load();
  }

  get nashHome(): string { return path.dirname(this.storagePath); }

  /**
   * 注册并授权一个本地项目目录
   */
  registerProject(projectPath: string, name?: string): RegisteredProject {
    if (!fs.existsSync(projectPath)) {
      throw new Error(`Project directory does not exist: ${projectPath}`);
    }

    const stat = fs.statSync(projectPath);
    if (!stat.isDirectory()) {
      throw new Error(`Project path is not a directory: ${projectPath}`);
    }

    // 递归解析符号链接，获取真实物理路径
    const canonicalPath = fs.realpathSync(projectPath);
    const projectName = name ?? path.basename(canonicalPath);

    return withPersistenceLockSync(path.dirname(this.storagePath), () => {
      this.load();
      // Preserve existing IDs and their historical task references when registering again.
      const existing = [...this.projects.values()].find(p => p.canonicalPath === canonicalPath);
      const projectId = existing?.projectId ?? `proj-${generateProjectId(canonicalPath)}`;

      const project: RegisteredProject = {
        ...existing,
        projectId,
        name: projectName,
        canonicalPath,
        registeredAt: existing?.registeredAt ?? Date.now(),
      };

      this.projects.set(projectId, project);
      this.save();
      return { ...project };
    });
  }

  /**
   * 移除已注册项目
   */
  removeProject(projectId: string): boolean {
    return withPersistenceLockSync(path.dirname(this.storagePath), () => {
      this.load();
      const removed = this.projects.delete(projectId);
      if (removed) this.save();
      return removed;
    });
  }

  /**
   * 获取指定项目
   */
  getProject(projectId: string): RegisteredProject | undefined {
    this.load();
    const project = this.projects.get(projectId);
    return project ? structuredClone(project) : undefined;
  }

  /**
   * 列出所有已注册项目
   */
  listProjects(): RegisteredProject[] {
    this.load();
    return structuredClone(Array.from(this.projects.values()));
  }

  /**
   * 校验项目是否存在且路径安全
   */
  resolveAndValidateProject(projectId: string): { valid: boolean; canonicalPath?: string; reason?: string } {
    this.load();
    const p = this.projects.get(projectId);
    if (!p) {
      return { valid: false, reason: `Project ID '${projectId}' is not registered on this node` };
    }

    if (!fs.existsSync(p.canonicalPath)) {
      return { valid: false, reason: `Registered canonical path does not exist on disk: ${p.canonicalPath}` };
    }

    const currentReal = fs.realpathSync(p.canonicalPath);
    if (currentReal !== p.canonicalPath) {
      return { valid: false, reason: `TOCTOU / symlink divergence detected for project: ${p.canonicalPath} -> ${currentReal}` };
    }

    return { valid: true, canonicalPath: p.canonicalPath };
  }

  private load(): void {
    const next = new Map<string, RegisteredProject>();
    try {
      const list: unknown = JSON.parse(fs.readFileSync(this.storagePath, "utf8"));
      if (!Array.isArray(list)) throw new ProjectRegistryError("Project registry must be an array");
      for (const item of list) {
        if (!item || typeof item.projectId !== "string" || !item.projectId || typeof item.canonicalPath !== "string" || !path.isAbsolute(item.canonicalPath) || next.has(item.projectId)) {
          throw new ProjectRegistryError("Invalid or duplicate registered project identity");
        }
        next.set(item.projectId, item);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new ProjectRegistryError(`Project registry unreadable (Fail-Closed): ${String(error)}`);
    }
    this.projects.clear();
    for (const [id, project] of next) this.projects.set(id, project);
  }

  private save(): void {
    atomicWriteFileSync(this.storagePath, JSON.stringify([...this.projects.values()], null, 2));
  }
}
