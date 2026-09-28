# Dev Record — #420 turn 在途事实收口：TurnLedger.active 升格唯一真源

> 入库保留。规格 `.agents/spec/420-turn-inflight-single-source.md`（一次性）的目标、范围与验收在此承接。

## 元信息

- issue：#420（裁决来源：#417 台账）
- 分支：`kumo/prometheus`
- 日期：2026-09-28
- ADR：`.agents/decisions/0034-turn-inflight-single-source.md`（修订 ADR-0017/#217 的 SessionInfo 标记表述）

## 目标与范围

**做**：「在途回合」事实从双写（ledger.begin + SessionInfo.turn_in_flight，清理双出口）收口为 `TurnLedger.active` 单源；防御纵深由 `settle_active_for_session` 在单源上重建；快照 anomaly 判据换轴（旧双源失配 → 非当前代际残留检测）；expiry 豁免切账本。

**不做**：wire 字段形状（三字段名/类型逐字不变）、前端、`settle_by_session` 的 cfg(test) 语义、`cancel_requested` 语义（仅载体方法改名承载）。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `pylon-acp/src/turn_ledger.rs` | 新增 `turn_in_flight` / `settle_active_for_session` / `stale_active_for_session` 三公开方法 + 三组单测 | 新增 |
| `src-tauri/src/session/model.rs` | 删 `TurnInFlightMark`/字段/四方法；新增 `clear_cancel_requested_for_new_turn` + 单测；注释随迁 | 删除+新增 |
| `src-tauri/src/session/prompt/wait.rs` | 置位点：mark 块改 cancel 清除（在途由相邻 begin 单独承载） | 修改 |
| `src-tauri/src/session/prompt/ledger.rs` | `report_settle` 删 sessions 清理块（settle 即单点权威） | 修改 |
| `src-tauri/src/session/prompt/ingest.rs` | 防御纵深改 `settle_active_for_session`（ProtocolError + 错误原文；Published 才告警） | 修改 |
| `src-tauri/src/runtime.rs` | 快照：`turnInFlight` 单源判定、anomaly 换轴（stale 残留）+ warn 文案；契约测试 ①②③ 重写（③ 改旧代际残留场景） | 修改 |
| `src-tauri/src/session/expiry.rs` | `SessionSnapshot.turn_in_flight` 采集闭包内查账本（叶子锁，无锁序风险） | 修改 |
| `src-tauri/src/session/prompt/tests.rs` | 成功终态/挂起回合/report_settle 三测改账本断言；cancel 测试改新方法 | 测试修正 |
| `src-tauri/src/session/session_expiry_platform_tests.rs` | 豁免夹具改 `ledger.begin(TurnKey)` | 测试修正 |
| `docs/说明书/Pylon-项目架构参考.md` | §8.1 #217 段改写（单源/新防御/换轴 anomaly）+ cancel 清除方法名 | 文档 |
| `docs/说明书/Pylon-模块维护地图.md` | Native session 行 #352 段随迁 | 文档 |

## 方案要点

- 防御结算**只动 active 候选**（新增 `settle_active_for_session`，而非启用 cfg(test) 的 `settle_by_session`——后者候选含终态、正常路径会产生 Late 告警噪声）。
- expiry 在 sessions 锁内查账本：账本是叶子锁（HashMap 读写、不回调、不取他锁），无锁序风险；注释如实说明。
- anomaly 换轴论证：单源化后旧「标记 ∧ ¬账本」按构造不可达；新判据（非当前代际残留）接住 drop_generation 漏清——旧检测器的单向盲区（账本侧滞留）反而首次可检。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| `cargo test --workspace --lib` | **1588 passed / 0 failed**（基线 1586：+3 账本新测、+1 cancel 新测、−2 model 删除的 in-flight 测，净 +2） |
| `bun run check:clippy` | exit 0，全部 crate `added: []`（首跑 expiry dead_code 一条，为多余 struct 字段，已删字段归零） |
| `cargo fmt --all --check` | 干净 |
| `bun run check:acp-shadow` | 见下方证据节（终验输出） |
| 快照 wire 形状 | 三字段名/类型逐字未动（契约测试 ①②③ 仍钉字段名）；前端零改动 |

## 测试处置

- 删除：`turn_in_flight_mark_keyed_clear_semantics`、`turn_in_flight_force_clear_is_unconditional_and_reported`（model.rs；键控语义由账本自身测试覆盖——TurnKey 含 generation 的 CAS 即键控）。
- 改名/改写：`report_settle_clears_keyed_in_flight_mark` → `report_settle_converges_ledger_in_flight`；`in_flight_turn_mark_tracks_hanging_prompt_until_timeout` → `in_flight_turn_ledger_tracks_hanging_prompt_until_timeout`（断言面从 SessionInfo 切账本）。
- 新增：账本三方法单测 ×3、`clear_cancel_requested_for_new_turn_drops_stale_cancel`、快照 ③ 场景重构造（旧代际残留）。

## 与 spec 的偏差

- spec 曾写「expiry 锁外查账本」——实施为锁内查询（闭包内就地读，账本叶子锁无风险），注释如实更正；无行为差异。

## 未解问题

- 同代际「active 滞留且防御也漏掉」的极端场景内部不可检（无第二源）——ADR-0034 风险节已记录，由防御结算覆盖面兜底。

## 并行交集

`src-tauri/src/runtime.rs`、`session/**`（#416 已并入，无在途冲突）；前端 `src/**`（#410 在途 CSS）零接触。
