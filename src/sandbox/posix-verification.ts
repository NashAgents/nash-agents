import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { MacOsSeatbeltBackend } from "./backends/macos-seatbelt.js";
import { LinuxBackendSelector } from "./linux/backend-selector.js";
import { buildSandboxEnvironment } from "./environment.js";
import type { SandboxCapabilityDetails } from "../cluster/protocol/types.js";
import type { SandboxPolicy } from "./types.js";

/** Probe the selected backend, using a live host listener as the network positive control. */
export function verifyPosixSandbox() {
  const now = Date.now();
  const policy: SandboxPolicy = { filesystem: { mode: "workspace-write" }, network: { mode: "deny" }, approval: { mode: "never" } };
  const backend = process.platform === "darwin" ? new MacOsSeatbeltBackend() : LinuxBackendSelector.select(policy);
  let filesystem = false, network = false, operational = false;
  const details: string[] = [];
  const root = fs.mkdtempSync(path.join(os.homedir(), ".nash-posix-verify-"));
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace);
  const outside = path.join(root, "outside.txt");
  fs.writeFileSync(outside, "UNCHANGED");
  let server: ReturnType<typeof spawn> | undefined;
  try {
    if (!backend.isAvailable() || !backend.buildExecutionSpec) throw new Error("Selected sandbox unavailable");
    const run = (script: string, filesystemMode: "read-only" | "workspace-write", networkMode: "allow" | "deny") => {
      const spec = backend.buildExecutionSpec!({ command: process.execPath, args: ["-e", script], cwd: workspace,
        policy: { ...policy, filesystem: { mode: filesystemMode }, network: { mode: networkMode } } });
      try { return spawnSync(spec.executable, spec.args, { cwd: spec.cwd, env: spec.env, encoding: "utf8", timeout: 5000 }); }
      finally { spec.cleanup?.(); }
    };
    const positive = run("require('fs').writeFileSync('inside.txt','OK');console.log(require('fs').readFileSync('inside.txt','utf8'))", "workspace-write", "deny");
    operational = positive.status === 0 && positive.stdout.trim() === "OK";
    const deniedScript = (target: string) => `try{require('fs').writeFileSync(${JSON.stringify(target)},'BROKEN');process.exit(90)}catch(e){if(!['EACCES','EPERM','EROFS','ENOENT'].includes(e.code))throw e;console.log('FS_DENIED');process.exit(91)}`;
    const outsideDenied = run(deniedScript(outside), "workspace-write", "deny");
    const readonlyDenied = run(deniedScript(path.join(workspace, "inside.txt")), "read-only", "deny");
    filesystem = operational && outsideDenied.status === 91 && outsideDenied.stdout.includes("FS_DENIED") &&
      readonlyDenied.status === 91 && readonlyDenied.stdout.includes("FS_DENIED") && fs.readFileSync(outside, "utf8") === "UNCHANGED" &&
      fs.readFileSync(path.join(workspace, "inside.txt"), "utf8") === "OK";
    const ready = path.join(root, "listener.json");
    server = spawn(process.execPath, ["-e", `const s=require('net').createServer(c=>c.end('CONTROL'));s.listen(0,'127.0.0.1',()=>require('fs').writeFileSync(${JSON.stringify(ready)},JSON.stringify(s.address())));setTimeout(()=>process.exit(),15000).unref()`], { stdio: "ignore", env: buildSandboxEnvironment() });
    const deadline = Date.now() + 3000;
    while (!fs.existsSync(ready) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    if (!fs.existsSync(ready)) throw new Error("Host listener did not become ready");
    const port = JSON.parse(fs.readFileSync(ready, "utf8")).port;
    const connect = `const s=require('net').connect(${port},'127.0.0.1');s.on('data',d=>{if(d.toString()==='CONTROL'){console.log('NETWORK_ALLOWED');s.destroy()}});s.on('error',e=>{if(!['EACCES','EPERM','ECONNREFUSED','ENETUNREACH'].includes(e.code))throw e;console.log('NETWORK_DENIED');process.exit(92)});s.setTimeout(2000,()=>process.exit(93));`;
    const allow = run(connect, "read-only", "allow");
    const deny = run(connect, "read-only", "deny");
    network = allow.status === 0 && allow.stdout.includes("NETWORK_ALLOWED") && deny.status === 92 && deny.stdout.includes("NETWORK_DENIED");
    details.push(`Workspace positive control=${operational}`, `Filesystem boundaries=${filesystem}`, `Network allow/deny same live listener=${network}`);
  } catch (error) { details.push(error instanceof Error ? error.message : String(error)); }
  finally {
    server?.kill("SIGKILL");
    fs.rmSync(root, { recursive: true, force: true });
  }
  const verified = operational && filesystem && network;
  const structuredDetails: SandboxCapabilityDetails = {
    backend: backend.name.includes("bubblewrap") ? "bubblewrap" : backend.name.includes("landlock") ? "landlock" : backend.name.includes("seatbelt") ? "seatbelt" : "none", installed: backend.isAvailable(), operational,
    filesystemIsolationVerified: filesystem, networkIsolationVerified: network,
    processIsolationVerified: verified && Boolean(backend.getCapabilities?.().processIsolation),
    supportedPolicies: filesystem ? ["read-only", "workspace-write", "danger-full-access"] : ["danger-full-access"],
    supportedNetworkModes: network ? ["deny", "allow"] : ["allow"],
    verifiedAt: verified ? now : undefined, verificationExpiresAt: verified ? now + 86400000 : undefined,
    failureReason: verified ? undefined : details.join("; "),
  };
  return { backend: backend.name, verified, details, structuredDetails };
}
