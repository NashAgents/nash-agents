import os from "node:os";
import path from "node:path";

export function resolveNashHome(): string {
  return path.resolve(process.env.NASH_HOME || path.join(os.homedir(), ".nash-agents"));
}
