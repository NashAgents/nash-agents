import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

export interface RuntimeReleaseInfo {
  commit: string | null;
  packageVersion?: string;
  dirty: boolean;
  builtAt?: string;
  artifactSha256?: string;
  artifactVerified?: boolean;
  /**
   * 哈希覆盖范围的自述（当前为 dist 目录下全部 js 文件）。它不是整个发布包的完整性证明：
   * 发布包级清单见 dist/release-manifest.json 的 buildArtifactChecksums。
   */
  artifactScope?: string;
  /** 参与哈希的文件数。缺失说明构建信息不是本机制产生的。 */
  artifactFileCount?: number;
  startedAt: string;
  pid: number;
  entrypoint: string;
}

// Read once at module initialization. Replacing dist or moving Git HEAD cannot relabel a live process.
export function captureRuntimeRelease(directory = fileURLToPath(new URL("..", import.meta.url))): Readonly<RuntimeReleaseInfo> {
  let build: Partial<RuntimeReleaseInfo> = {};
  let artifactVerified = false;
  try {
    build = JSON.parse(fs.readFileSync(path.join(directory, "build-info.json"), "utf8"));
    const digest = crypto.createHash("sha256");
    const walk = (folder: string) => {
      for (const entry of fs.readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
        const file = path.join(folder, entry.name);
        if (entry.isDirectory()) walk(file);
        else if (entry.name.endsWith(".js")) digest.update(path.relative(path.dirname(directory), file).split(path.sep).join("/")).update(fs.readFileSync(file));
      }
    };
    walk(directory);
    artifactVerified = digest.digest("hex") === build.artifactSha256;
  } catch { /* Unstamped development runtimes remain explicitly unverified. */ }
  return Object.freeze({
    commit: typeof build.commit === "string" && /^[a-f0-9]{40}$/.test(build.commit) ? build.commit : null,
    packageVersion: typeof build.packageVersion === "string" && /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(build.packageVersion) ? build.packageVersion : undefined,
    dirty: build.dirty !== false || !artifactVerified, artifactVerified, builtAt: build.builtAt, artifactSha256: build.artifactSha256,
    artifactScope: typeof build.artifactScope === "string" ? build.artifactScope : undefined,
    artifactFileCount: typeof build.artifactFileCount === "number" ? build.artifactFileCount : undefined,
    startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
    pid: process.pid, entrypoint: process.argv[1] ?? fileURLToPath(import.meta.url),
  });
}
export const runtimeRelease = captureRuntimeRelease();
