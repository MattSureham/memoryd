# memoryd 协议 1.2

本文说明当前 HTTP、MCP 和 CLI 接口。TypeScript 类型位于 [src/contracts.ts](../src/contracts.ts)，JSON Schema 位于 [schemas/memory-protocol-v1.schema.json](../schemas/memory-protocol-v1.schema.json)。当前协议版本为 `1.2`；Schema 文件名中的 `v1` 表示 major version，不表示 minor version。客户端应通过 handshake 校验精确版本和 capability。

## 1. 传输与约定

- 协议版本固定为字符串 `"1.2"`。
- Wire client 必须使用精确的 `1.2` 版本。旧数据库中的 `1.0`/`1.1` TurnPlan 会在解密读取边界迁移为 `1.2`；新增计划字段均有确定性运行时 fallback。其他持久化协议版本会以 `VERSION_CONFLICT` fail closed，并要求开启新 turn。这是本地存储迁移，不代表旧 wire protocol 兼容。
- HTTP 默认基址为 `http://127.0.0.1:7337`。
- MCP 使用 stdio；`memory-mcp` 通过 HTTP 调用已启动的 daemon。
- JSON request body 最大 2 MiB。
- 若设置 `MEMORYD_TOKEN`，所有 HTTP 路由都要求 `Authorization: Bearer <token>`；MCP client 从同一环境变量读取 token。
- 时间字段使用 ISO 8601 datetime；cursor 是不透明、query-bound 的 keyset token。
- 可重试写入必须提供稳定且非空的 `idempotencyKey`。

HTTP 成功时直接返回业务对象，不包 `data`。错误统一为：

```json
{
  "error": {
    "code": "STAGE_BLOCKED",
    "message": "reexperience recall is blocked until current evidence is checkpointed",
    "details": {}
  }
}
```

MCP 成功结果同时提供 JSON 文本 `content` 和 `structuredContent.result`；失败返回 `isError:true`，文本中是相同错误结构。

## 2. 核心标识

### 2.1 ScopeRef

```ts
interface ScopeRef {
  userId: string;
  workspaceId?: string;
  sessionId?: string;
  branch?: string;
  commit?: string;
}
```

scope 不是认证凭证。hook adapter 默认使用 `MEMORYD_USER_ID`（未设置时为 `local-default`），并用 Git remote 或真实路径与主密钥的 HMAC 生成 workspace ID。

ACL 语义：

- user ID 必须相同；
- 当前 workspace 可读同 workspace 和 user-scoped 记录；没有 workspace 时只能读 user-scoped 记录；
- WorldClaim、Policy 的 session scope 只对同 session 可见；
- Episode 和 SourceEvent 可在同 workspace 跨 session 召回；
- `begin_turn` 和 SessionEnd 必须有 session ID；结束后的 session ID 不能重新 begin。

### 2.2 AgentProfile

```ts
interface AgentProfile {
  family: string;
  version: string;
  model?: string;
  toolsetDigest?: string;
  capabilities: {
    hooks: boolean;
    stageGates: boolean;
    maxContextTokens?: number;
    modalities?: string[];
  };
}
```

profile key 为 `family:version:model-or-unknown:toolsetDigest-or-unknown`。Calibration 只作用于完全相同的 profile key。只有 `hooks` 和 `stageGates` 都为真时，TurnPlan 标记为 `enforced`；否则为 `advisory`。

### 2.3 SourceRef

```ts
interface SourceRef {
  eventId: string;
  sessionId: string;
  contentHash: string;
  capturedAt: string;
  workspaceId?: string;
  startOffset?: number;
  endOffset?: number;
  path?: string;
  commit?: string;
}
```

WorldClaim、Episode、Policy、correction 和 Re-experience 内容用 SourceRef 绑定来源。存储层会核对 event、session、workspace、hash、captured time 和 offset；不匹配返回 `VERSION_CONFLICT`。`memory_get_sources` 展开的内容已经脱敏，仍必须视为不可信证据。

## 3. 标准调用顺序

```text
memory_begin_turn
       │
       ├─ TurnPlan: risks + Policy schedule + retrieval strategy
       ▼
   gate.required ?
       │ yes
       ▼
读取当前文件/图片/测试/命令
memory_checkpoint_evidence
       │
       ▼
memory_retrieve（推荐）或 memory_recall（兼容）
       │
       ├─ 完整工作集 → memory_build_workset
       ├─ sourceRefs → memory_get_sources
       ├─ 用户纠错 → memory_submit_correction
       ▼
memory_complete_turn
       │
       └─ host lifecycle/wrapper → POST /v1/sessions/end
```

