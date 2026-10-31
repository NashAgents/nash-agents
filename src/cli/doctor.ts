import { runtimeRelease } from "../runtime/release-info.js";
import fs from "node:fs";
import path from "node:path";
import { execSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { LinuxSandboxProbe } from "../sandbox/linux/capability-probe.js";
import { LinuxBackendSelector } from "../sandbox/linux/backend-selector.js";
import { WindowsSandboxProbe } from "../sandbox/windows/capability-probe.js";
import { WindowsBackendSelector } from "../sandbox/windows/backend-selector.js";
import { createDefaultSandboxPolicy } from "../sandbox/policy.js";
import { runDeploymentDiagnostics, formatDeploymentReport } from "../cluster/preflight/deployment-doctor.js";

function getNashVersion(): string {
  try {
    const currentDir = path.dirname(fileURLToPath(import.meta.url));
    const pkgPath = path.resolve(currentDir, "../../package.json");
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as {
        version?: string;
      };
      if (pkg.version) return pkg.version;
    }
  } catch {}
  return runtimeRelease.packageVersion ?? "1.0.0";
}

function checkRipgrep(): { installed: boolean; path?: string } {
  try {
    const cmd = process.platform === "win32" ? "where rg" : "which rg 2>/dev/null";
    const p = execSync(cmd, { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (p) return { installed: true, path: p.split("\r\n")[0] };
  } catch {}
  return { installed: false };
}

/**
 * 运行系统诊断并格式化输出人类可读报告
 */
export async function runNashDoctor(args: string[] = []): Promise<number> {
  const nodeVersion = process.versions.node;
  const platform = process.platform;
  const arch = process.arch;
  const nashVersion = getNashVersion();
  const showDeployment = args.includes("--release") || args.includes("--deployment") || args.includes("--cluster");

  console.log(`\x1b[1m\x1b[36mNash Doctor\x1b[0m (v${nashVersion})\n`);

  console.log(`\x1b[1mRuntime\x1b[0m`);
  const nodeValid = (() => {
    const [major, minor] = nodeVersion.split(".").map(Number);
    return major === 24 && minor >= 14;
  })();

  console.log(
    `  Node.js          ${nodeValid ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${nodeVersion}${
      nodeValid ? "" : " (Required: >=24.14.0 <25)"
    }`
  );
  console.log(`  Release          ${runtimeRelease.commit ?? "UNVERIFIED"}${runtimeRelease.dirty ? " (dirty/unstamped)" : ""}`);
  console.log(`  Platform         \x1b[32m✓\x1b[0m ${platform} ${arch}`);

  const rg = checkRipgrep();
  console.log(
    `  ripgrep (rg)     ${rg.installed ? "\x1b[32m✓\x1b[0m" : "\x1b[33m-\x1b[0m"} ${
      rg.installed ? rg.path : "not installed (optional, file search falls back to native JS)"
    }`
  );

  let allOperational = true;
  let selectedBackendName = "unavailable";

  if (platform === "linux") {
    console.log(`\n\x1b[1mSandbox & Kernel Isolation\x1b[0m`);
    const probe = LinuxSandboxProbe.probe(true);

    // Bubblewrap
    if (probe.bubblewrapUsable) {
      console.log(`  Bubblewrap       \x1b[32m✓\x1b[0m ${probe.bwrapVersion ?? "installed"} (${probe.executablePath})`);
    } else if (probe.bubblewrapInstalled) {
      console.log(`  Bubblewrap       \x1b[33m!\x1b[0m installed but container setup failed`);
      console.log(`                   \x1b[2mReason: ${probe.reason}\x1b[0m`);
    } else {
      console.log(`  Bubblewrap       \x1b[33m-\x1b[0m not installed (optional if Landlock available)`);
    }

    // Namespaces
    console.log(
      `  User namespace   ${probe.userNamespaceUsable ? "\x1b[32m✓\x1b[0m" : "\x1b[33m-\x1b[0m"}`
    );
    console.log(
      `  Network ns       ${probe.networkNamespaceUsable ? "\x1b[32m✓\x1b[0m" : "\x1b[33m-\x1b[0m"}`
    );
    console.log(
      `  PID namespace    ${probe.pidNamespaceUsable ? "\x1b[32m✓\x1b[0m" : "\x1b[33m-\x1b[0m"}`
    );

    // Seccomp & Helper & no_new_privs
    console.log(
      `  Seccomp          ${
        probe.seccompSupported ? "\x1b[32m✓\x1b[0m targeted deny active" : "\x1b[31m✗\x1b[0m unavailable"
      }`
    );
    console.log(
      `  no_new_privs     ${probe.noNewPrivsSupported ? "\x1b[32m✓\x1b[0m active" : "\x1b[31m✗\x1b[0m"}`
    );
    console.log(
      `  Native Helper    ${
        probe.helperAvailable
          ? `\x1b[32m✓\x1b[0m protocol v${probe.helperVersion?.protocolVersion ?? 1}`
          : "\x1b[31m✗\x1b[0m missing or incompatible"
      }`
    );

    // Landlock
    console.log(
      `  Landlock LSM     ${
        probe.landlockAvailable
          ? `\x1b[32m✓\x1b[0m ABI ${probe.landlockAbi}`
          : "\x1b[33m-\x1b[0m kernel support not enabled"
      }`
    );

    // cgroup v2
    console.log(
      `  cgroup v2        ${
        probe.cgroupV2Available ? "\x1b[32m✓\x1b[0m available" : "\x1b[33m-\x1b[0m not mounted"
      }`
    );
    if (probe.cgroupV2Available) {
      console.log(
        `  cpu controller   ${probe.cgroupControllers.cpu ? "\x1b[32m✓\x1b[0m" : "\x1b[33m-\x1b[0m"}`
      );
      console.log(
        `  memory           ${probe.cgroupControllers.memory ? "\x1b[32m✓\x1b[0m" : "\x1b[33m-\x1b[0m"}`
      );
      console.log(
        `  pids             ${probe.cgroupControllers.pids ? "\x1b[32m✓\x1b[0m" : "\x1b[33m-\x1b[0m"}`
      );
      console.log(
        `  delegated        ${
          probe.cgroupDelegated
            ? "\x1b[32m✓\x1b[0m"
            : "\x1b[31m✗\x1b[0m current user cannot create child cgroup"
        }`
      );
    }

    const defaultPolicy = createDefaultSandboxPolicy();
    const backend = LinuxBackendSelector.select(defaultPolicy);
    selectedBackendName = backend.name;
    allOperational = backend.isAvailable();
  } else if (platform === "darwin") {
    console.log(`\n\x1b[1mSandbox Isolation\x1b[0m`);
    selectedBackendName = "macos-seatbelt";
    try {
      execFileSync("/usr/bin/sandbox-exec", ["-p", "(version 1)(allow default)", "/usr/bin/true"], { timeout: 5000, stdio: "ignore" });
      console.log(`  macOS Seatbelt   \x1b[32m✓\x1b[0m native process probe passed`);
      allOperational = true;
    } catch { console.log(`  macOS Seatbelt   \x1b[31m✗\x1b[0m native process probe failed`); allOperational = false; }
  } else if (platform === "win32") {
    console.log(`\n\x1b[1mSandbox & Windows Kernel Isolation\x1b[0m`);
    const probe = WindowsSandboxProbe.probe(true);

    console.log(
      `  Job Objects      ${probe.jobObjectsAvailable ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} process tree & resource limits active`
    );
    console.log(
      `  Restricted Token ${probe.restrictedTokenAvailable ? "\x1b[32m✓\x1b[0m" : "\x1b[33m-\x1b[0m"} privilege dropping active`
    );
    console.log(
      `  AppContainer     ${probe.appContainerAvailable ? "\x1b[32m✓\x1b[0m API available" : "\x1b[33m-\x1b[0m not available"}`
    );
    console.log(
      `  Native Helper    ${
        probe.helperAvailable
          ? `\x1b[32m✓\x1b[0m protocol v2 (${probe.helperPath})`
          : "\x1b[31m✗\x1b[0m missing"
      }`
    );

    const shells: string[] = [];
    if (probe.availableShells.powershell) shells.push("PowerShell");
    if (probe.availableShells.pwsh) shells.push("PowerShell 7 (pwsh)");
    if (probe.availableShells.cmd) shells.push("cmd.exe");
    if (probe.availableShells.bash) shells.push("Git Bash");

    console.log(
      `  Available Shells \x1b[32m✓\x1b[0m ${shells.join(", ")}`
    );

    const defaultPolicy = createDefaultSandboxPolicy();
    const backend = WindowsBackendSelector.select(defaultPolicy);
    selectedBackendName = backend.name;
    allOperational = backend.isAvailable();
  } else {
    console.log(`\n\x1b[1mSandbox Isolation\x1b[0m`);
    console.log(`  Unsupported OS   \x1b[31m✗\x1b[0m ${platform}`);
    allOperational = false;
  }

  console.log(`\n\x1b[1mSelected Backend\x1b[0m`);
  console.log(`  ${allOperational ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${selectedBackendName}`);

  let deploymentExitCode = 0;
  if (showDeployment) {
    try {
      const option = (name: string) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
      const deployReport = await runDeploymentDiagnostics({ deploymentDir: option("--deployment-dir"), serviceName: option("--service") });
      console.log(formatDeploymentReport(deployReport));
      if (deployReport.verdict !== "READY" || (args.includes("--release") && deployReport.releaseHealth !== "VERIFIED")) {
        deploymentExitCode = 1;
      }
    } catch (err) {
      deploymentExitCode = 1;
      console.error(`Failed to collect deployment diagnostics: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log("");
  if (nodeValid && allOperational && deploymentExitCode === 0) {
    console.log("\x1b[1m\x1b[32mEnvironment and native sandbox probes passed. Task execution still requires valid configuration and authorization.\x1b[0m\n");
    return 0;
  } else {
    if (!allOperational) {
      console.log(
        "\x1b[1m\x1b[31mNash sandbox is unavailable on this system.\x1b[0m\n" +
        "  Please install 'bubblewrap' (e.g. `sudo apt install bubblewrap`) or enable Landlock LSM.\n"
      );
    }
    return 1;
  }
}
