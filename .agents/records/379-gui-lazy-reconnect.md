# Dev Record — #379 GUI 断线懒重连（发送/建会话前发现 Disconnected 先重建）

## 元信息

- issue：#379（enhancement(acp): GUI 断线缺懒重连——空闲回收/停止后下一次发送直接硬错误）
- 分支：`kumo/prometheus`（共享批次分支，随 PR #438 走；实现提交 `dc5be765`）
- 提交范围：`08522607..dc5be765`
- 日期：2026-09-28

## 目标与范围

引用 issue 期望行为：GUI prompt 路径补上与平台侧 `ensure_runtime_ready` 同形的懒重连——发送前发现 runtime 处于 `Disconnected`（且不是 `Crashed`，避免与 `crash_reconnect.rs` 抢）时，先走既有 `do_connect_and_replace` 重建连接，再发送；重建失败则把既有错误语义（含 `lastError`）如实抛给用户，不吞。

**不做**：不下调 `PYLON_SESSION_IDLE_TIMEOUT_SECS` 默认值、不开放「有会话但闲置」的连接回收（issue 明言两者是后续独立决策）；不改 `crash_reconnect` 自动重连与 `AgentCrashed` 早退语义；不改前端；平台 ingest 路径与共享发送管线 `send_prompt_core` 零改动。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src-tauri/src/session/mod.rs` | 新 `ensure_connected_for_send`（紧随 `ensure_runtime_ready`，同形双检查）；`lazy_reconnect_tests` mod 声明；p28 测试夹具置 Connected + 直呼补 window | 修改 |
| `src-tauri/src/session/prompt/wait.rs` | `send_message` / `send_message_streaming` 两命令入口在 `resolve_agent_runtime` 后各加一次 ensure（streaming 版在 `register_update_channel` **之前**） | 修改 |
| `src-tauri/src/session/create.rs` | `new_session` 泛型化 `<R: tauri::Runtime>` + `window` 注入参（Tauri 注入，前端 wire 不变）+ ensure 调用（廉价校验先行） | 修改 |
| `src-tauri/src/lifecycle/mod.rs` | 仅模块文档：R9 LifecycleOp 状态机表加一行 + 入口清单点名 | 修改 |
| `src-tauri/src/session/lazy_reconnect_tests.rs` | 6 个回归测试 | 新增 |
| `src-tauri/src/test_harness.rs` | boot 后把已连接 fake agent 的 runtime status 如实置 Connected（夹具语义对齐）；harness `new_session` 两处直呼补 window 参 | 修改 |
| `src-tauri/src/session/model_switch_wire_tests.rs` | 已连接夹具置 Connected ×3 runtime；直呼 `new_session` ×3 补 window（新本地 `mock_window` helper） | 修改 |
| `docs/说明书/Pylon-项目架构参考.md` | §9 末尾新增「连接级懒重连（#379）」段 | 修改 |

## 方案要点

issue 三问的定义（详见规格 `.agents/spec/379-gui-lazy-reconnect.md`）：

1. **触发集与锁序**：只认 `Disconnected`（首查 + `agent_lifecycle` 锁后复查双检查）；`Connected/Connecting/Reconnecting` 放行，`Crashed` 放行（交给 crash_reconnect 退避序列 + 既有 `is_crashed → AgentCrashed` 早退）。只持 `agent_lifecycle`、不持 `switch_lock`（无 kill），与平台懒启动/自动重连同侧；调用点在 prompt 锁 / `prompt_gate` / `session_creation` 获取之前，无锁序反转。
2. **用户可见状态**：`announce=true`——重建期间三灯 `connecting`，成功收敛 `Connected`，失败回落 `Disconnected + lastError`（`emit_agent_status` 持久化 lastError + 广播）；错误原样上抛为命令拒绝，前端既有拒绝面回滚乐观行并展示错误文本，不吞。
3. **会话映射**：`continuity=Invalidated`（主动停止/回收后 agent 子进程已死，远端会话必亡，不做 probe，与 `ensure_runtime_ready` 对非 Crashed 的取值一致）；`replace_agent_client` 的 Invalidated 分支清映射 + 收敛旧 prompt 锁条目后，`ensure_session_mapping` 按前端持久化 `known_peri_id` 走 `session/resume|load` 复活、失败回退 `session/new`——既有语义，无额外前置。`agent_id=None`：不接管 `active_agent`（owner 路由的非 active runtime 不抢位）。

**夹具语义修正**（随契约变更）：harness boot 与 `model_switch_wire_tests`/p28 的既有夹具是「client 已连接但 lifecycle status 仍 Disconnected」——新入口会把它们判成待重建并真实二次 spawn（换代、wire trace hub 失联、golden 断言漂移）。按「已连接夹具如实置 Connected」修正，不动测试断言。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| Disconnected（含 #363 回收形态）触发重建成功，status=Connected、generation 前进 | ✅ `ensure_connected_for_send_rebuilds_disconnected_runtime` / `send_path_recovers_after_idle_reclaim_disconnected_runtime` |
| Connected 幂等放行（generation 不变） | ✅ `ensure_connected_for_send_is_noop_when_connected` |
| Crashed 放行不重连（不抢自动重连，状态保持） | ✅ `ensure_connected_for_send_does_not_fight_crash_reconnect` |
| 失败如实上抛 + status 回落 + lastError 落位 | ✅ `ensure_connected_for_send_failure_propagates_and_records_last_error` |
| 未知 agent 报错不留半途状态 | ✅ `ensure_connected_for_send_unknown_agent_errors` |
| 门禁 | ✅ `cargo fmt --all --check` 干净；`bun run check:clippy` exit 0（6 crate `added: []`，基线未动）；`cargo test --workspace --lib --features test-agent` 1619 passed / 0 failed；`cargo test --workspace --tests --features test-agent` 合计 1734 passed / 0 failed |

## 测试处置

- 新增：`session/lazy_reconnect_tests` 6 测（见上表）。
- 修正（夹具，非断言）：`test_harness::boot` 置 Connected；`model_switch_wire_tests` 3 runtime + `session::tests::new_session_applies_initial_options_*`（p28）1 runtime 同；直呼 `new_session` 的 6 处补 window 实参。
- 既有断言测试：零修改、零删除。

## 证据

- commit：本批（实现 + 记录 + 说明书），随共享分支 PR 走。
- 测试：上表门禁四条（fmt / clippy / workspace lib / workspace all-targets），计数如列。
- 手工验证：未做实机（改动面为纯后端命令入口 + 已有单测覆盖触发集与失败传播；实机验收可在需要时按 `.agents/skills/webview2-acceptance/` 配方补——场景：空闲回收触发后 GUI 直接发消息）。

## 与 spec 的偏差

无实质偏差。spec 未决问题一项按裁量落地：`new_session` 一并纳入（issue 问题描述把 `create.rs` 失败列为同症状；命令签名新增 `window` 注入参为 Tauri 运行时注入，前端 wire 零变化）——已在 issue 评论区声明供仓库主否决。

## 未解问题

- `PYLON_SESSION_IDLE_TIMEOUT_SECS` 默认值下调（对齐 Codeg 180s）与「有会话但全闲置也收连接」的开放——issue 明言待独立决策，本项不预判。
- 实机验收（可选）：需要时按 webview2-acceptance skill 配方跑「回收→发送」场景。
