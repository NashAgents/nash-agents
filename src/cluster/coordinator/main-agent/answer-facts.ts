/**
 * 最终回答的事实一致性核验 (Deterministic Fact Consistency Verifier)。
 *
 * 证据闸门只回答「哪些节点得出了结论」，不回答「回答里引用的数字是否真实」。
 * 真实 E2E 已暴露：产物里写的是 1793177600…，最终回答却生成了 1793177811…，
 * 这类不一致无法靠措辞检查发现，也不是表达方式问题。
 *
 * 设计原则：
 * 1. 来源必须是**结构化执行记录或本轮工具返回**，绝不以模型自述为证据；
 * 2. 不是「数字必须在原文逐字出现」的子串匹配——合法的时间换算、单位转换、
 *    区间差值与求和属于允许的推导，通过带单位的规范化与推导集来判定；
 * 3. 无法确认的事实不冒充已验证事实：核验失败时进入更正/重生成，
 *    仍不通过则前置确定性说明，明确标注「不作为已验证事实」。
 */
import type { ExecutionEvidenceSet } from "./execution-evidence.js";

export interface ToolResultFactInput {
  /** 证据来源标识，例如 `tool:read_graph_artifact:call-abc`。 */
  sourceId: string;
  sourceLabel?: string;
  taskId?: string;
  nodeId?: string;
  artifactId?: string;
  text: string;
}

export interface EpochFact {
  valueMs: number;
  label: string;
  source: string;
}

export interface DurationFact {
  valueMs: number;
  label: string;
  source: string;
}

export interface ArtifactFact {
  artifactId: string;
  name: string;
  sha256: string;
  sizeBytes: number;
  producerNodeId?: string;
  producerTaskId?: string;
}

export interface CountFact {
  category: string;
  value: number;
  label: string;
}

export interface FactCatalog {
  epochs: EpochFact[];
  /** 允许出现的秒级时间戳（含毫秒值向下取整），用于容忍秒级截断。 */
  epochSeconds: Set<number>;
  /** 允许出现的毫秒级时间戳。 */
  epochMillis: Set<number>;
  durations: DurationFact[];
  artifacts: ArtifactFact[];
  hashes: Set<string>;
  identifiers: Set<string>;
  counts: CountFact[];
  toolResultCount: number;
}

export type ClaimKind = "sha256" | "epoch" | "duration" | "bytes" | "count" | "identifier";

export interface Claim {
  kind: ClaimKind;
  raw: string;
  /** 规范化后的数值（epoch: ms；duration: ms；bytes: 字节数；count: 整数）。 */
  value?: number;
  unit?: string;
  category?: string;
  index: number;
}

export interface FactViolation {
  claim: string;
  kind: ClaimKind;
  claimed: string;
  expected: string;
  source: string;
  message: string;
}

export interface FactVerificationResult {
  verdict: "pass" | "violations" | "not_applicable";
  checkedClaims: number;
  violations: FactViolation[];
  /** 无法确认但不足以判为冲突的断言（例如产物大小类），仅作提示。 */
  unverifiable: FactViolation[];
}

/** 收集被验证过的时间戳范围，用于给出「同批真实值」提示。 */
function pushEpoch(list: EpochFact[], source: string, label: string, value?: number): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return;
  list.push({ valueMs: value, label, source });
}

function harvestEpochTokens(text: string, sink: (valueMs: number) => void): void {
  // 秒级（可带小数）与毫秒级时间戳；只接受合理区间，避免把普通大数当成时间。
  const re = /\b(1\d{9}(?:\.\d+)?|1\d{12})\b/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const raw = match[1]!;
    const value = Number(raw);
    if (!Number.isFinite(value)) continue;
    if (raw.length >= 13) {
      if (value >= 1_000_000_000_000 && value <= 2_000_000_000_000) sink(value);
    } else if (value >= 1_000_000_000 && value <= 2_000_000_000) {
      sink(value * 1000);
    }
  }
}

function harvestIdentifiers(text: string, sink: (id: string) => void): void {
  const re = /\b(?:task|graph|art|node|appr|conv|run|sec|sched)-[A-Za-z0-9][A-Za-z0-9_-]{3,}\b/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) sink(match[0]);
}

