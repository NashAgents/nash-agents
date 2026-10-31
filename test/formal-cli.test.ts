import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ProductStore } from "../src/product/store.js";
import { assertUpgradeCheckout, readPrivateJson } from "../src/cli/product-cli.js";
import { readServiceRecord, serviceRequest } from "../src/product-service.js";
import { ArtifactService } from "../src/cluster/artifacts/artifact-service.js";
import { InMemoryClusterStore } from "../src/cluster/storage/cluster-store.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const entry = path.join(root, "src/index.ts");
const cli = (home: string, args: string[]) => spawnSync(process.execPath, ["--import", "tsx", entry, ...args], { cwd: root, env: { ...process.env, NASH_HOME: home }, encoding: "utf8", timeout: 15000 });
async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}
test("formal status does not create an uninitialized installation", t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "nash-cli-status-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const home = path.join(base, "uninitialized"), result = cli(home, ["status"]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { state: "stopped" });
  assert.equal(fs.existsSync(home), false);
});
test("private configuration rejects symlinks and permissive files", t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "nash-cli-input-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const config = path.join(base, "input.json");
  fs.writeFileSync(config, '{"role":"worker"}', { mode: 0o600 });
  assert.deepEqual(readPrivateJson(config), { role: "worker" });
  if (process.platform !== "win32") {
    fs.chmodSync(config, 0o644);
    assert.throws(() => readPrivateJson(config), /600/);
    fs.chmodSync(config, 0o600);
    const link = path.join(base, "link.json"); fs.symlinkSync(config, link);
    assert.throws(() => readPrivateJson(link), /普通文件/);
  }
});
test("source upgrade refuses an npm package and a nested unrelated checkout", t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "nash-upgrade-source-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  assert.throws(() => assertUpgradeCheckout(base), /自动升级只支持/);
  const initialized = spawnSync("git", ["init", "-q"], { cwd: base });
  assert.equal(initialized.status, 0);
  assert.doesNotThrow(() => assertUpgradeCheckout(base));
  const nested = path.join(base, "package"); fs.mkdirSync(nested);
  assert.throws(() => assertUpgradeCheckout(nested), /自动升级只支持/);
});
test("Windows short and long paths identify the same checkout and artifact directory", { skip: process.platform !== "win32" }, async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "nash-windows-physical-path-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const shortResult = spawnSync("cmd.exe", ["/d", "/c", `for %I in ("${base}") do @echo %~sI`], { encoding: "utf8", windowsVerbatimArguments: true });
  assert.equal(shortResult.status, 0, `Unable to obtain short path: ${shortResult.error ?? shortResult.stderr}`);
  const short = shortResult.stdout.trim();
  if (short.toLowerCase() === base.toLowerCase()) { t.skip("8.3 short path names are disabled on this volume"); return; }
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: base }).status, 0);
  const gitRoot = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: short, encoding: "utf8" });
  assert.equal(gitRoot.status, 0, `Git failed in short-path checkout: ${gitRoot.stderr}`);
  assert.equal(path.relative(fs.realpathSync.native(gitRoot.stdout.trim()), fs.realpathSync.native(short)), "", "Git root must resolve to the same physical directory");
  assert.doesNotThrow(() => assertUpgradeCheckout(short));
  const artifacts = new ArtifactService(new InMemoryClusterStore(), short);
  const artifact = await artifacts.publishArtifact({ graphId: "test", producerTaskId: "task", producerNodeId: "node", name: "proof.txt", content: "valid" });
  assert.equal((await artifacts.readArtifactContent(artifact.artifactId, "node")).data.toString(), "valid");
});
test("formal Coordinator lifecycle authenticates control, preserves data, and stops cleanly", { timeout: 45000 }, async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nash-cli-service-"));
  let child: ChildProcess | undefined;
  t.after(async () => {
    if (child && child.exitCode === null) { child.kill("SIGTERM"); await new Promise<void>(resolve => { child!.once("exit", () => resolve()); setTimeout(resolve, 5000).unref(); }); }
    fs.rmSync(home, { recursive: true, force: true });
  });
  const port = await freePort(), password = "test-only-password-strong", key = "sk-test-formal-cli-nonproduction";
  const store = new ProductStore({ homeDir: home });
  store.initialize({ role: "coordinator", coordinator: { listenHost: "127.0.0.1", listenPort: port }, models: { main: { baseUrl: "https://api.example.com/v1", model: "example-model", apiKey: key, format: "completions" } }, security: { filesystem: "workspace-write", network: "deny", approval: "ask" }, admin: { username: "test-admin", password } });
  store.close();
  let output = "";
  child = spawn(process.execPath, ["--import", "tsx", entry, "start"], { cwd: root, env: { ...process.env, NASH_HOME: home }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout!.on("data", data => { output += data; }); child.stderr!.on("data", data => { output += data; });
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await serviceRequest("status", home)).state === "running") { ready = true; break; } } catch {}
    if (child.exitCode !== null) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(ready, true, output);
  const record = readServiceRecord(home)!;
  const unauthorized = await fetch(`http://127.0.0.1:${record.port}/stop`, { method: "POST" });
  assert.equal(unauthorized.status, 401);
  const status = await serviceRequest("status", home);
  assert.equal(status.pid, child.pid); assert.equal(status.role, "coordinator"); assert.equal(status.configurationVersion, 1);
  const duplicate = cli(home, ["start"]); assert.notEqual(duplicate.status, 0);
  assert.equal((await serviceRequest("status", home)).pid, child.pid);
  const invite = await serviceRequest("invite", home); assert.match(String(invite.inviteCode), /^nash-inv-/);
  assert.deepEqual((await serviceRequest("nodes", home)).nodes, []);
  const exited = new Promise<number | null>(resolve => child!.once("exit", resolve));
  const drained = await serviceRequest("drain", home, { timeoutMs: "15000" });
  assert.equal(drained.snapshot.readyToStop, true);
  await serviceRequest("stop", home); assert.equal(await exited, 0, output);
  assert.equal(readServiceRecord(home), undefined); assert.equal(fs.existsSync(path.join(home, "service.lock")), false);
  const reopened = new ProductStore({ homeDir: home });
  assert.equal(reopened.authenticate("test-admin", password)?.role, "admin"); assert.equal(reopened.getPublicConfig().version, 1);
  reopened.close();
  assert.equal(output.includes(password), false); assert.equal(output.includes(key), false);
});

