import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import type { FileSystemAccess } from "../../sandbox/filesystem-access.js";
import type { Tool, ToolExecutionContext } from "../../tools/tool.js";
import { MemoryService } from "../../memory/memory-service.js";
import { sanitizeSecretText } from "../../memory/secret-sanitizer.js";
import { resolveProjectContext } from "../../project/project-context.js";
import type { MemoryConfig } from "../../memory/types.js";
import type { ProjectRegistry } from "../worker/project-registry.js";
import type { DiscoveryCandidate, DiscoveryReport, DiscoveryScanReceipt } from "./types.js";
import { PROJECT_METADATA_FILES, ReadProjectMetaTool, SubmitDiscoveryReportTool } from "./scout-tools.js";

export class DiscoveryEvidenceError extends Error {
  constructor(message: string) { super(message); this.name = "DiscoveryEvidenceError"; }
}

interface ProjectDiscoverySessionOptions {
  nodeId: string;
  taskId: string;
  runId: string;
  query: string;
  projectRegistry: ProjectRegistry;
  fsAccess: FileSystemAccess;
  memoryConfig?: Partial<MemoryConfig>;
  scanRoots?: string[];
  onPersisted: (report: DiscoveryReport) => void;
}

/** Discovery stores knowledge under the observed project without granting execution rights. */
export class ProjectDiscoverySession {
  private readonly observations = new Map<string, { content: string; mtimeMs: number; size: number }>();
  private readonly scanReceipts: DiscoveryScanReceipt[] = [];
  private scanReceiptsOmitted = 0;
  readonly readTool: ReadProjectMetaTool;
  readonly reportTool: SubmitDiscoveryReportTool;
  readonly scanTool: Tool;

  constructor(private readonly options: ProjectDiscoverySessionOptions) {
    this.readTool = new ReadProjectMetaTool(options.fsAccess, (file, content) => {
      const { mtimeMs, size } = fs.statSync(file);
      this.observations.set(file, { content, mtimeMs, size });
    });
    this.reportTool = new SubmitDiscoveryReportTool(async (report) => {
      const candidates: DiscoveryCandidate[] = [];
      if (!Array.isArray(report.candidates) || report.candidates.length > 20) throw new DiscoveryEvidenceError("A discovery report may contain at most 20 projects.");
      // Validate every candidate before writing any memory.
      for (const candidate of report.candidates) candidates.push(this.validate(candidate));
      for (const candidate of candidates) await this.remember(candidate);
      options.onPersisted({
        discoveryId: `discovery-${options.taskId}`, nodeId: options.nodeId, query: options.query,
        timestamp: Date.now(), candidates, summary: report.summary,
        investigatedPaths: [...new Set([...this.observations.keys()].map((file) => path.dirname(file)))],
        investigatedMcpServers: [], scanReceipts: structuredClone(this.scanReceipts), scanReceiptsOmitted: this.scanReceiptsOmitted,
        outcome: this.reportOutcome(), durationMs: 0,
      });
      return { candidates, summary: report.summary };
    });
    this.scanTool = {
      name: "scan_local_projects",
      description: "Search common local project folders, including unregistered projects. Bounded read-only scan; normal filesystem approvals apply. Read candidate metadata with read_project_meta, then submit_discovery_report. An empty or truncated scan does not prove no project exists.",
      parameters: { type: "object", properties: { filter: { type: "string", description: "Project name or technical keywords (space separated)." } } },
      execute: (args: { filter?: string }, context?: ToolExecutionContext) => this.scan(args.filter, context?.signal),
    };
  }

  /**
   * The outcome describes what the harness actually scanned, not what the model asks to claim.
   * A truncated scan or an omitted receipt keeps the report partial regardless of the answer text.
   */
  private reportOutcome(): DiscoveryReport["outcome"] {
    if (!this.scanReceipts.length || this.scanReceiptsOmitted > 0) return "partial";
    if (this.scanReceipts.some(receipt => receipt.truncated || receipt.errors.length > 0 || !receipt.authorizedRoots.length)) return "partial";
    return "completed";
  }