function harvestHashes(text: string, sink: (hash: string) => void): void {
  const re = /\b[a-f0-9]{64}\b/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) sink(match[0]);
}

/**
 * 构建事实目录：所有允许被断言的值都必须能追溯到执行记录或本轮工具返回。
 */
export function buildFactCatalog(input: {
  evidence?: ExecutionEvidenceSet;
  toolResults?: ToolResultFactInput[];
}): FactCatalog {
  const epochs: EpochFact[] = [];
  const durations: DurationFact[] = [];
  const artifacts: ArtifactFact[] = [];
  const hashes = new Set<string>();
  const identifiers = new Set<string>();
  const counts: CountFact[] = [];

  for (const task of input.evidence?.tasks ?? []) {
    const source = task.taskId;
    identifiers.add(task.taskId);
    if (task.graphId) identifiers.add(task.graphId);
    if (task.nodeId) identifiers.add(task.nodeId);
    pushEpoch(epochs, source, `${task.taskId}.createdAt`, task.createdAt);
    pushEpoch(epochs, source, `${task.taskId}.startedAt`, task.startedAt);
    pushEpoch(epochs, source, `${task.taskId}.completedAt`, task.completedAt);
    if (typeof task.createdAt === "number" && typeof task.completedAt === "number" && task.completedAt > task.createdAt) {
      durations.push({ valueMs: task.completedAt - task.createdAt, label: `${task.taskId} 总耗时`, source });
    }
    if (typeof task.startedAt === "number" && typeof task.completedAt === "number" && task.completedAt >= task.startedAt) {
      durations.push({ valueMs: task.completedAt - task.startedAt, label: `${task.taskId} 执行耗时`, source });
    }
  }

  for (const artifact of input.evidence?.artifacts ?? []) {
    identifiers.add(artifact.artifactId);
    artifacts.push({
      artifactId: artifact.artifactId,
      name: artifact.name,
      sha256: artifact.sha256,
      sizeBytes: artifact.sizeBytes,
      producerNodeId: artifact.producerNodeId,
      producerTaskId: artifact.producerTaskId,
    });
    hashes.add(artifact.sha256.toLowerCase());
    pushEpoch(epochs, artifact.artifactId, `${artifact.name} 发布时间`, artifact.createdAt);
  }

  for (const nodeId of input.evidence?.workers.map((worker) => worker.nodeId) ?? []) identifiers.add(nodeId);
  if (input.evidence?.graph?.graphId) identifiers.add(input.evidence.graph.graphId);

  // 工具返回里的真实执行数字：这是模型当时确实拿到的证据，可作为断言来源。
  let toolResultCount = 0;
  for (const result of input.toolResults ?? []) {
    toolResultCount += 1;
    const source = result.sourceLabel ?? result.sourceId;
    if (result.taskId) identifiers.add(result.taskId);
    if (result.nodeId) identifiers.add(result.nodeId);
    if (result.artifactId) identifiers.add(result.artifactId);
    harvestEpochTokens(result.text, (valueMs) => pushEpoch(epochs, source, `工具返回时间戳`, valueMs));
    harvestIdentifiers(result.text, (id) => identifiers.add(id));
    harvestHashes(result.text, (hash) => hashes.add(hash));
  }

  // 时间区间推导：同一轮内任意两个真实时间戳之差，都是合法的「执行时长」断言来源。
  const uniqueEpochMs = [...new Set(epochs.map((item) => Math.round(item.valueMs)))];
  const bounded = uniqueEpochMs.slice(0, 64);
  for (let i = 0; i < bounded.length; i += 1) {
    for (let j = 0; j < bounded.length; j += 1) {
      if (i === j) continue;
      const delta = bounded[i]! - bounded[j]!;
      if (delta > 0) durations.push({ valueMs: delta, label: "执行区间差值", source: "derived" });
    }
  }

  const epochMillis = new Set<number>(uniqueEpochMs);
  const epochSeconds = new Set<number>();
  for (const value of uniqueEpochMs) {
    epochSeconds.add(Math.floor(value / 1000));
    epochSeconds.add(Math.ceil(value / 1000));
  }

  const evidenceCounts = input.evidence?.counts;
  if (evidenceCounts) {
    counts.push({ category: "node", value: evidenceCounts.workers, label: "Worker 数量" });
    counts.push({ category: "node", value: evidenceCounts.graphNodes, label: "任务图节点数量" });
    counts.push({ category: "task", value: evidenceCounts.tasks, label: "任务数量" });
    counts.push({ category: "task", value: evidenceCounts.completedTasks, label: "已完成任务数量" });
    counts.push({ category: "artifact", value: evidenceCounts.artifacts, label: "产物数量" });
  }

  return { epochs, epochSeconds, epochMillis, durations, artifacts, hashes, identifiers, counts, toolResultCount };
}

