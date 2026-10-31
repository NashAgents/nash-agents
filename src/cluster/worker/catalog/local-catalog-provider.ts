import type { ProjectRegistry } from "../project-registry.js";
import { SkillService } from "../../../skills/skill-service.js";
import { MCPManager } from "../../../mcp/mcp-manager.js";
import { detectNodeHardwareCapabilities } from "./hardware-detector.js";
import { ProjectRegistryAdapter } from "./project-registry-adapter.js";
import { SkillServiceAdapter } from "./skill-service-adapter.js";
import { MCPManagerAdapter } from "./mcp-manager-adapter.js";
import { MemoryFederationAdapter } from "./memory-federation-adapter.js";
import type {
  CatalogSyncSnapshotPayload,
  CatalogSyncDeltaPayload,
  RemoteMemorySearchPayload,
  RemoteMemorySearchResponsePayload,
  CatalogTombstoneItem,
  NodeHardwareCapability,
} from "../../protocol/types.js";

export interface LocalCatalogProviderOptions {
  nodeId: string;
  projectRegistry: ProjectRegistry;
  skillService?: SkillService;
  mcpManager?: MCPManager;
  nashHome?: string;
}

export class LocalCatalogProvider {
  public readonly projectAdapter: ProjectRegistryAdapter;
  public readonly skillAdapter: SkillServiceAdapter;
  public readonly mcpAdapter: MCPManagerAdapter;
  public readonly memoryAdapter: MemoryFederationAdapter;
  private readonly nodeId: string;
  private currentRevision = 1;
  private pendingTombstones: CatalogTombstoneItem[] = [];
  private hardwareCapabilities?: NodeHardwareCapability[];

  private verifiedHardwareSnapshot(): NodeHardwareCapability[] {
    const sandbox = this.hardwareCapabilities?.find((c) => c.category === "sandbox");
    if (!this.hardwareCapabilities || !sandbox?.structuredDetails?.verificationExpiresAt
      || sandbox.structuredDetails.verificationExpiresAt <= Date.now()) {
      this.hardwareCapabilities = detectNodeHardwareCapabilities();
    }
    // Retain the original verification time; catalog sync must not extend capability TTL.
    return this.hardwareCapabilities;
  }

  constructor(options: LocalCatalogProviderOptions) {
    this.nodeId = options.nodeId;
    this.projectAdapter = new ProjectRegistryAdapter(
      options.projectRegistry,
      options.nodeId,
      options.nashHome
    );

    const skillSvc = options.skillService ?? new SkillService({ nashHome: options.nashHome });
    this.skillAdapter = new SkillServiceAdapter(skillSvc, options.nodeId);

    const mcpMgr = options.mcpManager ?? new MCPManager({ nashHome: options.nashHome });
    this.mcpAdapter = new MCPManagerAdapter(mcpMgr, options.nodeId);

    this.memoryAdapter = new MemoryFederationAdapter({
      nodeId: options.nodeId,
      projectRegistry: options.projectRegistry,
      projectAdapter: this.projectAdapter,
      nashHome: options.nashHome,
    });
  }

  getRevision(): number {
    return this.currentRevision;
  }

  incrementRevision(): number {
    this.currentRevision++;
    return this.currentRevision;
  }

  recordTombstone(tombstone: CatalogTombstoneItem): void {
    const revision = this.incrementRevision();
    this.pendingTombstones.push({
      ...tombstone,
      nodeId: this.nodeId,
      revision,
      deletedAt: Date.now(),
    });
  }

  acknowledgeRevision(revision: number): void {
    this.pendingTombstones = this.pendingTombstones.filter((entry) => entry.revision > revision);
  }

  /**
   * 生成当前节点的完整全量 Catalog 快照
   */
  async getSnapshot(): Promise<CatalogSyncSnapshotPayload> {
    const revision = this.currentRevision;
    const hardwareCapabilities = this.verifiedHardwareSnapshot();
    const projects = this.projectAdapter.exportCatalogItems(revision);
    const skills = await this.skillAdapter.exportCatalogItems();
    const mcp = this.mcpAdapter.exportCatalogItems(revision);
    const memoryIndex = await this.memoryAdapter.exportFederatedIndex(revision);

    return {
      nodeId: this.nodeId,
      catalogRevision: revision,
      hardwareCapabilities,
      projects,
      skills,
      mcp,
      memoryIndex,
    };
  }

  /**
   * 生成增量同步 Payload
   */
  async getDelta(): Promise<CatalogSyncDeltaPayload> {
    const revision = this.currentRevision;
    const hardwareCapabilities = this.verifiedHardwareSnapshot();
    const projects = this.projectAdapter.exportCatalogItems(revision);
    const skills = await this.skillAdapter.exportCatalogItems();
    const mcp = this.mcpAdapter.exportCatalogItems(revision);
    const memoryIndex = await this.memoryAdapter.exportFederatedIndex(revision);

    const delta: CatalogSyncDeltaPayload = {
      nodeId: this.nodeId,
      catalogRevision: revision,
      hardwareCapabilities,
      projectsUpsert: projects,
      projectsDelete: this.pendingTombstones.filter((t) => t.revision <= revision && t.resourceType === "project"),
      skillsUpsert: skills,
      skillsDelete: this.pendingTombstones.filter((t) => t.revision <= revision && t.resourceType === "skill"),
      mcpUpsert: mcp,
      mcpDelete: this.pendingTombstones.filter((t) => t.revision <= revision && t.resourceType === "mcp"),
      memoryIndexUpsert: memoryIndex,
      memoryIndexComplete: true,
      memoryIndexDelete: this.pendingTombstones.filter((t) => t.revision <= revision && t.resourceType === "memory"),
    };

    return delta;
  }

  /**
   * 处理远程记忆检索请求
   */
  async handleRemoteMemorySearch(
    request: RemoteMemorySearchPayload
  ): Promise<RemoteMemorySearchResponsePayload> {
    return this.memoryAdapter.handleRemoteSearch(request);
  }
}
