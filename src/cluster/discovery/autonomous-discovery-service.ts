/**
 * Autonomous Discovery Service
 * 负责在 Catalog 检索不足、存在歧义或用户显式要求探查时，跨集群节点并行唤起分布式 Scout Agent
 * 自动收集物理证据，经由 DiscoveryResultValidator 严格审查，并增量更新 Catalog 与联邦记忆
 */

import * as crypto from "node:crypto";
import type {
  AutonomousDiscoveryResult,
  DiscoveryCandidate,
  DiscoveryReport,
  DiscoveryScope,
  DiscoveryRunContext,
} from "./types.js";
import { DiscoveryResultValidator } from "./discovery-validator.js";
import type { IClusterStore } from "../storage/cluster-store.js";
import type { ProjectCatalogItem, FederatedMemoryIndexItem } from "../protocol/types.js";
import type { NodeRegistry } from "../coordinator/node-registry.js";
import type { TaskScheduler } from "../coordinator/task-scheduler.js";
import type { EventBus } from "../../observability/event-bus.js";
import { normalizeProjectName } from "../coordinator/catalog/cluster-search-service.js";
import { defaultTraceContext } from "../../observability/trace-context.js";
import { changeGoalRun } from "../coordinator/goal-run-service.js";

export interface AutonomousDiscoveryServiceOptions {
  store: IClusterStore;
  registry: NodeRegistry;
  scheduler?: TaskScheduler;
  eventBus?: EventBus;
  validator?: DiscoveryResultValidator;
  defaultTimeoutMs?: number;
  maxScoutSteps?: number;
}

export class DiscoveryRecoveryError extends Error {
  constructor(message: string) { super(message); this.name = "DiscoveryRecoveryError"; }
}

export class AutonomousDiscoveryService {
  private readonly store: IClusterStore;
  private readonly registry: NodeRegistry;
  private readonly scheduler?: TaskScheduler;
  private readonly eventBus?: EventBus;
  private readonly validator: DiscoveryResultValidator;
  private readonly defaultTimeoutMs: number;
  private readonly maxScoutSteps?: number;

  constructor(options: AutonomousDiscoveryServiceOptions) {
    this.store = options.store;
    this.registry = options.registry;
    this.scheduler = options.scheduler;
    this.eventBus = options.eventBus;
    this.validator = options.validator ?? new DiscoveryResultValidator(this.store, this.registry);
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 180000;
    // 统一复用原生 Harness 预算，不再硬编码固定 6 步截断
    this.maxScoutSteps = options.maxScoutSteps;
  }

  private recovery?: Promise<void>;
  private readonly recovered = new Set<string>();

  recoverHistoricalReports(): Promise<void> {
    if (this.recovery) return this.recovery;
    this.recovery = this.recoverReports().finally(() => { this.recovery = undefined; });
    return this.recovery;
  }

  private async recoverReports(): Promise<void> {
    for (const task of await this.store.listTasks({ status: "completed", limit: 100000 })) {
      if (this.recovered.has(task.taskId)) continue;
      for (const event of await this.store.getEventsForTask(task.taskId, 0, 100000)) {
        if (event.eventType === "discovery.report_persisted" && event.runId === task.runId && event.nodeId === task.nodeId) {
          await this.ingestPersistedReport(event.data.report as DiscoveryReport, task.nodeId);
        }
      }
      this.recovered.add(task.taskId);
    }
  }

  /** Authenticated Worker receipts are durable and may come from ordinary tasks as well as Scouts. */
  async ingestPersistedReport(report: DiscoveryReport, nodeId: string): Promise<void> {
    if (!report || report.nodeId !== nodeId || !Array.isArray(report.candidates) || !Number.isFinite(report.timestamp)) {
      throw new DiscoveryRecoveryError("Invalid persisted discovery report or node identity mismatch");
    }
    const validation = await this.validator.validateReport(report);
    if (validation.rejectedCandidates.length) throw new DiscoveryRecoveryError("Persisted discovery report failed evidence validation");
    for (const candidate of validation.validatedCandidates) {
      candidate.candidateProjectId ??= `discovered-${crypto.createHash("sha256").update(`${nodeId}:${candidate.canonicalPath ?? candidate.projectName}`).digest("hex").slice(0, 16)}`;
      if (!await this.updateCatalogFromCandidate(candidate, report.timestamp) || !await this.updateMemoryFromCandidate(candidate, report.query, report.timestamp)) {
        throw new DiscoveryRecoveryError(`Discovery persistence failed for ${candidate.projectName}`);
      }
    }
  }

