# memoryd 架构

本文描述当前 `0.1.0` 源码已经实现的架构，而不是目标蓝图。公共协议版本为 `1.1`，SQLite schema version 为 `5`。

## 1. 设计目标与不变量

`memoryd` 采用“外部统一权威源 + Agent 薄适配层”模式。Claude Code、Codex 和其他 Agent 共享 World、Episode 和已批准 Policy；Calibration 按 `family:version:model:toolsetDigest` 隔离。

实现中的主要不变量是：

1. 原始可见 `SourceEvent` 是事实底座；FTS、embedding、实体边、摘要和 Episode 都是可重建索引。
2. 当前文件、图片、测试和命令观察高于历史记忆。高污染风险下，历史领域记忆必须等 evidence checkpoint。
3. 历史 Episode、Re-experience pack 和 source text 是不可信证据；只有独立、已批准且当前适用的 Policy 可作为记忆侧行为规则。
4. user/workspace/session ACL 和 `snapshotRevision` 在候选物化前后都执行，跨 scope 或 snapshot 的内容不能进入结果。
5. 写入使用 revision、稳定 ID 和幂等键；同 ID 不同内容不能静默覆盖。
6. 自我反思只能创建候选；学习 Policy 需要用户纠错证据和人工批准。结构化事件条件是 Trigger 激活的硬前提，相似度不能单独激活。
7. Policy 本体不随时间衰减。只有 Trigger 的后台调度优先级衰减；条件再次出现时可恢复。
8. approve、revoke、forget、export/import、reindex 和 Calibration 退休不暴露为 MCP 工具。

宿主自身的安全规则、权限和 sandbox 不由 `memoryd` 实现，始终高于记忆策略。

## 2. 组件与进程

```text
┌──────────────── Agent host ────────────────┐
│ CLAUDE.md / AGENTS.md / Skills             │
│ lifecycle hooks                            │
│ MCP tool calls                             │
└───────────────┬────────────────────────────┘
                │
      ┌─────────▼─────────┐       stdio
      │ memoryctl hook    │   ┌──────────────┐
      │ + failure spool   │   │ memory-mcp   │
      └─────────┬─────────┘   └──────┬───────┘
                └──────── HTTP ──────┘
                         ▼
              ┌────────────────────────┐
              │ memoryd / MemoryRuntime│
              │ Risk → Mode → Gate     │
              │ Hybrid Recall → Verify │
              │ learning job worker    │
              └───────────┬────────────┘
                          ▼
              ┌────────────────────────┐
              │ MemoryStore / SQLite   │
              │ WAL + FTS5 + vectors   │
              │ entity graph + AES-GCM │
              └────────────────────────┘
```

- `memoryd`：持有 `MemoryRuntime` 和 `MemoryStore`，默认监听 `127.0.0.1:7337`；同时按配置间隔消费持久化 learning job。
- `memory-mcp`：stdio MCP server，本身不打开数据库，通过 `MemoryClient` 调用 daemon。
- `memoryctl`：启动/停止 daemon、检查和管理数据库、显式运行学习、安装适配器，也可把宿主 hook JSON 转成 HTTP 调用。
- `MemoryClient`：使用标准 `fetch`，默认 2 秒超时，可添加全局 Bearer token。
- `LocalHashEmbeddingProvider`：默认同步、本地、确定性的 384 维 hash-ngram embedding；输入先过滤秘密，不保存 embedding 原文。runtime 也允许注入其他同步 provider 或显式禁用 embedding。

HTTP request body 上限为 2 MiB。daemon 是单进程 Node.js 服务；SQLite WAL 允许管理 CLI 与 daemon 并发访问同一文件，但没有分布式锁或远程协调层。

## 3. 在线控制层

### 3.1 `beginTurn`

`beginTurn()` 的顺序固定：

1. 验证 `scope.sessionId`，创建活动 session；已结束的 session 会以 `VERSION_CONFLICT` 拒绝新 turn。
2. 把当前用户输入追加为 `SourceEvent`，提取当前输入的结构特征。此时不读取领域 Episode。
3. 对当前 Agent profile 的 Calibration pattern 做结构匹配；active pattern 可贡献风险，shadow pattern 只记录在线命中率和延迟。
4. 对当前 scope 的活动 Trigger 做结构匹配。Policy 文本的本地 embedding 相似度只作为最多 20% 的辅助分数；结构条件没有满足时，Trigger 必定不激活。
5. 运行确定性规则和可选 HTTP classifier。每个风险取 rule、classifier、Calibration、Trigger 四类贡献的最大值。
6. 用相同 Trigger 上下文调度 Policy，解析依赖，生成 L1/L2/L3/Archive 分层。
7. 生成风险相关的检索策略和 stage 顺序，冻结为 `TurnPlan`，保存 begin trace；对实际激活 Policy 的 Trigger 追加 activation 记录。

