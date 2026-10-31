import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { captureRuntimeRelease } from "../src/runtime/release-info.js";
// @ts-expect-error —— 纯 ESM 脚本，无类型声明
import { evaluateClusterRelease } from "../scripts/cluster-release-evaluator.js";

/**
 * 构建产物可信性：
 *   - 进程启动时自校验产物字节，而不是相信 build-info 里的自报字段；
 *   - 产物被替换 / 缺失时 artifactVerified=false 且 dirty=true；
 *   - 集群判定必须同时比对 commit 与 artifactSha256，且要求 artifactVerified；
 *   - 哈希覆盖范围必须显式声明，不能被当成整个发布包的完整性证明。
 */

const COMMIT = "a".repeat(40);

function makeDist(): { root: string; dist: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nash-provenance-"));
  const dist = path.join(root, "dist");
  fs.mkdirSync(path.join(dist, "cli"), { recursive: true });
  fs.writeFileSync(path.join(dist, "index.js"), "export const a = 1;\n");
  fs.writeFileSync(path.join(dist, "cli", "main.js"), "export const b = 2;\n");
  fs.writeFileSync(path.join(dist, "notes.json"), "{\"asset\":true}\n");
  return { root, dist };
}

function digestOf(distDir: string, root: string): { sha: string; count: number } {
  const hash = crypto.createHash("sha256");
  let count = 0;
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.name.endsWith(".js")) { hash.update(path.relative(root, file).split(path.sep).join("/")).update(fs.readFileSync(file)); count += 1; }
    }
  };
  walk(distDir);
  return { sha: hash.digest("hex"), count };
}

function writeBuildInfo(root: string, dist: string, overrides: Record<string, unknown> = {}) {
  const { sha, count } = digestOf(dist, root);
  const info = {
    packageVersion: "0.0.0",
    commit: COMMIT,
    dirty: false,
    builtAt: "2026-01-01T00:00:00.000Z",
    artifactSha256: sha,
    artifactScope: "dist/**/*.js",
    artifactFileCount: count,
    ...overrides,
  };
  fs.writeFileSync(path.join(dist, "build-info.json"), JSON.stringify(info, null, 2) + "\n");
  return info;
}

test("构建产物自校验：字节一致时 artifactVerified=true，并公开覆盖范围", (t) => {
  const { root, dist } = makeDist();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const info = writeBuildInfo(root, dist);

  const release = captureRuntimeRelease(dist);
  assert.equal(release.artifactVerified, true);
  assert.equal(release.dirty, false);
  assert.equal(release.commit, COMMIT);
  assert.equal(release.artifactSha256, info.artifactSha256);
  assert.equal(release.artifactScope, "dist/**/*.js");
  assert.equal(release.artifactFileCount, 2, "只有 .js 参与哈希，json 资源不在范围内且范围已声明");
});

test("运行产物摘要使用平台无关路径和确定性顺序", (t) => {
  const { root, dist } = makeDist();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dist, "Z.js"), "upper\n");
  fs.writeFileSync(path.join(dist, "a.js"), "lower\n");
  const sha = crypto.createHash("sha256")
    .update("dist/Z.js").update("upper\n")
    .update("dist/a.js").update("lower\n")
    .update("dist/cli/main.js").update("export const b = 2;\n")
    .update("dist/index.js").update("export const a = 1;\n").digest("hex");
  writeBuildInfo(root, dist, { artifactSha256: sha });
  assert.equal(captureRuntimeRelease(dist).artifactVerified, true);
});

test("产物被篡改：artifactVerified=false 且 dirty=true（绝不自证成功）", (t) => {
  const { root, dist } = makeDist();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeBuildInfo(root, dist);

  fs.writeFileSync(path.join(dist, "index.js"), "export const a = 666;\n");
  const release = captureRuntimeRelease(dist);
  assert.equal(release.artifactVerified, false);
  assert.equal(release.dirty, true);
});

test("产物文件缺失：artifactVerified=false", (t) => {
  const { root, dist } = makeDist();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeBuildInfo(root, dist);

  fs.rmSync(path.join(dist, "cli", "main.js"));
  const release = captureRuntimeRelease(dist);
  assert.equal(release.artifactVerified, false);
  assert.equal(release.dirty, true);
});

test("没有 build-info：commit 为 null、dirty=true，明确标记未验证", (t) => {
  const { root, dist } = makeDist();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const release = captureRuntimeRelease(dist);
  assert.equal(release.commit, null);
  assert.equal(release.artifactVerified, false);
  assert.equal(release.dirty, true);
});

