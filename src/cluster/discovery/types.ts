/**
 * Autonomous Discovery & Distributed Scout Agent Types
 * 规范分布式自主发现系统的证据模型、探查范围、报告契约与验证状态
 */

export type DiscoveryVerificationStatus =
  | "verified"
  | "unverified"
  | "discovered_unregistered"
  | "rejected";

export interface DiscoveryEvidence {
  evidenceType: "file_content" | "package_json" | "mcp_tool" | "skill" | "memory_snippet" | "directory_structure";
  sourcePath?: string;
  matchedContent: string;
  confidence: number;
  extractedMetadata?: Record<string, unknown>;
}

export interface DiscoveredCapability {
  capabilityType: "mcp" | "skill" | "service" | "library";
  name: string;
  description: string;
  tools?: string[];
  status?: string;
}

export interface DiscoveryCandidate {
  candidateId: string;
  nodeId: string;
  candidateProjectId?: string;
  projectName: string;
  projectSummary: string;
  canonicalPath?: string;
  isRegistered: boolean;
  verificationStatus: DiscoveryVerificationStatus;
  confidence: number;
  evidences: DiscoveryEvidence[];
  relevantCapabilities: DiscoveredCapability[];
  relevantMemorySnippets: string[];
  suggestedAction?: "register_and_execute" | "use_mcp_capability" | "request_user_clarification" | "direct_execute";
}

/**
 * 单个节点的探查结论。空候选不能单独证明目标不存在；即使执行完成，
 * 也必须结合可验证的授权范围和执行收据判断具体范围是否已覆盖。
 */
export type DiscoveryReportOutcome = "completed" | "partial" | "failed" | "timed_out" | "outcome_unknown";

export interface DiscoveryScanReceipt {
  scannedAt: number;
  authorizedRoots: string[];
  filter: string;
  visitedDirectories: number;
  maxDepth: number;
  truncated: boolean;
  errors: Array<{ path: string; error: string }>;
  scope: string;
}

export interface DiscoveryReport {
  discoveryId: string;
  nodeId: string;
  query: string;
  timestamp: number;
  candidates: DiscoveryCandidate[];
  investigatedPaths: string[];
  investigatedMcpServers: string[];
  scanReceipts?: DiscoveryScanReceipt[];
  scanReceiptsOmitted?: number;
  summary: string;
  durationMs: number;
  error?: string;
  /** 历史报告可能缺少状态，缺省值不能作为覆盖完成的证据。 */
  outcome?: DiscoveryReportOutcome;
  /** 前台等待超时但远端 Scout 仍在执行时为 true。 */
  stillRunning?: boolean;
  taskId?: string;
}

export interface DiscoveryScope {
  nodeIds?: string[];
  allowUnregisteredScanning?: boolean;
  maxNodesToScout?: number;
  /** 仅约束协调器前台等待时长，不会限制 Worker 内 Scout 的实际运行时间。 */
  scoutTimeoutMs?: number;
  /** 显式给 Worker 内 Scout 设定的运行预算；缺省交给 Worker 自身 AgentLoop 预算。 */
  scoutRunBudgetMs?: number;
  maxScoutSteps?: number;
  recoveryOf?: { graphId: string; graphNodeId: string; reason: string };
}

/** Per invocation context; never store a conversation on the shared discovery service. */
export interface DiscoveryRunContext {
  conversationId?: string;
  onTaskDispatched?: (taskId: string, details: { nodeId: string; projectId: string; goal: string }) => void | Promise<void>;
}

export interface AutonomousDiscoveryResult {
  discoveryId: string;
  query: string;
  scoutReports: DiscoveryReport[];
  aggregatedCandidates: DiscoveryCandidate[];
  catalogUpdatesCount: number;
  memoryUpdatesCount: number;
  durationMs: number;
  status?: string;
  offlineClueNodes?: string[];
  summary?: string;
}
