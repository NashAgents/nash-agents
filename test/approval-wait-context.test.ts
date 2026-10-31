import { test } from "node:test";
import assert from "node:assert/strict";
import { ApprovalService, withApprovalWaitContext } from "../src/approval/approval-service.js";

test("approval wait notifications remain scoped to each asynchronous caller", async () => {
  const pending = new Map<string, (decision: "allow-once" | "deny") => void>();
  const service = new ApprovalService({ askApproval: request => new Promise(resolve => pending.set(request.id!, resolve)) });
  const events: string[] = [];
  const first = withApprovalWaitContext({ start: () => events.push("a:start"), end: () => events.push("a:end") }, () => service.requestApproval({ id: "a", capability: "filesystem-write", reason: "test" }));
  const second = withApprovalWaitContext({ start: () => events.push("b:start"), end: () => events.push("b:end") }, () => service.requestApproval({ id: "b", capability: "network", reason: "test" }));
  assert.deepEqual(events, ["a:start", "b:start"]);
  pending.get("a")!("allow-once");
  assert.equal(await first, "allow-once");
  await Promise.resolve();
  pending.get("b")!("deny");
  assert.equal(await second, "deny");
  assert.deepEqual(events, ["a:start", "b:start", "a:end", "b:end"]);
});
