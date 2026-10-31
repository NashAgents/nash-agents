/**
 * Semantic Task Router & Autonomous Task Dispatch Types
 * Phase 3 核心类型定义
 */

export type TaskOperationType =
  | "inspect"
  | "fix"
  | "test"
  | "deploy"
  | "research"
  | "setup"
  | "environment_check"
  | "general";

export interface TaskConstraints {
  readOnly?: boolean;
  explicitNodeId?: string;
  explicitProjectId?: string;
  preferredNodeId?: string;
  preferredProjectId?: string;
  preferredPlatform?: "darwin" | "linux" | "win32";
  timeoutMs?: number;
  maxSteps?: number;
  allowSideEffects?: boolean;
  requiredPolicy?: {
    filesystem?: "read-only" | "workspace-write" | "full-capability" | "danger-full-access";
    network?: "deny" | "allow";
  };
}

export interface TaskIntent {
  originalRequest: string;
  goal: string;
  operation: TaskOperationType;
  projectHints: string[];
  nodeHints: string[];
  capabilityHints: string[];
  requiredCapabilities: string[];
  preferredCapabilities: string[];
  constraints: TaskConstraints;
  ambiguities: string[];
  riskHints: string[];
  confidence: number;
}

export interface CandidateEvidence {
  sourceType: "project_catalog" | "federated_memory" | "remote_memory" | "skill_catalog" | "mcp_catalog" | "node_hardware";
  referenceId: string;
  summary: string;
  confidence: number;
  freshnessTimestamp: number;
  matchReasons: string[];
}

export interface RoutingCandidate {
  nodeId: string;
  projectId: string;
  projectName: string;
  projectSummary: string;
  technologies: string[];
  capabilities: string[];
  nodeOnline: boolean;
  projectStatus: "active" | "tombstone" | "disabled" | "unknown";
  score: number; // 综合相关度得分 (0.0 ~ 1.0)
  confidence: number; // 事实可信度 (0.0 ~ 1.0)
  hardConstraintsSatisfied: boolean;
  unsatisfiedConstraints: string[];
  evidences: CandidateEvidence[];
  requiredSkillsAvailable: boolean;
  requiredMCPAvailable: boolean;
  blockedReason?: string;
}

export type RoutingDecisionType =
  | "DISPATCH"
  | "CLARIFICATION_REQUIRED"
  | "BLOCKED"
  | "NO_CANDIDATE"
  | "DEFERRED"
  | "MULTI_NODE_REQUIRED"
  | "REPLAN_REQUIRED";

export interface MultiNodeSubTask {
  subTaskId: string;
  nodeId: string;
  projectId: string;
  goal: string;
  requiredCapabilities: string[];
  dependencies: string[];
}

export interface RoutingDecision {
  decisionId: string;
  decisionType: RoutingDecisionType;
  intent: TaskIntent;
  selectedCandidate?: RoutingCandidate;
  alternativeCandidates: RoutingCandidate[];
  reason: string;
  explanation: {
    selectedNodeReason?: string;
    selectedProjectReason?: string;
    whyAlternativesRejected: Array<{
      nodeId: string;
      projectId: string;
      reason: string;
    }>;
    evidencesUsed: string[];
    hardConstraintsChecked: string[];
  };
  clarificationPrompt?: string;
  clarificationOptions?: Array<{
    optionId: string;
    label: string;
    nodeId: string;
    projectId: string;
    description: string;
  }>;
  multiNodePlan?: {
    summary: string;
    subTasks: MultiNodeSubTask[];
    recommendedExecutionOrder: string[];
  };
  blockedReason?: string;
  createdAt: number;
}

export interface RoutingValidationResult {
  valid: boolean;
  code:
    | "VALID"
    | "NODE_NOT_FOUND"
    | "NODE_OFFLINE"
    | "PROJECT_NOT_FOUND"
    | "PROJECT_TOMBSTONE"
    | "PROJECT_ACCESS_DENIED"
    | "CAPABILITY_UNVERIFIED"
    | "CAPABILITY_NEEDS_AUTH"
    | "HARD_CONSTRAINT_VIOLATED"
    | "CATALOG_REVISION_STALE"
    | "SANDBOX_INCOMPATIBLE"
    | "PLATFORM_PATH_MISMATCH"
    | "STALE_SANDBOX_CAPABILITY";
  reason: string;
  details?: Record<string, unknown>;
}

export interface RoutingSessionRecord {
  sessionId: string;
  initialRequest: string;
  currentIntent: TaskIntent;
  decisionHistory: RoutingDecision[];
  currentDecision?: RoutingDecision;
  clarificationHistory: Array<{
    prompt: string;
    userResponse: string;
    timestamp: number;
  }>;
  associatedTaskId?: string;
  associatedRunId?: string;
  status: "analyzing" | "clarifying" | "decided" | "dispatched" | "replanning" | "completed" | "failed";
  createdAt: number;
  updatedAt: number;
}

export type ReplanTriggerType =
  | "NODE_OFFLINE"
  | "PROJECT_UNAVAILABLE"
  | "CAPABILITY_UNAVAILABLE"
  | "AUTHENTICATION_REQUIRED"
  | "EXECUTION_BLOCKED"
  | "REPEATED_FAILURE"
  | "USER_GOAL_CHANGED"
  | "WORKER_REQUESTS_HELP"
  | "RESULT_VALIDATION_FAILED"
  | "MULTI_NODE_REQUIRED";

export interface ReplanEvaluation {
  shouldReplan: boolean;
  trigger: ReplanTriggerType;
  reason: string;
  requiresUserConfirmation: boolean;
  originalRunReconciled: boolean;
  hasSideEffectsOccurred: boolean;
  outcomeUnknown: boolean;
  newGoal?: string;
}

export interface RoutingReplanRecord {
  replanId: string;
  routeId: string;
  taskId: string;
  originalRunId: string;
  trigger: ReplanTriggerType;
  triggerDetails: string;
  originalCandidate: {
    nodeId: string;
    projectId: string;
  };
  newCandidate?: {
    nodeId: string;
    projectId: string;
  };
  status:
    | "intervention_required"
    | "evaluating"
    | "proposed"
    | "reconciled"
    | "dispatched"
    | "blocked"
    | "outcome_unknown";
  outcomeUnknownReason?: string;
  createdAt: number;
  updatedAt: number;
}
