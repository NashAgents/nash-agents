import { defineTool, type Tool } from "../tool.js";
import { TaskError } from "../../task/errors.js";
import type { TaskManager } from "../../task/task-manager.js";
import type { SubAgentRuntime } from "../../agent/subagent-runtime.js";
import type { AgentRegistry } from "../../agent/agent-registry.js";
import type { TeamRuntime } from "../../team/team-runtime.js";
import type { PlanMode } from "../../plan/plan-mode.js";
import {
  formatTaskCentricView,
  formatAgentCentricView,
  formatTeamView,
} from "../../projection/index.js";

export type AgentToolRole = "lead" | "subagent" | "member";

// ==========================================
// 1. Task Tools
// ==========================================

export function createTaskTools(options: {
  agentId?: string;
  taskManager: TaskManager;
  planMode?: PlanMode;
  role?: AgentToolRole;
}): Tool[] {
  const tm = options.taskManager;
  const pm = options.planMode;
  const role = options.role ?? "lead";
  const isLead = role === "lead";
  const actor = () => {
    if (!isLead && !options.agentId) throw new TaskError("TASK_ACTOR_REQUIRED", "运行时未绑定任务调用者");
    return { agentId: options.agentId ?? "main", isLead };
  };

  const tools: Tool[] = [];

  // Lead 专有：创建与更新任务
  if (isLead) {
    tools.push(
      defineTool({
        name: "create_task",
        description:
          "在任务图中创建一个新的全局任务 (Task)。可指定依赖前置任务 (dependencies) 与预期写入范围 (writeScopes)。",
        parameters: {
          type: "object",
          properties: {
            id: { type: "string", description: "可选的自定义任务 ID" },
            subject: { type: "string", description: "任务简要主题" },
            description: { type: "string", description: "任务详细要求与完成标准" },
            dependencies: {
              type: "array",
              items: { type: "string" },
              description: "前置依赖的任务 ID 列表，全部完成之后本任务才变为 ready",
            },
            writeScopes: {
              type: "array",
              items: { type: "string" },
              description: "该任务预期写入修改的文件路径/Glob 模式 (如 [\"src/auth/**\"])",
            },
            ownerAgentId: { type: "string", description: "指定初始拥有该任务的 Agent ID" },
          },
          required: ["subject"],
        },
        async execute(args: any): Promise<string> {
          if (pm && (pm.getState() === "exploring" || pm.getState() === "proposed" || pm.getState() === "awaiting_approval")) {
            return `当前处于 Plan Mode (${pm.getState()}) 状态，在方案获得用户批准前禁止直接创建 Active Task。请先调用 propose_plan 提交方案。`;
          }
          const task = tm.createTask({
            id: args.id,
            subject: args.subject,
            description: args.description,
            dependencies: args.dependencies,
            writeScopes: args.writeScopes,
            ownerAgentId: args.ownerAgentId,
          });
          return `成功创建任务 [${task.id}]: '${task.subject}' (当前状态: ${task.status})`;
        },
      })
    );

    tools.push(
      defineTool({
        name: "update_task",
        description: "更新指定任务的信息、依赖或所有者。",
        parameters: {
          type: "object",
          properties: {
            taskId: { type: "string", description: "任务 ID" },
            subject: { type: "string", description: "修改后的任务主题" },
            description: { type: "string", description: "修改后的详细描述" },
            dependencies: {
              type: "array",
              items: { type: "string" },
              description: "更新后的前置依赖 ID列表",
            },
            ownerAgentId: { type: "string", description: "新指定的 Agent ID" },
            writeScopes: {
              type: "array",
              items: { type: "string" },
              description: "更新后的文件写入范围",
            },
            expectedRevision: { type: "number", description: "乐观锁预期版本号 (CAS)" },
          },
          required: ["taskId"],
        },
        async execute(args: any): Promise<string> {
          if (pm && (pm.getState() === "exploring" || pm.getState() === "proposed" || pm.getState() === "awaiting_approval")) {
            return `当前处于 Plan Mode (${pm.getState()}) 状态，在方案获得用户批准前禁止修改任务。`;
          }
          const task = tm.updateTask(args.taskId, {
            subject: args.subject,
            description: args.description,
            dependencies: args.dependencies,
            ownerAgentId: args.ownerAgentId,
            writeScopes: args.writeScopes,
            expectedRevision: args.expectedRevision,
          });
          return `成功更新任务 [${task.id}] (最新版本: rev ${task.revision}, 状态: ${task.status})`;
        },
      })
    );

    tools.push(
      defineTool({
        name: "supersede_task",
        description: "将已过时或被新方案替代的任务标记为 superseded / 作废状态。",
        parameters: {
          type: "object",
          properties: {
            taskId: { type: "string", description: "待作废的任务 ID" },
            supersededByTaskId: { type: "string", description: "替代它的新任务 ID (若有)" },
            reason: { type: "string", description: "替代或作废原因" },
          },
          required: ["taskId"],
        },
        async execute(args: any): Promise<string> {
          const task = tm.supersedeTask(args.taskId, args.supersededByTaskId, args.reason);
          return `任务 [${task.id}] 已标记为 superseded (作废)。\n原因: ${task.supersededReason ?? "方案调整"}`;
        },
      })
    );
  }

  // 所有角色（Lead, SubAgent, Member）共有：标记完成、标记阻塞、查看列表
  tools.push(
    defineTool({
      name: "complete_task",
      description:
        "将任务标记为 completed 完成状态，记录交付产物并级联唤醒后续依赖该任务的后继任务。",
      parameters: {
        type: "object",
        properties: {
          taskId: { type: "string", description: "任务 ID" },
          summary: { type: "string", description: "完成情况总结" },
          artifacts: {
            type: "array",
            items: { type: "string" },
            description: "产出的文件路径或产物列表",
          },
        },
        required: ["taskId", "summary"],
      },
      async execute(args: any): Promise<string> {
        const task = tm.completeTask(
          args.taskId,
          {
            summary: args.summary,
            artifacts: args.artifacts,
          },
          actor()
        );
        return `任务 [${task.id}] 已标记为 COMPLETED。\n概要: ${args.summary}`;
      },
    })
  );

  tools.push(
    defineTool({
      name: "block_task",
      description: "将任务标记为 blocked 阻塞状态，注明阻塞原因与外部等待项。",
      parameters: {
        type: "object",
        properties: {
          taskId: { type: "string", description: "任务 ID" },
          reason: { type: "string", description: "阻塞原因" },
          blockedBy: {
            type: "array",
            items: { type: "string" },
            description: "阻塞来源或前置项",
          },
        },
        required: ["taskId", "reason"],
      },
      async execute(args: any): Promise<string> {
        const task = tm.blockTask(args.taskId, args.reason, args.blockedBy, actor());
        return `任务 [${task.id}] 已标记为 BLOCKED (原因: ${args.reason})`;
      },
    })
  );

  tools.push(
    defineTool({
      name: "list_tasks",
      description: "获取并格式化显示当前 TaskGraph 的任务中心状态视图 (Task-Centric View)。",
      parameters: {
        type: "object",
        properties: {
          goal: { type: "string", description: "可选的当前目标描述" },
        },
      },
      async execute(args: any): Promise<string> {
        return formatTaskCentricView(tm, { goal: args?.goal });
      },
    })
  );

  return tools;
}

