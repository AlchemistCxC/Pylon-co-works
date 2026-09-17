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
