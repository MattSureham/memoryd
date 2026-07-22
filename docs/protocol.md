# memoryd 协议 1.0

本文是当前 HTTP 与 MCP 实现的使用说明。TypeScript 类型位于 `src/contracts.ts`，JSON Schema 位于 `schemas/memory-protocol-v1.schema.json`。

## 1. 传输与约定

- 协议版本固定为字符串 `"1.0"`。
- HTTP 默认基址：`http://127.0.0.1:7337`。
- MCP 使用 stdio；`memory-mcp` 通过 HTTP 调用已启动的 daemon。
- JSON request body 最大 2 MiB。
- 若设置 `MEMORYD_TOKEN`，所有 HTTP 路由都要求 `Authorization: Bearer <token>`；MCP client 会从同一环境变量读取 token。
- 时间字段使用 ISO 8601 datetime；cursor 是不透明字符串。
- 调用方必须为可重试写入提供稳定且非空的 `idempotencyKey`。

HTTP 成功时直接返回业务对象，不包 `data`。错误统一为：

```json
{
  "error": {
    "code": "STAGE_BLOCKED",
    "message": "episode recall is blocked until current evidence is checkpointed",
    "details": {}
  }
}
```

MCP 成功结果同时提供 JSON 文本 content 和 `structuredContent.result`；失败返回 `isError: true`，文本中是相同的错误结构。

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

作用域不是认证凭证。hook adapter 默认使用 `MEMORYD_USER_ID`（未设置时为 `local-default`），并用 Git remote 或真实路径与主密钥的 HMAC 生成 workspace ID。事件必须有 session ID；user/workspace 级 claim 和 policy 可以没有 session ID。

ACL 语义：

- user ID 必须相同；
- 当前 workspace 可读取同 workspace 和 user-scoped 记录；
- 未提供 workspace 时只读取 user-scoped 记录；
- World/Policy 的 session-scoped 记录只对同 session 可见；Episode 和 SourceEvent 可在同 workspace 跨 session 召回。

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

profile key 为 `family:version:model-or-unknown:toolsetDigest-or-unknown`。只有 `hooks` 和 `stageGates` 同时为真时，TurnPlan 标记为 `enforced`；否则为 `advisory`。

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

World claim、Episode 和 correction 使用 `SourceRef` 绑定来源。存储层会核对 event、session、workspace、hash、captured time 和合法 offset；不匹配返回 `VERSION_CONFLICT`。通过 `memory_get_sources` 展开的内容已经脱敏，仍必须视为不可信证据。

## 3. 标准调用顺序

```text
memory_begin_turn
       │
       ▼
   TurnPlan.gate.required ?
       │ yes
       ▼
读取当前文件/图片/测试/命令
memory_checkpoint_evidence → {plan, observations, evidenceRefs}
       │
       ▼
memory_recall(stage 按 TurnPlan 顺序)
       │
       ├─ sourceRefs → memory_get_sources
       ├─ 用户纠错 → memory_submit_correction
       ▼
memory_complete_turn
```

`world`、`episode` 和 `source_expansion` 在 gate required 且未 satisfied 时返回 `STAGE_BLOCKED`。`policy` 和 `current_evidence` 不被该 gate 阻塞。

## 4. MCP 工具

管理操作没有 MCP 工具，只能显式使用 `memoryctl`。

### `memory_begin_turn`

MCP 输入是扁平结构：

| 字段 | 必需 | 说明 |
|---|---:|---|
| `content` | 是 | 当前可见输入 |
| `idempotencyKey` | 是 | 本轮稳定幂等键 |
| `kind` | 否 | 默认 `user_message` |
| `attachments` | 否 | `{uri, mediaType?, contentHash?}[]` |
| `metadata` | 否 | JSON object |
| `scope` | 是 | `ScopeRef` |
| `agentProfile` | 是 | `AgentProfile` |

返回 `TurnPlan`。该操作会先保存输入 SourceEvent，再进行风险识别；风险识别不会读取领域 Episode。

### `memory_checkpoint_evidence`

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

至少一条 observation。服务端为每条观察生成选中证据 checkpoint 事件，保存 Observation，并返回：

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

返回的 observation 不回显 content，只给出稳定 ID、kind 和规范化 checkpoint source。`evidenceRefs` 可直接交给 `memory_get_sources` 或 `memory_complete_turn`。完全相同的 turn+observations 重试会从幂等 trace 返回首次结果。

