import type { SkillItemWithMode, SkillMode } from "../skills/types.js";
import { truncateToDisplayWidth, getVisibleWidth } from "./terminal-renderer.js";

const MODE_CYCLE: SkillMode[] = ["on", "off", "name-only", "user-only"];

/**
 * 交互式 Skills 弹窗管理器（/skills）
 */
export class SkillsPicker {
  private items: SkillItemWithMode[];
  query = "";
  selectedIndex = 0;
  private modified = false;

  constructor(items: SkillItemWithMode[]) {
    this.items = [...items];
  }

  get matches(): SkillItemWithMode[] {
    const q = this.query.trim().toLowerCase();
    if (!q) return this.items;
    return this.items.filter((item) =>
      item.metadata.name.toLowerCase().includes(q) ||
      item.metadata.description.toLowerCase().includes(q) ||
      item.mode.toLowerCase().includes(q)
    );
  }

  setQuery(query: string): void {
    this.query = query;
    this.selectedIndex = 0;
  }

  move(delta: number): void {
    const count = this.matches.length;
    if (count > 0) {
      this.selectedIndex = Math.max(0, Math.min(count - 1, this.selectedIndex + delta));
    }
  }

  /**
   * 循环切换当前选中技能的运行模式 (on -> off -> name-only -> user-only -> on)
   */
  cycleCurrentMode(): { name: string; newMode: SkillMode } | null {
    const target = this.matches[this.selectedIndex];
    if (!target) return null;

    const currentIdx = MODE_CYCLE.indexOf(target.mode);
    const nextIdx = (currentIdx + 1) % MODE_CYCLE.length;
    const newMode = MODE_CYCLE[nextIdx]!;

    target.mode = newMode;
    this.modified = true;
    return { name: target.metadata.name, newMode };
  }

  hasModifications(): boolean {
    return this.modified;
  }

  getItems(): SkillItemWithMode[] {
    return this.items;
  }

  render(columns: number, rows: number): string[] {
    const width = Math.max(40, columns - 2);
    const matches = this.matches;
    const totalCount = this.items.length;

    const lines: string[] = [
      "\x1b[1m\x1b[36mSkills\x1b[0m",
      truncateToDisplayWidth(
        `\x1b[90m${totalCount} skills · ↑↓ select · enter/space to cycle mode · / to search · Esc to close\x1b[0m`,
        width
      ),
      "",
    ];

    // 搜索输入框外观：框内直接渲染用户输入内容
    const boxInnerWidth = Math.min(width - 4, 74);
    const topDashes = Math.max(0, boxInnerWidth - 8);
    lines.push(`┌─ \x1b[36mSearch\x1b[0m ${"─".repeat(topDashes)}┐`);

    const queryDisplay = this.query ? this.query : "\x1b[90mSearch skills...\x1b[0m";
    const visibleQueryWidth = this.query ? getVisibleWidth(this.query) : 16;
    const innerPad = Math.max(0, boxInnerWidth - 1 - visibleQueryWidth);
    lines.push(`│  ${queryDisplay}${" ".repeat(innerPad)}│`);
    lines.push(`└${"─".repeat(boxInnerWidth + 1)}┘`);
    lines.push("");

    // 列表项视口高度计算 (预留选中项展开描述的 1 行空间)
    const headerLinesCount = lines.length;
    const footerLinesCount = 2;
    const pageSize = Math.max(2, rows - headerLinesCount - footerLinesCount - 1);

    const start = Math.min(
      Math.max(0, this.selectedIndex - pageSize + 1),
      Math.max(0, matches.length - pageSize)
    );
    const visible = matches.slice(start, start + pageSize);

    if (visible.length === 0) {
      lines.push("  \x1b[90mNo matching skills found.\x1b[0m");
    }

    for (let i = 0; i < visible.length; i++) {
      const item = visible[i]!;
      const isSelected = start + i === this.selectedIndex;
      const marker = isSelected ? "\x1b[36m\x1b[1m❯\x1b[0m" : " ";

      // 模式高亮渲染 (✓ on 绿色, off 灰色, name-only 青色, user-only 紫色)
      let modeDisplay: string;
      if (item.mode === "on") {
        modeDisplay = isSelected ? "\x1b[1m\x1b[32m✓ on       \x1b[0m" : "\x1b[32m✓ on       \x1b[0m";
      } else if (item.mode === "off") {
        modeDisplay = "\x1b[90m  off      \x1b[0m";
      } else if (item.mode === "name-only") {
        modeDisplay = isSelected ? "\x1b[1m\x1b[36m  name-only\x1b[0m" : "\x1b[36m  name-only\x1b[0m";
      } else {
        modeDisplay = isSelected ? "\x1b[1m\x1b[35m  user-only\x1b[0m" : "\x1b[35m  user-only\x1b[0m";
      }

      const scopeTag = item.metadata.scope === "global" ? "user" : "project";
      const nameStyled = isSelected
        ? `\x1b[1m\x1b[97m${item.metadata.name}\x1b[0m`
        : `\x1b[37m${item.metadata.name}\x1b[0m`;

      const toggleHint = isSelected ? " \x1b[33m(enter to cycle)\x1b[0m" : "";
      const itemLine = `${marker} ${modeDisplay}  ${nameStyled} \x1b[90m· ${scopeTag} · ~${item.estimatedTokens} tok\x1b[0m${toggleHint}`;
      lines.push(truncateToDisplayWidth(itemLine, width));

      // 选中项着重展示其详细功能描述
      if (isSelected && item.metadata.description) {
        const descLine = `    \x1b[36m↳\x1b[0m \x1b[90m${item.metadata.description}\x1b[0m`;
        lines.push(truncateToDisplayWidth(descLine, width));
      }
    }

    // 溢出指示行 (↓ N more below)
    const hiddenBelow = matches.length - (start + visible.length);
    if (hiddenBelow > 0) {
      lines.push(`\x1b[90m↓ ${hiddenBelow} more below\x1b[0m`);
    } else {
      lines.push("");
    }

    // 填充空白保持界面清爽稳定
    while (lines.length < rows) {
      lines.push("");
    }

    return lines.slice(0, rows);
  }
}