HTTP classifier 只接收压缩的布尔、枚举和计数特征以及 Agent 标识，不接收原始 prompt 或历史文本。超时或失败后规则、Calibration 和 Trigger 路径继续工作。

turn ID 默认由 `userId + workspaceId + input.idempotencyKey` 的摘要生成；调用方也可通过 input metadata 的 `turnId` 指定。`snapshotRevision` 是计划创建时的权威存储 revision。

### 3.2 Risk、Mode 与动态检索计划

规则识别八类风险：实体/符号混合、过期源码、错误 workspace、跨 session 混合、无证据推断、叙事补全、破坏性动作和秘密暴露。

以下风险在概率达到 `0.7` 时要求先 checkpoint：

- `entity_or_symbol_merge`
- `stale_source`
- `wrong_workspace`
- `cross_session_merge`
- `unsupported_inference`
- `narrative_completion`

gate 生效时，`world`、`episode`、`reexperience` 和 `source_expansion` 都被服务端阻塞；`policy` 和 `current_evidence` 仍可读取。`0.4` 和 `0.7` 也用于调高不确定性、原文读取和澄清模式。破坏性风险会提高澄清强度，但不会单独形成历史检索 gate。

`buildDynamicRetrievalStrategy()` 会融合所有概率至少 `0.4` 的风险，生成：

- 有序步骤，如 current evidence、exact match、timeline、entity graph、完整 Episode、原始来源和 conflict check；
- BM25、embedding、entity、temporal、thread 五路权重；
- 来源 coverage 权重和最低 evidence coverage；
- 是否要求先 checkpoint、原始来源、同 workspace，以及是否允许 embedding。

例如实体混淆提高 entity/timeline 权重，过期源码提高 temporal/current-evidence 权重，跨 session 混淆提高 thread/完整 Episode 权重；`secret_exposure` 禁用 embedding 信号。

`AgentProfile.capabilities.hooks && stageGates` 为真时计划标记为 `enforced`，否则是 `advisory`。真正的服务端 gate 对所有调用都生效；`advisory` 表示宿主无法保证整套生命周期编排，而不是绕过 gate。`enforced` 也不表示 `memoryd` 能阻止 shell、文件或其他宿主动作。

### 3.3 Evidence checkpoint

`checkpointEvidence()` 把每条 observation 另存为选中证据的 checkpoint `SourceEvent`，保存 Observation，并把 turn gate 更新为 satisfied。观察类型包括当前文件、图片、测试、命令和用户陈述。返回 `{plan, observations, evidenceRefs}`；Observation 不回显 content，只给出稳定 ID、kind 和规范化来源。

服务端不会自行打开文件、查看图片或执行测试来鉴证 observation；它信任调用方提交的非空观察。因此 evidence gate 是协议级顺序和来源约束，不是独立真实性证明。

`memory_recall(stage=current_evidence)` 返回 checkpoint 的去重 `sourceRefs`。调用方可用 `memory_get_sources` 展开这些已授权来源。

### 3.4 混合召回与重排

| stage | 当前行为 |
|---|---|
| `policy` | 返回 begin 时冻结、通过 Trigger/条件和 dependency 调度的 `activePolicies`；不走 FTS |
| `current_evidence` | 返回本 turn checkpoint 的 `sourceRefs` |
| `world` | 召回 active/disputed WorldClaim |
| `episode` | 召回完整叙事 Episode |
| `reexperience` | 构建近期原文、完整历史 Episode、关键/情绪事件和事实约束工作集 |
| `source_expansion` | 定位脱敏 SourceEvent，先返回 `sourceRefs` |

领域 stage 的候选来自：

- FTS5/BM25 exact/lexical hit；
- 本地 embedding bucket 的候选及 cosine similarity；
- 实体 mention owner 和最多一跳的实体关系；
- 当前 scope 最近 SourceEvent、WorldClaim 和 Episode；
- 候选时间与当前 turn 的 temporal 衰减；
- 同 session、其他 session 等 thread distance。

