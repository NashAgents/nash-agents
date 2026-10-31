import { observeGraphPhase } from "./runtime-tracing.js";
import { observeRuntimePhase } from "../../observability/runtime-phase.js";
/**
 * Reflection & Dynamic Replanner (Adaptive Multi-Agent Orchestration 2.0)
 * 任务图自省与受控动态重规划引擎：
 * - 支持新增节点 (addNodes)、依赖重连 (rewireDependencies)、Worker 重分配 (reassignNodes)、受控重试 (retryNodeIds)
 * - 支持失败自愈分支自动重连下游 Join / 依赖节点并解除 blocked 状态
 * - 强制执行 DagValidator 无环/深度/节点数預算校验
 * - 严禁篡改已完成节点历史结果、严禁自动重试 outcome_unknown 写任务、严禁越权提升沙箱策略
 */

import * as crypto from "node:crypto";
import type { IClusterStore } from "../storage/cluster-store.js";
import { DagValidator } from "./dag-validator.js";
import type { DistributedGraphOrchestrator } from "./graph-orchestrator.js";
import {
  RevisionConflictError,
  type AtomicGraphPatchSpec,
  type GraphPatchApplyResult,
} from "./types.js";
import { AutonomousPlanner, type PlannerLlmClient } from "./autonomous-planner.js";
import type {
  DistributedGraphNodeRecord,
  DistributedGraphEdgeRecord,
  GraphProposalNode,
  DependencyType,
} from "./types.js";

export type ReplanTriggerType =
  | "task_failed"
  | "steer"
  | "verification_failed"
  | "artifact_missing"
  | "new_dependency_discovered"
  | "worker_unavailable"
  | "worker_disconnected"
  | "conflict_detected"
  | "goal_incomplete";

export interface RewireDependencySpec {
  nodeId: string;
  addDependencies?: string[];
  removeDependencies?: string[];
  dependencies?: string[];
  dependsOnNodeIds?: string[];
  dependencyType?: DependencyType;
  requiredArtifacts?: import("./types.js").ArtifactRequirement[];
}

export interface ReassignNodeSpec {
  nodeId: string;
  targetNodeId: string;
  targetProjectId?: string;
}

export interface ReplanRequest {
  graphId: string;
  operationId?: string;
  expectedRevision?: number;
  trigger: ReplanTriggerType;
  reason: string;
  failedNodeId?: string;
  steerInstruction?: string;
  addNodes?: GraphProposalNode[];
  rewireDependencies?: RewireDependencySpec[];
  reassignNodes?: ReassignNodeSpec[];
  retryNodeIds?: string[];
  skipNodeIds?: string[];
}

export interface ReplanResult {
  success: boolean;
  replanned: boolean;
  newRevision: number;
  reason: string;
  addedNodeIds: string[];
  addedNodes: string[];
  conflict?: boolean;
  modifiedNodeIds?: string[];
  unblockedNodeIds?: string[];
}

export class GraphReplanner {
  constructor(
    private readonly store: IClusterStore,
    private readonly orchestrator: DistributedGraphOrchestrator,
    private readonly llmClient?: PlannerLlmClient
  ) {}

  private failResult(revision: number, reason: string): ReplanResult {
    return {
      success: false,
      replanned: false,
      newRevision: revision,
      reason,
      addedNodeIds: [],
      addedNodes: [],
    };
  }

