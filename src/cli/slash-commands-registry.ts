/**
 * Nash Agent Slash Commands 注册表与自动补全引擎
 * 命令提示体系：支持 / 触发提示、实时前缀过滤、Ghost Text 幽灵文本与 Tab 键自动补全。
 */

export interface SlashCommandDef {
  name: string;
  description: string;
  usage?: string;
  aliases?: string[];
  subcommands?: Array<{
    name: string;
    description: string;
  }>;
}

export const SLASH_COMMANDS: SlashCommandDef[] = [
  {
    name: "/mcp",
    description: "Manage Model Context Protocol (MCP) servers and tools",
    usage: "/mcp [list|test|tools|enable|disable|reconnect|doctor|trust|login|logout|remove]",
    subcommands: [
      { name: "list", description: "List all configured MCP servers and status" },
      { name: "test <name>", description: "Test handshake, latency and tools for an MCP server" },
      { name: "tools [name]", description: "List discovered tools from MCP servers" },
      { name: "enable <name>", description: "Enable and connect an MCP server" },
      { name: "disable <name>", description: "Disable an MCP server" },
      { name: "reconnect <name>", description: "Reconnect to an MCP server" },
      { name: "doctor", description: "Run comprehensive MCP health diagnostic check" },
      { name: "trust", description: "Approve and trust current project's .mcp.json" },
      { name: "login <name>", description: "Authenticate with an OAuth-enabled MCP server" },
      { name: "logout <name>", description: "Clear credentials for an MCP server" },
      { name: "remove <name>", description: "Remove an MCP server configuration" },
    ],
  },
  {
    name: "/prompt",
    description: "Inspect and trigger MCP prompt templates (/server:prompt)",
    usage: "/prompt [server] [prompt-name] [key=value...]",
  },
  {
    name: "/skills",
    description: "List and manage available skills (project & global)",
    usage: "/skills [show <name>]",
    aliases: ["/skill"],
    subcommands: [
      { name: "show <name>", description: "Inspect full procedure and verification for a skill" },
    ],
  },
  {
    name: "/status",
    description: "Show comprehensive status (Project, Model, Security, Runtime, Jobs)",
    usage: "/status",
  },
  {
    name: "/stats",
    description: "Run and per-agent metrics",
    usage: "/stats",
  },
  {
    name: "/diff",
    description: "Review local git changes and diff summary",
    usage: "/diff",
  },
  {
    name: "/tasks",
    description: "Plan execution and task graph",
    usage: "/tasks",
  },
  {
    name: "/agents",
    description: "Agent tree, including subagents and team members",
    usage: "/agents",
  },
  {
    name: "/agent",
    description: "Agent status and metrics",
    usage: "/agent <name/id>",
  },
  {
    name: "/jobs",
    description: "List all background jobs and status",
    usage: "/jobs",
  },
  {
    name: "/job",
    description: "Show details and output tail for a specific job",
    usage: "/job <id>",
  },
  {
    name: "/copy",
    description: "Copy latest assistant response to clipboard",
    usage: "/copy",
  },
  {
    name: "/resume",
    description: "List and choose a previous session to resume",
    usage: "/resume [index|id]",
  },
  {
    name: "/session",
    description: "Show information about the current session",
    usage: "/session",
    aliases: ["/sessions"],
  },
  {
    name: "/new",
    description: "Start a brand new session",
    usage: "/new",
  },
  {
    name: "/compact",
    description: "Manually trigger context compaction",
    usage: "/compact",
  },
  {
    name: "/memory",
    description: "View active memory summary",
    usage: "/memory [project|global|search|forget]",
    subcommands: [
      { name: "search <query>", description: "Search stored memories" },
      { name: "forget <id>", description: "Deprecate/remove a specific memory record" },
      { name: "project", description: "View project-scoped memories" },
      { name: "global", description: "View global-scoped memories" },
    ],
  },
  {
    name: "/remember",
    description: "Explicitly remember a fact or user preference",
    usage: "/remember <fact>",
  },
  {
    name: "/context",
    description: "Audit active context hierarchy and budgets",
    usage: "/context",
  },
  {
    name: "/help",
    description: "Show help message with available commands",
    usage: "/help",
  },
  {
    name: "/exit",
    description: "Exit the Nash Agents CLI",
    usage: "/exit",
    aliases: ["/quit"],
  },
];

