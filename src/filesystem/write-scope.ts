import path from "node:path";

/**
 * 极简高效的路径 Glob 范围匹配器
 * 支持：
 * - 精确路径: "src/auth/service.ts"
 * - 目录递归通配: "src/auth/**"
 * - 文件后缀通配: "*.ts"
 */
export function isPathInScope(filePath: string, scopePattern: string): boolean {
  const normPath = filePath.replace(/\\/g, "/").replace(/^\.\//, "");
  const normPattern = scopePattern.replace(/\\/g, "/").replace(/^\.\//, "");

  if (normPattern === "*" || normPattern === "**" || normPattern === ".") {
    return true;
  }

  if (normPattern.endsWith("/**")) {
    const prefix = normPattern.slice(0, -3);
    return normPath === prefix || normPath.startsWith(`${prefix}/`);
  }

  if (normPattern.endsWith("/*")) {
    const prefix = normPattern.slice(0, -2);
    if (normPath === prefix) return true;
    if (normPath.startsWith(`${prefix}/`)) {
      const rest = normPath.slice(prefix.length + 1);
      return !rest.includes("/");
    }
    return false;
  }

  if (normPattern.includes("*")) {
    const regexStr = "^" + normPattern.split(/(\*\*\/|\*\*|\*)/).map((part) => {
      if (part === "**/") return "(?:.*/)?";
      if (part === "**") return ".*";
      if (part === "*") return "[^/]*";
      return part.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    }).join("") + "$";
    const regex = new RegExp(regexStr);
    return regex.test(normPath);
  }

  return normPath === normPattern || normPath.startsWith(`${normPattern}/`);
}

/**
 * 判定两个 Task 声明的 writeScopes 是否存在重叠 (Overlap Conflict)
 */
export function checkScopeOverlap(
  scopeA: string[],
  scopeB: string[]
): {
  conflict: boolean;
  overlappingScopes: Array<{ patternA: string; patternB: string }>;
} {
  const overlapping: Array<{ patternA: string; patternB: string }> = [];

  for (const a of scopeA) {
    for (const b of scopeB) {
      if (patternsOverlap(a, b)) {
        overlapping.push({ patternA: a, patternB: b });
      }
    }
  }

  return {
    conflict: overlapping.length > 0,
    overlappingScopes: overlapping,
  };
}

function patternsOverlap(patA: string, patB: string): boolean {
  patA = patA.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
  patB = patB.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
  if (patA === "." || patB === ".") return true;
  if (patA === patB) return true;
  if (patA === "**" || patB === "**" || patA === "*" || patB === "*") return true;

  const aClean = patA.replace(/\/\*\*?$/, "");
  const bClean = patB.replace(/\/\*\*?$/, "");

  if (aClean === bClean) return true;
  if (aClean.startsWith(bClean + "/") || bClean.startsWith(aClean + "/")) {
    return true;
  }
  if (isPathInScope(patA, patB) || isPathInScope(patB, patA)) return true;
  // Glob intersections are conservatively locked when their literal prefixes overlap.
  if (patA.includes("*") || patB.includes("*")) {
    const aPrefix = patA.split("*")[0]!;
    const bPrefix = patB.split("*")[0]!;
    return aPrefix.startsWith(bPrefix) || bPrefix.startsWith(aPrefix);
  }
  return false;
}