  /**
   * 启动分布式自主发现流程
   */
  async discover(query: string, scope?: DiscoveryScope, context?: DiscoveryRunContext): Promise<AutonomousDiscoveryResult> {
    let recoveryOf: { graphId: string; graphNodeId: string; taskId: string; reason: string } | undefined;
    if (scope?.recoveryOf) {
      const request = scope.recoveryOf;
      const goalId = defaultTraceContext.get()?.goalRunId;
      const goal = goalId ? await this.store.getGoalRun?.(goalId) : undefined;
      if (!request.reason?.trim() || !goal?.linkedGraphIds.includes(request.graphId)) throw new DiscoveryRecoveryError("Recovery requires a reason and a graph belonging to the current GoalRun");
      const attempts = await this.store.listGraphTaskAttempts?.(request.graphId, request.graphNodeId) ?? [];
      const failed = attempts.at(-1);
      if (!failed || failed.status !== "failed") throw new DiscoveryRecoveryError("Recovery requires the latest attempt to have failed");
      recoveryOf = { ...request, taskId: failed.taskId };
    }
    const discoveryId = `disc-${crypto.randomUUID().slice(0, 10)}`;
    const startTime = Date.now();

    const emit = (type: string, data: Record<string, unknown>) => this.emitEvent(type, { ...data, conversationId: context?.conversationId });
    emit("discovery.started", {
      discoveryId,
      query,
      timestamp: startTime,
    });

    // 1. 确定目标探查节点列表 (先复用记忆，定向核验已知目标)
    const resolved = await this.resolveTargetNodes(scope, query);
    const { knownClueNodes, allKnownClueNodesOffline } = resolved;
    if (scope?.maxNodesToScout !== undefined && (!Number.isSafeInteger(scope.maxNodesToScout) || scope.maxNodesToScout < 1)) throw new DiscoveryRecoveryError("maxNodesToScout must be a positive integer");
    const uniqueTargets = [...new Set(resolved.targetNodeIds)];
    const targetNodeIds = uniqueTargets.slice(0, scope?.maxNodesToScout ?? uniqueTargets.length);
    const goalRunId = defaultTraceContext.get()?.goalRunId;
    if (goalRunId) {
      const selectedAt = Date.now(), snapshotStartedAt = Date.now();
      const nodes = await this.store.listNodes();
      const nodeIds = [...new Set([...nodes.map(node => node.nodeId), ...resolved.targetNodeIds, ...knownClueNodes])].sort();
      const snapshot = await Promise.all(nodeIds.map(async nodeId => ({ nodeId, connected: Boolean(this.registry.getConnection(nodeId)), catalogRevision: (await this.store.getCatalogRevision(nodeId))?.revision })));
      const snapshotCompletedAt = Date.now();
      await changeGoalRun(this.store, goalRunId, goal => {
        const scopes = goal.discoveryScopes ?? [];
        if (!scopes.some(entry => entry.discoveryId === discoveryId)) goal.discoveryScopes = [...scopes, {
          version: (scopes.at(-1)?.version ?? 0) + 1, discoveryId, query, selectedAt, snapshotStartedAt, snapshotCompletedAt,
          selectionSource: scope?.nodeIds?.length ? "explicit_nodes" : knownClueNodes.length ? "catalog_clues" : "online_snapshot",
          requestedNodeIds: scope?.nodeIds ? [...scope.nodeIds] : undefined, selectedNodeIds: [...targetNodeIds], knownClueNodeIds: [...knownClueNodes],
          snapshot, allowUnregisteredScanning: scope?.allowUnregisteredScanning ?? true, truncatedByLimit: targetNodeIds.length < uniqueTargets.length, recoveryOf,
        }];
        goal.status = "running"; goal.executionState = "running"; goal.finalReport = undefined; goal.reportFingerprint = undefined; goal.reportState = "pending"; goal.completedAt = undefined;
        return goal;
      });
    }

    if (allKnownClueNodesOffline) {
      const offlineSummary = `项目 "${query}" 在集群记忆中已定位到节点 (${knownClueNodes.join(", ")})，但已知目标节点当前均处于离线状态，避免无依据地遍历其他机器。`;
      emit("discovery.completed", {
        discoveryId,
        query,
        targetNodeIds: [],
        candidatesFound: 0,
        status: "known_nodes_offline",
        knownClueNodes,
        summary: offlineSummary,
      });

      return {
        discoveryId,
        query,
        scoutReports: [],
        aggregatedCandidates: [],
        catalogUpdatesCount: 0,
        memoryUpdatesCount: 0,
        durationMs: Date.now() - startTime,
        status: "known_nodes_offline",
        offlineClueNodes: knownClueNodes,
        summary: offlineSummary,
      };
    }

    if (targetNodeIds.length === 0) {
      emit("discovery.completed", {
        discoveryId,
        query,
        targetNodeIds: [],
        candidatesFound: 0,
        status: "no_online_nodes",
      });

      return {
        discoveryId,
        query,
        scoutReports: [],
        aggregatedCandidates: [],
        catalogUpdatesCount: 0,
        memoryUpdatesCount: 0,
        durationMs: Date.now() - startTime,
        status: "no_online_nodes",
      };
    }

    // 2. 并行派发 Scout Agents 调查各节点
    const waitMs = scope?.scoutTimeoutMs ?? this.defaultTimeoutMs;
    const scoutTasks = targetNodeIds.map((nodeId) =>
      this.runScoutOnNode(discoveryId, nodeId, query, {
        waitTimeoutMs: waitMs,
        runBudgetMs: scope?.scoutRunBudgetMs,
        maxSteps: scope?.maxScoutSteps ?? this.maxScoutSteps,
        allowUnregisteredScanning: scope?.allowUnregisteredScanning ?? true,
        recoveryOf,
      }, context).then((report) => {
        const eventType = report.outcome === "outcome_unknown" ? "discovery.scout_outcome_unknown" : report.outcome === "timed_out" && report.stillRunning ? "discovery.scout_wait_expired" : report.outcome === "failed" ? "discovery.scout_failed" : "discovery.scout_completed";
        emit(eventType, { discoveryId, nodeId, taskId: report.taskId, error: report.error, outcome: report.outcome, summary: report.summary, durationMs: report.durationMs });
        return report;
      })
    );

    // 独立分支绝不互相拖垮：任一节点抛错只记录该节点的失败，其余分支结果照常保留。
    const settled = await Promise.allSettled(scoutTasks);
    const scoutReports = settled.map((entry, index) => entry.status === "fulfilled"
      ? entry.value
      : {
          discoveryId,
          nodeId: targetNodeIds[index]!,
          query,
          timestamp: Date.now(),
          candidates: [],
          investigatedPaths: [],
          investigatedMcpServers: [],
          summary: `Scout on node ${targetNodeIds[index]} aborted without a report.`,
          durationMs: 0,
          error: entry.reason instanceof Error ? entry.reason.message : String(entry.reason),
          outcome: "failed" as const,
        });

    // 3. 结果核验与证据交叉审查 (DiscoveryResultValidator)
    const allValidatedCandidates: DiscoveryCandidate[] = [];
    for (const report of scoutReports) {
      emit("discovery.report_received", {
        discoveryId,
        nodeId: report.nodeId,
        candidatesCount: report.candidates.length,
        summary: report.summary,
      });

      const validation = await this.validator.validateReport(report);
      if (validation.valid) {
        allValidatedCandidates.push(...validation.validatedCandidates);
      }
    }

    // 4. Discovery -> Catalog -> Memory 反馈更新闭环 (Section 7)
    let catalogUpdatesCount = 0;
    let memoryUpdatesCount = 0;

    for (const cand of allValidatedCandidates) {
      cand.candidateProjectId ??= `discovered-${crypto.createHash("sha256").update(`${cand.nodeId}:${cand.canonicalPath ?? cand.projectName}`).digest("hex").slice(0, 16)}`;
      if (cand.verificationStatus === "verified" || cand.verificationStatus === "discovered_unregistered") {
        // 更新 Catalog
        const updatedCat = await this.updateCatalogFromCandidate(cand);
        if (updatedCat) catalogUpdatesCount++;

        // 更新联邦记忆
        const updatedMem = await this.updateMemoryFromCandidate(cand, query);
        if (updatedMem) memoryUpdatesCount++;
      }
    }

    // 5. 候选按置信度排序
    allValidatedCandidates.sort((a, b) => b.confidence - a.confidence);

    const durationMs = Date.now() - startTime;
    emit("discovery.completed", {
      discoveryId,
      query,
      scoutCount: targetNodeIds.length,
      validatedCandidatesCount: allValidatedCandidates.length,
      status: scoutReports.some(report => report.outcome === "outcome_unknown") ? "outcome_unknown" : scoutReports.some(report => report.stillRunning) ? "background_running" : "partial",
      catalogUpdatesCount,
      memoryUpdatesCount,
      durationMs,
    });

    return {
      discoveryId,
      query,
      scoutReports,
      aggregatedCandidates: allValidatedCandidates,
      catalogUpdatesCount,
      memoryUpdatesCount,
      durationMs,
    };
  }