  private async scan(filter?: string, signal?: AbortSignal) {
    const roots = this.options.scanRoots ?? [...["Documents", "Projects", "Code", "Workspace"].map((name) => path.join(os.homedir(), name)), os.homedir()];
    const tokens = (filter ?? "").toLowerCase().split(/\s+/).filter(Boolean);
    const projects: Array<{ canonicalPath: string; name: string; metadataFiles: string[] }> = [];
    const visited = new Set<string>();
    const errors: Array<{ path: string; error: string }> = [];
    const authorizedRoots: string[] = [];
    let count = 0;
    let truncated = false;
    for (const root of roots) {
      signal?.throwIfAborted();
      if (!fs.existsSync(root)) continue;
      // One approval covers enumeration beneath this root; symlinks are never followed.
      const authorized = await this.options.fsAccess.resolveForRead(root);
      const canonicalRoot = fs.realpathSync(authorized);
      authorizedRoots.push(canonicalRoot);
      const queue = [{ dir: canonicalRoot, depth: 0 }];
      while (queue.length) {
        signal?.throwIfAborted();
        if (count >= 1000 || projects.length >= 60) { truncated = true; break; }
        const current = queue.shift()!;
        if (visited.has(current.dir)) continue;
        visited.add(current.dir);
        count++;
        let entries: fs.Dirent[];
        try {
          if (fs.lstatSync(current.dir).isSymbolicLink() || fs.realpathSync(current.dir) !== current.dir) continue;
          entries = fs.readdirSync(current.dir, { withFileTypes: true });
        } catch (error) { errors.push({ path: current.dir, error: String(error) }); continue; }
        const metadataFiles = entries.filter((entry) => entry.isFile() && PROJECT_METADATA_FILES.includes(entry.name)).map((entry) => entry.name);
        const name = path.basename(current.dir);
        if (metadataFiles.length && (!tokens.length || tokens.some((token) => name.toLowerCase().includes(token)))) {
          projects.push({ canonicalPath: current.dir, name, metadataFiles });
        }
        if (current.depth < 3) {
          for (const entry of entries) {
            if (!entry.isDirectory() || entry.name.startsWith(".") || ["node_modules", "Library", "dist", "venv", "__pycache__"].includes(entry.name)) continue;
            queue.push({ dir: path.join(current.dir, entry.name), depth: current.depth + 1 });
          }
        }
      }
      if (truncated) break;
    }
    const scope = "bounded local directory names; maximum depth 3; hidden directories, symlinks and dependency/build directories excluded; not an exhaustive disk or semantic search";
    this.scanReceipts.push({ scannedAt: Date.now(), authorizedRoots, filter: (filter ?? "").slice(0, 1000), visitedDirectories: count, maxDepth: 3, truncated,
      errors: errors.map(error => ({ path: error.path, error: sanitizeSecretText(error.error) })), scope });
    if (this.scanReceipts.length > 10) { this.scanReceipts.shift(); this.scanReceiptsOmitted++; }
    return { projects, searchedRoots: roots, visitedDirectories: count, truncated, errors, scope };
  }

  private validate(raw: DiscoveryCandidate): DiscoveryCandidate {
    if (!raw.canonicalPath || !path.isAbsolute(raw.canonicalPath) || !raw.projectName?.trim() || !raw.projectSummary?.trim()) {
      throw new DiscoveryEvidenceError("Project name, summary and absolute canonicalPath are required.");
    }
    const canonicalPath = fs.realpathSync(raw.canonicalPath);
    if (!fs.statSync(canonicalPath).isDirectory()) throw new DiscoveryEvidenceError("Project must be a real directory.");
    const evidences = (raw.evidences ?? []).filter((evidence) => {
      if (!evidence.sourcePath || !path.isAbsolute(evidence.sourcePath) || !evidence.matchedContent || evidence.matchedContent.trim().length < 6) return false;
      const file = path.resolve(evidence.sourcePath);
      const observed = this.observations.get(file);
      if (path.dirname(file) !== canonicalPath || !observed?.content.includes(evidence.matchedContent.trim()) ||
        !fs.existsSync(file) || fs.realpathSync(file) !== file) return false;
      const current = fs.statSync(file);
      return current.mtimeMs === observed.mtimeMs && current.size === observed.size;
    }).map((evidence) => ({ ...evidence, confidence: 0.8, matchedContent: sanitizeSecretText(evidence.matchedContent.slice(0, 1000)) }));
    if (!evidences.length) throw new DiscoveryEvidenceError("Read project metadata first and quote its actual content as evidence. Unobserved or cross-project evidence is rejected.");
    const registered = this.options.projectRegistry.listProjects().find((project) => project.canonicalPath === canonicalPath);
    const candidateProjectId = registered?.projectId ?? `discovered-${crypto.createHash("sha256").update(`${this.options.nodeId}:${canonicalPath}`).digest("hex").slice(0, 16)}`;
    return {
      ...raw, nodeId: this.options.nodeId, candidateId: raw.candidateId || candidateProjectId,
      candidateProjectId, canonicalPath, projectName: sanitizeSecretText(raw.projectName.slice(0, 200)), projectSummary: sanitizeSecretText(raw.projectSummary.slice(0, 1000)),
      isRegistered: Boolean(registered), verificationStatus: registered ? "verified" : "discovered_unregistered",
      confidence: 0.8, evidences, relevantCapabilities: (raw.relevantCapabilities ?? []).map((capability) => ({ ...capability, name: sanitizeSecretText(capability.name), description: sanitizeSecretText(capability.description) })), relevantMemorySnippets: [],
    };
  }

  private async remember(candidate: DiscoveryCandidate): Promise<void> {
    const projectContext = await resolveProjectContext({ projectRoot: candidate.canonicalPath!, nashHome: this.options.projectRegistry.nashHome });
    const memory = new MemoryService({ projectContext, nashHome: projectContext.nashHome, config: this.options.memoryConfig });
    const content = `${candidate.projectName} 位于 ${candidate.canonicalPath}。${candidate.projectSummary}`;
    const existing = (await memory.getAll("project")).find((entry) => !entry.deprecated && entry.content === content);
    if (existing?.evidence?.some((evidence) => evidence.runId === this.options.runId)) return;
    const entry = await memory.remember({
      scope: "project", projectId: projectContext.projectId, kind: "fact", source: "agent-learned", confidence: candidate.confidence,
      content, tags: ["project-discovery", candidate.projectName.toLowerCase(), ...candidate.relevantCapabilities.map((capability) => capability.name).slice(0, 10)],
      evidence: candidate.evidences.map((evidence) => ({ runId: this.options.runId, sessionId: this.options.taskId, filePath: evidence.sourcePath, toolName: "read_project_meta", summary: evidence.matchedContent.slice(0, 300) })),
    });
    if (!entry) throw new DiscoveryEvidenceError(`Project memory was not persisted for ${candidate.projectName}; report has not been accepted.`);
  }
}
