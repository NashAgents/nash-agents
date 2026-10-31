import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
const git = (...args) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
let commit;
try { commit = git("rev-parse", "--verify", "HEAD"); } catch { /* Initial imports are not verified releases. */ }
const hash = crypto.createHash("sha256");
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    const file = `${dir}/${entry.name}`;
    if (entry.isDirectory()) walk(file);
    else if (file !== "apps/web/dist/build-info.json") hash.update(file).update(fs.readFileSync(file));
  }
}
walk("apps/web/dist");
const build = { commit: commit ?? null, dirty: !commit || Boolean(git("status", "--porcelain", "--untracked-files=all", "--", "apps/web/src", "apps/web/package.json", "apps/web/package-lock.json", "scripts/write-web-build-info.js", "package.json")), builtAt: new Date().toISOString(), artifactSha256: hash.digest("hex") };
fs.writeFileSync(path.join("apps/web/dist/build-info.json"), JSON.stringify(build, null, 2) + "\n");