`rankRetrievalCandidates()` 先对每个可用信号归一化；全局缺失的信号会被移除，剩余权重重新归一化。随后把检索分数与独立来源比例、query/entity evidence facet 覆盖合成最终分数。trace 记录策略 ID、实际信号、coverage rerank、候选数量和确定性降级原因。

所有候选在物化时再次检查 ACL、`revision <= snapshotRevision` 和状态。keyset cursor 绑定 snapshot、风险策略和 query 摘要，不能跨 query 或计划复用。每次基础 FTS 最多考虑 100 个 hit，embedding bucket 候选和实体候选也有界；预算规范化到 512–8000 tokens，页大小最多 40 条。

WorldClaim、Episode、Policy 和 correction 的来源在返回前重新校验 event ID、session、workspace、content hash 和 captured time。`memory_get_sources` 与 `completeTurn.evidenceRefs` 还执行 turn 内 capability 授权：event ID 必须来自本 turn checkpoint、冻结的活动 Policy 来源或已持久化 recall trace。仅知道同 workspace 的 event ID 不足以展开原文。

### 3.5 Re-experience pack

`memory_build_workset` 是 `reexperience` stage 的便利入口，并受相同 evidence gate 和 snapshot 约束。它把 `recentTurns` 限制在 20–50（默认 32），在 token budget 内选择：

- 最近 completed turn 的输入/输出原始脱敏事件；
- 旧的完整叙事 Episode 及其全部可见事件；
- checkpoint、已选证据、纠错等关键事件；
- 带情绪线索的事件；
- active/disputed WorldClaim 事实约束。

选择器先尝试为每类记忆保留锚点，再按相关性、重要度、时间和 thread 距离的 utility/token 分配剩余预算。Episode 只有完整时才可选，不会切成失去上下文的半段。返回的原文仍是 untrusted evidence。

### 3.6 Completion、叙事 Episode 与 SessionEnd

`completeTurn()` 会验证已授权 `evidenceRefs`、追加最终助手事件、合并外部 verifier 问题、运行确定性 verifier、更新 turn/trace，并在不再 retry 时更新叙事 Episode。最多 retry 一次；之后有冲突则 `clarify`，否则 `abstain`。

叙事切块以 SourceEvent 为底座。`partitionNarrativeTurn()` 会根据以下信号决定合并或开启新 Episode：

- 新 session、前一片段已关闭；
- 默认 30 分钟时间间隔；
- coding/visual/recall/conversation 任务类型变化；
- 本 turn 发生 correction；
- 实体/主题变化和文本相似度；
- 默认 12 个 turn 的大小上限；
- 显式 narrative boundary 或 session end。

Episode 保存 `turnIds`、topic key、边界原因、参与者、风险、标签、salience、情绪标签以及按时间排序的 `eventRefs`。title/summary 只用于定位，权威内容仍是原始事件。`memoryctl reindex` 可清空并从 completed turn 与 trace 确定性重建叙事 Episode 及其他派生索引。

adapter-only `POST /v1/sessions/end` 是幂等端点。它把 session 标为 ended、关闭当前叙事 Episode、记录 session-end trace 和学习 job，并报告该 session 的 Policy 数量。之后同一 session ID 不能开始新 turn；session Policy 不会被物理删除，但不会跨到新 session。

checkpoint、correction 和 complete 用 SQLite transaction/savepoint 包住多步写入，并把完整结果写入确定性 trace。重放相同请求返回首次结果，不重复创建 claim/Policy/Episode 或消耗 retry。

## 4. 记忆与慢速学习层

### 4.1 权威记录和派生记录

| 模型 | 用途 |
|---|---|
| `SourceEvent` | 脱敏后的用户/助手消息、附件引用、工具摘要、checkpoint 和 compaction；事实底座 |
| `Turn` / `Observation` | 固化 TurnPlan、gate、retry、branch/commit 和当前证据 |
| `WorldClaim` | 带 scope、版本、有效性、状态、置信度和 SourceRef 的结构化事实 |
| `Episode` | 由 completed turn 叙事切块形成的派生片段；title/summary 用于定位，`eventRefs` 回到权威原文 |
| `Policy` | 用户显式或已确认学习的行为规则，带 condition/action、scope、依赖、版本、review status 和来源 |
| `Correction` / `FailureCluster` | 纠错证据及跨 session 错误簇 |
| `Trigger` / `TriggerActivation` | 结构化条件、关联风险/Policy、调度优先级和实际激活审计 |
| `CalibrationPattern` | 按完整 Agent profile 隔离的 shadow/active/retired 风险 overlay |
| `TurnTrace` | begin、checkpoint、recall、correction、complete、session end 的回放信息 |
| `SessionLifecycle` | session 的 active/ended 状态和幂等结束语义 |
| `Tombstone` | 删除同步语义；只保留 ID、scope、时间、设备和脱敏 reason |

