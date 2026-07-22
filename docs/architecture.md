# memoryd 架构

本文描述当前 `0.1.0` 源码已经实现的架构，而不是目标蓝图。公共协议版本为 `1.0`。

## 1. 设计目标与不变量

`memoryd` 采用“外部统一权威源 + Agent 薄适配层”模式。Claude Code、Codex 和其他 Agent 共享 World、Episode 和显式 Policy；每个 turn 仍携带 Agent profile，以便按 `family:version:model:toolsetDigest` 读取独立 calibration overlay。

实现中的主要不变量是：

1. 原始可见事件是来源底座；World claim 和 Episode 必须引用可验证的 `SourceRef`。
2. 当前文件、图片、测试和命令观察高于历史记忆。高污染风险下，历史领域记忆必须等 evidence checkpoint。
3. 历史 Episode 和 source text 是不可信数据；只有独立 Policy 列表可作为记忆侧行为指令。
4. user/workspace ACL 在 FTS 匹配前物化，跨 workspace 内容不能进入结果。
5. 写入使用 revision、稳定 ID 和幂等键；同 ID 不同内容不能静默覆盖。
6. 管理动作不暴露为 MCP 工具。

宿主自身的安全规则、权限和 sandbox 不由 `memoryd` 实现，始终高于记忆策略。

## 2. 组件

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
                ┌───────────────────┐
                │ memoryd HTTP      │
                │ MemoryRuntime     │
                │ Risk / Mode       │
                │ Recall / Verify   │
                └─────────┬─────────┘
                          ▼
                ┌───────────────────┐
                │ MemoryStore       │
                │ SQLite WAL / FTS5 │
                │ AES-256-GCM       │
                └───────────────────┘
