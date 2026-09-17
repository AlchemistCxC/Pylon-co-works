# ADR-0008 内核落盘路径：流式 chunk 聚合 + 批事务

> 入库保留。编号顺延，按编号命名。
> 产出路径：`.agents/decisions/0008-kernel-ingest-delta-aggregation.md`

- **日期**：2026-09-18
- **状态**：提议（规划阶段，未施工）
- **议题**：issue #155

## 背景与约束

`canonical_events` 是唯一 durable 会话历史权威（`msg_repo/mod.rs:113`，schema v14）。其写入路径当前是：**每个到达的流式 chunk 一个独立 SQLite 事务**。

`dispatcher/routing.rs::commit_live_event` 对每个 session update 调一次 `ingest_event` → `session/event_repo.rs::ingest_kernel_event`：`BEGIN → 墓碑查询 → revision 读 → INSERT → （终态时同事务折叠 rollup）→ COMMIT`。前端 `canonicalEventSink`（含 #81 L1 的合并规则、1000ms debounce）在生产**没有调用方**——`turn_rollup.rs` 自述「生产唯一写路径是 kernel——前端 sink 自写轨无生产 offer 调用方」。

实测（真实 schema + 真实行形状，WAL + `synchronous=NORMAL`，写 1200 个 chunk）：

| 事务策略 | 事务数 | 耗时 | WAL 累计 | 每 chunk WAL |
|---|---|---|---|---|
| per-chunk（现状） | 1200 | 150 ms | **23,533 KB** | 19.6 KB |
| 每 25 行 | 48 | 28.5 ms | 2,981 KB | 2.5 KB |
| 每 50 行 | 24 | 27.3 ms | 2,028 KB | 1.7 KB |
| 单事务 1200 行 | 1 | 27.4 ms | 813 KB | 0.7 KB |

成因是机制性的：单行 INSERT 脏「表叶页 + 两棵唯一索引叶页」（约 4–5 页 = 19.6 KB），autocommit 下每 chunk 重新追加。**28× 写放大**（23.5 MB 写入存 840 KB 数据）。附带效应：auto-checkpoint 阈值 1000 页，按此形态流式期间**约每 200 chunk 触发一次 checkpoint**（fsync + 可能阻塞写）。

第二层放大：`event_id` 是主键且**恒等于 `owner_key || '#' || sequence`**（实测 1155/1155 行成立），与 `UNIQUE(owner_key, sequence)` 守同一逻辑键，每次 INSERT 多维护一棵 btree。

**必须守的约束（以下每条都在本 ADR 的备选筛选中起否决作用）**：

1. **durable-before-project**：行先落盘、再 `publishPluginEvent` 给前端（`canonicalEventFeed` 的 cursor→publish 顺序）。聚合只能推迟「落盘时刻」，不得让前端看到未落盘的行。
2. **append-only**：不允许把既有行原地 UPDATE 追加文本——那会破坏 sequence/revision 契约、前端 cursor 的 gap 定向补读与 `expectedRevision` 乐观并发。
3. **L3 sha256 等价性**：`turn.unit.contentSha256` 必须与「裁剪前那些行重折叠」逐字节一致（`turn_rollup.rs::fold_turn_rows` 与 trim 校验共用同一字节源）。
4. **读侧跨度契约已定死**：批量行形状见 `canonicalEventBatch.ts`——`typedPayload.seqSpan=[first,last]`、`rawPayload` 为原始 chunk 数组（长度 == `foldedCount` == 跨度宽度）、读侧按 `owner#(seqStart+i)` 重建原始 id。
5. **48 KiB 预算**：`event_repo.rs:140 MAX_CANONICAL_RAW_BYTES = 64 KiB`，`retain_raw_payload`（`:241`）越线会把 raw 截断成 `{_pylonTruncated, preview}` ⇒ chunk 数组不可逐字节还原、约束 3 失效。故聚合预算须落在 64 KiB 之内（前端取 48 KiB）。

## 备选方案

