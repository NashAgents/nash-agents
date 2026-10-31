import type { MemoryEntry, MemoryEvidence } from "../memory/types.js";
import type { SkillMetadata } from "../skills/types.js";

/**
 * Run 结束时的学习上下文输入
 */
export interface RunLearningInput {
  sessionId: string;
  runId?: string;
  userInput: string;
  response?: string;
  toolCalls?: Array<{
    name: string;
    args: Record<string, unknown> | string;
    result?: string;
    success?: boolean;
  }>;
  verifiedFiles?: string[];
  testResults?: {
    command: string;
    passed: boolean;
    redToGreen?: boolean;
  };
  isError?: boolean;
  metadata?: Record<string, unknown>;
}

/**
 * Memory 提炼学习结果
 */
export interface DistilledMemoryItem {
  content: string;
  kind: MemoryEntry["kind"];
  source: MemoryEntry["source"];
  confidence: number;
  tags?: string[];
  evidence?: MemoryEvidence[];
  supersedes?: string[];
}

/**
 * Run 学习综合输出
 */
export interface RunLearningResult {
  memoriesLearned: MemoryEntry[];
  skillsObserved?: string[];
  skillsCreated?: SkillMetadata[];
  skippedReason?: string;
}
