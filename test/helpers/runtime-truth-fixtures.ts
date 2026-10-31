import type { IClusterStore } from "../../src/cluster/storage/cluster-store.js";
import type { NodeHardwareCapability } from "../../src/cluster/protocol/types.js";
import { AutonomousPlanner } from "../../src/cluster/graph/autonomous-planner.js";
import type { DistributedGraphOrchestrator } from "../../src/cluster/graph/graph-orchestrator.js";

/** Test-only simulation. This never establishes REAL_LLM or REAL_REMOTE_WORKER attributes. */
export class SimulatedPlanner extends AutonomousPlanner {
  override planGoal(...args: Parameters<AutonomousPlanner["planGoal"]>) {
    return super.planGoal(args[0], args[1], args[2], { ...args[3], useLlmPlanner: false });
  }
}
export function simulatedSandbox(platform: string): NodeHardwareCapability {
  const now = Date.now();
  return { name: "simulated sandbox", category: "sandbox", status: "verified", details: "TEST FIXTURE ONLY", detectionMethod: "simulation", detectedAt: now, verifiedAt: now,
    structuredDetails: { backend: platform === "darwin" ? "seatbelt" : platform === "win32" ? "windows-sandbox" : "bubblewrap", installed: true, operational: true, filesystemIsolationVerified: true, networkIsolationVerified: true, processIsolationVerified: true,
      supportedPolicies: ["read-only", "workspace-write"], supportedNetworkModes: ["deny", "allow"], verificationExpiresAt: now + 86400000,
      helperPath: "C:\\fixture\\helper.exe", helperSha256: "a".repeat(64) } };
}
export function simulatedCapabilities(platform: string): NodeHardwareCapability[] {
  return [simulatedSandbox(platform), ...["bash", "read_file", "write_file", "edit_file", "list_files", "grep_search"].map((name): NodeHardwareCapability => ({ name: `tool:${name}`, category: "other", status: "available", details: "SIMULATED", detectionMethod: "fixture", detectedAt: Date.now() }))];
}
export async function recordSimulatedExecution(store: IClusterStore, taskId: string, evidence: Record<string, any> = {}) {
  const task = await store.getTask(taskId);
  if (!task) throw new Error("Simulation requires a persisted task");
  const current = await store.getEventsForTask(taskId, 0, 100000);
  let seq = Math.max(0, ...current.map((e) => e.seq));
  const event = (eventType: string, data: Record<string, unknown>) => ({ eventType, data, seq: ++seq, taskId, runId: task.runId ?? "simulation", nodeId: task.nodeId, timestamp: Date.now() });
  const events = [];
  if (evidence.totalToolCalls !== 0) events.push(event("tool.result", { source: "ToolExecutor", toolCallId: `SIMULATED-${seq}`, toolName: "fixture", success: true }));
  for (const input of task.dispatchOptions?.graphContext?.inputs ?? []) {
    const toolCallId = `SIMULATED-READ-${seq}`;
    events.push(event("tool.started", { toolName: "read_graph_artifact", toolCallId, rawArgs: JSON.stringify({ name: input.name, producerNodeId: input.producerNodeId }) }));
    events.push(event("tool.result", { source: "ToolExecutor", toolName: "read_graph_artifact", toolCallId, success: true }));
  }
  if (evidence.testExitCode !== undefined) events.push(event(evidence.testExitCode === 0 ? "job.completed" : "job.failed", { command: "node --test fixture.test.mjs", exitCode: evidence.testExitCode }));
  for (const path of evidence.modifiedFiles ?? []) events.push(event("file.modified", { path }));
  events.push(event("task.completed", {})); await store.appendEvents(events);
}
export async function completeSimulatedTask(store: IClusterStore, orchestrator: DistributedGraphOrchestrator, ...args: Parameters<DistributedGraphOrchestrator["handleNodeTaskCompleted"]>) {
  await recordSimulatedExecution(store, args[1], args[4]);
  return orchestrator.handleNodeTaskCompleted(...args);
}
