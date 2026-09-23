# Dev Record — #261 评估修复批次（注释漂移 / session 去重 / prompt 终态臂拆分 / spawn_blocking）

> 入库保留。规格文档（spec）不保留，其目标、范围、方案与验收结论在此承接。

## 元信息

- issue：https://github.com/AlchemistCxC/Pylon-co-works/issues/261
- 分支：`kumo/prometheus`（堆叠于 PR #257）
- 提交范围：`f6a7ea16..0ba940ad`（代码提交 `3e133027` 注释漂移 / `ccd1e5e4` 去重 / `f909d1a8` prompt 拆分 / `0ba940ad` spawn_blocking）
- 日期：2026-09-23
- 并行协调：全程绕开 #260 在途文件域（lifecycle/mod.rs、identityStore.ts、pylon-acp/**、Cargo.lock、hook_bridge、批次 C/D 前端文件）；对方批次 A~D 期间收工合流，双方零冲突

## 目标与范围

用户原话：「不碰前端中控区，不碰预设系统，把子agent提到的问题先调查清楚，然后在不影响契约与行为的情况下解决掉」。问题来源为 2026-09-23 全仓代码质量评估（三路深读 + 静态扫描），本卡先逐项实地复核（全部证实，其中两处子 agent 判断需修正，见「方案要点」），再以等价变换修复可安全解决的部分。

不做：theme 域撕裂归位（涉预设邻接结构重构，另行立卡）；property test 补齐（Cargo.lock 在 #260 批次 A 域，本轮不加依赖）；store.ts:347 强转链收紧、AgentRuntimePanel 拆分、obs04~07/css01 目录改名；lifecycle/mod.rs:14 与 identityStore.ts 的注释修正（当时在 #260 文件域内，待其合入后顺手清——#260 已于本卡期间收工，随时可清）。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src-tauri/src/gateway/mod.rs` | `is_platform_source` doc：指向 `session/expiry.rs` 真实入口，删已不存在的 `session.rs:618-623`/「闭包」表述 | 修改（仅注释） |
| `src-tauri/src/agent/runtime.rs` | `SessionSlotPolicy` doc 消费方 `session.rs` → `session/create.rs` | 修改（仅注释） |
| `src-tauri/src/session/create.rs` | E4 语义指针 → pylon-core `agent_config/types.rs` McpServersMode doc；`option_identity` 内联归一化 → `loose_normalized_key`；`option_choices` 递归 walk → 共享 `collect_config_choice_values` | 修改 |
| `src-tauri/src/session/fork.rs` | `session_fork` runtime 反向扫描处补契约豁免说明（owner.rs OWNER-02 相悖点） | 修改（仅注释） |
| `src-tauri/src/mcp/mod.rs` | 「差异适配表」指针 → pylon-acp `error.rs` | 修改（仅注释） |
| `src-tauri/src/gateway/credentials.rs` | `ISUUE-12` → `ISSUE-12` | 修改（仅注释） |
| `src-tauri/src/session/model.rs` | 删 `apply_session_response` 内联 usage 双写；新增 `loose_normalized_key`/`collect_config_choice_values`（pub(crate)）；`config_option_current_value_with` 归一化收敛；`config_option_choice_ids` 改走共享骨架 | 修改 |
| `src-tauri/src/session/persist.rs` | 新增 `rollback_load_slot_else`；五处 `restore_previous_slot(...)? + return` 样板收敛 | 修改 |
| `src-tauri/src/gateway/qq/mod.rs` | 新增 `dead_target_gate`（单锁判定+过期清除）；deliver_text/send_loop 两处 guard 收敛 | 修改 |
| `src-tauri/src/session/prompt.rs` | `send_prompt_core_impl` 按 `PromptWaitOutcome` 三终态臂提取 `settle_prompt_response` / `settle_prompt_connection_closed` / `settle_prompt_cancelled_after_timeout` | 修改 |
| `src-tauri/src/plugin_cmds/transaction.rs` | install/stage/stage_commit/stage_abort/set_enabled/rollback/uninstall 七命令的同步 `*_at` 段经 `spawn_blocking` 执行 | 修改 |
| `src/runtimeStore.ts`、`src/store.ts`、`src/workspaceStore.ts` | persist 域过期主张修正；「阶段 1」考古标签摘除 | 修改（仅注释） |

## 方案要点

**调查阶段的两个修正**（子 agent 报告 → 实地核实后的结论）：

1. 归一化「双轨」实为**两组语义**：`normalized_token`（trim + `-`/空格/`.`→`_`）与 create.rs/model.rs 内联版（`-`/空格→`_`，无 trim 无 dot）。wire 键含 `.` 时两组判定不同（`config.id` 前者匹配 `config_id` 后者不匹配）——**不能合并**，只能各自组内收敛。故新增 `loose_normalized_key` 收敛两个内联点，`normalized_token` 保持独立。
2. qq 死目标模式实为 **2 处 guard 型**（deliver_text / send_loop）+ 若干成功路径裸 remove（后者非重复样板）；且 guard 的 warn 日志消费 `entry.0`（标记原因），收敛时 helper 返回 `Option<String>`（Some=仍死携带原因）才能逐字保留日志。

