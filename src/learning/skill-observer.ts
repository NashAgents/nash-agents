import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import type { SkillObservation } from "../skills/types.js";
import type { RunLearningInput } from "./types.js";
import type { CreateSkillInput } from "../skills/skill-writer.js";

export interface SkillObserverOptions {
  storageDir: string;
}

/**
 * Skill 工作流观察与候选生成器 (Skill 自动生成必须保守)
 */
export class SkillObserver {
  private readonly observationsPath: string;

  constructor(options: SkillObserverOptions) {
    this.observationsPath = path.join(options.storageDir, ".observations.jsonl");
  }

  private async loadObservations(): Promise<SkillObservation[]> {
    if (!fsSync.existsSync(this.observationsPath)) {
      return [];
    }
    try {
      const raw = await fs.readFile(this.observationsPath, "utf-8");
      const lines = raw.split("\n").filter((l) => l.trim().length > 0);
      const list: SkillObservation[] = [];
      for (const line of lines) {
        try {
          list.push(JSON.parse(line));
        } catch {}
      }
      return list;
    } catch {
      return [];
    }
  }

  private async saveObservations(observations: SkillObservation[]): Promise<void> {
    const dir = path.dirname(this.observationsPath);
    if (!fsSync.existsSync(dir)) {
      await fs.mkdir(dir, { recursive: true });
    }
    const lines = observations.map((o) => JSON.stringify(o)).join("\n") + "\n";
    await fs.writeFile(this.observationsPath, lines, "utf-8");
  }

  /**
   * 检查用户是否显式要求保存 Skill
   * 例如："把刚才这个流程保存成 skill，叫 security-regression-fix"
   * 或："save this workflow as skill 'linux-sandbox-audit'"
   */
  detectExplicitSkillRequest(input: RunLearningInput): CreateSkillInput | null {
    const raw = (input.userInput || "").trim();
    const match = raw.match(
      /(?:保存成|保存为|创建|save\s+(?:this\s+)?as)\s+(?:skill|技能)\s*[:：,，]?\s*(?:叫|名为|name)?\s*["'‘“]?([a-z0-9-_]+)["'’”]?/i
    );

    if (!match || !match[1]) {
      return null;
    }

    const skillName = match[1].toLowerCase().trim();

    // 提炼执行步骤
    const steps: string[] = [];
    if (input.toolCalls && input.toolCalls.length > 0) {
      for (let i = 0; i < input.toolCalls.length; i++) {
        const tc = input.toolCalls[i];
        if (tc.name === "bash") {
          const cmd = typeof tc.args === "object" && tc.args !== null ? (tc.args as any).command : String(tc.args);
          steps.push(`${i + 1}. Execute bash command: \`${cmd}\``);
        } else if (tc.name === "edit_file" || tc.name === "write_file") {
          const filePath = typeof tc.args === "object" && tc.args !== null ? (tc.args as any).path : "target file";
          steps.push(`${i + 1}. Update file: \`${filePath}\``);
        } else if (tc.name === "read_file") {
          const filePath = typeof tc.args === "object" && tc.args !== null ? (tc.args as any).path : "target file";
          steps.push(`${i + 1}. Inspect and verify file: \`${filePath}\``);
        }
      }
    }

    const procedure = steps.length > 0
      ? steps.join("\n")
      : "1. Reproduce and identify the core invariants.\n2. Apply the verified fix.\n3. Run regression tests.";

    const verification = input.testResults
      ? `Run test verification command: \`${input.testResults.command}\``
      : "Execute relevant test suite or verification commands to ensure no regression.";

    return {
      name: skillName,
      description: `Workflow procedure for ${skillName} created per user explicit request.`,
      whenToUse: `When performing tasks related to ${skillName}.`,
      procedure,
      verification,
    };
  }

  /**
   * 记录一次工作流观察，并在满足严格晋升条件 (重复成功 >= 3次) 时返回晋升候选
   */
  async recordObservation(input: RunLearningInput): Promise<CreateSkillInput | null> {
    if (input.isError || !input.toolCalls || input.toolCalls.length < 3) {
      return null;
    }

    // 生成工作流工具签名
    const signature = input.toolCalls.map((tc) => tc.name).join("->");
    const observations = await this.loadObservations();

    let obs = observations.find((o) => o.workflowSignature === signature);
    const now = new Date().toISOString();

    if (!obs) {
      obs = {
        id: `obs-${crypto.randomBytes(4).toString("hex")}`,
        name: `workflow-${input.toolCalls[0].name}`,
        workflowSignature: signature,
        successCount: 1,
        failureCount: 0,
        lastUsedAt: now,
        createdAt: now,
        evidenceSessionId: input.sessionId,
      };
      observations.push(obs);
    } else {
      obs.successCount += 1;
      obs.lastUsedAt = now;
    }

    await this.saveObservations(observations);

    // 仅当独立成功且重复验证至少 3 次且包含测试回归验证时，才产生自动候选
    if (obs.successCount >= 3 && input.testResults?.passed) {
      return {
        name: `verified-${obs.name}`,
        description: `Standardized procedure for multi-step workflow (${signature}).`,
        whenToUse: `When encountering repetitive tasks involving ${signature}.`,
        procedure: "1. Inspect state\n2. Perform modifications\n3. Execute regression tests.",
        verification: `Verify with: \`${input.testResults.command}\``,
      };
    }

    return null;
  }
}
