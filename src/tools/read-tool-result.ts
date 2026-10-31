import { type Tool, defineTool } from "./tool.js";
import type { SpillStore } from "../context/spill/spill-store.js";
import { LocalSpillStore } from "../context/spill/local-spill-store.js";

/**
 * read_tool_result 工具入参接口
 */
export interface ReadToolResultArgs {
  /**
   * Spill 产物唯一 ID 或定位符（例如 tool-result://abc123 或 abc123）
   */
  id: string;

  /**
   * 起始行号（1-indexed，包含此行），默认为 1
   */
  offset?: number;

  /**
   * 本次读取的最大行数
   */
  limit?: number;

  /**
   * 起始字符偏移量（0-indexed），若提供则优先按字符分段
   */
  charOffset?: number;

  /**
   * 单次读取的最大字符数硬限制（防止超长单行撑爆上下文）
   */
  maxChars?: number;
}

/**
 * 单次输出字符数安全上限
 */
const DEFAULT_MAX_CHARS = 20_000;

/**
 * 创建并配置 read_tool_result 工具实例（支持依赖注入）
 *
 * @param customSpillStore - 可选注入的 SpillStore 实例
 */
export function createReadToolResultTool(
  customSpillStore?: SpillStore
): Tool<ReadToolResultArgs, string> {
  const getSpillStore = () => customSpillStore ?? new LocalSpillStore();

  return defineTool<ReadToolResultArgs, string>({
    name: "read_tool_result",
    description:
      "分页读取因体积超限而被外部归档的 ToolResult 完整内容 (Spill Artifact)。支持行分页 (offset/limit) 与字符偏移 (charOffset/maxChars)。",
    parameters: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description:
            "Spill 产物标识符，支持 'tool-result://<id>' 协议定位符或纯 '<id>' 字符串。",
        },
        offset: {
          type: "number",
          description: "起始读取行号 (1-indexed，包含此行)，默认为 1。",
        },
        limit: {
          type: "number",
          description: "本次读取的最大行数，默认为 100。",
        },
        charOffset: {
          type: "number",
          description:
            "起始字符偏移量 (0-indexed)。当单行极大或需要精确字符切片时使用。",
        },
        maxChars: {
          type: "number",
          description: "单次返回的最大字符数上限，默认为 20,000 字符。",
        },
      },
      required: ["id"],
    },
    async execute(args: ReadToolResultArgs): Promise<string> {
      if (!args || typeof args.id !== "string" || args.id.trim() === "") {
        throw new Error("缺少必填参数 'id' 或 ID 为空。");
      }

      const spillStore = getSpillStore();

      let offset: number | undefined;
      if (args.offset !== undefined) {
        const parsed = Number(args.offset);
        if (!Number.isFinite(parsed) || parsed < 1) {
          throw new Error(`参数 'offset' 必须为大于等于 1 的正整数，实际传入: ${args.offset}`);
        }
        offset = Math.floor(parsed);
      }

      let limit: number | undefined;
      if (args.limit !== undefined) {
        const parsed = Number(args.limit);
        if (!Number.isFinite(parsed) || parsed < 1) {
          throw new Error(`参数 'limit' 必须为大于等于 1 的正整数，实际传入: ${args.limit}`);
        }
        limit = Math.floor(parsed);
      }

      let charOffset: number | undefined;
      if (args.charOffset !== undefined) {
        const parsed = Number(args.charOffset);
        if (!Number.isFinite(parsed) || parsed < 0) {
          throw new Error(`参数 'charOffset' 必须为大于等于 0 的整数，实际传入: ${args.charOffset}`);
        }
        charOffset = Math.floor(parsed);
      }

      let maxChars = DEFAULT_MAX_CHARS;
      if (args.maxChars !== undefined) {
        const parsed = Number(args.maxChars);
        if (!Number.isFinite(parsed) || parsed < 1) {
          throw new Error(`参数 'maxChars' 必须为大于等于 1 的正整数，实际传入: ${args.maxChars}`);
        }
        maxChars = Math.floor(parsed);
      }

      const result = await spillStore.read(args.id, {
        offset: offset ?? 1,
        limit: limit ?? 100,
        charOffset,
        maxChars,
      });

      const headerLines: string[] = [
        `[Spill Artifact: ${result.locator}]`,
        `Lines ${result.startLine}-${result.endLine} of ${result.totalLines} | Chars ${result.startChar}-${result.endChar} of ${result.totalChars}`,
        `hasMore: ${result.hasMore}`,
      ];

      if (result.hasMore) {
        if (result.nextLineOffset !== undefined) {
          headerLines.push(`nextLineOffset: ${result.nextLineOffset}`);
        }
        if (result.nextCharOffset !== undefined) {
          headerLines.push(`nextCharOffset: ${result.nextCharOffset}`);
        }
      }

      const output = `${headerLines.join("\n")}\n\n--- Content ---\n${result.content}`;
      return output;
    },
  });
}

/**
 * 默认 read_tool_result 工具实例
 */
export const readToolResultTool: Tool<ReadToolResultArgs, string> =
  createReadToolResultTool();
