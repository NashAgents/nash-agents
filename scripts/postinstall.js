#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const root = path.resolve(import.meta.dirname, "..");

export function bundledLinuxHelperStatus(directory, arch) {
  const binary = path.join(directory, `native/bin/linux-${arch}/nash-linux-sandbox-helper`);
  const manifestPath = `${binary}.manifest.json`;
  if (!fs.existsSync(binary) && !fs.existsSync(manifestPath)) return "missing";
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const build = JSON.parse(fs.readFileSync(path.join(directory, "dist/build-info.json"), "utf8"));
    const sourceHash = crypto.createHash("sha256").update(fs.readFileSync(path.join(directory, "native/linux-sandbox-helper/main.c"))).update(fs.readFileSync(path.join(directory, "native/linux-sandbox-helper/json-config.h"))).digest("hex");
    const binaryHash = crypto.createHash("sha256").update(fs.readFileSync(binary)).digest("hex");
    return manifest.platform === "linux" && manifest.arch === arch && manifest.protocolVersion === 1 && /^[a-f0-9]{40}$/.test(build.commit ?? "") && manifest.sourceCommit === build.commit && manifest.sourceSha256 === sourceHash && manifest.binarySha256 === binaryHash ? "verified" : "invalid";
  } catch { return "invalid"; }
}

function tryBuildLinuxHelper() {
  if (process.platform !== "linux") return;
  // A source checkout can contain artifacts from an earlier commit; rebuild them.
  const status = fs.existsSync(path.join(root, ".git")) ? "missing" : bundledLinuxHelperStatus(root, process.arch);
  if (status === "verified") return;
  if (status === "invalid") {
    console.error("Nash: bundled Linux sandbox helper failed verification; installation cannot continue safely.");
    process.exitCode = 1;
    return;
  }
  const source = path.join(root, "native/linux-sandbox-helper/main.c");
  if (!fs.existsSync(source)) return;
  try {
    execFileSync("node", [path.join(root, "scripts/build-linux-helper.js")], { cwd: root, stdio: "ignore" });
  } catch {
    console.warn("Nash: Linux sandbox helper could not be built; run nash doctor before use.");
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  tryBuildLinuxHelper();

if (process.env.npm_config_global === "true" || process.env.npm_lifecycle_event === "postinstall") {
  console.log("\n=======================================================");
  console.log("  Nash Agents successfully installed!");
  console.log("  Run 'nash init' to initialize your cluster node.");
  console.log("  Run 'nash doctor' to verify kernel sandbox status.");
  console.log("=======================================================\n");
}
}