  /**
   * 在目标节点上运行 Scout Agent
   */
  private async runScoutOnNode(
    discoveryId: string,
    nodeId: string,
    query: string,
    options: { waitTimeoutMs: number; runBudgetMs?: number; maxSteps?: number; allowUnregisteredScanning?: boolean; recoveryOf?: { graphId: string; graphNodeId: string; taskId: string; reason: string } },
    context?: DiscoveryRunContext
  ): Promise<DiscoveryReport> {
    const scoutStart = Date.now();

    try {
      // 1. 若在线且具备 WSS 连接与调度器，真正向目标远程节点派发 Scout 任务 (Section 6.2 铁律: 调用目标节点原生 AgentLoop)
      const conn = this.registry.getConnection(nodeId);
      const nodeRecord = await this.store.getNode(nodeId);
      const registeredProjects: Array<{ name: string; projectId: string }> =
        (nodeRecord?.metadata as any)?.projects || [];
      const mcpList = await this.store.listMCPCatalog({ nodeId });

      if (this.scheduler && conn) {
        const targetProjectId = registeredProjects[0]?.projectId || "discovery";
        const task = await this.scheduler.createTask({
          nodeId,
          projectId: targetProjectId,
          goal: `[分布式 Scout 探查任务] 调查本节点上是否存在与 "${query}" 相关的项目代码、服务、MCP能力或本地记忆`,
          prompt: `探查目标: 调查本节点上是否存在与 "${query}" 相关的项目、服务、MCP能力或本地记忆。
请使用 inspect_local_projects, inspect_local_mcp, read_project_meta 等工具进行调查。登记表不包含全部磁盘项目；允许时用 scan_local_projects 搜索未登记项目，审批拒绝或搜索范围有限时如实说明限制。
调查完毕后，必须调用 submit_discovery_report 提交结构化报告。非空候选必须有真实 canonicalPath 及 read_project_meta 已读取的文件内容证据；该工具负责写入对应项目记忆并上报联邦索引。`,
          // 只有显式 runBudgetMs 才限制 Worker 内 Scout 的运行时间；缺省交给 Worker 自身预算。
          timeoutMs: options.runBudgetMs,
          maxSteps: options.maxSteps,
          beforeDispatch: async (task) => {
            await context?.onTaskDispatched?.(task.taskId, { nodeId, projectId: targetProjectId, goal: task.goal });
          },
          contextOverrides: {
            isDiscovery: true,
            discoveryId,
            conversationId: context?.conversationId,
            query,
            allowUnregisteredScanning: options.allowUnregisteredScanning,
            recoveryOf: options.recoveryOf,
          },
        });

        // Persist ownership before broadcasting so a reconnect sees the same tasks.
        this.emitEvent("discovery.scout_dispatched", {
          conversationId: context?.conversationId,
          discoveryId,
          nodeId,
          taskId: task.taskId,
          projectId: targetProjectId,
          query,
          goal: task.goal,
        });
        this.emitEvent("coordinator.task_dispatched", {
          conversationId: context?.conversationId,
          taskId: task.taskId,
          nodeId,
          projectId: targetProjectId,
          goal: task.goal,
          isScout: true,
        });

        // 轮询等待远程 Worker 完工 (最多等待 timeoutMs)
        const pollIntervalMs = 800;
        const maxWaitMs = options.waitTimeoutMs;
        const startWait = Date.now();
        let finishedTask: any = null;

        while (Date.now() - startWait < maxWaitMs) {
          const t = await this.store.getTask(task.taskId);
          if (t && ["completed", "failed", "cancelled", "outcome_unknown"].includes(t.status)) {
            finishedTask = t;
            break;
          }
          await new Promise((r) => setTimeout(r, pollIntervalMs));
        }

        if (!finishedTask) {
          // 前台放弃等待 ≠ 扫描完成。远端任务继续执行，后续经 discovery.report_persisted 回流。
          return {
            discoveryId,
            nodeId,
            query,
            timestamp: Date.now(),
            candidates: [],
            investigatedPaths: [],
            investigatedMcpServers: mcpList.map((m) => m.serverId),
            summary: `Scout on node ${nodeId} is still running after the ${Math.round(maxWaitMs / 1000)}s front-end wait window; no conclusion may be drawn for this node yet.`,
            durationMs: Date.now() - scoutStart,
            outcome: "timed_out",
            stillRunning: true,
            taskId: task.taskId,
          };
        }

        if (finishedTask.status !== "completed") {
          return {
            discoveryId,
            nodeId,
            query,
            timestamp: Date.now(),
            candidates: [],
            investigatedPaths: [],
            investigatedMcpServers: mcpList.map((m) => m.serverId),
            summary: `Scout task on node ${nodeId} ended as ${finishedTask.status}.`,
            durationMs: Date.now() - scoutStart,
            error: finishedTask.error || `Scout task ended as ${finishedTask.status}`,
            outcome: finishedTask.status === "outcome_unknown" ? "outcome_unknown" : "failed",
            taskId: task.taskId,
          };
        }

        const receipt = (await this.store.getEventsForTask(task.taskId, 0, 100000)).filter(event =>
          event.eventType === "discovery.report_persisted" && event.runId === finishedTask.runId && event.nodeId === nodeId
        ).map(event => event.data.report as DiscoveryReport).reverse().find(report => report?.nodeId === nodeId && Array.isArray(report.candidates));
        if (receipt) {
          // Coverage is decided by the persisted scan receipts, not by the answer text.
          const scans = Array.isArray(receipt.scanReceipts) ? receipt.scanReceipts : [];
          const complete = scans.length > 0 && !(receipt.scanReceiptsOmitted ?? 0)
            && scans.every(scan => !scan.truncated && (scan.errors?.length ?? 0) === 0 && (scan.authorizedRoots?.length ?? 0) > 0);
          return {
            discoveryId,
            nodeId,
            query,
            timestamp: Date.now(),
            candidates: receipt.candidates,
            investigatedPaths: receipt.investigatedPaths,
            investigatedMcpServers: receipt.investigatedMcpServers,
            scanReceipts: receipt.scanReceipts,
            summary: receipt.summary,
            durationMs: Date.now() - scoutStart,
            outcome: complete ? "completed" : "partial",
            taskId: task.taskId,
          };
        }
        return {
          discoveryId,
          nodeId,
          query,
          timestamp: Date.now(),
          candidates: [],
          investigatedPaths: [],
          investigatedMcpServers: mcpList.map((m) => m.serverId),
          summary: `Scout task on node ${nodeId} completed without a deliverable report.`,
          durationMs: Date.now() - scoutStart,
          error: "Scout completed without a structured report",
          outcome: "failed",
          taskId: task.taskId,
        };
      }

      throw new DiscoveryRecoveryError("Remote Scout unavailable; refusing to probe Coordinator filesystem as a remote node");
    } catch (err: any) {
      return {
        discoveryId,
        nodeId,
        query,
        timestamp: Date.now(),
        candidates: [],
        investigatedPaths: [],
        investigatedMcpServers: [],
        summary: `Scout dispatch failed on node ${nodeId}: ${err.message || String(err)}`,
        durationMs: Date.now() - scoutStart,
        error: err.message || String(err),
        outcome: "failed",
      };
    }
  }

