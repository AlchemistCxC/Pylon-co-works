# ADR-0016 跨度占位进入已提交序列（写侧行聚合的连续性契约）

> 入库保留。编号顺延，按编号命名。
> 产出路径：`.agents/decisions/0016-span-occupancy-in-committed-sequence.md`

- **日期**：2026-09-20
- **状态**：已采用（用户于 2026-09-20 批准立项；实现分片见「实施计划」）
- **议题**：issue #155 T3-1 / #205 / #208 ③

## 背景与约束

`canonical_events` 的 row 语义有两类跨度，**方向相反**，此前已被刻意钉死
（`src/__tests__/replay/rowSemantics.test.ts` 文件头）：

- `*.delta.batch` 的 `seqSpan` 是**占用**声明——跨度中间的编号**没有任何行写入**，读侧按
  `owner#(seqStart+i)` 重建原始 chunk；
- `turn.unit` 的 `rollup_*` 是**覆盖**声明——被折叠的行在 L3 裁剪前**仍然存在**，单元自身只占
  `terminal.sequence + 1` 一个编号。

当时的决定是：**已提交序列保持「一行 = 一个编号」的严格连续**，聚合行的跨度只允许出现在
**读边界**（`load_events_compact` 过滤后折叠，见 #205 的 `fold_adjacent_delta_runs`），
`canonicalEventCursor` 保持严格判据（`event.sequence !== cursor + 1` ⇒ `canonical_gap_unrecoverable`）。
理由（该文件原文）：两类误判代价**不对称**——把**占用**当 gap ⇒ 在途回合断流（有错误码）；
把**覆盖**当占用 ⇒ 游标跳过仍存在的行 ⇒ **静默丢数据**（无错误码，更危险）。

现在要评估的变更：**把行聚合从读边界下移到内核写路径**（#155 T3-1），
即 `ingest_kernel_events` 在同一窗口内把相邻同类 delta 折成一条 `*.delta.batch` 行后落盘，
于是**跨度占位行会进入已提交序列**（实时 feed 与 `evt_list` 都会看到）。

**实测动机**（本机，release，同一进程/同一数据）：

| 形态 | 库规模（单会话 13.6 万 chunk） | 落盘行数 |
| --- | --- | --- |
| 现状：1 chunk = 1 行 + 关闭时 L3 裁剪 | 使用中 ~135,826 行 / 50MB；关闭后 20 行 / 676KB | 135,826 → 20 |
| 写侧聚合（本 ADR 若采用） | 使用中约数百行量级 | ~1–2 个数量级下降 |

读侧的收益**已经拿到**（#205 读边界折叠：compact 读 954.8ms → 142.2ms、峰值 413.2MB → 13.4MB、
在途窗口下发行数 79,697 → 244），所以本 ADR 的**增量收益是存储/WAL 与在途窗口的落盘规模**，
代价是移动已被钉死的连续性契约。

**必须守的约束**：

1. `canonical_events` 仍是唯一 durable 历史权威，append-only，不改 schema、不改 wire EVT-01 契约；
2. **把覆盖当占用仍必须被禁止**（静默丢数据半边）——本 ADR 只放开占用半边，覆盖判据一字不动；
3. 读侧任何消费方都能从 `seqSpan` 重建跨度内每个原始 sequence/eventId（`canonicalRowToWorkbench`
   已具备，`canonicalEventBatch` 是唯一真值）；
4. durable-before-publish 不变量不变：行先落盘再发布；
5. 在途回合（draft tail）必须仍可完整重放（ADR-0008 对 T3 的硬约束）。

## 备选方案

| 方案 | 否决理由 |
| --- | --- |
| A. 维持现状：聚合只在读边界（#205 已落地） | **不否决，是现状**。读侧收益已拿到；仅在「存储/WAL 与在途落盘规模」上继续付 1–2 个数量级的代价 |
| B. 写侧聚合 + 已提交序列保持严格连续（把跨度内每个 chunk 都写成行） | 等于不聚合，行数不降；自相矛盾 |
| C. 写侧聚合 + 让消费方各自处理空洞（改游标为「允许空洞」而不校验跨度） | **否决**：游标一旦不校验跨度起点，就把「把覆盖当占用」那半边的静默丢数据风险一起打开——正是 rowSemantics 论证禁止的方向 |
| D. 写侧聚合 + **跨度感知的连续性判据**（本 ADR 采用） | 采用。连续性从「下一号 == 该行 sequence」放宽为「下一号被该行跨度覆盖」，**且仍逐行校验**（跨度起点必须恰为游标下一号、终点必须等于该行 sequence、只对 `*.delta.batch` 生效） |
| E. 改 schema：把跨度写成独立的覆盖表，行仍逐 chunk 落盘 | 不解决行数问题（行还在），只是把紧凑读做得更快；且要动 schema（T2 刚收口） |

## 决定