```

### 2.1 进程和传输

- `memoryd`：持有 `MemoryRuntime` 和 `MemoryStore`，默认监听 `127.0.0.1:7337`。
- `memory-mcp`：stdio MCP server，本身不打开数据库，通过 `MemoryClient` 调用 daemon。
- `memoryctl`：管理数据库、启动/停止 daemon、安装适配器，也可把宿主 hook JSON 转成 HTTP 调用。
- `MemoryClient`：使用标准 `fetch`，默认 2 秒超时，可添加全局 Bearer token。

HTTP request body 上限为 2 MiB。daemon 目前是单进程 Node.js 服务；SQLite WAL 允许管理 CLI 与 daemon 并发访问同一文件，但没有分布式锁或远程协调层。

## 3. 在线控制流程

### 3.1 `beginTurn`

1. 先把当前用户输入追加为 `SourceEvent`。
2. 只从当前输入、scope、Agent profile 和已存 calibration 数值构造风险输入；不会在风险识别前读取领域 Episode。
3. 确定性规则生成风险贡献。若配置 HTTP classifier，只把压缩的布尔/枚举/计数特征和 Agent 标识发送出去。
4. 每个风险取 rule、classifier、calibration 三类贡献中的最大值。
5. 加载当前 scope 的最新活动 Policy，生成并保存完整 `TurnPlan` 和 begin trace。

turn ID 默认由 `userId + workspaceId + input.idempotencyKey` 的摘要生成；调用方也可通过 input metadata 的 `turnId` 指定。snapshot revision 是计划创建时的权威存储 revision。

### 3.2 Risk 与 Mode

规则识别八类风险：实体/符号混合、过期源码、错误 workspace、跨 session 混合、无证据推断、叙事补全、破坏性动作和秘密暴露。

当前 gate 只由以下风险触发：

- `stale_source`
- `wrong_workspace`
- `unsupported_inference`
- `narrative_completion`

其中任意概率达到 `0.7` 时，`world`、`episode`、`source_expansion` 被阻塞，直到 checkpoint。`0.4` 和 `0.7` 也用于调高不确定性、原文读取和澄清模式；破坏性风险会提高澄清模式，但不会单独形成历史检索 gate。

`AgentProfile.capabilities.hooks && stageGates` 为真时计划标记为 `enforced`，否则是 `advisory`。真正的服务端 gate 对所有调用都生效；`advisory` 表示宿主无法保证整套生命周期顺序，而不是绕过服务端检查。这里的 `enforced` 只描述记忆调用编排，不代表 `memoryd` 能阻止 shell、文件或其他破坏性 Agent 动作。

### 3.3 Evidence checkpoint

`checkpointEvidence` 把每条 observation 另存为选中证据的 checkpoint `SourceEvent`，再保存 Observation，并把 turn gate 更新为 satisfied。观察类型包括当前文件、图片、测试、命令和用户陈述。返回值为 `{plan, observations, evidenceRefs}`：`observations` 只含 observation ID、kind 和规范化来源，`evidenceRefs` 可直接用于后续 source 展开和 completion。

服务端不会自行打开文件、图片或执行测试来证明 observation；它信任调用方提交的非空观察。因此 evidence gate 是协议级顺序约束，不是对证据真实性的独立鉴证。

`memory_recall(stage=current_evidence)` 不回显 Observation 文本，而是返回本 turn 已保存 checkpoint 的去重 `sourceRefs`。调用方可再用 `memory_get_sources` 展开这些已授权来源。

### 3.4 Recall

| stage | 当前行为 |
|---|---|
| `policy` | 返回当前 scope 的最新活动 Policy；不走 FTS |
| `current_evidence` | 不执行 FTS，返回本 turn checkpoint 的 `sourceRefs` |
| `world` | FTS5/BM25 检索 active/disputed World claim |
| `episode` | FTS5/BM25 检索 Episode title/summary |
| `source_expansion` | FTS5/BM25 定位脱敏 SourceEvent，先返回 `sourceRefs` |

FTS 查询先用 materialized CTE 形成 user/workspace 允许集合，再执行 `MATCH`。World 和 Policy 还应用 session scope；Episode 和 source event 可在同 workspace 内跨 session 召回。没有 workspace 的调用只会看到 user-scoped 数据，不会获得所有 workspace。

领域召回还把 `TurnPlan.snapshotRevision` 作为 `maxRevision` 传给存储查询，只允许 `row.revision <= snapshotRevision`。活动 Policy 直接使用 begin 时冻结在 TurnPlan 中的列表，behavior correction 和 disputed conflict 也应用同一 revision 上界。因此一个已开始的 turn 看不到之后由其他 turn 写入的事实或策略；新 checkpoint 是当前 turn 证据，作为明确例外通过 `current_evidence` 暴露。该机制是 revision 上界视图，不是保留任意历史行状态的完整 MVCC 数据库。

结果按 BM25 合并排序。runtime 最多从每次搜索的 100 个 hit 中分页，预算规范化到 512–8000 tokens，并按约 350 tokens/条换算页大小，最多 40 条。cursor 当前是 base64url 编码的 offset，应视为不透明值。

World claim、Episode 和 correction source 在返回前重新验证 event ID、session、workspace、content hash 和 captured time。`source_expansion` 的 `sourceRefs` 要再通过 `memory_get_sources` 获取完整脱敏事件。

source scope ACL 与完整 SourceRef 校验之外还有 turn 内 capability 授权：`memory_get_sources` 和 `completeTurn.evidenceRefs` 只接受两类 event ID——本 turn Observation/checkpoint 的来源，或已写入本 turn recall trace 的 bundle 来源（包括直接 source hit、claim、conflict、Episode 和 counterexample 来源）。仅知道同 workspace 中另一个 event ID不足以读取或引用它；必须先通过当前 evidence 或本 turn recall 暴露。

当前没有 embedding 召回、实体图排序、时间/线程打分融合；数据库中只为未来能力预留了 embedding 和 entity edge 表。

### 3.5 Completion 与 verifier

`completeTurn` 会：

1. 追加最终助手可见回答事件；
2. 验证调用方提交的每个 `evidenceRef`；
3. 把调用方 `verifierResult` 报告的问题合并进内置确定性 verifier；
4. 更新 turn retry/status 并保存 trace；
5. 若不需要 retry，以本轮输入、输出来源创建 Episode。

内置 verifier 最多允许一次 retry；之后存在冲突则 `clarify`，否则 `abstain`。其能力是刻意有限的：它能汇总调用方给出的 unsupported claim、conflict、policy violation，并识别少量“声称记得但没有 evidence ref”的中英文表达；它不会自行做完整的语义事实核验或策略理解。外部结果只能补充 unsupported/conflict/violation，或通过不足的 coverage/非 pass 状态增加问题；最终状态始终由 deterministic verifier 重算，所以外部 `pass` 不能绕过 floor。

hook 的 Stop 适配目前提交空 `evidenceRefs`；若 verifier 返回 retry，hook 只向宿主输出重试提示，不会自行驱动第二次模型调用。

checkpoint、correction 和 complete 都用 `MemoryStore.transact` 把多步写入包在一个 SQLite transaction（嵌套调用使用 savepoint 语义）中。每个操作把完整结果写进确定性 trace ID：checkpoint ID 来自 turn+observations，correction/complete ID包含调用方幂等键。相同请求重试先读取 trace result 并原样返回，因此不会重复创建 claim/policy/Episode，也不会再次增加 retry count。任一步抛错会回滚该操作内的事件、状态和 trace。

## 4. 记忆与学习模型

### 4.1 权威记录

| 模型 | 用途 |
|---|---|
| `SourceEvent` | 经过脱敏的用户/助手消息、附件引用、工具摘要、checkpoint 和 compaction |
| `Turn` / `Observation` | 固化 TurnPlan、gate、retry、branch/commit 和当前证据 |
| `WorldClaim` | 带 scope、版本、状态、置信度和 SourceRef 的结构化事实 |
| `Episode` | 一个已完成 turn 的标题、摘要和原始 event refs |
| `Policy` | 用户显式或已确认学习的行为规则，带 scope、版本、review status 和来源 |
| `Correction` | 事实、行为或未知类型的纠错事件 |
| `TurnTrace` | begin、checkpoint、recall、complete 等回放信息 |
| `Tombstone` | 删除同步语义；只保留 ID、scope、时间、设备和脱敏 reason |

另有 Trigger、FailureCluster、CalibrationPattern 表和库级 CRUD。其中 calibration 按完整 Agent profile key 隔离；当前没有通过公共 HTTP/MCP 自动训练或发布 calibration 的流程。

### 4.2 纠错路径

- 显式事实纠错且带 `subject`、`predicate`、`value`：通常立即写入 active World claim，并将 turn snapshot 中已存在的旧版标为 superseded。若当前最新版是在该 turn 的 `snapshotRevision` 之后写入，系统把它视为并发纠错：新旧版本都标为 disputed，不做 last-write-wins；在看见双方的新 turn 中再次显式纠正可创建 active 版本并解决该冲突。
- 显式行为纠错：立即写入 approved Policy，不扩大调用方请求的 scope。
- 非显式行为纠错：写入 candidate Policy，并按规范化 correction 文本形成 FailureCluster。达到三个独立 correction、两个 session 时 cluster 变为 `reviewed`，仍不会自动激活 Policy。
- 其他纠错：只保留 correction candidate。

管理员用 `memoryctl approve`/`revoke` 创建新的 Policy 版本。对 `confirmed_learned` candidate，`approve` 会先要求一个包含该纠错、至少 3 个 correction/2 个 session 的 reviewed/promoted cluster；CLI 操作本身是人工确认，操作者仍需审查该模式是否非实体特定。用户显式 Policy 可立即生效。检索只考虑每个 policy ID 的全局最新版本，因此最新 candidate/revoked 不会让旧 approved 版本重新生效。

活动策略排序为：`user_explicit` 高于 `confirmed_learned`；同 authority 下 `session > workspace > user`。宿主安全/权限优先级不在该排序器内，而由宿主负责。

## 5. 存储、版本和删除

### 5.1 SQLite

`MemoryStore` 使用 `better-sqlite3`，文件库启用 WAL、foreign keys、NORMAL synchronous 和 5 秒 busy timeout。schema 通过 `PRAGMA user_version` 顺序迁移；当前 schema version 为 3。

权威写入推进全局 `revision`；FTS 更新记录 `index_revision`。FTS、source link、embedding、edge 和 cache 被视为派生数据。`reindex` 从加密 payload 解密脱敏内容，重建 FTS 和 source link，不改变权威 revision。

### 5.2 幂等与冲突

事件、turn、claim、policy、episode 和 correction 都有稳定 ID/幂等路径。runtime 的 checkpoint/correction/complete 还用带结果的 trace 实现跨多步幂等。重放相同请求返回已有结果；复用同一幂等键或 ID但内容不同会产生 `VERSION_CONFLICT`。导入同样不会执行 last-write-wins。

### 5.3 Forget 与 tombstone

forget 会删除目标权威行、FTS、source link、embedding、entity edge 和 cache。管理接口对 WorldClaim 和 Policy 接受稳定公开 ID，并删除该身份的全部版本。级联是双向的：删除 source event 时，会删除引用它的 claim、Policy、Episode、correction、observation、turn 和 trace；直接删除带来源的 claim、Policy、Episode、correction 或 observation 时，也会删除其原始 source event，继而删除共享该来源的其他派生记录。删除 turn 会先删除 observation、correction 和 trace。全版本删除可避免历史事实内容残留，也避免旧 approved Policy 在新版本消失后重新生效。

该删除策略以隐私完整性优先，粒度不是语义级文本擦除：共享一个 SourceEvent 的多个派生记忆会一起消失，而其他不引用该来源、仅在独立原始消息中提到相似内容的记录不会靠字符串匹配自动删除。管理员应先用 `inspect` 确认目标；仅需停用策略时使用 `revoke`。

tombstone 阻止后到的导入重新创建相同实体。reason 在写入 tombstone 前经过凭据脱敏并截断为 500 字符；被删除的内容不进入 tombstone。

### 5.4 导入导出

导出包包含权威逻辑记录和 tombstone，不包含 FTS 等派生索引；整个 JSON 包再用 AES-256-GCM 加密。导入先应用 tombstone，再按依赖顺序插入事件、turn 和上层记忆，并为目标数据库重新加密 payload。

导入是幂等的记录级流程，但不是全包原子事务或持续同步。发现同 ID 不同内容、缺少依赖时会返回 conflict；其他异常可能在已有部分记录成功后终止。默认拒绝把不同 user scope 导入已有单用户库。

workspace ID 由主密钥参与 HMAC，导入不会重映射 scope。因此跨设备自然共享同一 workspace 需要对齐主密钥/身份；仅给导出包设置 passphrase 不会改变这一点。

## 6. 数据安全与信任边界

### 6.1 脱敏和加密顺序

事件 content、attachments、metadata 和其他 payload 字符串先经过已知秘密模式过滤，再加密。当前过滤器覆盖私钥块、OpenAI/GitHub/Slack token、AWS access key、Bearer token、URL credentials 和常见 secret/password assignment；敏感字段名也会被替换。

AES-256-GCM 使用每条 payload 独立随机 12 字节 IV，并把 `entityType:entityId` 作为 AAD。认证 tag、IV 和 ciphertext 保存在 JSON envelope 中。

这不是整库加密：用于 ACL、状态和搜索的列，以及脱敏后的 FTS 文本是明文。SQLite 主文件、WAL 和备份都应继续按敏感本地数据保护。

### 6.2 Key

daemon 主密钥是 base64url 编码的 32 字节随机值，默认存于 `~/.memoryd/master.key`，权限 `0600`。数据库记录持久化自己的 device ID；用不同 `MEMORYD_DEVICE_ID` 打开既有数据库会失败，避免设备身份漂移。

导出 passphrase 当前仅通过 SHA-256 归一化为 32 字节 key，没有 salt 或 password-hard KDF。因此应使用高熵随机 passphrase，并通过安全通道传递。

### 6.3 网络和用户隔离

HTTP 默认 loopback，可选全局 Bearer token。没有 TLS、每用户 token、权限角色、速率限制或远程管理接口。`userId` 来自请求或 `MEMORYD_USER_ID`，不是服务端认证结果。本项目的安全模型是单个受信本地用户，而不是共享 SaaS。

### 6.4 Prompt injection

召回 bundle 明确附带 `untrustedEvidenceNotice`。MCP instructions、Skills 和 Agent guidance 都要求把 source/Episode 当作引用证据。存储层不会把历史文本放进 Policy；不过最终是否遵守“不执行历史指令”仍依赖 Agent 宿主和提示约束，不是形式化 sandbox。

### 6.5 Hook failure spool

当 hook HTTP 调用失败时，适配器把原始 hook payload、错误和时间用本地主密钥逐条 AES-256-GCM 加密，保存为 `~/.memoryd/spool/hook-failures/*.json`。目录权限为 `0700`，单条文件为 `0600`；明文 payload 不进入文件名或 envelope 外层。

成功的 SessionStart 会调用 `replayHookSpool` 顺序补写最多 100 条，也可显式运行 `memoryctl replay`。每条重放沿用原 payload 生成的幂等键，成功后才删除；遇到首个仍失败、密钥不匹配或损坏的条目便停止，避免让依赖 begin 的 Stop/tool 事件越序。当前没有常驻 worker、退避调度或损坏条目自动隔离。

## 7. Agent 适配与降级

Claude/Codex hooks 当前行为：

- SessionStart：只做 daemon health 检查并注入可用性提示。
- UserPromptSubmit：调用 begin，保存 per-session hook state，注入最多约 1500 tokens 的 TurnPlan 摘要。
- PostToolUse：只保存工具名、input key 名、结果 hash、是否成功；不保存完整工具输出。可信 adapter 直接调用 `/v1/events` 时也执行同一规则：未设置 `selectedEvidence:true` 的 `tool_call/tool_result` 原文会在进入存储层前丢弃。
- Pre/PostCompact：保存 checkpoint 或 compact summary 事件。
- Stop：提交最终助手文本；可能返回 verifier retry 提示。
- SessionEnd：当前无额外动作。

项目级 Claude 安装现在会同时追加根 `AGENTS.md` 中的 shared memory protocol，并安装 `.claude/rules/memory.md`；因此单独运行 `memoryctl install claude --scope project` 也具备 `CLAUDE.md → @AGENTS.md` 的共享 guidance。Codex 项目安装同样合并 shared guidance。用户级 Claude 安装会安装 rule，但不在 home 根创建共享 `AGENTS.md`。

任何 hook 调用失败都会写加密 spool。SessionStart/UserPromptSubmit 返回明确降级提示；其他事件返回空字符串。失败期间的事件不会立即成为权威记忆，但可在后续成功 SessionStart 或显式 replay 时按原幂等语义补写。

generic hook profile 默认声明 `hooks:false`、`stageGates:false`，TurnPlan 因而为 advisory。直接使用 MCP/HTTP 的通用 Agent 可以按实际能力自行设置 profile。

## 8. 当前边界

为避免把预留表或设计意图误写成现有能力，以下功能尚未实现：

- 连续同步、远程复制、CRDT/三方冲突解决和 scope 重映射；
- 实际 embedding provider、向量检索和实体图检索；
- 全自动事实抽取、摘要重建 pipeline 或独立 blob store；
- classifier 训练、calibration shadow/replay 发布流程；
- 自动 Policy 晋升；
- 全语义 verifier；
- hook spool 的后台退避调度/损坏条目自动隔离、守护进程监督和自动备份；
- 多用户认证、远程安全暴露和密钥轮换。

`scripts/benchmark.ts` 可评估当前规则模式下 10 万事件的本机性能，但代码中的目标值是验收目标，不是已保证的 SLA。
