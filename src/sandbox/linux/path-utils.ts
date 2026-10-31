import { resolveCanonicalPhysicalPath } from "../../filesystem/file-lock-manager.js";
import fs from "node:fs";
import path from "node:path";

/**
 * 解析并获取规范化真实物理路径（安全处理真实软链接物理指向）
 */
export function resolveCanonicalPath(rawPath?: string): string {
  return resolveCanonicalPhysicalPath(rawPath || process.cwd());
}

/**
 * 校验 targetPath 是否逃逸出 workspaceRoot（包含词法与物理 realpath 校验）
 */
export function isPathOutsideWorkspace(workspaceRoot: string, targetPath: string): boolean {
  const canonicalWorkspace = resolveCanonicalPath(workspaceRoot);
  const canonicalTarget = resolveCanonicalPath(targetPath);

  // 1. 词法路径检查
  const lexicalRelative = path.relative(path.resolve(workspaceRoot), path.resolve(targetPath));
  if (
    lexicalRelative === ".." ||
    lexicalRelative.startsWith(`..${path.sep}`) ||
    lexicalRelative.startsWith("../") ||
    lexicalRelative.startsWith("..\\") ||
    path.isAbsolute(lexicalRelative)
  ) {
    return true;
  }

  // 2. 真实物理路径检查 (防软链接指向外部逃逸)
  const canonicalRelative = path.relative(canonicalWorkspace, canonicalTarget);
  if (
    canonicalRelative === ".." ||
    canonicalRelative.startsWith(`..${path.sep}`) ||
    canonicalRelative.startsWith("../") ||
    canonicalRelative.startsWith("..\\") ||
    path.isAbsolute(canonicalRelative)
  ) {
    return true;
  }

  return false;
}

/**
 * 规范化、去重并消除父子重叠的受限写目录列表
 *
 * 算法规则：
 * 1. path.resolve
 * 2. resolveCanonicalPath (realpath 物理真实路径)
 * 3. 校验路径是否存在，且未逃逸出当前 workspaceRoot
 * 4. 排序后消除子路径冗余（若 parent 在列表中，则 parent/child 属于冗余，自动剔除）
 */
export function canonicalizeWriteScopes(
  workspaceRoot: string,
  rawScopes?: string[]
): string[] {
  if (!rawScopes || rawScopes.length === 0) {
    return [];
  }

  const canonicalWorkspace = resolveCanonicalPath(workspaceRoot);
  const validatedPaths = new Set<string>();

  for (let raw of rawScopes) {
    if (!raw || typeof raw !== "string") continue;
    raw = raw.replace(/\\/g, "/").replace(/\/\*\*$/, "");
    if (raw === "*" || raw === "**") raw = ".";
    const absPath = path.isAbsolute(raw)
      ? path.resolve(raw)
      : path.resolve(workspaceRoot, raw);

    const canonical = resolveCanonicalPath(absPath);

    // 必须存在且未逃逸出 workspaceRoot
    if (fs.existsSync(canonical)) {
      if (!isPathOutsideWorkspace(canonicalWorkspace, canonical)) {
        validatedPaths.add(canonical);
      }
    }
  }

  // 按路径长度升序排列，以便父路径排在子路径之前
  const sorted = Array.from(validatedPaths).sort((a, b) => a.length - b.length);
  const result: string[] = [];

  for (const candidate of sorted) {
    // 检查是否已有更高层父目录已被包含
    const hasParent = result.some((parent) => {
      const rel = path.relative(parent, candidate);
      return (
        rel === "" ||
        (!rel.startsWith("..") && !path.isAbsolute(rel))
      );
    });

    if (!hasParent) {
      result.push(candidate);
    }
  }

  return result;
}