// ==========================================
// 2. SubAgent Tools (Lead 与有限 SubAgent)
// ==========================================

export function createSubAgentTools(options: {
  subAgentRuntime: SubAgentRuntime;
  agentId?: string;
  agentRegistry: AgentRegistry;
  taskManager?: TaskManager;
  planMode?: PlanMode;
  role?: AgentToolRole;
}): Tool[] {
  const runtime = options.subAgentRuntime;
  const registry = options.agentRegistry;
  const tm = options.taskManager;
  const pm = options.planMode;
  const role = options.role ?? "lead";

  if (role === "member") {
    // 普通 TeamMember 不允许派生子 Agent
    return [];
  }

  const spawnAgentTool = defineTool({
    name: "spawn_agent",
    description:
      "派生并异步执行一个独立的子 Agent (SubAgent)，执行特定独立子任务并返回其结构化执行结果。",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "指派给子 Agent 的明确任务指令" },
        background: { type: "boolean", description: "独立任务设为 true 并立即返回 Agent ID，可连续派发后通过 wait_agent 汇总" },
        name: { type: "string", description: "子 Agent 易读名称 (如 'code-reviewer')" },
        role: { type: "string", description: "角色定位 (如 'backend', 'frontend')" },
        taskId: { type: "string", description: "关联的全局 Task ID (若有)" },
        parentAgentId: { type: "string", description: "父 Agent ID" },
        writeScopes: {
          type: "array",
          items: { type: "string" },
          description: "该子 Agent 允许修改的文件范围",
        },
      },
      required: ["prompt"],
    },
    async execute(args: any, context): Promise<string> {
      if (pm && (pm.getState() === "exploring" || pm.getState() === "proposed" || pm.getState() === "awaiting_approval")) {
        return `当前处于 Plan Mode (${pm.getState()}) 状态，在方案获得用户批准前禁止派生执行子 Agent。请先调用 propose_plan 提交方案。`;
      }
      const spawnOptions = {
        name: args.name, role: args.role, taskId: args.taskId,
        parentAgentId: options.agentId ?? args.parentAgentId, writeScopes: args.writeScopes, parentSignal: context?.signal,
      };
      if (args.background === true) {
        const agentId = runtime.spawnInBackground(args.prompt, spawnOptions);
        return `SubAgent [${agentId}] 已派发，使用 wait_agent 获取最终结果。`;
      }
      const res = await runtime.spawn(args.prompt, spawnOptions);

      if (!res.success) {
        return `SubAgent [${res.agentId}] 执行失败: ${res.error?.message}`;
      }
      return `SubAgent [${res.agentId}] 执行完成 (耗时 ${res.durationMs}ms):\n\n${res.output}`;
    },
  });

  const interruptAgentTool = defineTool({
    name: "interrupt_agent",
    description: "显式中断指定的运行中子 Agent。",
    parameters: {
      type: "object",
      properties: {
        agentId: { type: "string", description: "待中断的 Agent ID" },
        reason: { type: "string", description: "中断原因" },
      },
      required: ["agentId"],
    },
    async execute(args: any): Promise<string> {
      const ok = runtime.interrupt(args.agentId, args.reason);
      return ok
        ? `成功向 Agent '${args.agentId}' 发送中断信号。`
        : `未找到活跃的 Agent '${args.agentId}' 或其已不在运行中。`;
    },
  });

  const listAgentsTool = defineTool({
    name: "list_agents",
    description: "查看当前运行时所有 Agent 的执行树结构与当前状态 (Agent-Centric View)。",
    parameters: { type: "object", properties: {} },
    async execute(): Promise<string> {
      return formatAgentCentricView(registry, tm);
    },
  });

  return [spawnAgentTool, interruptAgentTool, listAgentsTool, defineTool({
    name: "wait_agent", description: "等待后台子代理结果，等待时让出并发槽位，超时返回 running。",
    parameters: { type: "object", properties: { agentId: { type: "string" }, timeoutMs: { type: "number" } }, required: ["agentId"] },
    async execute(args: any, context) {
      const result = await runtime.waitForAgent(args.agentId, args.timeoutMs, context?.signal, options.agentId);
      return result ? JSON.stringify({ ...result, error: result.error?.message }) : JSON.stringify({ agentId: args.agentId, status: "running" });
    },
  })];
}