Episode、FTS、embedding、embedding bucket、entity edge、source link 和 cache 都是派生数据，可从上述事件和记录重建。learning job 是持久化工作队列，不属于 Agent 可直接调用的记忆内容。

### 4.2 纠错、聚类和安全晋升

- 显式事实纠错且带 `subject`、`predicate`、`value`：写入 active WorldClaim。若最新版晚于当前 turn snapshot，新旧版本都标为 disputed，不做 last-write-wins；后续看见冲突的新 turn 可显式解决。
- 显式行为要求：立即写入当前请求 scope 的 approved `user_explicit` Policy，不自动扩大作用域。
- 非显式行为纠错：写入 `confirmed_learned` candidate Policy，并按风险、结构特征和规范化 lesson 形成 FailureCluster。默认落在 workspace（无 workspace 时 user）scope，便于跨 session 聚类。
- `origin:self_reflection` 和实体特定 correction 可以保留候选/反例，但不计入学习阈值。

至少三个独立用户纠错、覆盖两个 session、且通过非实体特定过滤后，cluster 变为 reviewed 并进入学习队列。分析器从重复的结构特征学习 `equals`、`contains`、数值下界等 Trigger clause；prompt、用户文本、实体名称/ID、workspace/session/user ID 和 toolset digest 等字段被排除，避免把具体身份或纠错原文固化为触发条件。

学习器只创建 Trigger/Policy candidate 和 Calibration shadow。学习 Policy 仍需 `memoryctl approve`；CLI 会复查 3/2 阈值，并拒绝 dependency cycle。批准新 Policy version 后关联 Trigger 才会 active；revoke 会退休关联 Trigger。用户显式 Policy 不需要学习阈值。

### 4.3 Trigger 运行时与优先级

Trigger 匹配必须满足非空结构条件中的所有 `all` clause，以及可选 `any` 中至少一个 clause。相似度默认只占 20% 分数，且 `eventMatched` 为 false 时永远不能激活，因此历史文本中的相似指令不能单独触发 Policy。

活动 Trigger 可以：

- 向其 `riskCode` 提供概率，参与 Risk Recognizer 的 max 聚合；
- 激活关联 Policy 并把它提升到 L1；
- 记录 structural、similarity 和 effective score；
- 把自身 `priority` 恢复为 1，增加 activation count。

未触发时，`effectiveTriggerPriority()` 以默认 30 天半衰期降到 0.05 floor，并结合激活频率形成后台 tier 信号。该计算不修改 Policy，也不删除 Trigger；条件重现时会立即恢复。

### 4.4 Calibration shadow、replay 和 promotion

从满足阈值的纠错样本中，学习器按完整 `agentProfileKey + cluster + risk` 生成结构化 Calibration shadow。它在相同 profile 的历史 turn 上回放，记录：

- replay sample/match 数；
- 正样本 coverage；
- 全量 replay activation rate；
- correction/session support 和建议风险概率。

每个后续 `beginTurn()` 还会 shadow 执行条件，累计在线 sample、activation rate 和平均延迟。当前保守发布门为：至少 10 个 shadow sample、replay coverage 至少 `0.8`、历史和在线 activation rate 都不高于 `0.25`、平均 shadow 延迟低于 20 ms。满足后 pattern 才转为 active，并只影响同一 Agent profile；管理员可用 `memoryctl calibration retire` 退休。该流程更新的是 Risk Recognizer overlay，不训练或改写外部 HTTP classifier 模型。

### 4.5 Policy L1/L2/L3/Archive 与依赖

`schedulePolicies()` 对每个 Policy 的最新版本进行 scope、review status、condition、Trigger 和 dependency 检查：

- `L1 >= 0.75`、`L2 >= 0.4`、`L3 >= 0.1`，更低为 Archive；
- 当前 condition/Trigger 命中会把适用 Policy 提升到 L1；
- 无路由条件的已批准 Policy 按稳定 authority tier 加载；
- 有路由条件但当前未匹配的 Policy 只出现在 schedule 中，不进入 `activePolicies`；
- Policy ID dependency 会递归解析并随活动 Policy 一起加载；`current_source`、`source_refs`、`memoryd` 是运行时可用依赖；缺失、inactive 或 cycle 都 fail closed。