// 注意：中文不是 \w 字符，`节点\b` 永远不会成立；英文名词后面必须排除标识符继续，
// 否则 `产物 node0-report` 会被误读成「产物 0 个」。
const COUNT_NOUN_CATEGORY: Array<{ nouns: string; category: string }> = [
  { nouns: "节点|机器|主机|workers|worker|nodes|node", category: "node" },
  { nouns: "子任务|任务|tasks|task", category: "task" },
  { nouns: "产物|工件|artifacts|artifact", category: "artifact" },
];

const DURATION_UNITS: Record<string, number> = {
  ms: 1,
  "毫秒": 1,
  s: 1000,
  "秒": 1000,
  sec: 1000,
  seconds: 1000,
  min: 60_000,
  "分钟": 60_000,
  minutes: 60_000,
  h: 3_600_000,
  "小时": 3_600_000,
  hours: 3_600_000,
};

const BYTE_UNITS: Record<string, number> = {
  b: 1,
  byte: 1,
  bytes: 1,
  "字节": 1,
  kb: 1000,
  kib: 1024,
  mb: 1000 * 1000,
  mib: 1024 * 1024,
  gb: 1000 * 1000 * 1000,
  gib: 1024 * 1024 * 1024,
};

/** 抽取回答中可确定性核验的断言。 */
export function extractAnswerClaims(answer: string): Claim[] {
  const claims: Claim[] = [];
  if (!answer) return claims;

  const shaRe = /\b[a-f0-9]{64}\b/gi;
  for (const match of answer.matchAll(shaRe)) {
    claims.push({ kind: "sha256", raw: match[0], value: undefined, index: match.index ?? 0 });
  }

  const idRe = /\b(?:task|graph|art|node|appr|conv|run|sec|sched)-[A-Za-z0-9][A-Za-z0-9_-]{3,}\b/g;
  for (const match of answer.matchAll(idRe)) {
    claims.push({ kind: "identifier", raw: match[0], index: match.index ?? 0 });
  }

  const epochRe = /\b(1\d{9}(?:\.\d+)?|1\d{12})\b/g;
  for (const match of answer.matchAll(epochRe)) {
    const raw = match[1]!;
    const value = Number(raw);
    if (!Number.isFinite(value)) continue;
    if (raw.length >= 13) {
      if (value < 1_000_000_000_000 || value > 2_000_000_000_000) continue;
      claims.push({ kind: "epoch", raw, value, unit: "ms", index: match.index ?? 0 });
    } else {
      if (value < 1_000_000_000 || value > 2_000_000_000) continue;
      claims.push({ kind: "epoch", raw, value: value * 1000, unit: "s", index: match.index ?? 0 });
    }
  }

  const durationRe = /(\d+(?:\.\d+)?)\s*(毫秒|ms|秒钟|秒|seconds?|secs?|s|分钟|minutes?|mins?|min|小时|hours?|hrs?|h)(?![A-Za-z])/g;
  for (const match of answer.matchAll(durationRe)) {
    const unitRaw = match[2]!.toLowerCase();
    const factor = DURATION_UNITS[unitRaw] ?? DURATION_UNITS[unitRaw.replace(/s$/, "")];
    if (!factor) continue;
    const value = Number(match[1]);
    if (!Number.isFinite(value)) continue;
    claims.push({ kind: "duration", raw: match[0], value: value * factor, unit: unitRaw, index: match.index ?? 0 });
  }

  const byteRe = /(\d+(?:\.\d+)?)\s*(bytes?|字节|KiB|KB|kB|MiB|MB|GiB|GB)(?![A-Za-z])/g;
  for (const match of answer.matchAll(byteRe)) {
    const unitRaw = match[2]!.toLowerCase();
    const factor = BYTE_UNITS[unitRaw];
    if (!factor) continue;
    const value = Number(match[1]);
    if (!Number.isFinite(value)) continue;
    claims.push({ kind: "bytes", raw: match[0], value: value * factor, unit: unitRaw, index: match.index ?? 0 });
  }

  // 中英文数量表达两种语序都要覆盖：`3 个节点` / `节点 3 个` / `3 nodes`。
  for (const { nouns, category } of COUNT_NOUN_CATEGORY) {
    const numberFirst = new RegExp(`(\\d+)\\s*(?:个|台|项)?\\s*(?:${nouns})(?![A-Za-z0-9_-])`, "gi");
    for (const match of answer.matchAll(numberFirst)) {
      const value = Number(match[1]);
      if (!Number.isFinite(value)) continue;
      claims.push({ kind: "count", raw: match[0], value, category, index: match.index ?? 0 });
    }
    // 中文语序 `任务 5 个`：必须带量词，避免把 `node0` 这类标识符当成计数。
    const nounFirst = new RegExp(`(?:${nouns})(?![A-Za-z0-9_-])\\s*(\\d+)\\s*(?:个|台|项)`, "gi");
    for (const match of answer.matchAll(nounFirst)) {
      const value = Number(match[1]);
      if (!Number.isFinite(value)) continue;
      claims.push({ kind: "count", raw: match[0], value, category, index: match.index ?? 0 });
    }
  }

  return claims;
}

