/**
 * 集群运行版本判定的纯函数部分（无网络、无副作用，便于单元测试）。
 *
 * 核心区分：
 *   1. 期望版本（expected）：发布方声明的 commit / artifactSha256；
 *   2. 协同器自报（coordinator status.runtimeRelease）；
 *   3. 每个节点的自报（inventory.nodes[].runtimeRelease）。
 *
 * 判定必须同时满足：
 *   - 节点在线；
 *   - commit 与 dirty 匹配（dirty 必须为 false）；
 *   - artifactSha256 === 期望产物哈希 且 artifactVerified === true
 *     —— 只比对 commit 无法发现「同一 commit 但产物被替换」的运行进程；
 *   - 沙箱能力已验证且未过期；
 *   - Windows 节点的 helper 哈希匹配。
 *
 * 注意：这些字段都是进程自报（self-reported）。它们能证明「运行中的进程与磁盘产物一致」，
 * 但不能替代 CI 产物清单 / 签名提供的供应链信任根。
 */

export function evaluateClusterRelease({ expected, coordinatorRelease, nodes, expectedNodes, helperSha256, now = Date.now() }) {
  const problems = [];

  if (!/^[a-f0-9]{40}$/.test(expected?.commit ?? "")) problems.push("expected.commit 必须是完整 40 位 Git SHA");
  if (!/^[a-f0-9]{64}$/.test(expected?.artifactSha256 ?? "")) problems.push("expected.artifactSha256 必须是 64 位十六进制哈希");

  const matchesRelease = (release) => {
    if (!release) return false;
    if (release.commit !== expected.commit) return false;
    if (release.dirty !== false) return false;
    if (release.artifactVerified !== true) return false;
    if (release.artifactSha256 !== expected.artifactSha256) return false;
    return true;
  };

  const reported = expectedNodes.map((nodeId) => {
    const node = nodes.find((item) => item.nodeId === nodeId);
    const capability = node?.sandboxCapability;
    const sandbox = capability?.structuredDetails;
    const runtime = node?.runtimeRelease;
    const helperMatch = !helperSha256 || node?.platform !== "win32" || sandbox?.helperSha256 === helperSha256;
    const verified = Boolean(
      node
      && node.status === "online"
      && matchesRelease(runtime)
      && helperMatch
      && capability?.status === "verified"
      && typeof sandbox?.verificationExpiresAt === "number"
      && sandbox.verificationExpiresAt > now
    );
    const reasons = [];
    if (!node) reasons.push("节点不在清单中");
    else {
      if (node.status !== "online") reasons.push(`节点状态为 ${node.status}`);
      if (!runtime) reasons.push("节点未上报 runtimeRelease");
      else {
        if (runtime.commit !== expected.commit) reasons.push(`commit 不一致 (${runtime.commit ?? "null"})`);
        if (runtime.dirty !== false) reasons.push("产物标记为 dirty 或未验证");
        if (runtime.artifactVerified !== true) reasons.push("节点产物哈希自校验失败");
        if (runtime.artifactSha256 !== expected.artifactSha256) reasons.push("artifactSha256 与期望产物不一致");
      }
      if (!helperMatch) reasons.push("Windows helper 哈希不匹配");
      if (capability?.status !== "verified") reasons.push("沙箱能力不是 verified");
      else if (!(sandbox?.verificationExpiresAt > now)) reasons.push("沙箱能力验证已过期");
    }
    return {
      nodeId,
      platform: node?.platform,
      connectionGeneration: node?.connectionGeneration,
      runtime,
      sandbox,
      verdict: verified ? "RUNTIME_VERIFIED" : "RUNTIME_STALE_OR_UNVERIFIED",
      reasons: verified ? [] : reasons,
    };
  });

  const coordinatorVerified = matchesRelease(coordinatorRelease);
  if (!coordinatorVerified) problems.push("Coordinator runtimeRelease 与期望不符");

  const passed = problems.length === 0 && reported.every((node) => node.verdict === "RUNTIME_VERIFIED");
  return {
    expectedRelease: expected,
    coordinator: coordinatorRelease,
    coordinatorVerified,
    nodes: reported,
    problems,
    verdict: passed ? "RUNTIME_VERIFIED" : "PARTIAL",
  };
}