export interface SuggestionMatch {
  name: string;
  description: string;
  highlightPrefix: string;
  isAlias?: boolean;
}

export interface SlashSuggestionsResult {
  matches: SuggestionMatch[];
  ghostText?: string;
  bestCompletion?: string;
  totalMatches: number;
}

/**
 * 根据用户输入的草稿计算匹配的 Slash 命令及 Ghost Text 补全提示
 */
export function getSlashCommandSuggestions(
  draft: string,
  maxDisplay = 5
): SlashSuggestionsResult | null {
  if (!draft.startsWith("/")) {
    return null;
  }

  const trimmed = draft.trimStart();
  const parts = trimmed.split(/\s+/);
  const cmdPart = parts[0]!.toLowerCase();

  // 如果已经输入了命令并跟了参数 (例如 "/skills show" 或 "/skills ")
  if (parts.length > 1) {
    const parentCmd = SLASH_COMMANDS.find(
      (c) => c.name.toLowerCase() === cmdPart || c.aliases?.some((a) => a.toLowerCase() === cmdPart)
    );
    if (parentCmd && parentCmd.subcommands && parentCmd.subcommands.length > 0) {
      const subPrefix = parts.slice(1).join(" ").toLowerCase();
      const matchedSubs = parentCmd.subcommands.filter((s) =>
        s.name.toLowerCase().startsWith(subPrefix)
      );
      if (matchedSubs.length > 0) {
        const topSub = matchedSubs[0]!;
        const remainingGhost = topSub.name.slice(subPrefix.length);
        return {
          matches: matchedSubs.slice(0, maxDisplay).map((s) => ({
            name: `${parentCmd.name} ${s.name}`,
            description: s.description,
            highlightPrefix: `${parentCmd.name} ${subPrefix}`,
          })),
          ghostText: remainingGhost.length > 0 ? remainingGhost : undefined,
          bestCompletion: `${parentCmd.name} ${topSub.name.split(" ")[0]} `,
          totalMatches: matchedSubs.length,
        };
      }
    }
    return null;
  }

  // 命令名称前缀匹配
  const matches: SuggestionMatch[] = [];

  for (const cmd of SLASH_COMMANDS) {
    if (cmd.name.toLowerCase().startsWith(cmdPart)) {
      matches.push({
        name: cmd.name,
        description: cmd.description,
        highlightPrefix: cmdPart,
      });
    } else if (cmd.aliases) {
      for (const alias of cmd.aliases) {
        if (alias.toLowerCase().startsWith(cmdPart)) {
          matches.push({
            name: cmd.name,
            description: `${cmd.description} (alias: ${alias})`,
            highlightPrefix: cmdPart,
            isAlias: true,
          });
          break;
        }
      }
    }
  }

  if (matches.length === 0) {
    return null;
  }

  // 优先级排序：以精准前缀或更常用命令排在前面
  matches.sort((a, b) => {
    // 主命令优先于别名
    if (a.isAlias && !b.isAlias) return 1;
    if (!a.isAlias && b.isAlias) return -1;
    return a.name.localeCompare(b.name);
  });

  // 计算行内 Ghost Text
  let ghostText: string | undefined;
  let bestCompletion: string | undefined;

  const top = matches[0]!;
  if (top.name.toLowerCase().startsWith(cmdPart)) {
    const suffix = top.name.slice(cmdPart.length);
    if (suffix.length > 0) {
      ghostText = suffix;
    }
    bestCompletion = `${top.name} `;
  }

  return {
    matches: matches.slice(0, maxDisplay),
    ghostText,
    bestCompletion,
    totalMatches: matches.length,
  };
}

/**
 * 执行 Slash 命令的 Tab 补全：若有匹配项，返回补全后的字符串，否则返回原始 draft
 */
export function completeSlashCommand(draft: string): string {
  const suggestions = getSlashCommandSuggestions(draft);
  if (!suggestions || !suggestions.bestCompletion) {
    return draft;
  }
  return suggestions.bestCompletion;
}
