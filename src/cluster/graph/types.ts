/**
 * Distributed TaskGraph Types & Models (Phase 4)
 * 纯声明式分布式任务图、依赖拓扑、状态机与执行策略契约
 */

export type GraphStatus =
  | "planning"
  | "validating"
  | "ready"
  | "paused"
  | "running"
  | "waiting_approval"
  | "blocked"
  | "replanning"
  | "completed"
  | "partially_completed"
  | "failed"
  | "cancelling"
  | "cancelled"
  | "outcome_unknown";

export type GraphNodeStatus =
  | "pending"
  | "waiting_dependencies"
  | "ready"
  | "queued"
  | "dispatched"
  | "accepted"
  | "running"
  | "waiting_approval"
  | "blocked"
  | "cancelling"
  | "completed"
  | "failed"
  | "skipped"
  | "cancelled"
  | "outcome_unknown";

export type DependencyType =
  | "completion"
  | "success"
  | "artifact"
  | "conditional"
  | "join";

export type FailurePropagationPolicy =
  | "block_dependents"
  | "skip_dependents"
  | "cancel_graph"
  | "allow_degraded";

export type RetryClassification =
  | "none"
  | "transient"
  | "reassignable"
  | "non_retriable"
  | "outcome_unknown";

export type GraphFailureClassification = "PLANNING_CONSTRAINT_VIOLATION" | "RUNTIME_EXECUTION_FAILURE"
  | "MISSING_DEPENDENCY" | "VERIFICATION_FAILURE" | "CAPABILITY_CHANGED" | "APPROVAL_REQUIRED" | "OUTCOME_UNKNOWN";

export interface RequiredSandboxPolicy {
  filesystemMode?: "read-only" | "workspace-write" | "danger-full-access";
  networkMode?: "deny" | "allow";
  approvalMode?: "ask" | "deny";
}

export interface ExecutionStrategyDecision {
  conversationId?: string;
  traceId?: string;
  requiredTargets?: Array<{ key: string; label?: string; platform?: string; nodeId?: string; source?: "platform" | "project" | "named_node" | "cardinality"; candidateNodeIds: string[] }>;
  /** Sequential observation window, not an atomic cluster-wide snapshot. */
  catalogSnapshot?: { startedAt: number; completedAt: number; consistency: "sequential"; nodes: Array<{ nodeId: string; status: string; catalogRevision?: number; projectIds: string[] }> };
  /** 用户显式要求的范围无法被当前集群满足时的确定性说明（不用于派发）。 */
  scopeErrors?: string[];
  mode: "single_agent" | "multi_agent";
  fastPath: boolean;
  complexityScore: number;
  reason: string;
  requiredCapabilities: string[];
  selectedWorkers: Array<{
    nodeId: string;
    projectId?: string;
    reason: string;
    score?: number;
  }>;
  rejectedWorkers: Array<{
    nodeId: string;
    projectId?: string;
    reason: string;
  }>;
  estimatedSubtasks: number;
  estimatedCoordinationOverhead: "low" | "medium" | "high";
  planningSource?: "llm" | "synthesizer_fallback" | "fast_path" | "deterministic_fallback";
  planningDurationMs?: number;
  planningTokens?: { promptTokens: number; completionTokens: number; totalTokens: number };
  planningModel?: string;
  planningError?: string;
  planningRequestIds?: string[];
  planningAttempts?: Array<{ attempt: number; errors: string[]; nodes: GraphProposalNode[] }>;
  evaluatedAt: number;
}

export interface VerificationEvidence {
  verifiedFacts?: string[];
  modifiedFiles?: string[];
  executedTests?: string[];
  testExitCode?: number;
  producedArtifactIds?: string[];
  unresolvedIssues?: string[];
  totalToolCalls?: number;
  schemaValid?: boolean;
  customChecksPassed?: boolean;
  [key: string]: unknown;
}

export interface AcceptanceCriterion {
  type: "artifact_exists" | "test_exit_code" | "file_modified" | "schema_match" | "custom";
  description: string;
  expected?: unknown;
}

export interface ArtifactRequirement {
  name: string;
  producerNodeId: string;
  contentType?: string;
  requiredSha256?: string;
}

export interface ProducedArtifactSpec {
  name: string;
  contentType?: string;
  description?: string;
}

export interface GraphBudget {
  maxNodes: number;
  maxParallelTasks: number;
  maxReplanAttempts: number;
  maxDepth: number;
  totalTimeoutMs: number;
  perTaskTimeoutMs: number;
  /** Missing on legacy graphs: a positive value cannot safely be attributed to a user or an old default. */
  perTaskTimeoutSource?: "none" | "user" | "planner" | "legacy_default" | "unspecified";
}