| 方案 | 否决理由 |
| --- | --- |
| A. 只批事务，行粒度不变（每 chunk 一行） | 收益只有事务/写放大那一段（-87% 写入），行数与行成本不变；且与 B 的实施面几乎相同却不解决「每 chunk 一行」的根本冗余 |
| B. **内核 ingest 承担聚合**：相邻同类同 identity 的 delta 聚合成一条 batch 行，同一窗口内一次事务写入 | —（采纳） |
| C. 原地 UPSERT 单行增长（真正「一条消息一行」） | 违反约束 2：破坏 append-only 与 sequence/revision 契约；前端 cursor 的 gap 补读、`expectedRevision` 乐观并发、L3 的「重折叠 sha256」都建立在行不可变之上 |
| D. 不写 delta，只在终态写 `turn.unit` | 违反约束 1 的 mid-turn 面：崩溃丢整段回合文本；且 bind/refresh 期间读不到在途内容（`preserveActiveGeneration` 只覆盖投影间隙，不覆盖「无行可读」） |
| E. 保留现状，让前端 sink 承担合并 | sink 在生产无调用方（内核已是唯一写者）；要它生效就得把生产写路径搬回前端，与 P52「canonical committed row 的唯一前端入口」方向相反，且引入双写者竞争 |
| F. 只做 schema 瘦身（去冗余主键 + 行瘦身） | 不解决事务边界这一主因；实测单行事务的 19.6 KB 里，4–5 页是页级成本，瘦身只能减少页内字节，不能减少被脏的页数 |

方案 C 的诱惑最大（字面上就是「同一条消息聚合成一条」），但它与约束 2、3 正面冲突：把行做成可增长的，就必须让 sequence/revision 语义、cursor 去重、L3 等价性各自重写，且失去「rawPayload 逐字节可还原」。方案 B 用**既有编码**（`*.delta.batch` + seqSpan）拿到同样的行数收益，代价只是「一条消息可能分成数个窗口行」。

## 决定

**采纳方案 B**，并把落盘优化收敛为一条链：**聚合行（行粒度）→ 批事务（事务边界）→ 瘦身行（字节）**，三者乘性叠加。

1. **聚合责任下移到内核 ingest**：按「同 owner + 相邻同类 delta + identity 全字段相等 + 未超 48 KiB / 2000 chunk 预算」聚合为一条 batch 行，复用既有 `*.delta.batch` 编码与 seqSpan 语义（读侧无需新契约）。
2. **一个窗口一个事务**：窗口内同 owner 的 update 合并为一次 `BEGIN…COMMIT`，一次墓碑检查、一次 revision 读、一次 rollup 判定。
3. **边界立即 flush**：终帧 / 回合边界 / 切会话 / 应用关闭不等待窗口（对齐约束 1）。
4. **规则单一实现 + parity 契约**：聚合规则以 TS 侧 `canonicalEventBatch.ts` 为规范，Rust 实现须由 parity 契约测试钉定（对齐既有 `check:acp-shadow-parity` 的纪律），避免两套规则漂移。
5. **schema 破坏性重建**（本 ADR 授权、但独立成步）：以 `(owner_key, sequence)` 作主键（`event_id` 改为派生列或去列）、常量列外移或合并、`auto_vacuum=INCREMENTAL`、设 `application_id`、回收 74% 闲置页。存量无需兼容（无外部用户）。
6. **`fold_segments` 的类型表扩展（而非文本来源改造）**：聚合行**自带** `typedPayload.text`（拼接结果，见 `canonicalEventBatch.ts::buildBatchRow` 与 `canonicalEventSink.batch.test.ts` 的断言 `typedPayload = { text, foldedCount, seqSpan }`），因此折叠**不需要**去展开 chunk 取文本。真正要改的只有类型表：`turn_rollup.rs::is_foldable_delta` / `static_delta_type` 目前只认 `assistant.text.delta` / `assistant.thinking.delta`，会把 `*.delta.batch` 行判成不可折叠、退化为 `Segment::Event` 整行嵌入（单元膨胀且不再折叠）。加入 batch 类型映射到其基类型后，折叠结果与折叠原始单 chunk **逐字节相同**（证明见「后果 · 正面」）。
7. **`canonicalEventCursor` 必须获得跨度感知（本次唯一"改重放模型"的地方）**：游标的连续性契约是 `event.sequence === cursor + 1` 且消费后 `cursor === notification.sequence`（`canonicalEventCursor.ts`）。内核一旦写出 `sequence = 跨度末条` 的聚合行，行与行之间出现编号跳跃 ⇒ 游标判 `canonical_gap_unrecoverable` 抛错。必须让游标以「行 → 占用跨度」访问器判连续性：**仅 `*.delta.batch` 行的 `seqSpan` 是占用声明**（跨度中间编号无任何行占用，读侧按 `owner#(seqStart+i)` 重建）；**`turn.unit` 的 `rollup_seq_start/end` 是覆盖声明**（所指的行在裁剪前仍然存在）。两者不可同一处理——把 unit 的覆盖跨度当占用会让游标跳过仍然存在的 delta 行，静默丢数据。
8. **先钉死再改（纪律，不是步骤）**：本次会动「重放模型」的边界。施工顺序固定为：**先**为现状写特征化测试并验证其全绿（钉死"今天正确的行为"），**再**改动，且改动只允许是"为跨度新增支持"，不得改变既有逐 chunk 行下的任何可观测行为。
9. **合批口径 = 方案 B（回合/消息边界落盘，用户 2026-09-18 选定）**：聚合 run 在**遇到任何非同类 delta 事件时立即 flush**（该边界即"消息结束"：工具卡、user.message、turn.completed、usage/session 状态行都切断 run），另在**预算越线、终帧、切会话、应用关闭**时 flush。不设固定行数/时间窗。已接受的两项后果：① mid-message 期间该消息正文不在 journal（崩溃丢失窗 = 单条消息长度）；② 在途期间 bind/refresh 读不到该消息正文。
   - 兜底可逆性：把"最大驻留时长"实现为**单个具名常量**，B 的取值为"不设上限"；若要改为"B + 1s 兜底"（把崩溃丢失窗从整条消息压回 1s），只需改这一个常量，无需改设计。
   - 长消息仍会被 48 KiB / 2000 chunk 预算切成多行（实测约 338 chunk/行），故"一条消息一行"在物理上只对短消息成立。
