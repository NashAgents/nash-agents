import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { Readable } from "node:stream";
import { ApprovalService } from "../src/approval/approval-service.js";
import type { ApprovalDecision, ApprovalRequest } from "../src/approval/types.js";
import { FileSystemAccess } from "../src/sandbox/filesystem-access.js";
import { SandboxService } from "../src/sandbox/sandbox-service.js";
import { createDefaultSandboxPolicy } from "../src/sandbox/policy.js";
import { PreToolSecurityMonitor } from "../src/security/security-monitor.js";
import { InMemoryClusterStore } from "../src/cluster/storage/in-memory-cluster-store.js";
import { ProductStore } from "../src/product/store.js";
import type { ProductInitInput } from "../src/product/types.js";
import { ProductHttpApi } from "../src/product/http-api.js";
import { WorkerTaskRunner, validateTaskFullAccessPolicy } from "../src/cluster/worker/worker-task-runner.js";
import { ProjectRegistry } from "../src/cluster/worker/project-registry.js";
import { TaskSecurityGrantService } from "../src/cluster/coordinator/task-security-grant-service.js";
import type {
  ClusterApprovalRecord,
  ClusterTaskRecord,
  TaskSecurityGrant,
} from "../src/cluster/storage/cluster-store-types.js";
import type {
  TaskGrantSecurityPayload,
  TaskDispatchPayload,
  TaskGrantSecurityAckPayload,
  TaskRevokeSecurityAckPayload,
} from "../src/cluster/protocol/types.js";
import { WebRequestError } from "../src/cluster/coordinator/web-security.js";

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nash-grant-test-"));
  return dir;
}

function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

const FULL_ACCESS = {
  filesystem: { mode: "danger-full-access" as const },
  network: { mode: "allow" as const },
  approval: { mode: "auto-grant" as const },
};

function makePayload(overrides: Partial<TaskDispatchPayload> & { taskId: string; runId: string; projectId: string; goal: string }): TaskDispatchPayload {
  return { dispatchAttempt: 1, connectionGeneration: 1, ...overrides };
}

function makeRunner(taskId = "task-1", runId = "run-1", nodeId = "node-1") {
  const workspace = makeTmpDir();
  const projectRegistry = new ProjectRegistry({ customDir: path.join(workspace, ".nash") });
  const project = projectRegistry.registerProject(workspace, "proj-test");
  const runner = new WorkerTaskRunner(
    makePayload({ taskId, runId, projectId: project.projectId, goal: "Goal" }),
    projectRegistry,
    nodeId,
    "node-coord",
    null,
  );
  return { runner, workspace, project };
}

function wireRunner(runner: WorkerTaskRunner, workspace: string) {
  const policy = createDefaultSandboxPolicy();
  const fsAccess = new FileSystemAccess({ workspaceRoot: workspace, policy });
  const sandboxService = new SandboxService({ cwd: workspace, policy });
  (runner as any).isRunning = true;
  (runner as any).fsAccess = fsAccess;
  (runner as any).sandboxService = sandboxService;
  (runner as any).currentPolicy = policy;
  (runner as any).preGrantPolicy = createDefaultSandboxPolicy();
  return { fsAccess, sandboxService };
}

function grantPayload(overrides: Partial<TaskGrantSecurityPayload> = {}): TaskGrantSecurityPayload {
  return {
    grantId: "grant-1",
    approvalId: "appr-1",
    nodeId: "node-1",
    taskId: "task-1",
    runId: "run-1",
    targetPolicy: structuredClone(FULL_ACCESS),
    configurationVersion: 1,
    grantedAt: Date.now(),
    authorizedBy: "admin",
    ...overrides,
  };
}