当 gate required 且未 satisfied 时，`world`、`episode`、`reexperience` 和 `source_expansion` 返回 `STAGE_BLOCKED`。`policy` 与 `current_evidence` 不受该 gate 阻塞。

## 4. MCP 工具

MCP 暴露八个模型侧工具。approve、revoke、forget、Curator、export/import、reindex、显式学习和 Calibration 退休只存在于 `memoryctl`。

### 4.1 `memory_begin_turn`

MCP 输入是扁平结构：

| 字段 | 必需 | 说明 |
|---|---:|---|
| `content` | 是 | 当前可见输入 |
| `idempotencyKey` | 是 | 本轮稳定幂等键 |
| `kind` | 否 | 默认 `user_message` |
| `attachments` | 否 | `{uri,mediaType?,contentHash?}[]` |
| `metadata` | 否 | JSON object |
| `scope` | 是 | 含 session ID 的 `ScopeRef` |
| `agentProfile` | 是 | `AgentProfile` |

返回 `TurnPlan`。服务端先保存输入，再从当前输入特征、Agent profile、Calibration 和结构化 Trigger 识别风险；此步骤不会读取领域 Episode。Trigger 的相似度是辅助信号，结构条件不匹配时不能激活。

### 4.2 `memory_checkpoint_evidence`

```ts
{
  turnId: string;
  observations: Array<{
    observationId?: string;
    kind: "current_file" | "image" | "test" | "command" | "user_statement";
    content: string;
    source?: Partial<SourceRef>;
    metadata?: Record<string, unknown>;
  }>;
}
```

至少一条 observation。服务端为每条观察创建选中证据的 checkpoint SourceEvent，并返回：

```ts
interface CheckpointEvidenceResult {
  plan: TurnPlan;
  observations: Array<{
    observationId: string;
    kind: Observation["kind"];
    source: SourceRef;
  }>;
  evidenceRefs: SourceRef[];
}
```

结果不回显 observation content。完全相同的 turn + observations 重试会从幂等 trace 返回首次结果。

### 4.3 `memory_recall`

```ts
{
  turnId: string;
  stage:
    | "policy"
    | "current_evidence"
    | "world"
    | "reexperience"
    | "episode"
    | "source_expansion";
  query: string;
  budgetTokens?: number; // MCP 最大 8000
  cursor?: string;
  recentTurns?: number;  // 仅 reexperience；20..50
}
```

返回 `MemoryBundle`。只允许请求 TurnPlan 中存在的 stage；budget 在 runtime 中规范化为 512–8000，默认 8000。

领域 stage 使用 TurnPlan 冻结的 `retrievalStrategy` 融合 BM25、本地 embedding、实体、时间和 thread 信号，再按来源与 evidence facet coverage 重排。缺失信号会确定性降级，并在 `trace.strategies` 中以 `degraded:*` 标记。

### 4.4 `memory_retrieve`

协议 1.2 的推荐领域记忆入口：

```ts
interface RetrieveMemoryInput {
  turnId: string;
  query: string;
  budgetTokens?: number; // 最大 8000
  limit?: number;        // 最大 80，仍受服务端配置收紧
  includeArchive?: boolean;
}
```

服务端按以下顺序执行 Query Analysis、Risk Recognition、Memory Object/Partition 路由、局部成员展开、必要的 Episode/Raw Evidence 展开、冲突与证据覆盖检查。它返回结构化 `MemoryRetrievalResult`，明确区分 direct、derived、inferred 和 unresolved contradiction，并给出 `shouldAbstain`。

事实、原话或冲突问题会要求 raw depth；普通分析默认只加载 Object。cold 只有精确 key 命中才参与，archive 需要 `includeArchive:true` 或明确的回溯查询。未通过 TurnPlan gate 时仍返回 `STAGE_BLOCKED`。

同一 turn、query、snapshot 和 archive 选项生成稳定 retrieval ID；trace 会持久化路由对象、分区、阶段候选数、展开深度和 evidence coverage。

### 4.5 `memory_build_workset`

```ts
{
  turnId: string;
  query: string;
  budgetTokens?: number; // 最大 8000
  recentTurns?: number;  // 20..50，默认 32
  cursor?: string;
}
```

