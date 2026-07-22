# memoryd：跨 Agent 的本地长期记忆运行时

`memoryd` 是一个面向 Claude Code、Codex 和其他 Agent 的本地优先长期记忆 MVP。它把原始可见事件、事实、任务片段和行为策略放进同一个 SQLite 权威存储，并在检索历史内容前执行风险识别与证据门控。

当前版本为 `0.1.0`，协议版本为 `1.0`。项目尚未发布到 npm，需从源码构建和链接。

## 已实现能力

- 统一的 `memoryd` sidecar，提供 localhost HTTP API 和 stdio MCP server。
- `SourceEvent`、`WorldClaim`、`Episode`、`Policy`、纠错与 Turn trace 的持久化。
- 规则风险识别；可选 HTTP classifier 只接收压缩特征，不接收原始 prompt 或历史文本。
- `TurnPlan`、当前证据 checkpoint 和服务端检索门。
- 基于 `snapshotRevision` 的召回上界，以及 turn 内 checkpoint/recall trace 的来源授权。
- SQLite WAL、FTS5/BM25、user/workspace ACL、稳定 revision 和幂等写入。
- 并发事实纠错以 disputed 版本保留，不执行静默 last-write-wins。
- 原文先按已知凭据模式脱敏，再用 AES-256-GCM 加密；FTS 只保存脱敏后的派生文本。
- 带来源的事实与 Episode 召回，以及原始脱敏事件展开。
- Claude Code、Codex 的 hooks、MCP、Skills 安装器；通用 Agent 可使用 MCP、HTTP 或 hook wrapper。
- 本地管理命令：检查、策略审批/撤销、遗忘、加密导入导出、重建索引和健康检查。

