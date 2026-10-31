import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import tls from "node:tls";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { ProductStore, ProductConfigError, productHome } from "./product/index.js";
import { ClusterCoordinator } from "./cluster/coordinator/cluster-coordinator.js";
import { WorkerRuntime } from "./cluster/worker/worker-runtime.js";
import { ProjectRegistry } from "./cluster/worker/project-registry.js";

export interface ServiceRecord { pid: number; port: number; token: string; startedAt: number; entry: string }
export function readServiceRecord(homeDir = productHome()): ServiceRecord | undefined {
  try {
    const file = path.join(homeDir, "service.json");
    if (fs.lstatSync(file).isSymbolicLink()) throw new ProductConfigError("服务记录不能为符号链接");
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!Number.isSafeInteger(value.pid) || value.pid < 1 || !Number.isSafeInteger(value.port) || value.port < 1 || value.port > 65535 || !/^[a-f0-9]{64}$/.test(value.token)) throw new ProductConfigError("服务记录无效，请先检查诊断信息");
    return value;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
export async function serviceRequest(action: string, homeDir = productHome(), query?: Record<string, string>): Promise<Record<string, any>> {
  const record = readServiceRecord(homeDir);
  if (!record) throw new ProductConfigError("服务尚未启动", "NOT_RUNNING");
  const search = query && Object.keys(query).length ? `?${new URLSearchParams(query).toString()}` : "";
  const readOnly = action === "status" || action === "nodes" || action === "admission";
  const timeoutMs = action === "drain" ? 620000 : action === "stop" ? 60000 : 10000;
  const response = await fetch(`http://127.0.0.1:${record.port}/${action}${search}`, { method: readOnly ? "GET" : "POST", headers: { Authorization: `Bearer ${record.token}` }, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) {
    let payload: Record<string, any> | undefined;
    try { payload = await response.json() as Record<string, any>; } catch {}
    const code = typeof payload?.code === "string" ? payload.code : "CONTROL_REJECTED";
    const error = new ProductConfigError(
      code === "DRAIN_REQUIRED"
        ? "服务未通过排空门禁：仍有活动任务、审批或运行中的会话，拒绝停止；请先完成或显式使用 --force"
        : "本机服务控制请求失败；未发送进程终止信号",
      code,
    );
    (error as ProductConfigError & { response?: unknown }).response = payload;
    throw error;
  }
  return await response.json() as Record<string, any>;
}
export async function runProductService(homeDir = productHome()): Promise<void> {
  const store = new ProductStore({ homeDir });
  let coordinator: ClusterCoordinator | undefined, worker: WorkerRuntime | undefined;
  let ready = false, closing = false, record: ServiceRecord | undefined;
  let resolveStopped!: () => void;
  const stopped = new Promise<void>(resolve => { resolveStopped = resolve; });
  const recordPath = path.join(homeDir, "service.json");
  const lockPath = path.join(homeDir, "service.lock");
  let lockFd: number | undefined;
  const control = http.createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-store");
    const supplied = Buffer.from((req.headers.authorization ?? "").replace(/^Bearer /, ""));
    const expected = Buffer.from(record?.token ?? "");
    if (!expected.length || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { res.writeHead(401); res.end("{}"); return; }
    try {
      if (req.method === "GET" && req.url === "/status") {
        res.end(JSON.stringify({ state: ready ? "running" : "starting", pid: process.pid, coordinatorPid: coordinator ? process.pid : undefined, workerPid: worker ? process.pid : undefined, workerId: worker?.nodeId, role: store.getPublicConfig().role, configurationVersion: store.getPublicConfig().version, startedAt: record!.startedAt }));
      } else if (req.method === "GET" && req.url === "/nodes" && coordinator) {
        const nodes = await coordinator.getStore().listNodes();
        res.end(JSON.stringify({ nodes: nodes.map(({ tokenHash: _secret, ...node }) => ({ ...node, status: node.status === "revoked" ? "revoked" : coordinator!.getRegistry().getConnection(node.nodeId) ? "online" : "offline" })) }));
      } else if (req.method === "POST" && req.url === "/invite" && coordinator) {
        res.end(JSON.stringify(coordinator.getInviteManager().createInvite({ maxUses: 1, ttlMs: 15 * 60000 })));
      } else if (req.method === "GET" && req.url === "/admission" && (coordinator || worker)) {
        res.end(JSON.stringify(coordinator
          ? await coordinator.getAdmissionControl().snapshot()
          : { role: "worker", frozen: worker!.isDraining, activeRuns: worker!.activeRunCount, readyToStop: worker!.isDraining && worker!.activeRunCount === 0 }));
      } else if (req.method === "POST" && req.url?.startsWith("/freeze") && (coordinator || worker)) {
        const reason = new URL(req.url, "http://127.0.0.1").searchParams.get("reason") ?? "operator freeze";
        const state = coordinator?.getAdmissionControl().freeze("operator", reason) ?? { frozen: true, at: Date.now(), by: "operator", reason };
        worker?.beginDrain();
        res.end(JSON.stringify({ admission: state, snapshot: coordinator ? await coordinator.getAdmissionControl().snapshot() : { role: "worker", frozen: worker!.isDraining, activeRuns: worker!.activeRunCount } }));
      } else if (req.method === "POST" && req.url?.startsWith("/unfreeze") && (coordinator || worker)) {
        const state = coordinator?.getAdmissionControl().unfreeze() ?? { frozen: false };
        worker?.cancelDrain();
        res.end(JSON.stringify({ admission: state }));
      } else if (req.method === "POST" && req.url?.startsWith("/drain") && coordinator) {
        const url = new URL(req.url, "http://127.0.0.1");
        const timeoutMs = Math.min(Math.max(Number(url.searchParams.get("timeoutMs") ?? 120000) || 120000, 1000), 600000);
        const admission = coordinator.getAdmissionControl();
        // 先冻结准入，再让本地 Worker 停止接收新分派；最后用真实运行态证明已排空。
        const state = admission.freeze("operator", url.searchParams.get("reason") ?? "operator drain");
        worker?.beginDrain();
        const snapshot = await admission.waitForSettled({ timeoutMs, pollMs: 2000, consecutive: 2 });
        res.end(JSON.stringify({ admission: state, snapshot }));
      } else if (req.method === "POST" && req.url?.startsWith("/drain") && worker) {
        // 纯 Worker 节点：冻结本地接收，等待进程内真实 Runner 归零。
        const url = new URL(req.url, "http://127.0.0.1");
        const timeoutMs = Math.min(Math.max(Number(url.searchParams.get("timeoutMs") ?? 120000) || 120000, 1000), 600000);
        worker.beginDrain();
        const deadline = Date.now() + timeoutMs;
        while (worker.activeRunCount > 0 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 1000));
        res.end(JSON.stringify({ admission: { frozen: true }, snapshot: { role: "worker", frozen: true, activeRuns: worker.activeRunCount, readyToStop: worker.activeRunCount === 0 } }));
      } else if (req.method === "POST" && req.url?.startsWith("/stop")) {
        const url = new URL(req.url, "http://127.0.0.1");
        const force = url.searchParams.get("force") === "true";
        // 安全停止门禁：没有真实的排空证明就不停止服务。
        let snapshot: unknown;
        let blocked = false;
        if (coordinator) {
          snapshot = await coordinator.getAdmissionControl().snapshot();
          blocked = !(snapshot as { readyToStop?: boolean }).readyToStop;
        } else if (worker) {
          blocked = !(worker.isDraining && worker.activeRunCount === 0);
        }
        if (blocked && !force) {
          res.writeHead(409); res.end(JSON.stringify({ stopping: false, code: "DRAIN_REQUIRED", snapshot }));
          return;
        }
        res.end(JSON.stringify({ stopping: true, forced: blocked && force, snapshot }));
        void stop();
      } else { res.writeHead(404); res.end(JSON.stringify({ error: "当前节点不支持此操作" })); }
    } catch { if (!res.writableEnded) { res.writeHead(500); res.end(JSON.stringify({ error: "服务控制操作失败" })); } }
  });
  const stop = async () => {
    if (closing) return;
    closing = true; ready = false;
    try { await worker?.stop(); } finally { await coordinator?.stop(); }
    await new Promise<void>(resolve => { control.close(() => resolve()); control.closeAllConnections(); });
    try { if (record && readServiceRecord(homeDir)?.token === record.token) fs.unlinkSync(recordPath); } catch {}
    if (lockFd !== undefined) { fs.closeSync(lockFd); fs.rmSync(lockPath, { force: true }); lockFd = undefined; }
    store.close();
    process.removeListener("SIGINT", onSignal); process.removeListener("SIGTERM", onSignal);
    resolveStopped();
  };
  const onSignal = () => {
    // systemd / 计划任务直接发信号时无法拒绝停机，但必须留下明确的审计警告：
    // 没有 freeze + drain 证明的停止会取消 Worker 上正在运行的任务。
    if (coordinator && !coordinator.getAdmissionControl().isFrozen()) {
      console.warn("[SERVICE] 收到终止信号，但集群未进入 admission freeze / drain；正在执行的 Worker 任务将被取消。生产停机请先执行 `node dist/index.js stop --drain`。");
    }
    void stop();
  };
  try {
    const config = store.getPublicConfig();
    const old = readServiceRecord(homeDir);
    if (old) {
      try { process.kill(old.pid, 0); throw new ProductConfigError("已有进程占用服务记录，请先运行 status/stop；不会终止身份不明的进程", "SERVICE_EXISTS"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
      fs.unlinkSync(recordPath);
    }
    if (fs.existsSync(lockPath)) {
      const lockedPid = Number(fs.readFileSync(lockPath, "utf8"));
      if (!Number.isSafeInteger(lockedPid) || lockedPid < 1) throw new ProductConfigError("服务锁记录损坏，请先运行诊断，不会删除无法确认归属的锁", "SERVICE_LOCKED");
      try { process.kill(lockedPid, 0); throw new ProductConfigError("已有服务进程或启动过程，请先检查 status", "SERVICE_LOCKED"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
      fs.unlinkSync(lockPath);
    }
    // The lock prevents two launches from both passing the old-record check.
    try { lockFd = fs.openSync(lockPath, "wx", 0o600); fs.writeFileSync(lockFd, String(process.pid)); }
    catch { throw new ProductConfigError("服务启动锁已存在，请检查是否有正在启动的实例", "SERVICE_LOCKED"); }
    await new Promise<void>((resolve, reject) => { control.once("error", reject); control.listen(0, "127.0.0.1", resolve); });
    record = { pid: process.pid, port: (control.address() as { port: number }).port, token: randomBytes(32).toString("hex"), startedAt: Date.now(), entry: fileURLToPath(new URL("./index.js", import.meta.url)) };
    fs.writeFileSync(recordPath, JSON.stringify(record), { mode: 0o600, flag: "wx" });
    process.once("SIGINT", onSignal); process.once("SIGTERM", onSignal);
    const tlsConfig = (config.coordinator as { tls?: { certPath?: string; keyPath?: string } }).tls;
    const tlsCert = process.env.NASH_TLS_CERT ?? tlsConfig?.certPath;
    const tlsKey = process.env.NASH_TLS_KEY ?? tlsConfig?.keyPath;
    const hasTlsConfig = Boolean(process.env.NASH_TLS_CERT || process.env.NASH_TLS_KEY || tlsConfig);

    let hasTls = false;
    if (hasTlsConfig) {
      if (!tlsCert || !tlsKey) {
        throw new ProductConfigError("TLS 配置不完整：必须同时提供证书路径 (certPath) 与私钥路径 (keyPath)", "TLS_CONFIG_INCOMPLETE");
      }
      if (!fs.existsSync(tlsCert)) {
        throw new ProductConfigError(`TLS 证书文件不存在: ${tlsCert}`, "TLS_CERT_NOT_FOUND");
      }
      if (!fs.existsSync(tlsKey)) {
        throw new ProductConfigError(`TLS 私钥文件不存在: ${tlsKey}`, "TLS_KEY_NOT_FOUND");
      }
      try {
        const cert = fs.readFileSync(tlsCert);
        const key = fs.readFileSync(tlsKey);
        tls.createSecureContext({ cert, key });
      } catch (err) {
        throw new ProductConfigError(`TLS 证书或私钥无效或无法读取: ${err instanceof Error ? err.message : String(err)}`, "TLS_INVALID");
      }
      hasTls = true;
    }
    const webProtocol = hasTls ? "https" : "http";
    const wsProtocol = hasTls ? "wss" : "ws";

    if (config.role !== "worker") {
      const runtime = store.getCoordinatorRuntime();
      if (hasTls) (runtime as { tls?: { certPath: string; keyPath: string } }).tls = { certPath: tlsCert!, keyPath: tlsKey! };
      coordinator = new ClusterCoordinator({ ...runtime, customDir: homeDir, productStore: store, name: "Nash Coordinator", webDistDir: fileURLToPath(new URL("../apps/web/dist", import.meta.url)) });
      await coordinator.start();
    }
    if (config.role !== "coordinator") {
      const workerDir = coordinator ? path.join(homeDir, "local-worker") : homeDir;
      if (config.worker?.workspace) {
        fs.mkdirSync(config.worker.workspace, { recursive: true });
        new ProjectRegistry({ customDir: workerDir }).registerProject(config.worker.workspace);
      }
      const host = config.coordinator.listenHost;
      const localHost = host === "0.0.0.0" ? "127.0.0.1" : host === "::" || host === "[::]" ? "[::1]" : host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
      worker = new WorkerRuntime({ customDir: workerDir, productStore: store, maxConcurrentRuns: 1, name: config.worker?.name ?? "Local Worker", coordinatorUrl: coordinator ? `${wsProtocol}://${localHost}:${config.coordinator.listenPort}/ws/cluster` : config.worker?.coordinatorUrl, inviteCode: coordinator ? coordinator.getInviteManager().createInvite({ maxUses: 1, ttlMs: 60000 }).inviteCode : undefined, onFatalError: () => { process.exitCode = 78; void stop(); } });
      await worker.start();
    }
    ready = true;
    console.log(`Nash Agents 已启动（${config.role}，配置 v${config.version}）`);
    if (coordinator) {
      console.log(`Web: ${config.coordinator.publicUrl ?? `${webProtocol}://${config.coordinator.listenHost}:${config.coordinator.listenPort}`}`);
      const host = config.coordinator.listenHost;
      const isLoopback = host === "127.0.0.1" || host === "::1" || host === "localhost";
      if (!isLoopback && !hasTls) {
        console.warn(`[SECURITY WARNING] 协调器监听在非回环地址 '${host}' 且未启用原生 TLS。
局域网内节点令牌、执行指令与返回结果均为明文传输。
在跨机器或暴露到不可信网络前，请配置 TLS 终止反向代理（如 Nginx/Caddy）或部署虚拟加密专网（WireGuard/Tailscale）。`);
      }
    }
    await stopped;
  } catch (error) { await stop(); throw error; }
}
