import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const PACKAGE_NAME = "nash-agents";
const RELEASE_HELPERS = [
  "native/bin/linux-x64/nash-linux-sandbox-helper",
  "native/bin/win32-x64/nash-windows-sandbox-helper.exe",
];

export class ReleaseArtifactError extends Error {}

function fail(message) {
  throw new ReleaseArtifactError(message);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    fail(`cannot read ${file}: ${error.message}`);
  }
}

function sha256(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function sha256File(file) {
  return sha256(fs.readFileSync(file));
}

function relativePosix(root, file) {
  return path.relative(root, file).split(path.sep).join("/");
}

function assertCommit(commit) {
  if (!/^[a-f0-9]{40}$/.test(commit ?? "")) fail(`commit must be a full 40-character git SHA, got ${JSON.stringify(commit)}`);
}

function assertReleaseIdentity({ commit, version, tag }) {
  assertCommit(commit);
  if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) fail(`version must be a stable semver version, got ${JSON.stringify(version)}`);
  if (tag !== undefined && tag !== `v${version}`) fail(`tag must be v${version}, got ${JSON.stringify(tag)}`);
}

function assertPackage(pkg, version) {
  if (pkg.name !== PACKAGE_NAME) fail(`package name must be ${PACKAGE_NAME}, got ${JSON.stringify(pkg.name)}`);
  if (pkg.version !== version) fail(`package version must be ${version}, got ${JSON.stringify(pkg.version)}`);
  if (pkg.private === true) fail("release package must not be private");
}

function validateBuildInfo(info, { commit, version, kind }) {
  if (info.commit !== commit) fail(`${kind} build-info commit ${info.commit} does not match ${commit}`);
  if (info.dirty !== false) fail(`${kind} build-info reports a dirty build`);
  if (!/^[a-f0-9]{64}$/.test(info.artifactSha256 ?? "")) fail(`${kind} build-info has no valid artifactSha256`);
  if (kind === "runtime") {
    if (info.packageVersion !== version) fail(`runtime build-info packageVersion ${info.packageVersion} does not match ${version}`);
    if (info.artifactScope !== "dist/**/*.js") fail(`runtime build-info artifactScope must be dist/**/*.js, got ${info.artifactScope}`);
    if (!Number.isInteger(info.artifactFileCount) || info.artifactFileCount <= 0) fail("runtime build-info artifactFileCount must be positive");
  }
}

function hashTree(root, scope, include) {
  const hash = crypto.createHash("sha256");
  let count = 0;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else {
        const relative = relativePosix(root, absolute);
        if (!include(relative)) continue;
        hash.update(relative).update(fs.readFileSync(absolute));
        count += 1;
      }
    }
  };
  walk(path.join(root, scope));
  return { digest: hash.digest("hex"), count };
}

function helperSourceDigest(root, platform) {
  const sourceDir = platform === "win32" ? "native/windows-sandbox-helper" : "native/linux-sandbox-helper";
  const main = path.join(root, sourceDir, "main.c");
  if (!fs.existsSync(main)) return null;
  const hash = crypto.createHash("sha256").update(fs.readFileSync(main));
  if (platform === "linux") {
    const header = path.join(root, sourceDir, "json-config.h");
    if (!fs.existsSync(header)) return null;
    hash.update(fs.readFileSync(header));
  }
  return hash.digest("hex");
}