这是 gated `reexperience` stage 的便利工具，返回同一个 `MemoryBundle` 类型并填充 `reexperiencePack`。工作集在预算内包含：

- 最近 completed turn 的输入/输出原始事件；
- 选中的完整叙事 Episode 及其原始事件；
- checkpoint、纠错等关键事件；
- 带情绪线索的事件；
- active/disputed WorldClaim 事实约束。

Episode 只会完整选入，不会按 token 截断 event range。所有原文仍是不可信证据。

### 4.6 `memory_get_sources`

```ts
{
  turnId: string;
  sourceRefs: SourceRef[]; // 1..50
}
```

返回完整脱敏 `SourceEvent[]`。除了校验完整 SourceRef，event ID 还必须由当前 turn 的 checkpoint、冻结活动 Policy 来源或已落盘 recall/retrieve trace 授权。仅知道同 workspace 的 event ID 会得到 `SCOPE_DENIED`。

recall trace 可授权 bundle 中的直接 source refs、WorldClaim/conflict、Episode、Policy、counterexample 和 Re-experience pack 来源；retrieve trace 可授权所选 item 的 evidence refs。该工具不接受调用方重写 hash。

### 4.7 `memory_submit_correction`

```ts
{
  turnId: string;
  kind: "fact" | "behavior" | "unknown";
  wrongStatement?: string;
  correction: string;
  subject?: string;
  predicate?: string;
  value?: unknown;
  scopeLevel?: "user" | "workspace" | "session";
  explicit: boolean;
  idempotencyKey: string;
  origin?: "user_correction" | "self_reflection";
}
```

可能结果：

- `world_claim_active`：显式完整事实纠错；
- `world_claim_disputed`：存在晚于 turn snapshot 的并发事实版本；
- `policy_active`：显式行为要求；
- `policy_candidate`：非显式行为推断；
- `correction_candidate`：其他情况。

省略 fact scope 时，有 workspace 则默认 workspace，否则默认 user。显式 behavior 默认 session；非显式 behavior 默认 workspace（没有 workspace 时 user），以支持跨 session 聚类。服务端不会扩大调用方显式请求的 scope。

非显式 behavior 会创建 candidate Policy、FailureCluster 和 learning job。只有至少 3 个独立 `user_correction`、覆盖 2 个 session、且非实体特定的 cluster 才能生成 Trigger candidate 和 Calibration shadow；`self_reflection` 可以留下候选和反例，但不计阈值。学习 Policy 仍须管理 CLI 人工批准。

### 4.8 `memory_complete_turn`

```ts
{
  turnId: string;
  response: string;
  idempotencyKey: string;
  evidenceRefs: SourceRef[];
  verifierResult?: VerifierResult;
}
```

返回：

```ts
{
  turnId: string;
  eventId: string;
  verifier: VerifierResult;
  retryAllowed: boolean;
}
```

服务端只接受本 turn 已授权的 evidence refs。外部 `verifierResult` 只能补充问题或收紧结果，不能用 `pass` 清除 deterministic floor。最多 retry 一次；最终完成后，runtime 会按叙事边界合并或创建 Episode，并入队 session segmentation job。

complete 的事件、turn 更新、Episode 和结果 trace 在一个 SQLite transaction 中提交。相同 turn + idempotencyKey 重试原样返回首次结果。

## 5. HTTP API

HTTP 与 MCP 共享同一 runtime。MCP begin 输入是扁平结构，HTTP begin 使用完整 `BeginTurnInput`。

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| `GET` | `/v1/health` | 无 | protocol、SQLite、FTS、revision、learning job 健康信息 |
| `POST` | `/v1/handshake` | 任意/空 JSON | 版本、transport 和 capability |
| `POST` | `/v1/events` | `RecordEventInput` | `201 SourceEvent` |
| `POST` | `/v1/turns/begin` | `BeginTurnInput` | `201 TurnPlan` |
| `POST` | `/v1/turns/:id/checkpoint` | `CheckpointEvidenceInput` | `200 CheckpointEvidenceResult` |
| `POST` | `/v1/turns/:id/recall` | `RecallInput` | `200 MemoryBundle` |
| `POST` | `/v1/turns/:id/retrieve` | `RetrieveMemoryInput` | `200 MemoryRetrievalResult` |
| `POST` | `/v1/turns/:id/workset` | `BuildWorksetInput` | `200 MemoryBundle` |
| `POST` | `/v1/sources/get` | `{turnId,sourceRefs}` | `200 SourceEvent[]` |
| `POST` | `/v1/turns/:id/corrections` | `CorrectionInput` | `201` correction result |
| `POST` | `/v1/turns/:id/complete` | `CompleteTurnInput` | `200 CompleteTurnResult` |
| `POST` | `/v1/sessions/end` | `EndSessionInput` | `200 EndSessionResult` |