10. **重放模型的处置范围（用户 2026-09-18 授权重写）**：只重写**"行语义"这一层**——把「一行占用哪些 sequence / 覆盖哪些 sequence / 归一化后是哪些 per-sequence 事件」收敛为**单一事实源**，并让游标与既有展开器都走它。**不重写投影与等价那一半**：`agentWorkbenchSession.batch.test.ts`（batch 展开逐字节一致、unit 展开等价、段级隔离）与 `replayCrossLineContract.test.ts`（complete/truncated 可分、稳定机器码）已把"正确重放"钉在投影层且全绿，整体替换它们等于拿掉本次唯一的正确性基线。

## 追加（2026-09-18）：mid-stream 重放要求对方案 B 的修正 —— 两级存储（提议，待确认）

### 要求

用户提出：**在流式输出过程中切换页面后，重放必须正确**，并授权「设计新的存储方案，而不是行级别的存储」。

### 方案 B 单独用不成立

`turn.unit` 只在终态构建（`turn_rollup.rs`：未终结 turn 不折叠），因此**在途回合的内容今天由逐 chunk 行承载**（存量证据：1064 条 delta 行无对应 unit）。由此：

- **中途切 sheet（keep-alive）**：组件不卸载（`AgentRendererSuiteWorkbench` 的 `{isActiveSheet && <ActiveAgentSessionLifecycle/>}` 只 gate 生命周期链），runtime/TurnClock/document/stream channel 全部存活，帧继续 `applyLive` 写入内存文档；回到该 sheet 时 `activate → startPersistedLoad → refresh` 以 `initialDocument: current` 把 journal 折在 live 文档上，靠 coverage 互斥去重。此路径今天正确，但**正确性建立在内存状态之上**。
- **中途切 sheet / 应用重启后重新 bind**：无内存可依，只能读 journal；逐 chunk 行使部分正文可重放。此路径今天正确。

