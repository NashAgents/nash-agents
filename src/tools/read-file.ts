import { readTextPage } from "../filesystem/text-page.js";
import fs from "node:fs/promises";
import { type Tool, defineTool } from "./tool.js";
import { FileSystemAccess } from "../sandbox/filesystem-access.js";
import { createDefaultSandboxPolicy } from "../sandbox/policy.js";

/**
 * read_file 工具入参接口
 */
export interface ReadFileArgs {
  path: string;
  offset?: number;
  limit?: number;
  charOffset?: number;
}

/**
 * 单次输出字符数安全上限（兜底保护，避免异常长行撑爆上下文）
 */
const MAX_OUTPUT_LENGTH = 50_000;

/**
 * 默认单次读取行数
 */
const DEFAULT_LIMIT = 200;

/**
 * 创建并配置 read_file 工具实例（支持依赖注入）
 *
 * @param customFsAccess - 可选注入的 FileSystemAccess 实例
 */
export function createReadFileTool(
  customFsAccess?: FileSystemAccess
): Tool<ReadFileArgs> {
  const getFsAccess = () =>
    customFsAccess ??
    new FileSystemAccess({
      policy: createDefaultSandboxPolicy(),
    });

  return defineTool({
    name: "read_file",
    description:
      "分段读取文本文件内容（UTF-8 编码），按行编号返回。支持通过 offset 与 limit 进行分页读取，避免大文件撑爆上下文。",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "待读取的文件路径，支持相对路径或工作区内的绝对路径。",
        },
        charOffset: { type: "number", description: "超长行续读时，从该行已读字符数继续，默认 0。" },
        offset: {
          type: "number",
          description: "起始读取行号（1-indexed，包含此行），默认为 1。",
        },
        limit: {
          type: "number",
          description: "本次读取的最大行数，默认为 200。",
        },
      },
      required: ["path"],
    },
    async execute(args: ReadFileArgs): Promise<string> {
      if (!args || typeof args.path !== "string" || args.path.trim() === "") {
        throw new Error("缺少必填参数 'path' 或路径为空。");
      }

      let offset = 1;
      if (args.offset !== undefined) {
        const parsedOffset = Number(args.offset);
        if (!Number.isFinite(parsedOffset) || parsedOffset < 1) {
          throw new Error(
            `参数 'offset' 必须是大于等于 1 的正整数，实际传入: ${args.offset}`
          );
        }
        offset = Math.floor(parsedOffset);
      }

      let limit = DEFAULT_LIMIT;
      if (args.limit !== undefined) {
        const parsedLimit = Number(args.limit);
        if (!Number.isFinite(parsedLimit) || parsedLimit < 1) {
          throw new Error(
            `参数 'limit' 必须是大于等于 1 的正整数，实际传入: ${args.limit}`
          );
        }
        limit = Math.floor(parsedLimit);
      }

      const charOffset = args.charOffset ?? 0;
      if (!Number.isSafeInteger(charOffset) || charOffset < 0) throw new Error("charOffset 必须是非负整数");
      const fsAccess = getFsAccess();
      const resolvedPath = await fsAccess.resolveForRead(args.path, { observe: false });
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
          throw new Error(`文件不存在: '${relPath}'。`);
        }
        throw err;
      }

      if (stat.isDirectory()) {
        throw new Error(
          `目标路径是一个目录，无法作为文件读取: '${relPath}'。如需查看目录内容，请使用 'list_files' 工具。`
        );
      }

      const page = await readTextPage(resolvedPath, offset, limit, MAX_OUTPUT_LENGTH - 500, charOffset);
      fsAccess.recordFileWritten(resolvedPath, page.sha256);
      const totalLines = page.totalLines;
      if (totalLines === 0) return `[${relPath}]\n文件为空 (总行数: 0)。`;
      if (offset > totalLines) return `[${relPath}]\n请求的起始行 offset=${offset} 超出了文件总行数 (共 ${totalLines} 行)。`;
      const endLine = page.endLine;
      const formattedLines = [`Lines ${offset}-${endLine} of ${totalLines}`, ...page.lines];
      formattedLines.push(page.nextOffset <= totalLines ? `\nMore lines available. Continue from offset=${page.nextOffset}, charOffset=${page.nextCharOffset}.` : `\n(End of file - all lines read)`);
      let output = formattedLines.join("\n");
      if (page.truncated) output = output + "\n... [单次输出达到安全阈值已截断]";

      return output;
    },
  });
}

/**
 * 遵循 Tool 接口标准的默认 read_file 工具实例
 */
export const readFileTool: Tool<ReadFileArgs> = createReadFileTool();
