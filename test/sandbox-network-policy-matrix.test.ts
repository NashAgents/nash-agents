import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { SandboxService } from "../src/sandbox/sandbox-service.js";
import { ApprovalService } from "../src/approval/approval-service.js";
import type { ApprovalRequest } from "../src/approval/types.js";
import type { SandboxPolicy } from "../src/sandbox/types.js";
import type { SandboxBackend, SandboxProcessRequest, SandboxProcessResult } from "../src/sandbox/types.js";

/**
 * network: deny 与 approval: auto-grant 的组合语义（真实执行）
 *
 * 安全铁律：
 *   - approval 只决定「允许的审批如何获得授权」，不得单独放宽 network: deny；
 *   - 只有管理员显式的任务级全访问 (network: allow) 或全局 network: allow 才能联网；
 *   - auto-grant / never 在内核网络阻断后一律不得静默重试；
 *   - ask 只有在人工明确同意「重新执行一次」后才可一次性放宽，且审批文案必须说明
 *     第一次执行可能已产生副作用。
 *
 * 这些用例全部通过真实沙箱后端执行真实 curl，针对真实的本机 HTTP 服务器验证
 * 「是否真的连通」，而不是仅比较 Policy 对象。
 */

const platformSkip =
  process.platform === "win32"
    ? "Windows 原生沙箱当前只提供 Job/Object 与受限令牌能力，未提供内核级网络隔离；网络边界在 Windows 上无法用真实执行验证（文档化降级能力）"
    : false;

const CURL = "/usr/bin/curl";

function curlAvailable(): boolean {
  try {
    return fs.statSync(CURL).isFile();
  } catch {
    return false;
  }
}

const staticSkip = platformSkip !== false
  ? platformSkip
  : curlAvailable()
    ? false
    : "当前平台未提供可执行 curl，无法进行真实网络边界验证";

function mkdirTemp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "nash-net-matrix-"));
}

function policy(overrides: Partial<SandboxPolicy> & { filesystem?: any; network?: any; approval?: any }): SandboxPolicy {
  return {
    filesystem: { mode: overrides.filesystem?.mode ?? "workspace-write" },
    network: { mode: overrides.network?.mode ?? "deny" },
    approval: { mode: overrides.approval?.mode ?? "ask" },
  };
}

interface ProviderTrace {
  calls: ApprovalRequest[];
  decision: "allow-once" | "deny";
}

function makeApproval(trace: ProviderTrace): ApprovalService {
  return new ApprovalService({
    provider: {
      async askApproval(request: ApprovalRequest) {
        trace.calls.push(request);
        return trace.decision;
      },
    },
  });
}

interface ProbeServer {
  port: number;
  hits: number;
  close(): Promise<void>;
  reset(): void;
}

