# Dev Record — #266 撤掉「按条件隐藏」（含顺手补丁：权限语义色被通用规则覆写）

> 入库保留。施工单：`E:\Acode\FILES\任务\工作台优化\元件定义表\14-施工单-撤掉按条件隐藏.md`（**口径于 2026-09-23 改写**，
> 原「成员级显隐收编」方向作废）。本记录承接其目标、范围与验收结论。

## 元信息

- issue：**#266**（④ 项 + 用户指定并入的顺手补丁）
- 分支：`refactor/cc-member-visibility`（基于 `main @ d360f9b0`）
- 提交范围：`d360f9b0..HEAD`（本批三笔：`82035c1c` 范围声明 / `575edb7b` 主任务 / `7ab66605` 补丁）
- 日期：2026-09-23

## 目标与范围

**要达成**

1. **撤掉「按条件判明该不该显示」这一类做法** —— 用户 2026-09-23 口径：「不要这个判明条件，常态显示，预设里我手动改」。
   具体：删属性面板那三条按输入模式判明的 `showIf`（命令行边框 宽度/颜色/内边距）；删成员层那 4 条「按字段判明」声明；
   并**从类型上删掉** `CcMemberVisibility` 的 `field` 变体（防后人再实现这条路）。
2. **顺手补丁**（用户指定并入本会话）：修「权限语义色被通用规则覆写」的存量缺陷 —— 只改 CSS 特异度，**不用 `!important`**。

**不做**

- 不动中控结构 / 布局 / 定义表行 / 字段归属 / 组层 `conditions`；
- 不加**任何**新的隐藏机制（本件是减不是加）；
- 不碰 `ControlCenter.solid.tsx`（属性面板读取点）、`themeFieldDefs.ts`、`Settings.tsx`、预设系统、`src/ui-demo/**`、`src/layout-sketch/**`、`docs/前端接口地图.md`。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src/domains/cc/widgetDefinitions.ts` | `input.propertyFields` 三条 `cliLine*` 删 `showIf`；成员层 4 条 `{kind:'field'}` 改 `always`；`CcMemberVisibility` 删 `field` 变体；类型/字段注释按新口径改写 | 修改 |
| `src/domains/cc/__tests__/widgetDefinitionTable.test.ts` | 「cli 三个字段仍带 showIf」→「命令行边框三项不再带 showIf」；「成员默认显隐只引用已有字段」→「成员显隐只是说明列（四类归入 always）」 | 修改（断言改写） |
| `src/domains/cc/__tests__/ccSettingsGrouping.test.ts` | 新增一条：设置页 cc 区两模式可渲染集合同为 **77 / 77** 且差集为空 + cc 字段零 `showIf` | 修改（新增用例） |
| `src/renderers/solid-workbench/__tests__/mountSolidWorkbench.solid.test.tsx` | 原「属性 schema 的联动字段和条件字段…」→「属性面板不按输入模式判明：命令行边框三项两模式都渲染」（逐条点名 + 8 项） | 修改（断言改写） |
| `.../builtin.pylon-renderers/styles/components/chat/StatusBar.css` | 四条 `[data-mode]` 语义色补槽位作用域前缀 + 说明注释 | 修改 |
| `.../builtin.pylon-renderers/styles/components/solid-workbench/WorkbenchChrome.css` | 槽位段注释同步（**只改注释，零规则改动**） | 修改（注释） |
| `src/renderers/solid-workbench/__tests__/workbenchChromeCss.solid.test.ts` | 新增特异度守卫（去掉前缀即红） | 修改（新增用例） |

## 方案要点

1. **成员层那 4 条声明是"文档"不是"门"**：全仓无任何代码读 `member.visibility`（只有测试读）。四个子部件的真实判据在**渲染分支**：
   - 提示符 ❯ → `InputBar.solid.tsx` 的 `inputVariant() === 'cli'`；
   - 上下两条线 → cli 变体块上的 CSS 边框；
   - 历史快捷提示 → `InputBar.solid.tsx` 的 `inputShowHistoryHint && …`；
   - 提示行 → **组层** `conditions: ['has-session','cli-mode','hint-visible']`。
   ⇒ 删声明**不改变任何可见行为**，也不会出现空容器/空标题（渲染器根本不看这一列）。
   类型注释已写明「三类保留值只作说明、不构成显隐门」，`field` 变体删除后这条路**编译期即不可表达**。
2. **属性面板那三条 `showIf` 是唯一真正的"判明门"**，删掉即两模式常态显示。
   ★ **残留（已上报，未自行动手）**：`WidgetPropertyDef.showIf` 这个**可选钩子本身留着了**（删它要连带改
   `ControlCenter.solid.tsx:528` 的过滤 —— 该文件不在本单文件清单内）。已在类型注释写明"当前无声明方使用、
   不要再往这里加条件"。是否连钩子一起删，留给翻译决定。
3. **CSS 补丁走建议 (a)**：给四条语义色加 `.solid-workbench-control-center-slot ` 前缀 ⇒ (0,2,0) → (0,3,0) 反超通用规则；
   hover / `aria-expanded` 那条同为 (0,3,0) 但**更靠后**（`StatusBar.css` 先于 `WorkbenchChrome.css` 注入），故悬停反馈不变；
   前缀安全性已核：中控根节点自带该类，设置页预览挂同一组件。
4. **额外加了一条防回归守卫**（超出单子字面文件清单，**已显式上报**）：这类"算式型"失效 lint/build/测试全绿、
   没有任何一层能抓（与 `ccDeadDataGuard` 同一先例），故在 `workbenchChromeCss.solid.test.ts` 钉住选择器形态。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| 门禁五步（lint / build:example-plugin / build / check:solid / test） | ✅ 全绿；全量 **632 文件 / 4796 用例（4794 passed + 1 skipped + 1 todo）**，**连跑 2 次**无 flake |
| 属性面板：标准模式 5 项 → **8 项** | ✅ 实机（走真实 UI：设置 → 中控台 → 进入布局编辑器 → 选中输入栏 → 面板内切「标准输入」），两模式均为 `背景色/文字色/字号/最小高度/模式/边框宽度/边框颜色/内边距` |
| 设置页两模式仍 **77 / 77** | ✅ 实机数 `.set-row` = 77（命令行交互）与 77（标准输入），且三项目标项在标准模式下仍在 |
| 成员层不再承载判明门 | ✅ 类型 `field` 变体删除（编译期不可表达）+ 测试锁四类归入 `always` |
| 权限四档 computed color = 黄/红/紫/灰 | ✅ 实机：`auto rgb(245,158,11)` / `bypass rgb(244,63,94)` / `edit rgb(99,102,241)` / `default rgb(89,99,93)`，逐档等于各自变量 |
| 反向验证 ①（把 `showIf` 加回） | ✅ 两条新断言均变红（原文已贴报告），复原后绿 |
| 反向验证 ②（去掉语义色前缀） | ✅ 实机（真实引擎内把四条改回无前缀形态）四档**全变灰** `rgb(89,99,93)`；复原后四色回来 |
| 回归：自定义颜色优先 | ✅ 无 inline ⇒ 语义色；写 inline `#000` ⇒ `rgb(0,0,0)`；清掉 ⇒ 回语义色 |
| 契约快照无差异 | ✅ `bun scripts/check-workbench-theme-contract.mts` 通过（内置预设 10 / 主题字段 187 / CSS 变量 96），`git status` 无 fixture 改动 |
| 说明书漂移 | ✅ `docs/说明书/` 无 `visibleWhen` / 成员显隐 / `showIf` 表述，无漂移面 |