function formatMs(valueMs: number): string {
  if (valueMs >= 1000) return `${(valueMs / 1000).toFixed(3)}s (${Math.round(valueMs)}ms)`;
  return `${Math.round(valueMs)}ms`;
}

/** 断言是否与事实目录冲突。只有确定冲突才判失败；不确定归入 unverifiable。 */
export function verifyAnswerFacts(answer: string, catalog: FactCatalog): FactVerificationResult {
  const claims = extractAnswerClaims(answer);
  const violations: FactViolation[] = [];
  const unverifiable: FactViolation[] = [];

  if (!claims.length) return { verdict: "not_applicable", checkedClaims: 0, violations, unverifiable };

  const hasAnyEvidence = catalog.epochs.length > 0 || catalog.artifacts.length > 0
    || catalog.toolResultCount > 0 || catalog.counts.some((count) => count.value > 0);
  if (!hasAnyEvidence) return { verdict: "not_applicable", checkedClaims: 0, violations, unverifiable };

  const nearestEpochs = (value: number): string =>
    catalog.epochs
      .slice()
      .sort((a, b) => Math.abs(a.valueMs - value) - Math.abs(b.valueMs - value))
      .slice(0, 2)
      .map((item) => `${item.label}=${Math.round(item.valueMs)}（${item.source}）`)
      .join("；") || "（无记录）";

  for (const claim of claims) {
    if (claim.kind === "sha256") {
      const hash = claim.raw.toLowerCase();
      const exact = catalog.hashes.has(hash);
      const prefix = !exact && catalog.hashes.size > 0
        ? [...catalog.hashes].some((candidate) => candidate.startsWith(hash) || hash.startsWith(candidate.slice(0, 12)))
        : false;
      if (!exact && !prefix) {
        violations.push({
          claim: claim.raw, kind: claim.kind, claimed: hash.slice(0, 16) + "…",
          expected: catalog.artifacts.map((a) => `${a.name}=${a.sha256.slice(0, 16)}…`).join("；") || "（本轮没有已核验产物）",
          source: "artifact_registry",
          message: "回答中的 SHA-256 不属于本轮任何已核验产物。",
        });
      }
      continue;
    }

    if (claim.kind === "identifier") {
      if (catalog.identifiers.size === 0) {
        unverifiable.push({
          claim: claim.raw, kind: claim.kind, claimed: claim.raw, expected: "（本轮无标识符记录）",
          source: "evidence_set", message: "本轮没有可对照的执行标识符记录。",
        });
        continue;
      }
      if (!catalog.identifiers.has(claim.raw)) {
        violations.push({
          claim: claim.raw, kind: claim.kind, claimed: claim.raw,
          expected: [...catalog.identifiers].slice(0, 8).join("、"),
          source: "evidence_set",
          message: "回答引用了本轮执行记录中不存在的标识符。",
        });
      }
      continue;
    }

    if (claim.kind === "epoch") {
      const value = claim.value!;
      const toleranceMs = claim.unit === "s" ? 1000 : 1000;
      const matched = claim.unit === "s"
        ? (catalog.epochSeconds.has(Math.floor(value / 1000)) || catalog.epochMillis.has(Math.round(value)))
        : catalog.epochMillis.has(Math.round(value));
      const near = catalog.epochs.some((item) => Math.abs(item.valueMs - value) <= toleranceMs);
      if (!matched && !near) {
        violations.push({
          claim: claim.raw, kind: claim.kind, claimed: claim.raw,
          expected: nearestEpochs(value), source: "execution_records",
          message: "时间戳与真实执行记录不一致。",
        });
      }
      continue;
    }

    if (claim.kind === "duration") {
      const value = claim.value!;
      // 只核验「执行尺度」的时长断言（≥10s），避免把寒暄里的短时长当成事实错误。
      if (value < 10_000) continue;
      const tolerance = Math.max(1000, Math.abs(value) * 0.005);
      const hit = catalog.durations.find((item) => Math.abs(item.valueMs - value) <= tolerance);
      if (!hit) {
        const closest = catalog.durations
          .slice()
          .sort((a, b) => Math.abs(a.valueMs - value) - Math.abs(b.valueMs - value))[0];
        violations.push({
          claim: claim.raw, kind: claim.kind, claimed: claim.raw,
          expected: closest ? `${formatMs(closest.valueMs)}（${closest.label}）` : "（无时长记录）",
          source: closest?.source ?? "execution_records",
          message: "时长与执行记录不一致。",
        });
      }
      continue;
    }

    if (claim.kind === "bytes") {
      if (!catalog.artifacts.length) continue;
      const value = claim.value!;
      const tolerance = Math.max(1024, Math.abs(value) * 0.01);
      const hit = catalog.artifacts.some((artifact) => Math.abs(artifact.sizeBytes - value) <= tolerance);
      if (!hit) {
        unverifiable.push({
          claim: claim.raw, kind: claim.kind, claimed: claim.raw,
          expected: catalog.artifacts.map((a) => `${a.name}=${a.sizeBytes}B`).join("；"),
          source: "artifact_registry",
          message: "文件大小与已登记产物不一致；未作为已验证事实。",
        });
      }
      continue;
    }

    if (claim.kind === "count") {
      const candidates = catalog.counts.filter((count) => count.category === claim.category && count.value > 0);
      if (!candidates.length) {
        unverifiable.push({
          claim: claim.raw, kind: claim.kind, claimed: claim.raw,
          expected: "（本轮无该类计数记录）", source: "evidence_set",
          message: "本轮没有该类可核验的计数记录。",
        });
        continue;
      }
      if (!candidates.some((count) => count.value === claim.value)) {
        violations.push({
          claim: claim.raw, kind: claim.kind, claimed: claim.raw,
          expected: candidates.map((count) => `${count.label}=${count.value}`).join("、"),
          source: "evidence_set",
          message: "数量断言与执行记录不一致。",
        });
      }
      continue;
    }
  }

  const verdict = violations.length ? "violations" : "pass";
  return { verdict, checkedClaims: claims.length, violations, unverifiable };
}

