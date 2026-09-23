# Dev Record — #245 后端 src 根散落文件归类

## 元信息

- issue：[#245](https://github.com/AlchemistCxC/Pylon-co-works/issues/245) refactor(host)
- 分支：`Ru5t/host-src-regroup`（自 `github/main@1d4c8ca3` 新开；`Ru5t/Reflector` 与 `Ru5t/renderer-memory-probe` 均压有未合并工作，本次重构需要干净 diff）
- 提交范围：`6d9baa9f..eb244772`（4 笔：L.md 声明 / src 归类 / 死文件清理 / docs 同步）
- 日期：2026-09-22

## 目标与范围

用户原话：「重构下后端的文件系统，有很多散落文件，和疑似错误归类的散落文件，归类下」。

**做什么**：`src-tauri/src/` 根目录 40 个平铺文件中，9 个功能家族的成员归入专业子目录（维护地图「专业子目录优先归属」规则的落地）；挂 crate 根的兄弟测试模块就近归属；`src-tauri/` 根死文件处置。纯 `git mv` + 模块声明与 `crate::` 路径修正，**零行为变更**。

**不做什么**：不动 `test_harness.rs`/`test_utils.rs`（ADR-0005 门面，`tests/` 以 `prism_desktop_lib::test_harness` 消费、31 文件引用 `test_utils`，移动属外部 API 变更，收益不抵风险）；不合并/拆分任何实现内容；不动前端与 pylon-\* 子 crate；不删 `winds.c`（归档留裁决）。

## 改动清单

| 新位置 | 旧名 | 性质 |
| --- | --- | --- |
| `browser/{mod,cmds,bridge,agent_cmds}.rs`、`browser/agent/` | `browser.rs`、`browser_cmds.rs`、`browser_bridge.rs`、`browser_agent_cmds.rs`、`browser_agent/` | 重命名 |
| `gateway/cmds.rs` | `gateway_cmds.rs` | 重命名 |
| `hermes/{mod,runtime}.rs` | `hermes.rs`、`hermes_runtime.rs` | 重命名 |
| `mcp/{mod.rs,mcp_persist_tests.rs}` | `mcp.rs`、`mcp_persist_tests.rs` | 重命名 |
| `pet/{mod,cmds}.rs` | `pet.rs`、`pet_cmds.rs` | 重命名 |
| `prism/{mod,cmds}.rs` | `prism.rs`、`prism_cmds.rs` | 重命名 |
| `workspaces/{mod,cmds}.rs` | `workspaces.rs`、`workspace_cmds.rs` | 重命名 |
| `agent/{mod,detection,runtime}.rs` | `agent_detection.rs`、`agent_runtime.rs`（mod.rs 新增） | 重命名+新增 |
| `session/{store,session_info_tests,session_expiry_platform_tests}.rs` | `session_store.rs`、`session_info_tests.rs`、`session_expiry_platform_tests.rs` | 重命名 |
| `runtime_log/{mod,cmds}.rs` | `runtime_log.rs`、`logs_cmds.rs` | 重命名 |
| `acp/{p1_wire_regression_tests,real_acp_smoke}.rs` | 同名根文件 | 重命名 |
| `tools/winds.c` | `src-tauri/winds.c` | 重命名+头注释 |
| （删除）`src-tauri/config-template.rs` | 同名 | 删除 |

内容级改动仅四类：① lib.rs 模块声明块重写（顺带清掉一处重复 `#[cfg(test)]`）；② `crate::X` → `crate::<family>::<member>` 全 crate 机械重写（含 tests/、vendor/，先长后短避免 `browser_agent` ⊂ `browser_agent_cmds`、`pet` ⊂ `pet_cmds` 前缀误伤）与少量裸路径修正；③ 4 个搬家测试文件 `use super::*` → `use crate::*`（同名集合，零语义漂移）；④ 各家族 mod.rs / 新 agent/mod.rs 的子模块声明与注释。

## 方案要点

- **可见性镜像**：crate 根私有 `mod X`（crate 级可见）迁入子目录后升 `pub(crate)`；`pub mod browser_bridge` 的对外可见经 lib.rs `pub mod browser` + `browser/mod.rs` `pub mod bridge` 镜像。外部消费面核实为零（`tests/` 仅用 `prism_desktop_lib::test_harness`），对外路径变化无实际影响。
- **测试 filter 兼容**：搬家的测试模块一律保持原 basename，`cargo test --lib p1_wire`、`real_acp`、`mcp_persist` 等既有命令与文档表述不失效。
- **排除的疑似错误归类**：`src/agent_detection.rs` 与 `pylon-core/src/agent_detection.rs` 是有意分层（GUI 有状态适配 vs 纯探测库，文件头有说明），非错置，未动。
- **审计脚本零改动**：`audit-maintenance.mts` 按「最长前缀优先」匹配，`src-tauri/src/` 新子目录自动落 `rust-host`；`.c` 不在 maintained source 扩展名内，`tools/winds.c` 不被扫描。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| `cargo test --workspace --lib` | ✅ 1113 passed / 0 failed / 4 ignored（首跑 116 失败均为 `pylon-fake-agent` 桩未构建的环境原因，按提示构建后全绿） |
| `cargo test --workspace --tests --features test-agent` | ✅ 全目标合计 1442 passed / 0 failed |
| `cargo fmt --all --check` | ✅ 干净（dispatcher/mod.rs 一处路径加长后行超限，已单文件格式化） |
| `bun run check:maintenance` | ✅ exit 0，无 unmapped |
| `bun run check:docs` | ✅ exit 0 |
| 根目录 `.rs` 40 → | ✅ 16（lib/main + 12 单一横切职责 + test_harness/test_utils 门面） |
| diff 无实现逻辑变更 | ✅ 56 文件 303+/299−，逐类核对（见提交 1f46c33f） |

## 测试处置

无新增、无修改、无删除。5 个搬家测试文件内容仅 glob 导入一行（`use super::*` → `use crate::*`）。

## 证据

- commit：`1f46c33f`（归类主体，54 文件，34 组 rename 全部被 git 识别为 94–100% 相似）、`33ff8dda`（死文件清理）、`eb244772`（docs 同步）、`6d9baa9f`（L.md 声明）
- 测试：`cargo test --workspace --lib` → `test result: ok. 1113 passed; 0 failed`；`--tests --features test-agent` → 合计 1442 passed / 0 failed；两道 bun 门禁 exit 0
- 手工验证：`cargo check --workspace --all-targets` 零 error 零新增 warning（6 个 dead_code warning 为 test_harness/test_utils 在该 feature 组合下的既有状态，非本次引入）

## 与 spec 的偏差

- 提交时发现暂存区混入仓库主在共享工作树上对 `correlation.rs` 文件头两行注释的直接改动（移除 OBS-02/方案书 §5.2 不可追溯指向），经其确认随 `1f46c33f` 搭车，已在提交信息中标注来源。
- 本地顺带删除未跟踪残留 `src-tauri/cargo-test{,-norun}.log`（2026-08-16，`.gitignore` 已覆盖）——spec 中的计划项，不入库。

## 未解问题

- `tools/winds.c` 的最终去留由仓库主裁决（已归档 + 注释，MSVC/CI 均不引用）。
- `lib.rs` 根仍存的「方案书 §N」「OBS-NN」式不可追溯注释指向在本仓后端普遍存在，本次未扩 scope 清理；可另行立项。

## 并行交集

- 本支工作期间观察到 `package.json`/`bun.lock` 出现 `@tanstack/solid-virtual` 在途改动（#243 域，非本 issue 产物），未 stage、未提交、未回退。
- 本支全程 `pathspec` 提交；触碰文件域 = `src-tauri/src/**`（约 56 文件）、`src-tauri/{config-template.rs,winds.c}`、`src-tauri/tools/`（新增）、`docs/说明书/{Pylon-项目架构参考,Pylon-插件化前后端拓扑全图}.md`、`.agents/{L.md,records/}`。
