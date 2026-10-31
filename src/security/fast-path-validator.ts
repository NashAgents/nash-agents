/**
 * Deterministic Fast Path Eligibility Validator (Hardened 7-Layer Architecture)
 *
 * 负责严格检验待执行工具调用是否真正具备确定性免审资格 (Fast Path Eligibility)
 * 严禁仅凭命令名称 (如 npm test, lint, echo, status) 或工作区内位置盲目免审。
 *
 * 7 层分层防御架构：
 * 1. 工具身份与参数 Schema 确定性校验
 * 2. 用户授权与项目工作区物理边界隔离 (拒绝 ../、逃逸软链接与断链)
 * 3. 操作系统及底层文件系统策略 (拦截 Windows 保留设备 CON/PRN/AUX/NUL、ADS 隐蔽流与系统特权文件)
 * 4. 确定性风险分类 (硬阻断系统特权路径、拒绝敏感凭据/配置/私钥免审)
 * 5. Shell 命令深度语法与元字符分析 (彻底拒绝管道、命令拼接、子shell、重定向、变量展开及任何测试/代码执行脚本免审)
 * 6. 只读/无害确定性子集白名单 (严格限定为无副作用、无参数注入的确定性环境探查)
 * 7. Fail-Closed 兜底流转 (任何不确定、复杂或执行类操作 100% 移交 Security LLM 审查或人工审批)
 */

import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { SecurityContext, SecurityDecision } from "./security-types.js";
import {
  isInsideWorkspaceWindows,
  isWindowsReservedDevice,
  hasAlternateDataStream,
} from "../sandbox/windows/path-utils.js";

/**
 * 敏感资源与文件特征定义
 */
const SENSITIVE_FILENAME_PATTERNS = [
  /^\.env(\..+)?$/i, // .env, .env.local, .env.production, etc.
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /^known_hosts$/i,
  /^authorized_keys$/i,
  /\.(pem|key|pkcs8|pkcs12|p12|pfx|kdbx|keystore|der|crt|cer)$/i,
  /^(credentials|credentials\.json|service-account.*\.json)$/i,
  /^\.(bash_history|zsh_history|history)$/i,
  /^(shadow|sudoers|master\.passwd)$/i,
  /^(access_tokens?|secret_tokens?|client_secrets?)\.json$/i,
  /^\.(netrc|npmrc|pypirc|git-credentials)$/i,
  /^(secrets?|auth|token|oauth|apikey|api_key)\.(json|ya?ml|env|ini|conf)$/i,
  /^(wp-config\.php|database\.ya?ml|db_credentials\.json)$/i,
  /\.(sqlite|sqlite3|db|db3|rdb)$/i,
  /^(pre-commit|post-commit|pre-push|commit-msg|prepare-commit-msg)$/i,
  /^config$/i,
];

const SENSITIVE_DIR_SEGMENTS = [
  ".ssh",
  ".aws",
  ".kube",
  ".gnupg",
  ".azure",
  ".docker", // docker config.json contains auth tokens
  ".gcloud",
  ".alicloud",
  ".tencentcloud",
  "google-cloud-sdk",
  ".git",
  "hooks",
];

const ABSOLUTE_FORBIDDEN_PATHS = [
  "/etc/shadow",
  "/etc/sudoers",
  "/etc/master.passwd",
  "/private/etc/shadow",
  "/private/etc/sudoers",
  "/proc",
  "/sys",
  "/dev",
  "system32/config/sam",
  "system32/config/system",
  "system32/config/security",
];

export interface FastPathValidationResult {
  isEligible: boolean;
  hardBlock?: SecurityDecision;
  reason?: string;
  normalizedPath?: string;
}

export class DeterministicFastPathEligibilityValidator {
  private readonly homedir: string;

  constructor() {
    this.homedir = os.homedir();
  }

  /**
   * 规范化并展开路径 (展开 ~ 与相对路径)
   */
  public normalizeTarget(targetPath?: string, cwd?: string): string {
    if (!targetPath) return "";
    let expanded = targetPath.trim();
    if (expanded.startsWith("~")) {
      expanded = path.join(this.homedir, expanded.slice(1));
    }
    const baseCwd = cwd || process.cwd();
    return path.resolve(baseCwd, expanded);
  }

