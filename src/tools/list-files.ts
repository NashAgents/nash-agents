import fs from "node:fs/promises";
import { type Tool, defineTool } from "./tool.js";
import { FileSystemAccess } from "../sandbox/filesystem-access.js";
import { createDefaultSandboxPolicy } from "../sandbox/policy.js";

/**
 * list_files 工具入参接口
 */
export interface ListFilesArgs {
  path?: string;
}

/**
 * 目录项描述结构
 */
export interface FileEntryItem {
  name: string;
  type: "file" | "directory" | "other";
}

/**
 * 创建并配置 list_files 工具实例（支持依赖注入）
 *
 * @param customFsAccess - 可选注入的 FileSystemAccess 实例
 */
export function createListFilesTool(
  customFsAccess?: FileSystemAccess
): Tool<ListFilesArgs> {
  const getFsAccess = () =>
    customFsAccess ??
    new FileSystemAccess({
      policy: createDefaultSandboxPolicy(),
    });

  return defineTool({
    name: "list_files",
    description:
      "列出指定目录的直接子项（非递归），返回每个子项的名称和类型（file 或 directory）。",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "待列出内容的目录路径，例如 '.' 或 'src/tools'。默认为当前工作区根目录。",
        },
      },
    },
    async execute(args: ListFilesArgs): Promise<FileEntryItem[]> {
      const targetPathInput =
        args && typeof args.path === "string" && args.path.trim() !== ""
          ? args.path
          : ".";

      const fsAccess = getFsAccess();
      const resolvedPath = await fsAccess.resolveForRead(targetPathInput);
      const relPath = fsAccess.toRelativePath(resolvedPath);

      let stat;
      try {
        stat = await fs.stat(resolvedPath);
      } catch (err: unknown) {
        if (
          err &&
          typeof err === "object" &&
          "code" in err &&
          err.code === "ENOENT"
        ) {
          throw new Error(`目录不存在: '${relPath}'。`);
        }
        throw err;
      }

      if (!stat.isDirectory()) {
        throw new Error(
          `目标路径不是目录: '${relPath}'。如需查看文件内容，请使用 'read_file' 工具。`
        );
      }

      const entries = await fs.readdir(resolvedPath, { withFileTypes: true });

      const items: FileEntryItem[] = entries.map((entry) => ({
        name: entry.name,
        type: entry.isDirectory()
          ? "directory"
          : entry.isFile()
            ? "file"
            : "other",
      }));

      // 按名称升序稳定排序
      items.sort((a, b) => a.name.localeCompare(b.name));

      return items;
    },
  });
}

/**
 * 遵循 Tool 接口标准的默认 list_files 工具实例
 */
export const listFilesTool: Tool<ListFilesArgs> = createListFilesTool();