  /**
   * 将验证通过的发现成果增量沉淀至 Project Catalog
   */
  private async updateCatalogFromCandidate(candidate: DiscoveryCandidate, observedAt = Date.now()): Promise<boolean> {
    try {
      const existing = candidate.candidateProjectId
        ? await this.store.getProjectCatalog(candidate.nodeId, candidate.candidateProjectId)
        : null;
      if (existing && existing.lastIndexedAt >= observedAt) return true;

      const technologies = Array.from(
        new Set([
          ...(existing?.technologies || []),
          ...candidate.evidences.map((e) => e.extractedMetadata?.technology as string).filter(Boolean),
        ])
      );

      const capabilities = Array.from(
        new Set([
          ...(existing?.capabilities || []),
          ...candidate.relevantCapabilities.map((c) => c.name),
        ])
      );

      const catalogItem: ProjectCatalogItem = {
        projectId: candidate.candidateProjectId || `proj-${candidate.projectName.toLowerCase().replace(/[^a-z0-9_-]/g, "")}`,
        nodeId: candidate.nodeId,
        name: candidate.projectName,
        summary: candidate.projectSummary,
        description: candidate.projectSummary,
        technologies,
        capabilities,
        status: "active",
        registeredAt: existing?.registeredAt || Date.now(),
        updatedAt: observedAt,
        lastIndexedAt: observedAt,
        revision: (existing?.revision || 0) + 1,
        visibility: existing?.visibility || "discoverable",
        canonicalPath: candidate.canonicalPath || existing?.canonicalPath,
        userAliases: existing?.userAliases || [candidate.projectName],
      };

      await this.store.upsertProjectCatalog([catalogItem]);
      return true;
    } catch (err) {
      console.warn(`[AutonomousDiscoveryService] Failed to upsert project catalog:`, err);
      return false;
    }
  }

