import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FileSystemAccess } from "../src/sandbox/filesystem-access.js";
import { ApprovalService } from "../src/approval/approval-service.js";
import type { ApprovalRequest } from "../src/approval/types.js";
import type { SandboxPolicy } from "../src/sandbox/types.js";

/**
 * 文件系统边界的同一安全铁律：
 *   approval 只决定「允许的审批如何获得授权」，绝不能单独把明确的
 *   filesystem: read-only / workspace-write 放宽为全盘读写。
 * 需要跨工作区访问时必须由管理员授予该 Task/Run 全访问（danger-full-access），
 * 或显式切换全局策略；auto-grant 本身不具备提权能力。
 *
 * 全部用例执行真实文件系统操作，以「文件是否真的存在」为结论依据。
 */

let root: string;
let workspace: string;
let outsideDir: string;

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "nash-fs-autogrant-"));
  workspace = path.join(root, "workspace");
  outsideDir = path.join(root, "outside");
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(outsideDir, { recursive: true });
  fs.writeFileSync(path.join(outsideDir, "existing.txt"), "outside-secret", "utf8");
});

after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function policy(filesystem: SandboxPolicy["filesystem"]["mode"], approval: SandboxPolicy["approval"]["mode"]): SandboxPolicy {
  return {
    filesystem: { mode: filesystem },
    network: { mode: "deny" },
    approval: { mode: approval },
  };
}

function access(p: SandboxPolicy, approvalService?: ApprovalService): FileSystemAccess {
  return new FileSystemAccess({ workspaceRoot: workspace, policy: p, approvalService });
}

function allowOnceApproval(trace: ApprovalRequest[]): ApprovalService {
  return new ApprovalService({
    provider: {
      async askApproval(request) {
        trace.push(request);
        return "allow-once";
      },
    },
  });
}

describe("approval: auto-grant 不得放宽明确的 filesystem 边界", () => {
  test("read-only + auto-grant：工作区内写入也被真实拒绝", async () => {
    const target = path.join(workspace, "read-only-inside.txt");
    const svc = access(policy("read-only", "auto-grant"));
    await assert.rejects(
      svc.executeAtomicWrite(target, async (resolved) => fsp.writeFile(resolved, "x", "utf8")),
      /auto-grant 不能放宽文件系统边界/
    );
    assert.equal(fs.existsSync(target), false, "拒绝后不得留下任何文件");
  });

  test("workspace-write + auto-grant：工作区内写入成功", async () => {
    const target = path.join(workspace, "inside-ok.txt");
    const svc = access(policy("workspace-write", "auto-grant"));
    await svc.executeAtomicWrite(target, async (resolved) => fsp.writeFile(resolved, "inside", "utf8"));
    assert.equal(fs.readFileSync(target, "utf8"), "inside");
  });

  test("workspace-write + auto-grant：工作区外写入被真实拒绝", async () => {
    const target = path.join(outsideDir, "outside-write.txt");
    const svc = access(policy("workspace-write", "auto-grant"));
    await assert.rejects(
      svc.executeAtomicWrite(target, async (resolved) => fsp.writeFile(resolved, "x", "utf8")),
      /auto-grant 不能放宽该边界/
    );
    assert.equal(fs.existsSync(target), false);
  });

  test("workspace-write + auto-grant：工作区外读取被真实拒绝", async () => {
    const svc = access(policy("workspace-write", "auto-grant"));
    await assert.rejects(
      svc.resolveForRead(path.join(outsideDir, "existing.txt")),
      /auto-grant 不能放宽该边界/
    );
  });

  test("read-only + auto-grant：工作区外读取被真实拒绝", async () => {
    const svc = access(policy("read-only", "auto-grant"));
    await assert.rejects(
      svc.resolveForRead(path.join(outsideDir, "existing.txt")),
      /auto-grant 不能放宽该边界/
    );
  });

  test("danger-full-access + auto-grant：任务级授权等效策略允许真实工作区外写入", async () => {
    const target = path.join(outsideDir, "granted-write.txt");
    const svc = access(policy("danger-full-access", "auto-grant"));
    await svc.executeAtomicWrite(target, async (resolved) => fsp.writeFile(resolved, "granted", "utf8"));
    assert.equal(fs.readFileSync(target, "utf8"), "granted");
  });

  test("workspace-write + ask：人工 allow-once 仍然只放行一次，真实写入成功", async () => {
    const target = path.join(outsideDir, "ask-once.txt");
    const trace: ApprovalRequest[] = [];
    const svc = access(policy("workspace-write", "ask"), allowOnceApproval(trace));
    await svc.executeAtomicWrite(target, async (resolved) => fsp.writeFile(resolved, "approved", "utf8"));
    assert.equal(trace.length, 1, "必须恰好请求一次人工审批");
    assert.equal(trace[0]!.capability, "filesystem-outside-workspace");
    assert.equal(fs.readFileSync(target, "utf8"), "approved");
  });

  test("workspace-write + never：工作区外写入直接 Fail-Closed，不弹审批", async () => {
    const target = path.join(outsideDir, "never-write.txt");
    const trace: ApprovalRequest[] = [];
    const svc = access(policy("workspace-write", "never"), allowOnceApproval(trace));
    await assert.rejects(
      svc.executeAtomicWrite(target, async (resolved) => fsp.writeFile(resolved, "x", "utf8")),
      /拒绝访问工作区根目录之外的路径/
    );
    assert.equal(trace.length, 0);
    assert.equal(fs.existsSync(target), false);
  });
});