它不是云同步服务、完整语义向量数据库、多用户服务，也不是一个能够自动理解所有事实和策略违规的通用裁判。详见“[设计覆盖与实现状态](#设计覆盖与实现状态)”和“[MVP 边界](#mvp-边界)”。

## 设计覆盖与实现状态

以下状态对照 [记忆架构.md](记忆架构.md) 与 [记忆架构讨论原文.md](记忆架构讨论原文.md) 核查当前 `0.1.0` 实现。结论是：**在线快速控制层基本落地，慢速学习层主要停留在候选聚类、存储模型和人工审批。**

### 已实现

| 设计 | 当前实现 |
|---|---|
| Feature Extractor | [src/core/features.ts](src/core/features.ts) 的 `extractFeatures()` 提取 `hasImage`、`taskType`、`entitiesCount` 等特征；`compressedClassifierFeatures()` 只向可选分类器发送隐私压缩投影。 |
| Risk Recognizer 两级架构 | [src/core/risk.ts](src/core/risk.ts) 提供 8 类确定性风险规则和 `RiskClassifier` 接口，[HTTP classifier](src/providers/http-risk-classifier.ts) 提供可插拔实现；每个风险码取规则、分类器与 calibration 贡献的最大值。 |
| Cognitive Mode Controller | [src/core/mode.ts](src/core/mode.ts) 分级控制 `evidenceFirst`、`uncertainty`、`retrieveOriginalSource`、`askClarification` 和 `narrativeCompletionGate`，并在 `TurnPlan.retrievalStages` 中声明检索顺序及 checkpoint 门。 |
| 模式控制后的 Memory Retrieval | [src/runtime.ts](src/runtime.ts) 通过 `beginTurn()` → `checkpointEvidence()` → `recall()` 串起在线链路；未满足证据门时，服务端以 `STAGE_BLOCKED` 拒绝领域记忆召回。 |
| 纠错归因、聚类与晋升阈值 | `submitCorrection()` 将显式事实写入 World Memory，并把并发冲突标为 `disputed`；行为纠错由 `recordCandidateCluster()` 聚类，至少 3 次独立纠错、覆盖 2 个 session 后仍需人工 `memoryctl approve`。 |
| Verifier | [src/core/verifier.ts](src/core/verifier.ts) 汇总证据覆盖、冲突、Policy 违规和 unsupported claim，并检测少量“无证据声称记忆”的中英文表达；失败最多重试一次，之后 `clarify` 或 `abstain`。 |
| Episode 原始来源 | `createEpisode()` 保存用于定位的 title/summary，同时用 `eventRefs` 指向权威 SourceEvent；`memory_get_sources` 可按经过授权的 SourceRef 展开脱敏原文，摘要不会替代来源。 |
| Counterexample | 行为纠错持久化 `wrongStatement` 和来源；`recall()` 会在 MemoryBundle 中附带当前作用域最近最多 10 条行为纠错作为反例。 |

### 部分实现

- **Self Calibration Profile**：`calibration_patterns` 已有表、CRUD 和按完整 Agent profile 隔离的消费端，`beginTurn()` 会把活动 pattern 叠加到风险概率；但没有纠错驱动的自动写入、训练、历史回放或 shadow 发布流程。
- **混合检索**：当前只有 FTS5/BM25、scope ACL 和 SourceRef 展开；embedding、实体图、时间邻近和线程邻近融合尚未接入，相关表仅为未来能力预留。
- **三层记忆**：World、Episode、Policy 模型均已存在，Policy 支持 user/workspace/session 作用域；但 session Policy 不会在对话结束时自动清除，World Memory 也没有实体图遍历。
- **Episode 切块**：当前每个成功完成的 turn 生成一个 Episode，不按人物首次出现、纠错或情绪转折等叙事边界切分；summary 是最终回答的前 400 个字符。
- **快慢双轨**：风险识别、模式切换、门控检索和验证构成快速在线层；慢速层只有纠错聚类、候选 Policy 和人工审批，没有独立离线分析进程。

### 未实现

- **Trigger 运行时与自动学习**：只有持久表和库级 CRUD；Trigger 尚未参与风险识别、Policy 激活或检索，激活频率衰减和从重复纠错自动生成 Trigger 也未实现。
- **Policy 分层和依赖调度**：没有 L1/L2/L3/Archive 调度、Dependency 加载或 Policy Graph。按最终设计，Policy 本体保持不衰减；缺失的是 Trigger activation-frequency decay 与条件重新出现时的自动激活。
- **Re-experience pack 工作集**：尚不能自动组合近期 20–50 轮原文、完整历史片段、关键事件、情绪片段和事实约束表。
- **聚类后更新 Risk Recognizer**：FailureCluster 不会自动生成或发布新的风险模式；候选仍需要人工审查和审批。
- **按风险模式动态选择检索策略**：检索 stage 顺序基本固定，尚无 `entity_merge → 精确名称 → 时间线 → 关系图` 等按风险切换的策略表。
- **检索后重排序与证据覆盖排序**：`sourceCoverage` 目前是报告指标，不参与候选重排或返回顺序。

**一句话总结：**“危险识别 → 模式切换 → 门控检索 → 验证 → 纠错入口”这条在线主链路已经贯通；Calibration 自更新、Trigger、Policy 分层调度、混合检索和工作集重建等慢速元认知闭环仍依赖后续实现与人工 CLI 审批。

## 运行结构

```text
Claude Code / Codex / Generic Agent
        │ hooks + Skills + MCP
        │             └──────────────┐
        ▼                            ▼
  memoryctl hook               memory-mcp (stdio)
        │                            │
        └──────── HTTP ──────────────┘
                     ▼
             memoryd 127.0.0.1:7337
        Risk → TurnPlan → Gate → Recall → Verifier
                     │
                     ▼
          SQLite WAL + FTS5 + encrypted payloads
```

MCP server 是 HTTP daemon 的代理，因此使用 MCP 前必须先启动 `memoryd`。

## 快速启动

要求 Node.js 22+ 和 pnpm 10。

```bash
pnpm install
pnpm build
pnpm link --global

memoryctl start
memoryctl doctor
```

如果本机不使用 pnpm 全局链接，也可在项目根运行 `npm link`。无论采用哪种方式，都应确认以下命令对 Agent 启动时的 `PATH` 可见：

```bash
command -v memoryctl
command -v memory-mcp
```

开发时可不链接，直接运行：

```bash
pnpm dev                 # 前台启动 HTTP daemon
pnpm cli -- doctor       # 另一个终端
pnpm mcp                 # 手工启动 stdio MCP
```

但自动安装的 hooks 和 MCP 配置使用裸命令 `memoryctl`、`memory-mcp`，正式接入 Agent 时仍需把构建后的 bin 放进 `PATH`。

### 安装 Agent 适配器

在需要接入记忆的目标仓库中运行：

```bash
memoryctl install all --scope project
```

安装器会修改项目内的 Agent 配置。请先审阅 diff，再在 Claude/Codex 中信任新 hooks 和 MCP server，并重启宿主。需要同时接入两个宿主时推荐使用 `all`；Claude 项目级安装现在也会自行安装共享 `AGENTS.md` guidance，不再依赖 Codex 安装步骤。

用户级安装使用：

```bash
memoryctl install all --scope user
```

## 配置

| 环境变量 | 默认值 | 用途 |
|---|---|---|
| `MEMORYD_HOME` | `~/.memoryd` | 状态目录；保存 DB、key、device ID、日志和 hook 状态 |
| `MEMORYD_DB` | `$MEMORYD_HOME/memory.db` | SQLite 文件路径 |
| `MEMORYD_KEY` | `$MEMORYD_HOME/master.key` | 32 字节主密钥文件路径，不是密钥文本 |
| `MEMORYD_HOST` | `127.0.0.1` | HTTP 监听地址 |
| `MEMORYD_PORT` | `7337` | HTTP 端口 |
| `MEMORYD_URL` | 由 host/port 组成 | MCP、hook 和客户端访问 daemon 的 URL |
| `MEMORYD_TOKEN` | 未设置 | 可选的全局 Bearer token；设置后所有 HTTP 路由都要求它 |
| `MEMORYD_DEVICE_ID` | 持久化随机 UUID | 当前数据库的设备 ID |
| `MEMORYD_USER_ID` | `local-default` | CLI/hook 写入的逻辑用户作用域；它不是认证身份 |
| `MEMORYD_AGENT_VERSION` | 宿主版本或 `unknown` | hook 生成的 Agent profile 版本 |
| `MEMORYD_RISK_CLASSIFIER_URL` | 未设置 | 可选 HTTP 风险分类器 URL |
| `MEMORYD_RISK_CLASSIFIER_TOKEN` | 未设置 | 分类器 Bearer token |

直接把 `MemoryStore` 当库使用且未传 `encryptionKey` 时，还支持 `MEMORYD_ENCRYPTION_KEY`；daemon 本身始终从 `MEMORYD_KEY` 指向的文件加载密钥。

默认只监听 loopback。若改为非本机地址，至少应设置 `MEMORYD_TOKEN`，并在受信网络或 TLS 反向代理之后使用；当前服务自身不提供 TLS、用户级认证或速率限制。

## Agent 接入

### Claude Code

项目级安装会：

- 合并 `.claude/settings.json`，写入 `autoMemoryEnabled:false`，并接入 SessionStart、UserPromptSubmit、PostToolUse、Pre/PostCompact、Stop 和 SessionEnd hooks；
- 追加 `CLAUDE.md`，使用 `@AGENTS.md` 并声明 `memoryd` 是权威记忆源；
- 项目级安装向根 `AGENTS.md` 追加 shared memory protocol；所有 scope 都安装 `.claude/rules/memory.md`；
- 安装 `.claude/skills/memory-{recall,remember,forget}`；
- 合并 `.mcp.json`，注册 stdio server `memory-mcp`。

现有 hooks 会被保留并与模板合并。`SessionEnd` 当前没有额外 flush 行为，只是预留生命周期入口。

### Codex

项目级安装会：

- 追加根 `AGENTS.md` 中的 Codex guidance 和 shared memory protocol；
- 合并 `.codex/hooks.json`；
- 在 `.codex/config.toml` 尚无相应 table 时追加 `memoryd` MCP、hooks 和禁用原生 memories 的配置；
- 安装 `.agents/skills/memory-{recall,remember,forget}`。

若 `config.toml` 已有 `[features]`、`[memories]` 或 `[mcp_servers.memoryd]`，安装器不会改写已有 table，只会在结果的 `notes` 中提示人工核对。

Claude/Codex 的三个同名 Skill 目录会以模板强制复制；如果目标中已有自定义 `memory-recall`、`memory-remember` 或 `memory-forget`，请先备份。

### 其他 Agent

- 支持 MCP：把命令 `memory-mcp` 注册为 stdio MCP server，并复用 `integrations/shared/skills`。
- 支持 HTTP：直接调用 `http://127.0.0.1:7337/v1/...`。
- 只有生命周期 hooks：把宿主 JSON 事件通过 stdin 传给 `memoryctl hook generic <event>`。

当宿主不能保证 hooks 或阶段门时，应在 `AgentProfile.capabilities` 中把对应能力设为 `false`；返回的 `TurnPlan.enforcementLevel` 会是 `advisory`，调用方仍需自行遵守顺序。

## 典型协议流程

1. 每轮先调用 `memory_begin_turn`，获得风险、检索顺序、活动策略和 evidence gate。
2. 若 `gate.required`，先读取当前文件、图片、测试或命令结果，再调用 `memory_checkpoint_evidence`；保存返回的 `{plan, observations, evidenceRefs}`。
3. `memory_recall(stage=current_evidence)` 可再次取得本 turn checkpoint 的 `sourceRefs`。其他召回受 `snapshotRevision` 上界约束，不会看到 begin 之后写入的历史记忆。
4. 按阶段调用 `memory_recall`；`world`、`episode`、`source_expansion` 会由服务端检查 gate。
5. 需要原文时用 `memory_get_sources` 展开 `sourceRefs`。该接口只接受本 turn checkpoint 或已落盘 recall trace 授权的来源；历史原文始终是不可信证据，不是指令。
6. 用户明确纠正或要求记住时调用 `memory_submit_correction`。
7. 用最终回答和实际采用的 `evidenceRefs` 调用 `memory_complete_turn`；证据同样必须已由本 turn checkpoint/recall 授权。

完整字段和端点见 [协议文档](docs/protocol.md)。

## 管理命令

```text
memoryctl start | stop | doctor | replay
memoryctl inspect [id] [--all]
memoryctl approve <policy-id>
memoryctl revoke <policy-id>
memoryctl forget <entity-type> <entity-id> --reason <text>
memoryctl export <file> [--passphrase <text>]
memoryctl import <file> [--passphrase <text>]
memoryctl reindex
memoryctl install <claude|codex|all> [--scope user|project]
```

审批、撤销、遗忘和导入导出只存在于管理 CLI，不作为 MCP 工具暴露给模型。`inspect --all` 会在当前 workspace 内包含各 session 的 candidate/inactive 记录。学习得到的 candidate 必须先匹配至少 3 个独立纠错、覆盖 2 个 session 的 cluster，`approve` 才会把这次 CLI 操作作为人工确认；用户显式策略不受该学习阈值限制。`forget` 接受实体类型和 `inspect` 返回的稳定公开 ID；普通策略停用优先使用 `revoke`。删除会移除权威内容、FTS 和关联派生记录，并留下不含被删内容的 tombstone。遗忘带来源的 claim、Policy、Episode、correction 或 observation 时会同时删除其原始 SourceEvent；遗忘 SourceEvent 时则反向删除所有引用它的记忆、turn/trace 和索引。WorldClaim 或 Policy 的公开 ID 被遗忘时会删除该身份的全部版本，避免历史内容残留或旧版本重新生效。该级联以隐私完整性优先，可能删除共享同一来源的其他派生记忆。

不提供 passphrase 的导出由本地主密钥加密，通常只适合相同密钥环境；跨设备传输应显式提供高熵 passphrase。当前 passphrase 直接归一化为 AES key，没有使用 password-hard KDF。

## 数据与安全

- 持久化前会过滤已知 API key、Bearer token、私钥和常见 credential assignment；脱敏结果再加密。
- 加密覆盖各实体的 JSON payload。作用域、时间、状态、部分检索字段以及脱敏后的 FTS 文本仍是 SQLite 明文字段；这不是整库加密。
- key 和状态目录默认分别以 `0600`、`0700` 创建。丢失主密钥将无法恢复已加密 payload。
- workspace ID 由规范化 Git remote（无 remote 时为真实路径）和主密钥做 HMAC 得到；branch/commit 随事件和 turn 保存。
- FTS 检索先物化 user/workspace 允许集合，再匹配文本。当前 Bearer token 是服务级 token，`MEMORYD_USER_ID` 只是逻辑作用域，因此该 MVP 不应作为不互信用户共享的服务。
- checkpoint、correction 和 complete 涉及的事件、记忆、turn 更新与结果 trace 在同一 SQLite transaction/savepoint 内提交；确定性 trace ID 使相同请求重试直接返回首次结果，不重复消耗 verifier retry。
- adapter 提交的未选中 `tool_call/tool_result` 不保存原文，只保留白名单元数据和 SHA-256 摘要；只有 `selectedEvidence:true` 的工具证据才会经过脱敏、加密后成为 SourceEvent。
- hook 调用失败时，原始 hook payload 和错误会分别加密保存到 `$MEMORYD_HOME/spool/hook-failures/*.json`（目录 `0700`、文件 `0600`）。成功的 SessionStart 会按顺序重放最多 100 条，也可显式运行 `memoryctl replay`；遇到首个仍失败或损坏的条目时停止，以免越过依赖事件。

更完整的信任边界和存储设计见 [架构文档](docs/architecture.md)。

## 降级行为

hook 无法连接 daemon 时会允许 Agent 继续工作，并在 SessionStart/UserPromptSubmit 返回“记忆不可用，不得声称已召回”的提示；其他 hook 静默返回。失败事件进入加密、逐文件的幂等队列；后续成功的 SessionStart 或 `memoryctl replay` 会顺序补写。当前没有独立后台调度器、退避策略或自动清理损坏条目。

可选风险 classifier 超时或失败时，确定性规则继续运行。`MemoryClient` 默认 HTTP 超时为 2 秒；MCP 和 hooks 通过它访问 daemon。

如果 MCP 配置把 server 标记为 required，宿主自身可能在 MCP 启动失败时拒绝启动或报告错误，这属于宿主行为，并不由 `memoryd` 的 hook 降级逻辑控制。

## MVP 边界

当前没有实现：

- 连续或云端同步、设备间冲突合并、workspace identity 重映射；只有加密导入导出和 tombstone。
- 后台持续 replay、退避调度和损坏 hook spool 的自动隔离；当前只在 SessionStart 或显式 CLI 调用时顺序重放。
- 从任意对话自动抽取事实；事实和策略主要来自显式 correction，Episode 在成功完成 turn 后生成。
- 完整语义 verifier。内置 verifier 会检测少量“声称记得但没有证据”的表达，并合并外部 `verifierResult` 报告的问题；外部状态只能收紧结果，不能用 `pass` 绕过 deterministic floor。
- 强隔离的多用户服务、远程 TLS、密钥轮换和后台备份。

导入是可重复的记录级过程，但不是跨设备持续同步，也不是全包原子事务。tombstone 优先，已有同 ID 不同内容会报告冲突而不是覆盖。workspace ID 依赖本地主密钥；跨设备希望自然命中相同 workspace 时，需要保持一致的主密钥/身份配置。

## 开发与验证

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm bench
```

当前测试套件为 7 个测试文件、39 项测试。benchmark 默认写入 10 万条临时事件并报告 preflight/recall p95，同时显示目标值；目标值不是在所有机器上的性能保证。可用 `MEMORYD_BENCH_EVENTS` 和 `MEMORYD_BENCH_ITERATIONS` 调整规模。

协议 JSON Schema 位于 `schemas/memory-protocol-v1.schema.json`。设计背景见 `记忆架构.md` 与 `记忆架构讨论原文.md`。

宿主适配依据：[Claude Code memory](https://code.claude.com/docs/en/memory)、[Claude Code hooks](https://code.claude.com/docs/en/hooks-guide)、[Claude Code MCP](https://code.claude.com/docs/en/mcp)、[Codex AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md)、[Codex hooks](https://learn.chatgpt.com/docs/hooks)、[Codex MCP](https://learn.chatgpt.com/docs/extend/mcp)。宿主版本升级后，应重新核对生成的配置并运行端到端测试。
