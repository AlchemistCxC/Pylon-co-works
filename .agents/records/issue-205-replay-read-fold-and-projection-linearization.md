# Dev Record — #205 切会话冷读：读侧 delta 折叠 + 投影线性化

> 入库保留。规格文档（spec）不保留，其目标、范围、方案与验收结论在此承接。
> 产出路径：`.agents/records/<issue>-<slug>.md`

## 元信息

- issue：#205（关联 #204 ②③、#81 L2/L3、#155 T3）
- 分支：`Ru5t/Reflector`
- 提交范围：`cebeb6e0..HEAD`
- 日期：2026-09-20

## 目标与范围

用户原话：①「切换会话后页面空（期望能加载历史会话）」②「内存占用飙升，后端的 pylon.exe 峰值 600mb」
③「重放速度慢性能差」，以及授权「准许你引入高性能算法与库，彻底重构这个糟糕的内存大户」。

**做什么**：把会话切换冷读路径的**下发行数与每行投影成本**两条曲线同时压回线性。

**不做什么**：不改写路径/schema/`turn.unit` 产生时机（#155 T3 领域）；不改 `bind()` 清空文档、
绑定键幂等判据、`turnEpoch` 重置（#204 ② 领域，另条处置）；不改 live 单事件路径的语义与复杂度特征
（`reduceWorkbenchEvent` 语义不变，取不到上下文时回退原扫描）；不引入新依赖。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src/domains/workbench/workbenchProjector.ts` | 批量路径工作数组所有权（timeline 就地追加、覆盖区间就地并入）、`isAscendingBySequence` 入口免拷贝、`ProjectionContext`（tool/文本边界/终态 session 三索引 + 二分查询）、orphan 刷新短路、`refreshOrphans` 可选 id 集 | 修改 |
| `src/sheets/agent-workbench/agentWorkbenchSession.ts` | `bind`/`refresh` 的信封收集去掉 concat+flatMap 中间数组；缓冲帧为空时投影免拷贝；**#204 ② 修复**：`bind` 不再把 `turnEpoch` 回落为 0（承接当前值，保持单调围栏） | 修改 |
| `src-tauri/src/session/event_repo.rs` | `load_events_compact`：① 过滤下推 SQL（两段查询，覆盖跨度进 WHERE）；② 尾部读侧折叠 `fold_uncovered_delta_runs` + 预算/identity/收口助手 + 6 个内联测试；③ 跨度过多时的整读回退路径 | 修改 |
| `src-tauri/src/session/turn_rollup.rs` | `static_delta_type` 可见性 `pub(crate)`（读侧折叠复用同一类型口径，**无语义改动**） | 修改 |
| `src/__tests__/replay/projectionLinearization.test.ts` | 批量/单事件等价、乱序等价、增量折入等价、幂等、20k 规模护栏 | 新增 |
| `docs/说明书/Pylon-项目架构参考.md` | 存储一节 compact 读语义补读侧折叠 | 修改 |

## 方案要点

### 一、读侧折叠（治本：砍 N）

`turn.unit` 在回合终帧的**同一时刻**落盘（实测滞后 0.0s），但覆盖**整回合**；因此**回合进行中**
该回合已产出的 chunk 全部落在「未被 unit 覆盖」集合里——而切会话恰恰最常命中这个窗口
（实测单回合 79,682 行）。`evt_load_compact` 的过滤条件正是「unit 行 ∨ 未覆盖行」，于是不折叠就要
把整段 chunk 逐行下发。

折叠规则**逐条对齐**写侧 `canonicalEventBatch.mergeAdjacentDeltaChunks` 与前端展开判据
`canonicalBatchChunksOf`：相邻同类（`assistant.text.delta` / `assistant.thinking.delta`）、
sequence 连续、identity 四键全等、`typed_payload.text` 是 string、预算 48 KiB / 2000 chunk
（超限切断不截断、单条 run 不合并）；产出 `*.delta.batch` 行，`sequence`/`eventId` 取跨度末位、
`typedPayload = { text, foldedCount, seqSpan }`、`rawPayload` 为原始 chunk 数组。
前端 `canonicalRowToWorkbench` 已有该形状的展开路径 ⇒ **投影等价**，契约零变更。

选择读侧而非写侧：写侧聚合是 #155 T3（已按 ADR 待用户裁决），且读侧折叠对**存量 journal** 立即生效；
写侧落地后本折叠自然退化为无操作（输入里不再有相邻裸 delta）。

### 二、投影线性化（砍每行成本）

改造前 `projectWorkbench` 批量路径有 5 处 per-event 超线性成本：

1. `insertBySequence` 每事件展开复制整条 timeline（Θ(N²/2) 元素拷贝）；
2. `mergeCoverage` 每事件重建整个覆盖区间数组（Θ(N·R)）；
3. `refreshOrphans` 每事件对全部 activities 重建 `Set`（Θ(N·A)）；
4. `reduceReasoning` 里 tool 边界查询对整条 timeline `.some`（落在最高频的 delta 上）；
5. `textStreamContinues` 同样整条 `.some`——而 journal 里**每条 message/reasoning 条目本身就是
   文本流边界**，故该扫描恒定走满整条 timeline。

做法：批量路径**取得工作数组所有权**（入口复制一次，循环内就地追加/就地并入），归约器换掉 timeline
数组时按位置增量补扫索引；三处「按 timeline 查询」改为**升序索引 + 二分**（索引由批量路径维护，
缺省回退原扫描，故 live 路径语义与代价不变）；orphan 刷新按 activities 数组同一性短路
（orphan 是 (id 集, parentId) 的纯函数，且**无任何归约器读取 orphan**，已核对）。

### 三、紧凑读的过滤下推 SQL（治内存峰值）

`load_events_compact` 原本把**整表**读成 `Vec<CanonicalEventRow>`（每行三个 payload 列都要解成
`serde_json::Value` 树）再在内存里按覆盖跨度过滤。实测生产库（单 owner 13.6 万行）一次 compact 读
**1188ms、峰值数百 MB，而结果只有 12 行**。改为两段查询：先只读 `turn.unit` 行拿覆盖跨度，
再把跨度写成 `NOT (sequence BETWEEN ? AND ?)` 谓词只读未覆盖行（跨度数超 500 退回原整读路径，
避免撞 SQLite 的表达式深度/参数上限）。语义与原实现逐行相同（单元行恒保留、被覆盖行恒剔除）。

### 四、#204 ② 思考块分裂/截断（用户要求一并解决）

`turnEpoch` 是 runtime 局部的**单调**围栏：`workbenchRuntime.acceptDocument` 对 `applyDocument`
（live 帧）执行 `options.turnEpoch < snapshot.turnEpoch` 即**拒收**。而 `bind` 在每次绑定重建时把
闭包 `turnEpoch` 重置为 0 —— 切回时 snapshot 的 epoch 仍停在切走前那一轮（回合事实不会回退），
于是切回后到达的思考帧被静默丢弃：正文**截断在切换点**；又因为那些 sequence 在 `appliedRanges`
里没有覆盖记录，终帧后的 canonical refresh 会把 journal 行**重折一遍** ⇒ 用户看到的
「两个思考块，第二个是完整思考的截断」。

修法：`bind` 承接 `runtime.getSnapshot().turnEpoch ?? 0`（不再回落），新回合仍由 `applyLive` 的
user 帧推进（`turnEpoch += 1`）。回归测试 `agentWorkbenchSession.rebindIndicator.test.ts` 新增一例，
同时钉住两条症状：切回后的思考继续折入同一块（不截断）、终帧后 refresh 重折不得再折出第二块
（不复制），并断言 timeline/消息 sequence 单调。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| 前端基准每翻倍倍数 ∈ [1.8, 2.4]（线性） | 1.79 / 1.83 / 2.03 / 2.06（2k→5k→10k→20k→40k） |
| 40,000 行 bind ≤ 2,000ms | 986ms（同 fixture 改造前外推 ~32s；旧合成 fixture 基线 49,540ms） |
| 每次 bind 的 rssDelta ≤ 100MB | 26 / 50 / 0 / 32 / 84MB |
| 折叠后行数（合成 20,000 条连续 thinking delta） | 见测试 `compact_read_cuts_run_at_fold_budget_without_losing_rows` |
| 折叠前后投影等价 | `projectionLinearization.test.ts` 等价用例 + `agentWorkbenchSession.batch` 既有套件全绿 |
| Rust `cargo test --workspace --lib` | 1257 passed / 0 failed / 4 ignored（退出码 0） |
| 前端 `vitest run` | 见「证据」 |
| 生产库副本 compact 读行数（未覆盖窗复现） | 79,687 行 → **244 行** |

## 测试处置

新增：
- `src/__tests__/replay/projectionLinearization.test.ts`（5 例：批量/单事件文档等价、
  乱序等价、初始文档上折入增量等价、重复输入幂等、20,000 行规模护栏 < 2.5s）；
- `src-tauri/src/session/event_repo.rs` 内联 6 例：折叠形状（batch 字段/seqSpan/raw 数组/
  raw_payload_json 不变量）、单条不折叠、非 delta 打断、identity 打断、两类 delta 分 run、
  预算切断不丢行。

修改/删除既有行为测试：**无**。

## 证据

- commit：见 PR（本记录随同批提交）
- 测试：
  - `cargo test --workspace --lib` → `1103 + 93 + 61 + 0 passed; 0 failed; 4 ignored`，退出码 0
    （日志 `G:/TEMP/rust-tests-205.log`）
  - `npx vitest run src/__tests__/replay` → 24 文件 / 458 例全绿（改动后首轮）
  - `npx vitest run`（全量）→ 见 PR 描述
- 基准（`bun bench-replay.tmp.ts 2000 5000 10000 20000 40000`，行源 = 生产库真实 wire 行，
  即「长思考回合进行中的未覆盖 tail」）：

> 复现注记（2026-09-20）：`bench-replay.tmp.ts` 是**从未入库的一次性 scratch**，已随本轮临时文件
> 清理删除，仓库里没有它的副本——上表读数不可用该命令重跑。同口径的回归看守已落在
> `src/__tests__/replay/projectionLinearization.test.ts`（批量 vs 逐事件等价 + 20k 规模 tripwire）；
> 重测绝对耗时按 `.agents/spec/205-replay-projection-linearization.md` 的 fixture 来源重建同形状输入即可。

| 行数 | 改造前 | 改造后 | 每行成本（前→后） |
| --- | --- | --- | --- |
| 2,000 | 211ms | 72ms | 0.105 → 0.036ms |
| 5,000 | 623ms | 129ms | 0.125 → 0.026ms |
| 10,000 | 2,030ms | 236ms | 0.203 → 0.024ms |
| 20,000 | 8,100ms | 478ms | 0.405 → 0.024ms |
| 40,000 | （未测，按 ×3.99/翻倍外推 ~32s） | 986ms | — → 0.025ms |

  改造前每翻倍 ×3.99（Θ(N²)），改造后每翻倍 1.79 / 1.83 / 2.03 / 2.06、每行成本恒定在
  0.024–0.036ms（Θ(N)）；20,000 行改善 17×，40,000 行改善 ~32×。按线性外推 135,826 行
  （本机库单 owner 规模）≈ 3.4s（改造前同级输入 ≈ 6 分钟）。
- 读侧折叠实测（生产库**副本**，删掉最新 `turn.unit` 复现「回合进行中」窗口）：
  `P205 table_rows=136229 compact_rows=244`，构成 `{thinking.delta.batch:224, text.delta.batch:5,
  turn.unit:5, session.commands-updated:3, usage.updated:5, turn.completed:1, user.message:1}`
  ⇒ 单次切会话下发 **79,687 → 244 行**（327×）。
- 手工验证（实机，MCP；按 `.agents/skills/webview2-acceptance` 走）：
  替入 `F:\A-I\Platform\Pylon\pylon.exe`（旧实例备份 `pylon.exe.bak-before205` 与 `G:/TEMP/pylon.exe.205-pre`），
  带内置调试端口启动，用 `tools/webview2-mcp/` 取证：

| 项 | 数值 |
| --- | --- |
| `evt_load_compact`（单 owner 13.6 万行库） | **24ms / 14 行 / 668KB**（同一实例改造前 1188ms / 12 行 / 666KB ⇒ 读路径 49×） |
| 切回大会话：首行出现 → 17 个思考块渲染完 | 同一次 50ms 采样序列内 **t=26439ms → t=26489ms** |
| 后端 `pylon.exe` 工作集（切换窗口 40s / 114 个样本） | 起始 43.0MB / 峰值 **44.2MB** / 结束 43.5MB（用户报告峰值 600MB） |
| 渲染器族（WebView2 子进程 6 个） | 大会话 792.6MB（max 457.5）↔ 空会话 540.6MB（max 204.5）⇒ 该文档约 +250MB |
| 渲染器 JS 堆（GC 后，CDP `Runtime.getHeapUsage`） | 大会话 123.3 → 140.1 → 71.7MB；空会话 22.7 → 15.8MB（**非单调增长 ⇒ 不是泄漏**） |
| 内容保真（文档 vs journal 单元内嵌正文） | thinking **538,695 = 538,695 字符**，17 个思考块长度逐个吻合 |
| 顺序/完整性 | 块序与 journal 一致、无重复块；timeline(93) 与消息 sequence 单调 |
| 后端日志 | `session/load replay trace`：observed/retained 44–46、dropped 0、authority=local-journal、error 级 0 条 |
| 前端控制台 | `window` error 0 条 |

  复现测法（脚本为工作树内未跟踪 scratch，不入库）：从生产库**只读**取「单元 + 未覆盖行」构造 wire 行
  → 注入 `createAgentWorkbenchSessionRuntime({ loadAll })` → `bind`，逐块打印长度/头尾并与 unit 内嵌
  `delta-run` 正文求和对照。基准曲线的测法同理（行源换成生产库真实 delta 行并切片）。

## 与 spec 的偏差

1. spec 的验收项「20k 行 bind < 2s」在实现中改为**测试内**的 2.5s 护栏（jsdom 环境实测 ~0.2s），
   基准仍是交付判据；原因是避免把绝对耗时写进 CI 断言。
2. spec 提到「引入高性能库」：实测瓶颈是**每事件整数组复制与整条扫描**，用语言内建能力
   （就地追加、增量索引、二分、所有权复制一次）即可消除，故未引入任何新依赖（`check:deps` 不受影响）。
3. `turn_rollup.rs` 的 `static_delta_type` 改为 `pub(crate)`（1 词，无语义）——为让读侧折叠与
   单元折叠共用同一类型口径，避免第二份真值。该文件不在本轮 L.md 声明域内，已在 L.md 补报备。

## 未解问题

1. **live 单事件路径的同类成本**：`reduceWorkbenchEvent` 每帧仍复制整条 timeline（`insertBySequence`）
   并按整条扫描文本边界 ⇒ 长思考流式期间是 Θ(N²)（#204 ③ 的机制之一）。本轮不动（涉及
   `workbenchRuntime` 的深冻结契约），证据已在上文，归 #204 处置。
2. **`evt_list` 分页读未折叠**：折叠行与分页游标的交互需先定语义，留待 #155 T3。
3. **`addDiagnostic` 的 per-event `updateTimeline` + diagnostics 数组复制**：unknown 行密集的
   journal 上仍是 Θ(N·T)/Θ(D²)（生产库无 unknown 行，未命中）；是否收敛待定。
4. **写侧聚合（#155 T3）**：本轮的读侧折叠是「读时等价」，不减少落盘行数；落盘行数仍随
   chunk 线性增长（WAL 放大已由 dispatcher 32 行/8ms 批事务压低）。
5. **实机发现：reasoning 块在 DOM 里被稳定截到 ~9.3–10.1k 字符**（10 个长块全部落在该区间，
   头部与文档一致、尾部在内容中间被切），而文档内容为 23,971–218,181 字符；**数据面已证无误**
   （见验收表）。属渲染层的呈现截断（#150/#148/#55 同族），本轮不动，建议并入渲染面另条处置。
6. **未能实机复现「思考中切会话再切回」**：便携版当前只有一个会话，制造真实在途回合需先发提示词；
   #204 ② 的帧级行为由新增回归测试钉死（修复前后各跑一遍：修复前红、修复后绿）。
