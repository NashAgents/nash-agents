import type { Tool } from "./tool.js";
import type { MemoryService } from "../memory/memory-service.js";
import type { MemoryKind, MemoryScope } from "../memory/types.js";

export interface MemoryToolResult {
  output: string;
  success: boolean;
  executionTimeMs: number;
}

/**
 * remember 工具：显式持久化记录用户偏好、人设约束、架构或项目关键经验
 */
export class RememberTool implements Tool<any, MemoryToolResult> {
  readonly name = "remember";
  readonly description =
    "Explicitly record and persist a user preference, persona setting, workflow habit, or key technical fact into long-term persistent memory. Use this tool whenever the user instructs to remember, settle (沉淀记忆), or configure persona/preferences. DO NOT use write_file to create ad-hoc memory files.";

  readonly parameters = {
    type: "object",
    properties: {
      fact: {
        type: "string",
        description: "The fact, preference, persona rule, or lesson to remember.",
      },
      kind: {
        type: "string",
        enum: ["preference", "architecture", "environment", "fact", "decision", "lesson"],
        description: "Category of the memory entry. Defaults to 'preference' if persona/identity/habit, or 'fact'.",
      },
      scope: {
        type: "string",
        enum: ["global", "project"],
        description: "Memory scope. Use 'global' for user personas, styling, and general preferences; 'project' for repo-specific rules.",
      },
    },
    required: ["fact"],
  } as const;

  constructor(private readonly memoryService: MemoryService) {}

  async execute(args: {
    fact: string;
    kind?: MemoryKind;
    scope?: MemoryScope;
  }): Promise<MemoryToolResult> {
    const startTime = Date.now();
    try {
      if (!args.fact || typeof args.fact !== "string" || !args.fact.trim()) {
        return {
          output: "Error: Missing or invalid 'fact' argument for remember.",
          success: false,
          executionTimeMs: Date.now() - startTime,
        };
      }

      const content = args.fact.trim();
      let kind: MemoryKind = args.kind ?? "fact";

      // 智能推断人设与偏好
      if (!args.kind) {
        const low = content.toLowerCase();
        if (
          low.includes("称呼") ||
          low.includes("叫我") ||
          low.includes("哥哥") ||
          low.includes("人设") ||
          low.includes("女高中生") ||
          low.includes("妹妹") ||
          low.includes("偏好") ||
          low.includes("习惯")
        ) {
          kind = "preference";
        }
      }

      const targetScope = args.scope ?? (kind === "preference" ? "global" : undefined);

      const entry = await this.memoryService.remember({
        content,
        kind,
        source: "user-explicit",
        scope: targetScope,
        confidence: 1.0,
        tags: kind === "preference" ? ["persona", "user-preference", "invariant"] : undefined,
      });

      if (!entry) {
        return {
          output: "Memory disabled or failed to persist.",
          success: false,
          executionTimeMs: Date.now() - startTime,
        };
      }

      return {
        output: `Successfully remembered [${entry.kind}|${entry.scope}]: ${entry.content} (id: ${entry.id})`,
        success: true,
        executionTimeMs: Date.now() - startTime,
      };
    } catch (err: unknown) {
      return {
        output: `Failed to remember: ${err instanceof Error ? err.message : String(err)}`,
        success: false,
        executionTimeMs: Date.now() - startTime,
      };
    }
  }
}

/**
 * search_memory 工具：渐进式检索持久化记忆详情 (Tier 2 Progressive Disclosure)
 */
export class SearchMemoryTool implements Tool<any, MemoryToolResult> {
  readonly name = "search_memory";
  readonly description =
    "Search persistent memory across global and project scopes by keyword or topic to retrieve detailed historical knowledge and decisions.";

  readonly parameters = {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Search keyword, topic, or question to look up in persistent memory.",
      },
      scope: {
        type: "string",
        enum: ["all", "global", "project"],
        description: "Filter search scope. Defaults to 'all'.",
      },
    },
    required: ["query"],
  } as const;

  constructor(private readonly memoryService: MemoryService) {}

  async execute(args: {
    query: string;
    scope?: "all" | "global" | "project";
  }): Promise<MemoryToolResult> {
    const startTime = Date.now();
    try {
      if (!args.query || typeof args.query !== "string" || !args.query.trim()) {
        return {
          output: "Error: Missing or invalid 'query' argument for search_memory.",
          success: false,
          executionTimeMs: Date.now() - startTime,
        };
      }

      const results = await this.memoryService.search(args.query.trim(), args.scope ?? "all");

      if (results.length === 0) {
        return {
          output: `No persistent memories found matching '${args.query}'.`,
          success: true,
          executionTimeMs: Date.now() - startTime,
        };
      }

      const lines = [`Found ${results.length} persistent memory record(s):`];
      for (const item of results) {
        const sourceTag = item.source === "user-explicit" ? " *(user-explicit)*" : "";
        lines.push(`- [${item.kind}|${item.scope}] ${item.content}${sourceTag} (updated: ${item.updatedAt})`);
      }

      return {
        output: lines.join("\n"),
        success: true,
        executionTimeMs: Date.now() - startTime,
      };
    } catch (err: unknown) {
      return {
        output: `Failed to search memory: ${err instanceof Error ? err.message : String(err)}`,
        success: false,
        executionTimeMs: Date.now() - startTime,
      };
    }
  }
}