带 `:id` 的路径要求 path turn ID 与 body `turnId` 完全相同。

`/v1/events` 和 `/v1/sessions/end` 是 adapter-only，没有对应 MCP 工具。前者允许可信 hook 标记 `selectedEvidence`；未选中的 `tool_call/tool_result` 正文会在进入权威存储前丢弃，只保留白名单 metadata 和 SHA-256 摘要。Claude Code 可从原生 `SessionEnd` 调用后者；Codex 当前没有该 hook 事件，需由外层 wrapper 在确知会话结束时调用。

SessionEnd：

```ts
interface EndSessionInput {
  scope: ScopeRef & { sessionId: string };
  endedAt?: string;
  idempotencyKey: string;
}

interface EndSessionResult {
  sessionId: string;
  endedAt: string;
  expiredPolicyCount: number;
  closedEpisodeIds: string[];
}
```

它关闭 session 和最后一个叙事 Episode，并让同一 session ID 后续 begin 失败。`expiredPolicyCount` 是该 session 内 Policy 数量；这些 Policy 不会被物理删除或跨 session 加载。

handshake 当前返回：

```json
{
  "protocolVersion": "1.2",
  "transports": ["http", "mcp-stdio", "cli"],
  "maxRecallTokens": 8000,
  "supports": {
    "stageGates": true,
    "encryptedExport": true,
    "continuousSync": false,
    "hybridRetrieval": true,
    "reexperienceWorkset": true,
    "triggerLearning": true,
    "sessionLifecycle": true,
    "objectRoutedRetrieval": true,
    "dynamicMemoryCurator": true
  }
}
```

## 6. TurnPlan

| 字段 | 含义 |
|---|---|
| `protocolVersion` | 固定 `1.2` |
| `turnId` | 当前 turn 稳定 ID |
| `snapshotRevision` | 计划创建时的权威 revision；领域召回上界 |
| `memoryGeneration` | 对象/关系/温度等可演化记忆发生变化时推进的 generation |
| `agentProfileKey` | Calibration 隔离键 |
| `risks` | 每类风险的最终概率及 rule/classifier/calibration/trigger contributions |
| `modes` | evidence、uncertainty、source、clarification、narrative 强度 |
| `retrievalStages` | 根据主风险排序的 stage；含 checkpoint gate 标记 |
| `gate` | evidence checkpoint 是否 required/satisfied 及原因 |
| `activePolicies` | 当前真正加载的 approved Policy 与被拉入的依赖 |
| `policySchedule` | 可选扩展；L1/L2/L3/Archive 及 dependency error |
| `retrievalStrategy` | 可选扩展；风险、步骤、五路权重、coverage 和安全开关 |
| `enforcementLevel` | `enforced` 或 `advisory` |
| `retryCount` | verifier retry 次数，最多 1 |
| `createdAt` | 计划创建时间 |

风险聚合使用最大值而不是平均值。Policy schedule 是对所有最新 Policy 的可观测调度结果；只有 `shouldLoad` 的项目进入 `activePolicies`。Policy 本体不衰减，Trigger priority 只影响 tier，当前条件命中会直接提升到 L1。

## 7. MemoryBundle

| 字段 | 含义 |
|---|---|
| `snapshotRevision` | TurnPlan revision 上界 |
| `indexRevision` | 当前派生索引 revision |
| `stage` | 本次请求 stage |
| `worldClaims` | 命中的事实；每条含 `sources` |
| `episodes` | 命中的完整叙事片段；每条含 `eventRefs`，可含 turn/topic/boundary/salience/emotion |
| `sourceRefs` | 当前 stage 授权的来源引用 |
| `policies` | policy stage 冻结的活动 Policy |
| `counterexamples` | 当前 scope 最近最多 10 条带来源 behavior correction |
| `conflicts` | 当前 scope/snapshot 的 disputed WorldClaim |
| `reexperiencePack` | reexperience/workset stage 的近期、历史、关键、情绪原文及事实约束 |
| `sourceCoverage` | 返回候选的平均独立来源覆盖 |
| `trace` | query、策略、候选/返回数、cursor、strategy ID、实际信号和 coverage rerank |
| `untrustedEvidenceNotice` | 固定的不可信历史证据提示 |

