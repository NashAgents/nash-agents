import type { ServerResponse } from "node:http";

/** Serial polling keeps a slow database from multiplying requests or leaking rejected promises. */
export function pollStream(response: ServerResponse, intervalMs: number, poll: () => Promise<void>): () => void {
  let closed = false;
  let timer: NodeJS.Timeout | undefined;
  const stop = () => { closed = true; if (timer) clearTimeout(timer); };
  response.once("close", stop);
  const tick = async () => {
    if (closed || response.destroyed || response.writableEnded) return;
    try {
      if (response.writableLength > 1024 * 1024) { stop(); response.destroy(); return; }
      await poll();
    } catch {
      stop();
      response.end();
      return;
    }
    if (!closed && !response.writableEnded && !response.destroyed) {
      timer = setTimeout(() => { void tick(); }, intervalMs);
      timer.unref();
    }
  };
  timer = setTimeout(() => { void tick(); }, intervalMs);
  timer.unref();
  return stop;
}