  /**
   * 解析物理真实路径 (递归展开符号链接，检测不存在文件与断链软链接的真实目标)
   */
  public resolveRealPath(targetPath: string): { realpath: string; isSymlink: boolean; exists: boolean } {
    if (!targetPath) return { realpath: "", isSymlink: false, exists: false };
    try {
      // 使用 lstat 检测当前路径本身是否是软链接 (即便指向的目标不存在也能准确识别)
      let isSymlink = false;
      let currentTarget = targetPath;
      try {
        const lstat = fs.lstatSync(targetPath);
        if (lstat.isSymbolicLink()) {
          isSymlink = true;
          const linkTarget = fs.readlinkSync(targetPath);
          currentTarget = path.isAbsolute(linkTarget)
            ? linkTarget
            : path.resolve(path.dirname(targetPath), linkTarget);
        }
      } catch {}

      if (fs.existsSync(targetPath)) {
        const real = fs.realpathSync.native ? fs.realpathSync.native(targetPath) : fs.realpathSync(targetPath);
        return { realpath: real, isSymlink: isSymlink || real !== targetPath, exists: true };
      }

      // 若目标物理文件不存在，但它是指向敏感特权路径的软链接，返回该符号链接的目标绝对路径
      if (isSymlink) {
        return { realpath: currentTarget, isSymlink: true, exists: false };
      }

      // 目标尚不存在时（如待写入文件），解析其已存在的最深父目录物理真实路径
      let curr = path.dirname(targetPath);
      while (curr && curr !== path.dirname(curr)) {
        if (fs.existsSync(curr)) {
          const realParent = fs.realpathSync.native ? fs.realpathSync.native(curr) : fs.realpathSync(curr);
          const relativeSub = path.relative(curr, targetPath);
          const resolvedSub = path.resolve(realParent, relativeSub);
          return { realpath: resolvedSub, isSymlink: resolvedSub !== targetPath, exists: false };
        }
        curr = path.dirname(curr);
      }
    } catch {}
    return { realpath: targetPath, isSymlink: false, exists: false };
  }

