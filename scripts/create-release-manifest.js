import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export function createReleaseManifest(root, tag, verification = {}) {
  if (!/^v\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(tag)) throw new Error("Invalid release tag");
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const commit = git("rev-parse", "HEAD");
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  if (tag !== `v${pkg.version}`) throw new Error("Tag must match package version");
  const build = JSON.parse(fs.readFileSync(path.join(root, "dist/build-info.json"), "utf8"));
  if (build.commit !== commit || build.dirty !== false || git("status", "--porcelain", "--untracked-files=all")) throw new Error("Release requires a clean committed build at HEAD");
  const sha = file => crypto.createHash("sha256").update(fs.readFileSync(path.join(root, file))).digest("hex");
  const helperPath = "native/bin/win32-x64/nash-windows-sandbox-helper.exe";
  const helperManifest = JSON.parse(fs.readFileSync(path.join(root, `${helperPath}.manifest.json`), "utf8"));
  if (helperManifest.binarySha256 !== sha(helperPath) || helperManifest.sourceSha256 !== sha("native/windows-sandbox-helper/main.c")) throw new Error("Windows helper source/binary differs from its manifest");
  const artifacts = {};
  const digest = crypto.createHash("sha256");
  const walk = dir => {
    for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const file = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(file);
      else if (file !== "dist/release-manifest.json") {
        artifacts[file] = sha(file);
        if (file.startsWith("dist/") && file.endsWith(".js")) digest.update(file).update(fs.readFileSync(path.join(root, file)));
      }
    }
  };
  walk("dist"); walk("apps/web/dist");
  if (digest.digest("hex") !== build.artifactSha256) throw new Error("Runtime artifact bytes do not match build-info");
  const web = JSON.parse(fs.readFileSync(path.join(root, "apps/web/dist/build-info.json"), "utf8"));
  if (web.commit !== commit || web.dirty !== false) throw new Error("Web build must match the clean release commit");
  const webDigest = crypto.createHash("sha256");
  for (const file of Object.keys(artifacts).filter(file => file.startsWith("apps/web/dist/") && file !== "apps/web/dist/build-info.json")) webDigest.update(file).update(fs.readFileSync(path.join(root, file)));
  if (webDigest.digest("hex") !== web.artifactSha256) throw new Error("Web artifact bytes do not match build-info");
  artifacts[helperPath] = sha(helperPath);
  const protocol = fs.readFileSync(path.join(root, "src/cluster/protocol/types.ts"), "utf8").match(/CLUSTER_PROTOCOL_VERSION\s*=\s*"([^"]+)"/)[1];
  const migrations = [...fs.readFileSync(path.join(root, "src/cluster/storage/migrations.ts"), "utf8").matchAll(/version:\s*(\d+)/g)].map(match => Number(match[1]));
  return {
    schemaVersion: 1, releaseId: tag, gitCommit: commit, gitTag: tag, releasedAt: new Date().toISOString(), packageVersion: pkg.version,
    protocols: { runtime: protocol, coordinator: protocol, worker: protocol, windowsNativeHelper: helperManifest.protocolVersion },
    windowsHelper: { sha256: sha(helperPath), sourceSha256: helperManifest.sourceSha256, artifactOriginCommit: helperManifest.sourceCommit ?? null },
    supportedPlatforms: ["darwin-arm64", "linux-x64", "win32-x64"], requiredNodeVersion: pkg.engines.node,
    databaseSchemaVersion: Math.max(...migrations), sandboxCapabilityContractVersion: "unversioned-structured-details",
    build: { artifactSha256: build.artifactSha256, builtAt: build.builtAt, platform: process.platform, arch: process.arch },
    webBuild: web,
    buildArtifactChecksums: artifacts,
    verification: { source: "VERIFIED", build: "VERIFIED", runningServices: "UNVERIFIED", windowsIpv6: "UNVERIFIED", ...verification },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { parseArgs } = await import("node:util");
  const { values } = parseArgs({ options: { tag: { type: "string" }, output: { type: "string", default: "dist/release-manifest.json" } } });
  const manifest = createReleaseManifest(process.cwd(), values.tag);
  fs.writeFileSync(values.output, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`Release manifest: ${values.output} (${manifest.gitCommit})`);
}
