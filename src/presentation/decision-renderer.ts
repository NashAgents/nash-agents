import type { StructuredDecision } from "../decision/types.js";
import { truncateToDisplayWidth } from "./terminal-renderer.js";

export interface DecisionRenderOptions {
  decision: StructuredDecision;
  totalPending?: number;
  maxWidth?: number;
}

/**
 * 结构化决策终端渲染器 (DecisionRenderer)
 *
 * 铁律：
 * 1. 严格支持 ANSI 样式与中文字符宽度；
 * 2. 高亮选中的选项 (使用 `>` 与高亮色)；
 * 3. 清楚呈现快捷键与选项说明；
 * 4. 保持紧凑整洁，适配各种终端尺寸。
 */
export class DecisionRenderer {
  /**
   * 渲染单个结构化决策卡片
   */
  static renderDecision(options: DecisionRenderOptions): string[] {
    const { decision, totalPending = 1, maxWidth = 80 } = options;
    const lines: string[] = [];

    // 若为 plan-approval 决策，步骤与目标已由 ProposedPlanProjection 专职渲染，Decision 区域仅显示选项列表
    if (decision.kind === "plan-approval") {
      for (let i = 0; i < decision.options.length; i++) {
        const opt = decision.options[i];
        const isSelected = i === decision.selectedIndex;

        let prefix = isSelected ? "\x1b[36m> \x1b[0m" : "  ";
        let labelText = opt.label;

        if (isSelected) {
          if (opt.destructive) {
            labelText = `\x1b[31m\x1b[1m${opt.label}\x1b[0m`;
          } else {
            labelText = `\x1b[1m\x1b[36m${opt.label}\x1b[0m`;
          }
        } else if (opt.destructive) {
          labelText = `\x1b[90m${opt.label}\x1b[0m`;
        }

        let shortcutHint = "";
        if (opt.shortcut) {
          shortcutHint = ` \x1b[90m[${opt.shortcut}]\x1b[0m`;
        }

        lines.push(
          truncateToDisplayWidth(
            `${prefix}${labelText}${shortcutHint}`,
            maxWidth
          )
        );
      }
      return lines;
    }

    // 1. 标题栏（含队列序号提示）
    const queueBadge =
      totalPending > 1 ? ` \x1b[90m(Decision 1/${totalPending})\x1b[0m` : "";

    let titlePrefix = "\x1b[36m\x1b[1m";
    if (decision.kind === "permission") {
      titlePrefix = "\x1b[33m\x1b[1m";
    } else if (decision.kind === "confirmation") {
      titlePrefix = "\x1b[35m\x1b[1m";
    }

    lines.push(
      truncateToDisplayWidth(
        `${titlePrefix}${decision.title}\x1b[0m${queueBadge}`,
        maxWidth
      )
    );

    // 2. 描述信息（如果有）
    if (decision.description) {
      const descLines = decision.description.split("\n");
      for (const dLine of descLines) {
        lines.push(
          truncateToDisplayWidth(`  \x1b[90m${dLine}\x1b[0m`, maxWidth)
        );
      }
    }

    lines.push("");

    // 3. 选项列表
    for (let i = 0; i < decision.options.length; i++) {
      const opt = decision.options[i];
      const isSelected = i === decision.selectedIndex;

      let prefix = isSelected ? "\x1b[36m> \x1b[0m" : "  ";
      let labelText = opt.label;

      if (isSelected) {
        if (opt.destructive) {
          labelText = `\x1b[31m\x1b[1m${opt.label}\x1b[0m`;
        } else {
          labelText = `\x1b[1m\x1b[36m${opt.label}\x1b[0m`;
        }
      } else if (opt.destructive) {
        labelText = `\x1b[90m${opt.label}\x1b[0m`;
      }

      let shortcutHint = "";
      if (opt.shortcut) {
        shortcutHint = ` \x1b[90m[${opt.shortcut}]\x1b[0m`;
      }

      let descHint = "";
      if (opt.description) {
        descHint = ` \x1b[90m- ${opt.description}\x1b[0m`;
      }

      lines.push(
        truncateToDisplayWidth(
          `${prefix}${labelText}${shortcutHint}${descHint}`,
          maxWidth
        )
      );
    }

    return lines;
  }

  /**
   * 渲染 Plan Revision 自由文本输入界面
   */
  static renderPlanRevisionInput(draft: string, maxWidth = 80): string[] {
    const lines: string[] = [];
    lines.push("\x1b[33m\x1b[1mRevise plan\x1b[0m");
    lines.push("\x1b[90mDescribe what you want changed:\x1b[0m");
    if (draft) {
      lines.push(truncateToDisplayWidth(`> ${draft}\x1b[K`, maxWidth));
    } else {
      lines.push(
        truncateToDisplayWidth(
          `\x1b[90m> (e.g. 拆分模块并增加安全审计子 Agent...)\x1b[0m`,
          maxWidth
        )
      );
    }
    return lines;
  }

  /**
   * 获取当前状态对应的动态快捷键提示文本
   */
  static getDynamicHints(context: {
    hasActiveDecision: boolean;
    decisionKind?: string;
    isPlanRevisionInput?: boolean;
    isAlternateScreen?: boolean;
    followupCount?: number;
  }): string {
    if (context.isAlternateScreen) {
      const globalBadge = context.hasActiveDecision
        ? " \x1b[33m\x1b[1m[⚡ Decision Pending!]\x1b[0m"
        : "";
      return `\x1b[90mEsc back · ↑↓/PgUp/PgDn scroll · End follow · Ctrl+X interrupt${globalBadge}\x1b[0m`;
    }

    if (context.isPlanRevisionInput) {
      return `\x1b[90mEnter submit revision · Esc back to approval\x1b[0m`;
    }

    if (context.hasActiveDecision) {
      if (context.decisionKind === "permission") {
        return `\x1b[90m↑↓ select · Enter confirm · Esc deny · y/n shortcut\x1b[0m`;
      }
      return `\x1b[90m↑↓ select · Enter confirm · Esc cancel\x1b[0m`;
    }

    // 普通运行模式
    const followup =
      context.followupCount && context.followupCount > 0
        ? ` · Follow-ups: ${context.followupCount}`
        : "";
    return `\x1b[90mEnter steer · Ctrl+Q queue · ↑↓ agents · Ctrl+T plan · Esc interrupt${followup}\x1b[0m`;
  }
}
