# Dev Record — #266 刀4 空态「再藏」结构与显示前校验

> 入库保留。施工单：`E:\Acode\FILES\任务\工作台优化\待办\11-施工单-空态再藏与显示前校验（刀4）.md`

## 元信息

- issue：#266（中控遗留总账）· **本刀不开新 issue**
- 分支：`feat/cc-visibility-two-layer.4`（基于 `origin/main @ 8572cb02`，即 PR #461 合入后的 main）
- 提交范围：**未提交**（单子未要求提交；全部改动在工作树，`git status` 见「改动清单」）
- 日期：2026-09-29
- 前置：PR #461（刀2+刀3 移植）已合入 main ✓

## 目标与范围

**目标**（三块，缺一不算完）：

1. **结构切换**：显隐从「两份平权表 + 门选一份」→「一份**主管表** + 一份**空态再藏**（从属，只能加）」。
2. **两个开关**：工具栏每行两个显隐开关，**写哪份表显式**，消灭"我在哪个状态改的"这种隐性依赖。
3. **显示前校验**：点「显示」前先判「显示之后装不装得下」（纵向 + 横向）⇒ 装不下就**拒绝 + 提示**，**不改任何数据**。

**不做**：不做刀 5（画布件 ↔ 清单格双向高亮）；不动位置模型（`layout` / `detachX` / 槽位）；不动最小高/最小宽算式本身；不改出厂数据的**值**、不改 `THEME_SCHEMA_VERSION`；不清别的待办（CC-27 / CC-28 / CC-29 后续 / `inputBorderColor` 重叠）。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src/domains/cc/widgetDefinitions.ts` | 文件头「显隐」口径段、`CcVisibilitySlice` 文档块、`resolveCcHiddenWidgetIds`（**取值改并集** + 参数文档）、`CC_SYSTEM_FIELDS` / `isWidgetVisible` / `cliHintGoverned` 注释 | 修改 |
| `src/domains/cc/ccHeightState.ts` | `ccMinHeightInputOf` / `CcMinHeightInput` / `resolveCcMinHeight` 的**注释**；★ **退改 D1 后 `ccMinHeightInputOf` 的第二份切片改并集**（**有代码改动** ⇒ 见「退改 D1」节） | 修改 |
| `src/domains/cc/ccLayoutState.ts` | 新增 `CcVisibilityTarget`（`'base' \| 'empty'`）类型与口径注释 | 修改 |
| `src/domains/cc/ccShowVerdict.ts` | **新增**纯函数 `resolveCcShowVerdict` + 输入/结论类型 | 新增 |
| `src/domains/theme/presetReducer.ts` | **删** `inheritCcEmptySlice`（原位留指针注释）及其 3 处调用（`applyZonePresetReducer` / `setGlobalPresetReducer` / `applyCustomPresetReducer`）⇒ 恢复为 `filterPresetTheme(...)` | 删除 + 修改 |
| `src/domains/theme/themeDefaults.ts` | `ccHiddenEmpty` **值不动**；注释改「再藏基准」并删掉对 `inheritCcEmptySlice` 的引用 | 修改（仅注释） |
| `src/domains/theme/themeTypes.ts` / `themeFieldDefs.ts` | 字段注释按 C 重写；标签「空态隐藏控件」→「**空态里再藏**」 | 修改 |
| `src/domains/theme/themeStore.ts` | `setCcHidden(id, hidden, target)`；按 `target` 写对应表；clamp 用**更新后**的两份表 | 修改 |
| `src/domains/theme/migration.ts` | 一处注释（`ccHiddenEmpty` 缺省不再叫"回落常态切面"） | 修改（仅注释） |
| `src/domains/theme/presets/builtin.ts` | `ccHiddenEmpty` 注释改「再藏」口径；**值不动** | 修改（仅注释） |
| `src/domains/theme/zones/factory/{gui,terminal}-cc.ts` | 文件头一句（cc 区字段从「两个」订正为「三个」名单字段 + C 口径） | 修改（仅注释） |
| `src/domains/appearance/appearance.ts` | `AppearanceCommand` 的 `set-cc-hidden` 加 `target`；`ccHiddenEmpty` 注释按 C 重写 | 修改 |
| `src/domains/appearance/workbenchAppearanceStore.ts` | `case 'set-cc-hidden'` 按 `target` 写对应表 | 修改 |
| `src/domains/appearance/zustandWorkbenchAppearanceStore.ts` | `target` 透传 | 修改 |
| `src/renderers/solid-workbench/input/ControlCenter.solid.tsx` | `hiddenWidgetIdsFor` / 两个开关 + `requestHiddenChange`（校验入口）+ 尺寸实测（`ResizeObserver`）+ 提示与两条清除 effect + JSX（工具栏外层包 `.cc-edit-toolbar-stack`，提示挂其后） | 修改 |
| `.../styles/components/ControlCenter.css` | 定位改由 `.cc-edit-toolbar-stack` 承担；按钮 `flex:0 0 auto`；`.cc-chip-toggle.extra`（虚线边）；新增 `.cc-edit-warning` | 修改 |
| `src/domains/cc/__tests__/ccVisibilitySliceGuard.test.ts` | 数据级 + 行为级判据按 C 重写；回落块删除（原位留指针） | 修改 |
| `src/domains/cc/__tests__/widgetDefinitionTable.test.ts` | 「门开/门关二选一」→「主管 ∪ 再藏」 | 修改 |
| `src/domains/cc/__tests__/ccShowVerdict.test.ts` | 新增（相等放行 / 差 1px 拒 / 空态更严取空态 / 横向拒 / fail-open / 纯函数） | 新增 |
| `src/domains/appearance/__tests__/appearance.test.ts` | 4 处 dispatch 补 `target: 'base'`（形状变更，行为断言不动）+ 新增「两个开关各写各表」用例 | 修改 |
| `src/domains/appearance/__tests__/zustandWorkbenchAppearanceStore.test.ts` | 2 处 dispatch 补 `target` + 新增生产通路「两个开关各写各表」用例 | 修改 |
| `src/renderers/solid-workbench/__tests__/mountSolidControlCenterPreview.solid.test.tsx` | 门开/门关 DOM 读数用例按 C 重写 + 新增「被拒 ⇒ 不发命令 + 出提示 + 加高后成功」与「两个开关各写各表（DOM 读数）」 | 修改 |

## 方案要点

1. **结构 C**（用户 2026-09-29 定）：`生效名单 = 门 ? (主管表 ∪ 再藏表) : 主管表`（去重）。
   不变式 **空态隐藏 ⊇ 常态隐藏**（第二份只能加、不能抵消）——这正是「两个开关」需要的语法。
2. **两个开关各写各表、写入不认门**：`set-cc-hidden` 加 `target: 'base' | 'empty'`，两条写入路径
   （`workbenchAppearanceStore` 静态实现 / `themeStore` 生产实现）分别落到 `ccHidden` / `ccHiddenEmpty`。
   开关**读自己那一份表**判态；chip 的 `＋/●` 与 `dim` 仍按**当前生效名单**显示（"你眼下看到的样子"）。
3. **显示前校验**（`resolveCcShowVerdict`，纯函数）：纵向用 `resolveCcMinHeight`、横向逐态 `resolveCcMinWidth(resolveCcWidthGroups(...))`；
   **两态各算一遍取大**（与最小高下界同口径）、`needed > available` 才拒（相等放行）、
   **fail-open**（量不到尺寸 ⇒ 该方向放行）。`available` 由 `.control-center` 的 `clientHeight/clientWidth` **实测**。
4. **拒绝时不写任何数据**：`requestHiddenChange` 先算"改完之后"的两态名单 → `!ok` 就**连命令都不发**，
   把结论挂成**常驻提示**（`.cc-edit-warning`，`role="alert"`，挂在工具栏**之后**、不在 `role="toolbar"` 内）。
   提示的清除：成功的显隐写入 / 切换选中元件 / 尺寸变化后重判通过 / 退出编辑。
5. **提示与工具栏共用一个 fixed 容器**（`.cc-edit-toolbar-stack`）：提示要**紧贴工具栏下方**，又必须留在
   `role="toolbar"` 之外，共用容器最省事（且不必用魔法偏移量去追会换行的工具栏高度）。
6. **出厂数据一个值没动**：只核并集结果（见「验收标准与结果」的观感核对）。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| 五步门禁（lint / build:example-plugin / build / check:solid / test） | 全 exit 0；`test` = **656 文件通过 / 1 skipped（既有探针）、5110 用例通过 / 1 skipped / 1 todo** |
| `bun run check:clippy` | exit 0；**6 crate 全部 `added: []`**（无新增诊断） |
| 契约快照 `themeSettingCount` | **177**（未变）；`--write` 后**只有 `generatedAt` 变**，已还原时间戳（`git diff` 为空） |
| 反向验证 4 轮 | 全红 → 还原，四轮哈希均与基线逐字相同（见报告） |
| 观感核对（并集 vs 改造前） | **38 条数据（DEFAULTS + 10 出厂预设 + 2 默认预设 + 10 出厂 cc 条目 + 15 夹具）逐字相同 38 / 不同 0** |
| 实机（WebView2） | **部分**：构建新鲜度、工具栏双开关 DOM、几何读数已取；**交互三步因本机进不了活会话而未跑通**（见「未解问题」1） |

## 测试处置

**删（语义消失，不是放宽）** —— 均在原位留指针注释：

1. `ccVisibilitySliceGuard.test.ts` 整个「预设没写空态切面 ⇒ 落值抄常态切面」describe 块，共 **4 条**：
   ① 区域预设只带常态 ⇒ 空态切面 = 常态切面；② 写了就用写的（显式空数组）；③ 非 cc 区不回落 + 纯函数；
   ④ 整份主题路径同样回落且不被 DEFAULTS 盖住。原因：机制（`inheritCcEmptySlice`）**已删** ⇒ 用例语义消失。
   替换为「预设没写"再藏" ⇒ 该键不进 patch（由 `DEFAULTS` 兜底）」3 条新判据。
2. **单子 §六 点名要删的另外两组**（`presetReducer.test.ts`、`presetReducerPureHelpers.test.ts` 里的
   「缺省回落抄常态切面」用例）—— **实际不存在**（全文件 grep `ccHiddenEmpty` / `inheritCcEmptySlice` 均 0 命中）。
   见「与 spec 的偏差」1。

**改（语义从「替换」→「叠加」）**：

3. `ccVisibilitySliceGuard.test.ts`：数据级判据按 C 重写（"每套必须带非空再藏表"的**理由**改写 +
   新增「每套满足 再藏 ⊇ 主管」这条"改结构不改观感"的数据依据）；行为级新增「并集去重」「空态 ⊇ 常态（含穷举）」
   「读侧不做缺省回落」。正控（扫描面非空 / 剥注释）保留。
4. `widgetDefinitionTable.test.ts`：`★ 刀2 门开/门关**二选一**` → `★ 刀4 门开 = 主管 ∪ 再藏、门关 = 只主管`；
   `纯二选一` → `并集（再藏表为空 ⇒ 空态与常态同名单）`；详细档折叠那条的期望值随并集更正
   （`['model','cc-command-hint']` → `['model','tokens','cc-command-hint']`）；其余措辞随口径更新。
5. `mountSolidControlCenterPreview.solid.test.tsx`：`★ 刀2 门开/门关读两份切面` → `★ 刀4 …再藏表**放不出**主管表藏着的件`
   （新增最关键的那条断言：门开时主管表藏的 `tokens` 照样不在场）。
6. `appearance.test.ts` / `zustandWorkbenchAppearanceStore.test.ts`：既有 6 处 `set-cc-hidden` dispatch 补
   `target: 'base'`（**形状变更，行为断言一字未动**；施工单 §十.7 已预告这一处牵动）。

**新增**：

7. `ccShowVerdict.test.ts`：相等放行 / 差 1px 拒 / 空态更严取空态（+ 反证对照）/ 横向被拒 / 纵向优先 /
   fail-open（0 与非有限、单方向可分）/ 空名单不抛 / 纯函数。
8. `mountSolidControlCenterPreview.solid.test.tsx`：`★ 刀4 显示前校验`（装不下 ⇒ 不发命令 + 快照 JSON 逐字未变 +
   提示带 `还差 11px：需要 75px，当前 64px` + 提示不在 `role="toolbar"` 内 + 加高后重点成功 + 成功写入清提示）、
   `★ 刀4 两个开关各写各表（DOM 读数）`。
9. `appearance.test.ts` / `zustandWorkbenchAppearanceStore.test.ts`：`★ 两个开关各写各表`（静态与生产两条真实 store 通路）。
10. 反向验证本身补齐了覆盖：轮④ 的"忽略 target"把**三条**用例打红（含 DOM 那一条）。

**未改动但必须仍绿（逐条核过）**：`ccHeightState.test.ts`、`appearance.test.ts`、`zustandWorkbenchAppearanceStore.test.ts`、
`ccPrunedFieldsGuard`、`ccDeadDataGuard`、`ccVisibilityDeclarationGuard`、`src/__tests__/effectivePresetTheme.test.ts`（键数基线 177 / 64 / 37）。

## 证据

- commit：**无**（施工单未要求提交，改动留在工作树）
- 测试：`bun run test` → `Test Files 656 passed | 1 skipped (657)`、`Tests 5110 passed | 1 skipped | 1 todo (5112)`、exit 0
- 反向验证 4 轮：打坏 → 变红（① 5 红 ② 7 红 ③ 2 红 ④ 3 红）→ 还原 → 哈希逐字相同（细节见报告文件）
- 观感核对：脚本 `报告等\11-…\union-check.mts`，输出「38 条：逐字相同 38 / 不同 0」
- 实机：`pylon.exe`（23:34 重建）带 9222 调试端口；CSSOM 含 `.cc-edit-warning` / `.cc-edit-toolbar-stack` /
  `.cc-chip-toggle.extra`；`--cc-min-height: 85px`（= 常态 `ccMarginBottom 15 + modelHeight 70`，两态取 max 生效）、
  `--cc-min-width: 0px`（生效名单把下边组全藏）、`clientHeight 96` / `clientWidth 950`；
  退出编辑后与冷启动后 localStorage `pylon-theme` 与基线**逐字节相同**（sha 一致、5030 字节）
- 详细报告：`E:\Acode\FILES\任务\工作台优化\报告等\11-施工单-空态再藏与显示前校验（刀4）\2026-09-29-工作者汇报.md`

## 与 spec 的偏差

1. ★ **单子 §六 点名要删的两组用例不存在**：`presetReducer.test.ts` 与 `presetReducerPureHelpers.test.ts` 里
   **没有**「缺省回落抄常态切面」的用例（两文件对 `ccHiddenEmpty` / `inheritCcEmptySlice` 零命中）。
   处置：不删（无可删），已在报告里点名 —— 疑似单子写于刀2 时期、移植到重构后的 main 时那些用例没跟过来。
2. ★ **（初版）`ccHeightState.ts` 只做了注释改动（零代码）** —— ★★ **此条已被「退改 D1」订正**：
   翻译确认那是**单子歧义**（本意只是「**算式本体**别动」，并未排除"输入拼装"那一行）
   ⇒ 并集拼装**必须改**，D1 已改（见「退改 D1」节）。下面这段保留为当时的判断痕迹：
   单子 §三 写「两态 = `ccHidden`、`ccHidden ∪ ccHiddenEmpty`」，
   而 §五 把该文件标为「只读，别改算式」、§六 又点名 `ccHeightState.test.ts` 与
   `zustandWorkbenchAppearanceStore.test.ts` 的"空态更严"断言**必须仍绿**（它们直接锁 `ccHiddenEmpty` 的**原值**）。
   三条合起来是"不能把 `ccMinHeightInputOf` 的第二份名单并集化"（并集化必然改掉那几条被点名的断言 ⇒ 超出本单改动范围）。
   处置：**只修其注释**（原文引用了本刀删掉的 `inheritCcEmptySlice`，属可确认的过时注释；AGENTS.md §6.2），
   并在注释里写明这一处口径差异与后果（第二份仍取原值 ⇒ 只有在"再藏 ⊉ 主管"的合成输入下需求偏大，属**保守**，
   12 套真实预设全部满足 再藏 ⊇ 主管 ⇒ 结果逐字相同）。**verdict 与之同口径**（单子 §9.6.6「与下界同口径」）
   —— 即 verdict 与 clamp 用**同一份两态拼装**，两者永不打架。建议后续单裁：是否把第二份并集化（那会翻转上述被点名的断言）。
3. **`migration.ts` / `presetReducer.ts` 之外的注释顺带清理**：`ccHeightState.ts` 与 `migration.ts` 各一处引用了
   已删符号/已废口径 —— 属 AGENTS.md §6.2「顺手清理可确认的过时注释」；均为**纯注释**，已用「剥注释后逐字相同」核过
   （见报告：comment-only 校验）。
4. **工具栏外层新增 `.cc-edit-toolbar-stack`**（单子未点名的结构）：提示要"紧贴工具栏下方 + 不在 `role="toolbar"` 内"，
   把 fixed 定位提到公共容器是最省事且不依赖魔法偏移量的做法。CSS 里原 `.cc-edit-toolbar` 的
   `position/top/left/transform/z-index` 随之移交到该容器（其余视觉声明不动）。
5. **实机交互三步未跑通**（见「未解问题」1）—— 属环境限制，非代码问题；已用 jsdom + 真实 store 通路覆盖同一判据。

## 退改 D1（2026-09-30 · 翻译验收后追加，已落地）

> 施工单 §十一：翻译验收通过 ⇒ 只补一处**口径 bug**。验收报告见
> `报告等	-…6-09-29-翻译验收报告.md`；本次汇报 `报告等	-…6-09-30-工作者汇报-D1退改.md`。

**改什么**：`src/domains/cc/ccHeightState.ts` 的 `ccMinHeightInputOf` —— 第二份切片从"再藏表原值"
（`theme.ccHiddenEmpty ?? normal`）改为 **`主管 ∪ 再藏`**（`Array.from(new Set([...normal, ...(theme.ccHiddenEmpty ?? [])]))`）。

**为什么**：显隐侧"生效名单"（`resolveCcHiddenWidgetIds`）与显示前校验（`resolveCcShowVerdict`）早就是并集，
只有**最小高下界**这条线还在用"再藏表原值" ⇒ **两处口径打架**：主管表藏了"再藏表里没有的件"（`input` 恰是其一）时，
旧口径会把那个件在空态那一份里"放回来" ⇒ 下界偏高。**探针实测**（主管表藏 `input`、输入栏高 120、件高取默认 28）：
旧口径 **130** / D1 口径 **64**（偏高 66px）⇒ 用户可见后果是「**藏了输入栏，容器降不下来**」。
出厂数据"再藏 ⊇ 主管"掩盖了它（38 条观感核对全部逐字相同），只有上述组合才暴露。

**★ 这是改口径，不是放宽**：
- `ccHeightState.test.ts` 里 `ccMinHeightInputOf({ ccHidden: ['model'], ccHiddenEmpty: [] }).hiddenSlices`
  的期望值 `[['model'], []]` → **`[['model'], ['model']]`**（C 语义：再藏为空 ⇒ 空态 = 主管）。
  旧期望值编码的正是"空态能把常态藏的件放出来"——C 明确取消那种组合；
- `zustandWorkbenchAppearanceStore.test.ts` 的「两态取 max：空态在场更多时下界由空态那份决定」用例
  **语义已不可表达**（C 下 空态 ⊆ 常态在场 ⇒ 绑定项恒在常态那一份）⇒ 按 C 重写为
  「下界由**要求更高的那一份**决定」，并补一条"再藏加不出放回语义"的断言。★ 单子 §十一 未点到这一处（**翻译漏列**），
  属并集化的必然连带，已在汇报里点名。
- 新增 1 条测试用例（探针：藏 `input` + 输入栏高 120 ⇒ 64；反证两态都可见 ⇒ 130）。

**连带同步的注释**：`ccShowVerdict.ts` 文件头口径 2（空态 = 主管 ∪ 再藏）、
`ControlCenter.solid.tsx` 的 `showVerdictInputOf` 注释（改完才真的"与下界同口径"）、
`ccMinHeightInputOf` 文档块（删"空态缺省 ⇒ 回落常态切面"旧说法）。
★ 另**额外**修了 `resolveCcMinHeight` 文档块"四条口径"的第 3 条——原文写"空态切面是自由的、
某套预设的空态完全可以比常态在场更多"，D1 之后这句在 C 下**不可能成立**（再藏只能加）；
留着会把下一个人引回同一个 bug。**纯注释，已披露**。

**验收（D1 轮）**：
- 探针：旧口径 130 / D1 口径 64（脚本 `报告等	-…\d1-probe.mts`）；
- 反向验证**补一轮**：把并集改回 `?? normal` ⇒ **3 条断言红**（ccHeightState 两条 + zustand 一条），
  还原后哈希 `5abdd76930f5f932bc9cb55affd90c916491dc8afa135cbc549ff68d14155de8`（与 D1 后基线逐字相同）；
- 六步门禁：`lint` / `build:example-plugin` / `build` / `check:solid` / `test` 全 green；
  `test` = **656 文件通过 / 1 skipped、5111 用例通过 / 1 skipped / 1 todo**（较 D1 前 +1 用例）；
  `check:clippy` exit 0（6 crate、`added` 全空）；契约快照 `themeSettingCount` 仍 177、无 diff。

## 未解问题

1. ★ **实机交互验收未完成（环境限制）**：空态下工具栏被**既有** shell 规则
   `.solid-workbench-control-center-slot.is-empty .cc-edit-toolbar { display:none }` 隐藏（`WorkbenchChrome.css:414`，非本刀引入），
   而本机这台 dev 实例**进不了活会话**（点侧栏会话行只切换了标签页、`cwd-group` 的「新建会话」`+` 为 hover 显示且在遮挡下点不到、
   两个 sheet 标签都停在空态）⇒ 「两个开关各写各表 / 被拒 + 提示 / 加高后成功」三步在真机没跑。
   未擅自用 composer 发提示词起会话（会真实消耗用户 Agent、且会话会绑定工作区，属越界副作用）。
   **需要**：一个带活会话的实例（或用户授权起一个会话）后补跑这三步。
   现有替代证据：`mountSolidControlCenterPreview.solid.test.tsx`（真实 ControlCenter + 真实 store + 钉住几何）
   与两条真实 store 通路的单测。
2. **验后数据还原**：本机 dev 数据 `%APPDATA%\com.prism.desktop` + `%LOCALAPPDATA%\com.prism.desktop\EBWebView\Default\Local Storage`
   已备份到 `报告等\11-…\backup-userdata\`；主题数据全程未变（sha 一致）⇒ 未做还原动作（无需还原）。
   ★ 免费提示：实机期间点过「界面与设置 → 外观 → 中控台 → 进入布局编辑器」与两次标签切换，均未写主题数据。

## 并行交集

- 碰过而**未提交**：见「改动清单」全表（共 **22 个已跟踪文件** + **2 个新增文件**）。
- 与在途他人的潜在重叠：`ControlCenter.css` 属 #410 声明域（该批已随 PR 合入 main，本次改动点在其工具栏段，
  与 #410 的 `Sidebar.css` / `InputBar.css` 不重叠）；`src/domains/theme/**` 属 #266 本线。
- `src-tauri/**`、`src/workspace-sheets/**`、`src/ui-demo/**`、`src/layout-sketch/**` **未触碰**。
