# ADR-0027 跨窗口历史聚合与持久化临时片段

> 入库保留。议题：#155 T3；补充 ADR-0008、ADR-0016。

- **日期**：2026-09-25
- **状态**：已采用（用户逐项裁决，施工与验收进行中）

## 背景与约束

T1 把同 owner 32 行/8 ms 窗口收进一次事务；T3-1 在该窗口内产出 *.delta.batch 行。20,000 chunk 基准：历史行 20,000→625（32×），主库 8.27→5.56 MB（1.49×），WAL 4.14→4.17 MB。窗口末尾强制收口使一条 600 chunk 消息留下约 19 行，尚未达到 ADR-0008 的跨窗口消息粒度目标。

canonical_events 仍是唯一已提交历史权威，append-only；EVT-01、evt_*、expectedRevision 含义不变。正式 batch 单行 rawPayload 预算 48 KiB／2000 chunk（低于 64 KiB 截断线），长消息可有多行。已提交 batch 的 seqSpan 是占用，turn.unit 的 rollup span 是覆盖（ADR-0016），两者不可混同。正式历史必须先持久化再发布；临时内容也遵循用户本次选定的“先持久化再显示”。

## 备选方案

| 方案 | 处置 |
| --- | --- |
| 保留 T3-1 窗口行 | 否决：每 32 条即断开，无法达到用户已选的跨窗口累积 |
| 跨窗口只留内存、消息结束才落盘 | 否决：冷挂载读不到在途内容，崩溃丢整段 |
| 单个 draft 行反复 UPDATE（ADR-0008 方案 G 的提议） | 否决：合成 600 chunk、每 4 chunk 提交一次，WAL 12,067,512 B；重复改写增长中的行 |
| 追加临时片段，正式行提交时同事务清除 | 采用：同口径合成负载 WAL 1,557,392 B；片段仅用于在途显示与恢复，不参与 evt_* 历史 |

## 决定

1. 内核按同 owner、相邻同类 delta、identity 四键全等、string text 门控跨窗口累积。遇到非同类事件、owner/identity 变化、终态、关闭或 48 KiB／2000 chunk 预算即收口；正式 batch 仍按既有 seqSpan 编码，长消息依预算分行。
2. 在途数据存为追加的临时片段。首 chunk 立即登记持久化占位以关闭并发写插序窗口；之后累计 16 chunk 或经过约 800 ms，任一先到就追加片段，持久化成功后才显示；强制边界立即处理，不等待计时器。该批次由用户在生产形态 WAL 基准后裁决。
3. 临时片段不是 canonical 历史，不推进 evt_revision，不进入 evt_list/evt_load_compact/export 的正式历史源；前端以独立 draft seam 显示，不能把它交给 canonical cursor 或 canonical plugin event bus 冒充已提交事实。
4. 正式行与它覆盖的临时片段在一个事务内完成追加和删除；拒绝跨 owner/generation 混合。正式行的投影与临时片段消重，以已提交历史为最终权威。
5. 无终态崩溃后，冷挂载恢复最后已落盘片段为“中断的临时内容”，用户可显式“保留为历史”或“丢弃”；不自动提交为历史、不静默丢弃。已提交的预算分段仍照常从 canonical_events 读取。
6. 同一 owner 存在待提交 draft 时，外部 `evt_append` 明确返回稳定错误码 `draft_pending`；调用方保留待写批次，正式提交或用户处理 draft 后再重试。Kernel 的非 draft 写也受同一门禁，避免乱序。`expectedRevision` 仍只针对 canonical revision。
7. v15→v16 只增临时表并保留 v15 历史；v14 及更老库继续沿既定“老数据全丢”重建策略。会话删除和保留策略必须清扫对应临时片段。
8. Prompt 终态由 dispatcher 以外的任务写入，写终态前必须向 dispatcher 发收口请求并等待确认；dispatcher 先消费已排队 ACP update，再提交 draft，终态才分配 canonical sequence。仍在生成的片段由进程内活动登记簿标识，冷挂载可以显示但不能“保留／丢弃”；dispatcher 退出或被取消时登记簿释放，已存片段变为可处理的中断内容。

本决定将 ADR-0008 中方案 G 的“单行 UPDATE”实现细节替换为“追加片段”；将 ADR-0016 的“在途也聚合”延伸为跨窗口聚合，已提交跨度判据不变。ADR-0008 的消息边界方向与 ADR-0016 的可重放约束继续有效。

## 后果

- 正面：正式历史不再按 32 行窗口切断；800 ms／16 chunk 片段持久化提供在途切页与崩溃恢复；追加片段的 WAL 随输入近似线性增长。
- 负面：正常流式显示最长增加约 800 ms；需要新临时表、恢复 seam、正式提交消重；正式历史的 revision 在临时阶段不随每个 chunk 增加。生产形态合成基准（600 chunk）正式历史 19→2 行；原窗口 WAL 428,512 B，4 chunk／片段 1,858,152 B，16 chunk／片段 914,672 B，32 chunk／片段 552,112 B。用户在显示延迟与写入量之间选定 16 chunk／约 800 ms；基准的主库与耗时读数受 SQLite 分页与机器负载影响，应以 WAL 和行数为主要对照。
- 风险：临时与正式行交接竞态、并发 evt_append 插序、owner/generation 切换、终态丢失、预算触发时重复投影。每项需行为测试和实机验收；若无法保持既有外部契约，不得以静默降级交付。

## 证据

- 窗口与发布：src-tauri/src/dispatcher/canonical_flush.rs:25、src-tauri/src/dispatcher/canonical_flush.rs:137。
- 写侧单窗口 run：src-tauri/pylon-session/src/event_repo/repo.rs:279、src-tauri/pylon-session/src/event_repo/repo.rs:445。
- batch 预算与构形：src-tauri/pylon-session/src/event_repo/fold.rs:7、src/infrastructure/events/canonicalEventBatch.ts:45。
- 游标：src/infrastructure/events/canonicalEventCursor.ts:84。
- Workbench 只消费正式事件：src/sheets/agent-workbench/agentWorkbenchSession.ts:103、src/sheets/agent-workbench/agentWorkbenchSession.ts:474。
- v15 schema：src-tauri/pylon-session/src/msg_repo/mod.rs:47、src-tauri/pylon-session/src/msg_repo/mod.rs:129。
- 合成草稿基准：Python sqlite3，WAL + synchronous=NORMAL + wal_autocheckpoint=0；600 条约 231B raw、每 4 条一次事务；单行 UPDATE 12,067,512 B，追加片段 1,557,392 B。合成数据仅比较机制，最终还需生产形态基准。
- 生产形态基准：`src-tauri/pylon-session/src/event_repo/draft_bench.rs`，同一组 600 chunk，经真实 EventRepo；窗口 19 行／428,512 B WAL，draft 4／8／16／32 chunk 每片段分别 1,858,152／1,751,032／914,672／552,112 B WAL，draft 正式历史 2 行。