## 测试处置

**改写**（均为施工单 §3-2 要求的"按新口径改写断言"，非行为测试的擅自修改）：

1. `widgetDefinitionTable.test.ts`「cli 三个字段仍带 showIf（面板在非命令行模式仍按旧规则隐藏）」→
   「命令行边框三项不再带 showIf（两模式常态显示）」：靶子反转，并加"全表零 `showIf`"防回摆。
2. `widgetDefinitionTable.test.ts`「成员的默认显隐只引用已有字段」→
   「成员显隐只是说明列：不承载"按字段判明"（四类子部件归入 always）」：原断言依赖已删的 `field` 变体，靶子换成"分类收敛 + 四类具名子部件"。
3. `mountSolidWorkbench.solid.test.tsx`「属性 schema 的联动字段和条件字段在 Solid 面板中保持响应式」→
   「#266 · 属性面板不按输入模式判明：命令行边框三项在两种模式下都渲染（条件字段已撤）」：保留原"响应式"靶子，加两模式 8 项断言。

**新增**：`ccSettingsGrouping.test.ts` 一条（77/77 模式无关）、`workbenchChromeCss.solid.test.ts` 一条（语义色前缀守卫）。

**未删除**任何测试文件。

## 证据

- commit：`82035c1c`（L.md 范围声明）、`575edb7b`（主任务）、`7ab66605`（CSS 补丁）
- 门禁：`bun run lint` EXIT=0（0 error / 1 既有 warning，属 `RightRailHost.tsx` 他人文件）；`bun run build:example-plugin` EXIT=0；`bun run build` EXIT=0；`bun run check:solid` EXIT=0；`bun run test` 两次 EXIT=0，`Test Files 631 passed | 1 skipped (632)`、`Tests 4794 passed | 1 skipped | 1 todo (4796)`
- 实机（`cargo build` → `src-tauri/target/debug/pylon.exe`，WebView2 153.0.4234.48）：
  - CSSOM 自检（防"嵌了旧 dist"）：带前缀规则 **4 条**、无前缀 **0 条**；`typeof window.__TAURI_INTERNALS__.invoke === "function"`
  - 权限四档 / 反向 / 回归 数值见上表；读数须**等 `transition: color 120ms` 走完**（同帧读会拿到过渡起点值 —— 本轮踩过）
  - 控制台：全量扫描仅 1 条既有 warning（`pylon-skins schema revision` 恢复提示），无 error/exception
