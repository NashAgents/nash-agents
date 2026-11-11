# 单节点 Run 结束自动学习与 Skill 沉淀

本文描述 Nash Agents 单节点 Agent Loop 正常结束后，如何由模型判断是否沉淀长期记忆与可复用 Skill。跨节点联邦记忆与 A2A 不在本文范围内。

## 1. 触发时机

- 触发点：`src/runtime/agent-loop.ts` 的 `completeRun()`，即一轮 Agent Loop 正常产生最终答案之后。
- 只有正常完成的 Run 会触发；`isError=true` 的 Run 直接跳过。
- 学习环节同步执行，最多 **1 次** 学习模型调用。默认单次超时 20 秒，可通过 `AgentLoopOptions.learningTimeoutMs` 覆盖。
- 采用同步执行而不是后台 Promise，原因是避免会话结束、进程退出或任务取消后仍向错误的项目/会话写入。代价是最终 Run 返回会额外等待一次有界模型调用。
- 学习失败只产生可观察的失败记录，不抛出、不改变主任务的最终答案。

## 2. 开关与显式保存

| 配置/入口 | 行为 |
| --- | --- |
| `settings.json` → `memory.autoLearn=false` | 跳过自动记忆提炼，不调用学习模型中的记忆部分 |
| `settings.json` → `skills.autoGenerate=false` | 跳过自动 Skill 生成；用户在本轮显式要求“保存成 skill”时仍允许 |
| `settings.json` → `memory.enabled=false` 或 `skills.enabled=false` | 对应子系统完全关闭 |
| `remember` 工具 / CLI `/remember` | 不受自动学习开关影响，始终可用 |
| 用户显式“保存成 skill，叫 xxx” | 即使 `autoGenerate=false`，只要 Skills 子系统启用，仍会结合本轮真实上下文生成 |
| 环境变量 `NASH_DISABLE_AUTO_LEARNING=1` | 测试/运维紧急关闭自动学习；显式注入 `learningModelCaller` 时仍允许验证学习链路 |

当自动记忆和自动 Skill 都关闭，且用户没有显式 Skill 请求时，不会调用学习模型。

## 3. 有界模型输入

学习上下文由 `src/learning/learning-context.ts` 构建，总量硬预算为 `MAX_LEARNING_PROMPT_CHARS = 16_000` 字符（system + user 合计，约 4k–10k tokens，取决于中英文占比）。

输入包含：

- Run 元数据：session id、run id、项目名与项目根路径、agent id、记忆/Skill 持久化开关。
- 显式用户信号：是否出现“记住/沉淀”、纠正语气、显式 Skill 请求、用户是否提到“全局/跨项目”。
- 用户请求。
- 必要的近期对话（user/assistant 文本，最多 6 条）。
- 实际工具调用与实际结果（最多 12 条，保留头尾并标注原始长度）。
- 验证证据：测试命令与结果、本轮成功修改的文件。
- 最终回复。
- 现有活跃记忆摘要（最多 10 条），用于避免重复。
- 现有 Skill 名称与描述（最多 12 条），用于避免同名冲突。

裁剪策略：

- 单条工具输出保留头尾，并插入 `...[truncated N chars; original M chars]...` 标记。
- 超出总预算时，按“现有 Skill → 现有记忆 → 近期对话 → 工具调用数量 → 工具输出长度 → 最终回复 → 用户请求”的顺序逐步收缩。
- 用户请求、最终回复和验证证据优先保留。
- 上下文中的文本会先经过现有凭据净化逻辑，避免把密钥/令牌发送给学习模型。

## 4. 模型输出结构

模型必须只返回一个 JSON 对象：

```json
{
  "decision": "none | memory | skill | both",
  "memories": [
    {
      "content": "1-2 句话的自包含事实",
      "kind": "fact | preference | architecture | environment | decision | lesson",
      "scope": "global | project",
      "basis": "user-explicit | user-correction | verified-runtime | verified-code",
      "confidence": 0.9,
      "evidence": "用户原话、工具结果、文件或测试的具体引用",
      "tags": ["optional"]
    }
  ],
  "skill": {
    "name": "lowercase-kebab-case",
    "description": "用途",
    "whenToUse": "适用条件",
    "procedure": "1. 具体步骤\n2. ...\n3. ...",
    "verification": "可执行的验证方式或可观察验收标准",
    "limitations": "不适用场景、前置条件、已知限制",
    "scope": "project | global",
    "evidence": "本轮证明该流程有效的证据"
  },
  "notes": "可选说明"
}
```

`decision=none` 时 `memories` 必须为空、`skill` 必须为 `null`。

## 5. 严格校验

`src/learning/learning-analyzer.ts` 在写入前逐项校验：

### 5.1 依据（basis）

- `user-explicit`：必须在用户请求中找到显式记忆指令，或证据/内容与用户原话有足够重合。
- `user-correction`：必须存在真实纠正语气，且证据与用户原话重合。
- `verified-runtime`：必须有测试结果或成功命令执行，且证据能对应到实际命令/测试输出。
- `verified-code`：必须检查/修改过文件，或存在成功的文件工具调用，且证据能对应到实际文件/工具结果。
- **不接受** `agent-learned`/`inferred`：模型推测不会被写成长期事实。

### 5.2 内容安全

直接拒绝：

- 检测到的 API Key、Token、密码、Cookie、私钥，或已被净化为 `[REDACTED_SECRET]` 的内容。
- 临时状态：PID、端口、`localhost`、`127.0.0.1`、`/tmp/`、临时目录、session/run id、ISO 时间戳、进度百分比。
- 明显推测语言：可能、似乎、也许、猜测、maybe、probably 等。
- 置信度低于 0.5 的候选。

