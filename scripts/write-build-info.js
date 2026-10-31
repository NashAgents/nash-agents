import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
const root = process.cwd();
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
let commit;
try { commit = git("rev-parse", "--verify", "HEAD"); } catch { /* Unborn checkouts have no release provenance yet. */ }
const hash = crypto.createHash("sha256");
// 校验范围必须显式声明：用户不能把「只覆盖 dist 下 .js」的哈希当成整个发布包的完整性证明。
const artifactScope = "dist/**/*.js";
let artifactFileCount = 0;
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(file);
    else if (entry.name.endsWith(".js")) { hash.update(path.relative(root, file).split(path.sep).join("/")).update(fs.readFileSync(file)); artifactFileCount += 1; }
  }
}
walk(path.join(root, "dist"));
const info = { packageVersion: JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version, commit: commit ?? null, dirty: !commit || Boolean(git("status", "--porcelain", "--untracked-files=all", "--", "src", "scripts", "package.json", "package-lock.json", "tsconfig.json", "tsconfig.build.json", "apps/web/src", "native/linux-sandbox-helper", "native/windows-sandbox-helper")),
  builtAt: new Date().toISOString(), artifactSha256: hash.digest("hex"), artifactScope, artifactFileCount };
fs.writeFileSync(path.join(root, "dist/build-info.json"), JSON.stringify(info, null, 2)+"\n");
