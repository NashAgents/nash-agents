import type { ProposedPlan } from "../plan/types.js";
import { truncateToDisplayWidth } from "./terminal-renderer.js";

export interface ProposedPlanRenderOptions {
  maxWidth?: number;
  maxVisibleSteps?: number;
  stepOffset?: number;
  showDetails?: boolean;
}

/**
 * ProposedPlanProjection - 负责 Awaiting Approval 阶段方案提案的文档化呈现
 *
 * 核心设计：
 * 1. 忠实呈现人类可读的拟执行步骤 (1. 步骤名称)，不与运行时 TaskGraph 混合；
 * 2. 严禁显示 "(0/5)" 等执行态统计计数；
 * 3. 严禁显示 "○ ready" / "→ running" 等运行时状态图标；
 * 4. 为用户审阅提供清晰的 Goal 与 Step 结构。
 */
export class ProposedPlanProjection {
  static render(plan: ProposedPlan, options?: ProposedPlanRenderOptions): string[] {
    const lines: string[] = [];
    const maxSteps = options?.maxVisibleSteps ?? 5;
    const width = options?.maxWidth ?? 80;
    const offset = Math.max(0, Math.min(options?.stepOffset ?? 0, Math.max(0, plan.steps.length - maxSteps)));

    const range = offset > 0 ? ` · ${offset + 1}-${Math.min(offset + maxSteps, plan.steps.length)}/${plan.steps.length}` : ` · ${plan.steps.length} steps`;
    lines.push(`\x1b[1m\x1b[36mPlan ready for approval\x1b[0m \x1b[90m${range}\x1b[0m`);

    if (plan.goal && plan.goal !== "No explicit goal provided") {
      lines.push(truncateToDisplayWidth(`  \x1b[90mGoal: ${plan.goal}\x1b[0m`, width));
    }
    if (plan.summary) lines.push(truncateToDisplayWidth(`  \x1b[90mSummary: ${plan.summary}\x1b[0m`, width));
    if (plan.risks?.length) lines.push(truncateToDisplayWidth(`  \x1b[33mRisks: ${plan.risks.join("; ")}\x1b[0m`, width));
    if (options?.showDetails && plan.assumptions?.length) {
      lines.push(truncateToDisplayWidth(`  \x1b[90mAssumptions: ${plan.assumptions.join("; ")}\x1b[0m`, width));
    }

    const steps = plan.steps;
    const visibleSteps = steps.slice(offset, offset + maxSteps);

    for (let i = 0; i < visibleSteps.length; i++) {
      const step = visibleSteps[i];
      lines.push(truncateToDisplayWidth(`  \x1b[37m${offset + i + 1}. ${step.subject}\x1b[0m`, width));
      if (options?.showDetails) {
        if (step.description) lines.push(truncateToDisplayWidth(`     ${step.description}`, width));
        if (step.dependencies?.length) lines.push(truncateToDisplayWidth(`     After: ${step.dependencies.join(", ")}`, width));
        if (step.writeScopes?.length) lines.push(truncateToDisplayWidth(`     Files: ${step.writeScopes.join(", ")}`, width));
      }
    }

    if (steps.length > offset + maxSteps) {
      lines.push(`  \x1b[90m… 还有 ${steps.length - offset - maxSteps} 个步骤 · PgDn 查看\x1b[0m`);
    }

    lines.push(`  \x1b[90mPgUp/PgDn steps · D ${options?.showDetails ? "hide" : "show"} details\x1b[0m`);

    return lines;
  }
}
