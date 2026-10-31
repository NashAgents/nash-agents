import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

type SourceGuard = {
  verifyReleaseSource: (options: Record<string, unknown>) => Promise<Record<string, unknown>>;
};
type ArtifactGuard = {
  verifyWorkspace: (options: Record<string, unknown>) => Record<string, unknown>;
  verifyHelper: (options: Record<string, unknown>) => Record<string, unknown>;
  verifyTarball: (options: Record<string, unknown>) => Record<string, unknown>;
};

const { verifyReleaseSource } = await import(
  pathToFileURL(path.resolve("scripts/verify-release-source.js")).href
) as SourceGuard;
const { verifyWorkspace, verifyHelper, verifyTarball } = await import(
  pathToFileURL(path.resolve("scripts/verify-release-artifact.js")).href
) as ArtifactGuard;

const VERSION = "0.1.0";
const TAG = "v0.1.0";
const TAR_AVAILABLE = (() => {
  try {
    execFileSync("tar", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();
const TAR_SKIP = TAR_AVAILABLE ? false : "tar is not available on this runner";

function sha(data: string | Buffer): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function write(root: string, relative: string, content: string): void {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function makeFixture(t: { after: (fn: () => void) => void }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nash-npm-release-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  write(root, ".gitignore", "dist/\napps/web/dist/\nnative/bin/\n");
  write(root, "package.json", JSON.stringify({
    name: "nash-agents",
    version: VERSION,
    private: false,
    license: "Apache-2.0",
    type: "module",
    bin: { nash: "./dist/index.js", "nash-agents": "./dist/index.js" },
    engines: { node: ">=24.14.0 <25" },
    publishConfig: { access: "public", registry: "https://registry.npmjs.org/" },
    repository: { type: "git", url: "git+https://github.com/NashAgents/nash-agents.git" },
    files: ["dist/", "apps/web/dist/", "native/bin/", "native/linux-sandbox-helper/", "native/windows-sandbox-helper/"],
  }, null, 2));
  write(root, "native/linux-sandbox-helper/main.c", "linux-main\n");
  write(root, "native/linux-sandbox-helper/json-config.h", "linux-config\n");
  write(root, "native/windows-sandbox-helper/main.c", "windows-main\n");
  write(root, "src/keep.ts", "export const keep = true;\n");

  git(root, "init");
  git(root, "config", "user.name", "Release Fixture");
  git(root, "config", "user.email", "release-fixture@example.com");
  git(root, "config", "core.autocrlf", "false");
  git(root, "add", ".");
  git(root, "-c", "commit.gpgSign=false", "commit", "-m", "Release fixture");
  const commit = git(root, "rev-parse", "HEAD");
  git(root, "tag", TAG);

  const linuxBinary = path.join(root, "native/bin/linux-x64/nash-linux-sandbox-helper");
  const winBinary = path.join(root, "native/bin/win32-x64/nash-windows-sandbox-helper.exe");
  fs.mkdirSync(path.dirname(linuxBinary), { recursive: true });
  fs.mkdirSync(path.dirname(winBinary), { recursive: true });
  fs.writeFileSync(linuxBinary, "linux-binary\n", { mode: 0o755 });
  fs.writeFileSync(`${linuxBinary}.manifest.json`, JSON.stringify({
    sourceCommit: commit,
    sourceSha256: sha("linux-main\nlinux-config\n"),
    binarySha256: sha("linux-binary\n"),
    platform: "linux",
    arch: "x64",
    protocolVersion: 1,
  }, null, 2));
  fs.writeFileSync(winBinary, "windows-binary\n");
  fs.writeFileSync(`${winBinary}.manifest.json`, JSON.stringify({
    schemaVersion: 1,
    sourceCommit: commit,
    sourceSha256: sha("windows-main\n"),
    binarySha256: sha("windows-binary\n"),
    platform: "win32",
    arch: "x64",
    protocolVersion: 2,
  }, null, 2));

  write(root, "dist/index.js", "export const runtime = 1;\n");
  write(root, "dist/build-info.json", JSON.stringify({
    packageVersion: VERSION,
    commit,
    dirty: false,
    builtAt: "2026-01-01T00:00:00.000Z",
    artifactSha256: sha("dist/index.jsexport const runtime = 1;\n"),
    artifactScope: "dist/**/*.js",
    artifactFileCount: 1,
  }, null, 2));
  write(root, "apps/web/dist/index.html", "<html>release</html>\n");
  write(root, "apps/web/dist/build-info.json", JSON.stringify({
    commit,
    dirty: false,
    builtAt: "2026-01-01T00:00:00.000Z",
    artifactSha256: sha("apps/web/dist/index.html<html>release</html>\n"),
  }, null, 2));

  return { root, commit, linuxBinary, winBinary };
}

test("release source guard accepts a lightweight tag bound to the clean release commit", async t => {
  const { root, commit } = makeFixture(t);
  const result = await verifyReleaseSource({
    root,
    expectedVersion: VERSION,
    expectedTag: TAG,
    requireCi: false,
    env: {},
  });
  assert.equal(result.status, "PASSED");
  assert.equal(result.commit, commit);
  assert.equal(result.tagType, "commit");
  assert.equal(result.worktreeClean, true);
});

test("release source guard rejects annotated tags because provenance would record the tag object", async t => {
  const { root } = makeFixture(t);
  git(root, "tag", "-d", TAG);
  git(root, "tag", "-a", TAG, "-m", "annotated release tag");
  await assert.rejects(
    () => verifyReleaseSource({ root, expectedVersion: VERSION, expectedTag: TAG, env: {} }),
    /lightweight tag/,
  );
});

test("release source guard rejects a version mismatch, dirty worktree and tag/commit divergence", async t => {
  const { root, commit } = makeFixture(t);
  const originalPackage = fs.readFileSync(path.join(root, "package.json"), "utf8");
  write(root, "package.json", originalPackage.replace(`"version": "${VERSION}"`, '"version": "9.9.9"'));
  await assert.rejects(
    () => verifyReleaseSource({ root, expectedVersion: VERSION, expectedTag: TAG, env: {} }),
    /version must be 0\.1\.0/,
  );
  write(root, "package.json", originalPackage);

  write(root, "src/uncommitted.txt", "dirty\n");
  await assert.rejects(
    () => verifyReleaseSource({ root, expectedVersion: VERSION, expectedTag: TAG, env: {} }),
    /not clean/,
  );
  fs.rmSync(path.join(root, "src/uncommitted.txt"));

  write(root, "src/next.ts", "export const next = true;\n");
  git(root, "add", ".");
  git(root, "-c", "commit.gpgSign=false", "commit", "-m", "Move HEAD past the tag");
  await assert.rejects(
    () => verifyReleaseSource({ root, expectedVersion: VERSION, expectedTag: TAG, env: {} }),
    /points to/,
  );
  git(root, "reset", "--hard", commit);
});

test("release source guard fails closed when the CI gate has no token", async t => {
  const { root } = makeFixture(t);
  await assert.rejects(
    () => verifyReleaseSource({ root, expectedVersion: VERSION, expectedTag: TAG, requireCi: true, env: {} }),
    /GITHUB_TOKEN/,
  );
});

test("release source guard requires successful push and workflow_dispatch Validation runs for the tag commit", async t => {
  const { root, commit } = makeFixture(t);
  const origin = fs.mkdtempSync(path.join(os.tmpdir(), "nash-npm-release-origin-"));
  t.after(() => fs.rmSync(origin, { recursive: true, force: true }));
  execFileSync("git", ["init", "--bare"], { cwd: origin, stdio: ["ignore", "pipe", "pipe"] });
  git(root, "remote", "add", "origin", origin);
  git(root, "push", "origin", "HEAD:main");

  const env = {
    GITHUB_ACTIONS: "true",
    GITHUB_REF_TYPE: "tag",
    GITHUB_REF: `refs/tags/${TAG}`,
    GITHUB_SHA: commit,
    GITHUB_TOKEN: "fixture-token",
    GITHUB_REPOSITORY: "NashAgents/nash-agents",
    GITHUB_API_URL: "https://api.github.com",
  };
  const run = (id: number, event: string, conclusion = "success", branch = "main") => ({
    id,
    event,
    head_sha: commit,
    status: "completed",
    conclusion,
    head_branch: branch,
    html_url: `https://github.com/NashAgents/nash-agents/actions/runs/${id}`,
    run_attempt: 1,
    created_at: "2026-01-01T00:00:00Z",
  });
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({
      total_count: 2,
      workflow_runs: [run(10, "push"), run(11, "workflow_dispatch")],
    }),
  });

  const result = await verifyReleaseSource({
    root,
    expectedVersion: VERSION,
    expectedTag: TAG,
    requireCi: true,
    env,
    fetchImpl,
  });
  assert.equal(result.status, "PASSED");
  assert.equal((result.ci as { push: { id: number } }).push.id, 10);
  assert.equal((result.ci as { workflow_dispatch: { id: number } }).workflow_dispatch.id, 11);

  const missingDispatch = async () => ({
    ok: true,
    json: async () => ({ total_count: 1, workflow_runs: [run(10, "push")] }),
  });
  await assert.rejects(
    () => verifyReleaseSource({ root, expectedVersion: VERSION, expectedTag: TAG, requireCi: true, env, fetchImpl: missingDispatch }),
    /workflow_dispatch/,
  );

  const failedDispatch = async () => ({
    ok: true,
    json: async () => ({
      total_count: 2,
      workflow_runs: [run(10, "push"), run(11, "workflow_dispatch", "failure")],
    }),
  });
  await assert.rejects(
    () => verifyReleaseSource({ root, expectedVersion: VERSION, expectedTag: TAG, requireCi: true, env, fetchImpl: failedDispatch }),
    /concluded failure/,
  );

  const wrongBranch = async () => ({
    ok: true,
    json: async () => ({
      total_count: 2,
      workflow_runs: [run(10, "push"), run(11, "workflow_dispatch", "success", "release-candidate")],
    }),
  });
  await assert.rejects(
    () => verifyReleaseSource({ root, expectedVersion: VERSION, expectedTag: TAG, requireCi: true, env, fetchImpl: wrongBranch }),
    /not main/,
  );
});

test("workspace and helper guards bind runtime, web and native bytes to the release commit", t => {
  const { root, commit, linuxBinary } = makeFixture(t);
  const workspace = verifyWorkspace({ root, commit, version: VERSION, requireReleaseHelpers: true });
  assert.equal(workspace.status, "PASSED");
  assert.equal((workspace.nativeHelpers as unknown[]).length, 2);

  const helper = verifyHelper({ root, manifest: `${linuxBinary}.manifest.json`, commit });
  assert.equal(helper.status, "PASSED");

  fs.writeFileSync(linuxBinary, "replaced-binary\n");
  assert.throws(() => verifyHelper({ root, manifest: `${linuxBinary}.manifest.json`, commit }), /binarySha256/);
  fs.writeFileSync(linuxBinary, "linux-binary\n");

  write(root, "dist/index.js", "export const runtime = 666;\n");
  assert.throws(
    () => verifyWorkspace({ root, commit, version: VERSION }),
    /runtime artifact bytes .* do not match/,
  );
  write(root, "dist/index.js", "export const runtime = 1;\n");
  assert.equal(verifyWorkspace({ root, commit, version: VERSION }).status, "PASSED");
});

function packFixture(t: { after: (fn: () => void) => void }, root: string, name = "nash-agents-0.1.0.tgz") {
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "nash-npm-release-pack-"));
  t.after(() => fs.rmSync(staging, { recursive: true, force: true }));
  const packageDir = path.join(staging, "package");
  fs.cpSync(root, packageDir, {
    recursive: true,
    filter: source => !source.split(path.sep).includes(".git"),
  });
  const tarball = path.join(staging, name);
  execFileSync("tar", ["-czf", tarball, "-C", staging, "package"], { stdio: ["ignore", "pipe", "pipe"] });
  return { tarball, staging };
}

test("tarball guard verifies the exact tarball, checksum, commit and native bytes", { skip: TAR_SKIP }, t => {
  const { root, commit } = makeFixture(t);
  const { tarball } = packFixture(t, root);
  const digest = crypto.createHash("sha256").update(fs.readFileSync(tarball)).digest("hex");
  const checksums = path.join(path.dirname(tarball), "SHA256SUMS");
  fs.writeFileSync(checksums, `${digest}  nash-agents-0.1.0.tgz\n`);
  const manifestOut = path.join(path.dirname(tarball), "release-manifest.json");

  const result = verifyTarball({
    tarball,
    checksums,
    commit,
    version: VERSION,
    tag: TAG,
    manifestOut,
  });
  assert.equal(result.status, "PASSED");
  assert.equal(result.tarballSha256, digest);
  const manifest = JSON.parse(fs.readFileSync(manifestOut, "utf8"));
  assert.equal(manifest.commit, commit);
  assert.equal(manifest.tarballSha256, digest);
  assert.equal(manifest.nativeHelpers.length, 2);

  const renamed = path.join(path.dirname(tarball), "nash-agents-0.1.0-stage.tgz");
  fs.copyFileSync(tarball, renamed);
  assert.throws(
    () => verifyTarball({ tarball: renamed, commit, version: VERSION, tag: TAG }),
    /tarball name must be/,
  );
  assert.equal(
    verifyTarball({ tarball: renamed, commit, version: VERSION, tag: TAG, allowRenamed: true }).status,
    "PASSED",
  );
});

test("tarball guard rejects a tampered artifact even when the filename and checksum are correct", { skip: TAR_SKIP }, t => {
  const { root, commit } = makeFixture(t);
  const tamperedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nash-npm-release-tamper-"));
  t.after(() => fs.rmSync(tamperedRoot, { recursive: true, force: true }));
  fs.cpSync(root, tamperedRoot, {
    recursive: true,
    filter: source => !source.split(path.sep).includes(".git"),
  });
  write(tamperedRoot, "dist/index.js", "export const runtime = 666;\n");
  const { tarball } = packFixture(t, tamperedRoot);
  const digest = crypto.createHash("sha256").update(fs.readFileSync(tarball)).digest("hex");
  const checksums = path.join(path.dirname(tarball), "SHA256SUMS");
  fs.writeFileSync(checksums, `${digest}  nash-agents-0.1.0.tgz\n`);
  assert.throws(
    () => verifyTarball({ tarball, checksums, commit, version: VERSION, tag: TAG }),
    /runtime artifact bytes .* do not match/,
  );
});