function validateHelper(root, manifestPath, commit) {
  const binaryPath = manifestPath.replace(/\.manifest\.json$/, "");
  if (!fs.existsSync(binaryPath)) fail(`helper binary is missing for ${manifestPath}`);
  const manifest = readJson(manifestPath);
  if (!/^[a-f0-9]{40}$/.test(manifest.sourceCommit ?? "")) fail(`${manifestPath} has no valid sourceCommit`);
  if (manifest.sourceCommit !== commit) fail(`${manifestPath} sourceCommit ${manifest.sourceCommit} does not match ${commit}`);
  const directory = path.basename(path.dirname(binaryPath));
  const match = /^(linux|win32)-(x64|arm64)$/.exec(directory);
  if (!match) fail(`unsupported helper platform directory ${directory}`);
  const [, platform, arch] = match;
  if (manifest.platform !== platform || manifest.arch !== arch) {
    fail(`${manifestPath} platform/arch ${manifest.platform}/${manifest.arch} does not match ${directory}`);
  }
  const expectedProtocol = platform === "win32" ? 2 : 1;
  if (manifest.protocolVersion !== expectedProtocol) {
    fail(`${manifestPath} protocolVersion ${manifest.protocolVersion} must be ${expectedProtocol}`);
  }
  const binaryDigest = sha256File(binaryPath);
  if (manifest.binarySha256 !== binaryDigest) fail(`${manifestPath} binarySha256 does not match ${binaryPath}`);
  const sourceDigest = helperSourceDigest(root, platform);
  if (!sourceDigest) fail(`helper source files are missing for ${platform} under ${root}`);
  if (manifest.sourceSha256 !== sourceDigest) fail(`${manifestPath} sourceSha256 does not match the helper source`);
  return {
    path: relativePosix(root, binaryPath),
    platform,
    arch,
    protocolVersion: manifest.protocolVersion,
    binarySha256: binaryDigest,
    sourceSha256: sourceDigest,
  };
}

function validateHelpers(root, commit, { requireRelease }) {
  const binDir = path.join(root, "native/bin");
  const manifests = [];
  if (fs.existsSync(binDir)) {
    const stack = [binDir];
    while (stack.length > 0) {
      const dir = stack.pop();
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const absolute = path.join(dir, entry.name);
        if (entry.isDirectory()) stack.push(absolute);
        else if (entry.name.endsWith(".manifest.json")) manifests.push(absolute);
      }
    }
  }
  manifests.sort();
  const helpers = manifests.map((manifest) => validateHelper(root, manifest, commit));
  if (requireRelease) {
    for (const required of RELEASE_HELPERS) {
      if (!helpers.some((helper) => helper.path === required)) fail(`release helper is missing: ${required}`);
    }
  }
  return helpers;
}

function verifyChecksums(checksumsPath, tarballPath, digest) {
  const lines = fs.readFileSync(checksumsPath, "utf8").split(/\r?\n/).filter((line) => line.trim() !== "");
  if (lines.length !== 1) fail(`SHA256SUMS must contain exactly one entry, found ${lines.length}`);
  const match = /^([a-f0-9]{64})\s+\*?(.+)$/.exec(lines[0].trim());
  if (!match) fail("SHA256SUMS is malformed");
  const [, expectedDigest, expectedName] = match;
  if (expectedName.trim() !== path.basename(tarballPath)) {
    fail(`SHA256SUMS names ${expectedName.trim()}, not ${path.basename(tarballPath)}`);
  }
  if (expectedDigest !== digest) fail(`tarball SHA-256 ${digest} does not match SHA256SUMS ${expectedDigest}`);
}

