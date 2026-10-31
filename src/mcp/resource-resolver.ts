import type { MCPManager } from "./mcp-manager.js";

const RESOURCE_REF_REGEX = /@([a-zA-Z0-9_-]+):([a-zA-Z0-9_.\-/:~%]+)/g;

/**
 * 解析用户消息中包含的 MCP Resource 引用 (@server:uri)
 * @ 资源引用能力
 */
export async function resolveUserMessageMcpResources(
  input: string,
  mcpManager?: MCPManager
): Promise<{ resolvedInput: string; attachedResources: Array<{ server: string; uri: string; content: string }> }> {
  if (!mcpManager || !input.includes("@")) {
    return { resolvedInput: input, attachedResources: [] };
  }

  const attachedResources: Array<{ server: string; uri: string; content: string }> = [];
  const matches = Array.from(input.matchAll(RESOURCE_REF_REGEX));

  for (const match of matches) {
    const fullTag = match[0]!;
    const serverName = match[1]!;
    const uri = match[2]!;

    try {
      const status = mcpManager.getStatus(serverName);
      if (status && status.status === "connected") {
        const res = (await mcpManager.connectionManager.readResource(serverName, uri)) as any;
        const contents = res?.contents ?? [];
        const contentStr = contents
          .map((c: any) => c.text ?? (c.blob ? `[Binary blob: ${c.mimeType || "application/octet-stream"}]` : ""))
          .join("\n");

        if (contentStr) {
          attachedResources.push({
            server: serverName,
            uri,
            content: contentStr,
          });
        }
      }
    } catch {
      // 容错：读取资源失败时不破坏用户原始输入
    }
  }

  if (attachedResources.length === 0) {
    return { resolvedInput: input, attachedResources: [] };
  }

  const resourceBlocks = attachedResources
    .map(
      (r) =>
        `\n\n<mcp-resource server="${r.server}" uri="${r.uri}">\n${r.content}\n</mcp-resource>`
    )
    .join("");

  return {
    resolvedInput: `${input}${resourceBlocks}`,
    attachedResources,
  };
}
