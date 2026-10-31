import { resolveNashHome } from "../../../config/data-home.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { ProjectRegistry, RegisteredProject } from "../project-registry.js";
import type {
  ProjectCatalogItem,
  ProjectVisibility,
  CatalogTombstoneItem,
} from "../../protocol/types.js";

export interface ProjectMetadataOverride {
  summary?: string;
  description?: string;
  technologies?: string[];
  capabilities?: string[];
  visibility?: ProjectVisibility;
  userAliases?: string[];
  status?: "active" | "archived" | "migrated";
}

export class ProjectRegistryAdapter {
  private readonly metadataFile: string;
  private overrides = new Map<string, ProjectMetadataOverride>();

  constructor(
    private readonly projectRegistry: ProjectRegistry,
    private readonly nodeId: string,
    customDir?: string
  ) {
    const baseDir = customDir ?? resolveNashHome();
    if (!fs.existsSync(baseDir)) {
      try {
        fs.mkdirSync(baseDir, { recursive: true, mode: 0o700 });
      } catch {}
    }
    this.metadataFile = path.join(baseDir, "cluster-project-metadata.json");
    this.loadOverrides();
  }

  private loadOverrides(): void {
    if (fs.existsSync(this.metadataFile)) {
      try {
        const raw = fs.readFileSync(this.metadataFile, "utf-8");
        const obj = JSON.parse(raw);
        if (typeof obj === "object" && obj !== null) {
          for (const [k, v] of Object.entries(obj)) {
            this.overrides.set(k, v as ProjectMetadataOverride);
          }
        }
      } catch {}
    }
  }

  private saveOverrides(): void {
    try {
      const obj: Record<string, ProjectMetadataOverride> = {};
      for (const [k, v] of this.overrides.entries()) {
        obj[k] = v;
      }
      fs.writeFileSync(this.metadataFile, JSON.stringify(obj, null, 2), {
        mode: 0o600,
      });
    } catch {}
  }

  /**
   * 用户或 Agent 显式维护项目元数据描述
   */
  setProjectOverride(projectId: string, override: ProjectMetadataOverride): void {
    const existing = this.overrides.get(projectId) ?? {};
    this.overrides.set(projectId, { ...existing, ...override });
    this.saveOverrides();
  }

  getProjectOverride(projectId: string): ProjectMetadataOverride | undefined {
    return this.overrides.get(projectId);
  }

