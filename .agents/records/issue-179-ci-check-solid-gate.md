# Dev Record — 179 CI 未覆盖 check:solid——main 已带 A17 违规合并

## 元信息

- issue：#179（refactor）
- 分支：`Ru5t/Reflector`
- 提交范围：`e05bc80c..本轮 head`
- 日期：2026-09-19

## 目标与范围

把本地门禁 `check:solid` 上到 CI 前端 job（issue 方案 A），并处置 main 存量违规使该门禁可绿。

**不做什么**：不改 `check:frontend` / `check:solid` 脚本定义；不给 A17 R2 加白名单（方案 B 放宽分层红线，非必要不走）；不动 `plugin-runtime/sidebar/sidebarTypes.ts`。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `.github/workflows/ci.yml` | 前端 job 追加「Solid 边界门禁（check:solid）」独立步骤 | 修改 |
| `src/domains/workbench/sidebarModulePrefs.ts` | 删除对 `plugin-runtime/sidebar/sidebarTypes.ts` 的类型 import；`applyModulePrefs` 改泛型 `<T extends SidebarModuleLike>`，新增领域自持最小接口 `SidebarModuleLike { id; alwaysOpen? }` | 修改 |
| `scripts/check-runtime-boundaries.mts` | `DIRECT_INVOKE_ALLOWLIST`：新增 `useSidebarContributionProps.ts`（条目自 `Sidebar.tsx` 迁移，后者已无直发）与 `AgentRendererSuiteWorkbench.tsx`（#177 新增探测直发，漏登记），均附理由注释 | 修改 |
| `docs/说明书/Pylon-模块维护地图.md` | 验证段：「整体入口」表述更新为 check:solid 已入 CI 前端 job | 修改 |

## 方案要点

1. **R2 违规处置**：`applyModulePrefs` 只消费贡献的 `id` 与 `alwaysOpen`，却 import 了 plugin-runtime 的完整贡献契约——领域层自定义最小结构约束（泛型），依赖方向归正，调用方（`Sidebar.tsx`、`SidebarModulesPanel.tsx`）经类型推断保持不变，零行为变更。
2. **被掩盖的存量违规**：`check:solid` 各脚本串行短路执行，A17 首红挡住了后续 `check-runtime-boundaries` 的两条违规——修掉第一条后暴露：
   - `useSidebarContributionProps.ts`：#154 区块栈线把会话删除/导出接线从 `Sidebar.tsx`（allowlist 在册）搬入新文件未跟登，`Sidebar.tsx` 已无直发 → 条目随代码迁移；
   - `AgentRendererSuiteWorkbench.tsx`：#177 选择器空态探测直发 IPC 未登记 → 按同目录 `agentWorkbenchSessionCreation.ts` 先例登记。二者与 P55 `hookBridgeDispatcher`「引入时漏登记」同型。
   - 这正是本 issue 的实证：CI 不跑 `check:solid`，此类违规无感入库。
3. **CI 步骤独立于 `check:frontend`**：按 issue 方案 A 原文「CI 前端 job 追加」，本地门禁语义不动。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| `bun run check:solid` 全绿 | ✅ 退出码 0；A17 无违规；运行时边界门禁通过（54 条遗留白名单仅报告）；后续 CSS/主题/插件/context-panel/hook-anchor 各段全过 |
| 定点回归 | ✅ `sidebarModulePrefs.test.ts`（6）+ `Sidebar.blocks.test.tsx`（17）共 23 passed |
| 全量 tsc | ✅ `tsc -b` 退出码 0 |

## 测试处置

无新增/修改/删除测试。类型收窄不改变行为，既有测试即回归网。

## 证据

- 门禁：`bun run check:solid` → `运行时边界门禁通过：54 条遗留白名单仅报告；无新增 invoke/store/CustomEvent 越界` 及后续各段通过输出，退出码 0。
- 测试：`vitest run src/domains/workbench/__tests__/sidebarModulePrefs.test.ts src/components/__tests__/Sidebar.blocks.test.tsx` → `Tests 23 passed (23)`。
- 类型：`bunx tsc -b` → 退出码 0。
- 复核基线：stash 本轮改动后单跑 `bun scripts/check-runtime-boundaries.mts` 仍报两条违规 → 坐实为 main 存量（非本轮引入）。

## 与 spec 的偏差

spec（`.agents/spec/179-ci-check-solid-gate.md`）只登记了 A17 一条违规；实际处置了三条（A17 R2 + 两条被短路掩盖的 B-04 未登记直发）。原因：`check:solid` 串行短路，issue 登记时只能看到第一条。allowlist 登记属门禁既定流程（「新增路径须显式登记并复审」），两条均附理由注释，**提请架构师在 review 时复核**（先例：P55 hookBridgeDispatcher 事后裁定登记）。

## 未解问题

无。

## 并行交集

`.github/workflows/ci.yml`、`scripts/check-runtime-boundaries.mts`（共享门禁文件）；`src/domains/workbench/sidebarModulePrefs.ts`（#154 区块栈线产物，该线作者即本人）。