Tier 是工作集调度信息，不是 Policy 内容生命周期。Policy 本体不做 confidence decay；长期未触发的规则在条件再次匹配时仍可完整激活。

### 4.6 持久化 learning job worker

纠错、完成 turn 和 SessionEnd 会按幂等键写入 `learning_jobs`。daemon 默认每 5 秒（`MEMORYD_LEARNING_INTERVAL_MS`，最小 1 秒）claim 最多 25 个 job，完成后标记 completed；失败记录错误并可再次处理。`memoryctl learn --once` 会为当前 scope 的 reviewed/promoted cluster 入队，并同步消费最多 100 个 job。

当前 job 类型包括 cluster 分析、Calibration 评估、embedding 索引、实体图重建和 session segmentation。叙事切块已经在 complete/SessionEnd 在线确定性执行；segment job 主要保留崩溃恢复可观测性和后续分析扩展点。

## 5. 存储、版本和删除

### 5.1 SQLite schema v5

`MemoryStore` 使用 `better-sqlite3`，文件库启用 WAL、foreign keys、NORMAL synchronous 和 5 秒 busy timeout。schema 通过 `PRAGMA user_version` 顺序迁移，当前 version 为 `5`：

- v1–v3：权威记忆、FTS、来源、Trigger/Cluster/Calibration 预留、tombstone reason、turn branch/commit；
- v4：`session_lifecycle`、`trigger_activations`、`learning_jobs`；
- v5：`embedding_buckets` 候选索引。

权威写入推进全局 `revision`；FTS 更新记录 `index_revision`。embedding 只保存 Float32 vector；bucket 取向量显著维度用于本地候选缩小。实体 token 用本地密钥作用域化的稳定 ID 存储，WorldClaim 的字符串值可生成实体关系边，明文实体名称不作为图 ID 保存。

`memoryctl reindex` 先重建 FTS 和 source link，再由 runtime 重建 narrative Episode、embedding/bucket 和 entity index，不改变权威事件内容。

### 5.2 幂等与冲突

事件、turn、claim、Policy、Episode、correction、session end 和 learning job 都有稳定 ID/幂等路径。runtime 的 checkpoint/correction/complete 还使用带结果的 trace 实现跨多步幂等。重放相同请求返回已有结果；复用同一幂等键或 ID 但内容不同会产生 `VERSION_CONFLICT`。导入同样不做 last-write-wins。

### 5.3 Forget 与 tombstone

forget 会删除目标权威行、FTS、source link、embedding/bucket、entity edge、相关 Trigger/Calibration、activation/job 和 cache。WorldClaim 与 Policy 的公开 ID 会删除该身份的全部版本。级联是双向的：删除 source event 会删除引用它的 claim、Policy、Episode、correction、observation、turn 和 trace；直接删除带来源的派生记忆也会删除其原始 event，继而删除共享该来源的其他记录。

该策略以隐私完整性优先，粒度不是语义字符串擦除。共享一个 SourceEvent 的多个派生记忆会一起消失；其他独立事件中的相似文字不会靠字符串匹配自动删除。只需停用策略时应使用 `revoke`。

tombstone 阻止后到的导入重新创建相同实体。reason 在写入前经过凭据脱敏并截断为 500 字符；被删内容不进入 tombstone。

### 5.4 导入导出

导出包含权威事件、turn、记忆、Trigger/Cluster/Calibration、session、Trigger activation 和 tombstone，不包含 FTS、embedding、entity edge、cache 或 learning job；派生索引在导入后重建。整个 JSON 包用 AES-256-GCM 加密。

导入先应用 tombstone，再按依赖顺序逐记录插入。它是幂等的记录级流程，但不是全包原子事务或持续同步；同 ID 不同内容或缺少依赖会报告 conflict。workspace ID 由主密钥参与 HMAC，导入不重映射 scope。

## 6. 数据安全与信任边界

### 6.1 脱敏、加密和派生特征

事件 content、attachments、metadata 和其他 payload 字符串先过滤已知私钥、OpenAI/GitHub/Slack token、AWS access key、Bearer token、URL credential 和常见 secret/password assignment，再加密。embedding 和实体提取还有独立 secret filter，向量不携带输入原文。

AES-256-GCM 为每条 payload 使用随机 12 字节 IV，并把 `entityType:entityId` 作为 AAD。认证 tag、IV 和 ciphertext 存在 JSON envelope 中。