  /**
   * 自动探测项目物理目录中的技术栈 (严禁读取敏感文件或全量扫描代码)
   */
  private inspectTechnologies(canonicalPath: string): {
    technologies: string[];
    capabilities: string[];
    autoSummary: string;
    autoDescription: string;
  } {
    const techSet = new Set<string>();
    const capSet = new Set<string>();
    let autoSummary = "";
    let autoDescription = "";

    try {
      if (!fs.existsSync(canonicalPath)) {
        return { technologies: [], capabilities: [], autoSummary: "", autoDescription: "" };
      }

      // 1. package.json 探测
      const pkgPath = path.join(canonicalPath, "package.json");
      if (fs.existsSync(pkgPath)) {
        techSet.add("Node.js");
        try {
          const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
          if (pkg.description && typeof pkg.description === "string") {
            autoSummary = pkg.description.trim();
          }
          if (pkg.dependencies || pkg.devDependencies) {
            const allDeps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
            if (allDeps.typescript || fs.existsSync(path.join(canonicalPath, "tsconfig.json"))) {
              techSet.add("TypeScript");
            }
            if (allDeps.vue) techSet.add("Vue");
            if (allDeps.react || allDeps["next"]) techSet.add("React");
            if (allDeps.electron) techSet.add("Electron");
            if (allDeps["@modelcontextprotocol/client"] || allDeps["@modelcontextprotocol/sdk"]) {
              capSet.add("MCP");
            }
            if (allDeps["sherpa-onnx-node"]) {
              capSet.add("Speech Recognition");
              capSet.add("Realtime Subtitles");
            }
            if (pkg.keywords && Array.isArray(pkg.keywords)) {
              for (const kw of pkg.keywords.slice(0, 10)) {
                if (typeof kw === "string") capSet.add(kw);
              }
            }
          }
        } catch {}
      }

      // 2. Python 探测 (requirements.txt / pyproject.toml / main.py)
      const reqPath = path.join(canonicalPath, "requirements.txt");
      const pyprojectPath = path.join(canonicalPath, "pyproject.toml");
      if (fs.existsSync(reqPath) || fs.existsSync(pyprojectPath) || fs.existsSync(path.join(canonicalPath, "main.py"))) {
        techSet.add("Python");
        if (fs.existsSync(reqPath)) {
          try {
            const reqContent = fs.readFileSync(reqPath, "utf-8").toLowerCase();
            if (reqContent.includes("fastapi")) techSet.add("FastAPI");
            if (reqContent.includes("flask")) techSet.add("Flask");
            if (reqContent.includes("django")) techSet.add("Django");
            if (reqContent.includes("torch") || reqContent.includes("pytorch")) {
              techSet.add("PyTorch");
              capSet.add("Deep Learning");
            }
            if (reqContent.includes("transformers")) capSet.add("Transformers");
          } catch {}
        }
      }

      // 3. Rust 探测
      if (fs.existsSync(path.join(canonicalPath, "Cargo.toml"))) {
        techSet.add("Rust");
      }

      // 4. Go 探测
      if (fs.existsSync(path.join(canonicalPath, "go.mod"))) {
        techSet.add("Go");
      }

      // 5. README.md 提取前几行摘要
      const readmePath = path.join(canonicalPath, "README.md");
      if (fs.existsSync(readmePath)) {
        try {
          const readmeLines = fs.readFileSync(readmePath, "utf-8").split("\n");
          for (const line of readmeLines) {
            const trimmed = line.trim();
            if (trimmed.startsWith("# ") && !autoSummary) {
              autoSummary = trimmed.slice(2).trim();
            } else if (trimmed && !trimmed.startsWith("#") && !trimmed.startsWith("```") && !autoDescription) {
              autoDescription = trimmed.slice(0, 300);
            }
            if (autoSummary && autoDescription) break;
          }
        } catch {}
      }
    } catch {}

    return {
      technologies: Array.from(techSet),
      capabilities: Array.from(capSet),
      autoSummary: autoSummary || "Local authorized project",
      autoDescription: autoDescription || autoSummary || "No description provided",
    };
  }

  /**
   * 生成当前节点的已授权项目目录列表
   */
  exportCatalogItems(revision = 1): ProjectCatalogItem[] {
    const registered = this.projectRegistry.listProjects();
    const items: ProjectCatalogItem[] = [];

    for (const proj of registered) {
      const override = this.overrides.get(proj.projectId);

      // 若显式设置为 not_published，则不参与 Catalog
      if (override?.visibility === "not_published") {
        continue;
      }

      const inspected = this.inspectTechnologies(proj.canonicalPath);

      const visibility: ProjectVisibility = override?.visibility ?? "summary";
      const technologies = override?.technologies ?? inspected.technologies;
      const capabilities = override?.capabilities ?? inspected.capabilities;
      const summary = override?.summary ?? inspected.autoSummary;
      const description = override?.description ?? inspected.autoDescription;
      const userAliases = override?.userAliases ?? [];
      const status = override?.status ?? "active";

      items.push({
        projectId: proj.projectId,
        nodeId: this.nodeId,
        name: proj.name,
        summary: visibility === "discoverable" ? proj.name : summary,
        description: visibility === "discoverable" ? "" : description,
        technologies: visibility === "discoverable" ? [] : technologies,
        capabilities: visibility === "discoverable" ? [] : capabilities,
        status,
        registeredAt: proj.registeredAt,
        updatedAt: Date.now(),
        lastIndexedAt: Date.now(),
        revision,
        visibility,
        // canonicalPath 仅在本地记录，不向外部泄露绝对路径
        canonicalPath: proj.canonicalPath,
        userAliases,
      });
    }

    return items;
  }
}