test("local Worker joins its Coordinator when listening on a specific LAN address", { timeout: 45000 }, async t => {
  const address = Object.values(os.networkInterfaces()).flat().find(item => item && item.family === "IPv4" && !item.internal)?.address;
  if (!address) { t.skip("No non-loopback IPv4 interface is available"); return; }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nash-cli-lan-"));
  let child: ChildProcess | undefined;
  t.after(async () => {
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise<void>(resolve => { child!.once("exit", () => resolve()); setTimeout(resolve, 5000).unref(); });
      if (child.exitCode === null) child.kill("SIGKILL");
    }
    fs.rmSync(home, { recursive: true, force: true });
  });
  const port = await freePort();
  const store = new ProductStore({ homeDir: home });
  store.initialize({ role: "coordinator-worker", coordinator: { listenHost: address, listenPort: port }, worker: { coordinatorUrl: `http://${address}:${port}`, name: "Local test worker", workspace: path.join(home, "workspace"), inheritModels: true }, models: { main: { baseUrl: "https://api.example.com/v1", model: "example-model", apiKey: "sk-test-local-worker", format: "completions" } }, security: { filesystem: "workspace-write", network: "deny", approval: "ask" }, admin: { username: "test-admin", password: "test-only-password-strong" } });
  store.close();
  let output = "";
  child = spawn(process.execPath, ["--import", "tsx", entry, "start"], { cwd: root, env: { ...process.env, NASH_HOME: home }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout!.on("data", data => { output += data; }); child.stderr!.on("data", data => { output += data; });
  let status: Record<string, any> | undefined;
  for (let attempt = 0; attempt < 200; attempt++) {
    try { const result = await serviceRequest("status", home); if (result.state === "running") { status = result; break; } } catch {}
    if (child.exitCode !== null) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(status?.role, "coordinator-worker", output);
  assert.ok(status?.workerId, output);
  const exited = new Promise<number | null>(resolve => child!.once("exit", resolve));
  assert.equal((await serviceRequest("drain", home, { timeoutMs: "15000" })).snapshot.readyToStop, true);
  await serviceRequest("stop", home);
  assert.equal(await exited, 0, output);
});

test("Coordinator starts with TLS and HTTPS URL when TLS certificates are configured", { timeout: 45000 }, async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nash-cli-tls-"));
  let child: ChildProcess | undefined;
  t.after(async () => {
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise<void>(resolve => { child!.once("exit", () => resolve()); setTimeout(resolve, 5000).unref(); });
      if (child.exitCode === null) child.kill("SIGKILL");
    }
    fs.rmSync(home, { recursive: true, force: true });
  });
  const port = await freePort();
  const certPath = path.join(home, "server.crt");
  const keyPath = path.join(home, "server.key");
  try {
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-keyout", keyPath, "-out", certPath, "-days", "1", "-nodes", "-subj", "/CN=127.0.0.1"], { stdio: "ignore" });
  } catch {
    t.skip("openssl is not available for TLS test");
    return;
  }
  const store = new ProductStore({ homeDir: home });
  store.initialize({ role: "coordinator", coordinator: { listenHost: "127.0.0.1", listenPort: port, tls: { certPath, keyPath } }, models: { main: { baseUrl: "https://api.example.com/v1", model: "example-model", apiKey: "sk-test-local-worker", format: "completions" } }, security: { filesystem: "workspace-write", network: "deny", approval: "ask" }, admin: { username: "test-admin", password: "test-only-password-strong" } });
  store.close();
  let output = "";
  child = spawn(process.execPath, ["--import", "tsx", entry, "start"], { cwd: root, env: { ...process.env, NASH_HOME: home, NASH_TLS_CERT: certPath, NASH_TLS_KEY: keyPath }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout!.on("data", data => { output += data; }); child.stderr!.on("data", data => { output += data; });
  let status: Record<string, any> | undefined;
  for (let attempt = 0; attempt < 200; attempt++) {
    try { const result = await serviceRequest("status", home); if (result.state === "running") { status = result; break; } } catch {}
    if (child.exitCode !== null) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(status?.role, "coordinator", output);
  assert.ok(output.includes(`Web: https://127.0.0.1:${port}`), output);
  const exited = new Promise<number | null>(resolve => child!.once("exit", resolve));
  assert.equal((await serviceRequest("drain", home, { timeoutMs: "15000" })).snapshot.readyToStop, true);
  await serviceRequest("stop", home);
  assert.equal(await exited, 0, output);
});

test("Coordinator fails closed without downgrading to HTTP when TLS configuration is invalid or missing", { timeout: 45000 }, async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nash-cli-tls-fail-"));
  let child: ChildProcess | undefined;
  t.after(async () => {
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise<void>(resolve => { child!.once("exit", () => resolve()); setTimeout(resolve, 5000).unref(); });
      if (child.exitCode === null) child.kill("SIGKILL");
    }
    fs.rmSync(home, { recursive: true, force: true });
  });

  const port = await freePort();
  const certPath = path.join(home, "server.crt");
  const keyPath = path.join(home, "server.key");

  // 1. 缺少私钥路径配置时拒绝启动
  const store = new ProductStore({ homeDir: home });
  store.initialize({
    role: "coordinator",
    coordinator: { listenHost: "127.0.0.1", listenPort: port, tls: { certPath, keyPath: "placeholder-key" } },
    models: { main: { baseUrl: "https://api.example.com/v1", model: "example-model", apiKey: "sk-test-local-worker", format: "completions" } },
    security: { filesystem: "workspace-write", network: "deny", approval: "ask" },
    admin: { username: "test-admin", password: "test-only-password-strong" }
  });
  store.close();

  let output = "";
  child = spawn(process.execPath, ["--import", "tsx", entry, "start"], { cwd: root, env: { ...process.env, NASH_HOME: home, NASH_TLS_CERT: certPath, NASH_TLS_KEY: "" }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout!.on("data", data => { output += data; });
  child.stderr!.on("data", data => { output += data; });
  const exitedIncomplete = await new Promise<number | null>(resolve => child!.once("exit", resolve));
  assert.notEqual(exitedIncomplete, 0, output);
  assert.ok(output.includes("TLS 配置不完整") || output.includes("TLS_CONFIG_INCOMPLETE"), output);

  // 2. 证书文件不存在时拒绝启动
  output = "";
  child = spawn(process.execPath, ["--import", "tsx", entry, "start"], { cwd: root, env: { ...process.env, NASH_HOME: home, NASH_TLS_CERT: path.join(home, "missing.crt"), NASH_TLS_KEY: path.join(home, "missing.key") }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout!.on("data", data => { output += data; });
  child.stderr!.on("data", data => { output += data; });
  const exitedMissing = await new Promise<number | null>(resolve => child!.once("exit", resolve));
  assert.notEqual(exitedMissing, 0, output);
  assert.ok(output.includes("TLS 证书文件不存在") || output.includes("TLS_CERT_NOT_FOUND"), output);

  // 3. 证书文件存在但损坏时拒绝启动，绝不退回 HTTP
  fs.writeFileSync(certPath, "INVALID-CERTIFICATE-DATA");
  fs.writeFileSync(keyPath, "INVALID-KEY-DATA");
  output = "";
  child = spawn(process.execPath, ["--import", "tsx", entry, "start"], { cwd: root, env: { ...process.env, NASH_HOME: home, NASH_TLS_CERT: certPath, NASH_TLS_KEY: keyPath }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout!.on("data", data => { output += data; });
  child.stderr!.on("data", data => { output += data; });
  const exitedInvalid = await new Promise<number | null>(resolve => child!.once("exit", resolve));
  assert.notEqual(exitedInvalid, 0, output);
  assert.ok(output.includes("TLS 证书或私钥无效") || output.includes("TLS_INVALID"), output);
});
