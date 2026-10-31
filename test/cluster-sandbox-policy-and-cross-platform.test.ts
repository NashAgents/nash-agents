import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { InMemoryClusterStore } from "../src/cluster/storage/cluster-store.js";
import { NodeRegistry } from "../src/cluster/coordinator/node-registry.js";
import { InviteManager } from "../src/cluster/identity/invite-manager.js";
import { TaskScheduler } from "../src/cluster/coordinator/task-scheduler.js";
import { CoordinatorCatalogService } from "../src/cluster/coordinator/catalog/coordinator-catalog-service.js";
import { ClusterSearchService } from "../src/cluster/coordinator/catalog/cluster-search-service.js";
import {
  TaskIntentAnalyzer,
  RoutingCandidateCollector,
  RoutingCandidateRanker,
  RoutingValidator,
  SemanticTaskRouter,
} from "../src/cluster/router/index.js";
import type { TaskIntent, RoutingCandidate } from "../src/cluster/router/types.js";
import type { NodeHardwareCapability } from "../src/cluster/protocol/types.js";

describe("Nash Cluster: Sandbox Policy Matching, Cross-Platform Routing & Safety Gates", () => {
  let store: InMemoryClusterStore;
  let inviteManager: InviteManager;
  let registry: NodeRegistry;
  let scheduler: TaskScheduler;
  let catalogService: CoordinatorCatalogService;
  let searchService: ClusterSearchService;
  let validator: RoutingValidator;
  let ranker: RoutingCandidateRanker;
  let router: SemanticTaskRouter;

  const COORD_ID = "node-coord-test";
  const WIN_NODE_ID = "node-example-windows"; // Windows Native Worker
  const WSL_NODE_ID = "node-example-wsl"; // WSL2 Linux Worker
  const MAC_NODE_ID = "node-example-mac"; // macOS Worker

  beforeEach(async () => {
    store = new InMemoryClusterStore();
    inviteManager = new InviteManager();
    registry = new NodeRegistry(store, inviteManager);
    scheduler = new TaskScheduler(store, registry, COORD_ID);
    catalogService = new CoordinatorCatalogService(store, registry, COORD_ID);
    searchService = new ClusterSearchService(store, registry, catalogService);
    validator = new RoutingValidator(store, registry);
    ranker = new RoutingCandidateRanker();

    router = new SemanticTaskRouter({
      store,
      registry,
      scheduler,
      searchService,
      catalogService,
      enableAgentLoopConsultation: false,
    });

    const now = Date.now();

    // 1. 注册 Windows Native Worker (win32, x64)
    await store.saveNode({
      nodeId: WIN_NODE_ID,
      name: "FixtureHost",
      role: "worker",
      platform: "win32",
      arch: "x64",
      hostname: "FixtureHost",
      tokenHash: "hash-win",
      status: "online",
      lastSeenAt: now,
      metadata: { sandboxBackend: "windows-sandbox" },
      createdAt: now,
      updatedAt: now,
    });
    (registry as any).connections.set(WIN_NODE_ID, {
      generation: 1,
      connectedAt: now,
      lastHeartbeatAt: now,
      ws: { readyState: 1, send: () => {} },
      activeTasksCount: 0,
      maxConcurrentRuns: 4,
    });

    // Windows 沙箱能力：Job Objects 进程受控，但文件系统内核隔离未经验证 (degraded)
    const winCaps: NodeHardwareCapability[] = [
      {
        name: "Windows Native Sandbox",
        category: "sandbox",
        status: "degraded",
        details: "Windows Job Objects helper active; filesystem and network isolation unverified; restricted tasks require WSL2",
        detectionMethod: "WindowsSandboxProbe.probe()",
        detectedAt: now,
        structuredDetails: {
          backend: "windows-sandbox",
          installed: true,
          operational: true,
          filesystemIsolationVerified: false,
          networkIsolationVerified: false,
          processIsolationVerified: true,
          supportedPolicies: ["danger-full-access"],
          supportedNetworkModes: ["allow"],
          requiresWslForRestrictedExecution: true,
        },
      },
    ];
    await store.saveCatalogRevision(WIN_NODE_ID, 1, winCaps);

    // 2. 注册 WSL2 Linux Worker (linux, x64) - 相同的主机名与物理机器
    await store.saveNode({
      nodeId: WSL_NODE_ID,
      name: "FixtureHost",
      role: "worker",
      platform: "linux",
      arch: "x64",
      hostname: "FixtureHost",
      tokenHash: "hash-wsl",
      status: "online",
      lastSeenAt: now,
      metadata: { sandboxBackend: "bubblewrap" },
      createdAt: now,
      updatedAt: now,
    });
    (registry as any).connections.set(WSL_NODE_ID, {
      generation: 1,
      connectedAt: now,
      lastHeartbeatAt: now,
      ws: { readyState: 1, send: () => {} },
      activeTasksCount: 0,
      maxConcurrentRuns: 4,
    });

    // WSL2 沙箱能力：Bubblewrap 具备完整的内核隔离验证 (verified)
    const wslCaps: NodeHardwareCapability[] = [
      {
        name: "Linux Bubblewrap Sandbox",
        category: "sandbox",
        status: "verified",
        details: "Unprivileged namespace isolation via bubblewrap (bwrap)",
        detectionMethod: "which bwrap",
        detectedAt: now,
        verifiedAt: now,
        structuredDetails: {
          backend: "bubblewrap",
          installed: true,
          operational: true,
          filesystemIsolationVerified: true,
          networkIsolationVerified: true,
          processIsolationVerified: true,
          supportedPolicies: ["read-only", "workspace-write", "full-capability", "danger-full-access"],
          supportedNetworkModes: ["deny", "allow"],
          verifiedAt: now,
          verificationExpiresAt: now + 86400000,
        },
      },
    ];
    await store.saveCatalogRevision(WSL_NODE_ID, 1, wslCaps);

    // 3. 注册 macOS Worker (darwin, arm64)
    await store.saveNode({
      nodeId: MAC_NODE_ID,
      name: "MacBook-Air",
      role: "worker",
      platform: "darwin",
      arch: "arm64",
      hostname: "example-mac.local",
      tokenHash: "hash-mac",
      status: "online",
      lastSeenAt: now,
      metadata: { sandboxBackend: "seatbelt" },
      createdAt: now,
      updatedAt: now,
    });
    (registry as any).connections.set(MAC_NODE_ID, {
      generation: 1,
      connectedAt: now,
      lastHeartbeatAt: now,
      ws: { readyState: 1, send: () => {} },
      activeTasksCount: 0,
      maxConcurrentRuns: 4,
    });

    const macCaps: NodeHardwareCapability[] = [
      {
        name: "macOS Seatbelt Sandbox",
        category: "sandbox",
        status: "verified",
        details: "Seatbelt scheme profile isolation via /usr/bin/sandbox-exec",
        detectionMethod: "fs.existsSync(/usr/bin/sandbox-exec)",
        detectedAt: now,
        verifiedAt: now,
        structuredDetails: {
          backend: "seatbelt",
          installed: true,
          operational: true,
          filesystemIsolationVerified: true,
          networkIsolationVerified: true,
          processIsolationVerified: true,
          supportedPolicies: ["read-only", "workspace-write", "full-capability", "danger-full-access"],
          supportedNetworkModes: ["deny", "allow"],
          verifiedAt: now,
          verificationExpiresAt: now + 86400000,
        },
      },
    ];
    await store.saveCatalogRevision(MAC_NODE_ID, 1, macCaps);

    // 4. 注册项目目录
    await store.upsertProjectCatalog([
      {
        projectId: "proj-win-demo",
        nodeId: WIN_NODE_ID,
        name: "win-demo",
        summary: "Windows Native Demo Project",
        description: "Project running on Windows native filesystem",
        technologies: ["typescript", "node"],
        capabilities: [],
        status: "active",
        registeredAt: now,
        updatedAt: now,
        lastIndexedAt: now,
        revision: 1,
        visibility: "retrievable",
        canonicalPath: "C:\\Users\\test\\Documents\\project\\nash-agents",
      },
      {
        projectId: "proj-wsl-demo",
        nodeId: WSL_NODE_ID,
        name: "wsl-demo",
        summary: "WSL2 Linux Demo Project",
        description: "Project running inside WSL2 Ubuntu",
        technologies: ["typescript", "node", "python"],
        capabilities: [],
        status: "active",
        registeredAt: now,
        updatedAt: now,
        lastIndexedAt: now,
        revision: 1,
        visibility: "retrievable",
        canonicalPath: "/root/workspace/system-probe",
      },
      {
        projectId: "proj-mac-demo",
        nodeId: MAC_NODE_ID,
        name: "mac-demo",
        summary: "Mac Native Demo Project",
        description: "Project running on macOS",
        technologies: ["typescript", "node"],
        capabilities: [],
        status: "active",
        registeredAt: now,
        updatedAt: now,
        lastIndexedAt: now,
        revision: 1,
        visibility: "retrievable",
        canonicalPath: "/Users/test/Documents/project/nash-agents",
      },
    ]);
  });

  // ============================================================
  // 1. 策略兼容性校验 (Policy Compatibility)
  // ============================================================
  test("TC-SEC-01: 要求 workspace-write 的任务分发给文件系统未验证的 Windows 节点时坚决被拒 (Fail-Closed)", async () => {
    const candidate = { nodeId: WIN_NODE_ID, projectId: "proj-win-demo" };
    const writeIntent: Pick<TaskIntent, "constraints" | "requiredCapabilities"> = {
      constraints: { readOnly: false },
      requiredCapabilities: [],
    };

    const res = await validator.validateCandidate(candidate, writeIntent);
    assert.strictEqual(res.valid, false);
    assert.strictEqual(res.code, "SANDBOX_INCOMPATIBLE");
    assert.match(res.reason, /Windows Native.*workspace-write/i);
  });

  test("TC-SEC-02: 只读分析也需要真实文件与网络隔离，未经验证必须阻断", async () => {
    const candidate = { nodeId: WIN_NODE_ID, projectId: "proj-win-demo" };
    const readIntent: Pick<TaskIntent, "constraints" | "requiredCapabilities"> = {
      constraints: { readOnly: true },
      requiredCapabilities: [],
    };

    const res = await validator.validateCandidate(candidate, readIntent);
    assert.strictEqual(res.valid, false);
    assert.strictEqual(res.code, "SANDBOX_INCOMPATIBLE");
  });

  test("TC-SEC-02b: 显式声明 allowSideEffects (danger-full-access) 时允许在 Windows Native 节点执行", async () => {
    const candidate = { nodeId: WIN_NODE_ID, projectId: "proj-win-demo" };
    const dangerIntent: Pick<TaskIntent, "constraints" | "requiredCapabilities"> = {
      constraints: {
        readOnly: false,
        allowSideEffects: true,
        requiredPolicy: { filesystem: "danger-full-access", network: "allow" },
      },
      requiredCapabilities: [],
    };

    const res = await validator.validateCandidate(candidate, dangerIntent);
    assert.strictEqual(res.valid, true);
    assert.strictEqual(res.code, "VALID");
  });

  // ============================================================
  // 2. 跨平台物理路径互斥防御 (Platform Path Isolation)
  // ============================================================
  test("TC-SEC-03: POSIX 节点 (Linux/Mac) 执行 Windows 盘符路径项目必须被直接阻断", async () => {
    // 构造一个在 Linux 节点上却登记了 C:\ 盘符的非法项目
    await store.upsertProjectCatalog([{
      projectId: "proj-bad-linux-winpath",
      nodeId: WSL_NODE_ID,
      name: "bad-project",
      summary: "Invalid path project",
      description: "",
      technologies: [],
      capabilities: [],
      status: "active",
      registeredAt: Date.now(),
      updatedAt: Date.now(),
      lastIndexedAt: Date.now(),
      revision: 1,
      visibility: "retrievable",
      canonicalPath: "C:\\Users\\test\\stolen",
    }]);

    const res = await validator.validateCandidate(
      { nodeId: WSL_NODE_ID, projectId: "proj-bad-linux-winpath" },
      { constraints: { readOnly: true }, requiredCapabilities: [] }
    );
    assert.strictEqual(res.valid, false);
    assert.strictEqual(res.code, "PLATFORM_PATH_MISMATCH");
    assert.match(res.reason, /Windows drive path/i);
  });

  test("TC-SEC-04: Windows 节点执行 POSIX 路径项目必须被直接阻断", async () => {
    await store.upsertProjectCatalog([{
      projectId: "proj-bad-win-posixpath",
      nodeId: WIN_NODE_ID,
      name: "bad-posix",
      summary: "",
      description: "",
      technologies: [],
      capabilities: [],
      status: "active",
      registeredAt: Date.now(),
      updatedAt: Date.now(),
      lastIndexedAt: Date.now(),
      revision: 1,
      visibility: "retrievable",
      canonicalPath: "/root/workspace/linux-only",
    }]);

    const res = await validator.validateCandidate(
      { nodeId: WIN_NODE_ID, projectId: "proj-bad-win-posixpath" },
      { constraints: { readOnly: true }, requiredCapabilities: [] }
    );
    assert.strictEqual(res.valid, false);
    assert.strictEqual(res.code, "PLATFORM_PATH_MISMATCH");
    assert.match(res.reason, /not a valid Windows absolute path/i);
  });

  test("TC-SEC-04b: Windows 保留设备名 (CON, NUL, PRN 等) 路径被确定性拦截", async () => {
    await store.upsertProjectCatalog([{
      projectId: "proj-win-reserved-dev",
      nodeId: WIN_NODE_ID,
      name: "reserved-dev",
      summary: "",
      description: "",
      technologies: [],
      capabilities: [],
      status: "active",
      registeredAt: Date.now(),
      updatedAt: Date.now(),
      lastIndexedAt: Date.now(),
      revision: 1,
      visibility: "retrievable",
      canonicalPath: "C:\\Users\\test\\CON",
    }]);

    const res = await validator.validateCandidate(
      { nodeId: WIN_NODE_ID, projectId: "proj-win-reserved-dev" },
      { constraints: { readOnly: true }, requiredCapabilities: [] }
    );
    assert.strictEqual(res.valid, false);
    assert.strictEqual(res.code, "PLATFORM_PATH_MISMATCH");
    assert.match(res.reason, /Windows reserved device name/i);
  });

  // ============================================================
  // 3. 陈旧沙箱验证失效机制 (Stale Capability Invalidation)
  // ============================================================
  test("TC-SEC-05: 沙箱验证超过 24 小时未重新验证时，受限写任务被拒绝 (STALE_SANDBOX_CAPABILITY)", async () => {
    const expiredTime = Date.now() - 30 * 60 * 60 * 1000; // 30 小时前
    const staleCaps: NodeHardwareCapability[] = [
      {
        name: "Linux Bubblewrap Sandbox",
        category: "sandbox",
        status: "verified",
        details: "Old verification",
        detectionMethod: "which bwrap",
        detectedAt: expiredTime,
        verifiedAt: expiredTime,
        structuredDetails: {
          backend: "bubblewrap",
          installed: true,
          operational: true,
          filesystemIsolationVerified: true,
          networkIsolationVerified: true,
          processIsolationVerified: true,
          supportedPolicies: ["read-only", "workspace-write", "full-capability", "danger-full-access"],
          supportedNetworkModes: ["deny", "allow"],
          verifiedAt: expiredTime,
          verificationExpiresAt: expiredTime + 86400000, // 已经在 6 小时前过期
        },
      },
    ];
    await store.saveCatalogRevision(WSL_NODE_ID, 2, staleCaps);

    const res = await validator.validateCandidate(
      { nodeId: WSL_NODE_ID, projectId: "proj-wsl-demo" },
      { constraints: { readOnly: false }, requiredCapabilities: [] }
    );
    assert.strictEqual(res.valid, false);
    assert.strictEqual(res.code, "STALE_SANDBOX_CAPABILITY");
    assert.match(res.reason, /verification has expired/i);
  });

  // ============================================================
  // 4. CandidateRanker 候选排序与双节点区分
  // ============================================================
  test("TC-SEC-06: 面对同名主机 FixtureHost，需要写权限时自动优先选择验证过沙箱的 WSL2，排除 Windows Native", async () => {
    const intent: TaskIntent = {
      originalRequest: "修复 FixtureHost 上的代码并运行测试",
      goal: "修复测试中的加法函数",
      operation: "fix",
      projectHints: [],
      nodeHints: ["fixture-host"],
      capabilityHints: [],
      requiredCapabilities: [],
      preferredCapabilities: [],
      constraints: { readOnly: false }, // 需要 workspace-write
      ambiguities: [],
      riskHints: [],
      confidence: 0.9,
    };

    const candidates: RoutingCandidate[] = [
      {
        nodeId: WIN_NODE_ID,
        projectId: "proj-win-demo",
        projectName: "win-demo",
        projectSummary: "Windows Native Demo",
        technologies: ["node"],
        capabilities: [],
        nodeOnline: true,
        projectStatus: "active",
        score: 0.85,
        confidence: 0.9,
        hardConstraintsSatisfied: true,
        unsatisfiedConstraints: [],
        evidences: [
          {
            sourceType: "node_hardware",
            referenceId: "hw:Windows Native Sandbox",
            summary: "Windows Native Sandbox: Windows Job Objects helper active; filesystem and network isolation unverified",
            confidence: 1.0,
            freshnessTimestamp: Date.now(),
            matchReasons: ["Node platform win32/x64"],
          },
        ],
        requiredSkillsAvailable: true,
        requiredMCPAvailable: true,
      },
      {
        nodeId: WSL_NODE_ID,
        projectId: "proj-wsl-demo",
        projectName: "wsl-demo",
        projectSummary: "WSL2 Demo",
        technologies: ["node"],
        capabilities: [],
        nodeOnline: true,
        projectStatus: "active",
        score: 0.85,
        confidence: 0.9,
        hardConstraintsSatisfied: true,
        unsatisfiedConstraints: [],
        evidences: [
          {
            sourceType: "node_hardware",
            referenceId: "hw:Linux Bubblewrap Sandbox",
            summary: "Linux Bubblewrap Sandbox: verified unprivileged namespace isolation",
            confidence: 1.0,
            freshnessTimestamp: Date.now(),
            matchReasons: ["Node platform linux/x64"],
          },
        ],
        requiredSkillsAvailable: true,
        requiredMCPAvailable: true,
      },
    ];

    const ranked = ranker.rank(intent, candidates);

    // WSL2 必须硬约束满足，且排在第一位
    assert.strictEqual(ranked[0].nodeId, WSL_NODE_ID);
    assert.strictEqual(ranked[0].hardConstraintsSatisfied, true);

    // Windows Native 因缺少内核写隔离，硬约束被判定为不满足
    assert.strictEqual(ranked[1].nodeId, WIN_NODE_ID);
    assert.strictEqual(ranked[1].hardConstraintsSatisfied, false);
    assert.match(ranked[1].unsatisfiedConstraints.join(" "), /沙箱文件系统写隔离能力/);
  });

  // ============================================================
  // 5. TaskScheduler 调度守卫与安全审计自动落盘
  // ============================================================
  test("TC-SEC-07: TaskScheduler.createTask 尝试强行调度未验证受限任务至 Windows 时直接抛错并持久化安全审计", async () => {
    let auditSaved = false;
    store.saveSecurityAudit = async (record) => {
      auditSaved = true;
      assert.strictEqual(record.decisionSource, "DETERMINISTIC_POLICY");
      assert.strictEqual(record.verdict, "BLOCK");
      assert.strictEqual(record.ruleName, "SANDBOX_INCOMPATIBLE");
      assert.strictEqual(record.nodeId, WIN_NODE_ID);
    };

    await assert.rejects(
      async () => {
        await scheduler.createTask({
          nodeId: WIN_NODE_ID,
          projectId: "proj-win-demo",
          goal: "在 Windows 上直接编译和覆盖写入代码",
          contextOverrides: { readOnly: false },
        });
      },
      /SANDBOX_INCOMPATIBLE/
    );

    assert.strictEqual(auditSaved, true, "安全拦截记录必须成功写入审计日志");
  });
});