  /**
   * 触发图级受控动态重新规划 (Commit New Graph Revision)
   */
  async replanGraph(request: ReplanRequest): Promise<ReplanResult> {
    const {
      graphId,
      trigger,
      reason,
      failedNodeId,
      steerInstruction,
      addNodes,
      rewireDependencies,
      reassignNodes,
      retryNodeIds,
      skipNodeIds,
    } = request;

    const graph = await this.store.getGraph?.(graphId);
    if (!graph) throw new Error(`Graph '${graphId}' not found.`);
    if (!(addNodes?.length || rewireDependencies?.length || reassignNodes?.length || retryNodeIds?.length || skipNodeIds?.length || steerInstruction)) {
      return this.failResult(graph.revision, "An explicit validated patch is required; static recovery is disabled");
    }

    // 1. 预算治理：限制最大 Replan 次数
    if (request.expectedRevision !== undefined && graph.revision !== request.expectedRevision) return { ...this.failResult(graph.revision, "Graph changed while model was replanning"), conflict: true };
    if (graph.revision - 1 >= graph.budget.maxReplanAttempts) {
      await this.store.updateGraphStatus?.(graphId, "failed", {
        error: `Exceeded maximum replan attempts limit (${graph.budget.maxReplanAttempts}). Replan aborted.`,
      });
      return this.failResult(graph.revision, "Max replan attempts exceeded");
    }

    const existingNodes = (await this.store.listGraphNodes?.(graphId)) ?? [];
    const existingEdges = (await this.store.listGraphEdges?.(graphId)) ?? [];
    const nodeMap = new Map<string, DistributedGraphNodeRecord>(
      existingNodes.map((n) => [n.nodeId, { ...n }])
    );

    // 2. 安全边界校验：禁止重试或重派 outcome_unknown 的写任务，禁止篡改已完成节点
    for (const retryId of retryNodeIds ?? []) {
      const target = nodeMap.get(retryId);
      if (!target) {
        return this.failResult(graph.revision, `Cannot retry non-existent node '${retryId}'.`);
      }
      if (target.status === "completed") {
        return this.failResult(
          graph.revision,
          `Safety violation: cannot re-execute already completed node '${retryId}'.`
        );
      }
      if (target.status === "outcome_unknown" && target.operation !== "analyze") {
        return this.failResult(
          graph.revision,
          `Safety violation: cannot automatically retry write task '${retryId}' in outcome_unknown state.`
        );
      }
    }

    for (const reassign of reassignNodes ?? []) {
      const target = nodeMap.get(reassign.nodeId);
      if (!target) {
        return this.failResult(graph.revision, `Cannot reassign non-existent node '${reassign.nodeId}'.`);
      }
      if (target.status === "completed") {
        return this.failResult(
          graph.revision,
          `Safety violation: cannot reassign already completed node '${reassign.nodeId}'.`
        );
      }
      if (target.status === "outcome_unknown" && target.operation !== "analyze") {
        return this.failResult(
          graph.revision,
          `Safety violation: cannot reassign write task '${reassign.nodeId}' in outcome_unknown state.`
        );
      }
    }

    for (const newNode of addNodes ?? []) {
      if (nodeMap.has(newNode.nodeId)) {
        return this.failResult(graph.revision, `Duplicate node ID '${newNode.nodeId}' in replan request.`);
      }
      if (newNode.requiredSandboxPolicy?.filesystemMode === "danger-full-access") {
        return this.failResult(
          graph.revision,
          `Security policy violation: dynamic replan cannot escalate node '${newNode.nodeId}' to danger-full-access.`
        );
      }
    }

    const nextRevision = graph.revision + 1;
    const now = Date.now();
    const addedNodes: DistributedGraphNodeRecord[] = [];
    const addedEdges: DistributedGraphEdgeRecord[] = [];
    const removedEdges: Array<{ fromNodeId: string; toNodeId: string }> = [];
    const modifiedNodeIds = new Set<string>();
    const unblockedNodeIds = new Set<string>();

    // 3. 场景 A: Steer 动态调整或显式 skipNodeIds
    const nodesToSkip = new Set<string>(skipNodeIds ?? []);
    if (trigger === "steer" && steerInstruction) {
      const lower = steerInstruction.toLowerCase();
      if (lower.includes("不要修改") || lower.includes("只输出分析") || lower.includes("只做分析")) {
        for (const n of existingNodes) {
          if (
            n.operation === "execute" &&
            (["waiting_dependencies", "ready", "pending"].includes(n.status) ||
              (n.status === "blocked" && !n.taskId))
          ) {
            nodesToSkip.add(n.nodeId);
          }
        }
      }
    }

    for (const skipId of nodesToSkip) {
      const n = nodeMap.get(skipId);
      if (n && ["running", "accepted", "dispatched", "waiting_approval", "outcome_unknown", "completed"].includes(n.status)) return this.failResult(graph.revision, `Cannot skip active, unknown, approval-pending or completed node '${skipId}'`);
      if (n) {
        n.status = "skipped";
        modifiedNodeIds.add(skipId);
      }
    }

    // 4. 场景 B: 显式添加自定义节点 (例如新发现依赖 "检查 Worker Capability 上报链路")
    if (addNodes && addNodes.length > 0) {
      for (const pNode of addNodes) {
        const hasDeps = Boolean(pNode.dependencies && pNode.dependencies.length > 0);
        const depsSatisfied =
          !hasDeps ||
          pNode.dependencies!.every((depId) => nodeMap.get(depId)?.status === "completed");
        const initialStatus = depsSatisfied ? "ready" : "waiting_dependencies";

        const record: DistributedGraphNodeRecord = {
          graphId,
          nodeId: pNode.nodeId,
          title: pNode.title,
          goal: pNode.goal,
          description: pNode.description ?? pNode.title,
          operation: pNode.operation ?? "analyze",
          assignedNodeId: pNode.candidateNodeId,
          assignedProjectId: pNode.candidateProjectId,
          explicitNodePinned: pNode.explicitNodePinned ?? Boolean(pNode.candidateNodeId),
          requiredCapabilities: pNode.requiredCapabilities ?? [],
          requiredSandboxPolicy: pNode.requiredSandboxPolicy,
          inputs: pNode.inputs,
          expectedOutputs: pNode.expectedOutputs,
          requiredArtifacts: pNode.requiredArtifacts ?? [],
          producedArtifacts: pNode.producedArtifacts ?? [],
          acceptanceCriteria: pNode.acceptanceCriteria ?? [],
          status: initialStatus,
          failurePolicy: pNode.failurePolicy ?? "block_dependents",
          retryPolicy: {
            maxRetries: 1,
            backoffMs: 3000,
            classification: pNode.retryClassification ?? "transient",
          },
          timeoutMs: pNode.timeoutMs,
          attemptCount: 0,
          createdAt: now,
          updatedAt: now,
        };
        addedNodes.push(record);
        nodeMap.set(record.nodeId, record);

        for (const depId of pNode.dependencies ?? []) {
          addedEdges.push({
            edgeId: `edge-${crypto.randomUUID().slice(0, 8)}`,
            graphId,
            fromNodeId: depId,
            toNodeId: pNode.nodeId,
            dependencyType: pNode.dependencyType ?? "success",
            requiredOutcome: "completed",
            artifactRequirements: (pNode.requiredArtifacts ?? []).filter(
              (r) => r.producerNodeId === depId
            ),
            createdAt: now,
          });
        }
      }
    }

    // 6. 场景 D: 显式依赖重连 (rewireDependencies)
    for (const rewire of rewireDependencies ?? []) {
      const targetNode = nodeMap.get(rewire.nodeId);
      if (!targetNode || ["completed", "running", "accepted", "dispatched", "waiting_approval", "outcome_unknown"].includes(targetNode.status)) {
        return this.failResult(
          graph.revision,
          `Cannot rewire dependencies for completed or missing node '${rewire.nodeId}'.`
        );
      }
      if (rewire.requiredArtifacts) targetNode.requiredArtifacts = rewire.requiredArtifacts;
      const replacementDeps = rewire.dependencies ?? rewire.dependsOnNodeIds;
      if (replacementDeps) {
        for (const oldEdge of existingEdges.filter((e) => e.toNodeId === rewire.nodeId)) {
          removedEdges.push({ fromNodeId: oldEdge.fromNodeId, toNodeId: rewire.nodeId });
        }
        for (const addDep of replacementDeps) {
          addedEdges.push({
            edgeId: `edge-${crypto.randomUUID().slice(0, 8)}`,
            graphId,
            fromNodeId: addDep,
            toNodeId: rewire.nodeId,
            dependencyType: rewire.dependencyType ?? "success",
            requiredOutcome: "completed",
            artifactRequirements: [],
            createdAt: now,
          });
        }
      } else {
        for (const remDep of rewire.removeDependencies ?? []) {
          removedEdges.push({ fromNodeId: remDep, toNodeId: rewire.nodeId });
        }
        for (const addDep of rewire.addDependencies ?? []) {
          addedEdges.push({
            edgeId: `edge-${crypto.randomUUID().slice(0, 8)}`,
            graphId,
            fromNodeId: addDep,
            toNodeId: rewire.nodeId,
            dependencyType: rewire.dependencyType ?? "success",
            requiredOutcome: "completed",
            artifactRequirements: [],
            createdAt: now,
          });
        }
      }
      modifiedNodeIds.add(rewire.nodeId);
    }

    // 7. 场景 E: Worker 重新分配 (reassignNodes) 与节点重试 (retryNodeIds)
    for (const reassign of reassignNodes ?? []) {
      const target = nodeMap.get(reassign.nodeId)!;
      target.assignedNodeId = reassign.targetNodeId;
      if (reassign.targetProjectId) {
        target.assignedProjectId = reassign.targetProjectId;
      }
      target.taskId = undefined;
      target.error = undefined;
      target.status = "waiting_dependencies";
      modifiedNodeIds.add(target.nodeId);
      unblockedNodeIds.add(target.nodeId);
    }

    for (const retryId of retryNodeIds ?? []) {
      const target = nodeMap.get(retryId)!;
      target.taskId = undefined;
      target.error = undefined;
      target.status = "waiting_dependencies";
      modifiedNodeIds.add(target.nodeId);
      unblockedNodeIds.add(target.nodeId);
    }

    // 8. 计算投影边集合并执行 DagValidator 无环与预算验证
    const removeKeySet = new Set(removedEdges.map((e) => `${e.fromNodeId}->${e.toNodeId}`));
    const projectedEdges: DistributedGraphEdgeRecord[] = [
      ...existingEdges.filter((e) => !removeKeySet.has(`${e.fromNodeId}->${e.toNodeId}`)),
      ...addedEdges,
    ];

    const proposalNodesForValidation: GraphProposalNode[] = Array.from(nodeMap.values()).map(
      (n) => ({
        nodeId: n.nodeId,
        title: n.title,
        goal: n.goal,
        operation: n.operation,
        dependencies: projectedEdges
          .filter((e) => e.toNodeId === n.nodeId)
          .map((e) => e.fromNodeId),
        // 重规划后的 Join 必须与初次规划受同一套产物引用校验，否则改名/重连会绕过它。
        dependencyType: projectedEdges.some((e) => e.toNodeId === n.nodeId && e.dependencyType === "join")
          ? "join" as const
          : projectedEdges.find((e) => e.toNodeId === n.nodeId)?.dependencyType,
        requiredArtifacts: n.requiredArtifacts,
        producedArtifacts: n.producedArtifacts,
      })
    );

    const effectiveBudget = graph.budget;
    const dagValidation = DagValidator.validateProposal(
      proposalNodesForValidation,
      effectiveBudget
    );
    if (!dagValidation.valid) {
      return this.failResult(
        graph.revision,
        `Replan rejected by DagValidator: ${dagValidation.reason}`
      );
    }

    for (const rewire of rewireDependencies ?? []) {
      const node = nodeMap.get(rewire.nodeId)!;
      const impossible = projectedEdges.find((edge) => edge.toNodeId === node.nodeId && edge.dependencyType !== "completion" &&
        ["failed", "skipped", "cancelled"].includes(nodeMap.get(edge.fromNodeId)?.status ?? ""));
      const invalidInput = node.requiredArtifacts.find((input) => ["failed", "skipped", "cancelled"].includes(nodeMap.get(input.producerNodeId)?.status ?? ""));
      if (impossible || invalidInput) return this.failResult(graph.revision,
        `Rewired node '${node.nodeId}' still requires superseded producer '${impossible?.fromNodeId ?? invalidInput?.producerNodeId}'. Remove its success dependency and replace its requiredArtifacts with the validated replacement producer.`);
    }

    // 9. 自动解除因前置修复/重连而具备继续执行条件的下游 blocked 节点
    for (const node of nodeMap.values()) {
      if (node.status === "blocked") {
        const inEdges = projectedEdges.filter((e) => e.toNodeId === node.nodeId);
        const hasImpossibleUpstream = inEdges.some((e) => {
          const parent = nodeMap.get(e.fromNodeId);
          return !parent || ["failed", "cancelled", "outcome_unknown"].includes(parent.status);
        });
        if (!hasImpossibleUpstream && inEdges.length > 0) {
          node.status = "waiting_dependencies";
          node.error = undefined;
          modifiedNodeIds.add(node.nodeId);
          unblockedNodeIds.add(node.nodeId);
        }
      }
    }

    const addedIdsList = addedNodes.map((n) => n.nodeId);
    const diffSummary = {
      addedNodes: addedIdsList, addedEdges: addedEdges.map((e) => e.edgeId),
      removedEdges: removedEdges.map((e) => `${e.fromNodeId}->${e.toNodeId}`),
      modifiedNodes: Array.from(modifiedNodeIds),
    };
    if (!this.store.applyGraphPatchAtomic) return this.failResult(graph.revision, "Atomic graph store is required");
    const applied = await observeGraphPhase(this.store, graphId, "graph_patch", () => this.store.applyGraphPatchAtomic!({
      operationId: request.operationId ?? crypto.createHash("sha256").update(JSON.stringify(request)).digest("hex"),
      graphId, expectedRevision: graph.revision, nextRevision, reason, diffSummary,
      addNodes: addedNodes, removeEdges: removedEdges, addEdges: addedEdges, newGraphStatus: "running",
      updateNodes: Array.from(modifiedNodeIds).map((id) => ({ nodeId: id, status: nodeMap.get(id)!.status, record: nodeMap.get(id)! })),
    }), result => result.success ? "ok" : "error");
    if (!applied.success) return { ...this.failResult(applied.appliedRevision, applied.error ?? "Revision conflict"), conflict: applied.conflict };
    const eventPayload = { graphId, revision: nextRevision, newRevision: nextRevision, trigger, reason,
      addedNodesCount: addedNodes.length, addedNodeIds: addedIdsList,
      modifiedNodeIds: Array.from(modifiedNodeIds), unblockedNodeIds: Array.from(unblockedNodeIds) };
    await this.store.appendGraphEvent?.(graphId, "graph.revision_committed", eventPayload);
    await this.store.appendGraphEvent?.(graphId, "graph.replan_committed", eventPayload);

    // 12. 立即驱动一次依赖推进
    await this.orchestrator.advanceGraph(graphId);

    return {
      success: true,
      replanned: true,
      newRevision: nextRevision,
      reason,
      addedNodeIds: addedIdsList,
      addedNodes: addedIdsList,
      modifiedNodeIds: Array.from(modifiedNodeIds),
      unblockedNodeIds: Array.from(unblockedNodeIds),
    };
  }
  /**
   * 基于真实失败上下文与 LLM 智能推理生成 Graph Patch 并原子提交
   */
  async replanWithLlm(options: {
    graphId: string;
    trigger: ReplanTriggerType;
    failedNodeId?: string;
    failureDetails?: {
      error?: string;
      resultSummary?: string;
      unresolvedIssues?: string[];
      missingArtifacts?: string[];
    };
    steerInstruction?: string;
  }): Promise<ReplanResult> {
    return observeGraphPhase(this.store, options.graphId, "replanner", async () => {
    const { graphId, trigger, failedNodeId, failureDetails, steerInstruction } = options;
    const graph = await this.store.getGraph?.(graphId);
    if (!graph) throw new Error("Graph " + graphId + " not found.");

    const existingNodes = (await this.store.listGraphNodes?.(graphId)) ?? [];
    const client = this.llmClient ?? AutonomousPlanner.createDefaultLlmClient();

    if (!client) return this.failResult(graph.revision, "LLM replanner is unavailable; no static recovery was executed");
    const previousAttempts = (await this.store.listGraphEvents?.(graphId) ?? []).filter((e) => e.eventType === "graph.replan_started");
    if (previousAttempts.length >= graph.budget.maxReplanAttempts) return this.failResult(graph.revision, "Persisted LLM replan request budget exhausted");
    await this.store.appendGraphEvent?.(graphId, "graph.replan_started", { failedNodeId, trigger, expectedRevision: graph.revision });
    const started = performance.now();

    try {
      const systemPrompt = "You are the Nash Autonomous Graph Replanner.\nA task in the current DAG failed, produced invalid evidence, or requires dynamic adaptation.\nAnalyze the failure context and propose a minimal, high-precision Graph Patch to recover and complete the user goal.\n\nOUTPUT FORMAT (JSON ONLY):\n{\n  \"reason\": \"Clear explanation of the replanning decision\",\n  \"addNodes\": [\n    {\n      \"nodeId\": \"unique-kebab-id (e.g. fix-missing-dependency)\",\n      \"title\": \"Concise title\",\n      \"goal\": \"Specific execution instruction addressing root cause\",\n      \"operation\": \"analyze\" | \"execute\",\n      \"dependencies\": [\"prior-completed-or-new-node-ids\"],\n      \"candidateNodeId\": \"target worker if pinned\",\n      \"producedArtifacts\": [ { \"name\": \"artifact.md\", \"contentType\": \"text/markdown\" } ],\n      \"acceptanceCriteria\": [ { \"type\": \"artifact_exists\", \"expected\": \"artifact.md\", \"description\": \"criteria\" } ]\n    }\n  ],\n  \"rewireDependencies\": [\n    {\n      \"nodeId\": \"existing-downstream-node-id\",\n      \"addDependencies\": [\"newly-added-fix-node-id\"]\n    }\n  ],\n  \"skipNodeIds\": [\"optional-node-ids-to-safely-skip\"]\n}\nCRITICAL RULES:\n1. Do NOT re-execute already completed nodes.\n2. Output pure JSON without markdown backticks.";

      const failures = existingNodes.filter((n) => n.status === "failed");
      const failureEvents = (await Promise.all(failures.map((n) => n.taskId ? this.store.getEventsForTask(n.taskId, 0, 100000) : []))).flat();
      const strictPrompt = systemPrompt + "\nrequiredSandboxPolicy must be an object such as {\"filesystemMode\":\"read-only\",\"networkMode\":\"deny\"}, never a string. Replace dependencies on failed nodes rather than only adding dependencies; update requiredArtifacts when their producer changes. Use exact candidateNodeId AND candidateProjectId from the supplied catalog. Include requiredSandboxPolicy and requiredCapabilities. Required capabilities must be exact entries from the supplied worker catalog; graph-scoped artifact tools are attached by the harness, not installed worker capabilities. When replacement nodes supersede failed originals, mark only the superseded failed originals skipped so their historical failure remains auditable while final verification can evaluate the repaired path. Respect the original read-only scope, do not change host services or credentials. Rewire requiredArtifacts along with changed dependencies; retain existing completed results. You may retry a failed node after a new repair dependency, but must never retry completed or outcome_unknown write tasks. Return no patch if safe recovery is impossible.";
      const userContent = JSON.stringify({
        edges: await this.store.listGraphEdges?.(graphId),
        rejectedProposals: (await this.store.listGraphEvents?.(graphId) ?? []).filter((e) => e.eventType === "graph.replan_rejected").slice(-2),
        failureEvents: failureEvents.filter((e) => ["tool.result", "tool.started", "job.failed", "task.failed"].includes(e.eventType)).slice(-40),
        verificationEvidence: await this.store.listGraphVerifications?.(graphId, failedNodeId),
        parentGoal: graph.parentGoal,
        currentRevision: graph.revision,
        capabilities: await new AutonomousPlanner({ store: this.store }).planningCapabilities(),
        existingNodes: existingNodes.map((n) => ({
          nodeId: n.nodeId,
          title: n.title,
          status: n.status,
          operation: n.operation,
          resultSummary: n.resultSummary,
          assignedNodeId: n.assignedNodeId, assignedProjectId: n.assignedProjectId,
          requiredArtifacts: n.requiredArtifacts, producedArtifacts: n.producedArtifacts,
          error: n.error,
        })),
        failedNodeId,
        trigger,
        failureDetails,
        steerInstruction,
      });

      let rawText = "";
      let modelResponse: any;
      if (client.chat) {
        const res = await client.chat([
          { role: "system", content: strictPrompt },
          { role: "user", content: userContent },
        ], undefined, { purpose: "replanner", context: { graphId, graphRevision: graph.revision, traceId: graph.strategyDecision?.traceId } });
        modelResponse = res;
        rawText = res.content ?? "";
      } else if (client.complete) {
        const res = await client.complete([
          { role: "system", content: strictPrompt },
          { role: "user", content: userContent },
        ]);
        modelResponse = res;
        rawText = res.message?.content ?? "";
      }

      const jsonMatch = rawText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error("LLM did not return valid JSON for replan");
      }
      const patch = JSON.parse(jsonMatch[0]);

      await this.store.appendGraphEvent?.(graphId, "graph.replan_proposed", {
        failedNodeId, trigger, failureDetails, patch, expectedRevision: graph.revision,
        model: modelResponse?.model, requestId: modelResponse?.requestId ?? modelResponse?.id,
        usage: modelResponse?.usage, durationMs: performance.now() - started,
      });
      if (!patch.addNodes?.length && !patch.rewireDependencies?.length && !patch.retryNodeIds?.length && !patch.reassignNodes?.length) {
        return this.failResult(graph.revision, patch.reason ?? "Model proposed no recovery; graph remains unresolved");
      }
      const constraintErrors = await new AutonomousPlanner({ store: this.store }).validatePlanConstraints(patch.addNodes ?? []);
      if (constraintErrors.length) {
        await this.store.appendGraphEvent?.(graphId, "graph.replan_rejected", { patch, errors: constraintErrors });
        if (previousAttempts.length + 1 < graph.budget.maxReplanAttempts) {
          await this.store.appendGraphEvent?.(graphId, "graph.replan_retrying", { expectedRevision: graph.revision, reason: "plan_constraints", errors: constraintErrors });
          return this.replanWithLlm(options);
        }
        return this.failResult(graph.revision, constraintErrors.join("; "));
      }
      const applied = await this.replanGraph({
        graphId, expectedRevision: graph.revision,
        operationId: modelResponse?.requestId ?? modelResponse?.id ?? crypto.randomUUID(),
        trigger, reason: patch.reason || ("LLM dynamic replan triggered by " + trigger),
        failedNodeId, steerInstruction,
        addNodes: patch.addNodes, rewireDependencies: patch.rewireDependencies,
        skipNodeIds: patch.skipNodeIds, retryNodeIds: patch.retryNodeIds, reassignNodes: patch.reassignNodes,
      });
      if (!applied.success) {
        await this.store.appendGraphEvent?.(graphId, "graph.replan_rejected", { patch, errors: [applied.reason] });
        // Only repair invalid graph proposals; conflicts and unsafe operations require external reconciliation.
        if (!applied.conflict && applied.reason.startsWith("Replan rejected by DagValidator:") && previousAttempts.length + 1 < graph.budget.maxReplanAttempts) {
          await this.store.appendGraphEvent?.(graphId, "graph.replan_retrying", { expectedRevision: graph.revision, reason: "dag_validation", errors: [applied.reason] });
          return this.replanWithLlm(options);
        }
      }
      return applied;
    } catch (err) {
      await this.store.appendGraphEvent?.(graphId, "graph.replan_failed", { durationMs: performance.now() - started, failedNodeId, error: err instanceof Error ? err.message : "Model replanning failed" });
      return this.failResult(graph.revision, "LLM replanning failed; no static recovery was executed");
    }
    }, result => result.success ? "ok" : "error");
  }
}
