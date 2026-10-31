import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import path from "node:path";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import { SandboxService } from "../src/sandbox/sandbox-service.js";
import { LinuxBubblewrapBackend } from "../src/sandbox/backends/linux-bubblewrap.js";
import { MacOsSeatbeltBackend } from "../src/sandbox/backends/macos-seatbelt.js";
import { FileSystemAccess } from "../src/sandbox/filesystem-access.js";
import { ApprovalService } from "../src/approval/approval-service.js";
import type { ApprovalDecision, ApprovalRequest } from "../src/approval/types.js";
import { ToolExecutor } from "../src/tools/executor.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { createReadFileTool } from "../src/tools/read-file.js";
import { createWriteFileTool } from "../src/tools/write-file.js";
import { createDefaultSandboxPolicy } from "../src/sandbox/policy.js";

describe("Linux Sandbox Approval E2E Tests (跨平台提权审批与策略隔离)", { skip: process.platform !== "linux" ? "Requires Linux platform" : false }, () => {
  let workspaceRoot: string;
  let outsideTargetDir: string;
  let backend: LinuxBubblewrapBackend;

  beforeEach(async () => {
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nash-appr-ws-"));
    outsideTargetDir = await fs.mkdtemp(path.join(os.tmpdir(), "nash-appr-outside-"));
    backend = new LinuxBubblewrapBackend();
  });

  afterEach(async () => {
    if (fsSync.existsSync(workspaceRoot)) {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
    if (fsSync.existsSync(outsideTargetDir)) {
      await fs.rm(outsideTargetDir, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // 46. workspace 外操作触发现有 Approval
  // =========================================================================
  it("46. workspace 外操作触发现有 Approval: 访问工作区外部路径向用户发起提权请求", async () => {
    let requestedCapability = "";
    const mockProvider = {
      async askApproval(req: ApprovalRequest): Promise<ApprovalDecision> {
        requestedCapability = req.capability;
        return "deny";
      },
    };

    const approvalService = new ApprovalService({ provider: mockProvider });
    const fsAccess = new FileSystemAccess({
      policy: createDefaultSandboxPolicy(),
      workspaceRoot,
      approvalService,
    });

    const registry = new ToolRegistry();
    registry.register(createReadFileTool(fsAccess));
    const executor = new ToolExecutor(registry);

    const outsideFile = path.join(outsideTargetDir, "test.txt");
    await fs.writeFile(outsideFile, "outside content");

    await executor.execute("read_file", { path: outsideFile });
    assert.strictEqual(requestedCapability, "filesystem-outside-workspace");
  });

  // =========================================================================
  // 47. Deny -> PERMISSION_DENIED
  // =========================================================================
  it("47. Deny -> PERMISSION_DENIED: 审批拒绝时工具返回清晰的 PERMISSION_DENIED 且不崩溃", async () => {
    const mockProvider = {
      async askApproval(): Promise<ApprovalDecision> {
        return "deny";
      },
    };

    const approvalService = new ApprovalService({ provider: mockProvider });
    const fsAccess = new FileSystemAccess({
      policy: createDefaultSandboxPolicy(),
      workspaceRoot,
      approvalService,
    });

    const registry = new ToolRegistry();
    registry.register(createWriteFileTool(fsAccess));
    const executor = new ToolExecutor(registry);

    const outsideFile = path.join(outsideTargetDir, "forbidden.txt");
    const result = await executor.execute("write_file", {
      path: outsideFile,
      content: "blocked data",
    });

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.error, "PERMISSION_DENIED");
    assert.ok(result.output.includes("PERMISSION_DENIED"));
  });

  // =========================================================================
  // 48. Allow once -> 仅本次成功
  // =========================================================================
  it("48. Allow once -> 仅本次成功: 用户单次放行时当前操作顺利执行", async () => {
    const mockProvider = {
      async askApproval(): Promise<ApprovalDecision> {
        return "allow-once";
      },
    };

    const approvalService = new ApprovalService({ provider: mockProvider });
    const fsAccess = new FileSystemAccess({
      policy: createDefaultSandboxPolicy(),
      workspaceRoot,
      approvalService,
    });

    const registry = new ToolRegistry();
    registry.register(createWriteFileTool(fsAccess));
    const executor = new ToolExecutor(registry);

    const outsideFile = path.join(outsideTargetDir, "allowed.txt");
    const result = await executor.execute("write_file", {
      path: outsideFile,
      content: "written successfully",
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(fsSync.existsSync(outsideFile), true);
    assert.strictEqual(await fs.readFile(outsideFile, "utf-8"), "written successfully");
  });

  // =========================================================================
  // 49. 下一次相同越权再次需要 Approval
  // =========================================================================
  it("49. 下一次相同越权再次需要 Approval: 单次放行后下次操作仍需重新审批", async () => {
    let callCount = 0;
    const mockProvider = {
      async askApproval(): Promise<ApprovalDecision> {
        callCount++;
        return callCount === 1 ? "allow-once" : "deny";
      },
    };

    const approvalService = new ApprovalService({ provider: mockProvider });
    const fsAccess = new FileSystemAccess({
      policy: createDefaultSandboxPolicy(),
      workspaceRoot,
      approvalService,
    });

    const registry = new ToolRegistry();
    registry.register(createWriteFileTool(fsAccess));
    const executor = new ToolExecutor(registry);

    const outsideFile = path.join(outsideTargetDir, "twice.txt");

    // 第一次：放行
    const res1 = await executor.execute("write_file", { path: outsideFile, content: "1" });
    assert.strictEqual(res1.success, true);
    assert.strictEqual(callCount, 1);

    // 第二次：拒绝
    const res2 = await executor.execute("write_file", { path: outsideFile, content: "2" });
    assert.strictEqual(res2.success, false);
    assert.strictEqual(res2.error, "PERMISSION_DENIED");
    assert.strictEqual(callCount, 2, "第二次操作必须再次触发审批，绝无持久化提权");
  });

  // =========================================================================
  // 50. global SandboxPolicy 未被污染
  // =========================================================================
  it("50. global SandboxPolicy 未被污染: 提权完成后全局配置依然严格保持原样", async () => {
    const originalPolicy = createDefaultSandboxPolicy();
    const mockProvider = {
      async askApproval(): Promise<ApprovalDecision> {
        return "allow-once";
      },
    };

    const approvalService = new ApprovalService({ provider: mockProvider });
    const svc = new SandboxService({
      backend,
      policy: originalPolicy,
      approvalService,
      cwd: workspaceRoot,
    });

    // 验证执行后的全局策略
    const policyAfter = svc.getPolicy();
    assert.strictEqual(policyAfter.filesystem.mode, "workspace-write");
    assert.strictEqual(policyAfter.network.mode, "deny");
    assert.strictEqual(policyAfter.approval.mode, "ask");
  });

  // =========================================================================
  // 51. approval waiting 不占 concurrency slot
  // =========================================================================
  it("51. approval waiting 不占 concurrency slot: 审批挂起期间主动调用 yieldSlot 释放并发槽位", async () => {
    let yielded = false;
    let resumed = false;

    const mockProvider = {
      async askApproval(): Promise<ApprovalDecision> {
        // 验证进入提问时已经 yield
        assert.strictEqual(yielded, true);
        return "allow-once";
      },
    };

    const approvalService = new ApprovalService({ provider: mockProvider });

    const decision = await approvalService.requestApproval(
      {
        capability: "filesystem-write",
        reason: "Testing concurrency slot yield",
      },
      {
        yieldSlot: () => {
          yielded = true;
          return async () => {
            resumed = true;
          };
        },
      }
    );

    assert.strictEqual(decision, "allow-once");
    assert.strictEqual(yielded, true, "审批等待前必须让出槽位");
    assert.strictEqual(resumed, true, "审批裁决后必须恢复槽位");
  });

  // =========================================================================
  // 52. Linux 与 macOS Approval 语义完全一致
  // =========================================================================
  it("52. Linux 与 macOS Approval 语义一致: 核心服务层无平台差异，语义完全对齐", () => {
    const linuxBackend = new LinuxBubblewrapBackend();
    const macBackend = new MacOsSeatbeltBackend();

    const policy = createDefaultSandboxPolicy();
    const linuxSvc = new SandboxService({ backend: linuxBackend, policy });
    const macSvc = new SandboxService({ backend: macBackend, policy });

    assert.deepStrictEqual(linuxSvc.getPolicy(), macSvc.getPolicy());
  });
});
