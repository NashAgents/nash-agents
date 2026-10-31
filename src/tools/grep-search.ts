import { DeterministicFastPathEligibilityValidator } from "../security/fast-path-validator.js";
import { buildSandboxEnvironment } from "../sandbox/environment.js";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { type Tool, defineTool } from "./tool.js";
import { FileSystemAccess } from "../sandbox/filesystem-access.js";
import { createDefaultSandboxPolicy } from "../sandbox/policy.js";

/**
 * grep_search 工具入参接口
 */
export interface GrepSearchArgs {
  query: string;
  path?: string;
}

/**
 * 最大返回匹配项数量
 */
const MAX_MATCHES = 100;

function mayReturnSearchFile(file: string, root: string): boolean {
  try {
    return new DeterministicFastPathEligibilityValidator().validate({
      toolName: "read_file", toolArgs: { path: file }, rawArgs: "", argsFingerprint: "",
      cwd: root, agentIdentity: { agentId: "search-filter" }, userAuthorizationContext: {},
    }).isEligible;
  } catch { return false; }
}

/**
 * 当系统未安装 ripgrep 时优雅回退的原生 JS 遍历检索实现
 */
async function fallbackJsGrep(
  resolvedPath: string,
  relPath: string,
  query: string,
  workspaceRoot: string
): Promise<string> {
  const matches: string[] = [];
  const stat = await fs.stat(resolvedPath);

  const shouldIgnore = (p: string) => {
    const norm = p.replace(/\\/g, "/");
    return (
      norm.includes("/node_modules/") ||
      norm.endsWith("/node_modules") ||
      norm.includes("/dist/") ||
      norm.endsWith("/dist") ||
      norm.includes("/.git/") ||
      norm.endsWith("/.git")
    );
  };

  const searchFile = async (filePath: string) => {
    if (shouldIgnore(filePath) || !mayReturnSearchFile(filePath, stat.isDirectory() ? resolvedPath : path.dirname(resolvedPath))) return;
    try {
      const content = await fs.readFile(filePath, "utf-8");
      const lines = content.split(/\r?\n/);
      const relToWorkspace = path
        .relative(workspaceRoot, filePath)
        .replace(/\\/g, "/");
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes(query)) {
          matches.push(`${relToWorkspace}:${i + 1}:${lines[i]}`);
        }
      }
    } catch {}
  };

  const walkDir = async (dir: string) => {
    if (shouldIgnore(dir)) return;
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walkDir(full);
        } else if (entry.isFile()) {
          await searchFile(full);
        }
      }
    } catch {}
  };

  if (stat.isFile()) {
    await searchFile(resolvedPath);
  } else if (stat.isDirectory()) {
    await walkDir(resolvedPath);
  }

  if (matches.length === 0) {
    return `未在 '${relPath}' 中找到包含 '${query}' 的匹配项。`;
  }

  if (matches.length > MAX_MATCHES) {
    const truncated = matches.slice(0, MAX_MATCHES);
    truncated.push(
      `... [已达到最大匹配数量限制 (${MAX_MATCHES} 条)，更多结果请进一步缩小搜索范围]`
    );
    return truncated.join("\n");
  }

  return matches.join("\n");
}

function resolveRgExecutable(): string {
  if (process.env.PATH === "" || process.env.PATH === undefined) {
    return "rg";
  }
  if (process.platform === "win32") {
    const candidates = [
      ...(process.env.LOCALAPPDATA ? [path.join(process.env.LOCALAPPDATA, "Programs/Trae/resources/app/node_modules/@vscode/ripgrep/bin/rg.exe")] : []),
      "C:/Program Files/cursor/resources/app/extensions/node_modules/@vscode/ripgrep/bin/rg.exe",
    ];
    for (const c of candidates) {
      if (fsSync.existsSync(c)) return c;
    }
  }
  return "rg";
}

/**
 * 创建并配置 grep_search 工具实例（支持依赖注入）
 *
 * @param customFsAccess - 可选注入的 FileSystemAccess 实例
 */
