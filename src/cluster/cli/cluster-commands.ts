import { resolveNashHome } from "../../config/data-home.js";
import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { ClusterCoordinator } from "../coordinator/cluster-coordinator.js";
import { WorkerRuntime } from "../worker/worker-runtime.js";
import { NodeIdentity } from "../identity/node-identity.js";
import { ProjectRegistry } from "../worker/project-registry.js";
import {
  runServicePreflight,
  formatPreflightReport,
  PREFLIGHT_EXIT_CODES,
} from "../preflight/service-preflight.js";
import {
  installServiceUnits,
  restartService,
  serviceStatus,
  resolveDefaultInstallDir,
  resolveUnitName,
  ServiceManagerError,
  type ServiceRole,
} from "../service/service-manager.js";
import { ServiceUnitValidationError } from "../service/unit-renderer.js";
import { interpretClusterResponse, formatClusterConnectionError } from "./cluster-response.js";

export type ServiceCliAction = "status" | "install" | "restart";

export interface ServiceCliOptions {
  action: ServiceCliAction;
  role: ServiceRole;
  unitName?: string;
  releaseId?: string;
  envFile?: string;
  write: boolean;
  force: boolean;
  enable: boolean;
  dryRun: boolean;
  confirm: boolean;
  json: boolean;
}

export class ClusterCliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClusterCliUsageError";
  }
}

const SERVICE_ACTIONS: ServiceCliAction[] = ["status", "install", "restart"];
const SERVICE_VALUE_FLAGS = new Set(["--role", "--unit", "--release", "--service-env-file"]);
const SERVICE_ACTION_FLAGS: Record<ServiceCliAction, Set<string>> = {
  status: new Set(["--role", "--unit", "--json"]),
  install: new Set(["--role", "--unit", "--release", "--service-env-file", "--write", "--force", "--enable", "--dry-run", "--json"]),
  restart: new Set(["--role", "--unit", "--confirm", "--json"]),
};

/**
 * 严格解析 `nash cluster service ...` 参数：未知参数与缺值立即抛错，
 * 绝不静默忽略（例如把拼错的 --enabel 当成默认 dry-run 悄悄略过）。
 */
export function parseServiceCommandArgs(args: string[]): ServiceCliOptions {
  const [actionRaw, ...rest] = args;
  if (!actionRaw || !SERVICE_ACTIONS.includes(actionRaw as ServiceCliAction)) {
    throw new ClusterCliUsageError(
      `Unknown service action: ${actionRaw ?? "(none)"}. Expected one of: ${SERVICE_ACTIONS.join(" | ")}.`
    );
  }
  const action = actionRaw as ServiceCliAction;
  const allowed = SERVICE_ACTION_FLAGS[action];
  const flags = new Set<string>();
  let role: ServiceRole = "coordinator";
  let unitName: string | undefined;
  let releaseId: string | undefined;
  let envFile: string | undefined;

  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]!;
    if (!token.startsWith("--")) {
      throw new ClusterCliUsageError(`Unexpected argument for 'service ${action}': ${token}`);
    }
    if (!allowed.has(token)) {
      throw new ClusterCliUsageError(
        `Unknown flag for 'service ${action}': ${token}. Allowed: ${[...allowed].join(", ")}.`
      );
    }
    if (SERVICE_VALUE_FLAGS.has(token)) {
      const value = rest[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new ClusterCliUsageError(`Flag ${token} requires a value.`);
      }
      i++;
      if (token === "--unit") {
        unitName = value;
      } else if (token === "--release") {
        releaseId = value;
      } else if (token === "--service-env-file") {
        envFile = value;
      } else {
        if (value !== "coordinator" && value !== "worker" && value !== "product") {
          throw new ClusterCliUsageError(`Invalid --role: ${value}. Expected coordinator | worker | product.`);
        }
        role = value;
      }
      continue;
    }
    flags.add(token);
  }

  const write = flags.has("--write");
  const dryRun = flags.has("--dry-run");
  if (write && dryRun) throw new ClusterCliUsageError("--write and --dry-run are mutually exclusive.");
  if (role === "product" && action === "install" && (!releaseId || !/^[a-f0-9]{40}$/.test(releaseId))) {
    throw new ClusterCliUsageError("Product service install requires --release with a full lowercase commit ID.");
  }
  if (role !== "product" && releaseId) throw new ClusterCliUsageError("--release is only supported for the product service.");
  if (role === "product" && action === "restart") throw new ClusterCliUsageError("Product restart requires a separately verified drain; this command cannot establish one.");

  return {
    action,
    role,
    unitName,
    ...(releaseId ? { releaseId } : {}),
    ...(envFile ? { envFile } : {}),
    write,
    force: flags.has("--force"),
    enable: flags.has("--enable"),
    dryRun,
    confirm: flags.has("--confirm"),
    json: flags.has("--json"),
  };
}

function resolveServiceUser(): string {
  const sudoUser = process.env.SUDO_USER;
  if (sudoUser && /^(?:[A-Za-z_][A-Za-z0-9_.-]{0,31}|\d{1,10})$/.test(sudoUser)) return sudoUser;
  try {
    return os.userInfo().username;
  } catch {
    return "nash";
  }
}

/** CLI 兜底 Coordinator 地址；必须与 Coordinator 自身默认监听端口 (18443) 一致。 */
export const DEFAULT_COORDINATOR_URL = "http://127.0.0.1:18443";

function clusterFetch(
  urlStr: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  } = {}
): Promise<{ json: () => Promise<any>; status: number; ok: boolean; bodyText: string; body?: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const isHttps = url.protocol === "https:";
    const transport = isHttps ? https : http;

    let ca: Buffer | undefined;
    const caPath = path.join(resolveNashHome(), "nash-ca.crt");
    if (isHttps && fs.existsSync(caPath)) {
      try {
        ca = fs.readFileSync(caPath);
      } catch {}
    }

    const req = transport.request(
      url,
      {
        method: options.method ?? "GET",
        headers: { ...(process.env.NASH_ADMIN_API_KEY ? { Authorization: `Bearer ${process.env.NASH_ADMIN_API_KEY}` } : {}), ...options.headers },
        ca,
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => {
          raw += chunk;
        });
        res.on("end", () => {
          const status = res.statusCode ?? 200;
          resolve({
            status,
            ok: status >= 200 && status < 300,
            bodyText: raw,
            json: async () => (raw ? JSON.parse(raw) : {}),
          });
        });
      }
    );

    req.on("error", reject);
    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

