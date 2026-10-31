import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const browserLockPath = path.join(os.tmpdir(), "nash-headless-browser.lock");

export async function acquireBrowserLock(timeoutMs = 25000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try { await fs.mkdir(browserLockPath); return; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || Date.now() >= deadline) throw error;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
}
