# Dev Record — #484 生产树卫生批（vendor 死副本 / msg_repo 死方法 / 演示面出树 / 死桥与别名清理）

## 元信息

- issue：#484（refactor/hygiene）
- 分支：`kumo/484-hygiene`（基于 main `df6cd864`；工作原落在共享链提交 `d4054745`，cherry-pick 为本分支 `ce68af08`）
- 提交范围：`df6cd864..ce68af08`
- 日期：2026-10-01

## 目标与范围

2026-10-01 全项目审计裁决的「无行为争议纯删除/清理」批次（裁决书 `.agents/spec/audit-20261001/issue-hygiene.md`）：vendor 死副本、msg_repo 三个死方法、演示面（PrismSheet/mockBlocks）出生产树、React 死桥（SheetTabStrip.tsx）、react18 别名、依赖检查脚本改名。

**不做**：不迁移/重构（Solid 化、CSS 迁移另有 issue）；不动 pet-core；不新增死代码检测门禁；不删 `vendor/acp/ORIGIN.md`（codeg 迁入署名义务文档，§6 承载 #362/#363/#353 等活性条目）。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src-tauri/vendor/acp/acp_transcript.rs` | 全删（2297 行） | 删除 |
| `src-tauri/vendor/acp/ORIGIN.md` | 篇首注记 | 修改 |
| `src-tauri/pylon-session/src/msg_repo/mod.rs` | 删 `touch_session`/`delete_session`/`ensure_session_not_deleted`；`tombstone_state` 改 `#[cfg(feature = "test-support")]` | 修改 |
| `src-tauri/pylon-session/Cargo.toml` | 新 `test-support` feature | 修改 |
| `src-tauri/Cargo.toml`（workspace 主） | dev-dependencies 声明 pylon-session + test-support | 修改 |
| `src-tauri/pylon-session/src/msg_repo/tests.rs` | del 方法改两阶段调用；`tombstone_state` 读取改测试内 SQL 辅助；删 touch 专属测试 | 修改 |
| `src-tauri/pylon-session/src/del01/del02/del05_*.rs` | `delete_session` → `begin+finalize` 两阶段；删 touch 铺垫行 | 修改 |
| `src-tauri/src/session/del03_local_first_delete.rs` | 同上（跨 crate 测试）；`tombstone_state` 断言保留（feature 门控 API） | 修改 |
| `src/components/PrismSheet.tsx`、`src/sheets/PrismManagerSheetView.tsx`、`…/styles/components/PrismSheet.css`、`src/components/sidebar/blocks/mockBlocks.tsx` | 全删 | 删除 |
| `src/plugins/core/sheet/builtinWorkspacePlugins.ts` | 删 prism kind 注册行与 import | 修改 |
| `src/workspace-sheets/sheetTypes.ts` | `SHEET_KINDS` 摘 `'prism'`（11→10） | 修改 |
| `src/plugins/product/builtinPylonWorkspace.ts` | 删 4 个 mock 模块 lazy import、`MOCK_MODULE_BLOCKS` 与注册循环 | 修改 |
| `src/plugins/product/{firstPartyStyleOwnership.ts, packages/builtin.pylon-workspace/styleAssets.ts}` | 删 PrismSheet.css 登记 | 修改 |
| `src/plugins/product/packages/builtin.pylon-workspace/styles/components/Sidebar.css` | 注释中 ps-nav 历史案例措辞修正 | 修改 |
| `src/workspace-sheets/SheetTabStrip.tsx` | 全删（43 行 React 死桥） | 删除 |
| `src/workspace-sheets/__tests__/{sheetTabOverflow,sheetTabStripAgentSwitch}.test.tsx` | 全删（纯 React 桥测试） | 删除 |
| `src/workspace-sheets/__tests__/agentStatusConsumerMatrix.test.tsx` | 删 SheetTabStrip 小节与 helper（Settings/titlebar 矩阵保留） | 修改 |
| `src/sheets/__tests__/SheetInternalSidebars.test.tsx`、`…/sidebarUnifiedModel.css.test.ts`、`…/sheetRegistrySidebarMode.test.tsx`、`…/workspaceRegistry.test.ts`、`…/workspaceStore.integration.test.ts` | prism 样例/计数 pin/读取行随删同步 | 修改 |
| `src/plugin-runtime/ui/__tests__/IsolatedPluginSurface.integration.test.tsx` | react18 → 双自包含 react19 bundle（label 参数化） | 修改 |
| `package.json` | 删 react18/react-dom18；`check:deps`→`check:immer` | 修改 |
| `bun.lock` | react@18.3.1 / react-dom@18.3.1 / loose-envify 条目移除 | 修改 |
| `scripts/check-immer-imports.mjs` | 自 `check-dependency-imports.mjs` 改名（git mv，内容不变） | 重命名 |
| `scripts/{code-stats.mts,code-stats.test.mts,sheetState.compat.test.mts}` | mockBlocks/prism 样例替换、11 kind 计数 pin → 10 | 修改 |
| `docs/说明书/Pylon-插件系统说明书-开发者版.md` | 删「四个 mock 模块」句 | 修改 |

