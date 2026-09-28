# ADR-0034 turn 在途事实单源化——TurnLedger.active 为唯一真源

- **日期**：2026-09-28
- **状态**：已采用
- **关联**：修订 ADR-0017/#217 的 `SessionInfo.turn_in_flight` 表述；issue #420（裁决来源 #417 台账）

## 背景与约束

「本会话有没有在途回合」（本进程已派发 prompt、尚未收到终态）原为**双写**：`TurnLedger.begin` 与 `SessionInfo.turn_in_flight` 同点置位；清理双出口（`report_settle` 按键清理 + `publish_prompt_failure` 无条件 force-clear 防御纵深）。双写靠人肉对齐（#217/#352 时代多次修补），快照 anomaly 读数本质是「两源失配检测」——单方向（标记真 ∧ 账本无在途）的检测器。

约束：快照 wire 字段名/类型（`turnInFlight`/`turnInFlightAnomaly`/`turnInFlightAnomalies`）为前端契约不可变；`cancel_requested`（#352 判死输入）语义不变；账本 CAS/generation 隔离既有语义不变。

## 备选方案

| 方案 | 否决理由 |
| --- | --- |
| 保留双写、只补对齐测试 | 不消除结构性风险，检测器单向盲区（账本滞留检测不到）依旧 |
| SessionInfo 标记升格真源、账本只做终态 | 标记无 CAS、无保留语义，表达力弱于账本 active 表；快照 `turn` 记录与在途判定将来自两个不同源 |
| 单源化 + anomaly 字段随 wire 收敛移除 | 前端契约变更，超出 #420 授权 |

## 决定

`TurnLedger.active` 表为「在途回合」唯一真源；`SessionInfo` 删除该标记族。配套：

1. **三个新账本口**：`turn_in_flight(local, remote, generation)`（会话三元组在途查询，expiry/快照共用）；`settle_active_for_session(...)`（防御结算，只动 active 候选、不产生 Late 噪声，生产调用方 = `publish_prompt_failure`）；`stale_active_for_session(local, generation)`（非当前代际在途残留计数）。
2. **写入点收口**：置位 = `begin` 单独；收敛 = `report_settle` 的 `settle` 单独（键控让位语义由 `TurnKey` 含 generation 本身承担）；防御 = `publish_prompt_failure` 调 `settle_active_for_session`（cause=ProtocolError，detail=错误原文；`Published` 才告警——原 force-clear「真清了才告警」语义等价保留）。
3. **消费点切换**：冷挂载快照 `turnInFlight` = 账本「在途优先」记录无 terminal（单源同口径）；expiry 豁免 = `turn_in_flight` 查询（账本叶子锁，sessions 锁内查询无锁序风险——账本不回调宿主、不取其他锁）。
4. **anomaly 判据换轴**：旧「标记与账本失配」按构造不可达（单源）；新判据 = `stale_active_for_session > 0`（drop_generation 漏清检测）。字段名/类型不变，语义变化在本文档与说明书显式记录。
5. `cancel_requested` 的「回合起点清除」职责由 `clear_cancel_requested_for_new_turn()` 承载（原 `mark_turn_in_flight` 的幸存职责），与 `begin` 同点调用。

## 后果

- 正面：消灭双写与双出口人肉对齐；防御纵深在单源上根治「等待 future 被取消等未经终态臂的残余」导致的恒真快照；新 anomaly 接住旧检测器的单向盲区（账本侧残留）。
- 负面：同代际「active 滞留但防御也漏掉」的极端场景（如进程内路径全部失守）内部不可检（无第二源）——由防御结算的覆盖面兜底；anomaly 语义变化需文档随读。
- 风险：`settle_active_for_session` 与真实终态臂的次序竞态由 CAS 拦截（臂先结算 → 防御 no-op；防御先结算 → 臂收 Late 告警 + 计数，仅异常路径出现诊断噪声）。

## 证据

- `pylon-acp/src/turn_ledger.rs`：`turn_in_flight` / `settle_active_for_session` / `stale_active_for_session` 三方法 + 三组单测（含「防御结算不碰终态记录」「stale 只计非当前代际」）。
- `src-tauri/src/session/model.rs`：`TurnInFlightMark` 族删除；`clear_cancel_requested_for_new_turn` + 单测。
- `src-tauri/src/session/prompt/{wait,ledger,ingest}.rs`：三写入点收口。
- `src-tauri/src/runtime.rs` `cold_mount_turn_snapshot`：单源判定 + 换轴 anomaly + 契约测试 ①②③（③ 改为旧代际残留场景）。
- `src-tauri/src/session/expiry.rs`：豁免切账本（平台测试夹具随迁）。