**等价性论证要点**：

- **usage 双写消除**：内联块与 `session_state.rs::capture_usage` 提取链逐字相同（`usage`→`sessionInfo.usage`→clone→`usage_snapshot`），且 `apply_session_response` 尾部必调 `capture_session_state`；中间无人读该字段（`determine_model_surface`/`response_models_state` 不读）。删内联块终态相同。
- **option walk 共享**：两轨候选键集合一致、仅 `enum`/`items` 迭代序不同；宽容轨收集后 `sort()+dedup()` 故键序对输出无影响，统一取 machine-id 轨键序对两侧逐字节等价。提取函数参数化（`response_string` vs `value_as_machine_id`），去重策略留各自调用点（排序去重 vs 保序去重——machine-id 轨改「先收集后保序去重」，与原 walk 内 seen 检查输出逐一相同）。
- **persist 回滚收敛**：`rollback_load_slot_else` 保留原 `?` 传播序（回滚自身失败优先于原错误上抛），站点 1（带 clone 与专用日志的 replay-reject 臂）保持原样。
- **qq 单锁化**：毒锁/无条目 → 放行（与原 `.ok().and_then` None 行为一致）；过期清除与判定在同一锁内，TOCTOU 窗口消失（原后果仅多一次探测发送，无契约影响）。
- **prompt 拆分**：三函数体逐行搬移（含全部决策注释），仅两处机械适配——`&turn_key` 局部取址改参数直传、`protocol.prompt_timeout()` 在调用点求值为 `configured_prompt_timeout_secs: u64` 传入。参数多（15 参）系 variant 载荷逐一传递，clippy allow 带理由注释（先例：dispatcher `reject_interaction_request`）。
- **spawn_blocking**：写锁仍在 async 侧（互斥语义不变），仅把 `*_at` 同步 fs 段移入阻塞池；join 失败 expect 保留 panic 语义（原 panic 在命令内）。versions/list 只读小 IO 未包（记录为有意收窄）。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| 既有行为测试全绿且未被修改 | ✓ 零测试文件改动 |
| `cargo test --workspace --lib` | ✓ 9 二进制共 **1,337 passed / 0 failed / 4 ignored**（pylon 805、pylon-acp 141、pylon-session 61、pylon-core 118、pet-core 151、pylon-compute 36、pylon-foundations 16、canonical-types 9、pylon-markdown 0） |
| 集成测试（`--features test-agent`，golden-traces/auto_reconnect/b11_inject 端到端走 prompt 路径） | ✓ **27 passed / 0 failed**（exit 0） |
| vitest 全量 | ✓ **Test Files 626 passed / 1 skipped；Tests 4,712 passed / 0 failed / 1 skipped / 1 todo** |
| rustfmt（仅本卡文件，不跑 `--all` 以免触碰并行在途文件） | ✓ FMT-CLEAN |
| 日志文案/级别/字段零变化 | ✓（qq 短路 warn 的 reason 由 helper 返回值供给，文案逐字保留） |
| prompt.rs 主体缩短、三臂独立成函数 | ✓（+300/−216：三函数带职责注释；match 处从 ~230 行缩至 ~60 行调用） |
| 零白名单豁免新增 | ✓ |

## 测试处置

无。全部既有测试原样通过；未新增测试（本批为等价重构，行为锁由既有内联测试 + in-lib golden trace + parity corpus + 集成 harness 承担）。

## 证据

- `cargo test --workspace --lib`：`test result: ok. 805/141/9/36/118/61/16/0/151 passed; 0 failed`（9 个二进制，EXIT=0）
- `bun run test`：`Test Files 626 passed | 1 skipped (627)`、`Tests 4712 passed | 0 failed | 1 skipped | 1 todo (4714)`
- `rustfmt --edition 2021 --check`（本卡 11 文件）：无输出
- 集成：`cargo test --test integration --features test-agent` → `test result: ok. 27 passed; 0 failed`（EXIT=0）

## 遗留

1. lifecycle/mod.rs:14（R9 表 `session.rs` 指针）与 identityStore.ts「阶段 1」标签——#260 已收工合流，可随手清（小改动，未挤入本卡避免域交叠）。
2. theme 域撕裂（`ThemeSettings` 真源在根级 store.ts，5 个 domain 文件 `import type` 反向引用）——建议立 refactor 卡做归位。
3. property test 缺口：dev-standards #220「property test 靠宿主原生单测」目前是愿景（全仓无 proptest/quickcheck）；建议 std-only 随机化测试或引 dev-dep，另行决策。
4. `versions`/`list_installed` 只读 fs 仍在 async 线程（量小，有意不包）。
