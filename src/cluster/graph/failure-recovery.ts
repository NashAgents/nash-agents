import { createHash } from "node:crypto";
import type { SequencedEvent } from "../protocol/types.js";
import type { WorkspaceSnapshot } from "../worker/verification-snapshot.js";

function validSnapshot(value: any): value is WorkspaceSnapshot {
  return value?.complete === true && value.files && Object.entries(value.files).every(([name, hash]) => !name.startsWith("/") && !name.split("/").includes("..") && typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash))
    && value.digest === createHash("sha256").update(JSON.stringify(Object.entries(value.files).sort())).digest("hex");
}
const testControl = (name: string) => {
  const segments = name.split("/");
  const base = segments.at(-1) ?? "";
  return segments.some(segment => /^(?:tests?|__tests__)$/i.test(segment))
    || /^(?:package(?:-lock)?\.json|pyproject\.toml|pytest\.ini|tox\.ini|conftest\.py)$/i.test(base)
    || /(?:^test[_\.]|_test\.|\.test\.|\.spec\.|\.config\.)/i.test(base);
};

/**
 * 工具尝试级失败分类 (Tool Attempt vs Task Outcome)。
 *
 * 核心原则：一次 Tool Attempt 失败不等于 Agent Task 失败。
 * 任务是否完成由「最终目标达成 + 必要工具成功 + 产物验证」决定；
 * 但任何安全硬拦截、审批拒绝、执行中断、失败尝试已产生工作区副作用、
 * 或失败后没有成功的重试，都不能被模型「已经修好了」的说辞覆盖。
 */
export type ToolFailureClass =
  | "recovered_by_retest"
  | "recovered_inert_attempt"
  | "interrupted"
  | "security_blocked"
  | "approval_denied"
  | "workspace_mutated"
  | "no_successful_retry";

export interface ToolFailureRecord {
  failedToolCallId: string;
  toolName: string;
  classification: ToolFailureClass;
  /** 用于豁免的后续成功调用。 */
  recoveredByToolCallId?: string;
  repairedFiles?: string[];
  workspaceDigest?: string;
}

export interface ToolAttemptClassification {
  attempts: number;
  failedAttempts: number;
  recovered: ToolFailureRecord[];
  unresolved: ToolFailureRecord[];
}

const NON_DISCHARGEABLE_ERROR = /^(?:SecurityBlockError|ApprovalDeniedError)\b/i;
const NON_DISCHARGEABLE_OUTPUT = /\[Security Monitor: (?:BLOCK|REQUIRE_APPROVAL)\]/;

/**
 * 把每个失败的 tool.result 归入「可豁免的瞬时失败」或「必须判定任务失败」。
 *
 * 幂等性论证：失败尝试是否产生副作用，用同一 tool.started → tool.result 区间内
 * 是否出现 file.modified 事件来证明，事件序号由 Worker 顺序分配，不依赖模型文本。
 */
export function classifyToolAttempts(events: SequencedEvent[], failedCalls: SequencedEvent[]): ToolAttemptClassification {
  const owners = new Set(events.map((e) => `${e.taskId}/${e.runId}/${e.nodeId}`));
  const terminal = events.filter((e) => ["task.completed", "task.failed", "task.cancelled"].includes(e.eventType)).at(-1);
  const strict = classifyRecoveredFailures(events, failedCalls);
  const strictRecovered = new Map(strict.recovered.map((item) => [item.failedToolCallId, item]));

  const results = events.filter((e) => e.eventType === "tool.result" && e.data.source === "ToolExecutor");
  const recovered: ToolFailureRecord[] = [];
  const unresolved: ToolFailureRecord[] = [];

  for (const failure of failedCalls) {
    const id = String(failure.data.toolCallId);
    const toolName = String(failure.data.toolName ?? "unknown");
    const mark = (classification: ToolFailureClass, extra?: Partial<ToolFailureRecord>) => {
      const record: ToolFailureRecord = { failedToolCallId: id, toolName, classification, ...extra };
      if (classification === "recovered_by_retest" || classification === "recovered_inert_attempt") recovered.push(record);
      else unresolved.push(record);
    };

    // 1. 安全硬拦截 / 审批拒绝 / 中断：任何模型自我修复都不得覆盖。
    const errorText = String(failure.data.error ?? "");
    const outputText = String(failure.data.output ?? "");
    if (NON_DISCHARGEABLE_ERROR.test(errorText) || NON_DISCHARGEABLE_OUTPUT.test(outputText)) {
      mark("security_blocked");
      continue;
    }
    if (failure.data.interrupted === true) {
      mark("interrupted");
      continue;
    }

    // 2. 任务本身没有成功收尾，讨论豁免没有意义。
    if (owners.size !== 1 || terminal?.eventType !== "task.completed") {
      mark("no_successful_retry");
      continue;
    }

    // 3. 严格路径：测试失败 → 同命令重跑通过且工作区未变（保持原有最强证据要求）。
    const strictHit = strictRecovered.get(id);
    if (strictHit) {
      mark("recovered_by_retest", {
        recoveredByToolCallId: strictHit.retestToolCallId,
        repairedFiles: strictHit.repairedFiles,
        workspaceDigest: strictHit.workspaceDigest,
      });
      continue;
    }

    // 4. 通用路径：失败尝试未改动工作区，且后续同一工具的成功调用接替了这次尝试。
    const started = events.find((e) => e.eventType === "tool.started" && e.data.toolCallId === id && e.seq < failure.seq);
    const mutated = events.some((e) => e.eventType === "file.modified"
      && e.seq > (started?.seq ?? -1) && e.seq <= failure.seq);
    if (mutated) {
      mark("workspace_mutated");
      continue;
    }
    const retry = results
      .filter((e) => e.seq > failure.seq && e.data.success === true && e.data.toolName === failure.data.toolName)
      .at(0);
    if (!retry) {
      mark("no_successful_retry");
      continue;
    }
    mark("recovered_inert_attempt", { recoveredByToolCallId: String(retry.data.toolCallId) });
  }

  return { attempts: results.length, failedAttempts: failedCalls.length, recovered, unresolved };
}