/** 确定性事实核验说明（前置到回答，绝不改写模型结论）。 */
export function buildFactAnnotation(result: FactVerificationResult): string | undefined {
  const lines: string[] = [];
  if (result.violations.length) {
    lines.push("【事实核验（确定性校验）】最终回答中的以下断言与真实执行记录不一致，不构成已验证事实：");
    for (const violation of result.violations) {
      lines.push(`- “${violation.claim}”：${violation.message} 真实值：${violation.expected}。`);
    }
  }
  if (result.unverifiable.length) {
    lines.push("【以下数值未能与执行记录对上，请勿作为已验证事实使用】：");
    for (const item of result.unverifiable) {
      lines.push(`- “${item.claim}”：${item.message}`);
    }
  }
  return lines.length ? lines.join("\n") : undefined;
}

export interface QuarantinedClaim {
  /** 被移出正文的原始片段（截断到 400 字符），仅用于审计与人工复核。 */
  segment: string;
  claim: string;
  expected: string;
  source: string;
  message: string;
}

/**
 * 把已被执行证据确定性证伪的断言从正文中移除。
 *
 * 只做删除与隔离，不改写数值：把错误数字「悄悄改成」正确数字会让读者
 * 以为模型本来就这么说。被移除的片段连同真实值一起进入隔离说明，
 * 同时调用方必须保留原始模型输出用于审计。
 */