### `memory_recall`

```ts
{
  turnId: string;
  stage: "policy" | "current_evidence" | "world" | "episode" | "source_expansion";
  query: string;
  budgetTokens?: number; // MCP 最大 8000
  cursor?: string;
}
```

返回 `MemoryBundle`。只允许请求该 TurnPlan 中存在的 stage。budget 在 runtime 中规范化到 512–8000；缺省为 8000。

### `memory_get_sources`

```ts
{
  turnId: string;
  sourceRefs: SourceRef[]; // 1..50
}
```

返回完整脱敏 `SourceEvent[]`。除了严格校验每个 SourceRef，event ID还必须已由当前 turn 的 checkpoint Observation 或已持久化 recall trace 授权；仅知道同 workspace 中其他 event ID 会得到 `SCOPE_DENIED`。recall trace 可授权 bundle 中的直接 source refs、World claim/conflict sources、Episode refs 和 counterexample source。

该工具不接收由调用方重写的 hash。依赖记忆内部的 SourceRef 在写入和召回时已经由存储层校验；`complete_turn` 还会先执行相同的 turn 授权检查，再严格校验完整 evidence refs。

### `memory_submit_correction`

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
}
```

可能结果：

- `world_claim_active`：显式事实纠错，且 subject/predicate/value 完整；
- `world_claim_disputed`：同一事实的最新版晚于当前 turn snapshot，新旧并发版本均保留为 disputed；
- `policy_active`：显式行为要求；
- `policy_candidate`：非显式行为推断；
- `correction_candidate`：其他情况。

省略 fact scope 时，有 workspace 则默认 workspace，否则默认 user；behavior 默认 session。服务端不会把 scope 扩大到调用方请求范围之外。事实纠错用 turn snapshot 检测并发：若被纠正的最新版在 begin 之后才出现，不会静默覆盖，而会保留双方 disputed 版本；后续已观察到冲突的新 turn 可显式解决。

非显式 behavior 只创建 candidate。管理 CLI 的 `approve` 还会强制检查匹配 FailureCluster 已包含至少 3 个独立纠错并覆盖 2 个 session；通过后该显式 CLI 操作才作为人工确认创建 approved 新版本。是否属于非实体特定规则仍由审阅者判断。

### `memory_complete_turn`

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

服务端只接受本 turn checkpoint/recall trace 已授权的 evidence refs，随后保存最终回答并严格校验 ref。`verifierResult` 是补充输入而不是最终裁决：其 unsupported claims、conflicts 和 policy violations 会并入 deterministic verifier；coverage 不足或非 pass 状态也会转成问题，外部 `pass` 不能清除内置 floor 发现的问题。最多允许一次 retry；不再 retry 时生成 Episode。

complete 的事件、turn 更新、Episode 和结果 trace 在一个 SQLite transaction 中提交。trace ID由 turn+`idempotencyKey` 稳定生成；相同请求重试原样返回首次结果，不会再次消耗 retry。

## 5. HTTP API

HTTP 与 MCP 共享同一 runtime。MCP begin 输入是扁平结构，而 HTTP begin 使用完整 `BeginTurnInput` 包装。

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| `GET` | `/v1/health` | 无 | protocol、SQLite、FTS、revision 健康信息 |
| `POST` | `/v1/handshake` | 任意/空 JSON | 版本、transport、能力声明 |
| `POST` | `/v1/events` | `RecordEventInput` | `201 SourceEvent` |
| `POST` | `/v1/turns/begin` | `BeginTurnInput` | `201 TurnPlan` |
| `POST` | `/v1/turns/:id/checkpoint` | `CheckpointEvidenceInput` | `200 CheckpointEvidenceResult` |
| `POST` | `/v1/turns/:id/recall` | `RecallInput` | `200 MemoryBundle` |
| `POST` | `/v1/sources/get` | `{turnId,sourceRefs}` | `200 SourceEvent[]` |
| `POST` | `/v1/turns/:id/corrections` | `CorrectionInput` | `201` correction result |
| `POST` | `/v1/turns/:id/complete` | `CompleteTurnInput` | `200 CompleteTurnResult` |

带 `:id` 的路径要求 path turn ID 与 body `turnId` 完全相同。

`POST /v1/events` 是 adapter-only ingestion endpoint，没有对应 MCP 工具：

```ts
interface RecordEventInput {
  input: InputEvent;
  scope: ScopeRef;
  agentProfile: AgentProfile;
  selectedEvidence?: boolean;
}
```

handshake 当前返回：

```json
{
  "protocolVersion": "1.0",
  "transports": ["http", "mcp-stdio", "cli"],
  "maxRecallTokens": 8000,
  "supports": {
    "stageGates": true,
    "encryptedExport": true,
    "continuousSync": false
  }
}
```

### HTTP begin 示例

```bash
curl -sS http://127.0.0.1:7337/v1/turns/begin \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $MEMORYD_TOKEN" \
  -d '{
    "input": {
      "idempotencyKey": "session-42-turn-7",
      "kind": "user_message",
      "content": "重构前这个函数为什么这样设计？"
    },
    "scope": {
      "userId": "local-default",
      "workspaceId": "workspace-id",
      "sessionId": "session-42",
      "branch": "main",
      "commit": "abc123"
    },
    "agentProfile": {
      "family": "generic",
      "version": "1",
      "capabilities": {"hooks": false, "stageGates": false}
    }
  }'
