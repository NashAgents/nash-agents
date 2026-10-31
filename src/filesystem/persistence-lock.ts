import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export class PersistenceLockError extends Error {
  constructor(message: string) { super(message); this.name = "PersistenceLockError"; }
}

function tryAcquire(directory: string): (() => void) | undefined {
  const lock = path.join(directory, ".nash-write.lock");
  try { fs.mkdirSync(lock, { mode: 0o700 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    // A dead owner is reclaimable; an unidentifiable owner remains fail-closed.
    try {
      const ownerText = fs.readFileSync(path.join(lock, "owner.json"), "utf8");
      const owner = JSON.parse(ownerText);
      if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) return;
      try { process.kill(owner.pid, 0); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") {
          const guard = path.join(lock, "reclaim");
          const fd = fs.openSync(guard, "wx", 0o600);
          let moved = false;
          try {
            if (fs.readFileSync(path.join(lock, "owner.json"), "utf8") !== ownerText) return;
            const tombstone = `${lock}.orphan-${randomUUID()}`;
            fs.renameSync(lock, tombstone);
            moved = true;
            fs.rmSync(tombstone, { recursive: true, force: true });
          } finally { fs.closeSync(fd); if (!moved) fs.rmSync(guard, { force: true }); }
        }
      }
    } catch { /* A live owner may be publishing its identity. */ }
    return;
  }
  const ownerFile = path.join(lock, "owner.json");
  const identity = JSON.stringify({ pid: process.pid, token: randomUUID() });
  try { fs.writeFileSync(ownerFile, identity, { mode: 0o600, flag: "wx" }); }
  catch (error) { fs.rmSync(lock, { recursive: true, force: true }); throw error; }
  return () => {
    if (fs.readFileSync(ownerFile, "utf8") !== identity) throw new PersistenceLockError("Persistence lock ownership changed");
    fs.rmSync(lock, { recursive: true });
  };
}

export async function withPersistenceLock<T>(directory: string, action: () => Promise<T>): Promise<T> {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const deadline = performance.now() + 10000;
  let release: (() => void) | undefined;
  while (!(release = tryAcquire(directory))) {
    if (performance.now() >= deadline) throw new PersistenceLockError("Persistence lock acquisition timed out");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  try { return await action(); } finally { release(); }
}

export function withPersistenceLockSync<T>(directory: string, action: () => T): T {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const deadline = performance.now() + 10000;
  let release: (() => void) | undefined;
  while (!(release = tryAcquire(directory))) {
    if (performance.now() >= deadline) throw new PersistenceLockError("Persistence lock acquisition timed out");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  try { return action(); } finally { release(); }
}

export function atomicWriteFileSync(file: string, content: string): void {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, content, { mode: 0o600, flag: "wx", flush: true });
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
}