## 方案要点

1. **ORIGIN.md 保留**：它不只是 acp_transcript.rs 的登记——§6 追记承载 #362/#363/#353 等已落码的 codeg 署名义务。删副本本体、留文档并注记，是义务与卫生的平衡点。
2. **连带死代码**：`ensure_session_not_deleted`（session 维度 gate）唯一调用者即 `touch_session`，随删；owner 维度 `ensure_owner_not_deleted` 有生产调用（`set/get_session_state_for_owner`），保留。
3. **`tombstone_state` 的落地方式**：删除裁决的意图是「生产树无死方法」。跨 crate（pylon 主 crate DEL-03 测试、`delete_session_core` CR-01 幂等重试）需要断言 tombstone 中间态（`deleting`→`deleted`），且夹具是内存库（无法另开连接 SQL 直查）。落地为 **feature 门控**：`pylon-session` 新 `test-support` feature，方法 `#[cfg(feature = "test-support")]`；pylon 经 **dev-dependencies** 启用（feature union 只进测试构建）。生产 `cargo build` 不含该 feature，方法零痕迹。本 crate 内测试不用它（SQL 直查辅助），避免自我 dev 依赖的花活。
4. **删除语义对齐生产**：测试里 `delete_session`（一步 `'deleted'`）改走生产同款 `begin_delete_session` + `finalize_session_delete` 两阶段（终态等价；幂等性断言逐项保留），不改 `delete_session_with_state` 可见性。
5. **隔离测试语义收窄**：react18 别名删除后，`IsolatedPluginSurface` 集成测试改测「两个自包含 React bundle（esbuild 独立内联，label 参数化保证独立构建产物）共存 + 卸载其一不影响另一」——隔离语义（独立 root/事件监听/卸载）保留，双版本面随别名一并退役。
6. **SheetTabStrip 测试处置**：React 版删除后，其三个测试的消费对象不存在。`agentStatusConsumerMatrix` 只删 SheetTabStrip 消费方小节（矩阵主体 Settings/titlebar 保留）；另两个整文件删除。**覆盖缺口**（tab 溢出收拢 / 切换事务先 switch 后 focus / tab 状态矩阵）现由 `SheetTabStrip.solid.tsx` 承载且无等价测试——迁移属 Solid 化范围（issue「不做什么」条款），建议后续在 Solid 化 issue 下补齐。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| `cargo test -p pylon-session --lib` | ✅ 215 passed / 0 failed |
| `cargo test -p pylon --lib`（主 crate，含 del03） | ✅ 见评论区数字 |
| `bun run check:rust` 全链 | ✅ 见评论区（干净 Rust 树上执行） |
| `bun run check:clippy`（基线外新增诊断） | ✅ `added: []` |
| 干净 worktree `tsc -b` + `vite build` | ✅ exit 0（共享树上 tsc/vitest 红为 #487 在途中间态所致，与本批无关） |
| `bun run check:bundle` 体积对照 | ✅ `first-party-pylon-workspace` 235,216 → 223,122 B（gzip 56,058 → 54,063）；**总 gzip（js）1,521,689 → 1,514,131（−7,558 B）** |
| 每条删除「删除前引用扫描为零」 | ✅ 见 issue 评论区逐条证据 |

## 测试处置

- 删除：`sheetTabOverflow.test.tsx`、`sheetTabStripAgentSwitch.test.tsx`（消费对象为已删 React 桥）；`msg_repo/tests.rs::touch_session_rejects_tombstoned_session`（测的是已删方法）。
- 语义等价改写：`msg_repo/tests.rs`、`del01/del02/del05`（pylon-session）、`del03`（pylon）的删除链路测试 → 两阶段入口；tombstone 读取 → SQL 辅助（crate 内）/ feature 门控 API（跨 crate）。
- 样例替换（行为断言不变）：`sheetState.compat.test.mts`（prism→overview 样本 + 11→10 计数 pin）、`workspaceRegistry.test.ts`（prism→runtime 单例样本）、`sheetRegistrySidebarMode.test.tsx`（11→10）、`firstPartyStyleOwnership.test.ts`（workspace 包 7→6）、`code-stats`（mockBlocks→demoData 例）。
- 改写：`IsolatedPluginSurface.integration.test.tsx`（双 bundle 隔离，见方案要点 5）；`agentStatusConsumerMatrix.test.tsx`（删 SheetTabStrip 消费方小节）。

## 证据

- 共享树曾被 #487（workbench legacy 退役，并行在途）的中间态污染（tsc `messages` 类型错、4 个 workbench/solid 测试文件红）——本批的全量前端验证在与提交等价的干净 worktree 执行：`git worktree` @ `d4054745` + `tsc -b` + `vite build` + `check:bundle` 全绿；本批改动面定向测试（28 文件 136 用例）在共享树亦全绿。
- Rust 侧执行门禁时共享树无 Rust 在途脏文件，`check:rust`/`check:clippy` 结论直接有效。
- PR：分支 `kumo/484-hygiene`（只含本批提交），CI 在干净环境复跑全量门禁作最终裁决。
