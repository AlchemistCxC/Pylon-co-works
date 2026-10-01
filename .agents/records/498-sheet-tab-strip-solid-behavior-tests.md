# Dev Record — #498 SheetTabStrip.solid 行为测试补齐（溢出收拢 / 切换事务 / tab 状态矩阵）

## 元信息

- issue：#498（refactor）
- 分支：`kumo/prometheus`
- 提交范围：本分支增量提交（基于 `7222f233`）
- 日期：2026-10-01

## 目标与范围

#484 生产树卫生批删除 React 死桥 `SheetTabStrip.tsx` 及其三个测试文件后，`SheetTabStrip.solid.tsx` 承载的三块行为语义（溢出收拢 / 聚焦切换事务 / tab 状态矩阵）无门禁拦截。本批用 `@solidjs/testing-library` 补齐等价测试，mock 布线复用 `tauriCoreMock`/`resetStores` 现有 harness。

**不做**（issue 条款）：不改 `SheetTabStrip.solid.tsx` 生产行为；不重复 `agentStatusConsumerMatrix.test.tsx` 保留的 Settings/titlebar 矩阵。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src/workspace-sheets/__tests__/sheetTabOverflow.solid.test.tsx` | 新增 5 用例：量不到宽度全渲染 / 收拢进「···」选单（选单列全部、点击聚焦后收起）/ 活动页签平移进窗口 / 变宽恢复 / Escape 关闭 | 新增 |
| `src/workspace-sheets/__tests__/sheetTabStripAgentSwitch.solid.test.tsx` | 新增 4 用例：switch 成功后才 focus（中途 disabled+aria-busy）/ 失败不 focus 保持原 active（且切换态复位不卡 disabled）/ active sheet 直接 focus 不重复 switch / 键盘移动同契约 | 新增 |
| `src/workspace-sheets/__tests__/sheetTabStripStatusMatrix.solid.test.tsx` | 新增 4 用例：active 无快照 → unknown（无假绿 connected/disconnected）/ 挂载时已有快照 → connected / 挂载后快照到达 → 同步级联 connected / 非 active 有快照 → inactive | 新增 |
| `vitest.setup.ts` | console.error 白名单：删已随 #484 失效的 `sheetTabStripAgentSwitch.test.tsx` 条目，换为 `.solid` 新文件条目（A 类错误路径契约注释） | 修改 |

## 方案要点

1. **文件落位与 vitest 分组**：`*.solid.test.tsx` 后缀 + `// @vitest-environment jsdom` pragma → `vitest.config.ts` 的 solid-dom 项目（solid 编译 JSX）；`tsconfig.solid.json` 已覆盖该路径，`check:solid` 的 tsc 直接受管。状态矩阵不回填 `agentStatusConsumerMatrix.test.tsx`——该文件属 react-dom 组（React 编译 JSX），无法渲染 Solid 组件。
2. **Solid 时序语义**：信号同步传播、无批处理——溢出/状态矩阵断言全部同步；switch 异步链用 `waitFor`。原 React 版的 `act()` 包装不需要（Solid 无双阶段渲染）。
3. **「同帧」的落实**：矩阵用例「快照挂载后到达」用测试侧 `createSignal` 驱动 `latest()` 投喂（生产中 titlebar 即经此闭包投喂运行时快照流），断言 `setStatuses` 后当帧 `data-agent-state` 翻转——比原 React 版（只测挂载时带快照）更贴「快照到达」语义。
4. **等价之上的顺带强化**（均在原契约语句内，无新契约）：切换中 `aria-busy`/disabled；失败后 `setSwitchingSheetId(null)` 复位（页签不永久卡 disabled）；矩阵尾部一条 `selectAgentStatus` 裁决自检。
5. **测试设施差异**：`@solidjs/testing-library` 无自动 cleanup（vitest globals 关闭，solid-testing-library 的 global afterEach 钩子不生效）→ 每文件 `afterEach(cleanup)`；ResizeObserver/scrollIntoView 垫片已在 `vitest.setup.ts` 全局提供，不再按文件 stub。
6. **白名单换行而非追加**：`EXPECTED_CONSOLE_ERROR_FILES` 按 endsWith 匹配，旧条目匹配不到 `.solid` 新文件；旧 React 文件已删、条目失效，直接替换（白名单回收方向：只减不增）。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| 三个新文件（solid-dom 组） | ✅ 13/13 passed |
| solid-dom 全组 | ✅ 58 文件 / 589 passed + 1 skipped |
| `src/workspace-sheets/__tests__/` 全目录（全项目组） | ✅ 23 文件 / 114 passed |
| 全量前端 `bun run test` | ✅ 665 文件 / 5182 passed + 1 skipped + 1 todo / 0 failed |
| `bun run check:solid` | ✅ tsc solid 侧 + 边界/主题/manifest 等全链绿 |
| eslint（3 新文件 + vitest.setup.ts） | ✅ 0 诊断 |
| 生产行为零改动 | ✅ diff 仅 3 个新测试文件 + vitest.setup.ts 白名单行 |
| clippy | 不适用（无 Rust 改动） |