- 仓外文档：《中控元件总表》§8/§10、`待办\设置页死项审计-待办.md`、`待办\权限语义色被通用规则覆写-待修.md`（已标 ✅ 已修）、`待办\成员级显隐收编-待办.md`（已标 ⛔ 作废）

## 与 spec 的偏差

1. **额外新增一条 CSS 守卫测试**（`workbenchChromeCss.solid.test.ts`）——单子未要求，理由见"方案要点 4"。**已上报**，可整条回退。
2. **`WidgetPropertyDef.showIf` 钩子保留**（单子 §2-3 只要求删成员层的 `field` 变体；删这个钩子须动 `ControlCenter.solid.tsx`，不在文件清单内）⇒ 只改了注释写明现状。**已是遗留项**。
3. **`WorkbenchChrome.css` 只改注释**（单子 §7 的修法 (a) 只列 `StatusBar.css`）：那条注释原文说"scoped rules 更 specific"在修好后对本属性已不成立，会误导后来者，故同步一句。零规则改动。
4. **回归口径措辞**：单子 §7 写「`permissionTextColor` **留空** ⇒ 语义色」。实际字段是 `chips('mode' | 'black' | 'white')`，
   判据是 **`=== 'mode'`（界面标签「跟模式」）**，不是"留空"（`permissionTextColor=''` 会落到 `'#000'`）。按真实机理验收（见上表"回归"行）。

## 未解问题

1. **`WidgetPropertyDef.showIf` 钩子成了死机制**（无声明方）。删它需连带改 `ControlCenter.solid.tsx:528`（属性面板过滤）⇒ 建议下一刀一起收掉，别留着当"以后可能有用"的接口。
2. **渲染分支里的"按条件显示"仍在**（`InputBar.solid.tsx` 的 `inputVariant() === 'cli'` / `inputShowHistoryHint`）：
   这些是**子部件自身的渲染逻辑**（标准输入模式下不该出现"❯"提示符），与本次撤掉的"定义表判明门"不是一回事。
   若用户原意是"这些也要常态出现"，那是**另一个件**（会改变可见观感），需先确认。
3. **字段级 `showIf` 在设置页侧仍被 `themeFieldDefs` 使用**（`toolConnectorColor` / `spinnerCustomFrames` / `spinnerCustomVerbs`，均非 cc 区）——
   本件按施工单 §4-1 的界定（渲染器设置那套 schema 不算）未动。

## 并行交集

本分支改动的文件（请其他贡献者避让）：

- `src/domains/cc/widgetDefinitions.ts`、`src/domains/cc/__tests__/{widgetDefinitionTable,ccSettingsGrouping}.test.ts`
- `src/renderers/solid-workbench/__tests__/{mountSolidWorkbench.solid.test.tsx,workbenchChromeCss.solid.test.ts}`
- `src/plugins/product/packages/builtin.pylon-renderers/styles/components/chat/StatusBar.css`
- `src/plugins/product/packages/builtin.pylon-renderers/styles/components/solid-workbench/WorkbenchChrome.css`（注释）
- `.agents/L.md`、本文件

★ **与 #266 另两笔（①② 自由选色，分支 `feat/cc-widget-free-colors`）的堆叠关系**：两条分支**都从 `main @ d360f9b0` 开**，
且**都改了 `src/domains/cc/widgetDefinitions.ts`**（① 改三个 `propertyFields` 的 `kind`、本件删 `input` 的 `showIf` + 成员声明）
⇒ 开 PR / 合并时需先决定**谁先合、另一条 rebase**（区域不重叠、语义不冲突，但同文件必然要过一次合并）。
