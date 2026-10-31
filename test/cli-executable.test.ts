import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { resolveNashHome } from "../src/config/data-home.js";
import { generateProjectDirectoryName } from "../src/project/project-id.js";

describe("Nash CLI Executable & Global Command Subsystem", () => {
  const projectRoot = process.cwd();
  const pkgJsonPath = path.join(projectRoot, "package.json");
  const distIndexPath = path.join(projectRoot, "dist", "index.js");

  it("1. package.json 应正确配置 bin.nash 字段指向 ./dist/index.js", () => {
    assert.ok(fs.existsSync(pkgJsonPath), "package.json 必须存在");
    const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8")) as {
      bin?: Record<string, string>;
    };

    assert.ok(pkg.bin, "package.json 中必须包含 bin 配置");
    assert.strictEqual(
      pkg.bin.nash,
      "./dist/index.js",
      "bin.nash 必须指向 ./dist/index.js"
    );
  });

  it("2. dist/index.js 编译产物存在且首行必须保留 #!/usr/bin/env node shebang", () => {
    assert.ok(
      fs.existsSync(distIndexPath),
      "dist/index.js 产物必须存在（请先执行 npm run build）"
    );
    const content = fs.readFileSync(distIndexPath, "utf-8");
    const firstLine = content.split("\n")[0].trim();
    assert.strictEqual(
      firstLine,
      "#!/usr/bin/env node",
      "dist/index.js 首行必须为 #!/usr/bin/env node"
    );
  });

  it("3. nash --version / -v 应输出版本号并正常退出 (exit 0)", () => {
    const result = spawnSync("node", [distIndexPath, "--version"], {
      encoding: "utf-8",
      cwd: projectRoot,
    });

    assert.strictEqual(result.status, 0, "--version 必须正常退出 (code 0)");
    assert.match(
      result.stdout,
      /Nash Agents v\d+\.\d+\.\d+/,
      "输出必须包含版本号"
    );

    const shortResult = spawnSync("node", [distIndexPath, "-v"], {
      encoding: "utf-8",
      cwd: projectRoot,
    });
    assert.strictEqual(shortResult.status, 0, "-v 必须正常退出 (code 0)");
    assert.match(
      shortResult.stdout,
      /Nash Agents v\d+\.\d+\.\d+/,
      "输出必须包含版本号"
    );
  });

  it("4. nash --help / -h 应输出帮助文档并正常退出 (exit 0)", () => {
    const result = spawnSync("node", [distIndexPath, "--help"], {
      encoding: "utf-8",
      cwd: projectRoot,
    });

    assert.strictEqual(result.status, 0, "--help 必须正常退出 (code 0)");
    assert.ok(
      result.stdout.includes("Nash Agents CLI"),
      "帮助信息应包含 CLI 名称"
    );
    assert.ok(result.stdout.includes("Usage:"), "帮助信息应包含 Usage 说明");
    assert.ok(
      result.stdout.includes("/resume"),
      "帮助信息应包含 REPL 命令说明"
    );
  });

  it("5. 从非源码目录运行 nash 时，process.cwd() 必须被正确识别为用户调用目录", () => {
    const tempTestDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "nash-cli-exec-test-")
    );
    const canonicalTempDir = fs.realpathSync(tempTestDir);
    const projectNamespace = path.join(resolveNashHome(), "projects", generateProjectDirectoryName(canonicalTempDir));

    try {
      const result = spawnSync("node", [distIndexPath], {
        input: "/status\nexit\n",
        encoding: "utf-8",
        cwd: canonicalTempDir,
      });

      assert.strictEqual(result.status, 0, "CLI 应正常执行 exit 退出");
      const cleanStdout = result.stdout.replace(/\x1b\[[0-9;]*m/g, "");
      assert.ok(
        cleanStdout.includes(canonicalTempDir),
        `Project Namespace Root 必须包含调用目录 '${canonicalTempDir}'，实际输出: ${cleanStdout}`
      );
      assert.ok(
        cleanStdout.includes("Nash Status"),
        "必须支持 /status 展示完整配置与状态"
      );
      assert.ok(
        cleanStdout.includes("Nash ·"),
        "首屏必须展示极简 Header"
      );
    } finally {
      fs.rmSync(projectNamespace, { recursive: true, force: true });
      fs.rmSync(tempTestDir, { recursive: true, force: true });
    }
  });

  it("6. npm link 在隔离前缀注册的 nash 命令可直接调用并运行", () => {
    const tempTestDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "nash-global-link-test-")
    );
    const canonicalTempDir = fs.realpathSync(tempTestDir);
    const prefix = path.join(canonicalTempDir, "prefix");

    try {
      const linked = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["link", "--ignore-scripts", "--no-audit", "--no-fund"], {
        encoding: "utf8", cwd: projectRoot, env: { ...process.env, npm_config_prefix: prefix }, shell: process.platform === "win32", timeout: 30000,
      });
      assert.equal(linked.status, 0, linked.stderr);
      const executable = process.platform === "win32" ? path.join(prefix, "nash.cmd") : path.join(prefix, "bin", "nash");
      const result = spawnSync(executable, ["--version"], {
        encoding: "utf-8",
        cwd: canonicalTempDir,
        shell: process.platform === "win32",
      });
      assert.equal(result.status, 0, result.stderr);
        assert.match(
          result.stdout,
          /Nash Agents v\d+\.\d+\.\d+/,
          "全局 nash 命令输出应包含版本号"
        );
    } finally {
      fs.rmSync(tempTestDir, { recursive: true, force: true });
    }
  });
});
