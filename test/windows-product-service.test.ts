import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { parseWindowsProductServiceArgs } from "../src/cli/windows-product-service.js";
import { ProductStore } from "../src/product/index.js";
import { serviceRequest } from "../src/product-service.js";

test("Windows service launcher requires an absolute home and exact release identity", () => {
  const release = "a".repeat(40);
  assert.deepEqual(parseWindowsProductServiceArgs(["--home", "C:\\fixture\\nash", "--release", release]),
    { home: "C:\\fixture\\nash", release });
  assert.throws(() => parseWindowsProductServiceArgs(["--home", "relative", "--release", release]));
  assert.throws(() => parseWindowsProductServiceArgs(["--home", "C:\\fixture", "--release", "not-a-release"]));
  assert.throws(() => parseWindowsProductServiceArgs(["--home", "C:\\fixture\nother", "--release", release]));
  assert.throws(() => parseWindowsProductServiceArgs(["--home", "C:\\fixture", "--release", release, "extra"]));
});

const windowsEntry = path.resolve("dist/cli/windows-product-service-entry.js");
test("Windows launcher refuses a wrong release and runs an isolated product service", {
  timeout: 45000,
  skip: process.platform !== "win32" ? "Requires Windows" : !fs.existsSync(windowsEntry) ? "Requires a built release" : false,
}, async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nash-win-product-"));
  let child: ReturnType<typeof spawn> | undefined;
  let exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined;
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; }
    fs.rmSync(home, { recursive: true, force: true });
  });
  const server = net.createServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  const store = new ProductStore({ homeDir: home });
  try {
    store.initialize({ role: "coordinator", coordinator: { listenHost: "127.0.0.1", listenPort: port },
      models: { main: { baseUrl: "https://provider.invalid/v1", model: "fixture", apiKey: "fixture-only", format: "responses" } },
      security: { filesystem: "workspace-write", network: "deny", approval: "ask" },
      admin: { username: "fixtureadmin", password: "fixture-password-2026" } });
  } finally { store.close(); }
  const start = (release: string) => {
    child = spawn(process.execPath, [windowsEntry, "--home", home, "--release", release], { stdio: "ignore", windowsHide: true });
    exited = new Promise(resolve => child!.once("exit", (code, signal) => resolve({ code, signal })));
    return exited;
  };
  assert.equal((await start("0".repeat(40))).code, 78);
  assert.equal(fs.existsSync(path.join(home, "service.json")), false);
  const build = JSON.parse(fs.readFileSync(path.resolve("dist/build-info.json"), "utf8"));
  const running = start(build.commit);
  const deadline = Date.now() + 20000;
  let ready = false;
  while (Date.now() < deadline && child!.exitCode === null) {
    try { if ((await serviceRequest("status", home)).state === "running") { ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(ready, `Windows product service did not become ready; log=${fs.readFileSync(path.join(home, "service.log"), "utf8")}`);
  assert.equal((await serviceRequest("drain", home, { timeoutMs: "15000" })).snapshot.readyToStop, true);
  await serviceRequest("stop", home);
  assert.deepEqual(await running, { code: 0, signal: null });
  assert.match(fs.readFileSync(path.join(home, "service.log"), "utf8"), /Nash Agents/);
});
