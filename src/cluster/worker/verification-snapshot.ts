import { DeterministicFastPathEligibilityValidator } from "../../security/fast-path-validator.js";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type { FileSystemAccess } from "../../sandbox/filesystem-access.js";

export interface WorkspaceSnapshot {
  complete: boolean;
  digest: string;
  files: Record<string, string>;
  bytes: number;
}

/** A deliberately narrow test recognizer. Unsupported commands still run, but cannot prove recovery. */
export function isRepeatableTestCommand(command: string): boolean {
  return /^(?:node\s+(?:--test-isolation=none\s+)?--test\s+[\w./-]+(?:\s+[\w./-]+)*|npm\s+(?:run\s+)?test|python(?:3)?\s+-m\s+pytest(?:\s+[\w./-]+)*|pytest(?:\s+[\w./-]+)*)$/.test(command.trim());
}

/** Bounded and fail-closed: never follow symlinks, read sensitive files, or infer an incomplete tree is unchanged. */
export async function snapshotWorkspace(access: FileSystemAccess): Promise<WorkspaceSnapshot> {
  const result: WorkspaceSnapshot = { complete: true, digest: "", files: {}, bytes: 0 };
  const root = await fs.realpath(access.getWorkspaceRoot());
  let entries = 0;
  const eligibility = new DeterministicFastPathEligibilityValidator();
  const visit = async (relative: string): Promise<void> => {
    if (!result.complete) return;
    const resolved = await access.resolveForRead(relative || ".");
    const items = await fs.readdir(resolved, { withFileTypes: true });
    for (const item of items.sort((a,b) => a.name.localeCompare(b.name))) {
      if (item.name === ".git") continue;
      if (++entries > 512 || /^(?:\.env(?:\..*)?|id_.*|.*\.(?:pem|key))$/i.test(item.name)) { result.complete = false; return; }
      const name = relative ? `${relative}/${item.name}` : item.name;
      if (item.isSymbolicLink() || !item.isDirectory() && !item.isFile()) { result.complete = false; return; }
      const rawArgs = JSON.stringify({ path: path.join(root, name) });
      if (!eligibility.validate({ toolName: "read_file", toolArgs: JSON.parse(rawArgs), rawArgs,
        argsFingerprint: createHash("sha256").update(rawArgs).digest("hex"), cwd: root,
        agentIdentity: { agentId: "runtime_verifier" }, sourceTag: "coordinator_instruction", userAuthorizationContext: {},
      }).isEligible) { result.complete = false; return; }
      if (item.isDirectory()) { await visit(name); continue; }
      const file = await access.resolveForRead(name);
      const before = await fs.lstat(file);
      if (!before.isFile() || before.size + result.bytes > 2 * 1024 * 1024) { result.complete = false; return; }
      const handle = await fs.open(file, "r");
      try {
        const opened = await handle.stat();
        const physicalBeforeRead = await fs.realpath(file);
        const relativeBeforeRead = path.relative(root, physicalBeforeRead);
        if (opened.ino !== before.ino || opened.size !== before.size || opened.mtimeMs !== before.mtimeMs || relativeBeforeRead === ".." || relativeBeforeRead.startsWith(`..${path.sep}`) || path.isAbsolute(relativeBeforeRead)) { result.complete = false; return; }
        const buffer = Buffer.alloc(before.size + 1);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        if (bytesRead !== before.size) { result.complete = false; return; }
        const bytes = buffer.subarray(0, bytesRead);
        const after = await handle.stat();
        const physical = await fs.realpath(file);
        const physicalRelative = path.relative(root, physical);
        if (physicalRelative.startsWith(`..${path.sep}`) || physicalRelative === ".." || path.isAbsolute(physicalRelative) || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytes.length + result.bytes > 2 * 1024 * 1024) { result.complete = false; return; }
        result.bytes += bytes.length;
        result.files[name] = createHash("sha256").update(bytes).digest("hex");
      } finally { await handle.close(); }
    }
  };
  try { await visit(""); } catch { result.complete = false; }
  result.digest = createHash("sha256").update(JSON.stringify(Object.entries(result.files).sort())).digest("hex");
  return result;
}
