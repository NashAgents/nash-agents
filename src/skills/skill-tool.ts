import type { Tool, ToolResult } from "../tools/index.js";
import type { SkillService } from "./skill-service.js";

export interface SkillOpenToolOptions {
  skillService: SkillService;
}

/**
 * skill_open 工具：按需打开并读取指定 Skill 的完整定义与操作步骤 (Progressive Disclosure Level 2)
 */
export class SkillOpenTool implements Tool {
  readonly name = "skill_open";
  readonly description =
    "Open and view the detailed procedure, steps, and verification instructions for a specific skill from the Available Skills list.";

  readonly parameters = {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "The name of the skill to open (e.g. 'security-regression-fix').",
      },
    },
    required: ["name"],
  } as const;

  constructor(private readonly skillService: SkillService) {}

  async execute(args: { name: string }): Promise<ToolResult> {
    const startTime = Date.now();
    try {
      if (!args.name || typeof args.name !== "string") {
        return {
          output: "Error: Missing or invalid 'name' argument for skill_open.",
          success: false,
          executionTimeMs: Date.now() - startTime,
        };
      }

      const definition = await this.skillService.openSkill(args.name.trim());

      let output = `# Skill: ${definition.metadata.name} [${definition.metadata.scope}]\n`;
      output += `Description: ${definition.metadata.description}\n\n`;

      if (definition.whenToUse) {
        output += `## When to use\n${definition.whenToUse}\n\n`;
      }

      output += `## Procedure\n${definition.procedure}\n\n`;

      if (definition.verification) {
        output += `## Verification\n${definition.verification}\n\n`;
      }

      if (definition.referenceFiles && definition.referenceFiles.length > 0) {
        output += `\nAvailable References: ${definition.referenceFiles.join(", ")}`;
      }
      if (definition.scriptFiles && definition.scriptFiles.length > 0) {
        output += `\nAvailable Helper Scripts: ${definition.scriptFiles.join(", ")}`;
      }

      return {
        output: output.trim(),
        success: true,
        executionTimeMs: Date.now() - startTime,
      };
    } catch (err: unknown) {
      return {
        output: `Failed to open skill '${args.name}': ${
          err instanceof Error ? err.message : String(err)
        }`,
        success: false,
        executionTimeMs: Date.now() - startTime,
      };
    }
  }
}
