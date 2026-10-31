import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const entry = path.join(root, "dist", "index.js");
const [major, minor] = process.versions.node.split(".").map(Number);
if (major !== 24 || minor < 14) {
  console.error("Node.js >=24.14.0 <25 is required.");
  process.exit(1);
}
if (!existsSync(entry)) {
  console.error("Build this checkout first using scripts/install.sh or scripts/install.ps1.");
  process.exit(1);
}

// Lifecycle and port ownership belong to the product CLI; never kill a process by port.
const child = spawn(process.execPath, [entry, "start", ...process.argv.slice(2)], {
  cwd: root,
  stdio: "inherit",
  windowsHide: true,
  shell: false,
});
child.once("error", (error) => {
  console.error(`Unable to start Nash Agents: ${error.message}`);
  process.exitCode = 1;
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => { if (!child.killed) child.kill(signal); });
}
child.once("exit", (code, signal) => {
  process.exitCode = code ?? (signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1);
});