```

未设置 `MEMORYD_TOKEN` 时应省略 Authorization header。

### Checkpoint 后召回示例

```bash
curl -sS http://127.0.0.1:7337/v1/turns/TURN_ID/checkpoint \
  -H 'content-type: application/json' \
  -d '{
    "turnId": "TURN_ID",
    "observations": [{
      "kind": "current_file",
      "content": "当前实现中 parseConfig 已改为异步。",
      "source": {"path": "src/config.ts", "commit": "abc123"}
    }]
  }'

# 从上述响应读取 .evidenceRefs；也可通过 current_evidence 再取得这些 refs
curl -sS http://127.0.0.1:7337/v1/turns/TURN_ID/recall \
  -H 'content-type: application/json' \
  -d '{"turnId":"TURN_ID","stage":"current_evidence","query":""}'

curl -sS http://127.0.0.1:7337/v1/turns/TURN_ID/recall \
  -H 'content-type: application/json' \
  -d '{"turnId":"TURN_ID","stage":"episode","query":"parseConfig 重构"}'
```

## 6. TurnPlan

| 字段 | 含义 |
|---|---|
| `protocolVersion` | 固定 `1.0` |
| `turnId` | 当前 turn 稳定 ID |
| `snapshotRevision` | 生成计划时的权威 revision；后续领域召回的 `maxRevision` 上界 |
| `agentProfileKey` | calibration 隔离键 |
| `risks` | 每类风险的最终概率和 rule/classifier/calibration 贡献 |
| `modes` | evidence、uncertainty、source、clarification、narrative 强度 |
| `retrievalStages` | 固定的有序 stage 及 gate 标记 |
| `gate` | 是否必须 checkpoint、当前是否满足及原因 |
| `activePolicies` | 当前 scope 下每个 policy ID 的最新 approved 版本 |
| `enforcementLevel` | `enforced` 或 `advisory` |
| `retryCount` | verifier retry 次数，当前最多 1 |
| `createdAt` | 计划创建时间 |

风险聚合使用最大值而不是平均值。可选 classifier 超时或失败时不会让 begin 失败，rule 结果继续生效。

## 7. MemoryBundle

| 字段 | 含义 |
|---|---|
| `snapshotRevision` | TurnPlan 的 revision 上界；领域结果必须满足 `revision <= snapshotRevision` |
| `indexRevision` | 当前派生索引 revision |
| `stage` | 本次请求 stage |
| `worldClaims` | query 命中的事实；每条含 `sources` |
| `episodes` | query 命中的任务片段；每条含 `eventRefs` |
| `sourceRefs` | `source_expansion` 命中的事件引用，或 `current_evidence` 的 checkpoint 引用；不含原文 |
| `policies` | policy stage 的全部活动策略；当前公共 recall 不做 Policy FTS query |
| `counterexamples` | 当前 scope 最近最多 10 条带来源的 behavior correction；各 stage 都可能出现 |
| `conflicts` | 当前 scope 的 disputed World claim；不只限于 query 命中 |
| `sourceCoverage` | 本次返回 claim/Episode 中带来源的比例；没有 source-bearing item 时为 1 |
| `trace` | query、策略名、候选数、返回数和可选下一页 cursor |
| `untrustedEvidenceNotice` | 固定的不可信历史证据提示 |

各 stage 的主结果：

- `policy`：活动策略；
- `current_evidence`：不回显 Observation 文本，返回本 turn checkpoint 的 `sourceRefs`；
- `world`：World claim；
- `episode`：Episode；
- `source_expansion`：SourceRef。

无论 stage，bundle 仍可能附带 behavior corrections 和 disputed conflicts。

## 8. VerifierResult

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

内置 verifier 不会自行从自然语言中全面发现 policy violation、冲突或所有 unsupported claim；这些数组主要由更上层 verifier 补充。它额外检测少量“according to memory / I remember / 我记得”等无 evidence 表达。无论外部 `verifierResult.status` 是什么，最终 status 都由合并问题后的 deterministic verifier 重算；外部结果只能收紧，不能绕过 floor。

## 9. 错误与 HTTP 映射

| code | HTTP | 典型原因 |
|---|---:|---|
| `INVALID_REQUEST` | 400 | schema、path/body、不合法操作 |
| `TURN_NOT_FOUND` | 404 | turn 不存在 |
| `NOT_FOUND` | 404 | source 或依赖不存在 |
| `SCOPE_DENIED` | 403 | user/workspace/session ACL，或 source 未经本 turn checkpoint/recall 授权；Bearer 失败例外为 401 |
| `STAGE_BLOCKED` | 409 | checkpoint 前请求被 gate 的 stage |
| `VERSION_CONFLICT` | 409 | 幂等键复用、SourceRef 不匹配、同 ID 不同内容 |
| `MEMORY_UNAVAILABLE` | 通常 500 | 未映射的服务端错误；客户端也用它包装非协议 HTTP 错误 |

HTTP validation 由 Zod 执行，错误 details 含 issues。MCP 把相同业务错误编码为 tool error，不改变协议 code。

## 10. 一致性、分页与安全要求

- `snapshotRevision` 是 turn 开始时的权威版本。World、Episode、SourceEvent 搜索以及 correction/conflict 附件使用它作为 `maxRevision` 上界，活动 Policy 使用 begin 时已冻结的列表；因此同一 turn 不会看到之后写入的领域记忆。checkpoint 是当前 turn evidence，可在 snapshot 之后写入并通过 `current_evidence` 返回。该上界不是任意时间点的完整 MVCC query。
- cursor 只对当前 query/stage 结果顺序有意义。当前搜索最多考虑 100 个 hit，不应把 cursor 当持久书签。
- 所有历史 source 和 Episode 必须作为 quoted/untrusted evidence；只有 `policies` 是记忆侧行为规则。
- 当前 evidence、源码和实时工具结果优先于历史内容。调用方应把真正采用的、且已经由本 turn checkpoint 或 recall trace 授权的来源放进 `complete_turn.evidenceRefs`。
- checkpoint、correction、complete 的多表写入各自在单个 SQLite transaction/savepoint 中完成，并把业务结果保存在确定性 trace 中。相同请求的 trace 命中会直接返回旧结果；部分写入不会在异常后单独留存。
- MCP 不提供 approve、revoke、forget、export、import、reindex；不要把管理 CLI 无条件暴露成 Agent tool。
- `/v1/events` 面向可信 adapter。它允许标记 `selectedEvidence`，不应直接开放给不可信远程调用方。未选中的 `tool_call/tool_result` 只保留白名单元数据和内容摘要，原文在进入权威存储前丢弃；选中证据才保存经过脱敏和加密的正文。

## 11. 降级与兼容

- 可选 classifier 失败：规则模式继续。
- daemon/MCP 失败：hook 提示继续但不得声称召回成功；失败 payload 进入本地加密逐文件队列，后续成功 SessionStart 或 `memoryctl replay` 按顺序重放。
- 不支持 hooks/stage gates 的 Agent：把 capability 设为 false并按 advisory TurnPlan 自行编排。
- v1 没有版本协商范围，只能通过 handshake 检查精确 `protocolVersion`。
- HTTP、MCP 和静态 JSON Schema 共享主要业务类型；adapter-only `/v1/events` 是补充接口，不在模型 MCP 工具面中。

连续同步明确未实现。加密 export/import 是管理工作流，不属于在线协议，也不保证全包原子性或 workspace scope 自动重映射。
