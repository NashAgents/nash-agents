import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

test("release manifest binds a clean commit to actual runtime, web and native bytes", async t => {
  const { createReleaseManifest } = await import(pathToFileURL(path.resolve("scripts/create-release-manifest.js")).href);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nash-manifest-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (file: string, value: string) => { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), value); };
  const sha = (value: string) => crypto.createHash("sha256").update(value).digest("hex");
  write(".gitignore", "dist/\napps/web/dist/\n");
  write("package.json", JSON.stringify({ version: "1.0.0", engines: { node: ">=24.14.0 <25" } }));
  write("src/cluster/protocol/types.ts", 'export const CLUSTER_PROTOCOL_VERSION = "1.0" as const;');
  write("src/cluster/storage/migrations.ts", 'const migrations = [{version: 1}, {version: 9}];');
  write("native/windows-sandbox-helper/main.c", "source");
  const helper = "native/bin/win32-x64/nash-windows-sandbox-helper.exe";
  write(helper, "native-bytes");
  write(`${helper}.manifest.json`, JSON.stringify({ binarySha256: sha("native-bytes"), sourceSha256: sha("source"), protocolVersion: 2 }));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.com"); git("add", "."); git("-c", "commit.gpgSign=false", "commit", "-m", "Release fixture");
  const commit = git("rev-parse", "HEAD");
  write("dist/index.js", "runtime");
  const digest = crypto.createHash("sha256").update("dist/index.js").update("runtime").digest("hex");
  write("dist/build-info.json", JSON.stringify({ commit, dirty: false, artifactSha256: digest }));
  write("apps/web/dist/index.html", "web");
  write("apps/web/dist/build-info.json", JSON.stringify({ commit, dirty: false, artifactSha256: sha("apps/web/dist/index.htmlweb") }));
  const manifest = createReleaseManifest(root, "v1.0.0");
  assert.equal(manifest.gitCommit, commit);
  assert.equal(manifest.databaseSchemaVersion, 9);
  assert.equal(manifest.verification.runningServices, "UNVERIFIED");
  assert.equal(manifest.verification.windowsIpv6, "UNVERIFIED");
  assert.ok(!JSON.stringify(manifest).includes(root), "public metadata must not contain private absolute paths");
  assert.throws(() => createReleaseManifest(root, "v2.0.0"), /package version/);
  write("dist/index.js", "tampered");
  assert.throws(() => createReleaseManifest(root, "v1.0.0"), /Runtime artifact bytes/);
  write("dist/index.js", "runtime");
  write("apps/web/dist/index.html", "tampered");
  assert.throws(() => createReleaseManifest(root, "v1.0.0"), /Web artifact bytes/);
  write("apps/web/dist/index.html", "web");
  write(helper, "tampered");
  assert.throws(() => createReleaseManifest(root, "v1.0.0"), /clean committed build|helper source\/binary/);
  write(helper, "native-bytes");
  write("src/uncommitted.ts", "uncommitted");
  assert.throws(() => createReleaseManifest(root, "v1.0.0"), /clean committed build/);
});


test("deployment gate preserves historical uncertainty but blocks current, offline and unverified work", async () => {
  const { classifyReleaseTasks } = await import(pathToFileURL(path.resolve("scripts/release-health-gate.js")).href);
  const task = { taskId: "old", nodeId: "worker", status: "outcome_unknown", updatedAt: 1000 };
  const runtime = { startedAt: new Date(2000).toISOString(), artifactVerified: true, dirty: false };
  const node = { nodeId: "worker", status: "online", runtimeRelease: runtime };
  const result = classifyReleaseTasks([task], [node]);
  assert.equal(result.blocking.length, 0);
  assert.equal(result.historicalUnresolved.length, 1);
  assert.equal(task.status, "outcome_unknown", "classification must never resolve or rewrite task state");
  for (const status of ["created", "running", "accepted", "interrupted", "future_unknown"]) {
    assert.equal(classifyReleaseTasks([{ ...task, status }], [node]).blocking.length, 1);
  }
  assert.equal(classifyReleaseTasks([{ ...task, updatedAt: 3000 }], [node]).blocking.length, 1);
  assert.equal(classifyReleaseTasks([task], [{ ...node, status: "offline" }]).blocking.length, 1);
  assert.equal(classifyReleaseTasks([task], [{ ...node, runtimeRelease: { ...runtime, dirty: true } }]).blocking.length, 1);
});