  /**
   * 将验证通过的事实与上下文沉淀至联邦记忆索引
   */
  private async updateMemoryFromCandidate(candidate: DiscoveryCandidate, query: string, observedAt = Date.now()): Promise<boolean> {
    try {
      const entryId = `mem-disc-${crypto.createHash("sha256").update(`${candidate.nodeId}:${candidate.candidateProjectId}`).digest("hex").slice(0, 24)}`;
      const existing = (await this.store.listMemoryIndex({ nodeId: candidate.nodeId, projectId: candidate.candidateProjectId })).find((entry) => entry.entryId === entryId);
      if (existing && existing.updatedAt >= observedAt) return true;
      const keywords = Array.from(
        new Set([
          ...query.toLowerCase().split(/[\s,，、._\-/+]+/).filter(Boolean),
          ...candidate.projectName.toLowerCase().split(/[\s_-]+/).filter(Boolean),
          ...candidate.relevantCapabilities.map((c) => c.name.toLowerCase()),
        ])
      );

      const memItem: FederatedMemoryIndexItem = {
        entryId,
        nodeId: candidate.nodeId,
        projectId: candidate.candidateProjectId || "discovered-resources",
        topic: `Discovery: ${candidate.projectName}`,
        summary: candidate.projectSummary,
        keywords,
        sourceReference: candidate.evidences[0]?.sourcePath || "Scout Discovery Report",
        confidence: candidate.confidence,
        visibility: candidate.isRegistered ? "retrievable" : "summary",
        revision: (existing?.revision ?? 0) + 1,
        updatedAt: observedAt,
      };

      await this.store.upsertMemoryIndex([memItem]);
      return true;
    } catch (err) {
      console.warn(`[AutonomousDiscoveryService] Failed to upsert federated memory:`, err);
      return false;
    }
  }