**采用 D：跨度占位进入已提交序列，以「跨度感知的连续性判据」守住它。**

1. **写侧**：`ingest_kernel_events` 在同一窗口内先归一化、再用**与读侧同一个**
   `fold_adjacent_delta_runs`（同一预算 48 KiB / 2000 chunk、同 identity/类型/text 门控）折叠后写入。
   span 占位**不改动其余行的编号**（只丢弃 span 中间的裸行、幸存行移到 span 末位），故 sequence
   分配语义与 `expectedRevision`（max sequence）不变；`turn.unit` 仍按同事务从库内行构建。
2. **配对**：dispatcher 的「一输入一结果」配对改为**按跨度宽度展开**（`row_input_span_width`）——
   span 内每个 wire 帧都记在承载它的那一行上。
3. **游标**：`canonicalEventCursor` 接受「跨度起点 == 游标下一号」的 `*.delta.batch` 行，
   消费后游标推进到该行 sequence。**其余判据不变**：跨度起点不等于游标下一号仍抛
   `canonical_gap_unrecoverable`；覆盖（`turn.unit`）仍不得被当作占用。
4. **draft 尾巴（ADR-0008 T3-2 的裁决）**：**在途回合照常聚合（不豁免）**。
   理由：跨度感知的连续性判据使在途聚合与终结后聚合的**消费语义完全相同**（读侧按 chunk 展开、
   游标按跨度推进），因此不需要为在途引入第二套行形态；而「为在途保留逐 chunk」会让同一回合在
   终结前后呈现两种行形态，反而增加读侧分支。ADR-0008 的硬约束「draft tail 必须可重放」由
   「跨度可展开」满足——**判据是可重放性，不是行形态**。
5. **L3 裁剪不变**：被单元覆盖的行仍在关闭时删除；写侧聚合只影响「使用中」的行数规模。

## 后果

- 正面：
  - 使用中的落盘行数降 1–2 个数量级（WAL 累计写入随行数下降；T1 的批事务收益叠加其上）；
  - 在途窗口的下发行数进一步下降（不再依赖读边界折叠这一道补位）；
  - 行聚合规则只有一份真值（`fold_adjacent_delta_runs` 读写共用），不存在两套规则漂移。
- 负面：
  - 已提交序列出现空洞 ⇒ **所有连续性消费方都必须理解跨度**（本 ADR 只改了游标；`evt_list`
    分页、`threeSourceExport`、任何按 sequence 逐号扫描的新代码都要按同一契约写）；
  - `rowSemantics.test.ts` 的两条「现状」判据随之改写（契约变更，非修 bug）——必须在测试里引用本 ADR。
- 风险：
  - **静默丢数据**：若某处把 `turn.unit` 的覆盖当作占用（跳过仍存在的行）。守住方式：
    `spanStartOf` 只认 `*.delta.batch` 且要求 `end === event.sequence`；覆盖判据的测试保持原样且不得放宽；
  - 后端与前端对跨度的判据漂移：两侧都以「`seqSpan` 长度 2、`start >= 1`、`end === sequence`、
    `end - start + 1 === foldedCount === rawPayload.length`」为准，由跨语言一致性用例看守。

## 证据

- 既有契约与被改写点：`src/__tests__/replay/rowSemantics.test.ts`（文件头的不对称论证 + 两条现状判据）
- 读侧折叠（同一实现）：`src-tauri/src/session/event_repo.rs::fold_adjacent_delta_runs`（`#205`）
- 前端展开契约（唯一真值）：`src/infrastructure/events/canonicalEventBatch.ts`
- 游标：`src/infrastructure/events/canonicalEventCursor.ts`（严格判据处）
- 落盘配对：`src-tauri/src/dispatcher/mod.rs::flush_pending_canonical`
- 基线读数：#205 的读路径 A/B（954.8→142.2ms、413.2→13.4MB、79,697→244 行）见
  `.agents/records/issue-205-replay-read-fold-and-projection-linearization.md`

## 实施计划（分片，每片独立可回滚）

1. **S1 契约与判据**：本 ADR + `rowSemantics.test.ts` 改写（占用半边）+ 新增「跨度起点不符仍报 gap」用例；
2. **S2 写侧折叠**：`ingest_kernel_events` 两阶段 + `row_input_span_width` + Rust 用例
   （窗口内折叠 / 类型或 identity 打断 / 终态同事务单元 / revision = max sequence）；
3. **S3 落盘配对**：dispatcher `flush_pending_canonical` 按跨度展开 + 既有 dispatcher 用例回归；
4. **S4 读数**：`storage_write_bench` 扩展「写侧聚合」形态（行数 / WAL / checkpoint），
   与现状对照落 `.agents/records/`；
5. **S5 实机验收**：长回合并行中切会话（游标跨度推进、无 gap 报错、顺序稳定）+ 控制台/后端日志 0 error。
