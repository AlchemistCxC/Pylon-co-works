# Dev Record — #460 #266 刀2 + 刀3 移植到重构后的 main（移植单，合一个 PR）

> 入库保留。施工单不保留，其目标、范围、方案与验收结论在此承接。
> 本单性质 = **移植**：只换落点、不改语义。两刀各自的语义记录见同目录
> `266-cc-visibility-two-layer-2-empty-box-and-gate.md` 与 `…-3-min-height-by-edges.md`（本单不重复抄语义）。
> 验收读数与红段全文另存仓外报告
> `E:\Acode\FILES\任务\工作台优化\报告等\10-施工单-移植刀2刀3到重构后的main（两刀合一个PR）\2026-09-29-工作者汇报.md`。

## 元信息

- issue：[#460](https://github.com/AlchemistCxC/Pylon-co-works/issues/460)（`enhancement(cc): #266 刀2 + 刀3 移植到重构后的 main（合一个 PR）`）；父级总账 [#266](https://github.com/AlchemistCxC/Pylon-co-works/issues/266)（**本单不关它** —— 刀 4 未做）
- 分支：`feat/cc-visibility-port.1`（从 `origin/main @ fd7fdbb0` 新建；建后已 `branch --unset-upstream`）
- 提交范围：**未提交**（施工单 §五.6：施工期不 commit / 不 push / 不开 PR；收口由翻译做）
- 日期：2026-09-29
- 依据：施工单 `待办\10-施工单-移植刀2刀3到重构后的main（两刀合一个PR）.md`
- 移植源：刀 2 = `35c41546`、刀 3 = `b25fa6a9`（分支 `feat/cc-visibility-two-layer.2`）
- ★ `git fetch origin` **失败**（`Recv failure: Connection was reset`，GitHub 连不通）；但本地 `origin/main` 已是 `fd7fdbb0`，**与施工单 §一 实测基线逐字符一致** ⇒ 不缺基线，按本地 ref 施工。

## 目标与范围

**目标**：在重构后的 main 上新建分支，把刀 2 / 刀 3 的**语义**重贴过去，合成一个 PR。

**不做**：刀 4（显示前校验 + 写入要认门）；不动 UI / 渲染结构 / CSS 观感；不引入新语义；不重贴刀 2.5；不顺手清别的待办（CC-29 后续扫描、`inputBorderColor` 与 `inputBorder` 重叠、会话绑定提示接线）。

## 改动清单

相对 `origin/main` = **30 个文件**（+ `src/store.ts` 相对 main 无净变化，见"方案要点 3"）。

**生产（14）**

| 文件 | 改动 |
| --- | --- |
| `src/domains/cc/widgetDefinitions.ts` | 刀2：切面概念 + `cliHintGoverned` 行声明 + 派生 `CLI_HINT_GOVERNED_WIDGET_IDS` + 删两处硬编码 + `resolveCcHiddenWidgetIds` 改门选一份 + `CC_SYSTEM_FIELDS`；刀3：`heightField` 行声明（4 行填值） |
| `src/domains/cc/ccHeightState.ts` | 刀3 主战场：`ROW_MIN_HEIGHT`/`VERTICAL_EDGE_FIELD`/`CcMinHeightGroup`/`CcMinHeightInput`/`ccMinHeightInputOf`/`resolveCcHeightGroups`/`resolveCcMinHeight`（两态取 max）/`sliceHeightRequirement`/`clampCcHeight(height, input)`；最小高族置于最小宽族**之上**。刀2 那 4 行注释随自动合并落位 |
| `src/domains/theme/themeTypes.ts` | 刀2：`ThemeSettings.ccHiddenEmpty: string[]` + 说明注释（**原在 `store.ts`**） |
| `src/domains/theme/themeStore.ts` | 刀3：import 加 `ccMinHeightInputOf`；`setCcHeight` / `setCcHidden` 两处 clamp 传算式输入（**原在 `store.ts`**，两行中文注释一并搬） |
| `src/domains/theme/presetReducer.ts` | 刀2：`inheritCcEmptySlice` + 3 个落值点；刀3：`clampPresetCcHeight` 补 DEFAULTS 标量 + cc 分支传合并视图 + 3 处 `syncPresetCcHeight` |
| `src/domains/theme/themeDefaults.ts` | 刀2：`DEFAULTS.ccHiddenEmpty` = 出厂空态 6 件 |
| `src/domains/theme/themeFieldDefs.ts` | 刀2：新字段 `ccHiddenEmpty`；刀3：`ccHeight.minFn` 按在场算；import 加 `ccMinHeightInputOf` |
| `src/domains/theme/migration.ts` | 刀3：读盘路径 clamp 传算式输入 |
| `src/domains/theme/presets/builtin.ts` | 刀2：`GLASS_THEME` +`ccHiddenEmpty`（6 件） |
| `src/domains/theme/zones/factory/gui-cc.ts` | 刀2：5 条 cc 区域预设各 +`ccHiddenEmpty`；尾注释计数 |
| `src/domains/theme/zones/factory/terminal-cc.ts` | 同上 |
| `src/domains/appearance/appearance.ts` | 刀2：快照平铺 + 冻结 + 类型 |
| `src/domains/appearance/workbenchAppearanceStore.ts` | 刀2：边界夹具同处置；刀3：两处 clamp 传算式输入 + **删**重复的"输入栏抬高"规则 |
| `src/domains/appearance/workbenchSkinContract.ts` | 刀2：`ccHiddenEmpty` 与 `ccHidden` 同处置 |
| `src/renderers/solid-workbench/input/ControlCenter.solid.tsx` | 刀2：`hiddenWidgetIds()` 组装 + import 去名单常量；刀3：`minHeight()` 改算式值 |

**测试（10）+ 快照（1）**

| 文件 | 性质 |
| --- | --- |
| `src/domains/cc/__tests__/ccVisibilitySliceGuard.test.ts` | 新增（刀2 守卫 13 条） |
| `src/domains/cc/__tests__/ccHeightState.test.ts` | 修改（刀3 最小高度整组重写 + 两态取 max） |
| `src/domains/cc/__tests__/widgetDefinitionTable.test.ts` | 修改（刀2 语义改写 + 刀3 `heightField` 属主守卫） |
| `src/domains/appearance/__tests__/zustandWorkbenchAppearanceStore.test.ts` | 新增（刀3 生产通路 3 条） |
| `src/domains/appearance/__tests__/appearance.test.ts` | 修改 |
| `src/domains/theme/__tests__/presetReducer.test.ts` / `presetReducerPureHelpers.test.ts` | 修改 |
| `src/domains/theme/__tests__/settingsTraceability.test.ts` | 修改 |
| `src/__tests__/effectivePresetTheme.test.ts` | 修改（基线重算 + 视图键白名单） |
| `src/renderers/solid-workbench/__tests__/mountSolidControlCenterPreview.solid.test.tsx` | 修改 |
| `src/renderers/solid-workbench/__fixtures__/workbench-skin-baseline.json` | 契约快照（`--write` 后已还原时间戳噪声） |

**记录（3）**：`266-…-2-empty-box-and-gate.md`、`266-…-3-min-height-by-edges.md`（随 cherry-pick 带入）+ 本文件。

**未动**：`…/styles/components/ControlCenter.css`（刀 2.5 已在 main、与 `b25fa6a9` 逐字节一致 ⇒ 零改动）、`mountSolidWorkbench.solid.test.tsx`、`workbenchChromeCss.solid.test.ts`（同理由）、`src-tauri/**`、`src/workspace-sheets/**`。

## 方案要点

### 1 方法：`cherry-pick -n`（不走 merge）

```bash
git cherry-pick -n 35c41546     # 刀2 → 3 处冲突
git cherry-pick --quit          # 保留改动、清 sequencer、不产生提交
git cherry-pick -n b25fa6a9     # 刀3 → 6 处冲突 + store.ts modify/delete
git cherry-pick --quit
```

`--quit` 而非 `--continue`：后者会落提交，违反施工单 §五.6。

### 2 搬家映射（git rename 检测吃掉 16 个文件）

刀2 实测只剩 **3 处**人工解（与施工单 §2.2 预测一致）：

| # | 冲突 | 解法 |
| --- | --- | --- |
| 1 | `src/domains/cc/widgetDefinitions.ts`（content，文件头注释） | **双方保留**：main 侧刀 2.5 的 `detachX` 段落原样留 + 刀 2 的新显隐口径，弃 HEAD 的旧「两种承载」段 |
| 2 | `src/renderers/solid-workbench/input/ControlCenter.solid.tsx`（content，import） | 取 HEAD 的新路径 `../../../domains/theme/tokenFormat.ts` + 刀 2 的 import 名单（去掉 `EMPTY_STATE_HIDDEN_WIDGET_IDS`） |
| 3 | `src/store.ts`（modify/delete） | `git rm`，其 7 行按"要点 3"落到两个新文件 |

刀3 实测 **6 处 + store.ts**：

| # | 冲突 | 解法 |
| --- | --- | --- |
| 1 | `src/domains/cc/ccHeightState.ts`（import） | 加 `type CcNumberPropertyKey` |
| 2 | `src/domains/appearance/workbenchAppearanceStore.ts`（import） | 取 HEAD 路径 + 刀 3 的 `ccMinHeightInputOf` |
| 3 | `src/domains/theme/themeFieldDefs.ts`（import） | 同上（5 行 import 全取 HEAD 路径，只加标识符） |
| 4 | `src/domains/theme/migration.ts`（import） | 同上 |
| 5 | `src/renderers/solid-workbench/input/ControlCenter.solid.tsx`（import + `minHeight()`） | 取刀 3 的算式写法 |
| 6 | `src/domains/cc/__tests__/ccHeightState.test.ts`（import） | 加 `ccMinHeightInputOf` / `resolveCcHeightGroups` |
| 7 | `src/store.ts`（modify/delete） | `git rm` |

### 3 `store.ts` 那 7 行落到哪（唯一需要动脑处）

| # | 原位置 | main 落点 | 内容 |
| --- | --- | --- | --- |
| 1 | `ThemeSettings` 接口（刀 2） | `src/domains/theme/themeTypes.ts`（`ccHidden` 之后） | `ccHiddenEmpty: string[]` + 4 行说明注释（含「写 `[]` 是显式选择」口径），**连注释搬** |
| 2 | `import { clampCcHeight } from './domains/cc/ccHeightState.ts'`（刀 3） | `src/domains/theme/themeStore.ts` | 改 `import { clampCcHeight, ccMinHeightInputOf } from '../cc/ccHeightState.ts'` |
| 3 | `setCcHeight` / `setCcHidden` 两处 clamp（刀 3） | 同文件 | `clampCcHeight(height, ccMinHeightInputOf(state))`；`setCcHidden` 先算新名单再传 `ccMinHeightInputOf({ ...state, ccHidden })`（两处口径一致才有"藏一件 ⇒ 最小高变小"）。★ 两行中文注释（`D1：…` 与 `★ #266 刀3：…`）一并保留 |

### 4 刀 2.5 一律不重贴

`git diff origin/main b25fa6a9` 在三个刀 2.5 文件上**为空**（逐字节一致）：

```
src/renderers/solid-workbench/__tests__/mountSolidWorkbench.solid.test.tsx    IDENTICAL
src/renderers/solid-workbench/__tests__/workbenchChromeCss.solid.test.ts      IDENTICAL
src/plugins/product/packages/builtin.pylon-renderers/styles/components/ControlCenter.css  IDENTICAL
```

三方合并因此判定"双方相同"、无改动可落 ⇒ 无需人工跳过；`ControlCenter.css` 最终**一个字未动**。

### 5 ★ 移植中发现的偏差（4 处，均已处置/上报）

1. **刀 3 提交里混入的刀 2.5 宽度测试块被重复贴了一份**：`ccHeightState.test.ts` 出现**两个**同名的
   `describe('ccHeightState 最小宽度（#266 刀2.5 · 与最小高同构）')`（各 70 行、**逐字相同**）。
   起因：三方合并的 base（`35c41546`）没有该块 ⇒ theirs 整块新增，而 ours（main）已有一份。
   处置：**删掉重复的那一份**（保留 main 原有位置的那份）。判据：刀 2.5 味命中数 21 → 41（重复）→ **21**（= main 同值）。
2. **新文件里的旧路径 import**（`tsc -b` 抓出，`test` 抓不到——§七.4 的又一实例）：
   - `ccVisibilitySliceGuard.test.ts`：`../../../presets/index.ts` → `../../theme/presets/index.ts`；`../../../zones/index.ts` → `../../theme/zones/index.ts`
   - `zustandWorkbenchAppearanceStore.test.ts`：`../../../store.ts` → `../../theme/themeStore.ts`
3. **`zustandWorkbenchAppearanceStore.test.ts` 落错目录**：cherry-pick 按刀 3 的旧路径放在 `src/domains/workbench/__tests__/`；按施工单 §1.1 的映射 `git mv` 到 `src/domains/appearance/__tests__/`（与 `appearance.test.ts` 同域）。
4. **`ControlCenter.solid.tsx` 的 `minHeight()` 注释在源存档点里已过时**（未自行修改、留报告）：仍写
   "★ 在场集合取**常态切面**（`appearance().ccHidden`）"，而退改后 `ccMinHeightInputOf` 已**内部拼两态**。
   按"移植 = 只换落点"未改。

### 6 基线按探针实测复核（不照抄）

`.agents/spec/266-probe-preset-counts.mts`（仓外工具，gitignore；仅修其 import 路径）实测：

```
THEME_SETTING_KEYS=177
claude/nord/tokyo/solarized/amber/matrix = 177 ; glass = 64 ; agent-command/map/focus-flow = 37
```

⇒ 与刀 2 当时重算的 `177 / 64 / 37` 一致；`effectivePresetTheme.test.ts` 的 `BASELINE_FIELD_COUNTS` 与视图键白名单（`ccHiddenEmpty`）已同步。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| 分支从 `origin/main`（`fd7fdbb0`）新建，非 merge | ✅ 有上游已解；`git status -sb` 无 tracking |
| 两刀语义落位（生产 14 文件） | ✅ 抽查：`themeFieldDefs:247` 新字段、`presetReducer` 的 `inheritCcEmptySlice` 4 处、`themeDefaults:24` 出厂 6 件、`cliHintGoverned`/`CLI_HINT_GOVERNED_WIDGET_IDS`/`heightField` 在场 |
| 旧路径零残留（§七.6） | ✅ `src/store.ts` / `themeFieldDefs.ts` / `presets/` / `zones/` 均无跟踪；相对 main 无 `src/store.ts` 净变化 |
| 刀 2 语义删除自洽（§七.2） | ✅ main 侧引用面恰好 4 个文件（无第 5 个）；当前生产源码零命中（只剩注释） |
| 守卫正控字面量仍在（§七.1） | ✅ `widgetDefinitions.ts` 注释含 `inActiveSession` 与 `EMPTY_STATE_HIDDEN_WIDGET_IDS` |
| 无刀 2.5 新增（§九.b） | ✅ 逐文件扫：三处命中分别为「comment 里引用 `resolveCcWidthGroups`」「import 行（`resolveCcMinWidth` 本就在 main 该行）」「已删除的重复块」；无重贴 |
| 快照 `themeSettingCount` = 177（§六.3） | ✅ `176 → 177`；`--write` 后**只有 `generatedAt` 变** ⇒ 已按 §六.4 还原 |
| 五步门禁 + clippy（§六.1/2） | ✅ 见"证据" |
| 反向验证 4 轮全红（§六.5） | ✅ 见"证据" |
| 实机四组读数 = 85 / 64 / 85 / 130（§六.6） | ✅ 逐条命中；「藏显一件 = 85 ⇄ 64」 |

## 测试处置

- **未修改任何既有行为测试的判据**：所有测试改动均来自被移植的两个存档点本身（随 cherry-pick 落位）。
- **新增**：`ccVisibilitySliceGuard.test.ts`（13 条，刀2）、`zustandWorkbenchAppearanceStore.test.ts`（3 条，刀3 生产通路）。
- **被移植改写的既有文件**：`ccHeightState.test.ts`、`widgetDefinitionTable.test.ts`、`appearance.test.ts`、`presetReducer.test.ts`、`presetReducerPureHelpers.test.ts`、`settingsTraceability.test.ts`、`effectivePresetTheme.test.ts`、`mountSolidControlCenterPreview.solid.test.tsx`（口径与两刀记录一致，本单未再改动）。
- **移植期唯一改动测试的动作**：删除 `ccHeightState.test.ts` 里被重复贴入的那份刀 2.5 宽度块（见"方案要点 5.1"）——删除的是**重复副本**，保留的那份与 main 逐字相同。

## 证据

- commit：**无**（未提交；施工单 §五.6）
- 分支基线：`fd7fdbb0`（= `origin/main`）
- 门禁（均为真实退出码）：
  - `bun run lint` → exit 0（0 error / 1 warning；该 warning 在 `src/sheets/gateway/GatewaySheetView.tsx`，**不在改动面**）
  - `bun run build:example-plugin` → exit 0
  - `bun run build` → exit 0
  - `bun run check:solid` → exit 0（含"ZONE_FIELDS 一致性契约通过（177 个主题字段）"）
  - `bun run test` → exit 0，`Test Files 655 passed | 1 skipped (656)`、`Tests 5095 passed | 1 skipped | 1 todo (5097)`
  - `bun run check:clippy` → exit 0，全 crate `added: []`
  - 契约快照检查 → exit 0，"主题字段 177 个"
- 反向验证（每轮跑**整份测试文件**、不用 `-t` 名字过滤；逐轮"改坏 → 红 → 贴红 → 改回"）：
  | 轮 | 破坏点 | 红 |
  | --- | --- | --- |
  | ① 刀2 删名单打回旧写法（折叠改回写死 `cc-command-hint` id） | `widgetDefinitions.ts` | `Tests 2 failed \| 11 passed (13)` / EXIT=1 |
  | ② 刀2 门选一份打回并集 | `widgetDefinitions.ts` `resolveCcHiddenWidgetIds` | `Tests 3 failed \| 37 passed (40)` / EXIT=1 |
  | ③ 刀3 两组 max 改 sum | `ccHeightState.ts` `sliceHeightRequirement` | `Tests 5 failed \| 9 passed (14)` / EXIT=1（`expected 93 to be 64`） |
  | ④ 刀3 在场集合退回"只算常态切面" | `ccHeightState.ts` `resolveCcMinHeight` | `Tests 1 failed \| 13 passed (14)` / EXIT=1（`expected 64 to be 75`） |
  - 4 轮全红、4 轮已还原（`git diff` 归零），复跑三份测试 = `67 passed`。
- 实机验收（真实 Tauri/WebView2）：`bun run build` → `cargo build`（1m10s）→ `src-tauri/target/debug/pylon.exe`（WebView2 `Edg/153.0.4234.48`，调试端口 9222 内置）。
  现场数据：`inputOffsetTop=10`、`inputHeight=40`、`ccMarginBottom=15`、`modelHeight=70`、`reasoningHeight=28`、`permissionHeight=28`。
  | # | 两份切面（常态 / 空态） | 预测 | 实测 `--cc-min-height` |
  | --- | --- | --- | --- |
  | A | `['cc-send-button']` / 出厂空态 6 件 | 85 | **85px** |
  | B | 两态都藏 `model` | 64 | **64px** |
  | ★ C | 常态藏 `model+reasoning+mode`；空态只藏 `send-button` | 85 | **85px** |
  | D | 两态都只藏 `send-button`，`inputHeight=120` | 130 | **130px** |
  - ★ **C 组即"两态取 max"的活证据**：门关那台中控在场 = `tokens, cc-command-hint`（常态算式 15+28=43），门开那台在场 = `model, reasoning, mode, tokens, cc-command-hint`（空态算式 15+70=85）⇒ 取 max = 85；旧"只算常态"口径会得 64。
  - 「藏显一件 = 85 ⇄ 64」：A(85) → B(64) → 还原(85)，双向均已复现。
  - 后端日志：本窗口 `error` / `warn` **各 0 条**；启动链健康（`hydrated` 192–208ms、`ready` 271–332ms）。
- 数据安全：改动前**先关 App**，整目录备份 `%APPDATA%\com.prism.desktop`（336K）+ `%LOCALAPPDATA%\com.prism.desktop`（176M）到
  `E:\Acode\FILES\_backup\pylon-data-20260929-cc-port-460\`；另在 page 内另存一份 `pylon-theme`。
  验收后逐字节写回并重载复核（`themeLen=4941` 与原始同、临时键已清、`ccHidden/inputHeight/modelHeight/ccMarginBottom/ccHeight` 逐项回原值 ⇒ 读数回 **85px**）；
  再次冷启动从**磁盘**复读：`themeLen=4941`、无临时键、读数 85px ⇒ 磁盘态 = 还原态。
  **会话主库 `pylon-data-v1.sqlite3` mtime 未变**（仍 `Sep 28 20:08`）⇒ 本次验收未写入后端数据。验收后已关 App、9222 无监听者。

## 与 spec 的偏差

移植单本身无 spec；与施工单的偏差如下：

1. **刀3 提交里混入刀 2.5 内容导致的重复块**（施工单 §2.3 只把"刀 2.5 味 hunk 一律跳过"作为预测、未点明"会重复贴"）：实测重复发生在 `ccHeightState.test.ts` 的**整块**（不止 hunk），已删重复份（"方案要点 5.1"）。**这是施工单预测之外的新增动作**，动作性质 = 去重（不改语义、不改断言）。
2. **修 3 处旧路径 import + `git mv` 1 个新测试文件**：均为"落点适配"（§2.4 的兜底情形），不改语义。
3. **未回写 issue 评论区**（施工单 §八.4 列为"必做"）：与本次交接话第 7 条"施工期不存档、不推送、不开 PR；收口由翻译做"存在张力 ⇒ 按优先级（用户当场口径 > 文档）**留作收口项**，未执行。`#460` 的 assignee 已按交接话第 5 条设为本人。
4. **未写 L.md 之外的新增声明**：`.agents/L.md` 已按 §八.3 声明范围（**未提交**，见"并行交集"）。

## 未解问题

1. **issue 评论区未回写**（§八.4）——见"与 spec 的偏差 3"；PR 未开（收口项）。
2. **`ControlCenter.solid.tsx` 的 `minHeight()` 注释过时**（源存档点自带，见"方案要点 5.4"）：建议随收口或刀 4 一并改一行（把"在场集合取常态切面"改成"两态各算一遍取 max，由 `ccMinHeightInputOf` 拼装"）。**本单按"只换落点"未动**。
3. **`git fetch origin` 不通**（`Recv failure: Connection was reset`）：本次靠本地 `origin/main @ fd7fdbb0` 与施工单基线一致施工；若期间远端 main 前进，收口前需重新对齐（但改动面是主题域，冲突面小）。
4. **刀 4 未做**：`#266` 不关闭；"空态下切显隐写错切面"（刀 2 记录 §未解问题 1）仍悬。

## 并行交集

本单在 `feat/cc-visibility-port.1` 上施工，**未提交任何内容**；`.agents/L.md` 已声明条目（未入库，收口由翻译做）。

- **碰过的共享文件域**（供避让）：`src/domains/cc/**`、`src/domains/theme/**`（含 `presets/`、`zones/factory/`）、`src/domains/appearance/**`、`src/renderers/solid-workbench/input/ControlCenter.solid.tsx`、`src/renderers/solid-workbench/__tests__/mountSolidControlCenterPreview.solid.test.tsx`、`src/renderers/solid-workbench/__fixtures__/workbench-skin-baseline.json`、`src/__tests__/effectivePresetTheme.test.ts`。
- **`src/domains/theme/themeTypes.ts` / `themeStore.ts`**：本次是这两个文件在 main 上**首次收到 #266 域内容**（`ccHiddenEmpty` 字段与两处 clamp）——`#266` 后续刀（刀 4）与任何动主题 store 的分支需在此之上叠加。
- **`ControlCenter.css` 零改动**：刀 2.5 已在 main；`#410` 等动该 CSS 的分支与本单**不重叠**。
- **`themeSettingCount` 176 → 177**：动皮肤契约 / 主题字段面的在途件需同步这个基数。
- **`.agents/spec/266-probe-preset-counts.mts`**：仓外工具（gitignore），本次只修其 import 路径（旧 `src/presets/` → `src/domains/theme/presets/`），不入库。
- **共享 index 状态**：本次用 `cherry-pick -n` ⇒ 改动**已 staged**；全部改动均已暂存（`git diff --name-only` 为空）。收口提交请一律用 pathspec。

---

# §十 退改 D1（2026-09-29 · 翻译验收后追加，本次施工）

> 施工单 §十 D1。性质 = **纯注释**（6 处过期口径说明），零行为影响。
> 起因：移植交付后翻译验收发现 6 处注释仍写「在场集合 = 常态切面」，与退改后的**两态取 max** 事实不符。

## D1-1 六处前后对照

| # | 文件 | 改前（行号） | 改后（行号） |
| --- | --- | --- | --- |
| 1 | `src/domains/theme/presetReducer.ts` | `86`「★ 隐藏名单口径 = **常态切面**（见 `ccHeightState.resolveCcMinHeight` 的口径说明）。」 | `86-88`「★ 在场集合口径 = **两态各算一遍取 max**（`ccMinHeightInputOf` 交出常态 + 空态两份切面，`resolveCcMinHeight` 逐态各算一遍取大 ⇒ 下界由**要求更高的那一份**决定，常态 / 空态都可能成为绑定项；…）」 |
| 2 | `src/domains/theme/migration.ts` | `231`「★ #266 刀3：下界 = 按边算取最大（**常态切面口径**）。此处 state 已过结构对齐（`ccHidden` 必是数组、数字字段都有值）⇒ …」 | `231-233`「…（**两态各算一遍取 max**）。…（`ccHidden` 必是数组、数字字段都有值；`ccHiddenEmpty` 缺省时由 `ccMinHeightInputOf` 回落常态切面）⇒ …」 |
| 3 | `src/domains/theme/themeFieldDefs.ts` | `228`「设置页这条下界按**常态切面**的在场集合算（同落值侧 / 读盘侧口径，见该函数的"在场集合"节）。」 | `228`「设置页这条下界对**两态切面**各算一遍取 max（同落值侧 / 读盘侧口径，见该函数的"两种门态取 max"节）。」 |
| 4 | `src/domains/theme/themeStore.ts` | `147-148`「显隐一变，最小高跟着变 ⇒ 高度必须重过 clamp（下界**恒取常态切面**，而这里正是写常态切面的地方 —— 两处口径一致，"藏一件 ⇒ 最小高变小"由此成立）」 | `147-149`「显隐一变必须重过 clamp —— 这里写的正是**常态切面**，它一变、常态那一份算式就变。但下界取「两态中要求更高的那一份」⇒ 常态变矮**不一定**抬得动下界：空态那一份可能仍咬住，所以"藏一件 ⇒ 最小高变小"**不再必然成立**。」 |
| 5 | `src/renderers/solid-workbench/input/ControlCenter.solid.tsx` | `292-293`「★ 在场集合取**常态切面**（`appearance().ccHidden`）：与落值侧 / 设置页同一口径 —— 同一个值算两处…」 | `292-294`「★ 在场集合 = **两态各算一遍取 max**（`ccMinHeightInputOf(appearance())` 交出常态 + 空态两份切面，`resolveCcMinHeight` 逐态取大 ⇒ 下界由要求更高的那一份决定）：与落值侧 / 设置页同一口径…」 |
| 6 | `src/domains/appearance/workbenchAppearanceStore.ts` | `125`「显隐一变（`set-cc-hidden`）最小高跟着变 ⇒ 下界**恒按常态切面**算（同 **`store.setCcHidden`**）」 | `125-126`「显隐一变（`set-cc-hidden`）必须重过 clamp ⇒ 下界按**两态各算一遍取 max** 算（同 **`themeStore.setCcHidden`**）：常态那一份变了则常态算式变，而空态那一份可能仍咬住下界。」 |

★ 第 6 处顺带修掉过时模块引用：`store.setCcHidden` → `themeStore.setCcHidden`（`src/store.ts` 重构后已不存在）。

## D1-2 硬约束遵守情况

1. **只改注释** ✅ 两条独立证据：
   - 逐行看 diff：6 个文件的 `+` / `-` 行**全部**以 `*` 或 `//` 开头（`grep` 非注释行 = 空）；
   - **剥注释后逐字比对**：写了逐字符词法器的校验脚本 `报告等\<单子>\03-comment-only-check.mjs`，对每个文件取 `git show :<path>`（= 交付态）与工作树版本各剥注释 ⇒ **六个文件全部 `SAME`**。
     ★ 第一版用正则剥注释时 4 个文件报 `DIFF` —— 是**正则的假阳性**（未正确处理字符串内的 `//` / `/*…*/` 边界），换词法器后全 `SAME`。**结论以后者为准**。
2. **未碰含 `inActiveSession` 字面量的注释** ✅ 本次 6 处只在 `theme/*`、`appearance/*`、`renderers/…/ControlCenter.solid.tsx`；`widgetDefinitions.ts` **一个字未动**（`grep -c inActiveSession` 仍为 **2**）。
3. **改完跑整条门禁** ✅ 见 D1-3。

## D1-3 门禁（D1 之后重跑，全 exit 0）

| 步骤 | 结果 |
| --- | --- |
| `bun run lint` | exit 0（0 error / 1 warning；warning 在 `GatewaySheetView.tsx`，**非改动面**） |
| `bun run build:example-plugin` | exit 0 |
| `bun run build` | exit 0 |
| `bun run check:solid` | exit 0（含「ZONE_FIELDS 一致性契约通过（177 个主题字段）」） |
| `bun run test` | exit 0：`Test Files 655 passed \| 1 skipped (656)`、`Tests 5095 passed \| 1 skipped \| 1 todo (5097)` |
| `bun run check:clippy` | exit 0，6 个 crate 全 `added: []` |
| 三个读源码文本的守卫（单独跑） | exit 0：`ccVisibilityDeclarationGuard` 4 + `ccDeadDataGuard` 4 + `ccVisibilitySliceGuard` 13 = **21 passed** |

★ 计数与 D1 之前**逐项相同** ⇒ 零行为影响由全套测试独立佐证。日志 `报告等\<单子>\01b-gates-after-D1.log`。

## D1-4 事实基线漂移（一并记）

施工期间 `origin/main` 前进了 **1 个提交**：`fd7fdbb0` → **`33076bfc`**
（`ci(release): 预演模式产物留痕——dispatch 不再「绿 run 两手空空」 (#459)`）。

- 影响面：`.github/workflows/release.yml` + 新增 `.agents/records/2026-09-29-release-ci-dryrun-artifacts.md`，**与本单任何文件不重叠** ⇒ 收口合并 / rebase 无实质冲突。
- 本单仍按施工单 §一 写的基线 `fd7fdbb0` 施工，未随之变动；**收口前需把 main 并入再跑一次门禁**。
- ⇒ 因这一提交，`git diff origin/main` 会把变更面报成 **32 个文件**（多出的 2 个是 **main 侧新增、本分支未含**）；**本单自身的变更面仍是 30 个文件**。
- 另：本次开头 `git fetch origin` 失败（`Connection was reset`），随后（16:1x）重试成功，`origin/main` 即前移至 `33076bfc`。
