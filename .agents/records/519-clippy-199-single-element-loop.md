# Dev Record — #519 clippy 1.99 stable 破门禁（single_element_loop）修复

> 入库保留。规格文档（spec）不保留，其目标、范围、方案与验收结论在此承接。
> 产出路径：`.agents/records/519-clippy-199-single-element-loop.md`

## 元信息

- issue：#519（bug）
- 分支：`kumo/prometheus`（#517）；同一修复同步至 `kumo/321-persistence-adr`（#516）、`kumo/498-sheet-tab-solid-tests`（#518）两分支
- 提交范围：`f34ca356..`（本记录所在 PR）
- 日期：2026-10-02

## 目标与范围

恢复 clippy 门禁绿：`dtolnay/rust-toolchain@stable` 升级到 **1.99.0（2026-09-28）**后 `clippy::single_element_loop` 收入默认集，main 存量 `src-tauri/pylon-core/src/hermes/runtime.rs` 的单元素数组循环被判新指纹；CI 为 `pull_request` 触发（评 main+branch merge commit），**main 红 → #516/#517/#518 三个 PR 连坐全红**。

**不做什么**：不更新基线（真阳性 lint，按建议展开是正解，非历史诊断豁免）；不动 ci.yml 工具链策略（stable 通道滚动是既定决策，无版本 pin）；不改运行行为。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src-tauri/pylon-core/src/hermes/runtime.rs` | `select_and_probe`：`for key in [HERMES_GIT_BASH_PATH_ENV]` 展开为直取 + 注释（#519 说明） | 修改（行为等价） |

## 方案要点

- **复现**：本地 `rustup update stable` 到 1.99.0 后单条诊断必现；1.98.1 不复现（lint 未入默认集）——版本差异即根因，排除本地/CI 参数差异（两边同为 `cargo clippy --workspace --all-targets --message-format=json`）。
- **展开而非 allow/入基线**：`key` 为 `&'static str`（Copy），展开无语义与 drop 时序差异；循环体只执行一次。注释留「将来多键需求时以显式键表重建」的口径，防后来者误读为遗漏。
- **三分支同步**：三个 PR 全被 main 连坐，修复须同时进三条分支才能使 CI 立即转绿；#516/#518 分支以 `git worktree` 隔离 cherry-pick 同一提交，不切共享树工作区、不碰他人在途文件。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| 本地 1.99.0 复现原红（修复前） | ✅ pylon-core `single_element_loop` 必现 |
| 修复后单 crate clippy 零告警 | ✅ pylon-core 0 warning / 0 error |
| 全量 `bun run check:clippy`（1.99.0） | ✅ 全 crate `added: []`，await-holding 通过，exit 0 |
| `cargo test -p pylon-core`（行为不变） | ✅ 137 passed / 0 failed |
| #517 CI clippy job 转绿 | ✅ pass 8m24s（run 36896359120） |
| #516/#518 CI clippy job 转绿 | ✅ #516 pass 9m35s、#518 pass 8m53s（cherry-pick 后各自 run） |
| #516/#518 全门禁 | ✅ 均 6/6 绿 |

> #517 同 run 的前端三项红**非本 issue 面**：为分支上在途 #515 批 0/批 0.5（`kumo/prometheus` 上 2026-10-02 00:29 提交的 zustand→Solid 就地置换）的进行中遗留（`src/host/reactStoreShim.ts` 2 条死 eslint-disable 指令 + vitest 4 用例：shim 会话切换不重置、defaultPresets 重置主题 3 条），归 #515 施工域，本记录不处置（已在 PR #517 留诊断评论）。

## 测试处置

无（单元素循环展开为行为等价重构，既有测试即回归面：pylon-core 137 项覆盖 `select_and_probe` 的 hermes 运行时选择链）。

## 证据

- 复现：`rustup update stable` 至 1.99.0 后 `cargo clippy -p pylon-core --all-targets` 输出 `single_element_loop`（含官方展开建议）；1.98.1 同命令零告警（对照）。
- 门禁：`bun run check:clippy` 全 crate `added: []`（1.99.0 工具链）。
- 测试：`cargo test -p pylon-core` 137 passed。
- CI 原始红：run `36890052887` job `110463086684`（#517）、run `36887448059` job `110454259904`（#516）、run `36890971137` job `110466202272`（#518），同一指纹 `pylon-core | clippy::single_element_loop | src-tauri/pylon-core/src/hermes/runtime.rs`。

## 与 spec 的偏差

无 spec（hotfix 路径，未单独立 spec——改动一处、根因单一、验收即门禁本身）。

## 未解问题

- 工具链走上游 stable 通道，未来 stable 升级仍可能再引入新 lint 破门禁。治本选项（pin 版本 / 定期预检）超出本 issue 范围，留待仓库决策。
- `git worktree` 同步的分支提交与他主分支最终合并时的重复提交：内容相同、SHA 不同，合并无冲突（同 patch），但会在历史里留一份冗余。

## 并行交集

`src-tauri/pylon-core/src/hermes/runtime.rs`（仅此一处生产改动）。`kumo/321-persistence-adr` 与 `kumo/498-sheet-tab-solid-tests` 两远程分支各追加同一修复提交（cherry-pick，不含本记录）。
