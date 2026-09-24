# Dev Record — #266 遗留⑧ 显隐只剩「值」（撤掉元件侧三样显隐申明）

> 入库保留。施工单：`E:\Acode\FILES\任务\工作台优化\元件定义表\17-施工单-显隐只剩值.md`（该单不在仓库内）。
> 上游：④「撤掉按条件隐藏」开发记录 `.agents/records/266-cc-drop-conditional-hiding.md`。

## 元信息

- issue：**#266**（遗留⑧；总表 §10 记为「⑧ 显隐只剩「值」」）
- 分支：`refactor/cc-visibility-as-value`（从 ④ 的 tip `988cfbb9` 开出；本件与 ④ 同期进批量 PR）
- 提交范围：`988cfbb9..34e13f45`
- 日期：2026-09-24

## 目标与范围

**目标**：把中控可见性收敛成 **① 预设里的显隐值（`ccHidden` + 详细档这个自己的值）② 语境侧名单（空态那一侧）**
—— **元件自己不申明显隐**。

用户口径（逐字）：「所有东西在这一维只有显示 / 隐藏两个属性，要存状态存到预设里，不要额外申明属性」
「如果要记『这里不显示』，应该是在这里注明 a 不显示，而不是 a 申明在这里不显示」
「命令行提示按模式驱动可见**我后悔了**，能不能也改成值？」

