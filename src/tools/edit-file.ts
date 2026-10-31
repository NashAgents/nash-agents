import fs from "node:fs/promises";
import { type Tool, type ToolExecutionContext, defineTool } from "./tool.js";
import { FileSystemAccess } from "../sandbox/filesystem-access.js";
import { createDefaultSandboxPolicy } from "../sandbox/policy.js";

/**
 * edit_file 工具入参接口
 */
export interface EditFileArgs {
  path: string;
  old_text?: string;
  new_text?: string;
  edits?: Array<{ old_text: string; new_text: string }>;
}

/**
 * 创建并配置 edit_file 工具实例（支持依赖注入）
 *
 * @param customFsAccess - 可选注入的 FileSystemAccess 实例
 */
export function createEditFileTool(
  customFsAccess?: FileSystemAccess
): Tool<EditFileArgs> {
  const getFsAccess = () =>
    customFsAccess ??
    new FileSystemAccess({
      policy: createDefaultSandboxPolicy(),
    });

  return defineTool({
    name: "edit_file",
    description:
      "通过确定性精确字符串替换修改文件内容。同一文件的多处修改可放入 edits 数组，一次验证并写入；每个 old_text 必须唯一匹配。",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "需要修改的文件路径，支持相对路径或工作区内的绝对路径。",
        },
        old_text: {
          type: "string",
          description: "待替换的原始内容，必须在文件中唯一出现一次。",
        },
        new_text: {
          type: "string",
          description: "替换后的新内容。",
        },
        edits: {
          type: "array",
          description: "同一文件的多处替换，按顺序应用；与顶层 old_text/new_text 二选一。",
          items: {
            type: "object",
            properties: {
              old_text: { type: "string" },
              new_text: { type: "string" },
            },
            required: ["old_text", "new_text"],
          },
        },
      },
      required: ["path"],
    },
    async execute(args: EditFileArgs, context?: ToolExecutionContext): Promise<string> {
      if (!args || typeof args.path !== "string" || args.path.trim() === "") {
        throw new Error("缺少必填参数 'path' 或路径为空。");
      }
      if (args.edits !== undefined && (args.old_text !== undefined || args.new_text !== undefined)) {
        throw new Error("请使用 edits 数组或顶层 old_text/new_text，不能同时使用。");
      }
      const edits = args.edits ?? [{ old_text: args.old_text, new_text: args.new_text }];
      if (!Array.isArray(edits) || edits.length === 0) throw new Error("edits 至少需要一处替换。");
      for (const edit of edits) {
        if (!edit || typeof edit.old_text !== "string" || edit.old_text.length === 0) {
          throw new Error("缺少必填参数 'old_text' 或待替换内容为空。");
        }
        if (typeof edit.new_text !== "string") {
          throw new Error("缺少必填参数 'new_text' 或新内容类型不为 string。");
        }
      }

      const fsAccess = getFsAccess();

      return await fsAccess.executeAtomicWrite(args.path, async (resolvedPath) => {
        context?.signal?.throwIfAborted();
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
          throw new Error(`目标路径是一个目录，无法编辑文件: '${relPath}'。`);
        }

        let content = await fs.readFile(resolvedPath, "utf-8");

        // Validate every replacement before writing, so a later failure leaves
        // the file unchanged. Each edit observes the result of earlier edits.
        for (const [index, edit] of edits.entries()) {
          const oldText = edit.old_text!;
          const first = content.indexOf(oldText);
          if (first === -1) {
            throw new Error(`第 ${index + 1} 处替换失败：在文件 '${relPath}' 中未找到待替换的 'old_text'。请检查文本是否完全匹配（包括空格和换行）。`);
          }
          const second = content.indexOf(oldText, first + oldText.length);
          if (second !== -1) {
            let count = 2;
            for (let pos = second + oldText.length; (pos = content.indexOf(oldText, pos)) !== -1; pos += oldText.length) count++;
            throw new Error(`第 ${index + 1} 处替换失败：待替换的 'old_text' 在文件 '${relPath}' 中出现了 ${count} 次。为避免误改，请提供包含更多上下文的唯一匹配文本。`);
          }
          content = content.slice(0, first) + edit.new_text + content.slice(first + oldText.length);
        }

        context?.signal?.throwIfAborted();
        await fs.writeFile(resolvedPath, content, "utf-8");

        return `成功修改文件: ${relPath}（${edits.length} 处替换已验证并写入）。`;
      });
    },
  });
}

/**
 * 遵循 Tool 接口标准的默认 edit_file 工具实例
 */
export const editFileTool: Tool<EditFileArgs> = createEditFileTool();
