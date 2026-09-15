# Dev Record — #97 通用 ACP 模型选择器与切换闭环

> 入库保留。规格文档（spec）不保留，其目标、范围、方案与验收结论在此承接。
> 产出路径：`.agents/records/issue-97-model-selector-closed-loop.md`

## 元信息

- issue：[#97 通用 ACP 模型选择器与切换闭环](https://github.com/AlchemistCxC/Pylon-co-works/issues/97)
- 分支：`Ru5t/Reflector`
- 提交范围：`416aabab..d6251d82`（代码 `aa6f5e19`；文档 `d6251d82`）
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

- commit：`aa6f5e19`（代码）+ `d6251d82`（本记录/ADR）；PR：https://github.com/AlchemistCxC/Pylon-co-works/pull/103
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
4. **钳制/暂定结算当前为 log-only**：`ModelSwitchSettlement` 的 Clamped/Pending 以
   结构化 tracing 诊断（`model_switch_clamped`/`model_switch_pending`）输出，不进
   set_config_option 的 IPC 返回值——命令原样返回 Agent 响应，UI 从响应内容本身
   （P56/D3 权威回声覆盖）间接收敛。若 UI 需要可判定的 rejected/settled 事件，
   按向后兼容规则补 wire 字段（见未解问题）。

## 评审轮修正（2026-09-16，三路子 agent 行级审核后）

三个独立审核（spec 合规 / Rust 正确性 / 测试质量）对首轮提交 `aa6f5e19` 的发现与处置：

| 级别 | 发现 | 处置 |
| --- | --- | --- |
| P0 | `apply_models_state` 对 current-only models push（无列表，仓库既有测试定义的合法形状）把 ModelsState 面降级成 None——模型选择器在第一次增量推送后永久只读；门禁全绿是因新测试恰好全用带列表形状 | 已修：增量 push 语义与快照替换分离（D97-7）——push 未携带宣告 ≠ 撤销宣告，面与 choices 原样保留；补 `models_push_without_catalog_preserves_models_state_surface` 回归（含 resolve 可切换断言、models:null 边界） |
| P1 | `apply_session_response` 不清 `model_pending`——persist.rs 原位 load 路径让陈旧未确认态跨快照滞留 | 已修：快照携带权威 model 维度（configOptions model 选项 / models.current / 根级 current）时清除；补三条路径 + 负例测试 |
| P1 | usage `_meta.model` 权威通道不清 pending，与单值 config_option_update 分支不一致 | 已修：同契约清除；补 dispatcher 测试 |
| P1 | 验收 13 引用的既有 G2-03 owner 路由测试无判别力（`with_active_agent("runtime-b")` 使 active==runtime，误读 active 协议也绿） | 已修：改 `with_active_agent("active-a")`（其声明 SetModel），误读即 wire 出现 set_model，测试变有判别力 |
| P1 | 「过期 generation 丢弃回写」零测试（规格逐字要求） | 已修：新增 wire 测试 `stale_generation_discards_switch_write_back`——barrier 脚本挂起在途 RPC，测试中 `client_generation.fetch_add`，断言命令 stale 错误、current/pending 不变、请求恰上 wire 一次 |
| P1 | 验收 8 依赖 option 校验只测到纯函数，control 接线无测试 | 已修：新增 wire 测试 `reasoning_switch_is_validated_against_advertised_choices`（失效值拒且不上 wire、广告值按语义键上 wire） |
| P1 | 验收 6「Agent 拒绝」形态无测试（adopted 矩阵 7 形缺 3 形之一） | 已修：新增 wire 测试 `agent_rejected_switch_propagates_error_without_state_change`（JSON-RPC error 上抛、状态不变、不重试） |
| P1 | 验收 12 跨 owner 重绑零测试 | 已修：新增 wire 测试 `rebind_on_other_runtime_starts_with_clean_selector_snapshot`（同 source 跨两 runtime 重建，断言新 snapshot 无旧 config id/model id/choices，原会话不受扰） |
| P2 | model 校验/诊断用精确 `key == "model"`，reasoning 用别名匹配——同函数判据不一致，别名键绕过校验 | 已修：model 校验/诊断门改 `config_option_key_matches(&key,"model")`（P56 路由的 `key != "model"` 特判不动——路由是现状行为，校验是本 issue 新增不变量，D97-8） |
| P2 | `apply_models_state` 无 current 维度也清 pending，与 `apply_config_option_response` 判据不一致 | 已修：仅当 push 携带 current 维度才清（D97-2） |
| P2 | 诊断不可观测：envelope 拒绝/重复 push 丢弃无日志 | 已修：`selector_envelope_dropped` warn、`selector_push_duplicate_dropped` debug 结构化日志 |
| P2 | 指纹字段 doc 虚指「config_id/value」去重；文件头 doc 过期 | 已修：doc 与实现对齐（单值推送按 value 相等天然幂等，不走指纹槽），文件头补 #97 职责说明 |
| P2 | 弱断言：wire 空回声 `map_or(true,…)` 过宽、clamp 测试无 trace 计数、workbench `arrayContaining` 掩盖附加项、根级等价测试无交叉键形状 | 已修：精确 `assert_eq!(result, json!({}))`、clamp 断言恰一次 set-config、workbench 补 `toHaveLength(2)`、根级测试补 camel/snake 交叉形状 |
| P3 | wire 测试 trace 临时文件断言失败时泄漏 | 已修：`TraceFile` Drop guard 无条件清理 |
| 未采纳 | AC11 的 `(owner, generation, config_id, value)` 元组去重：评审指出 models 通道单槽指纹窄于 spec | 裁决为记录而非实现——Pylon 的 RPC 响应路径天然一一对应（无重复响应），异步 adopted(configOptions) 全量推送走幂等覆盖（重复提交无可观测副作用）；spec 的元组去重针对 codge 的自动补偿 loop，Pylon 结构上不存在该 loop。若未来引入自动补偿需先补元组去重 |
| 未采纳 | AC9 子情形「未知-kind-only push 降级 ConfigOption 面」 | 裁决为正确语义——完整 adopted 列表是权威，model 选项缺席 = Agent 撤销宣告，降级是正确行为（评审亦确认「未知 kind 与已知选项共存时保面」为真命题，已补测试） |

修正后门禁：`session::model` 34（30 单测 + 8 wire，其中 4 为本轮新增）、`dispatcher` 23（+2）、G2-03 修复后单测绿、`session::create` 8、全量 lib 测试见下、`cargo fmt --check` 全树通过、vitest 34（workbench 用例补强后）。

## 第二轮对抗性复审（2026-09-16，独立子 agent 审 `a94b1055`）

复审总评「可合并」：P0 修复经攻击无新缺口、回归测试真钉住（把旧实现代回必红）、G2-03 判别力成立、四个 wire 测试时序无竞态、两个不采纳裁决均站得住（元组去重论证复核成立；未知-kind-only 降级附条件——未来若出现分页/截断式 configOptions 推送需翻案）。复审同时找出一处修正轮自身漏检与三处判据错位，本轮（`<修正提交 2>`）全部闭环：

| 级别 | 发现 | 处置 |
| --- | --- | --- |
| P1 | N1：dispatcher 全量数组分支经 `apply_config_options` 更新 model 后不清 pending——pending 生命周期第四条路径（首轮与修正轮两轮审核均漏检） | 已修：新增 `SessionInfo::apply_config_options_push` 统一消费（有界替换 + 刷新 + 数组携带可提取 model currentValue 时清 pending，判据与 apply_config_option_response 的 settled 同款 value-based）；补正反两例测试 |
| P2 | N2：快照路径 authoritative_current 用 presence（model 选项存在）而非 value（可提取 currentValue）判据 | 已修：改 value-based；补「选项存在但无 currentValue 时 pending 保留」负例 |
| P2 | N3：resolve_model_switch_target 的宣告 config id 提取用精确 `key=="model"`，与 control 层校验/诊断门的别名判据错位——别名键 + 宣告面时误发 `model_config_id_missing` 诊断 | 已修：提取判据改同款别名匹配；P56 路由特判（`api.route` 与 `key != "model"` 早退）保持精确键现状不变量不动；补别名键提取测试 |
| P2 | N4：单值 config_option_update 的 model 值走 `value_as_string`（含 name/label 兜底），显示名可进入 session.model，违反 P56/D2 machine-id-only 不变量 | 已修：model 分支改 `value_as_machine_id`（mode 等其余语义保持宽容提取）；补显示名拒绝 + machine id 消费两例 |
| P3 | N6：barrier 信号文件（ready/release）断言失败路径泄漏 | 已修：`SignalFiles` Drop guard |
| P3 | N9：models push 对显式空列表与「未携带」同待，push 通道不表达撤销 | 记录为契约：撤销宣告走快照路径（session/new/load），已在 D97-7 doc 补注 |
| P3 | N5/N7/N8 | 记录不修：别名门双向残缺口根治需按「选项身份」而非键名校验（后续 issue）；session/mod.rs 既有 p4/p5 测试的 trace 手动清理属他人域；configOptions 通道推送观测性可并入后续诊断增强 |

复审对 G2（pending 生命周期）给出「部分闭合 → N1」的严谨表述：交叉核对全部 `self.model =` 写点与 pending 清除点后确认生产代码共五条路径（快照、RPC 收敛、models push、单值 config push、全量 config push、usage meta），本轮后全部闭合。

第二轮修正后门禁：`session::model` 34、`dispatcher` 25（+2）、`session::create` 8、G2-03 绿、全量 lib **1088 passed / 0 failed**、`cargo fmt --check` 全树通过。

## 未解问题

- `model_pending` 目前仅内部可辨识（诊断日志 + 状态字段），未上 IPC wire；若 UI 需要
  显示「未确认」角标，需按 ADR-0004 的向后兼容规则补 wire 字段。同理，
  Clamped/Pending 结算事件如需 UI 可判定（而非 tracing 日志），也走同一路径。
- workbench singleton mirror 的前端整改（见偏差 2）。
- dispatcher 侧「旧 generation 的 models push 静默丢弃计数」属 routing 门控（#99
  文件域），当前只有 tracing 无计数器字段。

## 并行交集

- `session/mod.rs`：追加一行 `#[cfg(test)] mod` 注册 + 评审修正轮对既有 G2-03 测试的
  `with_active_agent` 单行修正（与 #98 的 `mod fork;` 注册同文件不同位置）。
- `create.rs`：仅 `plan_initial_model` 区段；`revive_session_slot`/`ensure_session_mapping`
  区段属 #99 在途重构，本 issue 提交未包含其 hunk。
- `dispatcher/mod.rs`：`apply_update_event_with_pet_policy` 的 SessionInfoUpdate/
  ConfigOptionUpdate 区段与 tests 尾部；`handle_permission_request`/
  `handle_session_update`/`start_notification_dispatcher` 区段属 #99，本 issue 提交
  未包含其 hunk。
