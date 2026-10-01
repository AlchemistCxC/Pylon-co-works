# Dev Record — #504 prompt_path_sink_methods_match_direct_pet_calls 毫秒竞态修复

> 入库保留。规格文档（spec）不保留，其目标、范围、方案与验收结论在此承接。
> 产出路径：`.agents/records/504-pet-wall-clock-flake.md`

## 元信息

- issue：#504（bug）
- 分支：`kumo/prometheus`
- 提交范围：`f34ca356..`（本记录所在 PR）
- 日期：2026-10-01

## 目标与范围

消除 #425 件6「sink ≡ 直呼」characterization 锁（`dispatcher::reactions::tests::prompt_path_sink_methods_match_direct_pet_calls`）在高负载下的毫秒竞态红灯：表征断言只锁行为面，墙钟类非确定性字段在比较前归零。

**不做什么**：不改 `apply`/`settle`/`visit` 等生产行为；不动 `dispatcher/mod.rs` 另外两处 `PetState::default()` 测试用法（核查无同款风险：一处单态 flush sink 无对比断言，一处同态 before/after 快照）；不处理跨午夜天变更级抖动（毫秒窗口内 `visit()` 两路必同值，不在 issue 尺度）。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src-tauri/pet-core/src/lib.rs` | `impl PetState`：`restore` 与 `apply` 之间新增 `zero_wall_clock_for_test` | 新增（测试专用 helper） |
| `src-tauri/src/dispatcher/reactions.rs` | `tests::prompt_path_sink_methods_match_direct_pet_calls` 的 `drive` 闭包 + 测试 doc 注释 | 修改（比较前归一化） |

## 方案要点

- **根因**：`PetState::default()` → `new_at(0)` 时间戳起点本为 0；非确定性来自 pet-core `apply` 内部取真实 `now_ms()` 写入——`settle()` 末尾 `last_tick_at_ms`、apply 顶部 `last_activity_at_ms`、`UserSent` 分支 `last_interaction_at_ms`。测试里 sink 路先 apply（T1）、直呼路后 apply（T2），跨毫秒边界即 Debug 全等必败。
- **helper 落 pet-core 而非测试侧**：`last_activity_at_ms` / `last_interaction_at_ms` 是私有字段，pylon crate 测试无法直接置 0；issue 修法建议第二选项（「在 PetState 上补测试用的规范化 helper」）即为此设计。lib crate 的 pub 项不触发 dead_code 告警，无需 cfg(test)（跨 crate 测试也用不上 cfg(test)）。
- **确定性面核查**（确认归零三字段即充分）：`PetTraits::default` 全 50 中性、`lines::pick` 为计数器轮换无随机、`RecentEvent` 纯枚举无时间戳、三个被测事件（PromptFailed/UserSent/PromptTimeout）路径无 `rand` 调用（仅 PromptCompleted 掉落有，不在被测面）。
- **只归零时间戳、不剔除字段**：保留 Debug 全量比较（含私有字段），仅把两侧墙钟字段拉平——行为面（mood/machine/stats/需求/msg/recent_events/xp/bond）比较强度不降。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| `cargo test -p pylon --lib dispatcher::reactions` 全绿 | ✅ 2 passed / 0 failed |
| 目标测试连续 ≥3 轮重跑无红灯 | ✅ 3 轮均 1 passed / 0 failed |
| `cargo test -p pylon-pet-core`（helper 落点 crate 自测） | ✅ 68 passed / 0 failed |
| `bun run check:clippy` 基线外零新增 | ✅ 全 crate `added: []`，exit 0 |
| `git diff` 仅含上列两文件 | ✅ |

## 测试处置

- `prompt_path_sink_methods_match_direct_pet_calls`：仅比较前对两侧调用 `zero_wall_clock_for_test()`，断言语义（「sink 位点必须与直呼 pet 函数行为全等」）不变；doc 注释补 #504 根因说明。
- 无新增/删除测试。

## 证据

- 测试：`dispatcher::reactions` 2 passed；目标测试 3 轮重跑均绿；`pylon-pet-core` 68 passed。
- clippy：`bun run check:clippy` 全 crate `added: []`（含 pet-core / pylon）。
- 说明书：无影响——测试内部确定性处置，`docs/说明书/` 无该测试行为表述（grep 核查）。

## 与 spec 的偏差

无。spec 预案（pet-core helper + 测试比较前归零）即最终落地形态。

## 未解问题

无。跨午夜天变更级抖动为已知理论残留（概率 ~10⁻¹¹ 量级、且需恰跨本地午夜），issue 未要求，未施工。

## 并行交集

`src-tauri/pet-core/src/lib.rs`（纯追加一个方法）、`src-tauri/src/dispatcher/reactions.rs`（测试函数）。不碰 `src-tauri/Cargo.toml`、前端、说明书。
