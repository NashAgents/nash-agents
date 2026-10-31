import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { WindowsSandboxHelperManager as Helper } from "../src/sandbox/windows/sandbox-helper.js";
import { WindowsSandboxProbe as Probe } from "../src/sandbox/windows/capability-probe.js";
import { runtimeRelease, captureRuntimeRelease } from "../src/runtime/release-info.js";

test("DLL initialization failures cannot verify filesystem, network or Job isolation", (t) => {
  Probe.resetCache();
  t.after(() => Probe.resetCache());
  t.mock.method(Helper, "getArtifactIdentity", () => ({ path: "helper.exe", sha256: "a".repeat(64) }));
  t.mock.method(Helper, "assertArtifactMatchesManifest", () => {});
  t.mock.method(Probe, "probe", () => ({ isWindows: true, helperAvailable: true, appContainerAvailable: true, jobObjectsAvailable: true }));
  t.mock.method(Helper, "execute", () => ({ exitCode: 0xc0000142, stdout: "", stderr: "", killed: false }));
  const result = Probe.verifyIsolation(true);
  assert.equal(result.status, "DEGRADED");
  assert.equal(result.filesystemIsolationVerified, false);
  assert.equal(result.networkDenyVerified, false);
  assert.equal(result.networkAllowVerified, false);
  assert.equal(result.jobObjectsControlVerified, false);
});

test("artifact verification rejects a replaced executable and a missing custom path never falls back", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nash-artifact-test-"));
  t.after(() => { Helper.resetCache(); fs.rmSync(dir, { recursive: true, force: true }); });
  const helper = path.join(dir, "native/bin/win32-x64/helper.exe");
  const source = path.join(dir, "native/windows-sandbox-helper/main.c");
  fs.mkdirSync(path.dirname(helper), { recursive: true });
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.writeFileSync(helper, "version A"); fs.writeFileSync(source, "source A");
  const sha = (file: string) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  fs.writeFileSync(`${helper}.manifest.json`, JSON.stringify({ protocolVersion: 2, binarySha256: sha(helper), sourceSha256: sha(source) }));
  Helper.assertArtifactMatchesManifest(helper);
  fs.writeFileSync(helper, "version B");
  assert.throws(() => Helper.assertArtifactMatchesManifest(helper), /manifest verification failed/);
  assert.equal(Helper.resolveHelperExecutablePath(path.join(dir, "missing.exe")), undefined);
});

test("runtime release is a frozen startup snapshot; unstamped source runs stay unverified", () => {
  assert.equal(Object.isFrozen(runtimeRelease), true);
  assert.equal(runtimeRelease.commit, null);
  assert.equal(runtimeRelease.dirty, true);
  assert.ok(runtimeRelease.pid > 0);
});

test("recovery distinguishes PID reuse and retains records when cleanup fails", async (t) => {
  const { WindowsSandboxCrashRecoveryLedger: Ledger } = await import("../src/sandbox/windows/recovery-ledger.js");
  const cp = (await import("node:child_process")).default;
  const record = { taskId: "old-task", pid: 1234, processIdentity: "old-creation-time", createdAt: 1,
    profileName: "NashOldTask", sid: "S-1-15-2-123", allowedReadPaths: [], allowedWritePaths: [] };
  let removed = 0;
  t.mock.method(Ledger, "readLedger", () => [record]);
  t.mock.method(Ledger, "isProcessAlive", () => true);
  t.mock.method(Ledger, "processIdentity", () => "new-creation-time");
  t.mock.method(Ledger, "deregisterTransaction", () => { removed++; });
  t.mock.method(Helper, "resolveHelperExecutablePath", () => "helper.exe");
  const execute = t.mock.method(cp, "execFileSync", () => Buffer.from("{}"));
  assert.equal(Ledger.recoverOrphans().recovered, 1);
  assert.equal(removed, 1);
  execute.mock.mockImplementation(() => { throw new Error("cleanup denied"); });
  const result = Ledger.recoverOrphans();
  assert.equal(result.recovered, 0);
  assert.ok(result.warnings.length > 0);
  assert.equal(removed, 1, "failed recovery must retain its durable record");
});


test("runtime verifies actual JavaScript bytes and cannot relabel a captured process", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nash-runtime-identity-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, "dist"); fs.mkdirSync(directory);
  const file = path.join(directory, "entry.js"); fs.writeFileSync(file, "original");
  const artifactSha256 = crypto.createHash("sha256").update("dist/entry.js").update("original").digest("hex");
  fs.writeFileSync(path.join(directory, "build-info.json"), JSON.stringify({ commit: "a".repeat(40), packageVersion: "1.0.1", dirty: false, artifactSha256 }));
  const captured = captureRuntimeRelease(directory);
  assert.equal(captured.artifactVerified, true); assert.equal(captured.dirty, false);
  assert.equal(captured.packageVersion, "1.0.1");
  fs.writeFileSync(file, "replaced");
  assert.equal(captured.artifactVerified, true);
  assert.equal(captureRuntimeRelease(directory).dirty, true);
});


test("recovery does not steal cleanup from a live foreign owner", async t => {
  const { WindowsSandboxCrashRecoveryLedger: Ledger } = await import("../src/sandbox/windows/recovery-ledger.js");
  const cp = (await import("node:child_process")).default;
  const record = { taskId: "in-cleanup", pid: process.pid + 1, processIdentity: "birth", cleanupPending: true,
    createdAt: 1, profileName: "NashCleanup", sid: "S-1-15-2-123", allowedReadPaths: [], allowedWritePaths: [] };
  t.mock.method(Ledger, "readLedger", () => [record]);
  t.mock.method(Ledger, "isProcessAlive", () => true);
  t.mock.method(Ledger, "processIdentity", () => "birth");
  t.mock.method(Helper, "resolveHelperExecutablePath", () => "helper.exe");
  t.mock.method(Ledger, "deregisterTransaction", () => {});
  const execute = t.mock.method(cp, "execFileSync", () => Buffer.from("{}"));
  assert.deepEqual(Ledger.recoverOrphans(), { scanned: 1, recovered: 0, warnings: [] });
  assert.equal(execute.mock.callCount(), 0);
  record.pid = process.pid;
  assert.equal(Ledger.recoverOrphans().recovered, 1, "the owner may retry its own failed cleanup");
});
