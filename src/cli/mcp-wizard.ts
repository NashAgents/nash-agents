import readline from "node:readline";
import { MCPManager } from "../mcp/mcp-manager.js";
import type { MCPServerConfig, MCPConfigScope } from "../mcp/types.js";

/**
 * 在交互式 TTY 终端中展示单选菜单
 */
export async function promptSelect(
  title: string,
  options: Array<{ label: string; value: string }>
): Promise<string | null> {
  if (!process.stdin.isTTY) {
    return options[0]?.value ?? null;
  }

  return new Promise((resolve) => {
    let selectedIndex = 0;

    const render = () => {
      // 擦除旧输出
      readline.cursorTo(process.stdout, 0);
      readline.clearScreenDown(process.stdout);

      console.log(`\n\x1b[1m\x1b[36m${title}\x1b[0m`);
      console.log(`\x1b[90m(使用 ↑ / ↓ 键移动选择，Enter 确认，Esc 退出)\x1b[0m\n`);

      options.forEach((opt, idx) => {
        if (idx === selectedIndex) {
          console.log(`  \x1b[36m\x1b[1m> ${opt.label}\x1b[0m`);
        } else {
          console.log(`    \x1b[90m${opt.label}\x1b[0m`);
        }
      });
    };

    const cleanup = () => {
      process.stdin.removeListener("data", onData);
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false);
      }
      process.stdin.pause();
    };

    const onData = (chunk: Buffer) => {
      const key = chunk.toString();

      // Ctrl+C
      if (key === "\x03") {
        cleanup();
        resolve(null);
        return;
      }

      // Esc
      if (key === "\x1b") {
        cleanup();
        resolve(null);
        return;
      }

      // Enter
      if (key === "\r" || key === "\n") {
        cleanup();
        resolve(options[selectedIndex]!.value);
        return;
      }

      // Up arrow or 'k'
      if (key === "\x1b[A" || key === "k") {
        selectedIndex = (selectedIndex - 1 + options.length) % options.length;
        render();
        return;
      }

      // Down arrow or 'j'
      if (key === "\x1b[B" || key === "j") {
        selectedIndex = (selectedIndex + 1) % options.length;
        render();
        return;
      }
    };

    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", onData);
    render();
  });
}

/**
 * 终端行输入辅助
 */
export async function promptInput(promptText: string, defaultValue = ""): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    const display = defaultValue ? `${promptText} [${defaultValue}]: ` : `${promptText}: `;
    rl.question(display, (ans) => {
      rl.close();
      const val = ans.trim();
      resolve(val || defaultValue);
    });
  });
}

/**
 * 交互式 Nash MCP Manager 向导
 */