**方案 B 使第二条失效**：消息边界才落盘 ⇒ 在途消息在 journal 中无任何行 ⇒ 冷重放得到"空回合"。第一条仅由内存侥幸遮蔽。故「落盘节奏可以粗」与「在途回放必须精确」必须解耦；行级存储把二者绑死，B 则牺牲了后者。

### 备选（追加）

| 方案 | 否决理由 |
| --- | --- |
| G. **两级存储**：append-only 已提交历史（消息/回合粒度）+ 显式非历史的在途尾巴（`canonical_event_draft`，原地 UPDATE，粗节奏） | —（提议采纳） |
| H. B + 仅内存承载在途文本 | 冷重启即在途内容永久丢失（journal 无行、`canonical_events` 为唯一权威、local wins 不允许 replay 补齐）；且正确性依赖"组件不卸载"这一实现细节 |
| I. B + 1s 兜底窗口 | 只把丢失窗压到 1s，仍是丢；且历史里仍会留下按窗口切的中间行，行语义与 unit/trim 依旧纠缠 |

### 方案 G 结构

```
① 已提交历史（append-only，唯一权威）：canonical_events，每条消息/每回合 1 行，无逐 chunk 行
② 在途尾巴（显式非历史）：canonical_event_draft
   - 键 (owner_key, turn_id, message_id) 单行；原地 UPDATE；节奏 = 单个具名常量（如 200ms）
   - 永不参与 evt_* 历史读；只经专用 live-tail seam 暴露给 bind/refresh
   - provenance 显式 draft/unverified ⇒ 不构成第二种历史源
   - 消息提交：同事务 INSERT 正式行 + DELETE draft（原子换手；不存在"两者都在"或"两者都无"的窗口）
   - 读取判据（硬规则）：账本 `cold_mount_turn_snapshot.turn.phase` 为 prompting/streaming/settling
     ⇒ history ∪ tail；为 terminal ⇒ 仅 history，且存在的 tail 视为陈旧并清除
```

### 量化对比（600 chunk 的单条消息，沿用实测基数）

| | 今天 | 仅 B | 方案 G |
| --- | --- | --- | --- |
| 落盘量 | ~11.8 MB | ~0.2 MB | **~1.8 MB**（150×单行 UPDATE×~12 KB） |
| 历史行长 | 600 | 1–2 | **1** |
| 在途冷重放 | 精确 | **丢失** | **精确** |
| 崩溃丢失窗 | 0 | 整条消息 | **≤ 一个 draft 节奏** |
| 裁剪机制 | 需 unit + sha256 等价 | 仍需要 | **新回合不再需要**（历史无 chunk 行可裁） |

### 后果

- **正面**：在途回放精确性不再依赖内存存活；崩溃丢失窗从"整条消息"收回"一个 draft 节奏"；历史行数再降一个数量级；**L2/L3（rollup + trim）对新数据退役**——它们存在的唯一目的是压缩逐 chunk 行，而新数据没有可压缩对象，于是「trim 需先有 unit 且 sha256 相等」整类脆弱性对新数据消失（保留机器只为读存量）。
- **负面**：多一张表与一个 seam；需显式维护"draft 不是历史"的边界（历史读必须排除它，否则变成第二历史源）；`evt_rollup_trim` 的语义要按"存量 vs 新数据"分流。
- **风险**：draft 的原地 UPDATE 会反复脏同一页（~3 页/次），节奏定得过密会重新推高写入量——故节奏常量化并纳入验收（见 spec 的 S6 验收项）。

### 衔接

读取判据所需的权威信号已存在且**已有前端消费方**：`ColdMountTurnSnapshot.turn.phase`（`src-tauri/src/acp/turn_ledger.rs` 的 `TurnPhase`）经 `load_persisted_session` 回到前端 `refresh`（#68 修复的账本兜底，`.agents/records/issue-68-generator-indicator-terminal-delivery.md`）。

## 分期落地（2026-09-18，回应用户风险顾虑）

用户反馈：「这一次改动风险非常高，我不确定能不能稳定落地，但不彻底重构，持久化的存储压力非常大」。

**关键事实：写入压力与重放风险不是同一个变量。** 逐 chunk 行有两条独立的成本：