function makeTask(overrides: Partial<ClusterTaskRecord> = {}): ClusterTaskRecord {
  const now = Date.now();
  return {
    taskId: "task-1",
    runId: "run-1",
    nodeId: "node-1",
    projectId: "proj-1",
    goal: "goal",
    status: "waiting_approval",
    dispatchAttempt: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeApproval(overrides: Partial<ClusterApprovalRecord> = {}): ClusterApprovalRecord {
  const now = Date.now();
  return {
    approvalId: "appr-1",
    taskId: "task-1",
    runId: "run-1",
    nodeId: "node-1",
    agentId: "main",
    capability: "filesystem-outside-workspace",
    reason: "outside workspace write",
    status: "pending",
    requestedAt: now,
    expiresAt: now + 60_000,
    ...overrides,
  };
}

function makeGrant(overrides: Partial<TaskSecurityGrant> = {}): TaskSecurityGrant {
  return {
    grantId: "grant-1",
    approvalId: "appr-1",
    nodeId: "node-1",
    taskId: "task-1",
    runId: "run-1",
    authorizationMode: "task-full-access",
    originalPolicy: createDefaultSandboxPolicy(),
    targetPolicy: structuredClone(FULL_ACCESS),
    authorizedBy: "admin",
    grantedAt: Date.now(),
    status: "applied",
    configurationVersion: 1,
    ...overrides,
  };
}

interface FakeSchedulerOptions {
  grant?: (grant: TaskSecurityGrant) => Promise<{ success: boolean; message?: string; timedOut?: boolean; effectivePolicy?: any }>;
  revoke?: (grant: TaskSecurityGrant) => Promise<{ success: boolean; message?: string }>;
}

function fakeScheduler(options: FakeSchedulerOptions = {}) {
  const calls = { grant: [] as string[], revoke: [] as string[] };
  return {
    calls,
    async grantTaskSecurity(grant: TaskSecurityGrant) {
      calls.grant.push(grant.grantId);
      if (options.grant) return options.grant(grant);
      return { success: true, effectivePolicy: grant.targetPolicy };
    },
    async revokeTaskSecurity(grant: TaskSecurityGrant) {
      calls.revoke.push(grant.grantId);
      if (options.revoke) return options.revoke(grant);
      return { success: true };
    },
  } as any;
}

function fakeRegistry(online: boolean) {
  return {
    getConnection: (nodeId: string) => (online ? { ws: { readyState: 1 }, nodeId } : undefined),
  } as any;
}

async function seed(store: InMemoryClusterStore, task: Partial<ClusterTaskRecord> = {}, approval: Partial<ClusterApprovalRecord> = {}) {
  await store.saveTask(makeTask(task));
  await store.saveApproval(makeApproval(approval));
}

const sampleProductInit = (security: any): ProductInitInput => ({
  role: "coordinator-worker",
  coordinator: { listenHost: "127.0.0.1", listenPort: 18443 },
  models: {
    main: {
      baseUrl: "https://provider.invalid/v1",
      model: "main-v1",
      apiKey: "fixture-model-secret-never-persist-plain",
      format: "responses",
    },
  },
  security,
  admin: { username: "admin", password: "fixture-password-2026" },
});

// ---------------------------------------------------------------------------
// 1. 常规审批语义
// ---------------------------------------------------------------------------

test("workspace-write 下工作区外写入仍逐次审批", async () => {
  let asked = false;
  const approvalService = new ApprovalService({
    provider: {
      async askApproval(req: ApprovalRequest): Promise<ApprovalDecision> {
        asked = true;
        assert.equal(req.capability, "filesystem-outside-workspace");
        return "deny";
      },
    },
  });
  const workspace = makeTmpDir();
  try {
    const fsAccess = new FileSystemAccess({ workspaceRoot: workspace, policy: createDefaultSandboxPolicy(), approvalService });
    await assert.rejects(fsAccess.resolveForWrite("/etc/test-config-file"), /ApprovalDeniedError/);
    assert.equal(asked, true);
  } finally { cleanup(workspace); }
});

test("放行一次只生效一次，不改变持久策略", async () => {
  let askCount = 0;
  const approvalService = new ApprovalService({
    provider: {
      async askApproval(): Promise<ApprovalDecision> {
        askCount++;
        return askCount === 1 ? "allow-once" : "deny";
      },
    },
  });
  const workspace = makeTmpDir();
  const outside = makeTmpDir();
  try {
    const fsAccess = new FileSystemAccess({ workspaceRoot: workspace, policy: createDefaultSandboxPolicy(), approvalService });
    const outsideFile = path.join(outside, "file.txt");
    assert.ok(await fsAccess.resolveForWrite(outsideFile));
    assert.equal(askCount, 1);
    await assert.rejects(fsAccess.resolveForWrite(outsideFile), /ApprovalDeniedError/);
    assert.equal(askCount, 2);
    assert.equal(fsAccess.getPolicy().filesystem.mode, "workspace-write");
  } finally { cleanup(workspace); cleanup(outside); }
});

// ---------------------------------------------------------------------------
// 2. Worker 侧授权应用
// ---------------------------------------------------------------------------

test("授权只提升目标 Task/Run，且三处策略同时生效", async () => {
  const { runner, workspace } = makeRunner();
  try {
    const { fsAccess, sandboxService } = wireRunner(runner, workspace);
    let resolved: ApprovalDecision | undefined;
    (runner as any).approvalProvider = { resolveApproval: (_id: string, decision: ApprovalDecision) => { resolved = decision; return true; } };

    const result = runner.applyTaskSecurityGrant(grantPayload());
    assert.equal(result.success, true);
    assert.equal(runner.hasActiveGrant(), true);

    for (const policy of [fsAccess.getPolicy(), sandboxService.getPolicy(), runner.getCurrentPolicy()!]) {
      assert.equal(policy.filesystem.mode, "danger-full-access");
      assert.equal(policy.network.mode, "allow");
      assert.equal(policy.approval.mode, "auto-grant");
    }
    assert.equal(resolved, "allow-once");
    assert.equal(result.effectivePolicy?.approval.mode, "auto-grant");
  } finally { cleanup(workspace); }
});

test("同节点其他 Task 不会获得授权", async () => {
  const a = makeRunner("task-A", "run-A");
  const b = makeRunner("task-B", "run-B");
  try {
    const wiredA = wireRunner(a.runner, a.workspace);
    const wiredB = wireRunner(b.runner, b.workspace);
    assert.equal(a.runner.applyTaskSecurityGrant(grantPayload({ taskId: "task-A", runId: "run-A", grantId: "grant-A", approvalId: "appr-A" })).success, true);
    assert.equal(wiredA.fsAccess.getPolicy().filesystem.mode, "danger-full-access");
    assert.equal(wiredB.fsAccess.getPolicy().filesystem.mode, "workspace-write");
    assert.equal(wiredB.sandboxService.getPolicy().network.mode, "deny");
    assert.equal(b.runner.hasActiveGrant(), false);
  } finally { cleanup(a.workspace); cleanup(b.workspace); }
});

test("节点 / Task / Run 身份不一致的授权被拒绝", async () => {
  const { runner, workspace } = makeRunner();
  try {
    wireRunner(runner, workspace);
    for (const bad of [
      grantPayload({ nodeId: "node-2" }),
      grantPayload({ runId: "run-other" }),
      grantPayload({ taskId: "task-other" }),
    ]) {
      const result = runner.applyTaskSecurityGrant(bad);
      assert.equal(result.success, false);
      assert.match(result.error ?? "", /identity/i);
    }
    assert.equal(runner.hasActiveGrant(), false);
  } finally { cleanup(workspace); }
});

test("已结束的任务无法提权", async () => {
  const { runner, workspace } = makeRunner();
  try {
    wireRunner(runner, workspace);
    (runner as any).isRunning = false;
    const result = runner.applyTaskSecurityGrant(grantPayload());
    assert.equal(result.success, false);
    assert.match(result.error ?? "", /identity/i);
  } finally { cleanup(workspace); }
});

test("启动窗口内（沙箱服务尚未构建）绝不假装授权成功", async () => {
  const { runner, workspace } = makeRunner();
  try {
    (runner as any).isRunning = true;
    let resolved = false;
    (runner as any).approvalProvider = { resolveApproval: () => { resolved = true; return true; } };
    const result = runner.applyTaskSecurityGrant(grantPayload());
    assert.equal(result.success, false);
    assert.match(result.error ?? "", /not initialized/i);
    assert.equal(runner.hasActiveGrant(), false);
    assert.equal(resolved, false);
  } finally { cleanup(workspace); }
});

test("部分生效必须完整回滚，不得留下半提权状态", async () => {
  const { runner, workspace } = makeRunner();
  try {
    const { sandboxService } = wireRunner(runner, workspace);
    (runner as any).fsAccess = {
      getPolicy: () => createDefaultSandboxPolicy(),
      updatePolicy: () => { throw new Error("disk failure while swapping file policy"); },
    };
    let resolved = false;
    (runner as any).approvalProvider = { resolveApproval: () => { resolved = true; return true; } };

    const result = runner.applyTaskSecurityGrant(grantPayload());
    assert.equal(result.success, false);
    assert.match(result.error ?? "", /disk failure/);
    assert.equal(runner.hasActiveGrant(), false);
    assert.equal(resolved, false);
    // 沙箱已回滚到授权前策略
    assert.equal(sandboxService.getPolicy().filesystem.mode, "workspace-write");
    assert.equal(sandboxService.getPolicy().network.mode, "deny");
    assert.equal(runner.getCurrentPolicy()?.filesystem.mode, "workspace-write");
  } finally { cleanup(workspace); }
});

test("非既定提权策略被拒绝", async () => {
  const { runner, workspace } = makeRunner();
  try {
    wireRunner(runner, workspace);
    const result = runner.applyTaskSecurityGrant(grantPayload({
      targetPolicy: { filesystem: { mode: "danger-full-access" }, network: { mode: "deny" }, approval: { mode: "auto-grant" } },
    }));
    assert.equal(result.success, false);
    assert.match(result.error ?? "", /Unexpected grant target policy/);
    assert.equal(validateTaskFullAccessPolicy(FULL_ACCESS), undefined);
  } finally { cleanup(workspace); }
});

test("过期配置版本的授权被拒绝", async () => {
  const { runner, workspace } = makeRunner();
  try {
    wireRunner(runner, workspace);
    runner.setBoundConfigurationVersion(7);
    const stale = runner.applyTaskSecurityGrant(grantPayload({ configurationVersion: 6 }));
    assert.equal(stale.success, false);
    assert.match(stale.error ?? "", /Stale grant/);
    assert.equal(runner.applyTaskSecurityGrant(grantPayload({ grantId: "grant-2", configurationVersion: 7 })).success, true);
  } finally { cleanup(workspace); }
});

test("重复授权消息幂等，审批只解除一次", async () => {
  const { runner, workspace } = makeRunner();
  try {
    wireRunner(runner, workspace);
    let resolveCount = 0;
    (runner as any).approvalProvider = { resolveApproval: () => { resolveCount++; return true; } };
    assert.equal(runner.applyTaskSecurityGrant(grantPayload()).success, true);
    assert.equal(runner.applyTaskSecurityGrant(grantPayload()).success, true);
    assert.equal(resolveCount, 1);
    // 不同 grantId 的第二次授权必须被拒绝（同一 Run 不允许叠加）
    assert.equal(runner.applyTaskSecurityGrant(grantPayload({ grantId: "grant-2" })).success, false);
  } finally { cleanup(workspace); }
});

test("撤销授权恢复到授权前的真实策略", async () => {
  const { runner, workspace } = makeRunner();
  try {
    const { fsAccess, sandboxService } = wireRunner(runner, workspace);
    assert.equal(runner.applyTaskSecurityGrant(grantPayload()).success, true);
    const revoke = runner.revokeTaskSecurityGrant("grant-1", "global policy tightened");
    assert.equal(revoke.reverted, true);
    assert.equal(runner.hasActiveGrant(), false);
    for (const policy of [fsAccess.getPolicy(), sandboxService.getPolicy(), runner.getCurrentPolicy()!]) {
      assert.equal(policy.filesystem.mode, "workspace-write");
      assert.equal(policy.network.mode, "deny");
      assert.equal(policy.approval.mode, "ask");
    }
  } finally { cleanup(workspace); }
});

// ---------------------------------------------------------------------------
// 3. 存储层状态机
// ---------------------------------------------------------------------------

test("授权记录按审批唯一，且只有 applied 才可作为授权依据", async () => {
  const store = new InMemoryClusterStore();
  assert.equal(await store.saveTaskSecurityGrant(makeGrant({ status: "granted" })), true);
  assert.equal(await store.getActiveTaskSecurityGrant("task-1", "run-1"), null);
  assert.equal(await store.saveTaskSecurityGrant(makeGrant({ grantId: "grant-2" })), false, "同一审批不得重复授权");

  assert.equal(await store.transitionTaskSecurityGrant("grant-1", ["granted"], "applied"), true);
  assert.equal((await store.getActiveTaskSecurityGrant("task-1", "run-1"))?.grantId, "grant-1");

  assert.equal(await store.transitionTaskSecurityGrant("grant-1", ["granted"], "revoked"), false, "非法迁移被拒绝");
  assert.equal(await store.transitionTaskSecurityGrant("grant-1", ["applied"], "revoked"), true);
  assert.equal(await store.getActiveTaskSecurityGrant("task-1", "run-1"), null);

  // 迟到 ACK 不能复活
  assert.equal(await store.transitionTaskSecurityGrant("grant-1", ["granted"], "applied"), false);
  assert.equal((await store.getTaskSecurityGrant("grant-1"))?.status, "revoked");
});

test("已结束的授权不阻塞同一审批重新授权，生效中的授权仍然唯一", async () => {
  const store = new InMemoryClusterStore();
  await store.saveTaskSecurityGrant(makeGrant({ grantId: "grant-1", status: "revoked", grantedAt: 1 }));
  assert.equal(await store.saveTaskSecurityGrant(makeGrant({ grantId: "grant-2", status: "granted", grantedAt: 2 })), true);
  assert.equal(await store.saveTaskSecurityGrant(makeGrant({ grantId: "grant-3", status: "granted", grantedAt: 3 })), false, "活跃授权仍然唯一");
  assert.equal((await store.getTaskSecurityGrantByApproval("appr-1"))?.grantId, "grant-2", "按审批查询返回最新授权");
});

test("不同 Run 无法复用授权，任务终态使授权失效", async () => {
  const store = new InMemoryClusterStore();
  await store.saveTaskSecurityGrant(makeGrant({ status: "applied" }));
  assert.equal(await store.getActiveTaskSecurityGrant("task-1", "run-2"), null);
  assert.equal(await store.expireTaskSecurityGrantsForTask("task-1"), 1);
  assert.equal((await store.getTaskSecurityGrant("grant-1"))?.status, "expired");
  assert.equal(await store.getActiveTaskSecurityGrant("task-1", "run-1"), null);
});

test("outcome_unknown 与 revocation_pending 不会被 expire 掩盖", async () => {
  const store = new InMemoryClusterStore();
  await store.saveTaskSecurityGrant(makeGrant({ grantId: "g-1", approvalId: "a-1", status: "revocation_pending" }));
  assert.equal(await store.expireTaskSecurityGrantsForTask("task-1"), 0);
  assert.equal((await store.getTaskSecurityGrant("g-1"))?.status, "revocation_pending");
});

// ---------------------------------------------------------------------------
// 4. Coordinator 授权服务
// ---------------------------------------------------------------------------

async function coordinatorFixture(options: { online?: boolean; scheduler?: FakeSchedulerOptions; task?: Partial<ClusterTaskRecord>; approval?: Partial<ClusterApprovalRecord> } = {}) {
  const store = new InMemoryClusterStore();
  await seed(store, options.task, options.approval);
  const scheduler = fakeScheduler(options.scheduler);
  const service = new TaskSecurityGrantService({
    store,
    scheduler,
    registry: fakeRegistry(options.online ?? true),
  });
  return { store, scheduler, service };
}

test("授权成功：Worker ACK 之后才 marked applied、解除审批并恢复任务执行", async () => {
  const { store, scheduler, service } = await coordinatorFixture();
  const outcome = await service.requestGrant("appr-1", { username: "admin", role: "admin" });
  assert.equal(outcome.applied, true);
  assert.equal(outcome.status, "applied");
  assert.deepEqual(scheduler.calls.grant, [outcome.grantId]);

  const approval = await store.getApproval("appr-1");
  assert.equal(approval?.status, "resolved");
  assert.equal(approval?.decision, "grant-task-full-access");
  assert.equal(approval?.grantId, outcome.grantId);
  assert.equal((await store.getTask("task-1"))?.status, "running");
  assert.equal((await store.listPendingApprovals()).length, 0);
});

test("Worker 明确拒绝时授权记为 revoked，原审批保持 pending", async () => {
  const { store, service } = await coordinatorFixture({
    scheduler: { grant: async () => ({ success: false, message: "sandbox unavailable" }) },
  });
  await assert.rejects(service.requestGrant("appr-1", { username: "admin", role: "admin" }), (error: any) => {
    assert.equal(error.status, 502);
    return true;
  });
  const grants = await store.listTaskSecurityGrants({ taskId: "task-1" });
  assert.equal(grants.length, 1);
  assert.equal(grants[0]!.status, "revoked");
  assert.equal((await store.getApproval("appr-1"))?.status, "pending");
  assert.equal((await store.getTask("task-1"))?.status, "waiting_approval");
});

test("Worker 拒绝后允许在同一审批上重新授权，历史授权保留且生成新的 grantId", async () => {
  let attempt = 0;
  const { store, scheduler, service } = await coordinatorFixture({
    scheduler: {
      grant: async () => {
        attempt += 1;
        return attempt === 1 ? { success: false, message: "sandbox unavailable" } : { success: true };
      },
    },
  });
  await assert.rejects(service.requestGrant("appr-1", { username: "admin", role: "admin" }));
  const first = (await store.listTaskSecurityGrants({ taskId: "task-1" }))[0]!;
  assert.equal(first.status, "revoked");
  assert.equal((await service.eligibility((await store.getApproval("appr-1"))!)).canGrant, true, "失败的尝试不能永久禁用提权按钮");

  const outcome = await service.requestGrant("appr-1", { username: "admin", role: "admin" });
  assert.equal(outcome.applied, true);
  assert.notEqual(outcome.grantId, first.grantId, "重试必须产生新的授权记录");
  assert.deepEqual(scheduler.calls.grant, [first.grantId, outcome.grantId]);

  const history = await store.listTaskSecurityGrants({ approvalId: "appr-1" });
  assert.deepEqual(history.map((grant) => grant.status).sort(), ["applied", "revoked"]);
  assert.equal((await store.getTaskSecurityGrantByApproval("appr-1"))?.grantId, outcome.grantId, "按审批查询必须返回最新授权");
  assert.equal((await store.getApproval("appr-1"))?.grantId, outcome.grantId);
});

test("revocation_pending 只有在对账确认撤销后才允许重新授权", async () => {
  let grantAttempts = 0;
  let revokeConfirmed = false;
  const { store, service } = await coordinatorFixture({
    scheduler: {
      grant: async () => {
        grantAttempts += 1;
        return grantAttempts === 1
          ? { success: false, timedOut: true, message: "ack timeout" }
          : { success: true };
      },
      revoke: async () => (revokeConfirmed ? { success: true } : { success: false, message: "revoke ack timeout" }),
    },
  });
  await assert.rejects(service.requestGrant("appr-1", { username: "admin", role: "admin" }));
  const pending = (await store.listTaskSecurityGrants({ taskId: "task-1" }))[0]!;
  assert.equal(pending.status, "revocation_pending");

  await assert.rejects(
    service.requestGrant("appr-1", { username: "admin", role: "admin" }),
    (error: any) => {
      assert.equal(error.status, 409);
      assert.match(error.message, /撤销尚未被 Worker 确认/);
      return true;
    },
    "撤销未确认时不得发起新的提权",
  );
  assert.equal((await store.getTaskSecurityGrant(pending.grantId))?.status, "revocation_pending");

  revokeConfirmed = true;
  const outcome = await service.requestGrant("appr-1", { username: "admin", role: "admin" });
  assert.equal(outcome.applied, true);
  assert.notEqual(outcome.grantId, pending.grantId);
  assert.equal((await store.getTaskSecurityGrant(pending.grantId))?.status, "revoked");
});

test("ACK 超时收敛为 revocation_pending，绝不标记成功，也不解除审批", async () => {
  const { store, service, scheduler } = await coordinatorFixture({
    scheduler: {
      grant: async () => ({ success: false, timedOut: true, message: "ack timeout" }),
      revoke: async () => ({ success: false, message: "revoke ack timeout" }),
    },
  });
  await assert.rejects(service.requestGrant("appr-1", { username: "admin", role: "admin" }));
  const grant = (await store.listTaskSecurityGrants({ taskId: "task-1" }))[0]!;
  assert.equal(grant.status, "revocation_pending");
  assert.equal(grant.reconciliationRequired, true);
  assert.equal((await store.getApproval("appr-1"))?.status, "pending");
  assert.deepEqual(scheduler.calls.revoke, [grant.grantId]);
  assert.equal(await store.getActiveTaskSecurityGrant("task-1", "run-1"), null);
});

test("ACK 超时但回滚确认成功时，授权为 revoked 且审批仍待处理", async () => {
  const { store, service } = await coordinatorFixture({
    scheduler: {
      grant: async () => ({ success: false, timedOut: true }),
      revoke: async () => ({ success: true }),
    },
  });
  await assert.rejects(service.requestGrant("appr-1", { username: "admin", role: "admin" }));
  assert.equal((await store.listTaskSecurityGrants({ taskId: "task-1" }))[0]!.status, "revoked");
  assert.equal((await store.getApproval("appr-1"))?.status, "pending");
});

test("重复授权请求幂等；并发重复不会产生第二个授权", async () => {
  const { store, service } = await coordinatorFixture();
  const first = await service.requestGrant("appr-1", { username: "admin", role: "admin" });
  const second = await service.requestGrant("appr-1", { username: "admin", role: "admin" });
  assert.equal(second.grantId, first.grantId);
  assert.equal((await store.listTaskSecurityGrants({})).length, 1);
});

test("非管理员、终态任务、过期审批、非等待审批状态、离线节点全部拒绝", async () => {
  const { service } = await coordinatorFixture();
  await assert.rejects(service.requestGrant("appr-1", { username: "viewer", role: "viewer" }), (e: any) => e.status === 403);

  const completed = await coordinatorFixture({ task: { status: "completed" } });
  await assert.rejects(completed.service.requestGrant("appr-1", { username: "admin", role: "admin" }), (e: any) => e.status === 409);

  const expired = await coordinatorFixture({ approval: { expiresAt: Date.now() - 1 } });
  await assert.rejects(expired.service.requestGrant("appr-1", { username: "admin", role: "admin" }), (e: any) => e.status === 409);

  const running = await coordinatorFixture({ task: { status: "running" } });
  await assert.rejects(running.service.requestGrant("appr-1", { username: "admin", role: "admin" }), (e: any) => e.status === 409);

  const offline = await coordinatorFixture({ online: false });
  await assert.rejects(offline.service.requestGrant("appr-1", { username: "admin", role: "admin" }), (e: any) => e.status === 503);
});

test("迟到 ACK 不能复活已撤销授权，并触发再次回滚", async () => {
  const { store, service, scheduler } = await coordinatorFixture();
  await store.saveTaskSecurityGrant(makeGrant({ status: "applied" }));
  const revoked = await service.revokeGrant("grant-1", "global policy tightened");
  assert.equal(revoked.confirmed, true);
  scheduler.calls.revoke.length = 0;

  const ack: TaskGrantSecurityAckPayload = {
    grantId: "grant-1", approvalId: "appr-1", taskId: "task-1", runId: "run-1", nodeId: "node-1",
    applied: true, appliedAt: Date.now(),
  };
  await service.handleGrantAck(ack, false);
  assert.equal((await store.getTaskSecurityGrant("grant-1"))?.status, "revoked");
  assert.deepEqual(scheduler.calls.revoke, ["grant-1"]);
});

test("任务终态后到达的 applied ACK 也会触发回滚，绝不复活已过期授权", async () => {
  const { store, service, scheduler } = await coordinatorFixture();
  await store.saveTaskSecurityGrant(makeGrant({ status: "applied" }));
  assert.equal(await store.expireTaskSecurityGrantsForTask("task-1"), 1);
  assert.equal((await store.getTaskSecurityGrant("grant-1"))?.status, "expired");
  scheduler.calls.revoke.length = 0;

  await service.handleGrantAck({
    grantId: "grant-1", approvalId: "appr-1", taskId: "task-1", runId: "run-1", nodeId: "node-1",
    applied: true, appliedAt: Date.now(),
  }, false);
  assert.equal((await store.getTaskSecurityGrant("grant-1"))?.status, "expired", "终态授权不可被迟到 ACK 复活");
  assert.deepEqual(scheduler.calls.revoke, ["grant-1"]);
});

test("Worker 自撤销 ACK 会把 applied 收敛为 revoked", async () => {
  const { store, service } = await coordinatorFixture();
  await store.saveTaskSecurityGrant(makeGrant({ status: "applied" }));
  await service.handleGrantAck({
    grantId: "grant-1", approvalId: "appr-1", taskId: "task-1", runId: "run-1", nodeId: "node-1",
    applied: false, appliedAt: Date.now(), error: "Self-revoked: coordinator effective policy no longer matches the grant",
  }, false);
  assert.equal((await store.getTaskSecurityGrant("grant-1"))?.status, "revoked");
});

test("撤销 ACK 身份不一致时不做任何状态变更", async () => {
  const { store, service } = await coordinatorFixture();
  await store.saveTaskSecurityGrant(makeGrant({ status: "applied" }));
  const ack: TaskRevokeSecurityAckPayload = {
    grantId: "grant-1", taskId: "task-1", runId: "run-other", nodeId: "node-1", reverted: true, revokedAt: Date.now(),
  };
  await service.handleRevokeAck(ack, false);
  assert.equal((await store.getTaskSecurityGrant("grant-1"))?.status, "applied");
});

test("全局撤销：在线节点确认后才算撤销；离线节点只能待对账", async () => {
  const online = await coordinatorFixture();
  await online.store.saveTaskSecurityGrant(makeGrant({ status: "applied" }));
  const okay = await online.service.revokeAllActiveGrants("tightened");
  assert.equal(okay.confirmed, true);
  assert.equal((await online.store.getTaskSecurityGrant("grant-1"))?.status, "revoked");

  const offlineStore = new InMemoryClusterStore();
  await offlineStore.saveTaskSecurityGrant(makeGrant({ status: "applied" }));
  const offlineService = new TaskSecurityGrantService({
    store: offlineStore,
    scheduler: fakeScheduler(),
    registry: fakeRegistry(false),
  });
  const unconfirmed = await offlineService.revokeAllActiveGrants("tightened");
  assert.equal(unconfirmed.confirmed, false);
  assert.equal(unconfirmed.pending, 1);
  assert.equal((await offlineStore.getTaskSecurityGrant("grant-1"))?.status, "revocation_pending");
});

test("从未 ACK 的授权在节点离线时可安全丢弃", async () => {
  const store = new InMemoryClusterStore();
  await store.saveTaskSecurityGrant(makeGrant({ status: "granted" }));
  const service = new TaskSecurityGrantService({ store, scheduler: fakeScheduler(), registry: fakeRegistry(false) });
  const outcome = await service.revokeAllActiveGrants("tightened");
  assert.equal(outcome.confirmed, true);
  assert.equal((await store.getTaskSecurityGrant("grant-1"))?.status, "revoked");
});

// ---------------------------------------------------------------------------
// 5. 全局安全策略切换
// ---------------------------------------------------------------------------

test("全局权限放宽不需要运行时撤销，配置直接生效", async () => {
  const dir = makeTmpDir();
  const productStore = new ProductStore({ homeDir: dir });
  const store = new InMemoryClusterStore();
  let revokedCalls = 0;
  try {
    productStore.initialize(sampleProductInit({ filesystem: "workspace-write", network: "deny", approval: "ask" }));
    const api = new ProductHttpApi(productStore, store, async () => { revokedCalls++; });
    try {
    const res = await putConfig(api, {
      expectedVersion: 1,
      patch: { security: { filesystem: "danger-full-access", network: "allow", approval: "auto-grant", confirmFullAccess: true } },
    });
    assert.equal(res.applied, true);
    assert.equal(res.config.security.filesystem, "danger-full-access");
      assert.equal(revokedCalls, 0);
      assert.equal(productStore.pendingSecurityApply(), undefined);
    } finally { api.close(); }
  } finally { productStore.close(); cleanup(dir); }
});

test("权限收紧时若授权无法确认撤销，则保持 SECURITY_APPLY_PENDING 并如实报错", async () => {
  const dir = makeTmpDir();
  const productStore = new ProductStore({ homeDir: dir });
  const store = new InMemoryClusterStore();
  try {
    productStore.initialize(sampleProductInit({ filesystem: "danger-full-access", network: "allow", approval: "auto-grant", confirmFullAccess: true }));
    await store.saveTask(makeTask({ status: "outcome_unknown" }));
    await store.saveTaskSecurityGrant(makeGrant({ status: "applied" }));

    const service = new TaskSecurityGrantService({ store, scheduler: fakeScheduler(), registry: fakeRegistry(false) });
    const api = new ProductHttpApi(productStore, store, service.createSecurityRevocationHandler());
    try {
      await assert.rejects(putConfig(api, {
        expectedVersion: 1,
        patch: { security: { filesystem: "workspace-write", network: "deny", approval: "ask" } },
      }), /COMMITTED_APPLY_FAILED/);

      // 配置本身已提交，但运行时应用保持 pending
      assert.equal(productStore.getPublicConfig().version, 2);
      assert.equal(productStore.getPublicConfig().security.filesystem, "workspace-write");
      assert.equal(productStore.pendingSecurityApply()?.version, 2);
      // 历史未知结果不被静默改写
      assert.equal((await store.getTask("task-1"))?.status, "outcome_unknown");
      assert.equal((await store.getTaskSecurityGrant("grant-1"))?.status, "revocation_pending");
    } finally { api.close(); }
  } finally { productStore.close(); cleanup(dir); }
});

test("权限收紧在授权撤销确认后完成，且不影响 outcome_unknown 历史任务", async () => {
  const dir = makeTmpDir();
  const productStore = new ProductStore({ homeDir: dir });
  const store = new InMemoryClusterStore();
  try {
    productStore.initialize(sampleProductInit({ filesystem: "danger-full-access", network: "allow", approval: "auto-grant", confirmFullAccess: true }));
    await store.saveTask(makeTask({ status: "outcome_unknown" }));
    await store.saveTaskSecurityGrant(makeGrant({ status: "applied" }));

    const service = new TaskSecurityGrantService({ store, scheduler: fakeScheduler(), registry: fakeRegistry(true) });
    const api = new ProductHttpApi(productStore, store, service.createSecurityRevocationHandler());
    try {
      const res = await putConfig(api, {
        expectedVersion: 1,
        patch: { security: { filesystem: "workspace-write", network: "deny", approval: "ask" } },
      });
      assert.equal(res.applied, true);
      assert.equal(productStore.pendingSecurityApply(), undefined);
      assert.equal((await store.getTaskSecurityGrant("grant-1"))?.status, "revoked");
      assert.equal((await store.getTask("task-1"))?.status, "outcome_unknown");
    } finally { api.close(); }
  } finally { productStore.close(); cleanup(dir); }
});

async function putConfig(api: ProductHttpApi, body: unknown): Promise<any> {
  const req = Readable.from([JSON.stringify(body)]) as any;
  req.method = "PUT";
  let response: any;
  const res = {
    writeHead: () => {},
    setHeader: () => {},
    end: (chunk: string) => { response = JSON.parse(chunk); },
  } as any;
  await api.handle(req, res, new URL("http://localhost/api/product/config"), { userId: "usr-admin", role: "admin" });
  return response;
}

// ---------------------------------------------------------------------------
// 6. 安全审查边界不回退
// ---------------------------------------------------------------------------

test("确定性硬拦截在 auto-grant 下依然有效", async () => {
  const monitor = new PreToolSecurityMonitor({ enabled: true });
  const decision = await monitor.evaluateToolCall({
    toolName: "bash",
    toolArgs: { command: "rm -rf /" },
    rawArgs: JSON.stringify({ command: "rm -rf /" }),
    argsFingerprint: "fp-rm-rf-root",
    agentIdentity: { agentId: "main" },
    userAuthorizationContext: { userIntent: "wipe system" },
  });
  assert.equal(decision.verdict, "BLOCK");
  assert.equal(decision.isHardBlock, true);
});

test("安全审查不可用时 Fail-Closed", async () => {
  const monitor = new PreToolSecurityMonitor({ enabled: true });
  const decision = await monitor.evaluateToolCall({
    toolName: "bash",
    toolArgs: { command: "mkfs.ext4 /dev/sda" },
    rawArgs: JSON.stringify({ command: "mkfs.ext4 /dev/sda" }),
    argsFingerprint: "fp-format",
    agentIdentity: { agentId: "main" },
    userAuthorizationContext: { userIntent: "destructive disk write" },
  });
  assert.equal(decision.reviewUnavailable, true);
  assert.equal(decision.verdict, "REQUIRE_APPROVAL");
});

test("WebRequestError 用于区分 403/409/503 语义", () => {
  assert.equal(new WebRequestError(409, "x").status, 409);
});