export async function runMcpInteractiveWizard(manager: MCPManager): Promise<number> {
  console.log(`\n\x1b[1m\x1b[36m=== Nash MCP Manager Interactive Wizard ===\x1b[0m`);

  const statuses = manager.listStatuses();
  const connectedCount = statuses.filter((s) => s.status === "connected").length;
  console.log(`已配置服务: ${statuses.length} 个 (活跃连接: ${connectedCount} 个)`);

  const choice = await promptSelect("请选择要执行的操作:", [
    { label: "1. Add MCP Server (交互式添加新服务)", value: "add" },
    { label: "2. View Servers & Status (查看服务与状态)", value: "list" },
    { label: "3. Run MCP Doctor (执行系统健康体检诊断)", value: "doctor" },
    { label: "4. Trust Current Project MCP (批准当前项目 MCP)", value: "trust" },
    { label: "5. Reconnect All (重新连接所有服务)", value: "reconnect" },
    { label: "6. Exit (退出向导)", value: "exit" },
  ]);

  if (!choice || choice === "exit") {
    console.log("\n已退出 MCP 向导。");
    return 0;
  }

  if (choice === "list") {
    // 列出服务
    const all = manager.listStatuses();
    if (all.length === 0) {
      console.log("\n当前未注册任何 MCP 服务。\n");
      return 0;
    }
    console.log(`\n\x1b[1m已配置的服务列表:\x1b[0m`);
    for (const s of all) {
      console.log(`  ● \x1b[1m${s.name}\x1b[0m [${s.transport}] - 状态: ${s.status}, 工具: ${s.toolCount}`);
    }
    console.log("");
    return 0;
  }

  if (choice === "trust") {
    manager.configManager.trustCurrentProject();
    console.log("\n\x1b[32m✓ 已成功信任当前项目的 MCP 配置！\x1b[0m\n");
    return 0;
  }

  if (choice === "reconnect") {
    console.log("\n正在重新连接所有 MCP 服务...");
    await manager.reload();
    console.log("\x1b[32m✓ 重新连接完成！\x1b[0m\n");
    return 0;
  }

  if (choice === "add") {
    const typeChoice = await promptSelect("请选择 MCP 传输协议类型:", [
      { label: "Streamable HTTP (推荐，远程 HTTPS 端点)", value: "streamable-http" },
      { label: "stdio (本地子进程隔离执行，如 node, python, npx)", value: "stdio" },
      { label: "SSE (Server-Sent Events 兼容老端点)", value: "sse" },
    ]);

    if (!typeChoice) return 0;

    const name = await promptInput("请输入服务唯一标识名称 (例如: bilibili-subtitles)");
    if (!name) {
      console.error("\x1b[31m必须提供有效的服务名称\x1b[0m");
      return 1;
    }

    const scopeChoice = (await promptSelect("请选择保存作用域:", [
      { label: "user (全局当前用户所有项目可用，推荐)", value: "user" },
      { label: "project (.mcp.json，可提交至 Git 供团队共享)", value: "project" },
      { label: "local (当前项目专属且私有，不入 Git)", value: "local" },
    ])) as MCPConfigScope;

    const config: MCPServerConfig = {
      name,
      transport: typeChoice as any,
      enabled: true,
    };

    if (typeChoice === "streamable-http" || typeChoice === "sse") {
      const url = await promptInput("请输入远程服务端点 URL (例如: https://mcp.example.com/mcp)");
      config.url = url;

      const authChoice = await promptSelect("该服务是否需要身份凭证鉴权？", [
        { label: "不需要鉴权 (No Auth)", value: "none" },
        { label: "Bearer Token (输入 Token，将安全存入本地凭证库)", value: "bearer" },
        { label: "环境变量引用 (例如: ${BILIBILI_MCP_TOKEN})", value: "env" },
      ]);

      if (authChoice === "bearer") {
        const token = await promptInput("请输入 Bearer Token 字符串");
        manager.credentialStore.setBearerToken(name, token);
        config.headers = { Authorization: `Bearer ${token}` };
      } else if (authChoice === "env") {
        const envVar = await promptInput("请输入环境变量名称", "BILIBILI_MCP_TOKEN");
        config.headers = { Authorization: `Bearer \${${envVar}}` };
      }
    } else {
      const cmd = await promptInput("请输入可执行程序命令 (例如: node, npx, python)", "node");
      const argsStr = await promptInput("请输入命令行参数 (空格分隔，例如: ./server.js)");
      config.command = cmd;
      config.args = argsStr ? argsStr.split(/\s+/).filter(Boolean) : [];
    }

    console.log(`\n正在保存并连接服务 '${name}'...`);
    try {
      await manager.addServer(name, config, scopeChoice || "user");
      const status = manager.getStatus(name);
      console.log(`\x1b[32m✓ 服务 '${name}' 注册成功！\x1b[0m`);
      console.log(`  状态: ${status?.status}, 工具数: ${status?.toolCount}`);
      console.log(`  作用域: ${scopeChoice}\n`);
      return 0;
    } catch (err: unknown) {
      console.error(`\x1b[31m✖ 添加服务失败:\x1b[0m`, err instanceof Error ? err.message : String(err));
      return 1;
    }
  }

  return 0;
}
