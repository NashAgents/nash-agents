import crypto from "node:crypto";
import { defineTool } from "../../tools/tool.js";
import type { WorkerEventForwarder } from "./event-forwarder.js";

/** Sender identity comes from the Worker dispatch, never from model arguments. */
export function createGraphMessageTool(identity: { nodeId: string; taskId: string; graphId: string }, forwarder: WorkerEventForwarder) {
  return defineTool({
    name: "send_agent_message",
    description: "向同一任务图中的其他 Worker 发送协作消息。需要明确的目标节点与任务 ID，消息通过持久事件队列可靠中继。",
    parameters: { type: "object", properties: {
      targetNodeId: { type: "string" }, targetTaskId: { type: "string" }, content: { type: "string" },
    }, required: ["targetNodeId", "targetTaskId", "content"] },
    async execute(args: { targetNodeId: string; targetTaskId: string; content: string }, context) {
      context?.signal?.throwIfAborted();
      if (!args.targetNodeId || !args.targetTaskId || typeof args.content !== "string") throw new Error("A2A requires an explicit recipient and content");
      if (Buffer.byteLength(args.content) > 64000) throw new Error("A2A message exceeds 64 KB");
      const messageId = `a2a-${crypto.randomUUID()}`;
      forwarder.emitEvent("agent.message_send", {
        ...identity, messageId, sourceNodeId: identity.nodeId, sourceTaskId: identity.taskId, sourceAgentId: "main",
        targetNodeId: args.targetNodeId, targetTaskId: args.targetTaskId, targetAgentId: "main",
        messageType: "agent.message", payload: { message: args.content }, sentAt: Date.now(), expiresAt: Date.now() + 300000,
      });
      return JSON.stringify({ messageId, deliveryStatus: "pending" });
    },
  });
}
