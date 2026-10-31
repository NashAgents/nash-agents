import fs from "node:fs";
import { PosixProcessTreeTerminator } from "../../jobs/process-tree-terminator.js";

interface PinnedProcess { pid: number; birth: string; executable?: string; children: number[] }

function inspect(pid: number): PinnedProcess | undefined {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
    return { pid, birth: fields[19]!, executable: fs.realpathSync(`/proc/${pid}/exe`), children: [] };
  } catch { return undefined; }
}

/** One instance per namespace launch; pinned birth times prevent signaling recycled PIDs. */
export function createNamespaceTerminator(executable: string): (pid: number, signal: NodeJS.Signals) => void {
  const known = new Map<number, PinnedProcess>();
  const fallback = new PosixProcessTreeTerminator();
  const pause = new Int32Array(new SharedArrayBuffer(4));
  const signalPinned = (processInfo: PinnedProcess, signal: NodeJS.Signals) => {
    if (inspect(processInfo.pid)?.birth !== processInfo.birth) return;
    try { process.kill(processInfo.pid, signal); } catch {}
  };
  return (rootPid, signal) => {
    if (process.platform !== "linux") { fallback.terminate(rootPid, signal); return; }
    const current: PinnedProcess[] = [];
    const freeze = (pid: number) => {
      if (current.some(p => p.pid === pid) || current.length >= 4096) return;
      const processInfo = inspect(pid);
      if (!processInfo) return;
      signalPinned(processInfo, "SIGSTOP");
      for (let attempt = 0; attempt < 50; attempt++) {
        try {
          if (/^State:\s+[TtDZ]/m.test(fs.readFileSync(`/proc/${pid}/status`, "utf8"))) break;
        } catch { break; }
        Atomics.wait(pause, 0, 0, 1);
      }
      current.push(processInfo);
      known.set(pid, processInfo);
      try {
        for (const tid of fs.readdirSync(`/proc/${pid}/task`)) {
          try {
            const children = fs.readFileSync(`/proc/${pid}/task/${tid}/children`, "utf8").trim();
            for (const value of children.split(/\s+/).filter(Boolean)) {
              const child = Number(value);
              processInfo.children.push(child);
              freeze(child);
            }
          } catch { /* A thread can exit while its process is being stopped. */ }
        }
      } catch { /* Process exited before the snapshot. */ }
    };
    freeze(rootPid);
    let wrapper: string;
    try { wrapper = fs.realpathSync(executable); } catch { wrapper = executable; }
    // If only wrapper processes exist, no tool code has started. Prevent a fork after cancellation.
    const beforeToolStart = current.length > 0 && current.every(p => p.pid === rootPid || p.executable === wrapper);
    const effective = beforeToolStart ? "SIGKILL" : signal;
    for (const processInfo of [...known.values()].reverse()) signalPinned(processInfo, effective);
    if (effective !== "SIGKILL") {
      for (const processInfo of current.reverse()) signalPinned(processInfo, "SIGCONT");
    } else known.clear();
  };
}
