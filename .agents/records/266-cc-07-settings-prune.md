# Dev Record — #266 CC-07 设置页「中控台」多余项清理 + CC-09 左栏导航分层（刀 1~13）

> 入库保留。规格与逐刀口径见仓外施工单：`E:\Acode\FILES\任务\工作台优化\待办\04-施工单-设置页中控台多余项清理（CC-07）.md`（§三 刀 1~5 / §十 刀 6 / §十二 刀 7~13）。
> 两批的工作者汇报（含逐条原始证据）：`任务\工作台优化\报告等\04-施工单-设置页中控台多余项清理（CC-07）\2026-09-26-工作者汇报.md`、`…\2026-09-27-工作者汇报-刀7~13.md`。

## 元信息

- issue：[#266](https://github.com/AlchemistCxC/Pylon-co-works/issues/266)（总账 · CC-07 **+ CC-09**）
- 分支：`feat/cc-07-settings-prune`（自远端 `main @ 0838dc6e` 建，建完已 `git branch --unset-upstream`）
- 提交范围：**未提交**（工作树改动；用户口径「不 commit / 不 push / 不开 PR」）
- 日期：2026-09-26（刀 1~6）～ 2026-09-27（刀 7~13）

## 目标与范围

**要达成**：把设置页「中控台」一区里**真死 / 空转**的项清干净，并让左栏导航收到「元件」层。

- 刀 1~4：删 4 个「能改没人读」的字段 —— `sendVariant` / `inputShowPlaceholder` / `prismOnColor` / `pillText`；
  连带删两片**悬空 CSS 规则**（`chat/StatusBar.css` 的 `.prism-tag` 族与 `.model-menu`/`.model-item` 族）。
- 刀 5（CC-09）：左栏「中控台」二级项从 12 个子部件名收到**元件名**；主区元件标题补锚点。
- 刀 6：清 `migration.ts` 里已删字段的死行；把守卫扫描面扩到全 `src/`。
- 刀 7~13：删另 7 个字段（`cliLinePadding` / `cliContentOffsetY` / `inputMode` / `inputVariant` / `cliOverflowMode` / `footerLayout` / `inputMinHeight`），
  并把形态**固定化**：输入只剩命令行、底部信息只剩独立状态行、多行输入只剩「随内容增高」一套；清两族死 CSS。

**不做**（施工单 §12.8 + §0 已定案）：不改元件位置模型本身；不动 `CC_WIDGET_GROUPS` 的**元件/成员声明**（铁律：不删已有元件）；
不碰 `inputShowHistoryHint`（CC-08）、`cliTextColor` / `inputBg` / `inputBorderColor`（保留原样）、`sendButton*` 一族；不做 CC-29（CSS 生效性审计，仍是排队件）。

## 改动清单

### 生产源码

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src/themeFieldDefs.ts` | 删 11 条字段定义；`ccHeight.minFn` 收敛为常量转发；`normalizeThemeState` 跳过清单与注释收窄；`syncOnChange` 类型成员退场；`ccBg` / `inputFocusBorder` 加 `noCssVar`（连带处置，见「与 spec 的偏差」） | 修改 |
| `src/store.ts` | `ThemeSettings` 删 11 个成员；两处 `clampCcHeight(...)` 调用去形态参数；import 收窄 | 修改 |
| `src/domains/cc/ccHeightState.ts` | 删 `CcInputMode`/`CcFooterLayout`/`CcOverflowMode` 与 `CcMinHeightOptions`；`resolveCcMinHeight()` / `clampCcHeight(h)` 收敛为**常量最小高 64** | 修改 |
| `src/domains/cc/widgetDefinitions.ts` | `CcStringPropertyKey` / `CcNumberPropertyKey` 去 4 项；属性表单删 3 项；`WidgetPropertyDef.showIf` 与 chips 的 `sync` 机制整体退场；陈旧 note 更正 | 修改 |
| `src/domains/workbench/appearance.ts` | 快照接口与两处映射删 11 个字段 | 修改 |
| `src/domains/workbench/workbenchAppearanceStore.ts` | 两处 clamp 去形态参数 | 修改 |
| `src/domains/workbench/workbenchSkinContract.ts` | `data-footer-layout` / `data-cli-overflow-mode` 契约键删；`dirty` 样本去两字段 | 修改 |
| `src/domains/theme/presetReducer.ts` | `ThemePresetState` 去 4 项；`clampPresetCcHeight` 收敛；`resolveInputMode` / `applyInputVariantInvariant` 退场 | 修改 |
| `src/domains/theme/migration.ts` | 刀 6 删 `state.inputShowPlaceholder = …` 死行；刀 9~11 删 `inputVariant↔inputMode` 联动、`footerLayout`、`cliOverflowMode` 三段归一化；clamp 调用收敛 | 修改 |
| `src/themeFieldRenderer.tsx` | 删 `syncOnChange` 同步分支（`emit` 变薄壳）；元件 `<h3>` 挂 `data-group-anchor`（刀 5） | 修改 |
| `src/renderers/solid-workbench/input/InputBar.solid.tsx` | `resizeInput` 删 cli 提前 return（命令行纳入增高路径）；class 固定 `input-variant-cli cli-mode`、去 `cli-overflow-*`；`inputVariant()` 助手与条件 `Show` 删 | 修改 |
| `src/renderers/solid-workbench/input/ControlCenter.solid.tsx` | `minHeight` 常量；属性面板删 `showIf` 过滤与 chips `sync`；`cli-mode` 常量类；**peri 分支删除** | 修改 |
| `src/plugin-runtime/skin/skinSchema.ts` | `input-bar` 变体白名单显式 `['cli']`（原取自 `inputVariant.options`） | 修改 |
| `src/plugin-runtime/skin/skinResolver.ts` | 两个 data 属性删除 | 修改 |
| `src/plugins/core/renderer/builtinPresentationProfiles.ts` | 6 处 `inputMode`/`inputVariant` + 6 处 `footerLayout` 删除 | 修改 |
| `src/presets/builtin.ts` | 终端默认去契约字段；出厂键清 0 | 修改 |
| `src/zones/factory/terminal-cc.ts`、`gui-cc.ts` | 出厂区域预设键清 0（**授权手改**：数据文件头写着「请勿手改」，本单是明确授权的例外） | 修改 |
| `src/plugins/.../chat/InputBar.css` | `padding:var(--cli-line-padding,6px) 0` → `padding:0`；删两条 `transform:translateY(var(--cli-content-offset-y))`；删 `input-variant-compact` / `input-variant-command` 两族；删 `cli-overflow-fixed-scroll`/`-grow`/`-overlay` 三族；删 `.input-btn` 族 | 修改 |
| `src/plugins/.../ControlCenter.css` | 删 `.cc-footer-peri` 两族与 `data-cli-overflow-mode` 三条；**`.control-center.cli-mode` 高度算式补 `--cc-input-extra-height`**（刀 10 必要配套）；陈旧注释更正 | 修改 |
| `src/plugins/.../chat/ChatView.css` | 删 `.replay-continue-bar` 族（含其两个子类 `-hint` / `-cta`） | 修改 |
| `src/plugins/.../solid-workbench/WorkbenchChrome.css` | 删 tactical-blue 下两条 `.input-btn` 规则 | 修改 |
| `src/plugins/.../chat/StatusBar.css` | 删 `.prism-tag` 族与 `.model-menu`/`.model-item` 族（各 4 条） | 修改 |
| `src/sheets/SettingsSheetSidebar.tsx` | `navGroupsFor`：`zone==='cc'` 取 `block.heading`（元件名），其余 zone 原样 | 修改 |
| `examples/plugins/example.solid-renderer/src/entry.ts` | 示例插件的呈现方案去掉 `inputVariant` token（连带处置，见「与 spec 的偏差」） | 修改 |
| `src/renderers/solid-workbench/__fixtures__/workbench-skin-baseline.json` | 脚本重拍（非手改） | 修改 |
| `docs/说明书/Pylon-插件系统说明书-开发者版.md` | §6.4.1 的 Presentation Profile 示例删两个失效 token（`inputVariant` / `ccVariant`）并加一行说明 | 修改 |

### 测试

| 文件 | 性质 |
| --- | --- |
| `src/domains/cc/__tests__/ccPrunedFieldsGuard.test.ts` | **新增**（刀 6 建，刀 7~13 扩键：11 键 + 3 派生变量，6 条用例） |
| `src/__tests__/settingsCcNavElements.test.tsx` | **新增**（刀 5：真渲染左栏导航） |

其余 25 份测试的同步说明见「测试处置」。

## 方案要点

1. **「死项」的判据要查两件事，不能只查一件**（本单最重要的方法论教训）。
   - 刀 1~4 的四项之所以是「真死」，除了「**有没有人读**」（渲染/逻辑/CSS 变量/语义色四条通路），还必须查
     「**读它的那条规则，选择器里的类名在代码里到底生不生成**」。
     `prismOnColor` / `pillText` 的例子：它们各有一条 CSS 规则在读（`StatusBar.css` 的 `.prism-tag.on` / `.model-item.active`），
     按「有没有人读」判是**活的**；但 `.prism-tag` 这个类名**全仓只存在于 CSS 里**、`.model-item` 的真身是 `cc-model-item`
     ⇒ 规则**悬空**、从未匹配过任何元素 ⇒ 字段实际无渲染效果。
     ⇒ 判据补第 5 条「**规则悬空**」（复刻 CC-01 的病），并且**顺序上先处置规则、再删字段**（否则留下更深的悬空）。
   - 刀 7~13 的七个字段同理：`cliLinePadding` / `cliContentOffsetY` 有 `cssVar` 且有 CSS 读，但读法/取值使其**零视觉贡献**；
     `inputMode` / `inputVariant` / `cliOverflowMode` / `footerLayout` 是**形态开关**，形态固定后全部分支塌缩成一支。
2. **形态固定化 = 删「开关」而不是删「能力」**：刀 9/10/11 把输入形态、多行行为、底部信息布局各固定成一种，
   删的是「切换用的字段与分支」，保留的是被选中的那一种实现（命令行 / 随内容增高 / 独立状态行）。
   由此带来的最小高计算塌缩：`resolveCcMinHeight` 的三条分支 → 常量 64（改造前 `free` 形态走的就是这一支 ⇒ 对当前用户零变化）。
3. **位置差异改由区域预设记值**（用户口径）：样式/排布差异不再由「元件的小预设」承载 —— 元件位置仍由
   `widgetDefinitions` 的 `layout` 声明 + 区域预设的值决定，本单**不新增任何机制**。
4. **契约快照只写不验** ⇒ 每批做完必须主动 `bun scripts/check-workbench-theme-contract.mts --write` 重拍，
   并用探针做**删前删后逐变量 diff**（本单做法：`.agents/spec/266-probe-theme-state.mts` 跑两次 + `266-out/diff*.mjs` 逐 key 比对）。
5. **守卫的三层判据**（`.agents/cc/__tests__/ccPrunedFieldsGuard.test.ts`）：源码级（全 `src/` 生产源码零命中，剥注释、排除 `__tests__`/`__fixtures__`）
   + 字段表级（不在 `THEME_FIELD_DEFS`）+ 样式级（`StatusBar.css` 的变量/选择器不在）。
   ★ **转义教训**：正则写在模板串里必须用 `\\b` / `\\s` / `\\.`；首版写成单反斜杠 ⇒ `\b` 退化成退格符 U+0008、`\s` 退化成字面 `s`，
   判据整体空转、**守卫假绿**，是「把键放回生产文件」的**反向验证**才把它揪出来的。这条已写进守卫注释。
   ★ 判据形态：`(?:\.\b<key>\b|\b<key>\b(?!\s*=))` —— 抓 `.key`（属性访问/赋值）与「裸 key 且后面不是 `=`」，
   只排除 **JSX DOM 属性**形式（`inputMode={…}`、`inputMode="url"`，与主题字段同名但无关）。

### 两个机制退场（原因与恢复方式）

| 机制 | 位置 | 为什么退场 | 若要恢复 |
| --- | --- | --- | --- |
| `syncOnChange`（字段联动写：写 A 时连带写 `def.syncOnChange` 声明的伙伴字段） | 类型在 `themeFieldDefs.ts` 的 `ThemeFieldDef`；读取分支在 `themeFieldRenderer.tsx` 的 `emit` | 它**唯一的声明方**就是 `inputVariant`（`syncOnChange: ['inputMode']`，表达「输入栏外观 ↔ 输入交互模式」双写）。两个字段删除后，属性既无声明者也无读取者 ⇒ 留着就是「有人声明、没人读」的陷阱 ⇒ 一并删除（含 `src/__tests__/settingsCompleteness.test.ts` 里那条已空转的断言）。注意：**主题字段自己的 `showIf`**（`ThemeFieldDef.showIf`，用于 chat 区三项）**不受影响、仍在用**，删的只是 widget 属性面板那一套。 | ① `ThemeFieldDef` 加回 `syncOnChange?: readonly string[]`；② `themeFieldRenderer` 的 `emit` 恢复「按 `def.syncOnChange` 写入伙伴键」的分支；③ 需要联动的字段定义上写 `syncOnChange: [...]`；④ `settingsCompleteness.test.ts` 恢复「引用存在的字段」断言。恢复后**务必**让写盘路径的结构对齐仍幂等。 |
| 属性面板的 `showIf` + chips 的 `sync` | `widgetDefinitions.ts` 的 `WidgetPropertyDef` / `WidgetPropertyField.chips.options[].sync`；读取点在 `ControlCenter.solid.tsx`（属性面板过滤 + chips 点击） | `showIf` 的上下文类型就是 `Pick<ThemeSettings,'inputMode'>`，chips 的 `sync` 表达的正是 `inputMode↔inputVariant` 双写 —— 两个字段删除后两者都失去唯一上下文/声明方。口径本身没变（**属性项一律常态显示**，值由预设给、用户自己改），只是不再需要这两台机器。 | ① 恢复 `WidgetPropertyDef.showIf`（并给它一个不依赖已删字段的上下文类型）；② 恢复 chips 选项的 `sync` 字段与点击时的连带写入；③ 恢复 `ControlCenter` 的两处读取点。 |

### 刀 11 的影响（排布统一为「独立状态行」）

- 内置呈现方案共 **9 套**（`builtinPresentationProfiles.ts`）。改动前其中 **8 套配 `peri`**：
  `modern-gui` / `terminal-modern` / `paper-low-contrast` / `console-glass` 各自直接声明，
  以及经**共享 token 块** `EXECUTION_SURFACE_TOKENS` 继承的 `agent-command` / `agent-map` / `focus-flow` / `tactical-blue`；
  仅 `terminal-classic` 显式 `free`（其余未声明的本来也落默认 `free`）。
- 删掉该字段后，**9 套排布统一为 `free`（独立状态行）** —— 用户 2026-09-27 已知悉并**接受**（其口径：「你当前用的就是 `free`」）。
- 结构侧改动：`ControlCenter.solid.tsx` 的 `footerLayout === 'peri' ? … : …` 三分支塌缩为单一分支，`.cc-footer-peri` 包装 div 与 CSS 两族一并退场；
  位置差异**不新增机制**（仍由定义表 `layout` + 区域预设记值）。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| 字段基线 | ✅ `THEME_FIELD_KEYS` **190 → 186 → 179**；`cc` **79 → 75 → 68** |
| 11 个键在生产源码零残留 | ✅ 866 个生产文件 **0 命中**（独立脚本 + 守卫双口径） |
| 出厂侧键清 0 | ✅ `zones/factory/*` + `presets/builtin.ts` + `builtinPresentationProfiles` 逐文件 **各 0**（前批 4 键 + 本批 7 键，合计处数与施工单处数表一致） |
| 五族死类名 | ✅ `input-variant-` / `cli-overflow-` / `cc-footer-peri` / `input-btn` / `replay-continue-bar` 在 `src/**/*.css` **各 0** |
| 契约快照 | ✅ `--write` 退出码 0；`主题字段 176 / Workbench CSS variables 89 / fixture 15` |
| 删前删后逐变量 diff | ✅ 15 套 fixture **允许集之外 0 条差异**（允许 = 5 个变量：3 个被删 number 字段的派生变量 + 2 个连带失去消费者的别名变量） |
| 设置页实机 | ✅ 左栏「中控台」二级项 **7 项**（元件名）；主区元件 h3 有锚点、点击可滚到；「上下两条线」组仍在（宽度/颜色） |
| 刀 10 实机目视 | ✅ 底边恒 685 不动、上边 645→565 延伸、3 倍封顶 120、8 行起 `overflow-y:auto`、无滚动条、状态行 731–782 全程不动 |
| 两条新守卫测试 + 反向验证 | ✅ `ccPrunedFieldsGuard` 6 条 / `settingsCcNavElements` 4 条；反向验证 4 次（T7、T8 前批 + 守卫两种回归形状本批），改坏均变红、改回复绿 |
| 门禁五步 | ✅ `lint`（0 error，1 条他人在途文件警告）/ `build:example-plugin` / `build` / `check:solid`（11 项子检查全过，CSS 审计死注入与悬空引用均 0）/ `test`（**654 文件 / 5015 通过 / 1 skipped / 1 todo**） |

## 测试处置

★ **逐个点名**（共 27 份 = 25 份同步修正 + 2 份新增；同步修正全部是「契约变更引起的写法同步」，**没有删任何行为覆盖**）。
改法分三类：**①** 计数/清单按**实测真值**重算（真值由 `.agents/spec/` 探针跑出，不手推）；**②** 样本字段换成仍在的**同形字段**（逐处注明原样本为何不能用）；**③** 靶子反转型改写（机制被撤后，断言从「必须有 X」改为「不得回摆」）。

| # | 文件 | 改法与理由 |
| --- | --- | --- |
| 1 | `src/domains/cc/__tests__/ccPrunedFieldsGuard.test.ts` | **新增**：守卫（11 键 + 3 派生变量、三层判据、JSX 同名属性豁免） |
| 2 | `src/__tests__/settingsCcNavElements.test.tsx` | **新增**：真渲染导航（中控台=元件名、不含子部件名、点击滚到元件 h3、其它 zone 未变） |
| 3 | `src/domains/cc/__tests__/widgetDefinitionTable.test.ts` | ① cc 字段 83→81→**68**；分组计数与成员归属表按真值重算；③「命令行边框三项不再带 showIf」改为「两项仍在 + 表里任何一项都不带条件显示（机制已删，防回摆）」；属性表单清单同步减项 |
| 4 | `src/domains/cc/__tests__/ccSettingsGrouping.test.ts` | ① 冻结清单 78→77→73→**66**；分区数断言 8→**7**（「用量」退出）；③ 两模式用例改为「直接按冻结清单断言项数 + cc 区不得有 showIf」（原判据依赖已删的 `inputMode` 上下文） |
| 5 | `src/domains/cc/__tests__/ccHeightState.test.ts` | ① 最小高用例重写为「单一形态 ⇒ 常量 64」，`clampCcHeight` 补 NaN / 区间内 / 上界三档 |
| 6 | `src/domains/theme/__tests__/migration.test.ts` | 删除整段「`inputVariant↔inputMode` 联动不变量」用例（机制不存在了）；import 收窄 |
| 7 | `src/domains/theme/__tests__/presetReducer.test.ts` | ① 状态夹具去 4 个字段；③「D1 校验漏斗」用例改为只锁 clamp（常量 64 / 区间内 / 上界 400） |
| 8 | `src/domains/theme/__tests__/presetReducerPureHelpers.test.ts` | ① `clampPresetCcHeight` 用例组重写：下界常量 64、上界 400、缺省回落默认值、NaN 回落最小高（**既有语义未变**，只是形状收敛） |
| 9 | `src/domains/theme/__tests__/themeFieldCopy.test.ts` | ② 关键枚举样本去掉 4 个已删字段（`inputShowPlaceholder`/`sendVariant`/`inputMode`/`footerLayout`/`cliOverflowMode`）；② 「模糊字段」样本 `footerLayout` → `cliHintMode` |
| 10 | `src/domains/theme/__tests__/themeSchemaV8Backfill.test.ts` | ② 「保留项不受牵连」样本 `pillText`/`prismOnColor` → `inputShowHistoryHint`/`ccBg` |
| 11 | `src/domains/theme/__tests__/terminalPresets.test.ts` | ② 终端契约断言去掉 `inputMode`/`inputVariant` 两项（其余仍逐条锁） |
| 12 | `src/domains/workbench/__tests__/selectCcProperties.test.ts` | ① 可编辑键集合去 4 项；② 取值样本换 `modelSwitchMode` |
| 13 | `src/domains/workbench/__tests__/appearance.test.ts` | ③ 两条「切 CLI 抬高中控高度」用例改为锁常量最小高（原机制随字段退场） |
| 14 | `src/plugin-runtime/skin/__tests__/skinSchema.test.ts` | ② `inputVariant` 样本删除；③ `componentVariants['input-bar']` 断言改为 `['cli']`（白名单来源字段已删，现为显式单值） |
| 15 | `src/plugin-runtime/skin/__tests__/skinResolver.test.ts` | ② data 属性样本换 `msgStyle`；③ 新增「两个已删 data 属性不得回摆」断言 |
| 16 | `src/plugin-runtime/skin/__tests__/skinValidation.test.ts` | ② 「select + boolean default」样本 `inputShowPlaceholder` → `inputShowHistoryHint`（同形） |
| 17 | `src/plugins/core/renderer/__tests__/builtinPresentationProfiles.test.ts` | ① `terminal-classic` 冻结快照与两份「必需 token」清单按真值减项 |
| 18 | `src/renderers/solid-workbench/__tests__/mountSolidWorkbench.solid.test.tsx` | ② 去已删字段赋值；③ 属性面板用例改为「5 项恒定 + 面板里没有『模式/标准输入/命令行』切换」 |
| 19 | `src/renderers/solid-workbench/chat/__tests__/InputBar.css.test.ts` | ③ 「compact/command 两族必须有样式」→「命令行族仍在 + 两族不得回摆」 |
| 20 | `src/renderers/solid-workbench/input/__tests__/InputBar.solid.test.tsx` | ② `renderInput` 的 `inputVariant` 参数退役（形态固定，参数位保留为占位） |
| 21 | `src/__tests__/defaultPresets.test.ts` | ② `TERMINAL_CONTRACT` 去 2 项；夹具去 2 个字段赋值 |
| 22 | `src/__tests__/effectivePresetTheme.test.ts` | ① 出厂预设键数基线按**实测真值**重算（187→183→**176**；`glass` 67→65→**63**；`agent-*` 36 不变），注释里写明逐套账与探针来源 |
| 23 | `src/__tests__/presetAssembly.test.ts` | ③ ccHeight 收敛用例改为「装配必过 clamp 漏斗（常量下界 64 / 上界 400）」 |
| 24 | `src/__tests__/settingsCompleteness.test.ts` | 删「syncOnChange 引用存在字段」断言（机制已删，断言无对象）；文件头注释写明 |
| 25 | `src/application/transactions/__tests__/applyGlobalPreset.test.ts` | ② 期望对象去 `inputVariant` |
| 26 | `src/domains/interface/__tests__/interfaceMode.test.ts` | ① `CC_INPUT_TOKEN_KEYS` 去 3 项；② 样例 Profile token 去 `inputVariant`；② 两处 `toMatchObject` 收缩到仍在的 `msgStyle` |
| 27 | `src/domains/interface/__tests__/pluginInterfaceMode.integration.test.tsx` | ② 样例 Profile token 去 `inputVariant`（该 token 已是非法值，注册会抛） |

★ `src/plugin-runtime/renderers/__tests__/thirdPartySolidRenderer.integration.test.ts`（7 条）**未改测试**，红的是被它加载的**示例插件**（见「与 spec 的偏差」）—— 改插件后即绿。

**未修改**（本单未触碰、保持绿）：`ccDeadDataGuard` / `ccVisibilityDeclarationGuard`（停手条件未命中）、`B-01-visual-semantic-palette` 等语义色与布局契约类用例。

## 证据

- **commit**：无（未提交）。工作树：**52 改 + 3 新增**（52 改里含 **25 份测试**、`docs/说明书/Pylon-插件系统说明书-开发者版.md`；3 新增 = 本记录 + 两份新测试）——`git status` 可对账。
- **两批门禁五步**：见两份工作者汇报 §三 / §五；原始日志 `.agents/spec/266-out/final-*.log`（前批）、`f2-*.log`（本批刀 7~13）、`z-*.log`（收尾复跑）。
  本批最终一次（`f2-*`）：`lint` 0 error（1 条他人在途文件警告）→ `build:example-plugin` → `build` ✓ → `check:solid` 11 项子检查全过
  （CSS 消费审计：注入 106 / 消费 347 / 声明 363，**死注入与悬空引用均为 0**）→ `test` 654 文件 / **5015 通过** / 1 skipped / 1 todo（EXIT 0）。
- ★ **收尾复跑（`z-*`）第 5 步红 1 条，但与本单无关**：`src/plugins/core/renderer/__tests__/solidRendererSurface.test.ts`
  「mount 一次后 1000 次 update 保持 DOM identity」——`AssertionError: expected '' to contain 'chunk-0'`（`:47:58`）。
  该文件**本单从未触碰**；其红因是**既有 #373**（`vi.waitFor` 的 2s 预算吃不下一处**冷挂载**：动态 import + 现场转译渲染器图，机器相关秒级）。
  核验：① `gh issue view 373` 的排除链写明「把当次被测改动全部回退到 HEAD 后仍红」；② 把 `origin/main`（`f1df9eeb`，PR #374 = `Closes #373`）
  的修复**原样贴进来**跑 ⇒ `Tests 2 passed (2)`，随后**原样撤销**（`git diff` 该文件为空）⇒ 机制坐实是冷挂载预算，非本单改动。
  ★ **发 PR 前须先合最新 `origin/main`**（本分支基线 `0838dc6e` 落后 107 个提交），否则 CI 会在这一条上红。
- **探针（仓外 `.agents/spec/`，已 gitignore、不入库）**：`266-probe-theme-state.mts`（字段/变量基线，跑前跑后 + `266-out/diff.mjs`、`diff-batch2.mjs` 逐 key diff）、
  `266-probe-preset-counts.mts`（预设键数真值）、`266-probe-cc-groups.mts`（分组/成员归属真值）、`266-probe-zombie-keys.mts`（旧数据僵尸键读盘）。
- **实机**：`src-tauri\target\debug\pylon.exe` + WebView2 调试端点 `127.0.0.1:9222`（页面 `http://127.0.0.1:1430/`，从 `dist/` 载入）。
  - 刀 5：左栏「中控台」二级项 7 项 = 元件名；点「发送按钮」主区 h3 从 4115.5px → 150px。
  - 刀 10：多行输入几何逐档读数（空 / 3 / 8 / 12 / 30 行，见上文表格）；两条线贴边（`padding:0`、边框 3px、上留 1px 下留 0px）。
  - 死类名在真实 DOM：`.cc-footer-peri` / `.input-btn` / `.replay-continue-bar` 各 0 个。
  - 控制台 0 error / 0 exception；后端 `list_runtime_logs` error 0 条（仅有页面 reload 引起的 `[TAURI] Couldn't find callback id …` 警告）。
  - ★「读取器假绿」防控：故意打一条 `console.error` 做正控，确认读取器抓得到（前批已验，本批沿用同端点）。

## 与 spec 的偏差

1. **施工单 §五 / §12.5 的「需同步测试」清单不全**（施工单自身口径）：前批漏点 `effectivePresetTheme.test.ts`（翻译 §10.2 已追认**漏点在单子**）；本批 §12.5 只点 6 份，实际连带 **17 份**（上表 3~27 中除去两批新增与前批已改的）。全部按真值/新契约校准，**未放宽任何断言**。
2. **`syncOnChange` 机制整体退场**（单子只点了「渲染侧 sync 分支删」）：唯一声明方是 `inputVariant`，留着即陷阱 ⇒ 连带删类型成员与那条空转断言（原因与恢复方式见上表）。同理 `WidgetPropertyDef.showIf` + chips `sync` 一并退场（其上下文类型就是 `Pick<ThemeSettings,'inputMode'>`）。
3. **`normalizeThemeState` 跳过清单里的死引用**（前批）：施工单只说「删定义行」，该函数里另有一句显式引用被删键 ⇒ 一并删（否则验收项「生产源码零残留」永远差一处）。
4. **`DEFAULTS` 的实际位置**（前批）：施工单写「`store.ts` 的 `DEFAULTS` 同步删」，实际它已迁至 `domains/theme/themeDefaults.ts` 且**由定义表派生** ⇒ 无需改动。
5. **连带处置三处**（本批，见 2026-09-27 汇报 §七，均已请追认）：
   - `examples/plugins/example.solid-renderer/src/entry.ts` 的呈现方案含 `inputVariant` token ⇒ 不摘掉示例插件激活失败、`thirdPartySolidRenderer.integration` 7 条全红；
   - `ccBg` / `inputFocusBorder` 加 `noCssVar`：它们的**别名变量**（`--cc-bg` / `--input-focus-border`）唯一 CSS 消费者正是本单删掉的两族规则 ⇒ 成为「死注入」而被 `check-css-var-consumption` 挡住。两个**字段本身仍活着**（`ccBg` 走内联 `--cc-surface`；`inputFocusBorder` 是 `state.focusRing` 角色源，别名仍由 `themeCssSnapshot` 的兼容表运行时产出）⇒ 处置只是停止重复注入无人消费的别名。代价：它们退出 `WORKBENCH_CSS_VARIABLES` 皮肤契约表（94→89）。
   - 刀 10 的 1 行 CSS 配套：`.control-center.cli-mode { height }` 未含 `--cc-input-extra-height`（原先 cli 从不增高所以没暴露）⇒ 不补则多行输入向下长、顶开状态行，与验收 ③「底边不动」正相反。
6. **说明书同步**（用户点名的收尾件）：`docs/说明书/Pylon-插件系统说明书-开发者版.md` §6.4.1 示例里两个 token 已失效 —— `inputVariant`（本单刀 9 删）与 `ccVariant`（#238 刀8 删，**同一示例里的既有失效**）。两键相邻，只删一个示例仍不可用 ⇒ **一并移除**并在段末加一行说明（照旧写会因「未知 token」注册失败，写 Profile 前以 `THEME_FIELD_DEFS` 当前键集为准）。
7. **§12.4-7 的逐变量 diff 预期与实测的差异**：施工单写「刀 7/8/11/13 应零差异；刀 9/10 允许差异」。实测：
   刀 7/8/13 是 number 字段、各自带一个派生变量 ⇒ 差异表现为**变量集合 −3**（这正是「字段删了没人产出」的直接后果），其余变量值逐条不变；
   刀 9/10/11 是 select 字段（**本就不产出 CSS 变量**）⇒ 在变量契约上零差异，其可见变化落在渲染层。**允许集之外 0 条差异**（无未归因漂移）。

## 未解问题

1. **`resolveVisibleStatusWidgetCount` 现无生产消费者**（`ccHeightState.ts` 仍导出、自带测试）：形态固定后最小高是常量，`hintMode` / `visibleStatusWidgets` 不再参与任何计算 ⇒ 这个「计数与可见性谓词同源」的工具在生产侧空转（`isWidgetVisible` / `STATUS_WIDGET_IDS` 仍被渲染侧使用）。**本单未删**（不属范围），去留待裁定。
2. **`ccBg` / `inputFocusBorder` 两个 `noCssVar` 的取向**：若希望保留别名变量供第三方皮肤消费，需换另一种处置（删字段 / 让 `check-css-var-consumption` 认可 JS 消费 / 另找消费者），见「与 spec 的偏差」5。
3. **CC-29（CSS 生效性审计）仍排队**：本单新暴露一类现象 —— `ControlCenter.css` 里与「composer / 非 cli」相关的 `:not(.cli-mode)` 大段规则，在输入形态固定命令行后**已无匹配对象**（它们不属本单点名的五族，故未清理）。
4. **旧数据里的僵尸键**由 `store.ts` 的 A4 白名单在下次写盘修剪（前批实测：读盘不炸、写盘即清）；`migration.ts` 不再为这 11 个键做显式清键，与「不 bump 版本号」的既定处置一致。

## 并行交集

本单碰过的共享文件（供其他贡献者避让）：

- **中控区**：`src/themeFieldDefs.ts`、`src/store.ts`（`ThemeSettings`）、`src/domains/cc/{ccHeightState,widgetDefinitions}.ts`、`src/themeFieldRenderer.tsx`、`src/sheets/SettingsSheetSidebar.tsx`。
- **渲染器**：`src/renderers/solid-workbench/input/{InputBar,ControlCenter}.solid.tsx`（及其测试与 `chat/__tests__/InputBar.css.test.ts`）。
- **主题域 / 契约**：`src/domains/theme/{migration,presetReducer}.ts`、`src/domains/workbench/{appearance,workbenchAppearanceStore,workbenchSkinContract}.ts`、`__fixtures__/workbench-skin-baseline.json`（快照只能脚本重拍）。
- **皮肤**：`src/plugin-runtime/skin/{skinSchema,skinResolver}.ts`。
- **首方样式**（`builtin.pylon-renderers`）：`InputBar.css`、`ControlCenter.css`、`ChatView.css`、`StatusBar.css`、`solid-workbench/WorkbenchChrome.css`。
- **出厂数据**（预设组装线，该线已合入 main、无并行写者）：`src/zones/factory/{terminal-cc,gui-cc}.ts`、`src/presets/builtin.ts`、`src/plugins/core/renderer/builtinPresentationProfiles.ts`。
- **仓外示例插件**：`examples/plugins/example.solid-renderer/src/entry.ts`。
- 仓外一次性工具（不入库）：`.agents/spec/266-*` 与 `.agents/spec/266-out/**`。
