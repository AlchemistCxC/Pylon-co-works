# Dev Record — #166 check:solid 常红：`--sidebar-width` 死注入

> 入库保留。规格文档（spec）不保留，其目标、范围、方案与验收结论在此承接。
> 产出路径：`.agents/records/166-css-var-dead-injection.md`

## 元信息

- issue：[#166](https://github.com/AlchemistCxC/Pylon-co-works/issues/166)
- 分支：`fix/166-css-var-dead-injection`（基线 `002f88e5` = main `99ffcc43` 并入 `Ru5t/Reflector` 之后）
- 提交范围：`002f88e5..<本提交>`
- 日期：2026-09-18

## 目标与范围

**要达成什么**：让 `bun run check:solid` 的 CSS 消费审计恢复绿色——消除 `--sidebar-width` 的死注入（注入但全仓无 `var()` 消费）。

**不做什么**：

- 不复活任何旧的左列宽度 token（`--titlebar-sidebar-width` / `--workspace-sidebar-track-width` / `--workspace-sidebar-collapsed-width` / `--sheet-sidebar-width`）——`themeCssSnapshot.test.ts` 已把"不得复活"钉成契约。
- 不把 `sidebarWidth` 标 `hidden`（理由见"方案要点"）。
- 不改设置页信息架构，不碰 ADR-0009 锁定的几何面。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src/themeFieldDefs.ts` | `THEME_FIELD_DEFS.sidebarWidth` 一行：补 `noCssVar: true` 与解释性 `hint` | 修改 |
| `.agents/records/166-css-var-dead-injection.md` | 本记录 | 新增 |

## 方案要点

**缺陷两侧**：

- 注入侧：`THEME_CSS_VAR_MAP`（`src/themeFieldDefs.ts:396-404`）对 `type === 'number'` 且未标 `noCssVar` 的字段做 kebab 派生，`sidebarWidth` 正好命中 ⇒ 注入 `--sidebar-width`。
- 消费侧：#154（`42e4ea4c`，随 #158 入 main）把左列几何收敛为唯一真值 `--sheet-sidebar-track-width`（生产点 `src/domains/theme/themeCssSnapshot.ts:157`，取自布局层的 `sidebarWidth/ sidebarCollapsed/ sidebarEnabled`），并删除了 `App.css` / `Sidebar.css` 里 `var(…, var(--sidebar-width, 250px))` 这类回退链。全仓已无 `--sidebar-width` 字面量。

**为什么"停注入"是正确修法而不是"补消费"**：该字段的权威已不在主题层——`THEME_FIELD_OWNERS.sidebarWidth = 'workspace-layout'`（`src/themeFieldDefs.ts:376`，其 doc 明说这类字段"keep their legacy keys for migration compatibility"）；设置页两处渲染器按 `owner === 'theme'` 过滤（`src/themeFieldRenderer.tsx:379`、`src/components/settings/settingsContributionCatalog.ts:89`），故该字段已无 UI 入口；`workspaceStore` 只在 v1→v2 迁移时读它一次（`src/workspaceStore.ts:112-121`）。补消费等于再造第二条宽度来源，正是 #154 要消灭的东西。

**为什么没照 `rightWidth` 连 `hidden: true` 一起标**：`hidden` 会触发两条**成文契约**——① hidden 字段必须进 `settingsTraceability.test.ts` 的显式登记表；② `GROUP_ORDER` 不得有空组，而 `sidebar/布局` 组内**只有** `sidebarWidth` ⇒ 必须连带删掉该组在设置页导航里的项。那是设置页信息架构的改动，属 #154 的决定，不该由一个门禁修复顺手做（实测：标 `hidden` 时这两条用例双双转红，正是契约在起作用）。故本轮只停注入，把 `hidden` 对齐留给 #154 owner 定夺（见"未解问题"）。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| `bun run check:solid` | ✅ RC=0；`CSS 消费审计通过（注入 117 / 消费 355 / 声明 354，死注入与悬空引用均为 0）` |
| **反向验证** | ✅ 摘掉 `noCssVar` → 同一断言复红（`actual: ["--sidebar-width"]`，RC=1）；装回 → 复绿 |
| `bun run test` | ✅ 597 files / 4308 passed / 2 todo / 0 failed |
| `bun run build`（`tsc -b && vite build`） | ✅ RC=0 |
| 主题契约用例 | ✅ `settingsTraceability` / `themeFieldCopy` / `themeCssSnapshot` / `presetReducerPureHelpers` 共 33 例通过 |
| 影响面核对 | ✅ 全仓无 `--sidebar-width` 字面量；`docs/说明书/` 未把它写成主题 token（无文档漂移）；设置页预览不依赖该 var（左栏宽度不是预览的注入项） |
| 对分（缺陷非本次引入） | ✅ 同一命令在 `feat/preset-v2` tip `96fcdcd5` 上为绿；干净 `main`（`fbdc9817`）复现同一红 |

## 测试处置

**未修改、未删除任何既有测试**。反向验证为临时摘除字段声明（已还原，最终 diff 仅"改动清单"所列）。本轮**未新增测试**：缺陷的守卫就是 `check-css-var-consumption` 本身（它正是发现者），新增断言只会与它重复。

## 证据

- commit：`<本提交>`（PR 见 issue #166 评论区）
- 测试（名称 + 退出码）：`bun run check:solid` RC=0；`bun run test` RC=0（597 files / 4308 passed）；`bun run build` RC=0
- 手工验证：`bun scripts/check-css-var-consumption.mts` 单跑，修复前 RC=1（`deadInjected = ["--sidebar-width"]`）、修复后 RC=0

## 与 spec 的偏差

无 spec（门禁缺陷，直接登记 issue #166）。

## 未解问题

1. **`sidebarWidth` 是否补 `hidden: true`**：其 owner 已是 `workspace-layout`、渲染器也已按 owner 滤除，故 UI 上早已不可见（`sidebar/布局` 组当前渲染零字段）。若要与其同类先例 `rightWidth` 完全对齐（`hidden` + 登记表 + 删 `GROUP_ORDER` 的 `sidebar/布局` 组），属 #154 的信息架构决定，建议由该 owner 决定后再做。
2. **`check:solid` 不在 CI**：`.github/workflows/ci.yml` 只跑 `check:frontend`（不含 `check:solid`），本缺陷因此潜伏至今无人发现（与 `cargo fmt --check` 那笔同类）。是否把 `check:solid` 并入 CI 是路线决定，未在本 issue 处理。
