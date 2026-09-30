# Dev Record — #484 生产树卫生批（vendor 死副本 / msg_repo 死方法 / 演示面出树 / 死桥与别名清理）

## 元信息

- issue：#484（refactor/hygiene）
- 分支：`kumo/484-hygiene`（基于 main `df6cd864`；工作原落在共享链提交 `d4054745`，cherry-pick 为本分支 `ce68af08`）
- 提交范围：`df6cd864..a4dcd5a7` + 审查收尾提交（共享链上有等价内容提交，随共享分支另行合并）
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
| `bun run check:clippy`（基线外新增诊断） | ✅ 干净 worktree 复跑：6 crate `added: []`（pylon/pylon-core/pylon-acp/pylon-session/pylon-foundations/pet-core 全部 exit 0） |
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
- Rust 侧执行门禁时共享树先后被 #487（前端域）与 #488（`browser/agent_cmds.rs` E0277 等 Rust 在途）污染，全链 `check:rust`/`check:clippy` 在共享树无法收敛；单 crate 测试在共享树两次全绿（pylon-session 215/0、pylon 970/0），clippy 在干净 worktree 以独立 `CARGO_TARGET_DIR` 复跑完成 6 crate 基线比对（`added: []`）。CI 为最终全量门禁。
- PR：分支 `kumo/484-hygiene`（只含本批提交），CI 在干净环境复跑全量门禁作最终裁决。

## 审查轮（双子 agent：对抗式 + 残留扫描，2026-10-01）

两份独立审查一致结论：六项裁决本体成立、语义等价性经对抗核验（幂等/迟到写/tombstone 字段断言均实际执行，迟到写断言改走生产写路径后更强）、CI 六项全绿。findings 与处置：

- **[P1] SheetTabStrip 覆盖缺口无在案承接**（原指向的 Solid 化 issue #279 已关闭，`Closes #484` 后悬空）→ 登记 **#498** 承接。
- **[P1] `renderSheetTabStrip` 死导出**（SheetTabStrip.solid.tsx 挂载工厂，唯一消费者是被删 React 薄桥）→ 已删；连带修正「与 React 版逐行为同构」悬空注释。
- **[P1] Sidebar.css 模块区块「占位体型」死样式组**（`.sidebar-block-list/-row/-status/-switch/-metrics/-summary/-cta` 族，mockBlocks 配套，零生产消费者；外壳 `.sidebar-block-body` 族有 SettingsPreview/Sidebar 消费，保留）→ 已删；`Sidebar.blocks.css.test.ts` 字号同源断言的两选择器随删。
- **[P1] 维护地图仍写 `check:deps`** → 改 `check:immer`。
- **[P2] 注释/样例漂移**：msg_repo mod.rs 两处引用已删 `ensure_session_not_deleted`（改存在性 gate 口径）、del01 头注释第 4 条与 #110 F3 联动清扫断言矛盾（基线遗留，改正确口径）、msg_repo tests.rs 弱断言误导注释、code-stats SKILL.md 与 audit-maintenance.test.mts 的 mockBlocks/acp_transcript 样例（后者换 `src-tauri/tests/integration.rs`——vendor 分支已无源码样例可指）→ 全部清理。
- **[P2] 跨 React 大版本共存回归保护随别名删除而消失** → 接受（PR 已声明收窄）；bun.lock 的 scheduler 收敛 0.23.2→0.27.0 属正常锁解析。

验证：`Sidebar.blocks.css.test.ts` + `audit-maintenance.test.mts` 25/25 绿（worktree）。
