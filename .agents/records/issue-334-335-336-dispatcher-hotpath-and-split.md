# Dev Record — #334 + #335 + #336 单 PR 批次：dispatcher 逐帧热路径优化 / U1b 参数收口 / U2b 主泵拆分

> 元信息

- issue：#334（P2/P3/P5 逐帧热路径）、#335（U1b 结构体收口）、#336（U2b 拆分主泵）
- 分支：`kumo/prometheus`（单 PR 承载三 issue）
- 提交范围：`5371a46a..`（本批三提交：`319d8ffb` #334、`af12c778` #335、`8908ba96` #336）
- 日期：2026-09-25
- 规格：`.agents/spec/334-336-dispatcher-hotpath.md`（一次性，不入库；目标与方案在此承接）

## 目标与范围

- **#334**：消逐帧热路径深拷贝（P2）与 O(K²) 累积（P5）、`note_session_activity` 去
  全表扫（P3）、`should_flush_batch` 读数收尾；wire/命令名/错误码/持久化格式/公开字段
  不动；`classify_session_update` 不动。**不做**：dispatcher 大函数拆分（→#336）、P6。
- **#335**：`create.rs` 三个装配函数 + `canonical_flush` 上下文的结构体收口，摘除期票
  allow。**不做**：`new_session` wire 签名（IPC 契约）、send_message/prompt.rs 域。
- **#336**：拆分 `start_notification_dispatcher`（337→21 行编排入口），锁外副作用时序/
  路由顺序/锁持有范围逐语句保持。**不做**：`handle_session_update`/`handle_permission_request`
  拆分、任何通知语义变化。

## 改动清单

| 文件 | 范围 | 性质 |
| --- | --- | --- |
| `pylon-acp/src/state.rs` | `apply_session_update` 零拷贝入口（`apply` 委托）；tool_call_update 原地扩展替代 `append_output` | #334 P2/P5 |
| `pylon-acp/src/turn_ledger.rs` | 单表拆 `LedgerTables{active,terminal}`（单 Mutex）；`note_session_activity` 单遍 `values_mut`；settle 三态迁移同临界区 | #334 P3 |
| `pylon-session/src/event_repo/{row,service,normalize}.rs` | `KernelEventInput.raw_payload: Arc<Value>`；`ingest_event` impl Into 收口；normalize 解包计数非 1 克隆兜底 | #334 P2 |
| `src-tauri/src/dispatcher/routing.rs` | `RoutingInput.payload: Arc<Value>`；commit 传 Arc clone | #334 P2 |
| `src-tauri/src/dispatcher/mod.rs` | payload Arc 化 + 发布侧 try_unwrap；`CanonicalFlushContext` 装配；`start_notification_dispatcher` → `NotificationPump{new,run,pump_step,route_frame,flush_context}` + 2 纯函数 | #334 P2 / #335 / #336 |
| `src-tauri/src/dispatcher/canonical_flush.rs` | `should_flush_batch` 字段级 owner 比较；raw_payloads Arc 共享；发布 try_unwrap；上下文结构体 | #334 / #335 |
| `src-tauri/src/session/model.rs` | `durable_owner_matches` 字段级借用比较 | #334 |
| `src-tauri/src/session/create.rs` | `SessionAssembly` + `InitialSessionOptions` 收口四装配函数；摘 3 处 allow | #335 |
| `src-tauri/src/session/{prompt,mod}.rs`、`revive_tests.rs`、`test_harness.rs` | 调用点结构体化（生产 1 处 + 测试 11 处） | #335 |
| `src-tauri/src/dispatcher/frame_path_bench.rs` | 基准文档更新 + 新增 `note_session_activity` 基准项（第五项） | #334 |

## 方案要点

### #334/P2：payload 深拷贝 3→1（Arc 共享）