test("build-info 自报哈希与字节不符时，进程不会承认自己已验证", (t) => {
  const { root, dist } = makeDist();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeBuildInfo(root, dist, { artifactSha256: "b".repeat(64) });
  const release = captureRuntimeRelease(dist);
  assert.equal(release.artifactVerified, false);
  assert.equal(release.dirty, true);
});

// ---------------------------------------------------------------------------
// 集群判定
// ---------------------------------------------------------------------------

const ARTIFACT = "c".repeat(64);

function node(overrides: Record<string, unknown> = {}) {
  return {
    nodeId: "node-a",
    platform: "linux",
    status: "online",
    connectionGeneration: 3,
    runtimeRelease: { commit: COMMIT, dirty: false, artifactSha256: ARTIFACT, artifactVerified: true },
    sandboxCapability: { status: "verified", structuredDetails: { verificationExpiresAt: Date.now() + 60_000 } },
    ...overrides,
  };
}

function evaluate(nodes: any[], overrides: Record<string, unknown> = {}) {
  return evaluateClusterRelease({
    expected: { commit: COMMIT, artifactSha256: ARTIFACT },
    coordinatorRelease: { commit: COMMIT, dirty: false, artifactSha256: ARTIFACT, artifactVerified: true },
    nodes,
    expectedNodes: nodes.map((n) => n.nodeId),
    helperSha256: undefined,
    ...overrides,
  });
}

test("集群判定：commit 与产物哈希都匹配才 RUNTIME_VERIFIED", () => {
  const report = evaluate([node()]);
  assert.equal(report.verdict, "RUNTIME_VERIFIED");
  assert.equal(report.nodes[0]!.verdict, "RUNTIME_VERIFIED");
  assert.deepEqual(report.nodes[0]!.reasons, []);
});

test("集群判定：同一 commit 但产物哈希不同，必须判为未验证（不能只看 Git SHA）", () => {
  const report = evaluate([node({ runtimeRelease: { commit: COMMIT, dirty: false, artifactSha256: "d".repeat(64), artifactVerified: true } })]);
  assert.equal(report.verdict, "PARTIAL");
  assert.match(report.nodes[0]!.reasons.join("|"), /artifactSha256 与期望产物不一致/);
});

test("集群判定：节点自校验失败 (artifactVerified=false) 一律未验证", () => {
  const report = evaluate([node({ runtimeRelease: { commit: COMMIT, dirty: false, artifactSha256: ARTIFACT, artifactVerified: false } })]);
  assert.equal(report.verdict, "PARTIAL");
  assert.match(report.nodes[0]!.reasons.join("|"), /产物哈希自校验失败/);
});

test("集群判定：dirty 产物、离线节点、沙箱验证过期、Coordinator 不一致均拒绝", () => {
  const dirty = evaluate([node({ runtimeRelease: { commit: COMMIT, dirty: true, artifactSha256: ARTIFACT, artifactVerified: true } })]);
  assert.match(dirty.nodes[0]!.reasons.join("|"), /dirty/);

  const offline = evaluate([node({ status: "offline" })]);
  assert.equal(offline.verdict, "PARTIAL");

  const expired = evaluate([node({ sandboxCapability: { status: "verified", structuredDetails: { verificationExpiresAt: Date.now() - 1000 } } })]);
  assert.match(expired.nodes[0]!.reasons.join("|"), /验证已过期/);

  const coordinator = evaluate([node()], { coordinatorRelease: { commit: COMMIT, dirty: false, artifactSha256: "e".repeat(64), artifactVerified: true } });
  assert.equal(coordinator.coordinatorVerified, false);
  assert.equal(coordinator.verdict, "PARTIAL");
});

test("集群判定：Windows 节点必须匹配 helper 哈希", () => {
  const win = node({ platform: "win32", sandboxCapability: { status: "verified", structuredDetails: { verificationExpiresAt: Date.now() + 60_000, helperSha256: "f".repeat(64) } } });
  const ok = evaluate([win], { helperSha256: "f".repeat(64) });
  assert.equal(ok.verdict, "RUNTIME_VERIFIED");
  const bad = evaluate([win], { helperSha256: "0".repeat(64) });
  assert.match(bad.nodes[0]!.reasons.join("|"), /helper 哈希不匹配/);
});

test("集群判定：缺失 runtimeRelease 的节点不会因为「在线」而被误判为已验证", () => {
  const report = evaluate([node({ runtimeRelease: undefined })]);
  assert.equal(report.verdict, "PARTIAL");
  assert.match(report.nodes[0]!.reasons.join("|"), /未上报 runtimeRelease/);
});
