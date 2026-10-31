import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

if (process.platform !== "linux") throw new Error("Linux helper must be built on Linux");
const source = path.resolve("native/linux-sandbox-helper/main.c");
const output = path.resolve(`native/bin/linux-${process.arch}/nash-linux-sandbox-helper`);
fs.mkdirSync(path.dirname(output), { recursive: true });
const compiler = process.env.CC ?? "cc";
execFileSync(compiler, ["-O2", "-Wall", "-Wextra", source, "-o", output], { stdio: "inherit" });
fs.chmodSync(output, 0o755);
const version = JSON.parse(execFileSync(output, ["--version-json"], { encoding: "utf8" }));
const sha = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
let sourceCommit = "0.1.0";
try {
  sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
} catch {
  try {
    const buildInfo = JSON.parse(fs.readFileSync(path.resolve("dist/build-info.json"), "utf8"));
    sourceCommit = buildInfo.commit ?? "0.1.0";
  } catch {}
}
const manifest = { sourceCommit,
  sourceSha256: crypto.createHash("sha256").update(fs.readFileSync(source)).update(fs.readFileSync(path.join(path.dirname(source), "json-config.h"))).digest("hex"), binarySha256: sha(output), platform: process.platform, arch: process.arch,
  compiler: execFileSync(compiler, ["--version"], { encoding: "utf8" }).split("\n")[0],
  builtAt: new Date().toISOString(), protocolVersion: version.protocolVersion };
fs.writeFileSync(`${output}.manifest.json`, JSON.stringify(manifest, null, 2)+"\n");
console.log(JSON.stringify({ ...version, binarySha256: manifest.binarySha256 }));