消费顺序核实（issue 要求的先决确认）：**ingest 先于 publish**（flush 内 ingest await
返回后才 publish；非批次路径 commit 返回后才 publish）。ingest 侧 redact 需可变所有权且
跨 spawn_blocking（必须 `'static` 拥有）；publish 侧需原件注入 source/canonicalEvent——
两侧都需 owned，理论下限 = 反序列化原件 + 1 次复制。方案：`Arc<Value>` 共享进 ingest
（`KernelEventInput.raw_payload` 归一 Arc；normalize 取 redact 所有权时 try_unwrap 失败
再克隆——该处计数恒 ≥2，克隆与旧版持平），发布侧计数回到 1 后 `Arc::try_unwrap` 零拷贝
取回。逐帧深拷贝：原件 + `payload.clone()`(:1249) + `json!` 喂 reducer + raw_payloads
批次克隆（非批次路径另有 routing.rs 一处）→ **原件 + normalize 处 1 次**。
reducer 喂食：`AcpSessionState::apply_session_update(&Value)` 零拷贝入口，`apply` 抽包
后委托，行为逐分支等价（非对象 update 静默忽略原样保留）。

### #334/P3：账本 active/terminal 拆表（单 Mutex 原子性保持）

`note_session_activity` 每 chunk 原：全表 `filter().min()` + 两次 `to_string()` 重建
TurnKey。现：只扫 active 表 `values_mut().filter(scope).min_by_key(turn_id)` 单遍原地
更新（零分配；终态记录已移出故不需 `terminal.is_none()` 过滤）。CAS 语义：settle 的
「remove 出 active → 写终态 → 插 terminal → prune」在同一临界区；不在 active 则查
terminal（Late）→ 两表皆无 UnknownTurn。begin 幂等同时查两表（终态 key 重 begin 仍
AlreadyActive）；`settle_by_session`（测试）候选含终态的旧行为逐一对照保留；
`latest_session_snapshot` 选择语义不变。残余成本：active 表线性（每会话在途至多一个
turn，prompt_gate 保证），不再随终态保留集增长。

### #334/P5：rawOutput 原地扩展

同型 String/Array 先 `matches!` 确认，`mem::take` 取出累积值、原地 `push_str`/`extend`
吃增量、放回 `next`；非同型保持原 `_ => {}` 行为（next 自带值生效）。每帧 O(K) 克隆 →
摊销 O(增量)。

### #334/读数三：`durable_owner_matches`

每帧构造 `DurableSessionOwner`（3 String + validate）只为值比较 → 字段级借用比较。
等价性依据：validate 仅三字段 trim 非空（pylon-session owner.rs），expected 恒经
validate，字段全等即校验结论等价；expected=None 场景依赖入队不变量
（persist_canonical ⇒ owner.is_some()），现状不可达且已在代码注释声明复审条件。

### #335：`SessionAssembly`/`InitialSessionOptions`/`CanonicalFlushContext`

四装配函数共享参数面收敛；`new_session` 命令 wire 签名不动、内部装配。
**偏差披露**：验收文案「create.rs 4 处 allow 摘除」与约束「命令签名不动」自相矛盾——
实际摘 3 处（apply/create_slot/ensure），`new_session` 的 allow 按**自身**摘除条件
（payload 结构体 + 前端同步，另走契约变更流程）保留。allow 计数 5→1。两位审查者独立
判定该偏差处理合理。

### #336：`NotificationPump` 拆分