export async function handleClusterCommand(args: string[]): Promise<void> {
  const subCommand = args[0] || "help";

  if (subCommand === "help" || args.includes("--help") || args.includes("-h")) {
    printClusterHelp();
    return;
  }

  const identity = new NodeIdentity();
  // 兜底默认必须与 Coordinator 自身默认监听端口一致（18443），
  // 否则 Coordinator 本机（identity 里没有 coordinatorUrl）会连错端口。
  // 本机开通 TLS 时（存在 nash-ca.crt），兜底地址必须用 https：
  // 否则 CLI 会以明文访问 TLS 端口，把认证失败伪装成"连接被重置"。
  const defaultCoordinatorUrl = fs.existsSync(path.join(resolveNashHome(), "nash-ca.crt"))
    ? DEFAULT_COORDINATOR_URL.replace(/^http:/, "https:")
    : DEFAULT_COORDINATOR_URL;
  const rawCoordUrl = process.env.NASH_COORDINATOR_URL || identity.coordinatorUrl || defaultCoordinatorUrl;
  const coordinatorUrl = normalizeHttpUrl(rawCoordUrl);

  switch (subCommand) {
    case "preflight": {
      const portIndex = args.indexOf("--port");
      const hostIndex = args.indexOf("--host");
      const dbIndex = args.indexOf("--db");
      const jsonMode = args.includes("--json");
      const ignorePort = args.includes("--ignore-port");

      const port = portIndex !== -1 ? Number(args[portIndex + 1]) : 18443;
      const host = hostIndex !== -1 ? args[hostIndex + 1] : "127.0.0.1";
      const databaseUrl = dbIndex !== -1 ? args[dbIndex + 1] : process.env.DATABASE_URL;

      const report = await runServicePreflight({
        workingDirectory: process.cwd(),
        listenHost: host,
        listenPort: port,
        checkPort: !ignorePort,
        databaseUrl,
        checkDatabase: Boolean(databaseUrl),
      });

      if (jsonMode) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.log(formatPreflightReport(report));
      }

      if (!report.ok) {
        process.exit(report.exitCode);
      }
      break;
    }

    case "start": {
      const portIndex = args.indexOf("--port");
      const hostIndex = args.indexOf("--host");
      const dbIndex = args.indexOf("--db");
      const webDistIndex = args.indexOf("--web-dist");
      const withWorker = args.includes("--worker");
      const skipPreflight = args.includes("--skip-preflight");

      const port = portIndex !== -1 ? Number(args[portIndex + 1]) : 18443;
      const host = hostIndex !== -1 ? args[hostIndex + 1] : "127.0.0.1";
      const databaseUrl = dbIndex !== -1 ? args[dbIndex + 1] : process.env.DATABASE_URL;
      let webDistDir = webDistIndex !== -1 ? args[webDistIndex + 1] : process.env.NASH_WEB_DIST;
      if (!webDistDir) {
        const defaultCandidates = [
          path.join(process.cwd(), "apps", "web", "dist"),
          "/opt/nash-cluster/apps/web/dist",
        ];
        for (const candidate of defaultCandidates) {
          if (fs.existsSync(candidate)) {
            webDistDir = candidate;
            break;
          }
        }
      }

      // 执行启动前置环境预检 (Service Startup Preflight)
      if (!skipPreflight) {
        const report = await runServicePreflight({
          workingDirectory: process.cwd(),
          listenHost: host,
          listenPort: port,
          databaseUrl,
          checkDatabase: Boolean(databaseUrl),
        });

        if (!report.ok) {
          console.error(formatPreflightReport(report));
          console.error(`[Nash Cluster] Startup aborted by Service Preflight. Terminating process with code ${report.exitCode}.`);
          process.exit(report.exitCode);
        }
      }

      console.log(`Starting Nash Coordinator on ${host}:${port}...`);
      const coordinator = new ClusterCoordinator({
        listenHost: host,
        listenPort: port,
        databaseUrl,
        webDistDir,
      });

      const bound = await coordinator.start();
      console.log(`✓ Nash Coordinator running at ws://${bound.host}:${bound.port}/ws/cluster`);
      console.log(`✓ REST API available at http://${bound.host}:${bound.port}/api/cluster`);

      if (withWorker) {
        console.log(`Starting collocated Local Worker...`);
        const workerIdentity = new NodeIdentity({ name: "Local-Worker" });
        let inviteCode: string | undefined;
        if (!workerIdentity.nodeToken) {
          const autoInvite = coordinator.getInviteManager().createInvite({ role: "coordinator-worker", maxUses: 1 });
          inviteCode = autoInvite.inviteCode;
        }
        const worker = new WorkerRuntime({
          coordinatorUrl: `ws://127.0.0.1:${bound.port}/ws/cluster`,
          name: "Local-Worker",
          inviteCode,
        });
        await worker.start();
        console.log(`✓ Collocated Worker connected (NodeId: ${worker.nodeId})`);
      }

      // 保持前台运行
      await new Promise(() => {});
      break;
    }

    case "service": {
      let options: ServiceCliOptions;
      try {
        options = parseServiceCommandArgs(args.slice(1));
      } catch (error) {
        if (error instanceof ClusterCliUsageError) {
          console.error(error.message);
          printServiceUsage();
          process.exitCode = 2;
          return;
        }
        throw error;
      }

      try {
        const unitName = resolveUnitName(options.role, options.unitName);
        const installDir = resolveDefaultInstallDir();
        const user = resolveServiceUser();

        if (options.action === "status") {
          const status = await serviceStatus(unitName);
          if (options.json) {
            console.log(JSON.stringify(status, null, 2));
            return;
          }
          const d = status.diagnostic;
          console.log(`\n=== Nash systemd Service Status: ${status.unitName} ===`);
          console.log(`systemd available: ${status.available ? "yes" : `no (${status.unavailableReason ?? "not detected"})`}`);
          console.log(`Loaded:            ${d.loaded ? "yes" : "no"}`);
          console.log(`Active state:      ${d.activeState}/${d.subState} (unit: ${d.unitFileState})`);
          console.log(`Working directory: ${d.workingDirectory ?? "unknown"}`);
          console.log(`ExecStart:         ${d.execStart ?? "unknown"}`);
          console.log(`Restart policy:    Restart=${d.restartPolicy}, RestartSec=${d.restartSec ?? "default"}`);
          console.log(`Rate limiting:     StartLimitIntervalSec=${d.startLimitIntervalSec ?? "default"}, StartLimitBurst=${d.startLimitBurst ?? "default"}`);
          console.log(`Exit guard:        RestartPreventExitStatus=${d.restartPreventExitStatus?.join(" ") || "none"}`);
          console.log(status.hasInfiniteRestartRisk ? `[warn] Infinite restart risk: ${d.riskReason}` : `[ok] Restart loop guarded.`);
          console.log("");
          return;
        }

        if (options.action === "install") {
          const role = options.role;
          const base = {
            user,
            group: user,
            installDir,
            nodePath: process.execPath,
            envFile: options.envFile ?? path.posix.join("/etc/nash", role === "coordinator" ? "nash-cluster.env" : role === "worker" ? "nash-worker.env" : "nash-product.env"),
          };
          const shared = {
            unitName,
            write: options.write,
            force: options.force,
            enable: options.enable,
            dryRun: options.dryRun,
          };
          const result =
            role === "coordinator"
              ? await installServiceUnits({
                  role,
                  ...shared,
                  input: {
                    ...base,
                    host: "127.0.0.1",
                    port: 18443,
                    webDist: path.posix.join(installDir, "apps", "web", "dist"),
                  },
                })
              : role === "worker" ? await installServiceUnits({ role, ...shared, input: base })
                : await installServiceUnits({ role, ...shared, input: { ...base, releaseId: options.releaseId!, afterServices: ["postgresql.service", "frpc.service"] } });

          if (options.json) {
            console.log(JSON.stringify(result, null, 2));
          } else {
            console.log(`\n=== Nash systemd Service Install (${result.role}) ===`);
            console.log(`Unit:    ${result.unitName}`);
            console.log(`Target:  ${result.unitPath}`);
            console.log(`Mode:    ${result.dryRun ? "DRY RUN (nothing written)" : result.written ? "WRITTEN" : "NOT WRITTEN"}`);
            if (result.reason) console.log(`Note:    ${result.reason}`);
            console.log("\n--- Rendered Unit ---");
            console.log(result.content);
            console.log("--- systemctl actions ---");
            for (const action of result.actions) {
              console.log(
                action.executed
                  ? `  ${action.exitCode === 0 ? "[ok]" : "[fail]"} systemctl ${action.action}${action.stderr ? `: ${action.stderr}` : ""}`
                  : `  [skip] systemctl ${action.action} (${action.skippedReason})`
              );
            }
            console.log("");
          }

          const actionFailed = result.actions.some((a) => a.executed && a.exitCode !== 0);
          if (result.refused || actionFailed || (!result.written && !result.dryRun)) {
            process.exitCode = 1;
          }
          return;
        }

        const result = await restartService(unitName, { confirm: options.confirm });
        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(formatPreflightReport(result.preflight));
          console.log(result.restarted ? `[ok] systemctl restart ${result.unitName} requested.` : `[blocked] ${result.reason}`);
        }
        process.exitCode = result.exitCode;
        return;
      } catch (error) {
        if (error instanceof ServiceManagerError || error instanceof ServiceUnitValidationError) {
          console.error(error.message);
          process.exitCode = 1;
          return;
        }
        throw error;
      }
    }

    case "status": {
      try {
        const res = await clusterFetch(`${coordinatorUrl}/api/cluster/status`);
        const data = await res.json();
        if (args.includes("--json")) {
          console.log(JSON.stringify(data, null, 2));
        } else {
          console.log("\n=== Nash Cluster Status ===");
          console.log(`Coordinator ID:    ${data.coordinatorNodeId}`);
          console.log(`Online Nodes:      ${data.onlineNodes} / ${data.totalNodes}`);
          console.log(`Total Tasks:       ${data.totalTasks} (${data.runningTasks} running)`);
          console.log(`Pending Approvals: ${data.pendingApprovals}`);
          console.log(`Status:            ${data.status.toUpperCase()}\n`);
        }
      } catch (err) {
        console.error(`Failed to connect to Coordinator at ${coordinatorUrl}: ${err instanceof Error ? err.message : String(err)}`);
      }
      break;
    }

    case "nodes": {
      if (args[1] === "revoke" && args[2]) {
        const nodeId = args[2];
        const res = await clusterFetch(`${coordinatorUrl}/api/cluster/nodes/${nodeId}/revoke`, { method: "POST" });
        const data = await res.json();
        console.log(data.success ? `✓ Revoked node ${nodeId}` : `Failed to revoke node: ${data.error}`);
        return;
      }

      const nodesUrl = `${coordinatorUrl}/api/cluster/nodes`;
      try {
        const res = await clusterFetch(nodesUrl);
        const interpreted = interpretClusterResponse(res.status, res.bodyText, nodesUrl);
        if (!interpreted.ok) {
          // 鉴权/服务端失败绝不伪装成"没有节点"：打印可定位原因并让脚本拿到非 0 退出码。
          console.error(interpreted.message);
          process.exitCode = interpreted.exitCode;
          return;
        }
        const data = interpreted.data as { nodes: any[] };
        if (args.includes("--json")) {
          console.log(JSON.stringify(data, null, 2));
          return;
        }
        console.log("\n=== Registered Cluster Nodes ===");
        if (interpreted.message) {
          // 仅 HTTP 200 + 空数组时出现：确实没有节点注册。
          console.log(`${interpreted.message}\n`);
          return;
        }
        console.log("NODE ID".padEnd(28) + "NAME".padEnd(20) + "STATUS".padEnd(12) + "PLATFORM".padEnd(14) + "LAST SEEN");
        console.log("-".repeat(85));
        for (const n of data.nodes) {
          const lastSeen = n.lastSeenAt ? `${Math.floor((Date.now() - n.lastSeenAt) / 1000)}s ago` : "never";
          console.log(
            n.nodeId.padEnd(28) +
            n.name.slice(0, 18).padEnd(20) +
            n.status.padEnd(12) +
            `${n.platform}/${n.arch}`.padEnd(14) +
            lastSeen
          );
        }
        console.log("");
      } catch (err) {
        console.error(formatClusterConnectionError(nodesUrl, err));
        process.exitCode = 1;
      }
      break;
    }

    case "invite": {
      try {
        const res = await clusterFetch(`${coordinatorUrl}/api/cluster/invite`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ role: "worker", maxUses: 1 }),
        });
        const data = (await res.json()) as any;
        console.log("\n=== New Worker Invite Code ===");
        console.log(`Invite Code: ${data.inviteCode}`);
        console.log(`Expires At:  ${new Date(data.expiresAt).toLocaleString()}`);
        console.log(`\nTo join a worker node, run on the remote machine:`);
        console.log(`  nash node join ${coordinatorUrl.replace(/^http/, "ws")}/ws/cluster ${data.inviteCode}\n`);
      } catch (err) {
        console.error(`Failed to generate invite: ${err instanceof Error ? err.message : String(err)}`);
      }
      break;
    }

    // ============================================================
    // Phase 3: Semantic Task Router & Autonomous Dispatch
    // ============================================================
    case "run":
    case "route": {
      const isDryRunOnly = subCommand === "route" || args.includes("--dry-run");
      const asJson = args.includes("--json");
      const explain = args.includes("--explain");
      const follow = args.includes("--follow");

      const nodeIdx = args.indexOf("--node");
      const projIdx = args.indexOf("--project");
      const timeoutIdx = args.indexOf("--timeout");

      const explicitNodeId = nodeIdx !== -1 ? args[nodeIdx + 1] : undefined;
      const explicitProjectId = projIdx !== -1 ? args[projIdx + 1] : undefined;
      const timeoutMs = timeoutIdx !== -1 ? Number(args[timeoutIdx + 1]) : undefined;

      // 提取目标语句 (排除所有 flags 及其入参)
      const flagIndexes = new Set<number>();
      for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a.startsWith("--")) {
          flagIndexes.add(i);
          if (["--node", "--project", "--timeout"].includes(a) && i + 1 < args.length) {
            flagIndexes.add(i + 1);
          }
        }
      }
      const goalParts = args.slice(1).filter((_, idx) => !flagIndexes.has(idx + 1));
      const goal = goalParts.join(" ").trim();

      if (!goal) {
        console.error("Usage: nash cluster run \"<goal>\" [--dry-run] [--explain] [--node <nodeId>] [--project <projectId>] [--follow] [--json]");
        return;
      }

      try {
        const endpoint = isDryRunOnly ? "/api/cluster/route" : "/api/cluster/run";
        const res = await clusterFetch(`${coordinatorUrl}${endpoint}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            goal,
            constraints: {
              explicitNodeId,
              explicitProjectId,
              timeoutMs,
            },
            dryRun: isDryRunOnly,
          }),
        });

        const data = (await res.json()) as any;
        if (asJson) {
          console.log(JSON.stringify(data, null, 2));
          return;
        }

        const decision = data.decision;
        if (!decision) {
          console.error(`Routing failed: ${data.error || "No decision returned"}`);
          return;
        }

        console.log(`\n=== Semantic Task Routing Decision: [${decision.decisionType}] ===`);
        console.log(`Goal:    "${decision.intent.goal}"`);
        console.log(`Reason:  ${decision.reason}`);

        if (decision.decisionType === "DISPATCH") {
          const sel = decision.selectedCandidate;
          console.log(`\n\x1b[32m✓ Selected Target:\x1b[0m`);
          console.log(`  Node ID:    ${sel.nodeId}`);
          console.log(`  Project:    ${sel.projectName} (${sel.projectId})`);
          console.log(`  Summary:    ${sel.projectSummary}`);
          console.log(`  Score:      ${(sel.score * 100).toFixed(0)}% (Confidence: ${(sel.confidence * 100).toFixed(0)}%)`);

          if (data.dispatchResult?.taskId) {
            console.log(`\n\x1b[32m✓ Task Dispatched:\x1b[0m ${data.dispatchResult.taskId} (Status: ${data.dispatchResult.status})`);
            if (follow) {
              await streamTaskLogs(coordinatorUrl, data.dispatchResult.taskId, true);
              return;
            } else {
              console.log(`To follow live execution events:`);
              console.log(`  nash cluster task logs ${data.dispatchResult.taskId} --follow\n`);
            }
          }
        } else if (decision.decisionType === "CLARIFICATION_REQUIRED") {
          console.log(`\n\x1b[33m? Clarification Required:\x1b[0m ${decision.clarificationPrompt}`);
          if (decision.clarificationOptions) {
            for (let i = 0; i < decision.clarificationOptions.length; i++) {
              const opt = decision.clarificationOptions[i];
              console.log(`  [${i + 1}] ${opt.label} (${opt.projectId}) - ${opt.description}`);
            }
          }
          console.log(`\nTip: Re-run with --node or --project to specify your choice explicitly.\n`);
        } else if (decision.decisionType === "MULTI_NODE_REQUIRED") {
          console.log(`\n\x1b[35m⚡ Multi-Node Required:\x1b[0m`);
          if (decision.multiNodePlan) {
            console.log(`Summary: ${decision.multiNodePlan.summary}`);
            console.log("SubTasks Plan:");
            for (const st of decision.multiNodePlan.subTasks) {
              console.log(`  - [${st.subTaskId}] Node: ${st.nodeId} | Project: ${st.projectId}`);
              console.log(`    Goal: ${st.goal}`);
            }
          }
          console.log("");
        } else if (decision.decisionType === "BLOCKED") {
          console.log(`\n\x1b[31m✖ Execution Blocked:\x1b[0m ${decision.blockedReason || decision.reason}\n`);
        } else if (decision.decisionType === "DEFERRED") {
          console.log(`\n\x1b[33m⏳ Task Deferred:\x1b[0m Target node is currently offline. Awaiting node reconnect.\n`);
        } else if (decision.decisionType === "NO_CANDIDATE") {
          console.log(`\n\x1b[31m✖ No Suitable Candidate Found\x1b[0m for this task in cluster catalog.\n`);
        }

        if (explain && decision.explanation) {
          console.log("\n--- Routing Explanation & Evidence ---");
          if (decision.explanation.selectedNodeReason) {
            console.log(`Node Choice:    ${decision.explanation.selectedNodeReason}`);
          }
          if (decision.explanation.selectedProjectReason) {
            console.log(`Project Choice: ${decision.explanation.selectedProjectReason}`);
          }
          if (decision.explanation.evidencesUsed?.length > 0) {
            console.log("Evidences Used:");
            for (const ev of decision.explanation.evidencesUsed) {
              console.log(`  • ${ev}`);
            }
          }
          if (decision.explanation.whyAlternativesRejected?.length > 0) {
            console.log("Alternatives Rejected:");
            for (const rej of decision.explanation.whyAlternativesRejected) {
              console.log(`  • [${rej.nodeId} / ${rej.projectId}]: ${rej.reason}`);
            }
          }
          console.log("");
        }
      } catch (err) {
        console.error(`Autonomous run failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      break;
    }

    case "dispatch": {
      const nodeId = args[1];
      const projectId = args[2];
      const goal = args[3];

      if (!nodeId || !projectId || !goal) {
        console.error("Usage: nash cluster dispatch <node-id> <project-id> \"<goal>\" [--prompt \"<prompt>\"]");
        return;
      }

      const promptIndex = args.indexOf("--prompt");
      const prompt = promptIndex !== -1 ? args[promptIndex + 1] : undefined;

      try {
        const res = await clusterFetch(`${coordinatorUrl}/api/cluster/tasks`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ nodeId, projectId, goal, prompt }),
        });
        const data = (await res.json()) as any;
        if (data.task) {
          console.log(`✓ Task dispatched successfully!`);
          console.log(`Task ID: ${data.task.taskId}`);
          console.log(`Node ID: ${data.task.nodeId}`);
          console.log(`Status:  ${data.task.status}`);
          console.log(`\nTo view real-time logs:`);
          console.log(`  nash cluster task logs ${data.task.taskId} --follow\n`);
        } else {
          console.error(`Dispatch failed: ${data.error}`);
        }
      } catch (err) {
        console.error(`Failed to dispatch task: ${err instanceof Error ? err.message : String(err)}`);
      }
      break;
    }

    case "tasks": {
      try {
        const res = await clusterFetch(`${coordinatorUrl}/api/cluster/tasks`);
        const data = (await res.json()) as { tasks: any[] };
        if (args.includes("--json")) {
          console.log(JSON.stringify(data, null, 2));
        } else {
          console.log("\n=== Cluster Tasks ===");
          if (!data.tasks || data.tasks.length === 0) {
            console.log("No tasks found.\n");
            return;
          }
          console.log("TASK ID".padEnd(22) + "NODE".padEnd(24) + "STATUS".padEnd(16) + "GOAL");
          console.log("-".repeat(80));
          for (const t of data.tasks) {
            console.log(
              t.taskId.padEnd(22) +
              t.nodeId.slice(0, 22).padEnd(24) +
              t.status.padEnd(16) +
              t.goal.slice(0, 35)
            );
          }
          console.log("");
        }
      } catch (err) {
        console.error(`Failed to list tasks: ${err instanceof Error ? err.message : String(err)}`);
      }
      break;
    }

    case "task": {
      const sub = args[1];
      if (sub === "logs") {
        const taskId = args[2];
        const follow = args.includes("--follow");
        if (!taskId) {
          console.error("Usage: nash cluster task logs <task-id> [--follow]");
          return;
        }
        await streamTaskLogs(coordinatorUrl, taskId, follow);
        return;
      } else if (sub === "steer") {
        const taskId = args[2];
        const content = args[3];
        if (!taskId || !content) {
          console.error("Usage: nash cluster task steer <task-id> \"<guidance>\"");
          return;
        }
        const res = await clusterFetch(`${coordinatorUrl}/api/cluster/tasks/${taskId}/steer`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content }),
        });
        const data = await res.json();
        console.log(data.success ? `✓ Steer sent: ${data.message}` : `Failed: ${data.error}`);
        return;
      } else if (sub === "interrupt") {
        const taskId = args[2];
        const res = await clusterFetch(`${coordinatorUrl}/api/cluster/tasks/${taskId}/interrupt`, { method: "POST" });
        const data = await res.json();
        console.log(data.success ? `✓ Interrupted` : `Failed: ${data.error}`);
        return;
      } else if (sub === "cancel") {
        const taskId = args[2];
        const reason = args[3] || "Cancelled via CLI";
        const res = await clusterFetch(`${coordinatorUrl}/api/cluster/tasks/${taskId}/cancel`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reason }),
        });
        const data = await res.json();
        console.log(data.success ? `✓ Task cancelled` : `Failed: ${data.error}`);
        return;
      } else if (sub === "approvals") {
        const res = await clusterFetch(`${coordinatorUrl}/api/cluster/approvals`);
        const data = (await res.json()) as any;
        console.log("\n=== Pending Remote Approvals ===");
        if (!data.approvals || data.approvals.length === 0) {
          console.log("No pending approvals.\n");
          return;
        }
        for (const a of data.approvals) {
          console.log(`[${a.approvalId}] Task: ${a.taskId} | Node: ${a.nodeId}`);
          console.log(`  Capability: ${a.capability}`);
          console.log(`  Reason:     ${a.reason}`);
          if (a.target) console.log(`  Target:     ${a.target}`);
          console.log(`  Approve: nash cluster task approve ${a.approvalId}`);
          console.log(`  Deny:    nash cluster task deny ${a.approvalId}\n`);
        }
        return;
      } else if (sub === "approve" || sub === "deny") {
        const approvalId = args[2];
        if (!approvalId) {
          console.error(`Usage: nash cluster task ${sub} <approval-id>`);
          return;
        }
        const decision = sub === "approve" ? "allow-once" : "deny";
        const res = await clusterFetch(`${coordinatorUrl}/api/cluster/approvals/${approvalId}/resolve`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ decision, resolvedBy: "cli" }),
        });
        const data = await res.json();
        console.log(data.success ? `✓ Approval ${approvalId} resolved as: ${decision}` : `Failed: ${data.error}`);
        return;
      }

      // 查看单个 task 详情与状态投影
      const taskId = args[1];
      if (!taskId) {
        console.error("Usage: nash cluster task <task-id>");
        return;
      }
      try {
        const res = await clusterFetch(`${coordinatorUrl}/api/cluster/tasks/${taskId}`);
        const data = (await res.json()) as any;
        if (data.task) {
          const t = data.task;
          const p = data.projection;
          console.log(`\n=== Task Details: ${t.taskId} ===`);
          console.log(`Node:             ${t.nodeId}`);
          console.log(`Project:          ${t.projectId}`);
          console.log(`Status:           ${t.status.toUpperCase()}`);
          console.log(`Goal:             ${t.goal}`);
          if (p) {
            console.log(`Current Activity: ${p.currentActivity}`);
            console.log(`Step Progress:    ${p.currentStep} steps (${p.totalToolCalls} tool calls)`);
            if (p.recentTools.length > 0) {
              console.log(`Recent Tools:     ${p.recentTools.join(", ")}`);
            }
          }
          if (t.finalAnswer) {
            console.log(`\n--- Final Answer ---\n${t.finalAnswer}\n`);
          }
          if (t.error) {
            console.log(`\n--- Error ---\n${t.error}\n`);
          }
        } else {
          console.error(`Task not found: ${data.error}`);
        }
      } catch (err) {
        console.error(`Failed to get task: ${err instanceof Error ? err.message : String(err)}`);
      }
      break;
    }

    // ============================================================
    // Phase 2: Cluster Catalog & Federated Memory CLI Commands
    // ============================================================
    case "catalog": {
      const catSub = args[1];
      const asJson = args.includes("--json");

      if (catSub === "nodes") {
        try {
          const res = await clusterFetch(`${coordinatorUrl}/api/cluster/catalog/nodes`);
          const data = (await res.json()) as any;
          if (asJson) {
            console.log(JSON.stringify(data, null, 2));
            return;
          }
          console.log("\n=== Cluster Catalog: Nodes & Capabilities ===");
          if (!data.nodes || data.nodes.length === 0) {
            console.log("No nodes found in catalog.\n");
            return;
          }
          for (const n of data.nodes) {
            const statusLabel = n.online ? "\x1b[32monline\x1b[0m" : `\x1b[31m${n.status}\x1b[0m`;
            console.log(`[${n.nodeId}] ${n.name} (${statusLabel}) - Rev ${n.catalogRevision}`);
            console.log(`  Platform: ${n.platform} (${n.arch}) | Role: ${n.role}`);
            if (n.capabilities && n.capabilities.length > 0) {
              console.log("  Hardware & Environment Capabilities:");
              for (const c of n.capabilities) {
                const statTag = c.status === "verified"
                  ? "\x1b[32m[Verified]\x1b[0m"
                  : c.status === "available"
                  ? "\x1b[36m[Available]\x1b[0m"
                  : c.status === "detected"
                  ? "\x1b[33m[Detected]\x1b[0m"
                  : `[${c.status}]`;
                console.log(`    - ${statTag} ${c.name}: ${c.details}`);
              }
            }
            console.log("");
          }
        } catch (err) {
          console.error(`Failed to fetch catalog nodes: ${err instanceof Error ? err.message : String(err)}`);
        }
        return;
      }

      if (catSub === "projects") {
        try {
          const res = await clusterFetch(`${coordinatorUrl}/api/cluster/catalog/projects`);
          const data = (await res.json()) as any;
          if (asJson) {
            console.log(JSON.stringify(data, null, 2));
            return;
          }
          console.log("\n=== Cluster Catalog: Projects ===");
          if (!data.projects || data.projects.length === 0) {
            console.log("No projects registered in cluster catalog.\n");
            return;
          }
          for (const p of data.projects) {
            const onlineTag = p.nodeOnline ? "\x1b[32m[Online]\x1b[0m" : "\x1b[31m[Offline]\x1b[0m";
            console.log(`${onlineTag} [${p.projectId}] \x1b[1m${p.name}\x1b[0m (Node: ${p.nodeId})`);
            console.log(`  Summary:      ${p.summary || "No summary"}`);
            if (p.technologies && p.technologies.length > 0) {
              console.log(`  Technologies: ${p.technologies.join(", ")}`);
            }
            if (p.capabilities && p.capabilities.length > 0) {
              console.log(`  Capabilities: ${p.capabilities.join(", ")}`);
            }
            console.log(`  Visibility:   ${p.visibility}\n`);
          }
        } catch (err) {
          console.error(`Failed to fetch catalog projects: ${err instanceof Error ? err.message : String(err)}`);
        }
        return;
      }

      if (catSub === "skills") {
        try {
          const res = await clusterFetch(`${coordinatorUrl}/api/cluster/catalog/skills`);
          const data = (await res.json()) as any;
          if (asJson) {
            console.log(JSON.stringify(data, null, 2));
            return;
          }
          console.log("\n=== Cluster Catalog: Skills ===");
          if (!data.skills || data.skills.length === 0) {
            console.log("No skills registered in cluster catalog.\n");
            return;
          }
          for (const s of data.skills) {
            const availTag = s.available ? "\x1b[32mavailable\x1b[0m" : "\x1b[31mdisabled\x1b[0m";
            const onlineTag = s.nodeOnline ? "\x1b[32m[Node Online]\x1b[0m" : "\x1b[31m[Node Offline]\x1b[0m";
            console.log(`${onlineTag} \x1b[1m${s.name}\x1b[0m (${availTag}) - Node: ${s.nodeId}`);
            console.log(`  Description: ${s.description}`);
            if (s.tags && s.tags.length > 0) {
              console.log(`  Tags:        ${s.tags.join(", ")}`);
            }
            console.log("");
          }
        } catch (err) {
          console.error(`Failed to fetch catalog skills: ${err instanceof Error ? err.message : String(err)}`);
        }
        return;
      }

      if (catSub === "mcp") {
        try {
          const res = await clusterFetch(`${coordinatorUrl}/api/cluster/catalog/mcp`);
          const data = (await res.json()) as any;
          if (asJson) {
            console.log(JSON.stringify(data, null, 2));
            return;
          }
          console.log("\n=== Cluster Catalog: MCP Capabilities ===");
          if (!data.mcp || data.mcp.length === 0) {
            console.log("No MCP servers registered in cluster catalog.\n");
            return;
          }
          for (const m of data.mcp) {
            const statTag = m.status === "available"
              ? "\x1b[32m[Available]\x1b[0m"
              : m.status === "configured"
              ? "\x1b[36m[Configured]\x1b[0m"
              : `[${m.status}]`;
            console.log(`${statTag} \x1b[1m${m.displayName}\x1b[0m (${m.transportType}) - Node: ${m.nodeId}`);
            console.log(`  Summary: ${m.capabilitySummary}`);
            if (m.matchedTools && m.matchedTools.length > 0) {
              console.log(`  Tools (${m.matchedTools.length}):`);
              for (const t of m.matchedTools) {
                console.log(`    - ${t.name}: ${t.description} (${t.risk})`);
              }
            }
            console.log("");
          }
        } catch (err) {
          console.error(`Failed to fetch catalog MCP: ${err instanceof Error ? err.message : String(err)}`);
        }
        return;
      }

      // 默认展示 Catalog 全景概览与状态
      try {
        const res = await clusterFetch(`${coordinatorUrl}/api/cluster/catalog/status`);
        const data = (await res.json()) as any;
        if (asJson) {
          console.log(JSON.stringify(data, null, 2));
          return;
        }
        console.log("\n=== Nash Cluster Catalog & Federated Memory Overview ===");
        console.log(`Registered Nodes:    ${data.nodesCount}`);
        console.log(`Catalog Projects:    ${data.projectsCount}`);
        console.log(`Discovered Skills:   ${data.skillsCount}`);
        console.log(`MCP Capabilities:    ${data.mcpCount}`);
        console.log(`Federated Memories:  ${data.memoryIndexCount}`);
        console.log(`Status:              HEALTHY\n`);
        console.log(`Tip: Use 'nash cluster catalog [nodes|projects|skills|mcp]' to inspect details.`);
        console.log(`     Use 'nash cluster search "<query>"' for cross-cluster resource discovery.\n`);
      } catch (err) {
        console.error(`Failed to fetch catalog status: ${err instanceof Error ? err.message : String(err)}`);
      }
      break;
    }

    case "search": {
      const query = args.slice(1).filter((a) => !a.startsWith("--")).join(" ");
      const asJson = args.includes("--json");
      const deep = args.includes("--deep");

      if (!query) {
        console.error("Usage: nash cluster search <query> [--deep] [--json]");
        return;
      }

      try {
        const res = await clusterFetch(`${coordinatorUrl}/api/cluster/catalog/search`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query, deep }),
        });
        const data = (await res.json()) as any;
        if (asJson) {
          console.log(JSON.stringify(data, null, 2));
          return;
        }

        console.log(`\n=== Cluster Unified Search: "${query}" (Found: ${data.totalMatches}) ===\n`);

        if (data.projects && data.projects.length > 0) {
          console.log("\x1b[1m\x1b[36m--- Candidate Projects ---\x1b[0m");
          for (const p of data.projects) {
            const onlineTag = p.nodeOnline ? "\x1b[32m[Online]\x1b[0m" : "\x1b[31m[Offline]\x1b[0m";
            console.log(`${onlineTag} \x1b[1m${p.name}\x1b[0m (Score: ${(p.score * 100).toFixed(0)}%)`);
            console.log(`  Node ID:      ${p.nodeId}`);
            console.log(`  Project ID:   ${p.projectId}`);
            console.log(`  Summary:      ${p.summary}`);
            if (p.technologies?.length > 0) console.log(`  Technologies: ${p.technologies.join(", ")}`);
            if (p.capabilities?.length > 0) console.log(`  Capabilities: ${p.capabilities.join(", ")}`);
            if (p.matchReasons?.length > 0) console.log(`  Match:        ${p.matchReasons.join("; ")}`);
            console.log(`  Evidence:     ${p.evidence}\n`);
          }
        }

        if (data.memoryIndex && data.memoryIndex.length > 0) {
          console.log("\x1b[1m\x1b[35m--- Federated Memory Knowledge Candidates ---\x1b[0m");
          for (const m of data.memoryIndex) {
            const onlineTag = m.nodeOnline ? "\x1b[32m[Online]\x1b[0m" : "\x1b[31m[Offline]\x1b[0m";
            console.log(`${onlineTag} \x1b[1m${m.topic}\x1b[0m (Score: ${(m.score * 100).toFixed(0)}%)`);
            console.log(`  Node ID:    ${m.nodeId} | Project: ${m.projectId}`);
            console.log(`  Summary:    ${m.summary}`);
            console.log(`  Evidence:   ${m.evidence}`);
            if (m.remoteResults && m.remoteResults.length > 0) {
              console.log(`  \x1b[32m✓ Stage 2 Remote Snippets (${m.remoteResults.length}):\x1b[0m`);
              for (const r of m.remoteResults) {
                console.log(`    - [${r.memoryId}] (${r.topic}): ${r.snippet}`);
              }
            }
            console.log("");
          }
        }

        if (data.mcp && data.mcp.length > 0) {
          console.log("\x1b[1m\x1b[33m--- Matched MCP Capabilities ---\x1b[0m");
          for (const m of data.mcp) {
            const onlineTag = m.nodeOnline ? "\x1b[32m[Online]\x1b[0m" : "\x1b[31m[Offline]\x1b[0m";
            console.log(`${onlineTag} Server: \x1b[1m${m.displayName}\x1b[0m (Node: ${m.nodeId})`);
            console.log(`  Summary: ${m.capabilitySummary}`);
            if (m.matchedTools && m.matchedTools.length > 0) {
              for (const t of m.matchedTools) {
                console.log(`  - Tool: ${t.name} (${t.description})`);
              }
            }
            console.log("");
          }
        }

        if (data.skills && data.skills.length > 0) {
          console.log("\x1b[1m\x1b[34m--- Matched Skills ---\x1b[0m");
          for (const s of data.skills) {
            const onlineTag = s.nodeOnline ? "\x1b[32m[Online]\x1b[0m" : "\x1b[31m[Offline]\x1b[0m";
            console.log(`${onlineTag} Skill: \x1b[1m${s.name}\x1b[0m (Node: ${s.nodeId})`);
            console.log(`  Description: ${s.description}\n`);
          }
        }

        if (data.totalMatches === 0) {
          console.log("No matching resources or memories found across cluster.\n");
        }
      } catch (err) {
        console.error(`Search failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      break;
    }

    case "memory": {
      const memSub = args[1];
      const asJson = args.includes("--json");
      const deep = args.includes("--deep");

      if (memSub === "search") {
        const query = args.slice(2).filter((a) => !a.startsWith("--")).join(" ");
        if (!query) {
          console.error("Usage: nash cluster memory search <query> [--deep] [--node <nodeId>] [--project <projectId>]");
          return;
        }

        const nodeIdx = args.indexOf("--node");
        const projIdx = args.indexOf("--project");
        const nodeId = nodeIdx !== -1 ? args[nodeIdx + 1] : undefined;
        const projectId = projIdx !== -1 ? args[projIdx + 1] : undefined;

        try {
          const endpoint = deep ? "/api/cluster/memory/search-remote" : "/api/cluster/memory/search";
          const res = await clusterFetch(`${coordinatorUrl}${endpoint}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ query, nodeId, projectId }),
          });
          const data = (await res.json()) as any;
          if (asJson) {
            console.log(JSON.stringify(data, null, 2));
            return;
          }

          console.log(`\n=== Federated Memory Search: "${query}" (Deep: ${deep ? "Yes" : "No"}) ===\n`);
          if (!data.results || data.results.length === 0) {
            console.log("No relevant federated memory found.\n");
            return;
          }

          for (const m of data.results) {
            const onlineTag = m.nodeOnline ? "\x1b[32m[Online]\x1b[0m" : "\x1b[31m[Offline]\x1b[0m";
            console.log(`${onlineTag} \x1b[1m${m.topic}\x1b[0m (Score: ${(m.score * 100).toFixed(0)}%)`);
            console.log(`  Node ID:    ${m.nodeId}`);
            console.log(`  Project ID: ${m.projectId}`);
            console.log(`  Summary:    ${m.summary}`);
            console.log(`  Evidence:   ${m.evidence}`);
            if (m.remoteResults && m.remoteResults.length > 0) {
              console.log(`  \x1b[32m✓ Stage 2 Remote Memory Content (${m.remoteResults.length} hits):\x1b[0m`);
              for (const r of m.remoteResults) {
                console.log(`    - [${r.memoryId}] Score ${r.score}: ${r.snippet}`);
              }
            } else if (deep && !m.nodeOnline) {
              console.log(`  \x1b[33m(Remote node is offline; cached summary returned)\x1b[0m`);
            }
            console.log("");
          }
        } catch (err) {
          console.error(`Memory search failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        return;
      }

      console.error("Usage: nash cluster memory search <query> [--deep]");
      break;
    }

    // ============================================================
    // Phase 4: Distributed TaskGraph & A2A CLI Commands
    // ============================================================
    case "graph": {
      const graphAction = args[1];

      if (graphAction === "plan") {
        const goal = args.slice(2).filter((a) => !a.startsWith("--")).join(" ");
        if (!goal) {
          console.error('Usage: nash cluster graph plan "<goal>"');
          return;
        }
        try {
          const res = await clusterFetch(`${coordinatorUrl}/api/cluster/graphs/plan`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ goal }),
          });
          const data = (await res.json()) as any;
          if (!data.proposal) {
            console.error(`Planning failed: ${data.error}`);
            return;
          }
          console.log(`\n=== Distributed TaskGraph Plan: "${goal}" ===\n`);
          console.log(`Requires Multi-Agent: ${data.proposal.requiresMultiAgent}`);
          console.log(`Reasoning:            ${data.proposal.reasoning}`);
          console.log(`Validation:           ${data.validation?.valid ? "✓ Valid DAG" : "✖ Invalid"}`);
          if (data.validation?.parallelStages) {
            console.log(`\n--- Parallel Execution Stages (${data.validation.parallelStages.length} stages) ---`);
            data.validation.parallelStages.forEach((stage: string[], idx: number) => {
              console.log(`  Stage ${idx + 1} (Parallel): [${stage.join(", ")}]`);
            });
          }
          console.log(`\n--- Planned Task Nodes (${data.proposal.nodes.length}) ---`);
          for (const n of data.proposal.nodes) {
            const deps = n.dependencies?.length ? `[Depends on: ${n.dependencies.join(", ")}]` : "[No dependencies - Ready]";
            console.log(`* \x1b[1m${n.nodeId}\x1b[0m: ${n.title} ${deps}`);
            console.log(`  Goal: ${n.goal}`);
            if (n.producedArtifacts?.length) {
              console.log(`  Produces: ${n.producedArtifacts.map((a: any) => a.name).join(", ")}`);
            }
            if (n.requiredArtifacts?.length) {
              console.log(`  Requires: ${n.requiredArtifacts.map((a: any) => a.name).join(", ")}`);
            }
            console.log("");
          }
        } catch (err) {
          console.error(`Plan failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        return;
      }

      if (graphAction === "run") {
        const goal = args.slice(2).filter((a) => !a.startsWith("--")).join(" ");
        if (!goal) {
          console.error('Usage: nash cluster graph run "<goal>" [--follow]');
          return;
        }
        try {
          const res = await clusterFetch(`${coordinatorUrl}/api/cluster/graphs/run`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ goal }),
          });
          const data = (await res.json()) as any;
          if (data.mode === "fast_path") {
            console.log(`\n\x1b[33m⚡ Single Task Fast Path triggered (No multi-agent overhead):\x1b[0m`);
            console.log(`Task ID: ${data.result?.dispatchResult?.taskId}`);
            console.log(`Node:    ${data.result?.dispatchResult?.nodeId}`);
            console.log(`Project: ${data.result?.dispatchResult?.projectId}\n`);
            return;
          }
          if (!data.graph) {
            console.error(`Graph execution failed: ${data.error}`);
            return;
          }
          console.log(`\n\x1b[32m✓ Distributed TaskGraph Created & Started!\x1b[0m`);
          console.log(`Graph ID:   \x1b[1m${data.graph.graphId}\x1b[0m`);
          console.log(`Goal:       ${data.graph.parentGoal}`);
          console.log(`Status:     ${data.graph.status.toUpperCase()}`);
          console.log(`Nodes:      ${data.snapshot?.totalNodes} subtasks planned`);
          console.log(`\nMonitor progress: nash cluster graph show ${data.graph.graphId}`);
          console.log(`View subtasks:    nash cluster graph tasks ${data.graph.graphId}`);
          console.log(`Stream events:    nash cluster graph watch ${data.graph.graphId}\n`);
        } catch (err) {
          console.error(`Run failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        return;
      }

      if (graphAction === "list") {
        try {
          const res = await clusterFetch(`${coordinatorUrl}/api/cluster/graphs`);
          const data = (await res.json()) as any;
          console.log("\n=== Distributed TaskGraphs ===");
          if (!data.graphs || data.graphs.length === 0) {
            console.log("No distributed graphs found.\n");
            return;
          }
          console.log("GRAPH ID             STATUS      REV  UPDATED      GOAL");
          console.log("----------------------------------------------------------------------------------");
          for (const g of data.graphs) {
            const timeAgo = `${Math.floor((Date.now() - g.updatedAt) / 1000)}s ago`;
            console.log(
              `${g.graphId.padEnd(20)} ${g.status.toUpperCase().padEnd(11)} ${String(g.revision).padEnd(4)} ${timeAgo.padEnd(12)} ${g.parentGoal.slice(0, 35)}`
            );
          }
          console.log("");
        } catch (err) {
          console.error(`List graphs failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        return;
      }

      if (graphAction === "show" || graphAction === "status") {
        const graphId = args[2];
        if (!graphId) {
          console.error("Usage: nash cluster graph show <graph-id>");
          return;
        }
        try {
          const res = await clusterFetch(`${coordinatorUrl}/api/cluster/graphs/${graphId}`);
          const data = (await res.json()) as any;
          if (!data.graph) {
            console.error(`Graph not found: ${data.error}`);
            return;
          }
          const g = data.graph;
          const s = data.snapshot;
          console.log(`\n=== TaskGraph Details: ${g.graphId} ===`);
          console.log(`Goal:             ${g.parentGoal}`);
          console.log(`Status:           ${g.status.toUpperCase()} (Revision: ${g.revision})`);
          if (s) {
            console.log(`Current Phase:    ${s.currentPhase}`);
            console.log(`Progress:         ${s.completedNodes}/${s.totalNodes} completed (Running: ${s.runningNodes}, Waiting: ${s.waitingNodes}, Blocked: ${s.blockedNodes})`);
            console.log(`Artifacts:        ${s.artifactsCount} deliverables`);
          }
          if (g.finalSummary) {
            console.log(`\n--- Final Summary ---\n${g.finalSummary}\n`);
          }
          if (g.error) {
            console.log(`\n--- Error ---\n${g.error}\n`);
          }
        } catch (err) {
          console.error(`Show graph failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        return;
      }

      if (graphAction === "tasks") {
        const graphId = args[2];
        if (!graphId) {
          console.error("Usage: nash cluster graph tasks <graph-id>");
          return;
        }
        try {
          const res = await clusterFetch(`${coordinatorUrl}/api/cluster/graphs/${graphId}/tasks`);
          const data = (await res.json()) as any;
          console.log(`\n=== Subtasks for Graph ${graphId} ===\n`);
          for (const t of data.tasks || []) {
            const hostTag = t.assignedNodeId ? `[Node: ${t.assignedNodeId}]` : "[Unassigned]";
            console.log(`* \x1b[1m${t.nodeId}\x1b[0m (${t.status.toUpperCase()}) ${hostTag}`);
            console.log(`  Title:   ${t.title}`);
            console.log(`  Goal:    ${t.goal}`);
            if (t.taskId) console.log(`  Task ID: ${t.taskId}`);
            if (t.resultSummary) console.log(`  Result:  ${t.resultSummary}`);
            if (t.error) console.log(`  Error:   ${t.error}`);
            console.log("");
          }
        } catch (err) {
          console.error(`Get tasks failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        return;
      }

      if (graphAction === "artifacts") {
        const graphId = args[2];
        if (!graphId) {
          console.error("Usage: nash cluster graph artifacts <graph-id>");
          return;
        }
        try {
          const res = await clusterFetch(`${coordinatorUrl}/api/cluster/graphs/${graphId}/artifacts`);
          const data = (await res.json()) as any;
          console.log(`\n=== Deliverable Artifacts for Graph ${graphId} ===\n`);
          if (!data.artifacts || data.artifacts.length === 0) {
            console.log("No artifacts registered yet.\n");
            return;
          }
          for (const a of data.artifacts) {
            console.log(`* \x1b[1m${a.name}\x1b[0m (${a.sizeBytes} bytes, ${a.contentType})`);
            console.log(`  Artifact ID: ${a.artifactId}`);
            console.log(`  Producer:    Task ${a.producerTaskId} on ${a.producerNodeId}`);
            console.log(`  SHA256:      ${a.sha256}`);
            console.log(`  Status:      ${a.status}\n`);
          }
        } catch (err) {
          console.error(`Get artifacts failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        return;
      }

      if (graphAction === "steer") {
        const graphId = args[2];
        const instruction = args.slice(3).join(" ");
        if (!graphId || !instruction) {
          console.error('Usage: nash cluster graph steer <graph-id> "<instruction>"');
          return;
        }
        try {
          const res = await clusterFetch(`${coordinatorUrl}/api/cluster/graphs/${graphId}/steer`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ instruction }),
          });
          const data = (await res.json()) as any;
          console.log(`✓ Steer applied. Graph revision bumped to ${data.newRevision}: ${data.reason}`);
        } catch (err) {
          console.error(`Steer failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        return;
      }

      if (graphAction === "pause" || graphAction === "resume" || graphAction === "cancel") {
        const graphId = args[2];
        if (!graphId) {
          console.error(`Usage: nash cluster graph ${graphAction} <graph-id>`);
          return;
        }
        try {
          const res = await clusterFetch(`${coordinatorUrl}/api/cluster/graphs/${graphId}/${graphAction}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ reason: `Manual ${graphAction} via CLI` }),
          });
          const data = (await res.json()) as any;
          console.log(`✓ ${data.message ?? `Graph ${graphId} ${graphAction} executed.`}`);
        } catch (err) {
          console.error(`${graphAction} failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        return;
      }

      console.error("Usage: nash cluster graph <run|plan|list|show|tasks|artifacts|steer|pause|resume|cancel> [args]");
      break;
    }

    default:
      printClusterHelp();
  }
}

async function streamTaskLogs(coordinatorUrl: string, taskId: string, follow: boolean): Promise<void> {
  console.log(`\n--- Streaming Event Logs for ${taskId} ---`);
  if (!follow) {
    const res = await clusterFetch(`${coordinatorUrl}/api/cluster/tasks/${taskId}/events`);
    const data = (await res.json()) as any;
    for (const ev of data.events || []) {
      printEventLine(ev);
    }
    console.log(`--- End of logs ---\n`);
    return;
  }

  const sseUrl = `${coordinatorUrl}/api/cluster/tasks/${taskId}/stream`;
  const res = await clusterFetch(sseUrl);
  if (!res.body) {
    console.error("Failed to connect to SSE stream");
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (line.startsWith("data: ")) {
        try {
          const parsed = JSON.parse(line.slice(6));
          if (parsed.seq !== undefined) {
            printEventLine(parsed);
          } else if (parsed.type === "stream.ended") {
            console.log(`\n✓ Task finished with status: ${parsed.status}`);
            return;
          }
        } catch {}
      }
    }
  }
}

function printEventLine(ev: any): void {
  const time = new Date(ev.timestamp).toLocaleTimeString();
  const seq = String(ev.seq).padStart(3, " ");
  const type = ev.eventType.padEnd(20);
  let summary = "";
  if (ev.data.toolName) summary += `[${ev.data.toolName}] `;
  if (ev.data.goal) summary += `Goal: ${ev.data.goal} `;
  if (ev.data.activitySummary) summary += `${ev.data.activitySummary} `;
  if (ev.data.error) summary += `Error: ${ev.data.error} `;
  if (ev.data.finalAnswer) summary += `Answer: ${ev.data.finalAnswer.slice(0, 60)}... `;
  console.log(`[${time}] #${seq} ${type} ${summary}`);
}

function normalizeHttpUrl(rawUrl: string): string {
  let url = rawUrl.replace(/^ws:\/\//i, "http://").replace(/^wss:\/\//i, "https://");
  url = url.replace(/\/ws\/cluster\/?$/i, "");
  return url.replace(/\/+$/, "");
}

function printServiceUsage(): void {
  console.error(`
Usage:
  nash cluster service status  [--role coordinator|worker|product] [--unit <name>] [--json]
  nash cluster service install [--role coordinator|worker|product] [--unit <name>] [--release <full-sha>] [--service-env-file <path>] [--write] [--force] [--enable] [--dry-run] [--json]
  nash cluster service restart [--role coordinator|worker] [--unit <name>] --confirm [--json]

Defaults: status is read-only, install is a dry run, restart requires --confirm.
`);
}

function printClusterHelp(): void {
  console.log(`
Nash Cluster CLI (Phase 1 & Phase 2: Catalog & Federated Memory)

Usage:
  nash cluster start [--port <p>] [--host <h>] [--db <url>] [--worker]  Start Coordinator (and optional Worker)
  nash cluster preflight [--port <p>] [--host <h>] [--db <url>] [--json] Run service startup preflight environment checks
  nash cluster status                                                    Show Cluster status summary
  nash cluster nodes                                                     List all registered cluster nodes
  nash cluster nodes revoke <node-id>                                    Revoke a node's access token
  nash cluster invite                                                    Generate a single-use invite code
  nash cluster dispatch <node-id> <project-id> "<goal>"                  Dispatch an Agent task to a node
  nash cluster tasks                                                     List cluster tasks
  nash cluster task <task-id>                                            Show task status & state projection
  nash cluster task logs <task-id> [--follow]                            View or follow real-time task events
  nash cluster task steer <task-id> "<guidance>"                         Inject steer instruction to running task
  nash cluster task interrupt <task-id>                                  Request immediate tool interruption
  nash cluster task cancel <task-id>                                     Cancel task execution
  nash cluster task approvals                                            View pending remote approvals
  nash cluster task approve <approval-id>                                Approve pending capability request
  nash cluster task deny <approval-id>                                   Deny pending capability request

Phase 2 Catalog & Federated Memory Commands:
  nash cluster catalog                                                   Show complete cluster catalog summary
  nash cluster catalog nodes                                             List nodes and hardware capabilities
  nash cluster catalog projects                                          List all registered cluster projects
  nash cluster catalog skills                                            List cluster discovered skills
  nash cluster catalog mcp                                               List cluster MCP capabilities & tools
  nash cluster search "<query>" [--deep] [--json]                        Unified search across projects & memory
  nash cluster memory search "<query>" [--deep]                          Two-stage federated memory search

Phase 3 Semantic Task Router & Autonomous Dispatch:
  nash cluster run "<goal>" [--dry-run] [--explain] [--follow]          Intelligently route and execute autonomous task
  nash cluster route "<goal>" [--explain] [--json]                       Plan routing decision without executing

Optional systemd Service Management (Linux, opt-in):
  nash cluster service status [--role <r>] [--unit <name>] [--json]     Inspect unit state & restart-loop risk (read-only)
  nash cluster service install [--role <r>] [--unit <name>] [--write]   Render hardened unit (dry-run by default)
                               [--force] [--enable] [--dry-run] [--json]
  nash cluster service restart [--role <r>] [--unit <name>] --confirm   Preflight first, then systemctl restart

Phase 4 Distributed TaskGraph & A2A Orchestration:
  nash cluster graph run "<goal>"                                        Autonomous decompose, route, and run distributed graph
  nash cluster graph plan "<goal>"                                       Decompose goal and preview DAG dependencies & stages
  nash cluster graph list                                                List all distributed TaskGraphs
  nash cluster graph show <graph-id>                                     Show Graph state projection and phase summary
  nash cluster graph tasks <graph-id>                                    List subtask nodes and assignments
  nash cluster graph artifacts <graph-id>                                View deliverables and SHA256 integrity
  nash cluster graph steer <graph-id> "<instruction>"                   Inject goal adjustment and trigger dynamic replan
  nash cluster graph pause <graph-id>                                    Pause graph dispatching
  nash cluster graph resume <graph-id>                                   Resume graph dispatching
  nash cluster graph cancel <graph-id>                                   Cancel distributed graph execution
`);
}