**非目标（未做，且不该做）**：定义表结构 / 分组 / 布局；`ccHidden` 本体；`cliHintMode` 三档取值与出厂预设里写死的档位
（**没有**改成写 `ccHidden`：那要动 `builtinPresentationProfiles.ts` 6 处预设 + 迁移）；出厂数据（⑦ 域）；
空态名单**在计数侧的现有行为**（空态数值必须不变）；空态容器渲染行为。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src/domains/cc/widgetDefinitions.ts` | 删行级三样申明（7+1+5 处）与 `CcWidgetGroup` 上三个栏位；删类型 `CcVisibilityCondition` + 条件表 `CC_VISIBILITY_CONDITIONS`（原位留口径说明）；空态名单改字面量并加入 `cc-command-hint`；删 `ALWAYS_VISIBLE_STATUS_WIDGET_IDS`；**新增** `resolveCcHiddenWidgetIds`；`WidgetVisibilityCtx` 收成 `{hidden, editMode?}`；`isWidgetVisible` 收成一行 | 修改 |
| `src/renderers/solid-workbench/input/ControlCenter.solid.tsx` | 隐藏名单改走组装函数（空态并名单 → 折叠）；删 `passesStatusGate` / `hasAlwaysVisibleStatusWidget`；`statusRowContent` 改判「该落脚处有无可见件」；`visibilityContext` 只留 `{hidden, editMode}` | 修改 |
| `src/ccHeightState.ts` | `resolveVisibleStatusWidgetCount` 入参收成 `{hiddenIds}`（原 `inputMode`/`submitButtonMode`/`hintMode`/`hasSession` 全删） | 修改 |
| `src/themeFieldDefs.ts`（`ccHeight.minFn`）、`src/store.ts`（×2）、`src/domains/theme/migration.ts`、`src/domains/theme/presetReducer.ts`（×2）、`src/domains/workbench/workbenchAppearanceStore.ts`（×2） | **8 处**计数调用点改调 `resolveCcHiddenWidgetIds` | 修改 |
| `src/domains/cc/__tests__/ccVisibilityDeclarationGuard.test.ts` | **新增**源码级 + 对象级守卫（剥注释扫 4 个 token + 每行不带三个键 + 8 行正控） | 新增 |
| `src/domains/cc/__tests__/widgetDefinitionTable.test.ts`、`src/__tests__/ccHeightState.test.ts`、`src/domains/theme/__tests__/presetReducerPureHelpers.test.ts`、`src/domains/workbench/__tests__/appearance.test.ts` | 断言按新口径更新 / 反转（逐条见「测试处置」） | 修改 |
| `src/renderers/solid-workbench/__fixtures__/workbench-skin-baseline.json` | 契约快照重拍（差异**只有** `generatedAt`） | 修改 |

**未触碰**（施工单点名不动）：`src/zones/**`（⑦ 域）、`src/presets/**`、`ControlCenter.css`、`src/components/Settings.tsx`、
`src/sheets/**`、`src-tauri/**`、`tools/**`、`src/ui-demo/**`、`src/layout-sketch/**`、`docs/前端接口地图.md`。

`docs/说明书/`：**零命中**（`grep -rn "inActiveSession|hiddenInEmptyState|CC_VISIBILITY_CONDITIONS|ALWAYS_VISIBLE_STATUS|常态放行|空态隐藏" docs/说明书/` 无输出）⇒ 无漂移面。

## 方案要点

1. **`resolveCcHiddenWidgetIds({ccHidden, cliHintMode})` = 名单组装的唯一一处**（`widgetDefinitions.ts`，纯函数、零运行时依赖）。
   详细档 `'hidden'` 折成 `cc-command-hint` 进名单 ⇒ **谓词只认 `hidden`**，不再依赖任何运行期档位。
   渲染侧与 8 处计数调用点全调它 ⇒ 「渲染与计数同源」。
   ★ 没有选「把 `cliHintMode` 传进谓词」：那等于让可见性重新依赖运行期档位，与口径相悖。
2. **空态名单改字面量** `['model','reasoning','mode','tokens','cc-send-button','cc-command-hint']`（加入提示）——
   空态没有会话，提示没有意义（原由行上 `conditions` 的 `'has-session'` 承担）。类型是 `readonly CcWidgetGroupId[]` ⇒ 写错 id 当场报错。
3. **死码清除**（现场核实，非猜测）：7 行**全都**写了 `inActiveSession: 'show'` ⇒ 谓词第 2 步对现有任何一行都不成立（死码）；
   `ALWAYS_VISIBLE_STATUS_WIDGET_IDS` 因此恒等于 `STATUS_WIDGET_IDS` 全体；`passesStatusGate` 对 `visibleIds()` 里每个 id **恒真**。
   ⇒ 三者删除**零行为影响**。`showStatusSlots()` **保留**（语境侧门户，口径合法；留住它空态空容器行为才完全不变）。
4. **命令航提示的两条合法隐藏路径**：预设的值 `ccHidden`；或详细档选「隐藏」（折叠进名单）。行上不再有任何申明。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| 门禁五步（`lint` → `build:example-plugin` → `build` → `check:solid` → `test`） | ✅ 全绿（提交后在最终树上按序重跑一遍） |
| 全量 test 连跑 ≥2 次 | ✅ **3 次连续绿**：`632 文件 / 4799 用例` 通过（1 skipped + 1 todo，共 4801）；未命中 `PlainMessageList` #243 flake |
| 守卫「行上再无显隐申明」（剥注释扫源码 + 对象级 + 正控） | ✅ `ccVisibilityDeclarationGuard.test.ts` 4 用例绿 |
| 反向验证：往任一行加回 `conditions` / `inActiveSession` ⇒ 守卫必须红 | ✅ 两次注入均红（输出见「证据」），改回即绿 |
| 等价表：四语境 × 7 控件，只允许 §2 那一处不同 | ✅ 用同一脚本跑改造前后做差：**唯一变化的控件是命令行提示**（详见「偏差」1） |
| 实机：标准输入模式 ⇒ 提示**可见**（本件目的） | ✅ 205×19 真实像素，在 `.cc-status-group` 内 |
| 实机：详细档三档（隐藏 / 仅常用 / 全部）行为不变，选「隐藏」不显示 | ✅ `cliHintMode='hidden'` ⇒ 状态行由 5 项变 4 项、DOM 里无提示元素 |
| 实机：空态 ⇒ 提示不显示、其余照旧不显示、空容器仍在 | ✅ `is-empty`；只渲染 `input`；`.cc-status-group` 仍在（0 子件）；`--cc-min-height: 84px`（与改造前一致） |
| 实机：活跃会话 ⇒ 状态行 5 项 | ✅ `[model, reasoning, mode, tokens, cc-command-hint]` |
| 实机：编辑模式 ⇒ 与改造前一致（含"藏起来的元件露出来"） | ✅ `cc-editing` + 工具条 7 行；6 个内置件全渲染 |
| 高度计数前后数值（cli/free 与 cli/peri） | ✅ 见「证据」；★ 空态数值**未变**，会话无关入参处有一处预期外变化（见「偏差」2） |
| 契约快照 | ✅ 重拍后差异**只有** `generatedAt` |
| 开发记录 + 总表 §2/§8/§10 + #266 回写 | ✅ 本文件 + `E:\Acode\FILES\任务\工作台优化\中控元件总表.md` + issue 评论 |

## 测试处置

**新增（1 份）**：`src/domains/cc/__tests__/ccVisibilityDeclarationGuard.test.ts`（4 用例；已做反向验证）。

**改动的既有测试（4 份 / 逐个列出，无删除）**：

| 文件 | 改了什么 | 为什么必须改 |
| --- | --- | --- |
| `widgetDefinitionTable.test.ts` | 删 `ALWAYS_VISIBLE_STATUS_WIDGET_IDS` 相关 3 条断言（:198 常态放行 / :311 名单 5 条 / :455/:500 提示在常态放行里）；:197 那条改名为「成员 id 不得落进空态隐藏名单」（保护不丢）；:312 空态名单由 5 条改 **6 条**（含 `cc-command-hint`）；:502 由「提示**不在**空态名单」**反转**为「在内」；整个 `刀5B 可见性` describe 按 ⑧ 重写为「可见性只剩值 + 语境名单」（其中 :461 `inputMode:'default' ⇒ false` **反转为 true** —— 本件目的；:462 `hasSession:false ⇒ false` 改由**空态名单**承担，语境改为「空态名单里 ⇒ 不显示」）；:485-489 计数断言改为经组装函数、`default` 由 4 反转成 5 | 断言靶子被本件撤掉/反转 |
| `src/__tests__/ccHeightState.test.ts` | 计数入参去掉 `inputMode`/`submitButtonMode`；期望值 `4→5`、`2→3`、`3→4`（空名单即全体状态控件） | 可见性不再依赖输入模式；提示计入 |
| `presetReducerPureHelpers.test.ts` | 计数入参改经组装函数；期望 `4→5`、`2→3`；末条「名单上限 4 ⇒ 永不换行」的断言**不再成立**（上限变 5 ⇒ 满员触发状态行换行），改写为显式数值 `109 / 84` | 同上；原断言编码的「上限 4」是旧口径 |
| `domains/workbench/__tests__/appearance.test.ts` | 两条 clamp 断言 `84 → 109`（含标题与注释里的旧口径更正） | 计数 4→5 后 cli+peri 最小高变 109（见「偏差」2） |

★ 后 3 份**不在施工单 §3-8 点名的清单里**，是现场 `grep` 出来的（单子写「现场 grep 确认，**至少**这些」）——按纪律逐个列明于此，供核验。

## 证据

- commit：`c1013684`（L.md 范围声明，单文件）→ `34e13f45`（本件，14 文件）
- 门禁（提交后按序重跑）：
  - `bun run lint` → `✖ 1 problem (0 errors, 1 warning)`，`EXIT=0`（唯一 warning 在 `RightRailHost.tsx`，存量、非本件）
  - `bun run build:example-plugin` → `已由 src/ 重建`，`EXIT=0`
  - `bun run build` → `✓ built in 9.58s`，`EXIT=0`
  - `bun run check:solid` → 11 项子检查全过（末行 `check-hook-anchor-parity ... 为其子集`），`EXIT=0`
  - `bun run test` → `Test Files 632 passed | 1 skipped (633)`；`Tests 4799 passed | 1 skipped | 1 todo (4801)`，`EXIT=0`
- 反向验证（注入 ⇒ 红 ⇒ 改回）：
  - 往命令行提示行加回 `conditions: ['has-session']` → `Tests 2 failed | 2 passed`，红行原文：
    `AssertionError: expected '\nimport type { ThemeSettings } from …' not to contain 'conditions'`
    `AssertionError: 元件侧显隐申明又回到了定义表；若确要复活，改这条测试是显式动作: expected [ 'conditions（行上「运行期状态检测条件」申明）' ] to deeply equal []`
    `AssertionError: expected [ 'cc-command-hint.conditions' ] to deeply equal []`
  - 往模型行加回 `inActiveSession: 'show'` → `Tests 3 failed | 1 passed`，红行原文：
    `AssertionError: expected '\nimport type { ThemeSettings } from …' not to contain 'inActiveSession'`
    `AssertionError: … expected [ 'inActiveSession（行上「活跃会话里显示/收起」申明）' ] to deeply equal []`
    `AssertionError: expected [ 'model.inActiveSession' ] to deeply equal []`
  - 两次改回后：`Test Files 2 passed / Tests 38 passed`（守卫 + 定义表）
- 等价表 / 高度计数（同一脚本 `E:\Acode\FILES\temp\cc-visibility-equiv.mts` 跑改造前后，逐行 diff）：
  - **唯一变化的控件 = 命令行提示**：`C 活跃会话 · 标准输入` 由「隐」→«显»；`D2 编辑模式 · 标准输入`、`D3 编辑模式 · 空态` 同样由隐变显（同一根因，见「偏差」1）
  - 逐项**未变**：空态 6 隐 1 显；活跃会话命令行 compact/full 7 显；命令行 + 详细档隐藏 提示隐；编辑模式命令行全显；`ccHidden` 仍能藏发送按钮
  - `visibleStatusWidgets`：会话无关入参 `4→5`（`hidden` 档仍为 4）；渲染侧空态 `0→0`；渲染侧活跃会话 cli `5→5`、`hidden` 档 `4→4`
  - `--cc-min-height`：cli/free 恒 64；cli/peri 渲染侧活跃会话 `109→109`、渲染侧空态 `84→84`、会话无关入参 `84→109`（见「偏差」2）
- 实机（`cargo build --bin pylon` → 带调试端口启动 → `mcp__pylon-webview2__*` 读 DOM，读完整组后关掉 App）：
  - 活跃会话 · 命令行（free）：`--cc-min-height 64px` / `--cc-height 96px`；状态行 `[model, reasoning, mode, tokens, cc-command-hint]`；提示 `205×19`
  - 标准输入模式：控制台类名由 `control-center cli-mode` 变 `control-center`；提示**仍在**状态行内、`205×19` ⇒ **本件目的实机达成**
  - 详细档 = 隐藏（标准输入模式）：状态行 `[model, reasoning, mode, tokens]`，DOM 里无提示元素
  - cli + peri：`--cc-min-height 109px`、`--cc-height 109px`、实测高度 109；存储 `ccHeight` 由 96 被 clamp 到 109（见「偏差」2）
  - 空态（cli + peri）：`is-empty`；只渲染 `input`；`.cc-status-group` 存在且 0 子件；`--cc-min-height 84px`
  - 空态（cli + free）：`.cc-status-row` 仍在且含 1 个子容器 ⇒ **空容器未变**
  - 编辑模式：`cc-editing` + 工具条 7 行（含「＋ 发送按钮 / 显示」）；6 个内置件全渲染
  - 控制台 error/exception 与后端 error 日志：**均 0 条**
  - ★ 实机数据为**手工驱动 UI** 取得（改的是用户真实主题），结束后**逐项改回原值**并核对：`inputMode=cli / inputVariant=cli / cliHintMode=compact / footerLayout=free / ccHeight=96 / ccHidden=['cc-send-button']`，sheets 状态回 `{sidebarMode:'work'}` 与 `{activePageId:null}`。

## 与 spec 的偏差

1. **等价表里除施工单 §2 那一处外，还有两处同根因的「出现」** —— 均为命令行提示：
   `编辑模式 × 标准输入`、`编辑模式 × 空态` 由隐变显。原因是**编辑态豁免隐藏名单**（既有设计）而条件（有会话 / 命令行模式）从来不豁免；
   撤条件后编辑态才真正「全显」，与施工单 §2 「编辑模式照旧全显（仅 `ccHidden` 豁免）」这句自述一致。
   ⇒ 判定为**同一根因**（提示不再按模式判明）的表现，非 §4-1 的「别处依赖这些申明」。**提请翻译确认**。
2. **计数调用点是 8 处，不是单子写的「6 处」**：单子那句枚举出来的文件与项数（`store.ts`×2、`themeFieldDefs.ts`、`migration.ts`、`presetReducer.ts`×2、`workbenchAppearanceStore.ts`×2 = 8）**与现场逐条一致**，只有合计数字写小了。
   §4-3 的判据是「组装函数签名够不够用」：8 处**全都拿得到 `cliHintMode`** ⇒ 按枚举执行，未停手。
3. **会话无关入参的最小高 `84→109`（cli + peri）**：计数不再按「有没有会话」把提示算作不可见 ⇒ 与渲染侧同源（这正是 §1-4 要求的「渲染与计数同源」）。
   §3-5 只写了「仅在活跃会话语境允许因提示多出而变化」，此处属**未列举的连带**：渲染侧数值本来就已是 109，变的是**存储/钳制侧**跟着对齐，
   用户可见的后果是「cli + peri 下 `ccHeight` 会被抬到 109」（实机已复现 96→109）。**未触发 §4-2**（空态数值 84 未变）。**提请翻译确认**。
4. **谓词 ctx 连 `inputMode` / `submitButtonMode` 一并删除**：§1-6 首句「谓词只剩 `ctx.hidden`」按字面执行；这两个字段在条件表撤掉后已无消费者（`submitButtonMode` 本来就已经没人读）。
   代价是计数函数的入参同步收窄，连带改了 3 份测试（见「测试处置」）。**若只打算撤点名的两个字段，请回退这一点**。
5. **`appearance.test.ts` / `presetReducerPureHelpers.test.ts` / `ccHeightState.test.ts` 三份未被单子点名**（单子 §3-8 只说「至少这些」）：
   均因计数口径变化而必须改数值，无删除、无降级断言。

## 未解问题

1. **发送按钮在编辑模式下仍不出现**：`ControlCenter.solid.tsx` 渲染它的 `<Show>` 用 `!appearance().ccHidden.includes('cc-send-button')`（**raw `ccHidden`、无编辑豁免**），
   而 `sendButtonMode()` 用的是名单 + 编辑豁免 ⇒ 同一文件里两条判据不一致。**存量缺陷，本件未动**（不在单子范围），实机已复现（编辑模式工具条给「显示」入口但件不在场）。
2. **隐藏的 keep-alive sheet 的中控 DOM 会滞后**：切走再切回前，hidden sheet 的中控仍按旧的外观快照渲染（读到的 `--cc-height` 是旧值）。
   存量现象，与本件无关；实机取证时已按「先激活再读」规避。
3. **空容器在 peri 布局下是 `.cc-status-group`**（没有 `.cc-status-row` 包裹元素）⇒ 施工单 §3-4 的「空容器仍在」在 peri 下按 group 容器判，已按此取证。

## 并行交集

- **⑦（`src/zones/**`）**：无文件交叠；`widgetDefinitionTable.test.ts` ⑦ 未触碰，无冲突。
- **④（同文件同区域）**：按单子要求叠在 ④ 的 tip 上开分支 ⇒ 本件与 ④ 一起进批量 PR。
- 本次碰过的共享文件：`src/domains/cc/widgetDefinitions.ts`、`src/renderers/solid-workbench/input/ControlCenter.solid.tsx`、
  `src/ccHeightState.ts`、`src/themeFieldDefs.ts`、`src/store.ts`、`src/domains/theme/{migration,presetReducer}.ts`、
  `src/domains/workbench/workbenchAppearanceStore.ts`、以及四份测试与一份新增守卫、契约快照。
