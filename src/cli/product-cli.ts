import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ProductStore, ProductConfigError, productHome, type ProductInitInput, type ModelProfileInput, type SecurityModelBinding } from "../product/index.js";
import { runProductService, serviceRequest, readServiceRecord } from "../product-service.js";
import { WorkerRuntime } from "../cluster/worker/worker-runtime.js";
import { NodeIdentity } from "../cluster/identity/node-identity.js";
import { runNashDoctor } from "./doctor.js";
import { testModelProfile } from "../product/model-check.js";

const entryFile = fileURLToPath(new URL("../index.js", import.meta.url));
const root = fileURLToPath(new URL("../../", import.meta.url));
export function readPrivateJson(file: string): unknown {
  if (file === "-") return JSON.parse(fs.readFileSync(0, "utf8"));
  const info = fs.lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink()) throw new ProductConfigError("配置输入必须为普通文件");
  if (process.platform !== "win32" && info.mode & 0o077) throw new ProductConfigError("配置可能包含凭据，请先将文件权限设为 600");
  if (info.size > 1024 * 1024) throw new ProductConfigError("配置文件超过 1 MiB");
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
class Wizard {
  private muted = false;
  private readonly output = new Writable({ write: (chunk, _encoding, done) => { if (!this.muted) process.stdout.write(chunk); done(); } });
  private readonly rl = createInterface({ input: process.stdin, output: this.output, terminal: true });
  private readonly controller = new AbortController();
  constructor() { this.rl.on("SIGINT", () => this.controller.abort()); }
  async ask(label: string, fallback = "", secret = false): Promise<string> {
    process.stdout.write(`${label}${fallback ? ` [${fallback}]` : ""}: `);
    this.muted = secret;
    try { const answer = (await this.rl.question("", { signal: this.controller.signal })).trim(); return answer || fallback; }
    finally { this.muted = false; if (secret) process.stdout.write("\n"); }
  }
  async select(label: string, options: readonly string[], fallback = 1): Promise<number> {
    console.log(`\n${label}`); options.forEach((option, i) => console.log(`  ${i + 1}. ${option}`));
    for (;;) { const value = await this.ask("请选择", String(fallback)); if (/^[1-9]\d*$/.test(value) && Number(value) <= options.length) return Number(value); console.log("请输入列表中的数字。"); }
  }
  async profile(label: string): Promise<ModelProfileInput> {
    console.log(`\n${label}`);
    const format = (["completions", "responses", "messages"] as const)[await this.select("API 协议", ["Chat Completions", "Responses", "Anthropic Messages"]) - 1];
    return { baseUrl: await this.ask("Base URL", "https://api.example.com/v1"), model: await this.ask("模型名称"), format, apiKey: await this.ask("API Key（隐藏输入）", "", true), timeoutMs: 120000, streaming: true, toolCalling: true };
  }
  close(): void { this.rl.close(); this.output.end(); }
}
export async function interactiveInit(roleFlag?: string): Promise<ProductInitInput> {
  if (!process.stdin.isTTY) throw new ProductConfigError("非交互环境请通过 --config <权限600的JSON文件> 或 --config - 提供配置");
  const wizard = new Wizard();
  try {
    console.log("Nash Agents 初始化。Ctrl+C 可安全取消；配置将在全部校验通过后一次保存。");
    const role = roleFlag ?? (["coordinator-worker", "coordinator", "worker"] as const)[await wizard.select("节点角色", ["Coordinator + Worker（单机默认）", "Coordinator", "Worker"]) - 1];
    if (!["coordinator-worker", "coordinator", "worker"].includes(role)) throw new ProductConfigError("角色应为 coordinator-worker、coordinator 或 worker");
    const input: ProductInitInput = { role: role as ProductInitInput["role"], coordinator: { listenHost: "127.0.0.1", listenPort: 18443 }, models: {}, security: { filesystem: "workspace-write", network: "deny", approval: "ask" } };
    if (role !== "worker") {
      input.coordinator.listenHost = await wizard.ask("Coordinator 监听地址", "127.0.0.1");
      input.coordinator.listenPort = Number(await wizard.ask("Coordinator 端口", "18443"));
      input.coordinator.publicUrl = await wizard.ask("用户与 Worker 可访问的地址", `http://localhost:${input.coordinator.listenPort}`);
      const databaseUrl = await wizard.ask("PostgreSQL URL（留空使用本地持久存储，隐藏输入）", "", true);
      if (databaseUrl) input.coordinator.databaseUrl = databaseUrl;
      input.models.main = await wizard.profile("主模型");
      const mode = await wizard.select("安全模型", ["动态跟随主模型", "复用主模型 Provider，使用不同模型", "独立 Provider"]);
      input.models.security = mode === 1 ? { mode: "follow-main" } : mode === 2 ? { mode: "same-provider", model: await wizard.ask("安全模型名称") } : { mode: "independent", profile: await wizard.profile("独立安全模型") };
      const username = await wizard.ask("管理员用户名", "admin");
      let password: string;
      for (;;) { password = await wizard.ask("管理员密码（至少12字符，隐藏输入）", "", true); if (password.length < 12) { console.log("密码至少12字符。"); continue; } if (password === await wizard.ask("再次输入密码", "", true)) break; console.log("两次密码不一致。"); }
      input.admin = { username, password };
    } else {
      input.worker = { coordinatorUrl: await wizard.ask("Coordinator 地址"), inheritModels: true };
      input.models.security = { mode: "coordinator" };
    }
    const policy = await wizard.select("文件权限", ["Workspace-write：仅授权工作区内读写", "Read-only：只读", "Danger-full-access：完全访问（高风险）"]);
    input.security.filesystem = policy === 1 ? "workspace-write" : policy === 2 ? "read-only" : "danger-full-access";
    if (policy === 3) { console.log("完全访问会允许工具修改工作区以外的数据，并绕过原生文件隔离。安全审查仍启用。"); input.security.confirmFullAccess = await wizard.select("确认完全访问", ["取消", "明确启用 Danger-full-access"]) === 2; if (!input.security.confirmFullAccess) throw new ProductConfigError("已取消，未保存配置", "CANCELLED"); }
    input.security.network = await wizard.select("工具进程网络", ["拒绝（模型与集群通信由受控运行时处理）", "允许"]) === 1 ? "deny" : "allow";
    input.security.approval = await wizard.select("受限操作审批", ["请求人工审批", "拒绝，不发起审批"]) === 1 ? "ask" : "never";
    if (role !== "coordinator") {
      input.worker = { ...input.worker, coordinatorUrl: input.worker?.coordinatorUrl ?? input.coordinator.publicUrl!, name: await wizard.ask("Worker 名称", os.hostname()), workspace: path.resolve(await wizard.ask("授权本机工作目录", path.join(os.homedir(), "nash-workspace"))), inheritModels: true };
    }
    return input;
  } finally { wizard.close(); }
}
async function openStore(): Promise<ProductStore> {
  if (!fs.existsSync(path.join(productHome(), "product.db"))) throw new ProductConfigError("尚未初始化，请运行 node dist/index.js init", "NOT_INITIALIZED");
  const store = new ProductStore();
  if (!store.isInitialized()) { store.close(); throw new ProductConfigError("尚未完成初始化，请重新运行 init", "NOT_INITIALIZED"); }
  return store;
}
async function startBackground(): Promise<void> {
  const homeDir = productHome();
  if (readServiceRecord(homeDir)) { try { console.log(JSON.stringify(await serviceRequest("status"), null, 2)); return; } catch {} }
  fs.mkdirSync(homeDir, { recursive: true, mode: 0o700 });
  const caPath = path.join(homeDir, "nash-ca.crt");
  const env: NodeJS.ProcessEnv = { ...process.env, NASH_HOME: homeDir };
  if (fs.existsSync(caPath) && !env.NODE_EXTRA_CA_CERTS) {
    env.NODE_EXTRA_CA_CERTS = caPath;
  }
  const log = fs.openSync(path.join(homeDir, "service.log"), "a", 0o600);
  const child = spawn(process.execPath, [entryFile, "start", "--service"], { cwd: root, detached: true, windowsHide: true, stdio: ["ignore", log, log], env });
  if (process.platform !== "win32") {
    fs.closeSync(log);
  }
  let spawnError: Error | undefined; child.once("error", error => { spawnError = error; }); child.unref();
  for (let attempt = 0; attempt < 120; attempt++) {
    if (spawnError) throw new ProductConfigError("后台服务无法启动，请检查 Node.js 与目录权限");
    try { const status = await serviceRequest("status", homeDir); if (status.state === "running") { console.log(JSON.stringify(status, null, 2)); return; } } catch {}
    if (child.exitCode !== null) break;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new ProductConfigError("服务尚未就绪，请检查产品目录中的 service.log；不会放宽沙箱策略", "START_FAILED");
}
function validateConfig(store: ProductStore): Record<string, unknown> {
  const config = store.getPublicConfig();
  if (config.role !== "worker") { store.resolveModel({ purpose: "main" }); store.resolveModel({ purpose: "security" }); }
  return { valid: true, version: config.version, role: config.role, credentials: "configured; not displayed", modelConnection: "not tested by configuration validation" };
}
async function joinWorker(): Promise<void> {
  const store = await openStore();
  let worker: WorkerRuntime | undefined;
  try {
    const config = store.getPublicConfig();
    if (config.role !== "worker") throw new ProductConfigError("join 用于独立 Worker；同置 Worker 在 start 时自动配对");
    if (readServiceRecord()) throw new ProductConfigError("请先 stop，再执行配对");
    if (await runNashDoctor([]) !== 0) throw new ProductConfigError("本机沙箱诊断失败，请先修复环境", "SANDBOX_UNAVAILABLE");
    if (!process.stdin.isTTY) throw new ProductConfigError("邀请码需要交互输入；不接受命令行明文邀请码");
    const wizard = new Wizard();
    let inviteCode: string;
    try { inviteCode = await wizard.ask("一次性邀请码（隐藏输入）", "", true); } finally { wizard.close(); }
    worker = new WorkerRuntime({ customDir: store.homeDir, productStore: store, coordinatorUrl: config.worker!.coordinatorUrl, name: config.worker?.name, inviteCode });
    await worker.start();
    console.log(JSON.stringify({ joined: true, nodeId: worker.nodeId, providerKeysCopied: false }));
  } finally { await worker?.stop(); store.close(); }
}
export function assertUpgradeCheckout(directory: string): void {
  try {
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    if (path.relative(fs.realpathSync.native(top), fs.realpathSync.native(directory)) === "") return;
  } catch {}
  throw new ProductConfigError("自动升级只支持独立的源码 Git 工作区；npm 安装请先备份数据，再用 npm 安装已审核的目标版本", "SOURCE_CHECKOUT_REQUIRED");
}
async function upgrade(args: string[]): Promise<void> {
  assertUpgradeCheckout(root);
  const git = (...argv: string[]) => execFileSync("git", argv, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const store = await openStore();
  try {
    const current = git("rev-parse", "HEAD"), branch = git("branch", "--show-current");
    if (git("status", "--porcelain")) throw new ProductConfigError("升级要求源码工作区无改动，请先保存你的修改");
    const configuration = validateConfig(store);
    if (!args.includes("--apply")) { console.log(JSON.stringify({ current, branch, configuration, dataPreserved: true, action: "使用 upgrade --apply 执行 main 快进升级；先做完整备份" }, null, 2)); return; }
    if (branch !== "main") throw new ProductConfigError("自动升级仅支持 main，请先在独立工作区评审并合并版本");
    git("fetch", "origin", "main");
    git("merge-base", "--is-ancestor", "HEAD", "origin/main");
    let wasRunning = false;
    try { wasRunning = (await serviceRequest("status")).state === "running"; } catch { if (readServiceRecord()) throw new ProductConfigError("无法确认服务状态，升级已停止"); }
    if (wasRunning) {
      // 升级同样必须经过排空门禁：先冻结并证明排空，再停止。
      const drained = await serviceRequest("drain", productHome(), { timeoutMs: "300000" });
      if (drained.snapshot?.readyToStop !== true) throw new ProductConfigError("集群未能在超时内排空，升级已停止；服务仍在运行", "DRAIN_TIMEOUT");
      await serviceRequest("stop");
      for (let i = 0; i < 120 && readServiceRecord(); i++) await new Promise(resolve => setTimeout(resolve, 500));
      if (readServiceRecord()) throw new ProductConfigError("服务尚未完全停止，升级已停止");
    }
    const backup = path.join(path.dirname(store.homeDir), `nash-agents-backup-${Date.now()}`);
    fs.mkdirSync(backup, { mode: 0o700 });
    fs.cpSync(store.homeDir, path.join(backup, "data"), { recursive: true, dereference: false });
    fs.writeFileSync(path.join(backup, "source-commit.txt"), current, { mode: 0o600 });
    for (const artifact of ["dist", "apps/web/dist", "native/bin"]) if (fs.existsSync(path.join(root, artifact))) fs.cpSync(path.join(root, artifact), path.join(backup, artifact), { recursive: true });
    const run = (command: string, argv: string[]) => execFileSync(command, argv, { cwd: root, stdio: "inherit", windowsHide: true, shell: process.platform === "win32" });
    try {
      git("merge", "--ff-only", "origin/main");
      const npm = process.platform === "win32" ? "npm.cmd" : "npm";
      run(npm, ["ci"]); run(npm, ["ci", "--prefix", "apps/web"]);
      if (process.platform === "linux") run(npm, ["run", "build:helper:linux"]);
      if (process.platform === "win32") run(npm, ["run", "build:helper:win32"]);
      run(npm, ["run", "typecheck"]); run(npm, ["run", "build:all"]); run(npm, ["run", "test:unit"]);
      console.log(JSON.stringify({ upgraded: true, previousCommit: current, commit: git("rev-parse", "HEAD"), backup, configuration: validateConfig(store), restartRequired: wasRunning }, null, 2));
    } catch { throw new ProductConfigError(`升级未通过验证，服务保持停止；数据与旧产物备份保存在 ${backup}，请按恢复文档回滚`, "UPGRADE_FAILED"); }
  } finally { store.close(); }
}
export async function runProductCli(args: string[]): Promise<number> {
  try {
    const command = args[0];
    if (command === "init") {
      const index = args.indexOf("--config"), roleIndex = args.indexOf("--role");
      const input = index >= 0 ? readPrivateJson(args[index + 1]) as ProductInitInput : await interactiveInit(roleIndex >= 0 ? args[roleIndex + 1] : undefined);
      const store = new ProductStore();
      try {
        if (store.isInitialized()) throw new ProductConfigError("已经初始化，请使用 Web 配置或升级流程", "ALREADY_INITIALIZED");
        store.validateInitialization(input);
        if (input.role !== "coordinator" && await runNashDoctor([]) !== 0) throw new ProductConfigError("原生沙箱不可用，初始化未应用", "SANDBOX_UNAVAILABLE");
        if (input.models?.main) {
          console.log("正在验证主模型文本、工具参数、多轮调用、流式响应与取消能力…");
          await testModelProfile(store.previewModel(input.models.main));
        }
        const security: SecurityModelBinding | undefined = input.models?.security;
        if (security?.mode === "independent") await testModelProfile(store.previewModel(security.profile, "security"));
        if (security?.mode === "same-provider" && input.models.main) await testModelProfile(store.previewModel({ ...input.models.main, model: security.model }, "security"));
        const config = store.initialize(input);
        console.log(JSON.stringify({ initialized: true, version: config.version, role: config.role, home: store.homeDir, next: config.role === "worker" ? "node dist/index.js node join" : "node dist/index.js start" }, null, 2));
      } finally { store.close(); }
      return args.includes("--start") ? await runProductCli(["start", "--background"]) : 0;
    }
    if (command === "start") {
      const store = await openStore(); store.close();
      if (args.includes("--background")) await startBackground(); else await runProductService();
      // Worker fatal-error handling sets a nonzero process exit code before its
      // asynchronous shutdown resolves. Preserve it for the service manager.
      return Number(process.exitCode ?? 0);
    }
    if (command === "stop") {
      const force = args.includes("--force");
      if (!force) {
        // 默认即安全停止：冻结准入并用真实运行态证明排空后再停。
        const timeoutArg = args.indexOf("--timeout");
        const timeoutMs = timeoutArg >= 0 ? String(Math.max(1000, Number(args[timeoutArg + 1]) || 300000)) : "300000";
        const drained = await serviceRequest("drain", productHome(), { timeoutMs });
        const ready = drained.snapshot?.readyToStop === true;
        console.log(JSON.stringify({ drained: ready, snapshot: drained.snapshot }, null, 2));
        if (!ready) throw new ProductConfigError("集群未能在超时内排空，服务保持运行；请处理未完成任务后重试，或显式使用 stop --force", "DRAIN_TIMEOUT");
      } else console.warn("[STOP] --force：跳过排空门禁，正在执行的 Worker 任务将被取消。");
      await serviceRequest("stop", productHome(), force ? { force: "true" } : undefined);
      for (let i = 0; i < 120 && readServiceRecord(); i++) await new Promise(resolve => setTimeout(resolve, 500));
      if (readServiceRecord()) throw new ProductConfigError("服务仍在清理任务，尚未确认停止", "STOP_PENDING");
      console.log("Nash Agents 已停止。"); return 0;
    }
    if (command === "admission") {
      const action = args[1] ?? "status";
      if (action === "status") { console.log(JSON.stringify(await serviceRequest("admission"), null, 2)); return 0; }
      if (action === "freeze") { console.log(JSON.stringify(await serviceRequest("freeze"), null, 2)); return 0; }
      if (action === "unfreeze") { console.log(JSON.stringify(await serviceRequest("unfreeze"), null, 2)); return 0; }
      if (action === "drain") {
        const timeoutArg = args.indexOf("--timeout");
        const timeoutMs = timeoutArg >= 0 ? String(Math.max(1000, Number(args[timeoutArg + 1]) || 300000)) : "300000";
        console.log(JSON.stringify(await serviceRequest("drain", productHome(), { timeoutMs }), null, 2)); return 0;
      }
      throw new ProductConfigError("用法：admission status | admission freeze | admission unfreeze | admission drain [--timeout ms]");
    }
    if (command === "status") { if (!readServiceRecord()) { console.log(JSON.stringify({ state: "stopped" })); return 0; } console.log(JSON.stringify(await serviceRequest("status"), null, 2)); return 0; }
    if (command === "node") { if (args[1] === "join") await joinWorker(); else console.log(JSON.stringify(await serviceRequest(args[1] === "invite" ? "invite" : "nodes"), null, 2)); return 0; }
    if (command === "config") {
      const store = await openStore();
      try {
        if (args[1] === "validate") console.log(JSON.stringify(validateConfig(store), null, 2));
        else if (args[1] === "versions") console.log(JSON.stringify(store.listVersions(), null, 2));
        else if (args[1] === "rollback") { const expected = store.getPublicConfig().version; console.log(JSON.stringify(store.rollback(Number(args[2]), expected), null, 2)); }
        else if (args[1] && args[1] !== "show") throw new ProductConfigError("配置修改请登录 Web；CLI 支持 config、config validate、config versions、config rollback <version>");
        else console.log(JSON.stringify(store.getPublicConfig(), null, 2));
      } finally { store.close(); }
      return 0;
    }
    if (command === "upgrade") { await upgrade(args); return 0; }
    throw new ProductConfigError("未知产品命令");
  } catch (error) {
    if ((error as Error).name === "AbortError") { console.error("已取消，未保存配置。"); return 130; }
    console.error(error instanceof ProductConfigError ? `${error.code}: ${error.message}` : "操作失败，请检查环境、配置与诊断信息。");
    return 78;
  }
}
