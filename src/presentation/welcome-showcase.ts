import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getVisibleWidth, truncateToDisplayWidth } from "./terminal-renderer.js";

export interface WelcomeShowcaseOptions {
  modelName: string;
  projectRoot: string;
  sandboxMode?: string;
  contextWindow?: number;
  width?: number;
  version?: string;
}

function resolvePackageVersion(): string {
  try {
    const pkgPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/**
 * 展示页与欢迎仪表盘组件 (Showcase Hero Bento Card)
 * 采用极简克制、低噪高雅的设计语言，将品牌标识、环境上下文与快捷向导优雅呈现。
 */
export class WelcomeShowcase {
  static render(options: WelcomeShowcaseOptions): string[] {
    const termWidth = options.width ?? 80;
    // 卡片内宽度控制在 64 至 76 列之间，保持舒适比例
    const cardWidth = Math.max(50, Math.min(76, termWidth - 4));
    const innerWidth = cardWidth - 4; // 减去左右边框与 1 格内边距

    const BORDER = "\x1b[38;5;238m";
    const BRAND = "\x1b[1m\x1b[38;5;255m";
    const CYAN = "\x1b[38;5;39m";
    const GOLD = "\x1b[38;5;214m";
    const MUTED = "\x1b[38;5;244m";
    const TEXT = "\x1b[38;5;252m";
    const GREEN = "\x1b[32m";
    const ACCENT = "\x1b[1m\x1b[38;5;221m";
    const RESET = "\x1b[0m";

    const topBorder = `  ${BORDER}╭${"─".repeat(cardWidth - 2)}╮${RESET}`;
    const midBorder = `  ${BORDER}├${"─".repeat(cardWidth - 2)}┤${RESET}`;
    const botBorder = `  ${BORDER}╰${"─".repeat(cardWidth - 2)}╯${RESET}`;

    const makeLine = (content: string, visibleLen?: number): string => {
      const vLen = visibleLen ?? getVisibleWidth(content);
      const pad = Math.max(0, innerWidth - vLen);
      return `  ${BORDER}│${RESET} ${content}${" ".repeat(pad)} ${BORDER}│${RESET}`;
    };

    const lines: string[] = [];
    lines.push(""); // 顶部呼吸空行
    lines.push(topBorder);

    // 1. 品牌与定位标语
    const versionLabel = `v${options.version ?? resolvePackageVersion()}`;
    const titleText = `${CYAN}✦${RESET} ${BRAND}Nash Agent${RESET}  ${GOLD}${versionLabel}${RESET}`;
    const titleVisLen = getVisibleWidth(`✦ Nash Agent  ${versionLabel}`);
    lines.push(makeLine(titleText, titleVisLen));

    const subtitleText = `${MUTED}Distributed autonomous agent execution with native kernel sandbox${RESET}`;
    const subtitleVisLen = getVisibleWidth("Distributed autonomous agent execution with native kernel sandbox");
    lines.push(makeLine(subtitleText, subtitleVisLen));

    lines.push(midBorder);

    // 2. 环境与上下文矩阵
    const ctxWin = options.contextWindow ? `${Math.round(options.contextWindow / 1000)}k` : "64k";
    const modelStr = `${options.modelName} ${MUTED}(${ctxWin} context)${RESET}`;
    const modelVis = `${options.modelName} (${ctxWin} context)`;
    lines.push(makeLine(`${MUTED}Model      ${RESET}${TEXT}${modelStr}`, getVisibleWidth(`Model      ${modelVis}`)));

    // 路径适度压缩展示
    const displayRoot = options.projectRoot.replace(/^\/Users\/[^/]+/, "~");
    lines.push(makeLine(`${MUTED}Workspace  ${RESET}${TEXT}${displayRoot}${RESET}`, getVisibleWidth(`Workspace  ${displayRoot}`)));

    const sbMode = options.sandboxMode ?? "workspace-write";
    const sbStr = `${process.platform === "darwin" ? "macOS Seatbelt" : "Linux Bubblewrap"} · ${GREEN}${sbMode}${RESET} · ${MUTED}network: deny${RESET}`;
    const sbVis = `${process.platform === "darwin" ? "macOS Seatbelt" : "Linux Bubblewrap"} · ${sbMode} · network: deny`;
    lines.push(makeLine(`${MUTED}Sandbox    ${RESET}${TEXT}${sbStr}`, getVisibleWidth(`Sandbox    ${sbVis}`)));

    lines.push(midBorder);

    // 3. 快捷操作与功能向导
    lines.push(makeLine(`${MUTED}Quick Start:${RESET}`, getVisibleWidth("Quick Start:")));

    const tip1 = `${MUTED}•${RESET} ${TEXT}Type your prompt to inspect, edit, test or refactor code${RESET}`;
    lines.push(makeLine(tip1, getVisibleWidth("• Type your prompt to inspect, edit, test or refactor code")));

    const tip2 = `${MUTED}•${RESET} ${TEXT}Type ${ACCENT}!${RESET}${TEXT} to run direct shell commands (e.g. ${ACCENT}! git status${RESET}${TEXT})${RESET}`;
    lines.push(makeLine(tip2, getVisibleWidth("• Type ! to run direct shell commands (e.g. ! git status)")));

    const tip3 = `${MUTED}•${RESET} ${TEXT}Type ${ACCENT}/resume${RESET}${TEXT} to browse and switch historical sessions${RESET}`;
    lines.push(makeLine(tip3, getVisibleWidth("• Type /resume to browse and switch historical sessions")));

    const tip4 = `${MUTED}•${RESET} ${TEXT}Type ${ACCENT}/help${RESET}${TEXT} to inspect all available tools and commands${RESET}`;
    lines.push(makeLine(tip4, getVisibleWidth("• Type /help to inspect all available tools and commands")));

    lines.push(botBorder);
    lines.push(""); // 底部留白

    return lines;
  }
}