export function sanitizeAnswerFacts(
  answer: string,
  result: FactVerificationResult
): { sanitized: string; quarantined: QuarantinedClaim[] } {
  if (!result.violations.length) return { sanitized: answer, quarantined: [] };

  const removed = new Set<string>();
  const quarantined: QuarantinedClaim[] = [];
  const splitSegments = (line: string): string[] =>
    // 段落内按句末标点切开；没有标点的行（表格行、列项）整体作为一段。
    line.split(/(?<=[。！？!?；;])\s*/).filter((part) => part.length > 0);

  for (const violation of result.violations) {
    const token = violation.claim.trim();
    let hit = false;
    for (const line of answer.split(/\n/)) {
      if (!token || !line.includes(token)) continue;
      hit = true;
      const parts = splitSegments(line);
      const offenders = parts.filter((part) => part.includes(token));
      if (offenders.length === parts.length) {
        removed.add(line);
        quarantined.push({ segment: line.trim().slice(0, 400), claim: violation.claim, expected: violation.expected, source: violation.source, message: violation.message });
      } else {
        for (const part of offenders) {
          removed.add(part);
          quarantined.push({ segment: part.trim().slice(0, 400), claim: violation.claim, expected: violation.expected, source: violation.source, message: violation.message });
        }
      }
    }
    if (!hit) {
      // 找不到原文（已在上一次重生成中被改写）时仍记录，避免断言悄悄消失。
      quarantined.push({ segment: "", claim: violation.claim, expected: violation.expected, source: violation.source, message: violation.message });
    }
  }

  const sanitized = answer
    .split(/\n/)
    .map((line) => {
      if (removed.has(line)) return "";
      const parts = splitSegments(line);
      if (parts.length <= 1) return removed.has(line) ? "" : line;
      return parts.filter((part) => !removed.has(part)).join("");
    })
    .join("\n")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { sanitized, quarantined };
}

/** 隔离说明：明确这些表述不构成结论，并给出被证伪断言的真实值。 */
export function buildQuarantineSection(quarantined: QuarantinedClaim[], unverifiable: FactViolation[] = []): string | undefined {
  const lines: string[] = [];
  if (quarantined.length) {
    lines.push("【未通过核验的原始表述（已从正文移除，不作为结论）】");
    for (const item of quarantined) {
      lines.push(`- “${item.claim}”：${item.message} 真实值：${item.expected}${item.segment ? `；原文片段：${item.segment}` : ""}`);
    }
  }
  if (unverifiable.length) {
    lines.push("【以下数值未能与执行记录对上，请勿作为已验证事实使用】：");
    for (const item of unverifiable) lines.push(`- “${item.claim}”：${item.message}`);
  }
  return lines.length ? lines.join("\n") : undefined;
}

/** 供「重新生成有依据的答案」使用：把权威事实压成简短清单。 */
export function describeFactsForRevision(catalog: FactCatalog): string {
  const parts: string[] = [];
  const epochs = catalog.epochs
    .filter((item) => item.source !== "derived")
    .slice(0, 16)
    .map((item) => `${item.label}=${Math.round(item.valueMs)}ms`);
  if (epochs.length) parts.push(`真实时间戳：${epochs.join("；")}`);
  const durations = catalog.durations
    .filter((item) => item.source !== "derived")
    .slice(0, 16)
    .map((item) => `${item.label}=${formatMs(item.valueMs)}`);
  if (durations.length) parts.push(`真实时长：${durations.join("；")}`);
  if (catalog.artifacts.length) {
    parts.push(`已核验产物：${catalog.artifacts.map((a) => `${a.name} sha256=${a.sha256} size=${a.sizeBytes}B`).join("；")}`);
  }
  const counts = catalog.counts.filter((count) => count.value > 0).map((count) => `${count.label}=${count.value}`);
  if (counts.length) parts.push(`真实计数：${counts.join("；")}`);
  return parts.join("\n");
}
