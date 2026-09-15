# Dev Record — #99 ACP 基础会话通信可靠性与回合生命周期

> 入库保留。规格文档（spec）不保留，其目标、范围、方案与验收结论在此承接。
> 产出路径：`.agents/records/issue-99-acp-base-comm-reliability.md`

## 元信息

- issue：[#99 feat(acp): 补全基础会话通信可靠性与回合生命周期](https://github.com/AlchemistCxC/Pylon-co-works/issues/99)
- 分支：`Ru5t/Reflector`
- 提交范围：开工代码状态 `8d74e78a`（= issue 基准 `f7101cb6` + 文档基线）→ 本次提交
- 日期：2026-09-15
- 施工署名：图灵（L.md 已登记）

## 目标与范围

补全通用 ACP 客户端最小可靠通信闭环：入站帧投递、请求响应关联、prompt/turn 终态、
replay/live 边界、连接代际清理与 golden wire parity。**不做**：模型 selector（#97）、
capability/fork/交互队列（#98）、provider registry 迁移、canonical journal 重写、
前端 Renderer 改造。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src-tauri/src/acp/turn_ledger.rs` | TurnLedger 终态账本全量（CAS settle / phase 推进 / generation 隔离 / 会话级快照 / 11 组单测） | 新增 |
| `src-tauri/src/acp/engine.rs` | `InboundRelay`（可靠入站中继：有界 spill 续投 + 溢出显式过载终态 + 控制/更新双 lane + ingress ordinal）；`publish_inbound` 重写；`spawn_sdk_client`/`spawn_sdk_engine` 装配；`CrashReason::Overloaded`；`PromptWaitOutcome::CancelledAfterTimeout` 增加 `settle: CancelSettleResolution` 三态；洪泛/过载/优先级测试重写与新增 | 修改 |
| `src-tauri/src/acp/client.rs` | `NotificationInbox` 双通道（updates/control）；`ClassifiedMessage.ingress_seq`；`disconnected()` 装配 telemetry | 修改 |
| `src-tauri/src/acp/cause.rs` | `overloaded` 稳定 code 入封闭词表（cause DTO + 反向映射 + 词表测试） | 修改 |
| `src-tauri/src/acp/mod.rs` | turn_ledger 模块注册与再导出；engine 再导出 `CancelSettleResolution` | 修改 |
| `src-tauri/src/acp/replay.rs` | `ClassifiedMessage` 新字段适配（测试构造） | 修改 |
| `src-tauri/src/acp/tests.rs` | `settle` 字段断言；permission 请求改从控制 lane 接收 | 修改 |
| `src-tauri/src/acp/golden_trace_tests.rs` | 新增 `inbound_envelope_agrees_with_wire_capture`（raw/typed parity + id 保真）与 `replay_boundary_order_is_reconstructible_from_sequences`（replay 单序列重建） | 修改 |
| `src-tauri/src/runtime.rs` | `AgentRuntime.turn_ledger` 字段；`cold_mount_turn_snapshot`（turn/sequence/lastError/replayLoading 聚合快照） | 修改 |
| `src-tauri/src/session/prompt.rs` | prompt 全路径接 ledger：begin（出站成功）→ settle（Response/ConnectionClosed/CancelledAfterTimeout 三分支映射稳定终态 + empty-turn 细分 + settle 三态解析） | 修改 |
| `src-tauri/src/session/persist.rs` | `PersistedSessionLoadResult.turn` 字段（冷挂载快照随 load 响应下发） | 修改 |
| `src-tauri/src/dispatcher/mod.rs` | 主循环 `biased` select 控制帧优先；`drop_generation` 代际退出清理；`handle_session_update` 接 ledger（Streaming 推进 + ingress cursor） | 修改 |
| `scripts/check-acp-shadow-parity.mjs` | 背压探针改为逐个 `--exact` 运行新测试并校验 `1 passed`（修掉"测试改名后探针假绿"）；快照元数据更新为 `bounded-spill-then-overload-terminal` | 修改 |
| `docs/说明书/Pylon-项目架构参考.md` | §8.1 入站背压/turn 账本/冷挂载快照表述 | 修改 |

## 方案要点

1. **可靠投递（三选一取「spill + 显式过载终止」）**：入站帧先分配单调 ingress
   ordinal 再投递；inbox（4096）满转有界 spill（8192）由泵任务按「控制优先、各
   lane 保序」续投；spill 溢出 = 首个 gap 触发过载终态（携带稳定 code
   `overloaded` 的崩溃广播 + crashed 标志 + shutdown），此后溢出帧只计数。
   分配与终止内聚在 `InboundRelay`，调用方无法绕过（结构性不变量，非约定）。
2. **控制帧优先级**：agent JSON-RPC 请求与崩溃广播走独立有界通道（64），
   dispatcher `biased` select（crash watch > control > updates）；每帧携带
   ingress_seq，优先级不改写序列语义。
3. **Terminal ledger**：key = `(local, remote, generation, turn_id)`；CAS settle
   只认第一个终态，迟到者计 `late_terminal_events`；generation 是硬隔离，旧代际
   dispatcher 退出时 `drop_generation` 收敛。prompt 路径 begin 后每条路径必 settle
   （Response→按 stopReason/错误映射；ConnectionLost；超时分支按 settle 三态：
   Responded→Agent 终态胜出 / SettleTimeout→`CancelSettleTimeout`（triggered_by
   进 detail）/ ResponderDropped→`ConnectionLost`）。空回合细分
   tool-only/agent-empty/cancelled/refusal。
4. **raw/typed 双轨**：wire capture 保持 raw 权威（id 原始形态、脱敏、bounded）；
   新 parity 测试证明 inbox 帧的 `wire_ordinal` 与 wire 记录一一对应、method 一致、
   响应 id 与请求 id 同形同值。
5. **replay/live 单序列**：golden 化测试证明 load 请求 → replay update → load 响应
   可由 wire monotonicSeq + ingress_seq 重建；replay 帧分类绑定 request id。
6. **冷挂载**：`load_persisted_session` 响应新增 `turn` 快照
   （turnState/terminalCause/lastError/sequence/replayLoading），前端恢复不依赖
   一次性 Tauri event。账本决定生命周期、journal 决定 durable content、wire trace
   决定诊断证据的边界不变。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| inbox 持满 + 2 倍容量洪泛，无未记录丢帧 | ✅ `inbox_full_spills_then_delivers_every_frame_in_order`（spill 续投全量送达 + ingress 序列 1..3 无 gap）；溢出场景 `spill_overflow_terminates_connection_with_explicit_overload`（dropped=1 显式 gap + overloaded 终态） |
| response/控制帧在通知洪泛下有界时间内路由 | ✅ `control_lane_delivers_requests_while_update_flood_is_queued`；响应路径本就经 SDK SentRequest 不入 inbox |
| number/string/null/absent id、error、malformed、batch 有 wire/typed 断言 | ✅ wire 层既有 `preserves_number_string_null_absent_id_kinds`；新增 `inbound_envelope_agrees_with_wire_capture`（响应 id 与请求 id 同形同值）；malformed/batch 由 SDK transport 层承担，Pylon 侧 raw capture 原样记录（bridge_with_inspection 逐帧观测） |
| 一个 prompt 至多一个 terminal transition；重复 response/TurnComplete/cancel/EOF 竞态幂等 | ✅ `cancel_and_response_race_produces_single_terminal`、`begin_then_settle_publishes_exactly_once` 等 ledger 单测；prompt 路径 CAS 拦截 + `Late` 计数 |
| first-token/idle/cancel-settle/writer/EOF/protocol/refusal/max-turn/empty 全映射稳定终态且快照可恢复 | ✅ `terminal_cause_mapping_covers_protocol_stop_reasons` + prompt 路径 settle 分支；`TurnTerminalCause` 词表完备（writer/overloaded 等由测试锁定语义） |
| 超时触发 cancel 后 settle 窗口内终态胜出；窗口外迟到只记 stale/late | ✅ `CancelledAfterTimeout.settle == Responded` 断言 + CAS `Late`；代际迟到由 key 隔离（`generation_isolation_rejects_stale_settle`）+ dispatcher 退出 `drop_generation` |
| session/load replay 顺序可由 sequence 重建；replay 不进 live accumulator | ✅ `replay_boundary_order_is_reconstructible_from_sequences`；replay 不进 live collector 为既有 routing 契约（`replay_decision_never_persists_or_applies_pet` 等全绿） |
| 冷挂载只凭 snapshot + cursor 恢复 | ✅ `cold_mount_turn_snapshot`（turn/sequence/lastError/replayLoading）随 `PersistedSessionLoadResult.turn` 下发；不依赖一次性 Tauri event |
| generation replacement 后旧 client 不能改写新代际；旧 waiter 有终态 | ✅ key 隔离 + `drop_generation_clears_only_stale_entries` + 既有 generation 回归全绿（1071 tests） |
| 官方 ACP golden fixture 与 SDK engine/raw observer method/id/params/result/error 一致 | ✅ `check:acp-shadow` 8 场景 parity 全 true（含新增诚实背压探针）+ golden trace 双向 id 形态测试 |
| Job Object/taskkill、stderr tail、redaction、canonical journal、owner/generation、permission 语义不回归 | ✅ 全量 `cargo test --lib` 1071 通过（0 failed） |

## 测试处置

修改既有测试（预期行为变化逐条）：

1. `engine::inbox_full_does_not_block_dispatch` → 重写为
   `inbox_full_spills_then_delivers_every_frame_in_order`：旧契约断言「容量 1 时
   后 2 帧被静默丢弃」；#99 禁止静默丢帧，新契约 = 全帧按序送达 + ingress 单调。
   原「inbox 满时 dispatch loop 保持响应」断言原样保留。
2. `acp::tests::send_response_writes_result_with_matching_id`：permission 请求
   改从 `recv_control()` 接收（控制 lane 行为变化），其余断言不变。
3. `acp::tests` 两处 `CancelledAfterTimeout` 解构补 `settle` 字段断言
   （Responded 与 response 成对）。
4. `engine` 其余 5 个既有测试仅适配 `spawn_sdk_client` 新签名（`InboundRelay`
   测试构造），断言不变。
5. `check-acp-shadow-parity.mjs`：背压探针由「运行旧测试名（改名后会静默假绿）」
   改为逐个 `--exact` 运行两个新测试并强制校验 `1 passed`；元数据
   `drop-on-full` → `bounded-spill-then-overload-terminal`。

新增测试：`acp::turn_ledger` 11 组、`engine` 3 个（spill 续投/过载终态/控制优先）、
golden 2 个（wire parity/replay 序列）。

## 证据

- 门禁（全部 0 退出）：
  - `cargo fmt --check`：本 issue 文件域无差异（工作区其余差异属 #97/#98 在途文件）
  - `cargo test --lib acp::engine`：9 passed
  - `cargo test --lib acp::client`：0 failed（无测试模块，编译通过）
  - `cargo test --lib dispatcher::routing`：6 passed
  - `cargo test --lib session::prompt`：4 passed
  - `cargo test --lib acp::golden_trace_tests`：8 passed
  - `cargo test --lib acp::turn_ledger`：11 passed
  - `cargo test --lib`：**1071 passed, 0 failed**
  - `bun.cmd run check:acp-shadow`：ok=true，8 场景 parity 全 true
- 过载终态链路：spill 溢出 → `dropped_total` 计数 → 控制通道崩溃广播（reason=
  `overloaded`）→ dispatcher `handle_crash` 稳定文案 + cause DTO → shutdown 收敛。

## 与 spec 的偏差

- 「背压/spill/gap 终态三选一」：实现为组合策略——有界 spill 续投为主，
  spill 溢出后取显式 gap/过载终态（spec 允许的组合，杜绝静默丢帧）。
- `TurnTerminalCause` 的 writer/EOF 等传输侧变体在本切片由测试锁定语义、
  运行路径部分接线（ConnectionLost 覆盖 EOF/writer 大多数场景）；writer 细分
  接线留给消费方 #97/#98（词表完备性先行，`allow(dead_code)` 已注明理由）。
- turn ledger 未持久化到 session snapshot（spec 未决问题拍板：仅运行时权威 +
  load 响应投影快照，不复制第二套 durable journal）。

## 未解问题

- `InboundRelay` 泵任务的续投延迟（5ms 轮询 + Notify 唤醒）在极端洪泛下的
  生命周期开销未做 profile；如需可观测，telemetry 已暴露 spilled_total。
- `EmptyTurnCause::Unknown` 为防御性分支保留，当前运行路径不可达（由
  `agent-empty` 兜底）。

## 并行交集

本次提交只含本 issue 文件域；共享文件 `acp/mod.rs`、`dispatcher/mod.rs`、
`runtime.rs` 采用选择性暂存（仅 #99 hunks），#97/#98 的并行 hunks 留在各自
工作区未提交。给后来者：`dispatcher/mod.rs` 主循环 select 顺序
（watch > control > updates）与 `ClassifiedMessage.ingress_seq` 是 #99 契约，
改动需同步 `engine` 三个洪泛/优先级测试。
