import fs from "node:fs/promises";
import path from "node:path";
import { type Tool, type ToolExecutionContext, defineTool } from "./tool.js";
import { FileSystemAccess } from "../sandbox/filesystem-access.js";
import { createDefaultSandboxPolicy } from "../sandbox/policy.js";

/**
 * write_file 工具入参接口
 */
export interface WriteFileArgs {
  path: string;
  content: string;
}

/**
 * 创建并配置 write_file 工具实例（支持依赖注入）
 *
 * @param customFsAccess - 可选注入的 FileSystemAccess 实例
 */
export function createWriteFileTool(
  customFsAccess?: FileSystemAccess
): Tool<WriteFileArgs> {
  const getFsAccess = () =>
    customFsAccess ??
    new FileSystemAccess({
      policy: createDefaultSandboxPolicy(),
    });

  return defineTool({
    name: "write_file",
    description:
      "创建或覆盖写入指定路径的文本文件（UTF-8 编码）。如果父目录不存在会自动递归创建。",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "待写入的文件路径，支持相对路径或工作区内的绝对路径。",
        },
        content: {
          type: "string",
          description: "待写入的完整文本内容。",
        },
      },
      required: ["path", "content"],
    },
    async execute(args: WriteFileArgs, context?: ToolExecutionContext): Promise<string> {
      if (!args || typeof args.path !== "string" || args.path.trim() === "") {
        throw new Error("缺少必填参数 'path' 或路径为空。");
      }
      if (typeof args.content !== "string") {
        throw new Error("缺少必填参数 'content' 或内容类型不为 string。");
      }

      const fsAccess = getFsAccess();

      return await fsAccess.executeAtomicWrite(args.path, async (resolvedPath) => {
        context?.signal?.throwIfAborted();
        const relPath = fsAccess.toRelativePath(resolvedPath);

        // 检查目标路径是否已存在且是目录
        try {
          const stat = await fs.stat(resolvedPath);
          if (stat.isDirectory()) {
            throw new Error(
              `无法写入文件，目标路径已存在且为一个目录: '${relPath}'。`
            );
          }
        } catch (err: unknown) {
          if (
            !err ||
            typeof err !== "object" ||
            !("code" in err) ||
            err.code !== "ENOENT"
          ) {
            throw err;
          }
        }

        // 递归自动创建父目录
        const parentDir = path.dirname(resolvedPath);
        await fs.mkdir(parentDir, { recursive: true });

        // 写入文件
        context?.signal?.throwIfAborted();
        await fs.writeFile(resolvedPath, args.content, "utf-8");

        return `成功写入文件: ${relPath} (共 ${args.content.length} 字符)`;
      });
    },
  });
}

/**
 * 遵循 Tool 接口标准的默认 write_file 工具实例
 */
export const writeFileTool: Tool<WriteFileArgs> = createWriteFileTool();
