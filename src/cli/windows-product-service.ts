import fs from "node:fs";
import path from "node:path";
import tls from "node:tls";
import { fileURLToPath } from "node:url";

export function parseWindowsProductServiceArgs(args: string[]): { home: string; release: string } {
  if (args.length !== 4 || args[0] !== "--home" || args[2] !== "--release" ||
      !path.win32.isAbsolute(args[1]!) || !/^[a-f0-9]{40}$/.test(args[3]!)) {
    throw new Error("Expected --home <absolute Windows path> --release <full commit ID>");
  }
  if (/[\u0000-\u001f\u007f"]/.test(args[1]!)) throw new Error("Invalid product home path");
  return { home: args[1]!, release: args[3]! };
}

/** Runs the product in the scheduled task's own process, not a detached child. */
export async function runWindowsProductService(args: string[]): Promise<void> {
  if (process.platform !== "win32") throw new Error("Windows product service requires Windows");
  const { home, release } = parseWindowsProductServiceArgs(args);
  if (!fs.statSync(home).isDirectory() || !fs.statSync(path.join(home, "product.db")).isFile()) {
    throw new Error("The existing product home is not initialized");
  }
  const root = fileURLToPath(new URL("../..", import.meta.url));
  const entry = path.join(root, "dist", "index.js");
  process.chdir(root);
  process.env.NASH_HOME = home;
  process.argv = [process.execPath, entry, "start", "--service"];

  const logPath = path.join(home, "service.log");
  if (fs.existsSync(logPath) && fs.lstatSync(logPath).isSymbolicLink()) throw new Error("Service log must not be a symbolic link");
  const fd = fs.openSync(logPath, "a", 0o600);
  const write = (chunk: string | Uint8Array, encoding?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void): boolean => {
    const data = typeof chunk === "string" ? Buffer.from(chunk, typeof encoding === "string" ? encoding : "utf8") : chunk;
    fs.writeSync(fd, data);
    const done = typeof encoding === "function" ? encoding : callback;
    if (done) process.nextTick(done);
    return true;
  };
  process.stdout.write = write as typeof process.stdout.write;
  process.stderr.write = write as typeof process.stderr.write;
  process.once("exit", () => { try { fs.closeSync(fd); } catch {} });

  // Node reads NODE_EXTRA_CA_CERTS only during process initialization. The
  // scheduled task starts without the interactive session's environment, so
  // apply the product CA to the default trust store before loading the app.
  const caPath = path.join(home, "nash-ca.crt");
  if (fs.existsSync(caPath)) {
    const certs = fs.readFileSync(caPath, "utf8").match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
    if (!certs?.length) throw new Error("Product CA file contains no certificates");
    tls.setDefaultCACertificates([...tls.getCACertificates("default"), ...certs]);
  }

  const { captureRuntimeRelease } = await import("../runtime/release-info.js");
  const info = captureRuntimeRelease(path.join(root, "dist"));
  if (!info.artifactVerified || info.dirty || info.commit !== release) {
    throw new Error("Product release verification failed");
  }

  await import("../index.js");
}
