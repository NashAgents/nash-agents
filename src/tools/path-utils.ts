import path from "node:path";
import {
  isWindowsReservedDevice,
  hasAlternateDataStream,
  isInsideWorkspaceWindows,
} from "../sandbox/windows/path-utils.js";

/**
 * 校验并解析相对于工作区根目录的绝对路径。
 *
 * 安全约束：
 * 1. 相对路径基于工作区根目录（默认 process.cwd()）解析；
 * 2. 绝对路径必须严格落在工作区根目录内部；
 * 3. 禁止通过 '..' 等相对路径越界访问工作区之外的任何文件或目录；
 * 4. 返回规范化 (normalized) 后的绝对路径。
 *
 * @param inputPath - 用户或模型传入的路径
 * @param rootDir - 工作区根目录，默认为 process.cwd()
 * @returns 规范化后的绝对路径
 * @throws 当路径试图越出工作区根目录时抛出安全异常
 */
export function resolveWorkspacePath(
  inputPath: string,
  rootDir: string = process.cwd()
): string {
  if (typeof inputPath !== "string") {
    throw new Error("路径参数必须为字符串。");
  }

  const trimmed = inputPath.trim();
  const normalizedRoot = path.resolve(rootDir);

  // Windows 保留设备名与 ADS 拦截
  if (process.platform === "win32") {
    if (isWindowsReservedDevice(trimmed)) {
      throw new Error(`安全限制：拒绝访问 Windows 保留设备名称 '${inputPath}'。`);
    }
    if (hasAlternateDataStream(trimmed)) {
      throw new Error(`安全限制：拒绝访问 Windows Alternate Data Streams (ADS) 路径 '${inputPath}'。`);
    }
  }

  // 如果输入为空字符串，则视为主工作区根目录
  const targetPath =
    trimmed === "" ? normalizedRoot : path.resolve(normalizedRoot, trimmed);

  if (process.platform === "win32") {
    if (!isInsideWorkspaceWindows(targetPath, normalizedRoot)) {
      throw new Error(
        `安全限制：拒绝访问工作区根目录之外的路径 '${inputPath}'。当前工作区为 '${normalizedRoot}'。`
      );
    }
    return targetPath;
  }

  const relative = path.relative(normalizedRoot, targetPath);

  // 判断是否逃逸出工作区根目录：
  // 1. relative 为空字符串，说明是工作区根目录自身；
  // 2. relative 为 ".." 或以 "../"、`..\` 开头，说明是上层路径；
  // 3. relative 仍为绝对路径（例如 Windows 下跨盘符情况）。
  const isEscape =
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    relative.startsWith("../") ||
    relative.startsWith("..\\") ||
    path.isAbsolute(relative);

  if (isEscape) {
    throw new Error(
      `安全限制：拒绝访问工作区根目录之外的路径 '${inputPath}'。当前工作区为 '${normalizedRoot}'。`
    );
  }

  return targetPath;
}

/**
 * 获取相对于工作区根目录的展示用相对路径
 *
 * @param targetPath - 绝对或相对路径
 * @param rootDir - 工作区根目录，默认为 process.cwd()
 * @returns 规范化的相对路径（若与根目录一致则返回 "."）
 */
export function toWorkspaceRelativePath(
  targetPath: string,
  rootDir: string = process.cwd()
): string {
  const resolved = resolveWorkspacePath(targetPath, rootDir);
  const relative = path.relative(path.resolve(rootDir), resolved);
  return relative === "" ? "." : relative;
}
