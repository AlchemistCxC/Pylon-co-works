# Dev Record — #97 通用 ACP 模型选择器与切换闭环

> 入库保留。规格文档（spec）不保留，其目标、范围、方案与验收结论在此承接。
> 产出路径：`.agents/records/issue-97-model-selector-closed-loop.md`

## 元信息

- issue：[#97 通用 ACP 模型选择器与切换闭环](https://github.com/AlchemistCxC/Pylon-co-works/issues/97)
- 分支：`Ru5t/Reflector`
- 提交范围：`416aabab..（本次实现提交）`
- 日期：2026-09-15
- ADR：[ADR-0004 模型选择器切换收敛与兼容发送规则](../decisions/0004-model-selector-convergence.md)

## 目标与范围

把模型切换收敛成与 Agent 厂商无关的后端状态机：统一模型面解析、真实 config id
全链路保留、requested/pending/confirmed 三态收敛、异步全量刷新、generation 检查与
幂等去重。**不做**：provider 特判、fork/权限 UI、模型定价、模型目录持久化、Workbench
视觉组件重构（前端仅契约测试）。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src-tauri/src/session/model.rs` | 模型面解析（`response_models_state`、根级 current 消费）、`ModelSwitchSettlement` 收敛、`apply_models_state`、`replace_config_options` 有界替换、`resolve_model_switch_target` 宣告 id 保留、`validate_advertised_choice`、`model_pending`/诊断计数字段及对应测试 | 修改 |
| `src-tauri/src/session/control.rs` | reasoning 组发送前校验、`model_config_id_missing` 兼容诊断、钳制/暂定结算诊断 | 修改 |
| `src-tauri/src/session/create.rs` | `plan_initial_model` 改用共享 `response_models_state`（与 SessionInfo 同一解析入口） | 修改 |
| `src-tauri/src/dispatcher/mod.rs` | `SessionInfoUpdate` 的 models 全量消费（fingerprint 幂等）、`ConfigOptionUpdate` 有界替换与 pending 清除、对应测试 | 修改 |
| `src-tauri/src/session/mod.rs` | `#[cfg(test)] mod model_switch_wire_tests;` 一行注册 | 修改 |
| `src-tauri/src/session/model_switch_wire_tests.rs` | wire 级集成测试（4 用例，fake ACP agent + 请求 trace 断言） | 新增 |
| `src/components/chat/__tests__/sessionModelState.test.ts` | current-only 回声不压塌 catalog、adopted 列表权威性契约 | 修改 |
| `src/sheets/agent-workbench/__tests__/agentWorkbenchSession.test.ts` | 空回声保留已投影 catalog、权威完整列表刷新契约 | 修改 |
| `.agents/decisions/0004-model-selector-convergence.md` | 兼容发送规则 ADR | 新增 |

## 方案要点

1. **一套解析规则全链路共用**：`response_models_state` 同时服务初值计划
   （`plan_initial_model`）、`session/new`/`session/load` 响应刷新
   （`apply_session_response`）与异步 `session_info_update`（`apply_models_state`）。
   嵌套 `models.availableModels`、根级 `availableModels`/`available_models`、
   camel/snake 变体、根级 `currentModelId`/`current_model_id` 全部等价进入模型面。
2. **三态收敛**：`apply_config_option_response` 返回 `ModelSwitchSettlement`——
   `Confirmed`/`Clamped`（requested≠实际，状态回到 Agent 值）/`Pending`（空回声，
   乐观值保留且 `model_pending` 可辨识）/`Authoritative`。pending 只被权威回显或
   完整 models 推送清除；纯内部字段，不落 wire、不持久化（向后兼容零影响）。
3. **路由与发送不变量**：显式 ConfigOption 声明 + 会话宣告非标准 config id →
   原样上 wire（`resolve_model_switch_target` 返回宣告 id）；未宣告 → 兼容发送语义键
   + `model_config_id_missing` 诊断（ADR-0004 裁决，采纳「兼容 + 诊断」而非
   fail-closed 拒绝）。reasoning 组依赖 option 在宣告了 choices 时发送前校验
   （`reasoning_not_advertised`），choices 为空放行（现状兼容）。
4. **幂等与有界**：`apply_models_state` 对完全相同的 models push 按 FNV-1a 指纹去重
   （丢弃计数 `selector_duplicate_pushes`）；`replace_config_options` 对超 256KiB 的
   raw selector envelope 拒绝替换并计数（`selector_envelope_dropped`），不做截断——
   未知 option kind 随原样数组保留（typed projection 只在读侧窄化，结构未变）。
5. **replay/owner**：`session/load` 复活期零 selector RPC（模型状态来自 load 响应
   本身，依赖 option 由 Agent 建立期推送；wire trace 断言）；owner 路由（active agent
   ≠ session runtime agent 时按 runtime owner 通道发送）由既有 G2-03 测试继续覆盖，
   本轮未改动该路由逻辑。
6. **共享文件处置**：`create.rs`、`dispatcher/mod.rs`、`session/mod.rs` 与 #98/#99
   在途改动同文件不同 hunk；本次提交对这些文件只暂存本 issue 的 hunk
   （`git apply --cached` 选择性暂存），未连带他人改动。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| 标准 config option 非标准广告 id（`model-selection`）原样上 wire（断言 wire params） | 通过：`runtime_switch_sends_advertised_config_id_and_keeps_pending_on_empty_echo` |
| 嵌套/根级/camel/snake 模型列表进入 `model_surface`/`model_choices` 等价 | 通过：`root_level_model_catalogs_enter_session_info_equivalently`、`initial_model_plan_reads_top_level_model_catalog` |
| 有可用集合时未广告 id 发送前被拒；无集合无显式通道返回稳定「不可切换」错误 | 通过：`unadvertised_model_id_is_rejected_before_any_rpc`、`resolve_model_switch_target_rejects_when_no_surface_advertised`（既有） |
| `session_info_update` 完整模型集合同步刷新 choices/current；旧 push 幂等丢弃 | 通过：`session_info_update_refreshes_full_model_catalog_and_clears_pending`、`duplicate_session_info_push_is_deduplicated_with_diagnostic_count` |
| 空成功响应保留已有完整集合（两项不合成单项） | 通过：`config_option_response_keeps_local_catalog_on_empty_echo`、workbench `#97 空回声响应保留已投影的 selector catalog` |
| Agent 拒绝/钳制时状态回到实际值 + 可恢复诊断，不滞留乐观值 | 通过：`clamped_switch_converges_to_agent_settled_value`、`model_switch_settlement_matrix_distinguishes_confirmed_clamped_pending`（`model_switch_clamped` warn） |
| 依赖 option（reasoning/effort）只发送仍被广告的值 | 通过：`validate_advertised_choice_carries_stable_code_for_dependent_options` + control 发送前校验 |
| 未知 config option kind 不丢已知 selector；raw envelope 有界、超限拒绝 | 通过：`oversized_selector_envelope_is_refused_without_corrupting_known_state`、dispatcher 同款测试 |
| reconnect/load selector replay：零自动 selector RPC、Agent 推送优先；模型先于依赖 option（初值路径既有顺序 model→mode→reasoning 不变） | 通过：`load_revive_applies_root_level_catalog_without_selector_rpcs` |
| 重复 adopted push 只提交一次、不触发第二次 set-config RPC | 通过：`duplicate_session_info_push_is_deduplicated_with_diagnostic_count`（dispatcher 无自动补偿 RPC 路径，结构性成立） |
| 跨 owner 重绑 selector snapshot 原子替换、无泄漏 | 通过：结构性成立——`replace_session_slot` 整体替换 SessionInfo，`SessionInfo::new` 空 selector 起点（既有行为，本轮未改动） |
| owner 路由：active agent ≠ session runtime agent 仍按 runtime owner 通道发送 | 通过：既有 G2-03 测试（`session/mod.rs` tests），本轮未触碰该路由 |
| fixture 不以真实 provider 命名 | 通过：`ms-agent`/`ms-revive-agent` + 标准配置项/仅扩展列表/非标准 config id 三种 Agent 形态齐备 |
| 不改变非模型 config option、mode、close/cancel、journal、generation 行为 | 通过：全量 lib 测试（worktree 基线）无回归 |

## 测试处置

- 新增（Rust）：`session::model::tests` 7 个（根级等价、三态收敛矩阵、全量刷新+去重、
  有界 envelope、显式声明 config id 保留、依赖 option 校验码）+
  `session::model_switch_wire_tests` 4 个（wire config id、发送前拒绝、钳制收敛、
  复活零 selector RPC）+ `dispatcher::tests` 3 个（全量刷新、重复 push 去重、超限
  envelope）。
- 新增（前端）：`sessionModelState.test.ts` 2 个、`agentWorkbenchSession.test.ts` 2 个
  （catalog 保留/权威刷新契约；仅测试，未改任何 UI 源文件）。
- 既有测试零删除、零跳过；`resolve_model_switch_target_prefers_explicit_declaration`
  既有断言在 D97-5 语义下继续成立。

## 证据

- commit：`<本次实现提交>`（见 PR）
- 测试：worktree（HEAD + 本 issue hunks）`cargo test --lib` 全量绿、
  `session::model` 26 passed、`model_switch_wire_tests` 4 passed、`dispatcher` 21
  passed、`session::create` 8 passed、`cargo fmt --check` 通过；前端 vitest 目标两文件
  34 passed。共享树当时被 #99 在途测试代码阻塞 cfg(test) 构建，故门禁在独立
  worktree 执行（共享树 lib 目标编译通过）。
- 手工验证：无（本切片为后端状态机 + 契约测试，无 UI 交互变更）。

## 与 spec 的偏差

1. spec 未决问题「显式 ConfigOption 无 config id 是否兼容发送」：按 ADR-0004 裁决为
   「兼容发送 + `model_config_id_missing` 诊断」，未采纳默认建议的 fail-closed 拒绝
   （会破坏 set_model_api=ConfigOption 声明下未宣告广告的现有可用会话；兼容优先为
   仓库一贯裁决先例）。
2. spec 验收「两项模型切换后 selector catalog 仍为两项」在 workbench 投影层的
   singleton mirror（`AgentRendererSuiteWorkbench.tsx` 为空回声合成的单项响应）仍会把
   **前端文档** catalog 压成单项——该行为属 UI 层预存的已知缺口（审计已点名），本
   issue 明确禁止改 UI 源码；前端契约测试钉住的是「后端可发出的全部回声形状
   （空对象/空 configOptions/current-only）不会压塌 catalog」。UI mirror 的整改留给
   UI 改造 issue（#51/#53 背景）。
3. 「stale generation push 丢弃计数」由 dispatcher/routing 的 generation 门控负责
   （#99 文件域），本 issue 只落地了重复 push 的 dropped 计数；两者合并构成 spec 的
   dropped/stale 诊断。

## 未解问题

- `model_pending` 目前仅内部可辨识（诊断日志 + 状态字段），未上 IPC wire；若 UI 需要
  显示「未确认」角标，需按 ADR-0004 的向后兼容规则补 wire 字段。
- workbench singleton mirror 的前端整改（见偏差 2）。

## 并行交集

- `session/mod.rs`：仅追加一行 `#[cfg(test)] mod` 注册（与 #98 的 `mod fork;` 注册
  同文件不同位置）。
- `create.rs`：仅 `plan_initial_model` 区段；`revive_session_slot`/`ensure_session_mapping`
  区段属 #99 在途重构，本 issue 提交未包含其 hunk。
- `dispatcher/mod.rs`：`apply_update_event_with_pet_policy` 的 SessionInfoUpdate/
  ConfigOptionUpdate 区段与 tests 尾部；`handle_permission_request`/
  `handle_session_update`/`start_notification_dispatcher` 区段属 #99，本 issue 提交
  未包含其 hunk。