function extractTarball(tarball, destination) {
  try {
    execFileSync("tar", ["-xzf", tarball, "-C", destination], { stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    const detail = String(error.stderr ?? error.message ?? "").trim();
    fail(`cannot extract ${path.basename(tarball)}${detail ? `: ${detail}` : ""}`);
  }
}

function workflowMetadata() {
  const runId = process.env.GITHUB_RUN_ID ?? null;
  return {
    runId,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
    runUrl: runId ? `${process.env.GITHUB_SERVER_URL ?? "https://github.com"}/${process.env.GITHUB_REPOSITORY}/actions/runs/${runId}` : null,
    workflowRef: process.env.GITHUB_WORKFLOW_REF ?? null,
    ref: process.env.GITHUB_REF ?? null,
    sha: process.env.GITHUB_SHA ?? null,
    event: process.env.GITHUB_EVENT_NAME ?? null,
  };
}

export function verifyWorkspace({ root = process.cwd(), commit, version, requireReleaseHelpers = false }) {
  assertReleaseIdentity({ commit, version });
  const resolvedRoot = path.resolve(root);
  const pkg = readJson(path.join(resolvedRoot, "package.json"));
  assertPackage(pkg, version);

  const runtime = readJson(path.join(resolvedRoot, "dist/build-info.json"));
  validateBuildInfo(runtime, { commit, version, kind: "runtime" });
  const runtimeTree = hashTree(resolvedRoot, "dist", (file) => file.endsWith(".js"));
  if (runtimeTree.digest !== runtime.artifactSha256) {
    fail(`runtime artifact bytes ${runtimeTree.digest} do not match build-info ${runtime.artifactSha256}`);
  }
  if (runtimeTree.count !== runtime.artifactFileCount) {
    fail(`runtime artifact file count ${runtimeTree.count} does not match build-info ${runtime.artifactFileCount}`);
  }

  const web = readJson(path.join(resolvedRoot, "apps/web/dist/build-info.json"));
  validateBuildInfo(web, { commit, kind: "web" });
  const webTree = hashTree(resolvedRoot, "apps/web/dist", (file) => file !== "apps/web/dist/build-info.json");
  if (webTree.digest !== web.artifactSha256) {
    fail(`web artifact bytes ${webTree.digest} do not match build-info ${web.artifactSha256}`);
  }

  const helpers = validateHelpers(resolvedRoot, commit, { requireRelease: requireReleaseHelpers });
  return {
    status: "PASSED",
    mode: "workspace",
    package: pkg.name,
    version,
    commit,
    runtime: { artifactSha256: runtime.artifactSha256, artifactFileCount: runtime.artifactFileCount, builtAt: runtime.builtAt },
    web: { artifactSha256: web.artifactSha256, builtAt: web.builtAt },
    nativeHelpers: helpers,
  };
}

export function verifyHelper({ root = process.cwd(), manifest, commit }) {
  assertCommit(commit);
  const resolvedRoot = path.resolve(root);
  const resolvedManifest = path.resolve(manifest);
  return {
    status: "PASSED",
    mode: "helper",
    commit,
    helper: validateHelper(resolvedRoot, resolvedManifest, commit),
  };
}

export function verifyTarball({ tarball, checksums, commit, version, tag, allowRenamed = false, manifestOut }) {
  assertReleaseIdentity({ commit, version, tag });
  const tarballPath = path.resolve(tarball);
  if (!fs.existsSync(tarballPath)) fail(`tarball not found: ${tarballPath}`);
  const expectedName = `${PACKAGE_NAME}-${version}.tgz`;
  if (!allowRenamed && path.basename(tarballPath) !== expectedName) {
    fail(`tarball name must be ${expectedName}, got ${path.basename(tarballPath)}`);
  }
  const digest = sha256File(tarballPath);
  if (checksums) verifyChecksums(path.resolve(checksums), tarballPath, digest);

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nash-release-artifact-"));
  try {
    extractTarball(tarballPath, tempRoot);
    const root = path.join(tempRoot, "package");
    if (!fs.existsSync(path.join(root, "package.json"))) fail("tarball does not contain package/package.json");
    const pkg = readJson(path.join(root, "package.json"));
    assertPackage(pkg, version);

    const runtime = readJson(path.join(root, "dist/build-info.json"));
    validateBuildInfo(runtime, { commit, version, kind: "runtime" });
    const runtimeTree = hashTree(root, "dist", (file) => file.endsWith(".js"));
    if (runtimeTree.digest !== runtime.artifactSha256) {
      fail(`tarball runtime artifact bytes ${runtimeTree.digest} do not match build-info ${runtime.artifactSha256}`);
    }
    if (runtimeTree.count !== runtime.artifactFileCount) {
      fail(`tarball runtime artifact file count ${runtimeTree.count} does not match build-info ${runtime.artifactFileCount}`);
    }

    const web = readJson(path.join(root, "apps/web/dist/build-info.json"));
    validateBuildInfo(web, { commit, kind: "web" });
    const webTree = hashTree(root, "apps/web/dist", (file) => file !== "apps/web/dist/build-info.json");
    if (webTree.digest !== web.artifactSha256) {
      fail(`tarball web artifact bytes ${webTree.digest} do not match build-info ${web.artifactSha256}`);
    }

    const helpers = validateHelpers(root, commit, { requireRelease: true });
    const manifest = {
      schemaVersion: 1,
      package: pkg.name,
      version,
      tag,
      commit,
      tarball: path.basename(tarballPath),
      tarballSha256: digest,
      tarballSize: fs.statSync(tarballPath).size,
      runtimeArtifact: {
        sha256: runtime.artifactSha256,
        scope: runtime.artifactScope,
        fileCount: runtime.artifactFileCount,
        builtAt: runtime.builtAt,
      },
      webArtifact: { sha256: web.artifactSha256, builtAt: web.builtAt },
      nativeHelpers: helpers,
      workflow: workflowMetadata(),
      verifiedAt: new Date().toISOString(),
    };
    if (manifestOut) {
      const output = path.resolve(manifestOut);
      fs.mkdirSync(path.dirname(output), { recursive: true });
      fs.writeFileSync(output, JSON.stringify(manifest, null, 2) + "\n");
    }
    return {
      status: "PASSED",
      mode: "tarball",
      package: manifest.package,
      version,
      tag,
      commit,
      tarball: manifest.tarball,
      tarballSha256: manifest.tarballSha256,
      tarballSize: manifest.tarballSize,
      runtimeArtifact: manifest.runtimeArtifact,
      webArtifact: manifest.webArtifact,
      nativeHelpers: manifest.nativeHelpers,
    };
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function parseCli(argv) {
  const values = {};
  const flags = new Set();
  const booleanFlags = new Set(["allow-renamed", "require-release-helpers", "help"]);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) fail(`unexpected argument: ${token}`);
    const key = token.slice(2);
    if (booleanFlags.has(key)) {
      flags.add(key);
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) fail(`missing value for --${key}`);
    values[key] = value;
    index += 1;
  }
  return { values, flags };
}

const USAGE = [
  "Usage:",
  "  node scripts/verify-release-artifact.js tarball --tarball <path> --commit <sha> --version <version> --tag <tag> [--checksums <file>] [--manifest-out <file>] [--allow-renamed]",
  "  node scripts/verify-release-artifact.js workspace --root <dir> --commit <sha> --version <version> [--require-release-helpers]",
  "  node scripts/verify-release-artifact.js helper --root <dir> --manifest <path> --commit <sha>",
].join("\n");

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const command = process.argv[2];
  try {
    const { values, flags } = parseCli(process.argv.slice(3));
    if (flags.has("help") || command === undefined || command === "--help") {
      console.log(USAGE);
    } else if (command === "tarball") {
      console.log(JSON.stringify(verifyTarball({
        tarball: values.tarball,
        checksums: values.checksums,
        commit: values.commit,
        version: values.version,
        tag: values.tag,
        allowRenamed: flags.has("allow-renamed"),
        manifestOut: values["manifest-out"],
      }), null, 2));
    } else if (command === "workspace") {
      console.log(JSON.stringify(verifyWorkspace({
        root: values.root ?? process.cwd(),
        commit: values.commit,
        version: values.version,
        requireReleaseHelpers: flags.has("require-release-helpers"),
      }), null, 2));
    } else if (command === "helper") {
      console.log(JSON.stringify(verifyHelper({
        root: values.root ?? process.cwd(),
        manifest: values.manifest,
        commit: values.commit,
      }), null, 2));
    } else {
      fail(`unknown command: ${command}`);
    }
  } catch (error) {
    console.error(`RELEASE-ARTIFACT FAILED: ${error.message}`);
    process.exitCode = 1;
  }
}
