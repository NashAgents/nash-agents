/**
 * Routing Session Manager
 * 维护多轮任务路由上下文、用户澄清历史及决策迭代版本
 */

import * as crypto from "node:crypto";
import type {
  RoutingSessionRecord,
  TaskIntent,
  RoutingDecision,
} from "./types.js";

export class RoutingSessionManager {
  private readonly sessions = new Map<string, RoutingSessionRecord>();

  /**
   * 创建新的路由会话
   */
  createSession(initialRequest: string, intent: TaskIntent): RoutingSessionRecord {
    const sessionId = `rsess-${crypto.randomUUID().slice(0, 10)}`;
    const now = Date.now();

    const record: RoutingSessionRecord = {
      sessionId,
      initialRequest,
      currentIntent: intent,
      decisionHistory: [],
      clarificationHistory: [],
      status: "analyzing",
      createdAt: now,
      updatedAt: now,
    };

    this.sessions.set(sessionId, record);
    return record;
  }

  /**
   * 获取会话
   */
  getSession(sessionId: string): RoutingSessionRecord | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * 记录生成的路由决策
   */
  recordDecision(sessionId: string, decision: RoutingDecision): RoutingSessionRecord | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;

    session.currentDecision = decision;
    session.decisionHistory.push(decision);
    session.status = decision.decisionType === "CLARIFICATION_REQUIRED" ? "clarifying" : "decided";
    session.updatedAt = Date.now();

    return session;
  }

  /**
   * 处理用户多轮澄清输入并更新意图约束
   */
  handleClarification(
    sessionId: string,
    userClarification: string
  ): { session: RoutingSessionRecord; updatedIntent: TaskIntent } {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Routing session '${sessionId}' not found`);
    }

    const currentDecision = session.currentDecision;
    const input = userClarification.trim().toLowerCase();

    // 记录澄清历史
    session.clarificationHistory.push({
      prompt: currentDecision?.clarificationPrompt ?? "请选择目标：",
      userResponse: userClarification,
      timestamp: Date.now(),
    });

    const updatedIntent: TaskIntent = {
      ...session.currentIntent,
      constraints: { ...session.currentIntent.constraints },
    };

    // 1. 检查是否匹配 clarificationOptions (如 "1", "opt-1", 或项目名)
    if (currentDecision?.clarificationOptions) {
      let matchedOption = input ? currentDecision.clarificationOptions.find(opt => opt.optionId.toLowerCase() === input) : undefined;
      if (!matchedOption) {
        const numeric = input.match(/^(?:#|第)?([1-9]\d*)(?:项|个)?$/);
        if (numeric) matchedOption = currentDecision.clarificationOptions[Number(numeric[1]) - 1];
      }
      if (!matchedOption && input) {
        const matches = currentDecision.clarificationOptions.filter(opt =>
          [opt.nodeId, opt.projectId, opt.label, opt.description].some(value => value.toLowerCase().includes(input))
        );
        if (matches.length === 1) matchedOption = matches[0];
      }

      if (matchedOption) {
        updatedIntent.constraints.explicitNodeId = matchedOption.nodeId;
        updatedIntent.constraints.explicitProjectId = matchedOption.projectId;
      }
    }

    // 2. 检查补充只读或限制指令
    if (input.includes("只读") || input.includes("不要修改") || input.includes("禁止改动")) {
      updatedIntent.constraints.readOnly = true;
    }

    session.currentIntent = updatedIntent;
    session.status = "analyzing";
    session.updatedAt = Date.now();

    return { session, updatedIntent };
  }

  /**
   * 关联派发后的任务
   */
  bindTask(sessionId: string, taskId: string, runId?: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.associatedTaskId = taskId;
      session.associatedRunId = runId;
      session.status = "dispatched";
      session.updatedAt = Date.now();
    }
  }
}