这不是整库加密：ACL、时间、状态、revision、脱敏后的 FTS 文本、Float32 vector、bucket 和作用域化实体 ID 是 SQLite 明文。数据库、WAL 和备份仍应按敏感本地数据保护。

### 6.2 Key、网络和用户隔离

daemon 主密钥默认存于 `~/.memoryd/master.key`，权限 `0600`；状态目录为 `0700`。数据库持久化 device ID，用不同 `MEMORYD_DEVICE_ID` 打开既有数据库会失败。

HTTP 默认 loopback，可选全局 Bearer token。没有 TLS、每用户 token、权限角色、速率限制或远程管理接口。`userId` 是逻辑作用域，不是服务端认证结果；安全模型是单个受信本地用户，而不是共享 SaaS。

导出 passphrase 当前仅通过 SHA-256 归一化为 32 字节 key，没有 salt 或 password-hard KDF；应使用高熵随机 passphrase。

### 6.3 Prompt injection 与来源授权

每个 MemoryBundle 都带 `untrustedEvidenceNotice`。MCP instructions、Skills 和 Agent guidance 要求把 source、Episode 和 Re-experience 原文作为引用证据，而不是指令。存储层不会把历史 source text 自动变成 approved Policy；不过最终是否遵守仍依赖 Agent 宿主和提示约束，不是形式化 sandbox。

### 6.4 Hook failure spool

hook HTTP 调用失败时，适配器把 payload、错误和时间逐条加密到 `~/.memoryd/spool/hook-failures/*.json`。成功 SessionStart 或 `memoryctl replay` 会按序重放最多 100 条，成功后才删除；遇到首个仍失败、密钥不匹配或损坏条目便停止，以免依赖事件乱序。

hook spool 与 `learning_jobs` 是两套队列。learning job 有 daemon worker；hook spool 仍没有常驻退避 worker、损坏条目自动隔离或自动清理。

## 7. Agent 适配与降级

Claude/Codex 共有 hooks 当前行为：

- SessionStart：检查 daemon 并注入可用性提示；成功后 CLI wrapper 会顺序 replay hook spool。
- UserPromptSubmit：调用 begin，保存 per-session hook state，注入约 1500 tokens 的 TurnPlan 摘要。
- PostToolUse：只保存工具名、input key、结果 hash 和成功状态；未选择的工具正文进入存储前即丢弃。
- Pre/PostCompact：保存 checkpoint 或 compact summary 事件。
- Stop：提交最终助手文本；需要 retry 时，Claude/Codex CLI 适配器输出宿主认可的结构化 `decision:block` 以继续一轮，generic wrapper 收到等价的非空纯文本并自行映射。

Claude Code 另外通过 `SessionEnd` 调用 `/v1/sessions/end`，关闭叙事片段和 session，然后清理本地 hook state。Codex 当前公开 hook 事件不含 `SessionEnd`，所以其模板不注册无效事件；session scope 仍隔离旧 Policy，显式 lifecycle 收口需由 wrapper 调用 HTTP 端点。

项目级 Claude 安装追加根 `AGENTS.md` shared protocol、`.claude/rules/memory.md`、Skills、hooks 和 MCP；Codex 项目安装合并相同 shared guidance。原生 auto memory 默认关闭，避免双写。

任何 hook 调用失败都会写加密 spool。SessionStart/UserPromptSubmit 返回明确降级提示；其他事件返回空字符串。可选 classifier、embedding 或实体索引单路失败不会中断权威写入，recall trace 会记录降级并用剩余信号重排。

generic hook profile 默认声明 `hooks:false`、`stageGates:false`，TurnPlan 因而为 advisory。直接使用 MCP/HTTP 的通用 Agent 可按实际能力设置 profile。

## 8. 当前边界

当前仍未实现：

- 连续同步、远程复制、CRDT/三方冲突解决和 workspace identity 重映射；
- 从任意自然语言对话自动抽取结构化 WorldClaim；
- 外部 classifier 模型训练、通用神经 embedding 服务、ANN 向量数据库或多跳知识图谱推理；
- LLM 级语义摘要和完整语义 verifier；
- 学习 Policy 的无人工自动授权；
- hook failure spool 的后台退避/损坏隔离、守护进程监督和自动备份；
- 多用户认证、远程 TLS、安全远程暴露和密钥轮换。

`scripts/benchmark.ts` 可评估规则模式下 10 万事件的本机性能；代码中的目标值是验收目标，不是所有机器上的 SLA。
