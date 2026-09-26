# Dev Record — #352 用户 cancel 一等判死输入

## 元信息

- issue：#352
- 分支：`kumo/352-cancel-death`（**独立 worktree** `../pylon-352`，基于 `github/main` `0838dc6e`）
- 提交范围：`0838dc6e..<本次 PR head>`
- 日期：2026-09-27

## 目标与范围

issue 期望原话：「用户 cancel 应当是一等判死输入：『本 generation 本 session 已发出用户 cancel』应直接触发进入 `cancel_settle_timeout` 窗口（窗口内到达的终态胜出；窗口超时按既有 `CancelSettleTimeout` 终因收敛），而不是依赖闲置判死；同时 liveness 续命应对 cancel 之后的活动豁免。」

做：cancel 判死输入贯穿三域（engine 判死循环 / 会话载体 / control-prompt 接线）+ 回归测试。
不做：不动 dispatcher 的 `last_activity` 刷新点（豁免由 flag 命中后完全绕开 liveness 评估构造性达成）；不动 `turn_ledger`（`CancelSettleTimeout` 终因与 CAS 单终态不变，detail 自由串新增 `user_cancel` 值）；不做「liveness 时间戳钳制」替代实现（那只是把永不收敛劣化为 idle_timeout 级迟滞，不满足「直接进 settle 窗口」契约）。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `pylon-acp/src/engine.rs` | `PromptTimeoutKind` 增 `UserCancel`（as_str `user-cancel`）；`wait_prompt_with_recovery` 增参 `cancel_requested: impl Fn() -> bool`，循环内在闲置/首 token 评估**之前**检查——命中即跳过评估直接进 cancel+settle+force_kill 既有路径 | 修改 |
| `src-tauri/src/session/model.rs` | `SessionInfo` 增 `cancel_requested_at: Option<Instant>`（进程内事实，不落 wire）+ `mark_cancel_requested`；`mark_turn_in_flight` 同点清除（新回合不继承旧 cancel） | 修改 |
| `src-tauri/src/session/control.rs` | `cancel_prompt` 发送成功 + generation/session 复核通过后置位标记 | 修改 |
| `src-tauri/src/session/prompt.rs` | 注入 `cancel_requested` 闭包（读载体）；`timeout_label` 补 `UserCancel => "user-cancel"` 臂；新增载体语义测试 | 修改 |
| `src-tauri/src/acp/tests.rs` | 新增 3 例回归；6 处既有调用机械补 `|| false` | 修改 |
| `src-tauri/src/acp/real_acp_smoke.rs` | 2 处既有调用机械补 `|| false` | 修改 |

## 方案要点

- **为什么必须是 engine 判死输入**：settle 窗口只存在于 `wait_prompt_with_recovery` 判死**之后**；判死输入此前只有首 token/闲置两路。session 层钳制 liveness 时间戳只能把「永不收敛」劣化为「idle_timeout 级迟滞」，不满足契约。
- **「cancel 后活动豁免」由构造满足**：flag 在闲置/首 token 评估之前检查，命中即完全绕开 liveness——活动刷新不再有任何效果，无需时间戳操作。
- **幂等与安全**：flag 命中后仍走既有 cancel 闭包（重发 `session/cancel` 协议幂等，保持「死亡路径必 cancel」引擎不变量）；control 侧置位放在发送成功 + 复核之后（发送失败的 cancel 不判死）；`mark_turn_in_flight` 清除保证新回合不继承（prompt_gate 单在途 → 标量载体足够）；命中感知延迟 ≤ 一个轮询周期（最小超时/8）。
- **遥测**：settle 窗口超时终因仍为 `CancelSettleTimeout`，detail `triggered_by:user-cancel`；failure metadata `timeout_kind: "user-cancel"`（前端仅按 "timed out after Ns" 轻量解析，不受影响）。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| engine 判死回归：flag 置位即判死（持续活动不得续命） | ✅ `user_cancel_flag_fires_immediately_despite_sustained_activity` |
| settle 窗口语义：窗口内终态胜出 / 超时 SettleTimeout | ✅ `user_cancel_settle_window_terminal_wins` + `user_cancel_flag_converges_sustained_turn_after_late_set`（flag 迟到 100ms 置位，2s 内收敛——对修复前「永不收敛」的直接回归） |
| 载体语义：置位可见、新回合起点清除 | ✅ `session::prompt::tests::cancel_requested_mark_is_set_and_cleared_on_new_turn` |
| 既有行为不回归 | ✅ pylon-acp `159 passed (159)`；主 crate `852 passed / 0 failed / 4 ignored`（含全部既有 wait/settle/force_kill 测试） |
| fmt / clippy | ✅ `cargo fmt --all --check` 通过；`cargo clippy --workspace --all-targets` 零告警 |

## 测试处置

- 新增：3 例 engine 判死回归（`acp/tests.rs`）+ 1 例载体语义（`session/prompt.rs` tests）。
- 修改：`wait_prompt_with_recovery` 全部 8 个调用点机械补 `cancel_requested` 实参（生产 1 + 测试 6 + smoke 2 中的 `|| false`）。

## 证据

- `cargo test -p pylon-acp --lib`：`159 passed; 0 failed`。
- `cargo test --lib`（主 crate）：`852 passed; 0 failed; 4 ignored`。
- `cargo fmt --all --check`：通过；`cargo clippy --workspace --all-targets`：零告警。
- 本机可复现说明：修复前该 bug 需「cancel 后持续产出不回终态」的 agent（issue 复现步骤）；修复后由 `user_cancel_flag_converges_sustained_turn_after_late_set` 以合成 liveness 持续刷新 + flag 迟到置位直接钉住同一机制，无需真实不合规 agent。

## 与 spec 的偏差

无。spec（`.agents/spec/352-user-cancel-first-class-death.md`，共享树，不入库）三域设计与本实现一致；worktree 内新增环境性占位（`dist/index.html`，gitignored，tauri `generate_context!` 编译所需），不影响任何提交内容。

## 未解问题

- 无。#349 规格备注的「cancel settle 窗口（待复核）」随本修复闭合：窗口现可由用户 cancel 直接触发，不再依赖闲置判死这一先决条件。

## 并行交集

- **共享工作树零触碰**（只动过 `.agents/L.md`，已单独提交）。`engine.rs` 在共享树属 #363 在途脏文件（§2.1），故按 §2.5 并行冲突条款以独立 worktree 基于 `github/main` 施工；本分支与 #363 对 engine.rs 的改动区域不相交（spawn 收口区 ~:635 vs 等待循环区 ~:1980-2160），合并序由 PR 层解决。