// ==========================================
// 3. Team Tools (区分 Lead 与 Member)
// ==========================================

export function createTeamTools(options: {
  agentId?: string;
  teamRuntime: TeamRuntime;
  subAgentRuntime?: SubAgentRuntime;
  taskManager?: TaskManager;
  planMode?: PlanMode;
  role?: AgentToolRole;
}): Tool[] {
  const team = options.teamRuntime;
  const subAgentRuntime = options.subAgentRuntime;
  const tm = options.taskManager;
  const pm = options.planMode;
  const role = options.role ?? "lead";

  if (role === "subagent") {
    // 独立 SubAgent 默认不参与团队 Roster 与 Mailbox
    return [];
  }

  const isLead = role === "lead";
  const actorId = () => {
    if (!isLead && !options.agentId) throw new TaskError("TASK_ACTOR_REQUIRED", "运行时未绑定团队调用者");
    return options.agentId ?? team.leaderId;
  };
  const tools: Tool[] = [];

  if (isLead) {
    tools.push(
      defineTool({
        name: "spawn_teammate",
        description: "向团队中添加一个常驻专业成员 (TeamMember)。",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string", description: "成员名称 (如 'Backend Specialist')" },
            agentId: { type: "string", description: "可选的固定 Agent ID" },
            role: { type: "string", description: "专业领域 (如 'backend', 'frontend')" },
            roleDescription: { type: "string", description: "专业职责与边界描述" },
            writeScopes: {
              type: "array",
              items: { type: "string" },
              description: "负责的文件写范围",
            },
          },
          required: ["name", "role", "roleDescription"],
        },
        async execute(args: any): Promise<string> {
          if (pm && (pm.getState() === "exploring" || pm.getState() === "proposed" || pm.getState() === "awaiting_approval")) {
            return `当前处于 Plan Mode (${pm.getState()}) 状态，在方案获得用户批准前禁止添加团队执行成员。`;
          }
          const member = team.addMember({
            name: args.name,
            agentId: args.agentId,
            role: args.role,
            roleDescription: args.roleDescription,
            writeScopes: args.writeScopes,
          });
          return `成功添加团队成员: ${member.name} [ID: ${member.agentId}, Role: ${member.role}]`;
        },
      })
    );

    tools.push(
      defineTool({
        name: "assign_task",
        description: "Lead 将任务明确指派给指定的团队成员，并驱动该成员执行该任务。",
        parameters: {
          type: "object",
          properties: {
            taskId: { type: "string", description: "任务 ID" },
            agentId: { type: "string", description: "指派的目标 Agent ID" },
            prompt: { type: "string", description: "可选的附加执行指导或上下文说明" },
            background: { type: "boolean", description: "后台执行以允许多成员并发，使用 wait_agent 等待结果" },
            execute: {
              type: "boolean",
              description: "是否立即驱动该成员执行该任务 (默认为 true)",
            },
          },
          required: ["taskId", "agentId"],
        },
        async execute(args: any): Promise<string> {
          if (pm && (pm.getState() === "exploring" || pm.getState() === "proposed" || pm.getState() === "awaiting_approval")) {
            return `当前处于 Plan Mode (${pm.getState()}) 状态，在方案获得用户批准前禁止指派任务。`;
          }
          const task = team.assignTask(args.taskId, args.agentId);
          const member = team.roster.getMember(args.agentId);

          // 若提供 subAgentRuntime 且 execute 不为 false，真正拉起该成员执行任务
          const shouldExecute = args.execute !== false && subAgentRuntime && member;
          if (shouldExecute) {
            const taskObj = tm ? tm.getTask(args.taskId) : task;
            const taskSubject = taskObj?.subject ?? args.taskId;
            const taskDesc = taskObj?.description ?? "";
            const taskPrompt =
              `你已作为专业团队成员被指派执行任务 [${task.id}]: '${taskSubject}'。\n\n` +
              `【任务要求与完成标准】\n${taskDesc || "无额外说明"}\n\n` +
              `【你的角色定位】\n${member.name} (${member.role}): ${member.roleDescription}\n` +
              (args.prompt ? `\n【Lead 附加指导】\n${args.prompt}\n` : "") +
              `\n请以你专业的角色职责使用工具深入调研、分析或操作，并在结束时给出详细的结论与交付产物总结。`;

            const spawnOptions = {
              agentId: member.agentId,
              name: member.name,
              role: member.role,
              roleDescription: member.roleDescription,
              taskId: task.id,
              writeScopes: taskObj?.writeScopes,
            };
            if (args.background === true) {
              const agentId = subAgentRuntime.spawnInBackground(taskPrompt, spawnOptions);
              return `任务 [${task.id}] 已派发给 ${agentId}，使用 wait_agent 等待结果。`;
            }
            const res = await subAgentRuntime.spawn(taskPrompt, spawnOptions);

            if (!res.success) {
              return `任务 [${task.id}] 已分配给成员 '${member.name}' [ID: ${args.agentId}]，但执行遇到错误:\n${res.error?.message}`;
            }

            return `任务 [${task.id}] 已由团队成员 '${member.name}' [ID: ${args.agentId}] 执行完成 (耗时 ${res.durationMs}ms):\n\n${res.output}`;
          }

          return `任务 [${task.id}] 已分配给成员: ${args.agentId}`;
        },
      })
    );
  }

  // Lead 与 Member 均拥有认领、发送消息、等待变化、查看团队列表
  tools.push(
    defineTool({
      name: "claim_task",
      description: "认领一个当前处于 ready 状态的任务 (原子 CAS 抢占)。",
      parameters: {
        type: "object",
        properties: {
          taskId: { type: "string", description: "任务 ID" },
        },
        required: ["taskId"],
      },
      async execute(args: any): Promise<string> {
        if (pm && (pm.getState() === "exploring" || pm.getState() === "proposed" || pm.getState() === "awaiting_approval")) {
          return `当前处于 Plan Mode (${pm.getState()}) 状态，在方案获得用户批准前禁止认领执行任务。`;
        }
        const task = team.claimTask(args.taskId, actorId());
        return `Agent '${actorId()}' 成功认领任务 [${task.id}]: '${task.subject}'`;
      },
    })
  );

  tools.push(
    defineTool({
      name: "send_message",
      description: "向团队指定成员或广播发送点对点沟通消息 (在 Step Boundary 被接收方摄取)。",
      parameters: {
        type: "object",
        properties: {
          targetAgentId: { type: "string", description: "接收方 Agent ID，或 '*' 广播" },
          content: { type: "string", description: "沟通内容" },
        },
        required: ["targetAgentId", "content"],
      },
      async execute(args: any): Promise<string> {
        team.sendMessage(actorId(), args.targetAgentId, args.content);
        return `消息已发送至 '${args.targetAgentId}'。`;
      },
    })
  );

  tools.push(
    defineTool({
      name: "list_team",
      description: "查看当前团队成员名单、各自分配任务与未读沟通消息概况。",
      parameters: { type: "object", properties: {} },
      async execute(): Promise<string> {
        return formatTeamView(team);
      },
    })
  );

  tools.push(
    defineTool({
      name: "wait_for_change",
      description:
        "非轮询等待团队状态变化（当有新消息到达、前置任务完成或有新任务 Ready 时自动被事件总线唤醒）。",
      parameters: {
        type: "object",
        properties: {
          timeoutMs: { type: "number", description: "最大等待超时毫秒数，默认 30000" },
        },
      },
      async execute(args: any): Promise<string> {
        const res = await team.waitForChange(actorId(), {
          timeoutMs: args.timeoutMs,
        });
        return `Agent '${actorId()}' 已被唤醒 (唤醒原因: ${res.reason})`;
      },
    })
  );

  return tools;
}