  /**
   * 校验待执行工具调用是否满足 Fast Path 确定性免审资格
   */
  public validate(context: SecurityContext): FastPathValidationResult {
    const { toolName, toolArgs, rawArgs, argsFingerprint } = context;

    // 1. Layer 1: 工具身份与参数 Schema 基础有效性
    if (!toolName || typeof toolName !== "string") {
      return { isEligible: false, reason: "工具名称无效或缺失。" };
    }

    // 提取工具的目标文件或目录路径
    const rawTarget =
      (toolArgs?.path as string) ||
      (toolArgs?.file_path as string) ||
      (toolArgs?.filePath as string) ||
      (toolArgs?.directory as string) ||
      (toolArgs?.target as string) ||
      "";

    const normalized = rawTarget ? this.normalizeTarget(rawTarget, context.cwd) : "";

    // 2. Layer 2: 解析物理真实路径，彻底杜绝符号链接逃逸与欺骗
    const physical = normalized ? this.resolveRealPath(normalized) : { realpath: "", isSymlink: false, exists: false };
    const realTarget = physical.realpath || normalized;

    // 3. Layer 3: 系统特权与保留设备检查 (Hard Block)
    if (rawTarget) {
      // Windows 保留设备名称检测 (CON, PRN, AUX, NUL, COM*, LPT*)
      if (process.platform === "win32" && (isWindowsReservedDevice(rawTarget) || isWindowsReservedDevice(realTarget))) {
        return {
          isEligible: false,
          hardBlock: {
            verdict: "BLOCK",
            severity: 95,
            category: "Device Hijacking",
            ruleName: "Windows Reserved Device Hard Block",
            reason: `确定性硬性拦截：严禁访问 Windows 保留设备名 '${rawTarget}'。`,
            fingerprint: argsFingerprint,
            toolName,
            evaluatedAt: Date.now(),
            durationMs: 0,
          },
        };
      }

      // Windows Alternate Data Streams (ADS) 检测 (如 file.txt:hidden)
      if (process.platform === "win32" && (hasAlternateDataStream(rawTarget) || hasAlternateDataStream(realTarget))) {
        return {
          isEligible: false,
          hardBlock: {
            verdict: "BLOCK",
            severity: 92,
            category: "Alternate Data Stream",
            ruleName: "Windows ADS Hard Block",
            reason: `确定性硬性拦截：检测到试图利用 NTFS Alternate Data Streams (ADS) 逃逸沙箱监控。`,
            fingerprint: argsFingerprint,
            toolName,
            evaluatedAt: Date.now(),
            durationMs: 0,
          },
        };
      }
    }

    // 检查绝对禁止的系统核心特权文件 (Hard Block)
    const rawSlash = rawTarget.replace(/\\/g, "/").toLowerCase();
    const normSlash = normalized.replace(/\\/g, "/").toLowerCase();
    const realSlash = realTarget.replace(/\\/g, "/").toLowerCase();
    const normNoDrive = normSlash.replace(/^[a-z]:/, "");
    const realNoDrive = realSlash.replace(/^[a-z]:/, "");

    for (const forbidden of ABSOLUTE_FORBIDDEN_PATHS) {
      const forbSlash = forbidden.toLowerCase();
      const isMatch =
        rawSlash === forbSlash ||
        rawSlash.startsWith(forbSlash + "/") ||
        normSlash === forbSlash ||
        normSlash.startsWith(forbSlash + "/") ||
        normNoDrive === forbSlash ||
        normNoDrive.startsWith(forbSlash + "/") ||
        realSlash === forbSlash ||
        realSlash.startsWith(forbSlash + "/") ||
        realNoDrive === forbSlash ||
        realNoDrive.startsWith(forbSlash + "/") ||
        (forbSlash.startsWith("system32/") && (normSlash.includes(forbSlash) || realSlash.includes(forbSlash) || rawSlash.includes(forbSlash)));

      if (isMatch) {
        return {
          isEligible: false,
          hardBlock: {
            verdict: "BLOCK",
            severity: 98,
            category: "Privilege Escalation",
            ruleName: "System Privileged Path Hard Block",
            reason: `确定性硬性拦截：严禁任何工具读取或篡改系统底层特权文件 '${forbidden}' (真实物理路径: ${realTarget})。`,
            fingerprint: argsFingerprint,
            toolName,
            evaluatedAt: Date.now(),
            durationMs: 0,
          },
        };
      }
    }

    // 4. Layer 4: 检查是否触及敏感文件或凭据目录
    const isSensitive = this.isSensitiveResource(normalized, realTarget, rawTarget, toolArgs || {});
    if (isSensitive.sensitive) {
      return {
        isEligible: false,
        reason: `目标涉及敏感凭据或私密环境资源 (${isSensitive.reason})，拒绝确定性免审，必须经由安全模型深入裁决。`,
        normalizedPath: realTarget,
      };
    }

    // 5. 工作区边界检测 (Workspace Root Boundary)
    const rawCwd = context.cwd ? path.resolve(context.cwd) : process.cwd();
    const baseCwd = this.resolveRealPath(rawCwd).realpath || rawCwd;
    const isInsideWorkspace = process.platform === "win32"
      ? isInsideWorkspaceWindows(realTarget, baseCwd)
      : (realTarget === baseCwd || realTarget.startsWith(baseCwd + path.sep));

    if (physical.isSymlink && !isInsideWorkspace) {
      return {
        isEligible: false,
        reason: `检测到符号链接指向工作区外物理路径 '${realTarget}'，潜在逃逸风险，拒绝免审。`,
        normalizedPath: realTarget,
      };
    }

    // 6. Layer 5: 只读探测工具白名单检查 (严格约束在当前工作区内)
    const safeReadOnlyTools = new Set([
      "list_files",
      "grep_search",
      "inspect_local_projects",
      "inspect_local_mcp",
      "read_project_meta",
      "submit_discovery_report",
      "search_cluster_projects",
    ]);

    if (safeReadOnlyTools.has(toolName)) {
      // 对于 list_files 和 grep_search，若显式指定了路径且该路径不在工作区内，拒绝 Fast-Path，转模型审查
      if ((toolName === "list_files" || toolName === "grep_search") && normalized) {
        if (!isInsideWorkspace) {
          return {
            isEligible: false,
            reason: `工具 '${toolName}' 检索目标 '${realTarget}' 位于工作区外部，不可静默免审，需经安全模型审查授权范围。`,
            normalizedPath: realTarget,
          };
        }
      }

      // 对于 grep_search，检查 search pattern 是否含有提取 secret/private key 恶意特征
      if (toolName === "grep_search") {
        const query = String(toolArgs?.query || toolArgs?.pattern || "");
        if (
          query.toLowerCase().includes("id_rsa") ||
          query.toLowerCase().includes("private_key") ||
          query.toLowerCase().includes(".aws/credentials") ||
          query.toLowerCase().includes("api_key") ||
          query.toLowerCase().includes("token")
        ) {
          return {
            isEligible: false,
            reason: "Grep 检索内容包含敏感私钥或凭据关键字，需经由安全模型核准意图。",
            normalizedPath: realTarget,
          };
        }
      }

      return {
        isEligible: true,
        reason: "只读或探查工具，目标路径及参数经规范化已确认为无害常规资源。",
        normalizedPath: realTarget,
      };
    }

    // 7. read_file 检查：仅当确定为当前授权工作区内部且非敏感的项目常规代码与文档时才放行
    if (toolName === "read_file") {
      if (!normalized) {
        return { isEligible: false, reason: "无法确定读取目标的物理规范路径。" };
      }

      // 必须属于当前项目授权范围 (Workspace Root) 内部，工作区外的文件不得静默免审
      if (!isInsideWorkspace) {
        return {
          isEligible: false,
          reason: `读取目标 '${realTarget}' 位于当前项目工作区外，不可确定性免审，需经由安全模型审查授权范围。`,
          normalizedPath: realTarget,
        };
      }

      // 预检文件物理形态：若文件存在，必须为常规文件，坚决拒绝读取 FIFO 管道/特殊设备免审以防阻塞挂死
      if (physical.exists) {
        try {
          const stat = fs.statSync(realTarget);
          if (!stat.isFile()) {
            return {
              isEligible: false,
              reason: `读取目标 '${realTarget}' 不是常规文件（可能为命名管道 FIFO、设备或套接字），拒绝免审。`,
              normalizedPath: realTarget,
            };
          }
        } catch {}
      }

      return {
        isEligible: true,
        reason: "目标文件已确认为工作区内常规项目源代码或配置文档，无凭据外泄风险，快速放行。",
        normalizedPath: realTarget,
      };
    }

    // 8. Layer 6: bash / execute_command 深度安全性审计
    // 核心安全原则：命令名称不等于实际行为！
    // 任何脚本执行、测试框架 (npm test, pytest, node test.js)、编译器调用或未知命令，
    // 均可执行任意代码并产生写文件/子进程/网络外联等动态副作用，绝对严禁 Fast-Path 0ms 免审！
    // Fast-Path 仅限无副作用、无参数注入的确定性环境探测原子命令。
    if (toolName === "bash" || toolName === "execute_command") {
      const cmd = String(toolArgs?.command || rawArgs || "").trim();

      // 8.1 严厉拦截所有包含 Shell 元字符的复杂复合命令
      // 包含：重定向 (> >> < << <<<), 管道 (|), 命令拼接 (; & && ||), 命令替换 (` $()),
      // 变量展开 ($ ${}), 子 Shell (()), 花括号展开 ({}), 转义符 (\), 换行符 (\n \r)
      const hasShellMetacharacters = /[><|;&`$\n\r(){}\\]/.test(cmd);
      if (hasShellMetacharacters) {
        return {
          isEligible: false,
          reason: `Shell 命令包含元字符或复合指令 (${cmd.slice(0, 60)})，潜在注入/管道逃逸风险，移交安全模型深入审查。`,
          normalizedPath: realTarget,
        };
      }

      // 8.2 拦截工作目录变更与环境劫持
      if (/^(?:cd|pushd|popd|export|unset|set|alias|unalias|source)\b/i.test(cmd)) {
        return {
          isEligible: false,
          reason: `检测到 Shell 环境/工作目录变更指令，必须经过安全模型审查。`,
          normalizedPath: realTarget,
        };
      }

      // 8.3 拦截任何脚本执行与构建/测试命令 (npm, npx, yarn, pnpm, node, python, pytest, cargo, go run, make 等)
      // 依据安全铁律：npm test / pytest 等表面无害但内部可执行任意代码，不可跳过模型审查！
      if (/^(?:npm|npx|yarn|pnpm|node|python|python3|pytest|cargo|go|make|sh|bash|zsh|eval|exec)\b/i.test(cmd)) {
        // 唯一特例：仅限纯版本号查询 (如 node -v, npm -v, python -V, python3 --version)
        const isPureVersionQuery = /^(?:node\s+-(?:v|-version)|npm\s+-(?:v|-version)|python3?\s+-(?:[vV]|-version))$/i.test(cmd);
        if (isPureVersionQuery) {
          return {
            isEligible: true,
            reason: "纯运行时版本探测命令，无参数注入与执行副作用，快速放行。",
            normalizedPath: realTarget,
          };
        }

        return {
          isEligible: false,
          reason: `命令 '${cmd.split(/\s+/)[0]}' 涉及代码/脚本/测试执行，命令名称不代表实际行为，坚决移交安全模型深入审查。`,
          normalizedPath: realTarget,
        };
      }

      // 8.4 确定性只读环境与版本探测白名单 (纯原子只读查询)
      const isPureSafeQuery = /^(?:pwd|whoami|hostname)$/i.test(cmd);
      if (isPureSafeQuery) {
        return {
          isEligible: true,
          reason: "常规工作区只读信息探测命令，无凭据外泄特征，快速放行。",
          normalizedPath: realTarget,
        };
      }

      // 8.5 Git 确定性只读子集白名单 (严格排查 mutating flags)
      // 仅允许纯只读查询，严禁包含 push, pull, commit, checkout, switch, rebase, merge, reset, clean, rm, tag, hook
      const isGitSafeQuery = /^(?:git\s+(?:status(?:\s+-(?:s|-short))?|branch(?:\s+--(?:show-current|list))?|rev-parse\s+(?:HEAD|--show-toplevel)|log(?:\s+(?:-(?:n\s+\d+|\d+|p|stat)|--oneline|--stat))?|diff(?:\s+--(?:cached|staged|stat))?))$/i.test(cmd);
      if (isGitSafeQuery && !this.isSensitiveResource("", "", cmd, toolArgs || {}).sensitive) {
        return {
          isEligible: true,
          reason: "Git 只读状态/分支/日志查询命令，参数无副作用特征，快速放行。",
          normalizedPath: realTarget,
        };
      }

      // 任何其他 Shell 命令（包括未明确收敛的命令）坚决不免审
      return {
        isEligible: false,
        reason: `Shell 命令 '${cmd.slice(0, 50)}' 未命中确定性安全查询白名单，必须由安全模型核准意图。`,
        normalizedPath: realTarget,
      };
    }

    // 9. Layer 7: 其他工具（写文件、编辑文件、网络调用、MCP、分布式派发）一律移交安全模型审查
    return {
      isEligible: false,
      reason: `工具 '${toolName}' 属于写/执行/外部交互工具，必须经过安全模型深入审查。`,
      normalizedPath: realTarget,
    };
  }

  /**
   * 判断目标是否属于敏感文件或敏感目录
   */
  private isSensitiveResource(
    normalizedPath: string,
    realPath: string,
    rawTarget: string,
    toolArgs: Record<string, unknown>
  ): { sensitive: boolean; reason?: string } {
    const rawLower = rawTarget.toLowerCase();
    const normLower = normalizedPath.toLowerCase();
    const realLower = realPath.toLowerCase();

    // 检查参数中是否包含 .env 或 id_rsa 等关键词
    if (rawLower.includes(".env") || normLower.includes("/.env") || realLower.includes("/.env") || realLower.endsWith(".env")) {
      return { sensitive: true, reason: "Environment Secrets (.env file)" };
    }

    if (rawLower.includes("id_rsa") || normLower.includes("id_rsa") || realLower.includes("id_rsa") || rawLower.includes("id_ed25519") || realLower.includes("id_ed25519")) {
      return { sensitive: true, reason: "SSH Private Key" };
    }

    if (rawLower.includes(".aws") || normLower.includes("/.aws") || realLower.includes("/.aws")) {
      return { sensitive: true, reason: "Cloud Provider Credentials (.aws)" };
    }

    if (
      rawLower.includes("system32/config") ||
      rawLower.includes("system32\\config") ||
      normLower.includes("system32/config") ||
      normLower.includes("system32\\config") ||
      realLower.includes("system32/config") ||
      realLower.includes("system32\\config")
    ) {
      return { sensitive: true, reason: "Windows SAM / System Registry Hive" };
    }

    // 检查目录段 (同时检查表层与物理路径)
    const checkSegments = (p: string) => {
      const parts = p.split(path.sep);
      for (const seg of parts) {
        if (SENSITIVE_DIR_SEGMENTS.includes(seg.toLowerCase())) {
          return seg;
        }
      }
      return null;
    };

    const normSeg = checkSegments(normalizedPath);
    if (normSeg) return { sensitive: true, reason: `Sensitive Directory (${normSeg})` };

    const realSeg = checkSegments(realPath);
    if (realSeg) return { sensitive: true, reason: `Physical Sensitive Directory (${realSeg})` };

    // 检查文件名模式
    const checkBasename = (p: string) => {
      const basename = path.basename(p);
      for (const pattern of SENSITIVE_FILENAME_PATTERNS) {
        if (pattern.test(basename)) {
          return basename;
        }
      }
      return null;
    };

    const normBase = checkBasename(normalizedPath);
    if (normBase) return { sensitive: true, reason: `Sensitive File Pattern (${normBase})` };

    const realBase = checkBasename(realPath);
    if (realBase) return { sensitive: true, reason: `Physical Sensitive File Pattern (${realBase})` };

    // 检查跨项目窃取私有 session 或记忆文件 (如读取 ~/.nash/session.jsonl 等包含历史凭据的记录)
    if (
      normLower.includes(".nash/session") ||
      normLower.includes(".nash/sessions") ||
      realLower.includes(".nash/session") ||
      realLower.includes(".nash/sessions")
    ) {
      return { sensitive: true, reason: "Private Nash Conversation / Session Store" };
    }

    return { sensitive: false };
  }
}