`reexperiencePack` 的核心字段：

```ts
interface MemoryReexperiencePack {
  recentSourceRefs: SourceRef[];
  recentEvents: SourceEvent[];
  historicalEpisodes: EpisodeMemory[];
  historicalEvents: SourceEvent[];
  keyEventRefs: SourceRef[];
  keyEvents: SourceEvent[];
  emotionalEventRefs: SourceRef[];
  emotionalEvents: SourceEvent[];
  factConstraints: WorldClaim[];
  window: {
    requestedTurns: number;
    includedTurns: number;
    startedAt?: string;
    endedAt?: string;
  };
}
```

## 8. MemoryRetrievalResult

```ts
interface MemoryRetrievalResult {
  protocolVersion: "1.2";
  retrievalId: string;
  turnId: string;
  query: string;
  strategy: string;
  riskProfile: {
    factualRecall: boolean;
    quoteRecall: boolean;
    entityConfusion: boolean;
    temporalConfusion: boolean;
    contradictionRisk: boolean;
    narrativeCompletionRisk: boolean;
    lowEvidenceRisk: boolean;
    inferenceAllowed: boolean;
    retrievalDepth: "object" | "episode" | "raw";
    topK: number;
    confidenceLanguage: "normal" | "qualified" | "strict";
  };
  analysis: {
    entities: string[];
    topics: string[];
    temporalHints: string[];
    taskType: "factual_recall" | "quote_recall" | "analysis" | "general";
    explicitArchiveLookup: boolean;
  };
  memories: Array<{
    memoryId: string;
    memoryType: "raw" | "episode" | "semantic" | "object";
    content: string;
    score: number;
    confidence: number;
    evidenceRefs: SourceRef[];
    sourceType: "direct" | "derived" | "inferred" | "unresolved_contradiction";
    timestamp?: string;
    contradictions?: string[];
    objectId?: string;
    partitionId?: string;
  }>;
  unresolvedQuestions: string[];
  unresolvedContradictions: Contradiction[];
  evidenceCoverage: number;
  shouldAbstain: boolean;
  trace: RetrievalTrace;
  untrustedEvidenceNotice: string;
}
```

`content` 是便于调用方消费的脱敏文本，但可信类别由 `sourceType` 决定。Object、Episode 和 Semantic item 的 `content` 都是派生定位信息；高风险事实回答应引用同一结果中的 raw/direct item 或继续用 `memory_get_sources` 展开已授权 refs。

`evidenceCoverage` 衡量返回派生记忆所需 refs 中可在当前 scope/snapshot 解析的比例。事实/quote/冲突 recall coverage 低于配置阈值、raw depth 没有 direct item、或 unresolved contradiction 没有 preferred claim 时，`shouldAbstain` 为 true。

`RetrievalTrace` 除阶段候选数外还包含 `routedPartitionIds`、`routedObjectIds`、`returnedMemoryIds` 和 `returnedObjectIds`。前两者表示 coarse route 访问过的局部工作集，后两者表示预算和风险排序后实际交给调用方的内容；Curator 只在达到配置的最低样本数后，才用二者计算 query-hit dispersion 与 local-use ratio。

## 9. VerifierResult

```ts
interface VerifierResult {
  status: "pass" | "retry" | "clarify" | "abstain";
  sourceCoverage: number;
  policyViolations: string[];
  unsupportedClaims: string[];
  conflicts: string[];
  message?: string;
}
```

内置 verifier 汇总调用方报告的问题，并额外检测少量“according to memory / I remember / 我记得”等无 evidence 表达。它不会自行全面理解自然语言 Policy、冲突或 unsupported claim。最终 status 由合并问题后的 deterministic verifier 重算，外部结果只能收紧。

## 10. 管理 CLI 与慢速学习