export function createGrepSearchTool(
  customFsAccess?: FileSystemAccess
): Tool<GrepSearchArgs> {
  const getFsAccess = () =>
    customFsAccess ??
    new FileSystemAccess({
      policy: createDefaultSandboxPolicy(),
    });

  return defineTool({
    name: "grep_search",
    description:
      "在当前项目工作区内搜索文本内容（调用 ripgrep 进行高性能普通字符串匹配）。自动忽略 node_modules、dist、.git 和敏感凭据文件，返回 path:line:content。敏感文件需显式审查后使用 read_file 读取。",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "待搜索的目标文本字符串（固定普通字符串匹配）。",
        },
        path: {
          type: "string",
          description:
            "搜索起始文件或目录路径，支持相对路径或工作区内的绝对路径。默认为当前工作区根目录 '.'。",
        },
      },
      required: ["query"],
    },
    async execute(args: GrepSearchArgs): Promise<string> {
      if (!args || typeof args.query !== "string" || args.query === "") {
        throw new Error("缺少必填参数 'query' 或搜索关键词为空。");
      }

      const targetPathInput =
        typeof args.path === "string" && args.path.trim() !== ""
          ? args.path
          : ".";

      const fsAccess = getFsAccess();
      const resolvedPath = await fsAccess.resolveForRead(targetPathInput);
      const relPath = fsAccess.toRelativePath(resolvedPath);

      let stat;
      try {
        stat = await fs.stat(resolvedPath);
      } catch (err: unknown) {
        if (
          err &&
          typeof err === "object" &&
          "code" in err &&
          err.code === "ENOENT"
        ) {
          throw new Error(`搜索路径不存在: '${relPath}'。`);
        }
        throw err;
      }

      const rgArgs = [
        "--json",
        "--line-number",
        "--with-filename",
        "--fixed-strings",
        "--no-heading",
        "--color=never",
        "--glob=!node_modules/**",
        "--glob=!dist/**",
        "--glob=!.git/**",
        "-e",
        args.query,
        "--",
        resolvedPath,
      ];

      const rgExecutable = resolveRgExecutable();

      return new Promise((resolve, reject) => {
        execFile(
          rgExecutable,
          rgArgs,
          {
            cwd: fsAccess.getWorkspaceRoot(),
            env: buildSandboxEnvironment(),
            maxBuffer: 10 * 1024 * 1024,
          },
          (error, stdout) => {
            if (error) {
              if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                if (process.env.PATH === "" || process.env.PATH === undefined) {
                  return reject(
                    new Error(
                      "ripgrep (rg) is not installed or not available in PATH"
                    )
                  );
                }
                // ripgrep 未安装时，优雅回退至原生 JS 文件检索
                return fallbackJsGrep(
                  resolvedPath,
                  relPath,
                  args.query,
                  fsAccess.getWorkspaceRoot()
                ).then(resolve, reject);
              }

              if (error.code === 1) {
                return resolve(
                  `未在 '${relPath}' 中找到包含 '${args.query}' 的匹配项。`
                );
              }

              return reject(
                new Error(
                  `ripgrep 执行失败 (退出码: ${error.code}): ${error.message}`
                )
              );
            }

            const lines: string[] = [];
            for (const row of stdout.split(/\r?\n/).filter(Boolean)) {
              let event;
              try { event = JSON.parse(row); } catch { continue; }
              if (event.type !== "match" || typeof event.data?.path?.text !== "string") continue;
              const file = event.data.path.text;
              if (!mayReturnSearchFile(file, stat.isDirectory() ? resolvedPath : path.dirname(resolvedPath))) continue;
              const relative = path.relative(fsAccess.getWorkspaceRoot(), file).replaceAll("\\", "/");
              lines.push(`${relative}:${event.data.line_number}:${String(event.data.lines?.text ?? "").replace(/\r?\n$/, "")}`);
            }

            if (lines.length === 0) {
              return resolve(
                `未在 '${relPath}' 中找到包含 '${args.query}' 的匹配项。`
              );
            }

            if (lines.length > MAX_MATCHES) {
              const truncated = lines.slice(0, MAX_MATCHES);
              return resolve(
                truncated.join("\n") +
                  `\n\n... [已达到最大匹配数量限制 (${MAX_MATCHES} 条)，已停止展示]`
              );
            }

            return resolve(lines.join("\n"));
          }
        );
      });
    },
  });
}

/**
 * 遵循 Tool 接口标准的默认 grep_search 工具实例
 */
export const grepSearchTool: Tool<GrepSearchArgs> = createGrepSearchTool();
