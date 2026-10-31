import type { RunLearningInput, DistilledMemoryItem } from "./types.js";

const GREETING_PATTERN = /^(?:你好|您好|hi|hello|hey|nash|开始|继续|ok|好的|test|测试|在吗|在不在)[!！?.。\s]*$/i;
const SPECULATIVE_PATTERN = /(?:可能|似乎|也许|大概|不确定|猜测|貌似|maybe|perhaps|probably)/i;
const TEMP_PATTERN = /(?:pid:\s*\d+|port:\s*\d+|localhost:\d+|http:\/\/\S+|127\.0\.0\.1|进度\s*\d+%)/i;

/**
 * 结构化知识提炼器
 */
export class MemoryDistiller {
  /**
   * 分析单次 Run 上下文，提炼值得长期记住的事实与经验
   */
  distill(input: RunLearningInput): DistilledMemoryItem[] {
    const rawInput = (input.userInput || "").trim();
    if (!rawInput || GREETING_PATTERN.test(rawInput)) {
      return [];
    }

    // Run 失败时，不提炼成功经验
    if (input.isError) {
      return [];
    }

    const items: DistilledMemoryItem[] = [];

    // 1. 用户显式记忆指令 (User Explicit: "记住..." / "沉淀记忆..." / "以后称呼我为..." / "人设...")
    let extractedContent: string | null = null;
    const explicitPrefixMatch = rawInput.match(
      /(?:(?:请|帮我|务必|必须)?(?:沉淀(?:一下)?(?:记忆|偏好)?|记住|牢记|记一下|remember|记录|保存|存一下))\s*[:：,，\s]?\s*(.+)$/i
    );

    if (explicitPrefixMatch && explicitPrefixMatch[1]) {
      extractedContent = explicitPrefixMatch[1].trim();
    } else {
      const personaMatch = rawInput.match(
        /^(?:以后)?(?:请|务必)?(?:叫我|称呼我为?|你是|设定|人设为?)\s*[:：,，\s]?\s*(.+)$/i
      );
      if (personaMatch && personaMatch[1]) {
        extractedContent = rawInput.trim();
      }
    }

    if (extractedContent) {
      const content = extractedContent.trim();
      if (content.length >= 3 && !SPECULATIVE_PATTERN.test(content)) {
        items.push({
          content,
          kind: this.inferKind(content),
          source: "user-explicit",
          confidence: 1.0,
          tags: this.inferTags(content),
          evidence: [
            {
              sessionId: input.sessionId,
              runId: input.runId,
              summary: "User explicit instruction",
            },
          ],
        });
      }
    }

    // 2. 用户纠正指令 (User Correction: "不对，是..." / "不是X，而是Y" / "不对，这个项目应该使用 pnpm")
    const correctionMatch = rawInput.match(
      /(?:不对|错了|不是|不要|别|修正|纠正)[，,;；\s]+(.+)$/i
    );
    if (correctionMatch && correctionMatch[1]) {
      const content = correctionMatch[1].trim();
      if (content.length >= 3 && !SPECULATIVE_PATTERN.test(content)) {
        items.push({
          content,
          kind: this.inferKind(content),
          source: "user-correction",
          confidence: 0.95,
          tags: this.inferTags(content),
          evidence: [
            {
              sessionId: input.sessionId,
              runId: input.runId,
              summary: "User correction",
            },
          ],
        });
      }
    }

    // 3. 测试通过与回归修复验证经验 (Test Red -> Green)
    if (input.testResults && input.testResults.redToGreen && input.testResults.passed) {
      items.push({
        content: `Verified regression test passing for: ${input.testResults.command}`,
        kind: "lesson",
        source: "verified-runtime",
        confidence: 0.9,
        evidence: [
          {
            sessionId: input.sessionId,
            runId: input.runId,
            toolName: "bash",
            summary: `Test command '${input.testResults.command}' succeeded`,
          },
        ],
      });
    }

    // 4. 过滤明显包含临时数据、猜测词的条目
    return items.filter((item) => {
      if (SPECULATIVE_PATTERN.test(item.content)) return false;
      if (TEMP_PATTERN.test(item.content)) return false;
      return true;
    });
  }

  private inferKind(text: string): DistilledMemoryItem["kind"] {
    const low = text.toLowerCase();
    if (low.includes("架构") || low.includes("设计") || low.includes("模块") || low.includes("backend") || low.includes("sandbox") || low.includes("architecture")) {
      return "architecture";
    }
    if (low.includes("node") || low.includes("npm") || low.includes("pnpm") || low.includes("python") || low.includes("version") || low.includes("环境") || low.includes("版本") || low.includes("environment")) {
      return "environment";
    }
    if (
      low.includes("偏好") ||
      low.includes("习惯") ||
      low.includes("喜欢") ||
      low.includes("称呼") ||
      low.includes("叫我") ||
      low.includes("哥哥") ||
      low.includes("人设") ||
      low.includes("角色") ||
      low.includes("语气") ||
      low.includes("女高中生") ||
      low.includes("妹妹") ||
      low.includes("preference")
    ) {
      return "preference";
    }
    if (low.includes("bug") || low.includes("排查") || low.includes("教训") || low.includes("lesson")) {
      return "lesson";
    }
    if (low.includes("决定") || low.includes("采用") || low.includes("decision")) {
      return "decision";
    }
    return "fact";
  }

  private inferTags(text: string): string[] {
    const low = text.toLowerCase();
    const tags: string[] = [];
    if (low.includes("pnpm") || low.includes("npm") || low.includes("yarn") || low.includes("bun")) {
      tags.push("package-manager", "npm", "pnpm", "dependencies");
    }
    if (low.includes("node") || low.includes("nodejs")) {
      tags.push("node", "runtime", "version");
    }
    if (low.includes("sandbox") || low.includes("bubblewrap") || low.includes("landlock") || low.includes("seatbelt")) {
      tags.push("sandbox", "security", "backend");
    }
    if (
      low.includes("称呼") ||
      low.includes("叫我") ||
      low.includes("哥哥") ||
      low.includes("人设") ||
      low.includes("女高中生") ||
      low.includes("妹妹")
    ) {
      tags.push("persona", "user-preference", "invariant");
    }
    return tags;
  }
}
