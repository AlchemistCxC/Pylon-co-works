# Dev Record — #349 宿主会话生命周期缺陷批次

> 入库保留。规格文档（spec）不保留，其目标、范围、方案与验收结论在此承接。
> 规格原稿：`.agents/spec/349-host-session-lifecycle-defects.md`（不计入版本库）。

## 元信息

- issue：[#349](https://github.com/AlchemistCxC/Pylon-co-works/issues/349)
- 分支：`kumo/prometheus`
- 提交范围：`bd5cd0d9`（代码；本记录另计）
- 日期：2026-09-26
- 来源：ACP 连接四域对照审计 C3 报告的可施工清单（审计基线早于 PR #347 / #155，本批每项均在合并后的树上重新核实）

## 目标与范围

**目标**：修掉 revive 路径 `session/load` 回放无治理导致的双症状（dispatcher 泵长停摆、canonical journal 重复历史），并修正私有交互的语义问题。

**不做什么**：不改 ACP wire 行为；不动 `pylon-acp/**`（`src/adapter/**` 除外，属本批）、`pylon-session/**`、`dispatcher/mod.rs`、前端。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src-tauri/src/session/create.rs` | `revive_session_slot` 的 load 臂改造 + 外层 generation 失败恢复 | 修改 |
| `src-tauri/src/session/revive_tests.rs` | 新增两个用例 | 修改 |
| `src-tauri/src/dispatcher/interaction_route.rs` | 私有交互准入守卫（回退至 B2 前形态）+ 测试模块改写 | 修改 |
| `src-tauri/pylon-acp/src/adapter/private_ext/mod.rs` | `parse_elicitation` 的 mode fail-closed 拒绝 | 修改 |
| `src-tauri/src/session/fork.rs` | `METHOD_SESSION_FORK` 注释 | 修改 |

## 方案要点

- **B1 与 `session/persist` 同构**：预插 `replay_loading=true` 的 loading 槽 → 锁内 `begin_replay_capture` → 锁外 `load_session_with_replay` → **回放内容丢弃**（canonical journal 仍是唯一 durable 权威），响应仅做挂载判定；capture 拒绝 / load 失败 / generation 失配三条失败路径均先恢复原槽。
- **预插槽是必要条件，不是可选优化**：审计初稿认为「仅登记 capture 即可让回放帧不再走未知会话等待路径」，经施工期核实**不成立**——`dispatcher/mod.rs` 的映射等待循环在 `is_replay` 被消费之前执行，所以只有让映射先在场才能消除每帧 ≤100ms 的停留。该更正已回报并在本记录留存。
- **因果链更正**：revive 的 load 超时由 SDK 传输层施加（不经 dispatcher 泵），故「泵停滞 → 超过 `rpc_timeout` → 降级 new」的推断不成立。真实症状是：泵长停摆拖累同 runtime 全部流量 + journal 重复历史（后者经核实成立）。
- **B2 只保留纯收紧的一半**：`parse_elicitation` 对未广告 `mode != "form"` 的显式拒绝。request-scoped elicitation 的**准入未落地**（理由见「与 spec 的偏差」）。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| revive 的 load 走 capture；回放不产生 canonical 事件 | 达成（`revive_replay_frames_never_reach_canonical_journal` 用真实传输 + 真实 dispatcher 泵，回放 2 帧后断言 journal 零泄漏） |
| 缺 `sessionId` 的私有交互返回参数类错误、方法不受支持仍 `-32601` | **改为**：缺 `sessionId` 一律 `-32601`（B2 准入回退，见偏差）；`mode != "form"` 走 `-32602` |
| B4 有明确结论 | 达成——复核成立但跳过，另立 [#352](https://github.com/AlchemistCxC/Pylon-co-works/issues/352) |
| `cargo fmt --all --check` 无差异 | 达成（exit 0） |

## 测试处置

- 新增：`revive_tests.rs` 的 `revive_load_registers_replay_capture_and_preinserts_loading_slot`（barrier 阻塞期断言槽位已预插且 `replay_loading=true`、二次 capture 得 `ReplayLoadInProgress`、成功后清位）与 `revive_replay_frames_never_reach_canonical_journal`。
- 新增：`interaction_route` 的 `non_elicitation_bridge_without_session_id_is_rejected_method_not_found`、`elicitation_without_session_id_is_rejected_method_not_found`（后者由原 B2 用例改写，方向反转）。
- 保留：`session_scoped_elicitation_keeps_session_id_projection`、`unadvertised_url_mode_is_rejected_as_invalid_params`。
- 修改/删除既有行为测试：**无**。`new_load` / `p1_wire` / `golden_trace` / `model_switch_wire` 用例全部原样通过。

## 证据

- commit：`bd5cd0d9`（5 文件，+585 / −72）
- 测试：
  - `cargo test -p pylon-acp --lib` → `159 passed; 0 failed`
  - `cargo test --lib -p pylon` → `848 passed; 0 failed; 4 ignored`
  - 定向：`interaction_route` 4 passed、`revive*` 11 passed、`p1_wire` 19 passed、`golden*` 8 passed
  - `cargo fmt --all --check` → exit 0
- 门禁：`bun run check:rust` 与单独复核的 `bun run check:acp-shadow` 均绿（8 场景 parity 稳定）。
- 手工验证：无（本批不涉及 UI 行为）。

## 与 spec 的偏差

1. **B2 的 request-scoped elicitation 准入整体回退**（本批最大偏差）。原改动让空 `sessionId` 的 elicitation 入桥入队，但独立审查发现两件事：
   - **条件宽化（真 bug）**：`interaction_route.rs` 的判定写成 `!session_id.is_empty() || bridge != Elicitation`，使**非 elicitation 桥**（ask-user / exit-plan / pi-select）在缺 `sessionId` 时也从「`-32601` 拒绝」变成「入队」——规格未授权。
   - **端到端反而更差**：前端三道真值门都把空串当缺失（`interaction.ts` 的 `stringValue`、`permissionController.ts` 的 `!envelope.sessionId`、`interactionTransport.ts` 的 `requireIdentity`），GUI 既渲染不出也提交不了；且私有交互**没有超时回包**（`private_interactions.cancel_all()` 只在 runtime 崩溃时调用，超时 watcher 的 `expired` 只覆盖 `pending_permissions`），agent 的 `elicitation/create` 会等一个永不到来的响应——**比修之前的即时 `-32601` 更差**。
   故整体回退准入（`interaction_route.rs` 相对 HEAD **零删除行**，函数体逐字节复原），完整跨栈修法另立 [#356](https://github.com/AlchemistCxC/Pylon-co-works/issues/356)。
   **根因记录**：规格与两个施工 agent 都沿用了「本批无 wire/事件形状变化 → 不动前端」这一前提，但该改动虽未变事件**形状**却变了**取值**（`sessionId` 变空串），恰撞上前端真值门。此前提是发起方规划缺陷。
2. **追加外层 generation 失败恢复**（规格未列，审查 P3-1）：原实现下外层 `ensure_generation` 失败会遗留预插的 `replay_loading=true` 槽，持续抑制该 source 的 live 投影直到下次成功 load/new。
3. **B4 跳过**：复核确认成立（且 #155 使其加重——liveness 探针让 cancel 后仍活动的 agent 永不触发闲置判死），但修复需横跨 `pylon-acp/src/engine.rs`、`runtime.rs`/`session/model.rs`、`prompt.rs`/`control.rs` 三个域，按规格预留出口跳过并另立 issue。

## 未解问题

1. 审查报告（未修，同族残留）：`revive_session_slot` 中 `replace_session_slot` 装入最终槽之后，若 `mark_attached_if_current` 失败或 `!attached`，已装入的真实会话槽不会被撤销。与已修的 R7 同族，但未在审查清单内，未扩大范围处理。
2. 外层 generation 纳秒窗口无确定性用例（靠代码路径对称性保证）。

## 并行交集

本批触碰：`src-tauri/src/session/{create.rs,revive_tests.rs,fork.rs}`、`src-tauri/src/dispatcher/interaction_route.rs`、`src-tauri/pylon-acp/src/adapter/private_ext/mod.rs`。未触碰 `dispatcher/mod.rs`、`pylon-session/**`、前端（属在途 #351）。

`dispatcher/interaction_route.rs` 与 `dispatcher/mod.rs` 同目录但不同文件；#334–336 已合入，本批与该目录无在途重叠。
