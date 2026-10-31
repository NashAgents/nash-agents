/**
 * Tool Effect Classification & Execution Dependency / Conflict Detector
 *
 * 负责在并行审查与 Step 执行链路中，识别多工具调用之间的组合副作用与时序冲突
 * 防止诸如 "Tool A 修改 package.json/脚本，Tool B 执行 npm install/运行脚本" 时直接复用旧审查结果
 */

import path from "node:path";
import { SecurityContext } from "./security-types.js";

export type ToolEffectType = "READ" | "WRITE" | "EXECUTE" | "COORDINATION";

export interface ToolEffect {
  type: ToolEffectType;
  targetPaths: string[];
  affectsEnvironment: boolean;
  affectsWorkingDirectory: boolean;
  commandSnippet?: string;
}

export interface ConflictCheckResult {
  hasConflict: boolean;
  conflictReason?: string;
  conflictingPrerequisiteIndex?: number;
  requiresReevaluation: boolean;
}

export class ExecutionDependencyDetector {
  /**
   * 分类工具的执行副作用
   */
  public static classifyToolEffect(context: SecurityContext): ToolEffect {
    const { toolName, toolArgs } = context;
    const baseCwd = context.cwd || process.cwd();

    // 1. 写文件工具
    if (context.executionKind === "write" || toolName === "write_file" || toolName === "edit_file") {
      const p = String(toolArgs.path || toolArgs.file_path || "");
      const resolved = p ? path.resolve(baseCwd, p) : "";
      return {
        type: "WRITE",
        targetPaths: resolved ? [resolved] : [],
        affectsEnvironment: false,
        affectsWorkingDirectory: false,
      };
    }

    // 2. 读文件 / 搜索工具
    if (context.executionKind === "read" || toolName === "read_file" || toolName === "grep_search" || toolName === "list_files") {
      const p = String(toolArgs.path || toolArgs.file_path || toolArgs.directory || "");
      const resolved = p ? path.resolve(baseCwd, p) : "";
      return {
        type: "READ",
        targetPaths: resolved ? [resolved] : [],
        affectsEnvironment: false,
        affectsWorkingDirectory: false,
      };
    }

    // 3. 执行工具 (bash / npm / node / python 等)
    if (context.executionKind === "process" || toolName === "bash" || toolName === "execute_command") {
      const command = String(toolArgs.command || toolArgs.cmd || "");
      const cmdLower = command.toLowerCase().trim();

      // 检测是否包含写或变更操作
      const isWriteCmd =
        cmdLower.includes("npm install") ||
        cmdLower.includes("pnpm install") ||
        cmdLower.includes("yarn add") ||
        cmdLower.includes("pip install") ||
        cmdLower.includes("rm ") ||
        cmdLower.includes("mv ") ||
        cmdLower.includes("cp ") ||
        cmdLower.includes("> ") ||
        cmdLower.includes(">> ");

      const isCwdChange = cmdLower.startsWith("cd ") || cmdLower.includes("; cd ") || cmdLower.includes("&& cd ");

      return {
        type: isWriteCmd ? "WRITE" : "EXECUTE",
        targetPaths: [],
        affectsEnvironment: cmdLower.includes("export ") || isWriteCmd,
        affectsWorkingDirectory: isCwdChange,
        commandSnippet: command.slice(0, 80),
      };
    }

    // 4. 集群调度工具
    return {
      type: "COORDINATION",
      targetPaths: [],
      affectsEnvironment: false,
      affectsWorkingDirectory: false,
    };
  }

  /**
   * 检测待执行工具与本轮前面已经执行完成的工具之间是否存在读写冲突或依赖更新
   */
  public static detectConflict(
    currentContext: SecurityContext,
    executedContexts: SecurityContext[]
  ): ConflictCheckResult {
    const currentEffect = this.classifyToolEffect(currentContext);
    for (let i = 0; i < executedContexts.length; i++) {
      const previous = this.classifyToolEffect(executedContexts[i]!);
      // Executable code and external tools can change arbitrary files and aliases.
      const dynamic = previous.type === "EXECUTE" || previous.type === "COORDINATION" || previous.affectsEnvironment || previous.affectsWorkingDirectory;
      const written = previous.type === "WRITE";
      const executes = currentEffect.type === "EXECUTE" || currentEffect.type === "COORDINATION";
      const overlaps = previous.targetPaths.some(a => currentEffect.targetPaths.some(b => {
        const relative = path.relative(a, b), reverse = path.relative(b, a);
        const inside = (p: string) => !p || p !== ".." && !p.startsWith(`..${path.sep}`) && !path.isAbsolute(p);
        return inside(relative) || inside(reverse);
      }));
      if (dynamic || written && (executes || overlaps || !previous.targetPaths.length || !currentEffect.targetPaths.length)) {
        return { hasConflict: true, requiresReevaluation: true, conflictingPrerequisiteIndex: i,
          conflictReason: `前序工具 '${executedContexts[i]!.toolName}' (${previous.targetPaths.join(", ") || "动态副作用"}) 可能改变了执行证据，必须重新审查。` };
      }
    }

    return {
      hasConflict: false,
      requiresReevaluation: false,
    };
  }
}
