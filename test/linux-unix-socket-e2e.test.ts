import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import net from "node:net";
import fs from "node:fs";
import { LinuxBubblewrapBackend } from "../src/sandbox/backends/linux-bubblewrap.js";

describe("Linux Host Unix Domain Socket / IPC Isolation E2E Tests (宿主特权 IPC隔离验证)", { skip: process.platform !== "linux" ? "Requires Linux platform" : false }, () => {
  const hostSocketPath = "/run/nash-sandbox-test.sock";
  let server: net.Server | undefined;
  let serverListening = false;

  before(async () => {
    try {
      if (fs.existsSync(hostSocketPath)) {
        fs.unlinkSync(hostSocketPath);
      }
    } catch {}

    await new Promise<void>((resolve) => {
      server = net.createServer((socket) => {
        socket.write("privileged-host-socket\n");
        socket.end();
      });

      server.on("error", () => {
        // 若在只读环境或非特权环境无法写入 /run，则标记未监听
        serverListening = false;
        resolve();
      });

      server.listen(hostSocketPath, () => {
        serverListening = true;
        resolve();
      });
    });
  });

  after(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
    try {
      if (fs.existsSync(hostSocketPath)) {
        fs.unlinkSync(hostSocketPath);
      }
    } catch {}
  });

  it("1. 宿主 /run 下的 Unix Domain Socket 在 Bubblewrap 沙箱中彻底不可见且无法连接", async () => {
    if (!serverListening) {
      // 容错环境
      return;
    }

    const backend = new LinuxBubblewrapBackend();
    // 沙箱内运行 Node.js 试图连接宿主 socket
    const testScript = `
const net = require("net");
const client = net.createConnection("${hostSocketPath}", () => {
  console.log("CONNECTED_LEAK");
  process.exit(0);
});
client.on("error", (err) => {
  console.log("BLOCKED_OK:" + err.code);
  process.exit(1);
});
`;

    const res = await backend.run({
      command: "node",
      args: ["-e", testScript],
      cwd: process.cwd(),
      policy: {
        filesystem: { mode: "workspace-write" },
        network: { mode: "allow" },
        approval: { mode: "never" },
      },
    });

    assert.notStrictEqual(res.exitCode, 0, "连接宿主特权 Socket 必须被阻断退出非零");
    assert.doesNotMatch(res.stdout, /CONNECTED_LEAK/);
    assert.match(res.stdout + res.stderr, /BLOCKED_OK:ENOENT/);
  });
});
