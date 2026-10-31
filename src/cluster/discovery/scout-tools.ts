import { resolveNashHome } from "../../config/data-home.js";
/**
 * Scout Agent Tools
 * 专为分布式 Scout 探查智能体设计的受限只读工具集
 * 允许探查本地 ProjectRegistry、本地 MCP 服务、本地 Skills 与本地 Memory，严禁写入与删除
 */

import type { Tool } from "../../tools/tool.js";
import type { ProjectRegistry } from "../worker/project-registry.js";
import type { DiscoveryCandidate, DiscoveryReport } from "./types.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { FileSystemAccess } from "../../sandbox/filesystem-access.js";
import { createDefaultSandboxPolicy } from "../../sandbox/policy.js";

export const PROJECT_METADATA_FILES = ["package.json", "README.md", "pyproject.toml", "Cargo.toml", "go.mod"];

/**
 * 1. inspect_local_projects
 * 探查本地 ProjectRegistry 中已注册的项目及其目录信息
 */
export class InspectLocalProjectsTool implements Tool<{ filter?: string }> {
  public readonly name = "inspect_local_projects";
  public readonly description = "Inspect registered projects and their canonical paths on this worker node.";
  public readonly parameters = {
    type: "object",
    properties: {
      filter: {
        type: "string",
        description: "Optional filter substring to search project name or path",
      },
    },
  };

  constructor(private readonly projectRegistry: ProjectRegistry) {}

  async execute(args: { filter?: string }) {
    const list = this.projectRegistry.listProjects();
    const filterLower = args.filter?.toLowerCase();
    const filtered = filterLower
      ? list.filter((p) => p.name.toLowerCase().includes(filterLower) || p.projectId.toLowerCase().includes(filterLower))
      : list;

    return {
      total: list.length,
      matched: filtered.length,
      projects: filtered.map((p) => ({
        projectId: p.projectId,
        name: p.name,
        canonicalPath: p.canonicalPath,
        registeredAt: p.registeredAt,
      })),
    };
  }
}

/**
 * 2. inspect_local_mcp
 * 探查本地配置与在线的 MCP 服务及其暴露的工具
 */
export class InspectLocalMcpTool implements Tool<{ query?: string }> {
  public readonly name = "inspect_local_mcp";
  public readonly description = "Inspect local MCP servers, tools, and capabilities available on this node.";
  public readonly parameters = {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Optional query to match server name or tool name",
      },
    },
  };

  constructor(private readonly nashHome?: string) {}

  async execute(args: { query?: string }) {
    const homeDir = this.nashHome ?? resolveNashHome();
    const mcpConfigPath = path.join(homeDir, "mcp.json");
    const settingsPath = path.join(homeDir, "settings.json");

    const servers: Array<{ name: string; transport: string; toolsCount?: number; description?: string }> = [];

    // 读取 mcp.json
    if (fs.existsSync(mcpConfigPath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(mcpConfigPath, "utf-8"));
        const srvs = raw.mcpServers ?? {};
        for (const [name, cfg] of Object.entries(srvs)) {
          servers.push({
            name,
            transport: (cfg as any).transport ?? "unknown",
            description: (cfg as any).description ?? `MCP server ${name}`,
          });
        }
      } catch {}
    }

    // 读取 settings.json 中的 mcp
    if (fs.existsSync(settingsPath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
        const srvs = raw.mcp?.servers ?? {};
        for (const [name, cfg] of Object.entries(srvs)) {
          if (!servers.some((s) => s.name === name)) {
            servers.push({
              name,
              transport: (cfg as any).transport ?? "unknown",
              description: (cfg as any).description ?? `MCP server ${name}`,
            });
          }
        }
      } catch {}
    }

    const qLower = args.query?.toLowerCase();
    const matched = qLower
      ? servers.filter((s) => s.name.toLowerCase().includes(qLower) || s.description?.toLowerCase().includes(qLower))
      : servers;

    return {
      totalServers: servers.length,
      matchedServers: matched,
    };
  }
}

/**
 * 3. read_project_meta
 * 安全读取本地候选项目的元数据文件 (package.json / README.md / Cargo.toml / pyproject.toml)
 */