原 spawn 闭包捕获局部 → 结构体字段（逐一对应）；`new()`（克隆段 + agent_id 解析 +
handle_crash 装配，同步执行——纯字段装配无 await，提前于 spawn 不改变可观察时序）；
`run()` 循环骨架；`pump_step()`（select! 原样，biased 优先级保持）；`route_frame()`
（分支链次序不变，每分支一行模块调用；`return true/false` 精确映射原 `continue/break`）；
`wrap_provider_extension_frame`/`crash_reason_from_params` 纯函数抽出。
`PumpStep::Frame` 挂定点 `large_enum_variant` allow：Box 化需每帧堆分配，与 #334 降
分配方向相悖，属有意取舍（非期票）。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| #334 四项基准读数可复核下降 | ✅（见证据；另新增第五项 P3 基准 1803→~200） |
| #334 `cargo test --workspace --lib` 全绿 | ✅ 1410（838+152+9+36+118+84+22+0+151） |
| #334 `check:acp-shadow` 绿 | ✅ EXIT 0（两轮） |
| #334 P4 值比较与 owner_mismatch 行为不变 | ✅ bench 自检 `should_flush_batch_rejects_cross_owner_pending` 通过；审查确认检查原样 |
| #335 allow 计数下降、clippy 基线 added=0 | ✅ 5→1（偏差见上）；基线 added=[] |
| #335 建会话行为测试原样通过 | ✅ session 135 全绿；revive_tests 9 处实参逐一对照 |
| #336 `start_notification_dispatcher` ≤150 行 | ✅ 21 行（new 85/run 59/pump_step 34/route_frame 166 各司其职） |
| #336 逐语句对照（次序/锁点/校验点） | ✅ 语句 1:1 搬运；审查 agent 独立对照 |
| 三 issue 审查 | ✅ #334 可合入（A–F 全过）/ #335 可合入（A–F 全过，P2 注释建议已落实）/ #336 见下 |

## 测试处置

- 无断言弱化/删除。turn_ledger 测试模块 diff 仅空行；fold_tests/tests.rs 为机械 Arc
  包装；revive_tests 9 处调用点实参逐一对照；dispatcher pending_batch 测试临时值具名化。
- 新增基准：`frame_cost_turn_ledger_note_session_activity_with_retained_terminals`
  （16 终态保留 + 1 在途，断言命中不变量，不钉墙钟）。

## 证据

**frame_path_bench（Windows/debug，同机同法，ns/帧）**：

| 组件 | 改造前 | 改造后（3 跑区间） | 变化 |
| --- | --- | --- | --- |
| `apply_update_event_with_pet_policy`（总入口） | 13,055 | 1,586–1,663 | ≈−87% |
| `acp_state_apply`（reducer 单独，无改动对象） | 2,811 | 1,581–2,105 | 噪声带内 |
| `should_flush_batch`（8 在途，owner 比较） | 4,009 | 1,259–1,761 | ≈−60% |
| `tool_raw_output_accumulate` K=64 | 57,706 | 11,468–21,512 | ≈−65% |
| `tool_raw_output_accumulate` K=512 | 35,126 | 9,634–15,089 | ≈−62%（K 增大不再变贵，O(K²) 消除实证） |
| `note_session_activity`（新增项：1 在途+16 终态） | 1,803 | 153–211 | ≈−89% |

reducer 单独读数无设计改动对象（P2 消的是总入口与 reducer 之间的深拷贝差值），波动属
运行噪声；issue 基线语境（reducer 1,348 vs 总入口 7,096）的差值部分即本次消除对象。

**门禁**：`cargo test --workspace --lib` 1,410 全绿；`bun run check:acp-shadow` EXIT 0；
`check-clippy-baseline` added=[]（routing.rs large_enum_variant 随 Arc 化消失，mod.rs
新增 1 处已按仓规定点 allow 附 reason）。

**审查**：三个 issue 各派独立审查 agent（只读，#334 审查者在临时 worktree 实跑全量
测试复核提交信息计数）。#334/#335 判定「可合入」（各 1 条 P2 注释建议，已落实）；
#336 审查结论见 issue 评论回写。

## 遗留

- `acp_state_apply` 单独读数无下降（其路径无深拷贝可消）——已在 issue 评论说明口径。
- `KernelEventInput.raw_payload` 的 Arc 归一影响 pylon-session 公开方法签名
  （`impl Into<Arc<Value>>` 向后兼容），后续如需 `&[&Value]` 形态再评估。
- #331 遗留的 `handle_session_update`/`handle_permission_request` 拆分仍待另立 issue。
