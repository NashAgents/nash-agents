import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

export function classifyReleaseTasks(tasks, nodes) {
  const historicalUnresolved = [];
  const blocking = tasks.filter(task => {
      if (!["outcome_unknown", "cancelling"].includes(task.status)) return true;
      const worker = nodes.find(node => node.nodeId === task.nodeId);
      const runtime = worker?.runtimeRelease;
      // These states never re-execute from the Worker journal. A newer authenticated
      // live process cannot still be executing this historical run. Preserve its audit state.
      if (worker?.status === "online" && runtime?.artifactVerified === true && runtime?.dirty === false && Number(task.updatedAt) < Date.parse(runtime.startedAt)) {
        historicalUnresolved.push({ taskId: task.taskId, nodeId: task.nodeId, status: task.status });
        return false;
      }
      return true;
    });
  return { blocking, historicalUnresolved };
}

export async function runReleaseHealthGate(args) {
const value = name => args[args.indexOf(name) + 1];
const pid = value("--pid");
if (!/^\d+$/.test(pid ?? "") || Number(pid) <= 0) throw new Error("No live service PID");
// Values stay in memory and the child environment; never serialize the service environment.
const env = Object.fromEntries(fs.readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").filter(item => item.includes("=")).map(item => [item.slice(0, item.indexOf("=")), item.slice(item.indexOf("=") + 1)]));
if (args.includes("--preflight")) {
  const index = args.indexOf("--preflight");
  const result = spawnSync(process.execPath, [args[index + 2], "cluster", "preflight", "--ignore-port"], { cwd: args[index + 1], env, stdio: "inherit", timeout: 15000 });
  process.exit(result.status ?? 1);
}
const base = value("--url");
let headers = {};
let session = false;
async function request(route, init = {}) {
  const res = await fetch(`${base}${route}`, { ...init, headers: { ...headers, ...init.headers }, signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`Health request failed (${res.status})`);
  return res.json();
}
try {
  if (env.NASH_ADMIN_API_KEY) headers.Authorization = `Bearer ${env.NASH_ADMIN_API_KEY}`;
  else {
    const res = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: env.DASHBOARD_USER || env.ADMIN_USER || "admin", password: env.DASHBOARD_PASS || env.ADMIN_PASS }), signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`Health authentication failed (${res.status})`);
    headers.cookie = (res.headers.get("set-cookie") ?? "").split(";")[0];
    headers["x-csrf-token"] = (await res.json()).csrfToken;
    session = true;
  }
  const status = await request("/api/cluster/status");
  if (args.includes("--idle") || args.includes("--inspect")) {
    const tasks = await request("/api/cluster/tasks?limit=100000");
    const inventory = await request("/api/cluster/nodes");
    const pending = (tasks.tasks ?? []).filter(task => !["completed", "failed", "cancelled"].includes(task.status));
    const conversations = await request("/api/cluster/conversations?limit=100000");
    if (!Array.isArray(tasks.tasks) || !Array.isArray(conversations.conversations)) throw new Error("Incomplete idle-state response");
    const active = [];
    for (const conversation of conversations.conversations) {
      const detail = await request(`/api/cluster/conversations/${encodeURIComponent(conversation.id)}`);
      if (detail.isRunning || detail.activeTurn || detail.activeTasks?.length || detail.activeGraphs?.length) active.push(conversation.id);
    }
    const { blocking, historicalUnresolved } = classifyReleaseTasks(pending, inventory.nodes);
    if (args.includes("--inspect")) {
      console.log(JSON.stringify({ inspectedAt: new Date().toISOString(), coordinator: status.runtimeRelease,
        pendingApprovals: status.pendingApprovals, historicalUnresolved, unresolvedTasks: pending.map(task => ({ taskId: task.taskId, nodeId: task.nodeId, status: task.status })), activeConversations: active,
        nodes: inventory.nodes.map(node => ({ nodeId: node.nodeId, name: node.name, status: node.status, platform: node.platform, runtimeRelease: node.runtimeRelease, sandboxCapability: node.sandboxCapability })),
      }, null, 2));
    }
    if (args.includes("--idle") && historicalUnresolved.length) console.log(JSON.stringify({ historicalUnresolved, disposition: "PRESERVED_REQUIRES_MANUAL_RECONCILIATION" }));
    if (args.includes("--idle") && (status.runningTasks || status.pendingApprovals || blocking.length || active.length)) throw new Error("Service has active or unresolved work; deployment blocked");
  }
  if (args.includes("--commit") && (status.runtimeRelease?.commit !== value("--commit") || status.runtimeRelease?.dirty !== false || status.runtimeRelease?.artifactVerified !== true)) throw new Error("Runtime identity differs from requested release");
  console.log(JSON.stringify({ status: "VERIFIED", runtimeRelease: status.runtimeRelease, onlineNodes: status.onlineNodes, runningTasks: status.runningTasks, pendingApprovals: status.pendingApprovals }));
} finally {
  if (session) await request("/api/auth/logout", { method: "POST" });
}

}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runReleaseHealthGate(process.argv.slice(2));
