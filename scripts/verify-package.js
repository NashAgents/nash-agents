import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { auditText } from "./product-audit.js";

export function verifyPackageFiles(files, root = process.cwd(), { release = false } = {}) {
  const paths = new Set(files.map(file => file.path));
  const findings = [];
  for (const required of ["package.json", "LICENSE", "README.md", "THIRD_PARTY_NOTICES.md", "dist/index.js", "dist/build-info.json", "apps/web/dist/index.html", "apps/web/dist/build-info.json"]) if (!paths.has(required)) findings.push({ path: required, line: 1, category: "required-package-file-missing" });
  if (release) {
    for (const required of ["native/bin/win32-x64/nash-windows-sandbox-helper.exe", "native/bin/win32-x64/nash-windows-sandbox-helper.exe.manifest.json", "native/bin/linux-x64/nash-linux-sandbox-helper", "native/bin/linux-x64/nash-linux-sandbox-helper.manifest.json"]) {
      if (!paths.has(required)) findings.push({ path: required, line: 1, category: "release-native-helper-missing" });
    }
  }
  for (const file of paths) {
    if (/(?:^|\/)(?:AGENTS\.md|CLAUDE\.md|CODEX\.md|\.env|settings\.json|credentials\.json|\.claude|\.codex|\.codegraph|\.git|node_modules)(?:\/|$)|^docs\/reports\/|^scripts\/runtime-truth\/|\.log$/.test(file)) findings.push({ path: file, line: 1, category: "private-file-in-package" });
    if (/^native\/bin\//.test(file)) {
      if (file.endsWith(".manifest.json")) continue;
      const manifestPath = `${file}.manifest.json`;
      if (!paths.has(manifestPath)) {
        findings.push({ path: file, line: 1, category: "unverified-native-binary-in-package" });
        continue;
      }
      try {
        const manifest = JSON.parse(fs.readFileSync(path.resolve(root, manifestPath), "utf8"));
        const actualSha = crypto.createHash("sha256").update(fs.readFileSync(path.resolve(root, file))).digest("hex");
        if (manifest.binarySha256 !== actualSha) {
          findings.push({ path: file, line: 1, category: "native-binary-checksum-mismatch" });
        }
        const build = JSON.parse(fs.readFileSync(path.resolve(root, "dist/build-info.json"), "utf8"));
        if (!/^[a-f0-9]{40}$/.test(build.commit ?? "") || (release && manifest.sourceCommit !== build.commit)) {
          findings.push({ path: file, line: 1, category: "native-binary-source-commit-mismatch" });
        }
        if (file === "native/bin/win32-x64/nash-windows-sandbox-helper.exe") {
          const source = fs.readFileSync(path.resolve(root, "native/windows-sandbox-helper/main.c"));
          if (manifest.platform !== "win32" || manifest.arch !== "x64" || manifest.protocolVersion !== 2 ||
              manifest.sourceSha256 !== crypto.createHash("sha256").update(source).digest("hex")) {
            findings.push({ path: file, line: 1, category: "native-binary-source-or-platform-mismatch" });
          }
        } else if (file.startsWith("native/bin/linux-")) {
          const source = fs.readFileSync(path.resolve(root, "native/linux-sandbox-helper/main.c"));
          const header = fs.readFileSync(path.resolve(root, "native/linux-sandbox-helper/json-config.h"));
          if (manifest.platform !== "linux" || manifest.arch !== file.split("/")[2].slice("linux-".length) || manifest.protocolVersion !== 1 ||
              manifest.sourceSha256 !== crypto.createHash("sha256").update(source).update(header).digest("hex")) {
            findings.push({ path: file, line: 1, category: "native-binary-source-or-platform-mismatch" });
          }
        }
      } catch {
        findings.push({ path: file, line: 1, category: "native-binary-manifest-invalid" });
      }
    }
  }
  return findings;
}

export function verifyBuildIdentity(root, files) {
  const findings = [];
  const fail = (file, category) => findings.push({ path: file, line: 1, category });
  try {
    const runtime = JSON.parse(fs.readFileSync(path.join(root, "dist/build-info.json"), "utf8"));
    const web = JSON.parse(fs.readFileSync(path.join(root, "apps/web/dist/build-info.json"), "utf8"));
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    if (!/^[a-f0-9]{40}$/.test(runtime.commit ?? "") || runtime.commit !== web.commit || runtime.packageVersion !== pkg.version || runtime.dirty !== false || web.dirty !== false) fail("dist/build-info.json", "uncommitted-or-mismatched-build");
    const hashTree = (directory, include, normalize) => {
      const hash = crypto.createHash("sha256");
      const walk = dir => {
        for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
          const file = `${dir}/${entry.name}`;
          if (entry.isDirectory()) walk(file);
          else if (include(file)) {
            if (!files.some(item => item.path === file)) fail(file, "built-file-missing-from-package");
            hash.update(normalize(file)).update(fs.readFileSync(path.join(root, file)));
          }
        }
      };
      walk(directory); return hash.digest("hex");
    };
    if (hashTree("dist", file => file.endsWith(".js"), file => file) !== runtime.artifactSha256) fail("dist/build-info.json", "runtime-artifact-digest-mismatch");
    if (hashTree("apps/web/dist", file => file !== "apps/web/dist/build-info.json", file => file) !== web.artifactSha256) fail("apps/web/dist/build-info.json", "web-artifact-digest-mismatch");
  } catch { fail("dist/build-info.json", "build-identity-missing-or-invalid"); }
  return findings;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const output = execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { encoding: "utf8", shell: process.platform === "win32", maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
    const [manifest] = JSON.parse(output);
    const findings = [...verifyPackageFiles(manifest.files, process.cwd(), { release: process.argv.includes("--release") }), ...verifyBuildIdentity(process.cwd(), manifest.files)];
    for (const file of manifest.files) {
      if (!/\.(?:js|json|md|txt|html|css|map|ts|c|h)$/.test(file.path)) continue;
      const bytes = fs.readFileSync(path.resolve(file.path));
      if (!bytes.includes(0)) findings.push(...auditText(file.path, bytes.toString("utf8"), { scanEndpoints: false }));
    }
    for (const finding of findings) console.log(JSON.stringify(finding));
    console.log(JSON.stringify({ audit: "package", status: findings.length ? "FAILED" : "PASSED", files: manifest.files.length, findings: findings.length }));
    process.exitCode = findings.length ? 1 : 0;
  } catch { console.error(JSON.stringify({ path: "package.json", line: 1, category: "package-verification-failed" })); process.exitCode = 1; }
}
