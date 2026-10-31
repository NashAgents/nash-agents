import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import dns from "node:dns/promises";
import { spawnSync } from "node:child_process";
import { WindowsSandboxBackend } from "../src/sandbox/backends/windows-sandbox.js";
import { buildSandboxEnvironment } from "../src/sandbox/environment.js";

const tcp6 = "const s=require('net').connect({host:'2606:4700:4700::1111',port:53,family:6},()=>{console.log('NET_OK');s.destroy()});s.on('error',e=>{console.log('NET_ERROR:'+e.code);process.exit(['EPERM','EACCES'].includes(e.code)?91:93)});s.setTimeout(3000,()=>process.exit(94));";
const udp = "console.log('UDP_STARTED');const s=require('dgram').createSocket('udp4');const q=Buffer.from('123401000001000000000000076578616d706c6503636f6d0000010001','hex');s.on('message',(b,r)=>{if(r.address==='1.1.1.1'&&b.readUInt16BE(0)===0x1234&&(b[2]&128)){console.log('NET_OK');s.close()}});s.on('error',e=>{console.log('NET_ERROR:'+e.code);process.exit(['EPERM','EACCES'].includes(e.code)?91:93)});s.send(q,53,'1.1.1.1',e=>{if(e)s.emit('error',e);else console.log('UDP_SEND_QUEUED')});setTimeout(()=>{console.log('UDP_NO_REPLY');process.exit(94)},3000).unref();";
// TLS 用例只验证「允许模式下能完成真实 TLS 握手且证书校验通过」，不依赖某次 HTTP 响应耗时：
// 完整 https.get 到公网站点会受上游 403 与慢响应影响，曾把小超时误判成沙箱拒绝。
const https = "const tls=require('tls');const s=tls.connect({host:'www.microsoft.com',port:443,servername:'www.microsoft.com',family:4,autoSelectFamily:false,lookup:(_h,_o,cb)=>cb(null,__IP__,4)},()=>{console.log('NET_OK:'+s.getProtocol()+':authorized='+s.authorized);s.destroy();process.exit(0)});s.on('error',e=>{console.log('NET_ERROR:'+e.code);process.exit(['EPERM','EACCES'].includes(e.code)?91:93)});s.setTimeout(25000,()=>{console.log('NET_TIMEOUT');process.exit(94)});";

describe("Windows network protocol matrix with real host controls", { skip: process.platform !== "win32" }, () => {
  for (const [name, script] of [["IPv6 TCP", tcp6], ["UDP DNS wire query", udp], ["HTTPS TLS", https]]) {
    it(`${name}: same destination succeeds with allow and is denied by kernel policy`, async t => {
      let actualScript = script!;
      if (name === "HTTPS TLS") {
        const address = await dns.lookup("www.microsoft.com", { family: 4 });
        actualScript = actualScript.replace("__IP__", JSON.stringify(address.address));
      }
      const host = spawnSync(process.execPath, ["-e", actualScript], { encoding: "utf8", timeout: 15000, env: buildSandboxEnvironment() });
      if (host.status !== 0 || !host.stdout.includes("NET_OK")) { t.skip(`UNVERIFIED: host positive control unavailable (${host.stdout.trim() || host.status})`); return; }
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "nash-network-matrix-"));
      try {
        const backend = new WindowsSandboxBackend();
        // TLS 握手比裸 TCP 慢，且允许模式要验证真实证书链；给足预算，超时不能再冒充拒绝。
        const runTimeout = name === "HTTPS TLS" ? 40000 : 15000;
        const run = (mode: "allow" | "deny") => backend.run({ command: process.execPath, args: ["-e", actualScript], cwd, timeout: runTimeout,
          policy: { filesystem: { mode: "read-only" }, network: { mode }, approval: { mode: "never" } } });
        const allowed = await run("allow"); assert.equal(allowed.exitCode, 0, JSON.stringify(allowed));
        if (name === "HTTPS TLS") {
          // 证书校验必须仍然打开：只有 authorized=true 的 TLS1.2/1.3 握手才算网络放行成功。
          assert.match(allowed.stdout, /NET_OK:TLSv1\.[23]:authorized=true/);
        } else { assert.match(allowed.stdout, /NET_OK/); }
        const denied = await run("deny");
        if (name === "UDP DNS wire query" && denied.exitCode === 94) {
          assert.match(denied.stdout, /UDP_STARTED/); assert.match(denied.stdout, /UDP_SEND_QUEUED/); assert.match(denied.stdout, /UDP_NO_REPLY/);
          assert.ok(!denied.stdout.includes("NET_OK"));
          const after = await run("allow"); assert.equal(after.exitCode, 0, JSON.stringify(after)); assert.match(after.stdout, /NET_OK/);
        } else { assert.equal(denied.exitCode, 91, JSON.stringify(denied)); assert.match(denied.stdout, /NET_ERROR:(EPERM|EACCES)/); }
      } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
    });
  }
  it("loopback remains denied even with internet capabilities, against a live host listener", async () => {
    const server = net.createServer(socket => socket.end());
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as net.AddressInfo).port;
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "nash-loopback-matrix-"));
    try {
      await new Promise<void>((resolve, reject) => { const s = net.connect(port, "127.0.0.1", () => { s.destroy(); resolve(); }); s.once("error", reject); });
      for (const mode of ["allow", "deny"] as const) {
        const script = `const s=require('net').connect(${port},'127.0.0.1',()=>process.exit(99));s.on('error',e=>{console.log('LOOPBACK_ERROR:'+e.code);process.exit(['EPERM','EACCES','ETIMEDOUT'].includes(e.code)?91:93)});s.setTimeout(2000,()=>process.exit(94));`;
        const result = await new WindowsSandboxBackend().run({ command: process.execPath, args: ["-e", script], cwd, timeout: 5000,
          policy: { filesystem: { mode: "read-only" }, network: { mode }, approval: { mode: "never" } } });
        assert.equal(result.exitCode, 91, JSON.stringify(result)); assert.match(result.stdout, /LOOPBACK_ERROR:(EPERM|EACCES|ETIMEDOUT)/);
      }
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); fs.rmSync(cwd, { recursive: true, force: true }); }
  });
});