export interface DistributedGraphNodeRecord {
  graphId: string;
  nodeId: string;
  taskId?: string;
  title: string;
  goal: string;
  description?: string;
  operation: "execute" | "analyze" | "verify" | "synthesize";
  assignedNodeId?: string;
  assignedProjectId?: string;
  explicitNodePinned?: boolean;
  requiredCapabilities: string[];
  requiredSandboxPolicy?: RequiredSandboxPolicy;
  inputs?: Record<string, unknown>;
  expectedOutputs?: string[];
  requiredArtifacts: ArtifactRequirement[];
  producedArtifacts: ProducedArtifactSpec[];
  acceptanceCriteria: AcceptanceCriterion[];
  status: GraphNodeStatus;
  failurePolicy: FailurePropagationPolicy;
  retryPolicy: {
    maxRetries: number;
    backoffMs: number;
    classification?: RetryClassification;
  };
  timeoutMs?: number;
  attemptCount: number;
  workerRunId?: string;
  resultSummary?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  completedAt?: number;
}

export interface DistributedGraphEdgeRecord {
  edgeId: string;
  graphId: string;
  fromNodeId: string;
  toNodeId: string;
  dependencyType: DependencyType;
  requiredOutcome: "completed" | "succeeded" | string;
  artifactRequirements: ArtifactRequirement[];
  createdAt: number;
}

export interface DistributedGraphRecord {
  graphId: string;
  parentGoal: string;
  status: GraphStatus;
  revision: number;
  plannerSessionId?: string;
  budget: GraphBudget;
  concurrencyPolicy: {
    maxConcurrentTasks: number;
    projectWriteLock: boolean;
  };
  strategyDecision?: ExecutionStrategyDecision;
  finalSummary?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}

export interface GraphRevisionRecord {
  id?: number;
  graphId: string;
  revision: number;
  reason: string;
  triggerType?: string;
  diffSummary: {
    addedNodes?: string[];
    removedNodes?: string[];
    addedEdges?: string[];
    removedEdges?: string[];
    modifiedNodes?: string[];
  };
  createdAt: number;
}

export interface GraphVerificationRecord {
  id?: number;
  graphId: string;
  graphNodeId: string;
  verificationType: string;
  status: "passed" | "failed" | "incomplete" | "blocked" | "needs_auth" | "needs_approval" | "outcome_unknown";
  evidence: VerificationEvidence;
  message?: string;
  verifiedAt: number;
}

export interface GraphProposalNode {
  nodeId: string;
  title: string;
  goal: string;
  description?: string;
  operation?: "execute" | "analyze" | "verify" | "synthesize";
  candidateNodeId?: string;
  candidateProjectId?: string;
  explicitNodePinned?: boolean;
  dependencies?: string[];
  dependencyType?: DependencyType;
  requiredCapabilities?: string[];
  requiredSandboxPolicy?: RequiredSandboxPolicy;
  inputs?: Record<string, unknown>;
  expectedOutputs?: string[];
  requiredArtifacts?: ArtifactRequirement[];
  producedArtifacts?: ProducedArtifactSpec[];
  acceptanceCriteria?: AcceptanceCriterion[];
  failurePolicy?: FailurePropagationPolicy;
  timeoutMs?: number;
  retryClassification?: RetryClassification;
}

export interface GraphProposal {
  parentGoal: string;
  reasoning: string;
  nodes: GraphProposalNode[];
  budget?: Partial<GraphBudget>;
  requiresMultiAgent: boolean;
  strategyDecision?: ExecutionStrategyDecision;
}

export interface TaskGraphValidationResult {
  valid: boolean;
  reason?: string;
  topologicalOrder?: string[];
  cyclesDetected?: string[];
  danglingDependencies?: string[];
  unreachableNodes?: string[];
  parallelStages?: string[][];
}

export interface GraphStateSnapshot {
  graphId: string;
  parentGoal: string;
  status: GraphStatus;
  revision: number;
  totalNodes: number;
  completedNodes: number;
  runningNodes: number;
  waitingNodes: number;
  blockedNodes: number;
  failedNodes: number;
  currentPhase: string;
  activeNodesByHost: Record<string, string[]>;
  pendingApprovalsCount: number;
  artifactsCount: number;
  updatedAt: number;
}

// ==========================================
// 乐观并发控制 (OCC) 与原子补丁类型契约
// ==========================================

export class RevisionConflictError extends Error {
  constructor(
    public readonly graphId: string,
    public readonly expectedRevision: number,
    public readonly actualRevision: number,
    message?: string
  ) {
    super(
      message ??
        `Revision conflict on graph '${graphId}': expected revision ${expectedRevision}, but actual revision is ${actualRevision}.`
    );
    this.name = "RevisionConflictError";
  }
}

export interface AtomicGraphPatchSpec {
  operationId?: string;
  graphId: string;
  expectedRevision: number;
  nextRevision: number;
  reason: string;
  diffSummary?: Record<string, unknown>;
  addNodes?: DistributedGraphNodeRecord[];
  updateNodes?: Array<{
    nodeId: string;
    status: GraphNodeStatus;
    assignedNodeId?: string;
    assignedProjectId?: string;
    error?: string;
    resultSummary?: string;
    record?: DistributedGraphNodeRecord;
  }>;
  removeEdges?: Array<{ fromNodeId: string; toNodeId: string }>;
  addEdges?: DistributedGraphEdgeRecord[];
  newGraphStatus?: GraphStatus;
  graphError?: string;
  graphFinalSummary?: string;
}

export interface GraphPatchApplyResult {
  success: boolean;
  graphId: string;
  appliedRevision: number;
  conflict?: boolean;
  replayed?: boolean;
  error?: string;
}