  /**
   * 解析需要探查的目标节点
   * 优先复用联邦记忆与项目目录中的已知线索进行定向核验，杜绝无依据地向全网盲目广播
   */
  private async resolveTargetNodes(
    scope?: DiscoveryScope,
    query?: string
  ): Promise<{ targetNodeIds: string[]; knownClueNodes: string[]; allKnownClueNodesOffline: boolean }> {
    if (scope?.nodeIds && scope.nodeIds.length > 0) {
      return { targetNodeIds: scope.nodeIds, knownClueNodes: scope.nodeIds, allKnownClueNodesOffline: false };
    }

    // 若未显式指定目标节点，首先在联邦记忆与目录中查找是否已有该项目的明确归属节点
    const normQ = normalizeProjectName(query);
    let knownClueNodes: string[] = [];

    if (normQ) {
      try {
        const memEntries = (await this.store.listMemoryIndex?.()) ?? [];
        const catProjects = (await this.store.listProjectsCatalog?.()) ?? [];

        const matchedMem = memEntries.filter(
          (m) =>
            normalizeProjectName(m.topic) === normQ ||
            normalizeProjectName(m.topic).includes(normQ) ||
            normalizeProjectName(m.summary).includes(normQ) ||
            (m.keywords ?? []).some((k) => normalizeProjectName(k) === normQ)
        );

        const matchedCat = catProjects.filter(
          (p) =>
            normalizeProjectName(p.name) === normQ ||
            normalizeProjectName(p.name).includes(normQ) ||
            (p.userAliases ?? []).some((a) => normalizeProjectName(a) === normQ)
        );

        knownClueNodes = Array.from(
          new Set([...matchedMem.map((m) => m.nodeId), ...matchedCat.map((p) => p.nodeId)])
        ).filter(Boolean);
      } catch (err) {
        console.warn("[AutonomousDiscoveryService] Failed to query existing memory/catalog clues:", err);
      }
    }

    // 若记忆中存在明确的项目节点线索：
    if (knownClueNodes.length > 0) {
      const onlineKnownNodes = knownClueNodes.filter((nodeId) => {
        const conn = this.registry.getConnection(nodeId);
        return conn !== undefined;
      });

      if (onlineKnownNodes.length === 0) {
        // 已知目标节点当前均处于离线状态！
        // 核心准则：已知节点离线时明确反馈，坚决杜绝无依据地遍历其他机器
        return { targetNodeIds: [], knownClueNodes, allKnownClueNodesOffline: true };
      }

      // 将核验严格限制在已知目标节点
      return { targetNodeIds: onlineKnownNodes, knownClueNodes, allKnownClueNodesOffline: false };
    }

    // 仅在完全没有已知记忆/目录线索时，才降级为在所有在线节点上探查
    const onlineConns = this.registry.listOnlineConnections();
    if (onlineConns.length > 0) {
      return { targetNodeIds: onlineConns.map((c) => c.nodeId), knownClueNodes: [], allKnownClueNodesOffline: false };
    }

    const allNodes = await this.store.listNodes();
    const onlineNodes = allNodes.filter((n) => n.status === "online").map((n) => n.nodeId);
    return { targetNodeIds: onlineNodes, knownClueNodes: [], allKnownClueNodesOffline: false };
  }

  private emitEvent(type: string, data: Record<string, unknown>): void {
    if (this.eventBus) {
      this.eventBus.emit({
        id: crypto.randomUUID(),
        type: type as any,
        timestamp: new Date().toISOString(),
        projectId: "cluster-discovery",
        sessionId: "discovery-session",
        data,
      });
    }
  }
}