1. **事务边界成本**（每 chunk 一次提交 ⇒ 每次脏 4–5 页 ⇒ 19.6 KB WAL/chunk）：**与行形态无关**，只批事务即可消除，行结构一字不改。
2. **行粒度成本**（600 行/消息 × 542 B）：**必须改行语义**才能消除，因此是唯一会动重放模型的一层。

于是存在一条"只吃第 1 条、不碰第 2 条"的安全路径：

| 阶段 | 内容 | 落盘/存储效果 | 风险 | 在途切页重放 |
| --- | --- | --- | --- | --- |
| **T0** | 回收 74% 闲置页 + 删死表（一次性脚本） | 库 3.5 MB → ~0.9 MB | 数据操作（有备份），零代码 | 不受影响 |
| **T1** | **只批事务**：同窗口同 owner 一次 `BEGIN…COMMIT`，**仍逐 chunk 一行** | WAL/chunk 19.6 KB → 2.5 KB（**-87%**）；checkpoint 频率 -8× | **低**：行结构、sequence、eventId、payload 全不变 ⇒ 游标 / 投影 / 折叠 / 裁剪 / coverage 零改动 | **自动保持**（行仍是逐 chunk durable） |
| **T2** | 一次破坏性重建：行瘦身（542 → ~250 B/行）+ `(owner_key,sequence)` 主键 + `auto_vacuum=INCREMENTAL` + `application_id` | 每消息 325 KB → ~150 KB（-54%）；不再产生闲置页 | **中**：schema 破坏性，但有 SCHEMA_MANIFEST / DEL-01 审计 / 版本迁移链做护栏；读侧字段映射需逐项核对 | 保持 |
| **T3** | 行聚合（消息粒度历史 + draft 尾巴） | 每消息 600 行 → 1 行；库增长再降约 2 个数量级 | **高**：动重放模型（跨度语义、游标、折叠、trim） | **必须靠 draft tail 才能保持**——这正是 T3 与前两层的根本区别 |

**T1 的验收判据是可判定的、而不是承诺**：把同一段输入喂给改造前后，产出的行集合除 `received_at` 的毫秒值外**逐字段相等**（sequence / eventId / eventType / typedPayload / rawPayload / identity / provenance 全部相同），且**既有重放与等价测试原样全绿且未被修改**。满足这两条即证明"重放模型没有被移动"。

**T3 与 T1/T2 的关系不是累积依赖**：T1/T2 把写入压力与体积降到一半以下之后，若实测增长可接受，**可以永远不做 T3**——重放模型保持完整并被钉死，这是正当的终点而非妥协。

**结论**：把决定从"高风险的彻底重构 vs 扛不住的存储压力"改写为"先做 T0–T2（低/中风险、可独立回滚、重放零改动），拿到真实增长读数后再决定是否需要 T3"。用户完全可以在 T0–T2 之后停止。

## 追加（2026-09-18）：老数据全丢 —— 迁移路径由"升版"退化为"按 schema 重建"

用户决定：**「老数据我一个都不要了」**。据此撤销/简化以下原先的待办：

| 原待办 | 处置 |
| --- | --- |
| 老回合无 `turn.unit` ⇒ 无法被 L3 裁剪（1064 条 delta 行） | **撤销**。不补建 unit、不裁剪——直接随重建丢弃 |
| v14 → v15 迁移（重建 + 逐行搬迁 + 抽样比对） | **退化为按新 schema 建库**：不搬迁任何旧行。迁移代码只保留"检测到旧库版本 ⇒ 明确告知并重建"的路径，不做数据搬运 |
| `deleted_sessions` 墓碑回收口径（93 行） | **撤销**：墓碑随重建丢弃 |
| 死表/空表清理（`sessions`、`retention_policy` 空行、`legacy_message_backfill_audit`） | 并入重建，无需单独脚本 |
| 74% 闲置页回收（VACUUM） | 并入重建，无需单独 VACUUM |