/** History is retained; only exact re-execution with ordered, unchanged-version evidence can discharge a failure. */
export function classifyRecoveredFailures(events: SequencedEvent[], failedCalls: SequencedEvent[]) {
  const owners = new Set(events.map(e => `${e.taskId}/${e.runId}/${e.nodeId}`));
  const terminal = events.filter(e => ["task.completed", "task.failed", "task.cancelled"].includes(e.eventType)).at(-1);
  if (owners.size !== 1 || terminal?.eventType !== "task.completed") return { recovered: [], unresolved: failedCalls.map(e => String(e.data.toolCallId)) };
  const tests = events.filter(e => e.eventType === "verification.test_execution" && e.data.source === "WorkerTaskRunner");
  const final = events.filter(e => e.eventType === "verification.workspace_final" && e.data.source === "WorkerTaskRunner").at(-1);
  const finalSnapshot = final?.data.snapshot;
  const recovered: Array<{ failedToolCallId: string; retestToolCallId: string; repairedFiles: string[]; workspaceDigest: string }> = [];
  const unresolved: string[] = [];
  const bound = (test: SequencedEvent) => {
    const id = test.data.toolCallId;
    const start = events.find(e => e.eventType === "tool.started" && e.data.toolCallId === id && e.seq < test.seq);
    const result = events.find(e => e.eventType === "tool.result" && e.data.source === "ToolExecutor" && e.data.toolCallId === id && e.seq < test.seq);
    const job = events.find(e => ["job.completed", "job.failed"].includes(e.eventType) && e.data.toolCallId === id && e.data.command === test.data.command && e.data.exitCode === test.data.exitCode && e.seq < test.seq);
    try { return !!start && !!result && !!job && JSON.parse(String(start.data.rawArgs)).command.trim() === test.data.command && (result.data.exitCode === undefined || result.data.exitCode === test.data.exitCode) && result.data.success === test.data.success; } catch { return false; }
  };
  for (const failure of failedCalls) {
    const failed = tests.find(e => e.data.toolCallId === failure.data.toolCallId && e.data.success === false && typeof e.data.exitCode === "number" && e.data.exitCode !== 0 && bound(e));
    let recovery: typeof recovered[number] | undefined;
    if (failed && !failure.data.interrupted && validSnapshot(failed.data.before) && validSnapshot(failed.data.after) && failed.data.before.digest === failed.data.after.digest && validSnapshot(finalSnapshot)) {
      for (const retest of tests.filter(e => e.seq > failed.seq && e.data.command === failed.data.command && e.data.success === true && e.data.exitCode === 0 && bound(e))) {
        const before = retest.data.before, after = retest.data.after;
        if (!validSnapshot(before) || !validSnapshot(after) || before.digest !== after.digest || after.digest !== finalSnapshot.digest || final!.seq <= retest.seq) continue;
        const old = failed.data.after as WorkspaceSnapshot;
        const names = [...new Set([...Object.keys(old.files), ...Object.keys(before.files)])];
        const changed = names.filter(name => old.files[name] !== before.files[name]);
        if (!changed.length || changed.some(testControl)) continue;
        const repairEvents = events.filter(e => e.eventType === "file.modified" && e.seq > failed.seq && e.seq < retest.seq);
        if (!changed.every(name => repairEvents.some(e => e.data.relativePath === name && e.data.afterSha256 === before.files[name]))) continue;
        recovery = { failedToolCallId: String(failure.data.toolCallId), retestToolCallId: String(retest.data.toolCallId), repairedFiles: changed, workspaceDigest: after.digest };
        break;
      }
    }
    if (recovery) recovered.push(recovery); else unresolved.push(String(failure.data.toolCallId));
  }
  return { recovered, unresolved };
}
