import type { SandboxPolicy } from "./types.js";

/**
 * 创建系统底层默认的 SandboxPolicy (基础受限沙箱底座)。
 *
 * 默认策略配置：
 * - filesystem: workspace-write（工作区内读写，外部路径受限）
 * - network: deny（默认禁止进程访问网络）
 * - approval: ask（越界或受限操作时向用户交互式请求一次性放行）
 */
export function createDefaultSandboxPolicy(): SandboxPolicy {
  return {
    filesystem: {
      mode: "workspace-write",
    },
    network: {
      mode: "deny",
    },
    approval: {
      mode: "ask",
    },
  };
}

/**
 * 创建 Full Capability Execution 沙箱策略 (Nash Agent 核心执行权限体系)。
 *
 * 取消 workspace-write 作为 Agent 的默认能力上限：
 * - filesystem: full-capability (具备完成任务所需的完整读写能力，保留 OS 底层系统防护)
 * - network: allow (允许依赖安装、API 调用与集群通信)
 * - approval: ask (高风险破坏性操作由 Pre-Tool Security Monitor 审查并触发人机审批)
 */
export function createFullCapabilitySandboxPolicy(): SandboxPolicy {
  return {
    filesystem: {
      mode: "full-capability",
    },
    network: {
      mode: "allow",
    },
    approval: {
      mode: "ask",
    },
  };
}

/**
 * 深拷贝一个 SandboxPolicy 副本，用于生成单次调用的临时策略重写 (Policy Override)，
 * 确保全局策略不被篡改。
 *
 * @param policy - 源策略对象
 */
export function cloneSandboxPolicy(policy: SandboxPolicy): SandboxPolicy {
  return {
    filesystem: {
      mode: policy.filesystem.mode,
    },
    network: {
      mode: policy.network.mode,
    },
    approval: {
      mode: policy.approval.mode,
    },
  };
}
