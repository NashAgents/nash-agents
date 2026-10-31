import { resolveNashHome } from "../config/data-home.js";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ProjectMetadata } from "./project-context.js";

export class ProjectStore {
  private readonly nashHome: string;

  constructor(nashHome?: string) {
    this.nashHome = nashHome ?? resolveNashHome();
  }

  get projectsDir(): string {
    return path.join(this.nashHome, "projects");
  }

  /**
   * 列出所有已记录的项目元数据列表（按最近使用时间倒序）
   */
  async listProjects(): Promise<ProjectMetadata[]> {
    if (!fsSync.existsSync(this.projectsDir)) {
      return [];
    }

    const entries = await fs.readdir(this.projectsDir);
    const projects: ProjectMetadata[] = [];

    for (const entry of entries) {
      const metaPath = path.join(this.projectsDir, entry, "metadata.json");
      if (fsSync.existsSync(metaPath)) {
        try {
          const raw = await fs.readFile(metaPath, "utf-8");
          const meta = JSON.parse(raw) as ProjectMetadata;
          projects.push(meta);
        } catch {
          // ignore corrupted metadata
        }
      }
    }

    // 按 lastUsedAt 倒序排列
    projects.sort(
      (a, b) => new Date(b.lastUsedAt).getTime() - new Date(a.lastUsedAt).getTime()
    );

    return projects;
  }

  /**
   * 获取指定 projectId 的元数据（扫描所有项目子目录的 metadata.json）
   */
  async getProject(projectId: string): Promise<ProjectMetadata | null> {
    if (!fsSync.existsSync(this.projectsDir)) {
      return null;
    }

    try {
      const entries = await fs.readdir(this.projectsDir);

      for (const entry of entries) {
        const metaPath = path.join(this.projectsDir, entry, "metadata.json");
        if (fsSync.existsSync(metaPath)) {
          try {
            const raw = await fs.readFile(metaPath, "utf-8");
            const meta = JSON.parse(raw) as ProjectMetadata;
            if (meta.projectId === projectId) {
              return meta;
            }
          } catch {
            // ignore corrupted
          }
        }
      }
    } catch {
      return null;
    }

    return null;
  }
}