// ==========================================
// 4. Plan Tools (仅 Lead 拥有)
// ==========================================

export function createPlanTools(options: {
  planMode: PlanMode;
  role?: AgentToolRole;
}): Tool[] {
  const pm = options.planMode;
  const role = options.role ?? "lead";

  if (role !== "lead") {
    return [];
  }

  const enterPlanModeTool = defineTool({
    name: "enter_plan_mode",
    description: "进入方案设计模式 (Plan Mode)。在执行大范围修改前先探索并制定方案。",
    parameters: {
      type: "object",
      properties: {
        goal: { type: "string", description: "方案设计目标" },
      },
      required: ["goal"],
    },
    async execute(args: any): Promise<string> {
      pm.enter(args.goal);
      return `已进入 Plan Mode。当前目标: '${args.goal}'。请使用只读探索工具调研，并随后调用 propose_plan 提交方案。`;
    },
  });

  const proposePlanTool = defineTool({
    name: "propose_plan",
    description: "提交设计好的方案提案供用户审批。待用户审批通过后方可转为实际 Task 执行。",
    parameters: {
      type: "object",
      properties: {
        summary: { type: "string", description: "方案总体设计与实现思路总结" },
        steps: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              subject: { type: "string" },
              description: { type: "string" },
              dependencies: { type: "array", items: { type: "string" } },
              writeScopes: { type: "array", items: { type: "string" } },
            },
            required: ["subject"],
          },
          description: "分解的步骤列表",
        },
        assumptions: { type: "array", items: { type: "string" } },
        risks: { type: "array", items: { type: "string" } },
      },
      required: ["summary", "steps"],
    },
    async execute(args: any): Promise<string> {
      const result = await pm.requestApproval({
        summary: args.summary,
        steps: args.steps,
        assumptions: args.assumptions,
        risks: args.risks,
      });

      if (result.approved) {
        return `方案已获得用户批准并已成功构建为运行时任务图！请立即调度并指派子 Agent 开始执行这些任务。`;
      } else if (result.revisionFeedback) {
        return `用户对方案提出了修改意见: "${result.revisionFeedback}"\n请根据用户反馈重新调研调整，并调用 propose_plan 重新提交修改后的方案。`;
      } else {
        return `用户已取消该方案提案。`;
      }
    },
  });

  return [enterPlanModeTool, proposePlanTool];
}