## 测试处置

- 新增：上表三个 `.solid.test.tsx`（13 用例），承接 #484 删除的 `sheetTabOverflow.test.tsx`（5）、`sheetTabStripAgentSwitch.test.tsx`（4）、`agentStatusConsumerMatrix.test.tsx` SheetTabStrip 小节（3→4，见方案要点 3）。
- 修改：`vitest.setup.ts` 白名单换行（见方案要点 6）。Settings/titlebar 矩阵原样保留在 `agentStatusConsumerMatrix.test.tsx`，未动。

## 证据

- `bunx vitest run --project solid-dom <3 新文件>`：`Test Files 3 passed (3)` / `Tests 13 passed (13)`；切换文件 stderr 3 次 console.error 均为白名单内预期契约（`对账 Agent 状态失败` / `切换 Agent失败`）。
- 全量：`bun run test` → `Test Files 664 passed | 1 skipped (665)` / `Tests 5182 passed | 1 skipped | 1 todo (5184)`。**采集时点：2026-10-01 23:56，早于 #515 在共享树落入在途改动**——验收时点共享树的全量已被 #515 未提交中间态污染（存量测试同样红，与本批无关）；本批域内验证由子 agent 在基准提交 `7222f233` 的隔离 worktree 复跑补齐（见下）。
- `bun run check:solid` 全链绿（运行时边界 26 条遗留白名单仅报告、无新增越界；CSS 消费审计 0 死注入）。

## 子 agent 对抗式验收（2026-10-01）

裁决 **PASS-with-findings**。八项核验全过：语义等价（与 `d4054745^` 三份被删原文逐用例比对，无原契约静默丢弃；新增断言均可从原契约推出）；生产行为零改动；vitest solid-dom 分组与 tsconfig 覆盖正确；白名单换行被证实为**必要**（旧条目 endsWith 匹配不到 `.solid` 新文件，沿用则 afterAll 必炸）；隔离 worktree 独立复跑 13/13（切换文件连跑 3 次稳定）+ solid-dom 全组 57 文件 + `check:solid` exit 0；测试卫生（afterEach(cleanup)/resetStores/console.error 全在白名单契约内）与 harness 复用合规；「不做什么」条款遵守。

- P2（环境，非本批缺陷）：验收时点共享树被 #515（zustand→Solid 在途）的 `themeStore.ts` 中间态污染，全量门禁在共享树不可复跑，由 PR 合并后的 CI 全量兜底。
- P3（已采纳）：本记录已补记全量证据采集时点。

## 遗留

- 无行为缺口。`agentStatusConsumerMatrix.test.tsx` 白名单条目所对应的 console.error 属其自身 Settings/titlebar 用例，未动。