### 5.3 作用域

- `global`：
  - 记忆仅允许 `kind=preference` 且依据为 `user-explicit`/`user-correction`。
  - 其他 `global` 记忆在存在项目作用域时**保守降级为 project**，并记录 warning；没有项目作用域时跳过。
  - Skill 只有在用户显式要求且提到“全局/跨项目”时才允许 `global`。
- `project`：
  - 必须有项目作用域；否则跳过。
  - 自动 Skill 默认 project。
- 缺失作用域时：记忆默认 project（有项目作用域时），Skill 默认 project。
- 非法作用域字符串直接拒绝。

### 5.4 证据不足

- 记忆必须有非空 `evidence`。
- Skill 必须同时满足：
  - 至少 2 次成功工具调用，或 1 次成功命令 + 通过测试，或 2 个已验证文件；
  - `evidence` 能对应到本轮实际工具结果、文件或测试；
  - `procedure` 至少 2–3 个具体步骤，不是“检查状态、修改、测试”的空泛模板；
  - `verification` 非空；
  - 不包含临时路径、PID、时间戳等一次性信息。
- 没有任何候选通过校验时，本轮不写入任何内容。

### 5.5 顶层一致性

- `decision=none` 时忽略任何候选并记录 warning。
- `decision=memory` 时忽略 skill；`decision=skill` 时忽略 memories。
- `decision=both` 时两者都校验；缺失的一方不会伪造。
- JSON 无法解析、`decision` 非法、`memories` 不是数组、`skill` 不是对象/null 时整次学习失败，不写入任何内容。

## 6. 记忆写入与去重

写入统一调用 `MemoryService.remember()`，继续复用 `MemoryWriter` 的：

- 相似内容强化（相似度 ≥ 0.85）；
- 冲突主题检测与 supersede；
- 来源优先级（user-explicit > user-correction > verified-* > agent-learned）；
- 凭据净化。

自动学习额外增加两道保守保护：

1. 与现有活跃记忆相似度 ≥ 0.95 且现有来源优先级不低于新候选时，直接跳过，保证同一轮重复处理幂等。
2. 若候选与现有记忆构成冲突主题，且现有记忆来源优先级**严格更高**，跳过，避免自动内容覆盖用户明确偏好。

来源按 basis 映射，不会把所有自动内容都标记为 `user-explicit`。

## 7. Skill 写入与同名冲突

- 生成内容包含：`description`、`whenToUse`、`procedure`、`verification`，以及可选的 `limitations` 段落。
- 同名 Skill 已存在时：
  - 内容完全相同：跳过（幂等）。
  - 自动生成且内容不同：**跳过，不覆盖**，在结果中记录 `skillSkippedReason`。
  - 用户显式要求同名 Skill 且内容不同：创建版本化名称（`name-v2`、`name-v3`…），原 Skill 保持不变。
- `SkillWriter.createSkill()` 默认拒绝覆盖同作用域已存在的 Skill，并抛出 `SkillConflictError`。只有调用方显式传入 `overwrite: true` 才允许替换。

## 8. 失败处理与可观察性

`RunLearningHook.processRun()` 内部捕获所有异常，返回 `RunLearningResult`：

```ts
{
  status: "skipped" | "completed" | "partial" | "failed",
  memoriesLearned: MemoryEntry[],
  skillsCreated?: SkillMetadata[],
  skillSkippedReason?: string,
  skippedReason?: string,
  failures: LearningFailure[],
  warnings?: LearningWarning[],
  rejections?: LearningRejection[],
  modelUsed?: string,
  promptChars?: number
}
```

- `failures[].stage`：`context`、`model`、`parse`、`validation`、`memory-write`、`skill-write`。
- 通过 EventBus 发出 `learning.completed`、`learning.failed`、`learning.skipped`，包含失败、警告、拒绝原因、写入数量与模型输入字符数。
- 只有实际由 `MemoryService`/`SkillService` 返回的条目才会进入 `memoriesLearned`/`skillsCreated`；解析失败不会被声称保存成功。
- 学习失败不会改变 `runAgentLoop()` 的最终答案或成功状态。

## 9. 已知局限

- 证据对应是**轻量词元/字符串匹配**，不是语义事实核验；它只能降低幻觉写入概率，不能证明候选一定正确。
- 作用域判断依赖模型输出 + 保守规则；模型仍可能给出错误分类，规则会在不明确时降级或跳过。
- 学习上下文有硬预算，超长 Runs 的早期工具结果会被省略（上下文中有省略说明）；完整原始记录仍在 session/spill 存储中。
- 学习模型判断受模型能力影响；没有确定性 fallback 会自动写入内容，因为把规则猜测写成长期记忆的风险更高。
- 同步执行会增加一次有界模型调用的延迟；当前不做后台执行，以避免跨会话/跨项目写入与进程退出时的 Promise 泄漏。
- 不修改跨节点联邦记忆或 A2A 流程。

## 10. 相关测试

`test/learning-auto-distillation.test.ts` 使用可注入假模型覆盖：

- 用户明确的全局偏好；
- 仅适用于当前项目的事实；
- 临时信息、不确定推测、敏感凭据不保存；
- 有充分证据生成项目 Skill；
- 工作流证据不足不生成 Skill；
- 同名 Skill 不静默覆盖，显式请求时版本化；
- 模型返回空结果、非法 JSON、非法作用域、模型调用失败；
- 自动学习关闭时显式 `remember` 仍可用；
- 自动 Skill 关闭时显式 Skill 请求仍可用；
- 同一轮反复处理幂等；
- 学习失败不影响主任务最终答案；
- 超长上下文遵守输入预算与可追溯裁剪。
