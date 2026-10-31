import type { MCPConnectionStatus, MCPTransportType } from "./types.js";

/**
 * MCP 生命周期事件定义
 */
export interface MCPServerEventPayload {
  serverName: string;
  transport: MCPTransportType;
  status: MCPConnectionStatus;
  error?: string;
  toolCount?: number;
  timestamp: number;
}

export interface MCPToolsUpdatedEventPayload {
  serverName: string;
  toolCount: number;
  tools: string[];
  timestamp: number;
}

export type MCPEventType =
  | "mcp.server.connecting"
  | "mcp.server.connected"
  | "mcp.server.disconnected"
  | "mcp.server.reconnecting"
  | "mcp.server.failed"
  | "mcp.tools.updated";
