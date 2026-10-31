import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { SandboxService } from "../src/sandbox/sandbox-service.js";
import { loadSandboxPolicyFromSettings } from "../src/config/settings.js";
import { createDefaultSandboxPolicy } from "../src/sandbox/policy.js";

test("REAL_SANDBOX: shell process preserves the configured runtime PATH instead of sourcing login profiles", { timeout: 45000 }, async (t) => {
  const policy = createDefaultSandboxPolicy(); policy.filesystem.mode = "read-only";
  const workspace = await mkdtemp(path.join(tmpdir(), "nash-runtime-path-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const service = new SandboxService({ policy, cwd: workspace });
  if (!service.getBackend().isAvailable()) { t.skip("Native sandbox unavailable on this host"); return; }
  const previous = process.env.PATH;
  process.env.PATH = `${path.dirname(process.execPath)}${path.delimiter}${previous ?? ''}`;
  t.after(() => { if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous; });
  const output = await service.runBash('node -p "process.version"');
  assert.ok(output.includes(process.version), output);
});
test("MOCK_UNIT: invalid sandbox configuration objects cannot become runtime policy modes", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "nash-policy-shape-")); t.after(() => rm(root, { recursive:true, force:true }));
  await writeFile(path.join(root, "settings.json"), JSON.stringify({ sandbox: { filesystem: { mode: "danger-full-access" }, network: { mode: "allow" }, approval: { mode: "never" } } }));
  const policy = loadSandboxPolicyFromSettings(undefined, { nashHome: root, projectRoot: root });
  assert.equal(policy.filesystem.mode, "workspace-write"); assert.equal(policy.network.mode, "deny"); assert.equal(policy.approval.mode, "ask");
});
