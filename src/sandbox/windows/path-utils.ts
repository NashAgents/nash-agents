import { resolveCanonicalPhysicalPath } from "../../filesystem/file-lock-manager.js";
import path from "node:path";
import fsSync from "node:fs";
import { FilesystemAccessDeniedError } from "../errors.js";

/** ACL grants support literal paths and recursive directory scopes, never wider glob approximations. */
export function resolveWindowsWriteScope(scope: string, workspace: string): string {
  const normalized = scope.replace(/\\/g, "/").replace(/^\.\//, "");
  const literal = normalized === "*" || normalized === "**" ? "." : normalized.replace(/\/\*\*$/, "");
  if (!literal || /[*?\[\]]/.test(literal) || isWindowsReservedDevice(literal) || hasAlternateDataStream(literal)) {
    throw new FilesystemAccessDeniedError(scope, "write", "Windows ACL 无法精确表达该写范围 (Fail-Closed)");
  }
  const resolved = path.resolve(workspace, literal);
  if (!isInsideWorkspaceWindows(resolved, workspace)) {
    throw new FilesystemAccessDeniedError(scope, "write", "scopedWritePaths escapes workspace");
  }
  return resolveCanonicalPhysicalPathWindows(resolved);
}

/**
 * Windows 保留设备名称列表 (无论后缀名大小写均被 Windows 驱动捕获)
 * 包括 CON, PRN, AUX, NUL, COM1-COM9, LPT1-LPT9
 */
const WINDOWS_RESERVED_DEVICE_NAMES = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  "com1",
  "com2",
  "com3",
  "com4",
  "com5",
  "com6",
  "com7",
  "com8",
  "com9",
  "lpt1",
  "lpt2",
  "lpt3",
  "lpt4",
  "lpt5",
  "lpt6",
  "lpt7",
  "lpt8",
  "lpt9",
]);

/**
 * 规范化 Windows 扩展长路径前缀 (\\?\)
 */
export function stripExtendedLengthPrefix(p: string): string {
  if (!p) return "";
  if (p.startsWith("\\\\?\\UNC\\")) {
    return "\\\\" + p.slice(8);
  }
  if (p.startsWith("\\\\?\\")) {
    return p.slice(4);
  }
  return p;
}

/**
 * 判断路径是否包含 Windows 保留设备名 (如 NUL, CON, COM1.txt 等)
 */
export function isWindowsReservedDevice(inputPath: string): boolean {
  if (!inputPath || typeof inputPath !== "string") return false;

  const normalized = stripExtendedLengthPrefix(inputPath).replace(/\//g, "\\");
  const segments = normalized.split("\\").filter(Boolean);

  for (const seg of segments) {
    // 提取不带扩展名的基本名以及完整名
    const dotIndex = seg.indexOf(".");
    const baseName = (dotIndex >= 0 ? seg.slice(0, dotIndex) : seg).toLowerCase().trim();
    if (WINDOWS_RESERVED_DEVICE_NAMES.has(baseName)) {
      return true;
    }
  }

  return false;
}

/**
 * 判断路径是否包含 Windows Alternate Data Streams (ADS) 语法
 * 例如: `file.txt:hidden.exe` 或 `file.txt::$DATA`
 * 注意：必须排除 Windows 盘符冒号 (如 `C:\`)
 */
export function hasAlternateDataStream(inputPath: string): boolean {
  if (!inputPath || typeof inputPath !== "string") return false;

  const clean = stripExtendedLengthPrefix(inputPath);
  // 去除开头的盘符 (如 "C:")
  const withoutDrive = clean.replace(/^[a-zA-Z]:/, "");

  return withoutDrive.includes(":");
}

/**
 * 解析并规范化 Windows 物理真实路径（自动展开符号链接、Junction 与 Reparse Points）
 */
export function resolveCanonicalPhysicalPathWindows(rawPath: string): string {
  return stripExtendedLengthPrefix(resolveCanonicalPhysicalPath(stripExtendedLengthPrefix(rawPath)));
}

/**
 * 大小写不敏感的 Windows 目录归属判定
 * 确保 `C:\Projects\nash` 能够识别并允许访问 `c:\projects\nash\src`，
 * 但坚决拦截跨目录逃逸（如 `C:\Projects\nash-evil` 或 `D:\other`）。
 */
export function isInsideWorkspaceWindows(
  targetPath: string,
  workspaceRoot: string
): boolean {
  const canonicalTarget = resolveCanonicalPhysicalPathWindows(targetPath);
  const canonicalRoot = resolveCanonicalPhysicalPathWindows(workspaceRoot);

  const relative = path.relative(canonicalRoot, canonicalTarget);

  // 跨盘符时 relative 会直接返回绝对路径 (如 "D:\foo")
  if (path.isAbsolute(relative)) {
    return false;
  }

  // 大小写折叠比对
  const lowerRelative = relative.toLowerCase();

  if (
    lowerRelative === ".." ||
    lowerRelative.startsWith("..\\") ||
    lowerRelative.startsWith("../")
  ) {
    return false;
  }

  return true;
}