**这带来的风险削减（不只是省事）**：
1. **T2 的风险从"中"降到"低"**——最大的风险源是"搬迁 94k 行旧数据出岔子"，现在没有可搬的东西；重建失败的唯一后果是重跑。
2. **L2/L3（rollup + trim）对新数据退役**（见方案 G）**且对旧数据也不再需要** ⇒ 整套 sha256 等价性校验、预算暂停/续跑、trim 迁移进度表都可以**只保留读兼容**或直接删除。**"trim 需先有 unit 且重折叠 sha256 相等"这一整类脆弱性彻底消失**，而不是"仅对新数据消失"。
3. **可观测的行为变化（必须在验收里显式承认）**：重建后**不会再有历史会话**。因此
   `#110 F3` 的墓碑清扫路径、`evt_load_compact` 的 compact 读路径、`expandTurnUnitRows`
   的单元展开路径都会**失去生产数据**——它们仍需保留为读兼容与测试覆盖对象，但不再是"必须正确"的活路径。这反过来意味着：**旧数据相关的既有测试全部变成纯契约测试**，其失败不再代表用户可见的回归。

**待确认的一处口径**：既然老数据全丢、且方案 G 让新数据不再产生逐 chunk 历史行，那么
"逐 chunk 形态"在生产中将**只作为写入中间态存在**（被聚合行取代）。因此
`src/__tests__/replay/` 里"逐 chunk vs 聚合等价"的性质从"两种生产形态互等"变为
"**写入中间态与落盘形态等价**"——契约不变（仍必须等价），但意义上要写清楚，避免后人
误以为生产里两种形态长期共存。

## 后果

- **正面**：WAL 写入相对基线 ≤ 1/8；checkpoint 频率同比例下降（流式期间的 fsync 抖动随之下降）；行数与表占用大幅下降（一条 600 chunk 的回合从 600 行降到窗口数量级）；表占用相对基线 ≤ 60%（含冗余主键移除）；「老回合没有 unit 导致永不可裁剪」的存量问题随重建一次性清掉。
- **负面**：**流式显示延迟 = 合批窗口**，这是唯一的实质代价（约束 1 只允许推迟、不允许绕过）。crash 丢失窗口从「0」变为「≤1 个窗口」。
- **风险**：
  - 若忘记处理 `fold_segments` 的文本来源，`turn.unit` 会折叠出**空文本**且 sha256 变化——既有测试未必覆盖（因为既有 data 里没有 batch 行），故必须新增「聚合行输入下 sha256 == 单 chunk 输入下 sha256」的等价测试。
  - 忘记 48 KiB 预算会让 raw 被截断，且截断是**静默**的（只在 `raw_truncated=1` 上留痕）。
  - 聚合与 trim 的交互：聚合后行数变少，L3 需要能按 span 覆盖判定，不能假设「一 delta 一行」。

## 证据

- 写入路径：`src-tauri/src/dispatcher/routing.rs`（`commit_live_event` 每 update 一次 ingest）、`src-tauri/src/session/event_repo.rs`（`ingest_kernel_event` 的事务体；`:140` `MAX_CANONICAL_RAW_BYTES`；`:241` `retain_raw_payload`）
- 消费面（单条 Committed）：`src-tauri/src/dispatcher/mod.rs`（`commit_live_event` 调用点与其 Committed 分支）
- 折叠与裁剪：`src-tauri/src/session/turn_rollup.rs`（`fold_segments` 的 `typed_payload.text` 依赖、`fold_turn_rows` 单一字节源、`is_turn_terminal`）；`src-tauri/src/lib.rs`（`evt_rollup_trim` 命令注册，应用关闭时调用）
- 编码契约与预算：`src/infrastructure/events/canonicalEventBatch.ts`（`DELTA_TO_BATCH`、`canonicalBatchSpanOf`、`canonicalBatchChunksOf`、`CANONICAL_BATCH_LIMITS`）
- 已做对、本次不动：`src-tauri/src/session/msg_repo/migrations.rs::connect`（WAL + `synchronous=NORMAL` 及其理由注释）
- 实测：本 ADR 背景节的两张表（Python sqlite3 基准 + 真实库只读体检；比值可信，绝对值非 rusqlite 代表值）
- 存量数据面：真实库 902 页 / 676 空闲页（74%）；`event_id` 恒等于 `owner_key#sequence` 1155/1155；1064 条 delta 行无 `turn.unit` 覆盖