```text
memoryctl start | stop | doctor | replay | learn --once
memoryctl curate [scan|temperature|archive|reorganize|integrity_check|quality|reindex] [--dry-run]
memoryctl curate merge --object <id> --object <id> [--force] [--dry-run]
memoryctl curate split --object <id> [--dry-run]
memoryctl curate rename --object <id> --title <text> [--routing-key <key>] [--dry-run]
memoryctl curate process | curate jobs
memoryctl curate rollback <action-id> [--idempotency-key <key>]
memoryctl inspect [id] [--all]
memoryctl approve <policy-id> | revoke <policy-id>
memoryctl calibration retire <pattern-id>
memoryctl forget <entity-type> <entity-id> --reason <text>
memoryctl export <file> [--passphrase <text>]
memoryctl import <file> [--passphrase <text>]
memoryctl reindex
memoryctl install <claude|codex|all> [--scope user|project]
```

- `learn --once` 为当前 scope 的 reviewed/promoted cluster 入队并立即处理学习 job。
- `curate scan` 增量执行对象 ingest、merge/split 建议、温度、完整性和质量检查；`--dry-run` 只持久化 job/计划/audit，不改记忆对象。
- `curate merge/split/rename` 是显式维护接口；可逆 action 用 `curate rollback` 恢复内容并创建新的 restore 版本。
- `curate jobs` 查看持久任务与审计；`curate process` 手工消费队列。
- `inspect --all` 还包含 Partition、MemoryObject、Contradiction、Temperature、maintenance job 和 audit；`--all` 不绕过 scope ACL。
- `approve` 强制检查学习阈值和 dependency cycle，并激活关联 Trigger；`revoke` 退休关联 Trigger。
- `calibration retire` 停止指定 active/shadow pattern。
- `reindex` 重建 FTS/source link，并重建 narrative Episode、embedding bucket 和 entity index。

daemon 按 `MEMORYD_LEARNING_INTERVAL_MS`（默认 5000 ms）处理 learning job，并按 `MEMORYD_CURATOR_INTERVAL_MS`（默认 15000 ms）处理 maintenance job。该管理面不应无条件暴露给模型。

## 11. 错误与 HTTP 映射

| code | HTTP | 典型原因 |
|---|---:|---|
| `INVALID_REQUEST` | 400 | schema、path/body、cursor 或不合法操作 |
| `TURN_NOT_FOUND` | 404 | turn 不存在 |
| `NOT_FOUND` | 404 | source 或依赖不存在 |
| `SCOPE_DENIED` | 403 | ACL 或 source 未经本 turn 授权；Bearer 失败为 401 |
| `STAGE_BLOCKED` | 409 | checkpoint 前请求 gated stage |
| `VERSION_CONFLICT` | 409 | 幂等键复用、SourceRef 不匹配、session 已结束、同 ID 不同内容 |
| `MEMORY_UNAVAILABLE` | 通常 500 | 未映射服务端错误；client 也用它包装非协议 HTTP 错误 |

HTTP validation 由 Zod 执行，错误 details 含 issues。MCP 把相同业务错误编码为 tool error，不改变协议 code。

## 12. 一致性、分页和降级

- `snapshotRevision` 冻结 turn 可见上界；current evidence 是允许晚于 snapshot 的本 turn 例外。它不是任意时间点的完整 MVCC query。
- cursor 是 stable rank tuple 的 keyset token，绑定 snapshot、retrieval strategy 和 query 摘要；跨 query/stage/plan 复用返回 `INVALID_REQUEST`。
- 历史 source、Episode 和 Re-experience 必须作为 quoted/untrusted evidence；只有 `activePolicies` 是记忆侧行为规则。
- 当前 evidence、源码和实时工具结果优先于历史内容。真正采用的已授权来源应进入 `complete_turn.evidenceRefs`。
- checkpoint、correction 和 complete 的多表写入各自在 transaction/savepoint 中提交，并用确定性 trace 幂等。
- classifier 失败时规则、Calibration 和 Trigger 继续；embedding/实体信号失败时 recall 用剩余信号重新归一化并在 trace 标记降级。
- daemon/MCP 失败时 hook 允许普通任务继续，但提示不得声称召回成功；payload 进入加密 hook spool，由后续 SessionStart 或 `memoryctl replay` 顺序重放。
- 不支持 hooks/stage gates 的 Agent 应把 capability 设为 false，并按 advisory TurnPlan 自行编排。
- v1 没有版本范围协商；通过 handshake 检查精确 `protocolVersion` 和 capability。

连续同步仍未实现。加密 export/import 是管理工作流，不保证全包原子性或 workspace scope 自动重映射。
