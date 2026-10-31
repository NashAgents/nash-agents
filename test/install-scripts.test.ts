import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const readScript = (name: string): string =>
  fs.readFileSync(new URL(`../scripts/${name}`, import.meta.url), "utf8");
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const powershell51 = path.join(
  process.env.SystemRoot ?? "C:\\Windows",
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
);

describe("Cross-platform installer checks", () => {
  it("Windows installer checks Node without node -e quoting on PowerShell 5.1", () => {
    const script = readScript("install.ps1");
    assert.doesNotMatch(script, /& node -e '/);
    assert.match(script, /& node --version/);
  });
});

describe(
  "Windows PowerShell 5.1 real installer execution",
  { skip: process.platform !== "win32" ? "Requires Windows PowerShell 5.1" : false },
  () => {
    const runVersionCheck = (env: NodeJS.ProcessEnv = process.env) =>
      execFileSync(
        powershell51,
        [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          "scripts/install.ps1",
          "-TestNodeVersionOnly",
        ],
        { cwd: repoRoot, env, encoding: "utf8" },
      );

    it("actually runs under PowerShell 5.1, not PowerShell 7", () => {
      const major = execFileSync(
        powershell51,
        ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.Major"],
        { encoding: "utf8" },
      ).trim();
      assert.equal(major, "5");
    });

    it("accepts the current Node 24 runtime without node -e", () => {
      const output = runVersionCheck();
      assert.match(output, /NODE_VERSION_OK/);
      assert.match(output, /NODE_VERSION_OK\r?\n$/);
    });

    it("rejects an older Node runtime with the same real PowerShell 5.1 path", () => {
      const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), "nash-ps51-node-"));
      try {
        fs.writeFileSync(
          path.join(fakeBin, "node.cmd"),
          "@echo off\r\necho v22.14.0\r\nexit /b 0\r\n",
        );
        const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "Path";
        const env = { ...process.env, [pathKey]: `${fakeBin};${process.env[pathKey] ?? ""}` };
        const result = spawnSync(
          powershell51,
          [
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            "scripts/install.ps1",
            "-TestNodeVersionOnly",
          ],
          { cwd: repoRoot, env, encoding: "utf8" },
        );
        assert.equal(result.status, 1, result.stderr || result.stdout);
        assert.match(result.stdout, /NODE_VERSION_UNSUPPORTED/);
      } finally {
        fs.rmSync(fakeBin, { recursive: true, force: true });
      }
    });
  },
);