export class ReadProjectMetaTool implements Tool<{ projectPath: string; fileName?: string }> {
  constructor(
    private readonly fsAccess = new FileSystemAccess({ policy: createDefaultSandboxPolicy() }),
    private readonly onRead?: (filePath: string, content: string) => void,
  ) {}
  public readonly name = "read_project_meta";
  public readonly description = "Safely read metadata files (e.g. package.json, README.md) of a local project directory.";
  public readonly parameters = {
    type: "object",
    properties: {
      projectPath: {
        type: "string",
        description: "The directory path of the project to inspect",
      },
      fileName: {
        type: "string",
        description: "Target metadata file (default 'package.json', or 'README.md')",
      },
    },
    required: ["projectPath"],
  };

  async execute(args: { projectPath: string; fileName?: string }) {
    const requestedProject = path.resolve(this.fsAccess.getWorkspaceRoot(), args.projectPath);
    if (!fs.existsSync(requestedProject)) {
      return { found: false, error: `Path does not exist: ${args.projectPath}` };
    }

    const targetFile = args.fileName ?? "package.json";
    if (!PROJECT_METADATA_FILES.includes(targetFile)) {
      return { found: false, error: "Only project metadata files may be read; credentials and arbitrary paths are forbidden." };
    }
    const projectPath = fs.realpathSync(requestedProject);
    const requestedPath = path.join(projectPath, targetFile);
    if (fs.existsSync(requestedPath) && fs.realpathSync(requestedPath) !== requestedPath) {
      return { found: false, error: "Symlinked metadata files are not accepted as project evidence." };
    }
    const filePath = await this.fsAccess.resolveForRead(requestedPath);

    if (!fs.existsSync(filePath)) {
      return { found: false, error: `File '${targetFile}' not found in ${args.projectPath}` };
    }

    try {
      if (!fs.statSync(filePath).isFile()) return { found: false, error: "Metadata must be a regular file." };
      const fd = fs.openSync(filePath, "r");
      const buffer = Buffer.alloc(16000);
      let bytesRead: number;
      try { bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0); }
      finally { fs.closeSync(fd); }
      const truncated = buffer.subarray(0, bytesRead).toString("utf8").slice(0, 4000);
      this.onRead?.(filePath, truncated);
      return {
        found: true,
        filePath,
        content: truncated,
        isTruncated: fs.statSync(filePath).size > Buffer.byteLength(truncated),
      };
    } catch (err: any) {
      return { found: false, error: err.message || String(err) };
    }
  }
}

/**
 * 4. submit_discovery_report
 * Scout Agent 最终提交结构化发现结果的工具
 */
export class SubmitDiscoveryReportTool implements Tool<{
  candidates: DiscoveryCandidate[];
  summary: string;
}> {
  constructor(private readonly onSubmit?: (report: { candidates: DiscoveryCandidate[]; summary: string }) => Promise<{ candidates: DiscoveryCandidate[]; summary: string }>) {}
  public readonly name = "submit_discovery_report";
  public readonly description = "Submit final structured discovery report with verified physical evidence.";
  public readonly parameters = {
    type: "object",
    properties: {
      candidates: {
        type: "array",
        items: {
          type: "object",
          properties: {
            candidateProjectId: { type: "string" },
            projectName: { type: "string" },
            projectSummary: { type: "string" },
            canonicalPath: { type: "string" },
            isRegistered: { type: "boolean" },
            evidences: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  evidenceType: { type: "string" },
                  sourcePath: { type: "string" },
                  matchedContent: { type: "string" },
                  confidence: { type: "number" },
                },
                required: ["evidenceType", "matchedContent"],
              },
            },
            relevantCapabilities: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  capabilityType: { type: "string" },
                  name: { type: "string" },
                  description: { type: "string" },
                },
              },
            },
          },
          required: ["projectName", "projectSummary", "canonicalPath", "evidences"],
        },
      },
      summary: {
        type: "string",
        description: "Human-readable summary of the scout findings",
      },
    },
    required: ["candidates", "summary"],
  };

  private submittedReport?: { candidates: DiscoveryCandidate[]; summary: string };

  getReport() {
    return this.submittedReport;
  }

  async execute(args: { candidates: DiscoveryCandidate[]; summary: string }) {
    const report = this.onSubmit ? await this.onSubmit(args) : args;
    this.submittedReport = report;
    return {
      status: "accepted",
      candidatesCount: report.candidates.length,
      candidates: report.candidates,
      summary: report.summary,
      message: "Discovery report submitted and recorded successfully.",
    };
  }
}