async function startProbeServer(): Promise<ProbeServer> {
  let hits = 0;
  const server = http.createServer((_req, res) => {
    hits += 1;
    res.end("NETWORK_OK");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  return {
    port: address.port,
    get hits() { return hits; },
    reset() { hits = 0; },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function curlArgs(port: number): string[] {
  return ["-sS", "--connect-timeout", "4", `http://127.0.0.1:${port}/`];
}

describe("network: deny 与 approval 的组合语义（真实 SandboxService 执行）", { skip: staticSkip }, () => {
  let workspace: string;
  let probe: ProbeServer;

  before(async () => {
    workspace = mkdirTemp();
    probe = await startProbeServer();
  });

  after(async () => {
    await probe.close();
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  test("deny + ask + requiresNetwork：执行前审批，allow-once 后真实连通", async () => {
    const trace: ProviderTrace = { calls: [], decision: "allow-once" };
    const svc = new SandboxService({ policy: policy({}), approvalService: makeApproval(trace), cwd: workspace });
    probe.reset();
    const result = await svc.runProcess({ command: CURL, args: curlArgs(probe.port), requiresNetwork: true, cwd: workspace });
    assert.equal(trace.calls.length, 1, "必须在执行前发起一次人工审批");
    assert.equal(trace.calls[0]!.capability, "network");
    assert.equal(result.exitCode, 0, "allow-once 后命令必须真实执行成功");
    assert.match(result.stdout, /NETWORK_OK/);
    assert.equal(probe.hits, 1, "服务器只应收到一次真实连接");
  });

  test("deny + ask + requiresNetwork：人工拒绝时绝不执行、绝不重试", async () => {
    const trace: ProviderTrace = { calls: [], decision: "deny" };
    const svc = new SandboxService({ policy: policy({}), approvalService: makeApproval(trace), cwd: workspace });
    probe.reset();
    await assert.rejects(
      svc.runProcess({ command: CURL, args: curlArgs(probe.port), requiresNetwork: true, cwd: workspace }),
      /用户拒绝了网络访问审批请求/
    );
    assert.equal(probe.hits, 0, "拒绝后不得产生任何真实网络连接");
  });

  test("deny + never + requiresNetwork：直接 Fail-Closed，不弹审批", async () => {
    const trace: ProviderTrace = { calls: [], decision: "allow-once" };
    const svc = new SandboxService({ policy: policy({ approval: { mode: "never" } }), approvalService: makeApproval(trace), cwd: workspace });
    probe.reset();
    await assert.rejects(
      svc.runProcess({ command: CURL, args: curlArgs(probe.port), requiresNetwork: true, cwd: workspace }),
      /approval: never/
    );
    assert.equal(trace.calls.length, 0);
    assert.equal(probe.hits, 0);
  });

  test("deny + auto-grant + requiresNetwork：auto-grant 不得放宽网络边界（P0 回归）", async () => {
    const trace: ProviderTrace = { calls: [], decision: "allow-once" };
    const svc = new SandboxService({ policy: policy({ approval: { mode: "auto-grant" } }), approvalService: makeApproval(trace), cwd: workspace });
    probe.reset();
    await assert.rejects(
      svc.runProcess({ command: CURL, args: curlArgs(probe.port), requiresNetwork: true, cwd: workspace }),
      /auto-grant 不能放宽网络边界/
    );
    assert.equal(trace.calls.length, 0, "auto-grant 下不得再弹出人工审批");
    assert.equal(probe.hits, 0, "auto-grant 下绝不能产生真实网络连接");
  });

  test("deny + auto-grant：内核阻断后不得静默以 allow 重试（P0 回归）", async () => {
    const trace: ProviderTrace = { calls: [], decision: "allow-once" };
    const svc = new SandboxService({ policy: policy({ approval: { mode: "auto-grant" } }), approvalService: makeApproval(trace), cwd: workspace });
    probe.reset();
    const result = await svc.runProcess({ command: CURL, args: curlArgs(probe.port), cwd: workspace });
    assert.notEqual(result.exitCode, 0, "network: deny 下命令必须失败");
    assert.equal(trace.calls.length, 0);
    assert.equal(probe.hits, 0, "不得发生任何隐式网络放宽重试");
  });

  test("deny + never：内核阻断后不得重试", async () => {
    const trace: ProviderTrace = { calls: [], decision: "allow-once" };
    const svc = new SandboxService({ policy: policy({ approval: { mode: "never" } }), approvalService: makeApproval(trace), cwd: workspace });
    probe.reset();
    const result = await svc.runProcess({ command: CURL, args: curlArgs(probe.port), cwd: workspace });
    assert.notEqual(result.exitCode, 0);
    assert.equal(trace.calls.length, 0);
    assert.equal(probe.hits, 0);
  });

  test("deny + ask：内核阻断后必须人工确认「重新执行」，allow-once 才真实连通", async () => {
    const trace: ProviderTrace = { calls: [], decision: "allow-once" };
    const svc = new SandboxService({ policy: policy({}), approvalService: makeApproval(trace), cwd: workspace });
    probe.reset();
    const result = await svc.runProcess({ command: CURL, args: curlArgs(probe.port), cwd: workspace });
    assert.equal(trace.calls.length, 1, "内核阻断后必须请求一次人工授权");
    assert.match(String(trace.calls[0]!.reason), /重新执行/, "审批文案必须如实说明会重新执行命令");
    assert.match(String(trace.calls[0]!.reason), /副作用/, "审批文案必须如实说明第一次执行可能已产生副作用（非幂等风险）");
    assert.equal(result.exitCode, 0);
    assert.equal(probe.hits, 1, "只有被批准的第二执行可以联网");
  });

  test("deny + ask：内核阻断后人工拒绝，命令只执行过一次且无法联网", async () => {
    const trace: ProviderTrace = { calls: [], decision: "deny" };
    const svc = new SandboxService({ policy: policy({}), approvalService: makeApproval(trace), cwd: workspace });
    probe.reset();
    const result = await svc.runProcess({ command: CURL, args: curlArgs(probe.port), cwd: workspace });
    assert.equal(trace.calls.length, 1);
    assert.notEqual(result.exitCode, 0);
    assert.equal(probe.hits, 0, "拒绝后不得重试");
  });

  test("network: allow + auto-grant：无需审批即可联网（任务级全访问的等效策略）", async () => {
    const trace: ProviderTrace = { calls: [], decision: "deny" };
    const svc = new SandboxService({
      policy: policy({ filesystem: { mode: "danger-full-access" }, network: { mode: "allow" }, approval: { mode: "auto-grant" } }),
      approvalService: makeApproval(trace),
      cwd: workspace,
    });
    probe.reset();
    const result = await svc.runProcess({ command: CURL, args: curlArgs(probe.port), requiresNetwork: true, cwd: workspace });
    assert.equal(trace.calls.length, 0, "任务级授权后不再逐次人工审批");
    assert.equal(result.exitCode, 0);
    assert.equal(probe.hits, 1);
  });

  test("network: allow + ask：网络已显式允许，无需额外审批", async () => {
    const trace: ProviderTrace = { calls: [], decision: "deny" };
    const svc = new SandboxService({
      policy: policy({ network: { mode: "allow" } }),
      approvalService: makeApproval(trace),
      cwd: workspace,
    });
    probe.reset();
    const result = await svc.runProcess({ command: CURL, args: curlArgs(probe.port), requiresNetwork: true, cwd: workspace });
    assert.equal(trace.calls.length, 0);
    assert.equal(result.exitCode, 0);
    assert.equal(probe.hits, 1);
  });

  test("运行时授权切换：deny→allow 只影响后续执行，撤销后恢复受限", async () => {
    const trace: ProviderTrace = { calls: [], decision: "deny" };
    const svc = new SandboxService({ policy: policy({}), approvalService: makeApproval(trace), cwd: workspace });

    probe.reset();
    const denied = await svc.runProcess({ command: CURL, args: curlArgs(probe.port), cwd: workspace });
    assert.notEqual(denied.exitCode, 0);
    assert.equal(probe.hits, 0);

    // 模拟任务级全访问授权
    svc.updatePolicy(policy({ filesystem: { mode: "danger-full-access" }, network: { mode: "allow" }, approval: { mode: "auto-grant" } }));
    probe.reset();
    const granted = await svc.runProcess({ command: CURL, args: curlArgs(probe.port), cwd: workspace });
    assert.equal(granted.exitCode, 0);
    assert.equal(probe.hits, 1);

    // 撤销授权
    svc.updatePolicy(policy({}));
    probe.reset();
    const revoked = await svc.runProcess({ command: CURL, args: curlArgs(probe.port), cwd: workspace });
    assert.notEqual(revoked.exitCode, 0);
    assert.equal(probe.hits, 0);
  });
});

// ---------------------------------------------------------------------------
// 受控后端：精确验证「内核网络阻断后」的重试决策与执行次数
// ---------------------------------------------------------------------------

class RecordingBackend implements SandboxBackend {
  readonly name = "recording-stub";
  readonly attempts: Array<{ command: string; network: string; approval: string }> = [];

  isAvailable(): boolean {
    return true;
  }

  async run(request: SandboxProcessRequest): Promise<SandboxProcessResult> {
    this.attempts.push({
      command: request.command,
      network: request.policy.network.mode,
      approval: request.policy.approval.mode,
    });
    if (request.policy.network.mode === "deny") {
      return { exitCode: 7, stdout: "", stderr: "NET_ERR:EPERM" };
    }
    return { exitCode: 0, stdout: "NETWORK_OK", stderr: "" };
  }
}

describe("内核网络阻断后的重试决策（受控后端，精确执行次数）", () => {
  test("auto-grant：绝不重试，绝不改变执行策略", async () => {
    const trace: ProviderTrace = { calls: [], decision: "allow-once" };
    const backend = new RecordingBackend();
    const svc = new SandboxService({
      policy: policy({ approval: { mode: "auto-grant" } }),
      approvalService: makeApproval(trace),
      backend,
      cwd: os.tmpdir(),
    });
    const result = await svc.runProcess({ command: "curl", args: ["http://127.0.0.1:1/"], cwd: os.tmpdir() });
    assert.equal(result.exitCode, 7);
    assert.equal(backend.attempts.length, 1, "只能执行一次");
    assert.equal(backend.attempts[0]!.network, "deny", "不得以 allow 重新执行");
    assert.equal(trace.calls.length, 0, "auto-grant 下不得弹出人工审批");
    assert.equal(svc.getPolicy().network.mode, "deny", "不得污染服务策略");
  });

  test("never：绝不重试", async () => {
    const trace: ProviderTrace = { calls: [], decision: "allow-once" };
    const backend = new RecordingBackend();
    const svc = new SandboxService({
      policy: policy({ approval: { mode: "never" } }),
      approvalService: makeApproval(trace),
      backend,
      cwd: os.tmpdir(),
    });
    await svc.runProcess({ command: "curl", args: ["http://127.0.0.1:1/"], cwd: os.tmpdir() });
    assert.equal(backend.attempts.length, 1);
    assert.equal(trace.calls.length, 0);
  });

  test("ask + allow-once：只重试一次，且第二次为一次性 allow，不污染原策略", async () => {
    const trace: ProviderTrace = { calls: [], decision: "allow-once" };
    const backend = new RecordingBackend();
    const original = policy({});
    const svc = new SandboxService({ policy: original, approvalService: makeApproval(trace), backend, cwd: os.tmpdir() });
    const result = await svc.runProcess({ command: "curl", args: ["http://127.0.0.1:1/"], cwd: os.tmpdir() });
    assert.equal(result.exitCode, 0);
    assert.equal(backend.attempts.length, 2, "恰好重试一次");
    assert.deepEqual(backend.attempts.map((attempt) => attempt.network), ["deny", "allow"]);
    assert.equal(trace.calls.length, 1);
    assert.equal(svc.getPolicy().network.mode, "deny", "拒绝污染全局/服务策略");
    assert.equal(original.network.mode, "deny", "调用方传入的策略对象不得被修改");
  });

  test("ask + deny：只执行一次，绝不重试", async () => {
    const trace: ProviderTrace = { calls: [], decision: "deny" };
    const backend = new RecordingBackend();
    const svc = new SandboxService({ policy: policy({}), approvalService: makeApproval(trace), backend, cwd: os.tmpdir() });
    const result = await svc.runProcess({ command: "curl", args: ["http://127.0.0.1:1/"], cwd: os.tmpdir() });
    assert.equal(result.exitCode, 7);
    assert.equal(backend.attempts.length, 1);
    assert.equal(trace.calls.length, 1);
  });

  test("requiresNetwork + auto-grant：在真正执行前就 Fail-Closed（零执行）", async () => {
    const trace: ProviderTrace = { calls: [], decision: "allow-once" };
    const backend = new RecordingBackend();
    const svc = new SandboxService({
      policy: policy({ approval: { mode: "auto-grant" } }),
      approvalService: makeApproval(trace),
      backend,
      cwd: os.tmpdir(),
    });
    await assert.rejects(svc.runProcess({ command: "curl", args: ["http://127.0.0.1:1/"], requiresNetwork: true, cwd: os.tmpdir() }), /auto-grant/);
    assert.equal(backend.attempts.length, 0, "不得启动任何进程");
    assert.equal(trace.calls.length, 0);
  });

  test("网络非断开性失败（非 EPERM）绝不触发重试", async () => {
    const trace: ProviderTrace = { calls: [], decision: "allow-once" };
    const backend: SandboxBackend = {
      name: "dns-failure-stub",
      isAvailable: () => true,
      run: async (request) => request.policy.network.mode === "deny"
        ? { exitCode: 1, stdout: "", stderr: "command not found: nope" }
        : { exitCode: 0, stdout: "NETWORK_OK", stderr: "" },
    };
    const svc = new SandboxService({ policy: policy({}), approvalService: makeApproval(trace), backend, cwd: os.tmpdir() });
    const result = await svc.runProcess({ command: "nope", args: [], cwd: os.tmpdir() });
    assert.equal(result.exitCode, 1);
    assert.equal(trace.calls.length, 0, "普通失败不得触发网络重试审批");
  });
});
