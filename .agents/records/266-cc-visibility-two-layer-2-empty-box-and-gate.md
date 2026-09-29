# Dev Record — #266 刀 2 空态收成「盒子 + 一道门」（显隐两层模型）

> 入库保留。施工单不保留，其目标、范围、方案与验收结论在此承接。
> **注**：本记录的验收读数与红段全文另存仓外报告
> `E:\Acode\FILES\任务\工作台优化\报告等\09-施工单-空态收成盒子与一道门（刀2）\2026-09-28-工作者汇报.md`。

## 元信息

- issue：[#266](https://github.com/AlchemistCxC/Pylon-co-works/issues/266)（显隐与布局的两层模型 · **刀 2**）
- 分支：`feat/cc-visibility-two-layer.2`（从 `origin/main @ 9229f564` 新建；建后已解上游跟踪）
- 提交范围：**未提交**（施工单要求不 commit / 不 push / 不开 PR）；工作树 18 个文件
- 日期：2026-09-28
- 依据：施工单 `待办\09-施工单-空态收成盒子与一道门（刀2）.md`；规范 §六 / §7.9 / §八
- 上游：刀 1（谓词去豁免，#426）已在 main（`4a3fa0de`）；本刀与刀 2.5（#431，评审中）/ 刀 3 互不依赖

## 目标与范围

**目标**：把"空态"从「按元件硬编码的名单 ∪ 预设名单」收成两层 —— ① 预设多带一份**空态切面**（与常态切面同形：显隐）；② 一道**门**（"现在是不是空态"）；取值 = 二选一，缺省回落常态切面。并消灭另一处"按元件特判"：折叠逻辑里写死的命令行提示 id 改成**件自述声明**。

**不做**：不动谓词 `isWidgetVisible` 与刀 1 的在场语义；位置不进盒子（留扩展位）；不动横向（刀 2.5）、不动高度算式（刀 3）、不改任何 UI / 渲染结构；不做"显示前校验"（刀 4）。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src/domains/cc/widgetDefinitions.ts` | 切面概念类型 `CcVisibilitySlice`；行声明 `cliHintGoverned`（`cc-command-hint` 行 = true）；派生 `CLI_HINT_GOVERNED_WIDGET_IDS`；删 `EMPTY_STATE_HIDDEN_WIDGET_IDS` 与 `COMMAND_HINT_WIDGET_ID`；`resolveCcHiddenWidgetIds` 改"门选一份 + 按声明折叠"；`CC_SYSTEM_FIELDS` +`ccHiddenEmpty`；表头/口径注释同步 | 修改 |
| `src/renderers/solid-workbench/input/ControlCenter.solid.tsx` | `hiddenWidgetIds()` 组装处（门 + 两份切面）；import 去名单常量 | 修改 |
| `src/domains/theme/presetReducer.ts` | 新增 `inheritCcEmptySlice`（预设没写空态切面 ⇒ 抄常态切面），接 3 个落值点：`applyZonePresetReducer` / `setGlobalPresetReducer` / `applyCustomPresetReducer` | 修改 |
| `src/domains/theme/themeDefaults.ts` | `DEFAULTS.ccHiddenEmpty` = 出厂空态 6 件（非空；理由见下"方案要点 3"） | 修改 |
| `src/themeFieldDefs.ts` | 新字段 `ccHiddenEmpty`（cc 区 / hidden / noCssVar） | 修改 |
| `src/store.ts` | `ThemeSettings.ccHiddenEmpty: string[]` | 修改 |
| `src/domains/workbench/appearance.ts` | 快照平铺 + 冻结 + 类型 | 修改 |
| `src/domains/workbench/workbenchSkinContract.ts` | 边界夹具：`ccHiddenEmpty` 与 `ccHidden` 同处置 | 修改 |
| `src/domains/cc/ccHeightState.ts` | 仅注释（名单组成描述） | 修改 |
| `src/presets/builtin.ts` | `GLASS_THEME` +`ccHiddenEmpty`（6 件） | 修改 |
| `src/zones/factory/gui-cc.ts` | 5 条 cc 区域预设各 +`ccHiddenEmpty`；尾注释计数 | 修改 |
| `src/zones/factory/terminal-cc.ts` | 5 条同上 | 修改 |
| `src/domains/cc/__tests__/ccVisibilitySliceGuard.test.ts` | **新守卫 13 条**（源码级 / 数据级 / 行为级） | 新增 |
| `src/domains/cc/__tests__/widgetDefinitionTable.test.ts` | 按新语义改写（+3 新 / −1 删 / 若干条改口径） | 修改 |
| `src/renderers/solid-workbench/__tests__/mountSolidControlCenterPreview.solid.test.tsx` | 空态那块改由预设切面驱动 + 新增门开/门关读数用例 | 修改 |
| `src/__tests__/effectivePresetTheme.test.ts` | 基线按探针实测重算（176/63/36 → 177/64/37）+ 白名单补键 | 修改 |
| `src/domains/theme/__tests__/settingsTraceability.test.ts` | hidden 字段登记表 +`ccHiddenEmpty`（该用例明确要求新 hidden 字段登记） | 修改 |
| `src/renderers/solid-workbench/__fixtures__/workbench-skin-baseline.json` | 契约快照重拍（`--write`） | 修改 |

## 方案要点

1. **切面（盒子）**：`ccHidden`（常态）/ `ccHiddenEmpty`（空态）都是 `cc` 区的普通主题字段 ⇒ 预设可携带、可持久化、区域预设可只给一份。取值规则唯一一处 `resolveCcHiddenWidgetIds`：门 → 选一份 → 详细档折叠。
2. **门**：沿用 `emptyVisual()`（`!input().sessionId || sessionEntering()`），一个字没改，只把它从"并集开关"变成"取哪一份"。
3. ★ **"缺省回落常态切面"落在预设落值这一步**（`inheritCcEmptySlice`），不在读侧。理由：读侧判"没写"需要 `ccHiddenEmpty` 可为 `undefined`，而两条既存硬约束不许（`themeDefaults.test`「每个主题字段都要有默认值」+ skin contract「fixture 不得缺字段」）。落点前移后：① 读侧保持纯二选一；② `DEFAULTS.ccHiddenEmpty` 可以非空（= 出厂空态 6 件），保住"空态极简"这一既成行为（新装 / 未套预设时）；③ 顺带获得"预设写 `[]` = 显式空态不藏任何件"的表达力。
   - ★ 代价（已向翻译/用户点名）：对**存量安装**（磁盘无此键且未套预设），空态取 `DEFAULTS` 基准而非用户自己那份常态切面。备选方案与改法写在报告 §8-A。
4. **折叠改件声明**：删 `COMMAND_HINT_WIDGET_ID`，改由 `CLI_HINT_GOVERNED_WIDGET_IDS`（表里 `cliHintGoverned === true` 的行派生）参与折叠 —— 折叠逻辑不再认任何写死的元件 id。
5. **不 bump `THEME_SCHEMA_VERSION`**：按 `migration.ts` 现行口径（加字段不 bump，结构对齐每次读盘无条件跑）。
6. 出厂数据取值 = 刀 2 之前那份代码侧名单的**逐字搬运** ⇒ 出厂观感不变（重构，不是改观感）。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| 两处特判已消失（生产源码 grep） | ✅ 代码级 0 命中（两处剩余命中都在注释里）；守卫逐条钉住 |
| 取值已是二选一 | ✅ 组装处 / `resolveCcHiddenWidgetIds` 均无并集写法 |
| ★ 实机：门开/关各取一份；改一项只在门开反映 | ✅ 真机两态并列读数：门关缺席集合 == `ccHidden`、门开缺席集合 == `ccHiddenEmpty`，差异项互不串味 |
| 缺省回落（不报错） | ✅ 行为级用例（区域预设 / 整份主题两条路径）；数据面装配全绿 |
| ★ 切面键集守卫 + 反向验证 | ✅ 13 条新守卫；反向验证 4 轮全红（见报告 §6） |
| 出厂预设数据 + 基线按探针实测重算 | ✅ 10 套各 +1 键；`177/64/37` |
| 门禁五步 + 快照重拍 | ✅ exit 0 × 6（`bun run test` 663 文件 / 5127 用例） |

## 测试处置

- **新增**：`src/domains/cc/__tests__/ccVisibilitySliceGuard.test.ts`（13 条）——① 源码级：两处特判剥注释后 0 命中、折叠管辖集来自件声明；② 数据级：出厂 10 条各带非空空态切面、键集字面量锁死、两种切面取值必须是当前可拖元件 id、`DEFAULTS` 基准 = 6 件、两条默认预设也带；③ 行为级：`inheritCcEmptySlice` 的回落 / 显式空 / 纯函数 / 整份主题路径。
- **改写（未放宽断言）**：
  - `widgetDefinitionTable.test.ts`：删「空态隐藏 6 条」字面量用例（保护移入守卫，原位留指针注释）；「成员 id 不得落进空态隐藏名单」→「切面取值名只允许可拖元件」；可见性 describe 改名并新增 3 条（门开/关二选一、读侧纯二选一、折叠只读件声明）；详细档/空态/计数三条只补必填参数与新语义；系统桶 2→3、cc 字段总数 68→69。
  - `mountSolidControlCenterPreview.solid.test.tsx`：空态那块改为"预设带了空态切面"（题材写入 `ccHiddenEmpty`，断言照旧）；新增门开/门关各读一份切面的 DOM 用例。
  - `effectivePresetTheme.test.ts`：基线重算 + 视图键白名单补 `ccHiddenEmpty`。
  - `settingsTraceability.test.ts`：hidden 字段登记表 +1（用例本身要求）。
- **未改（跑过，绿）**：`ccVisibilityDeclarationGuard` / `ccHeightState` / `ccDeadDataGuard` / `ccPrunedFieldsGuard` / `ccSettingsGrouping` / `ccLayoutV8` / `presetAssembly` / `defaultPresets` / `factoryZonePresets` / `themeDefaults` / `appearance`。

## 证据

- commit：**无**（未提交；施工单要求）
- 测试：`bun run test` → `Test Files 663 passed | 1 skipped (664)`、`Tests 5127 passed | 1 skipped | 1 todo (5129)`、EXIT 0（基线 662/5111）
- 门禁：`lint` / `build:example-plugin` / `build` / `check:solid` / `test` / `check-workbench-theme-contract.mts --write` 全 exit 0
- 反向验证：4 轮（切面键集 / 源码级 / 门 / 回落），每轮都变红，红段全文在仓外报告
- 实机：`bun run build` → `cargo build` → `src-tauri/target/debug/pylon.exe`（WebView2 `Edg/153.0.4234.48`），两态并列读数见仓外报告 §5；验收后已关 App、端口 9222 无监听者、数据已还原（备份在 `E:\Acode\FILES\_backup\pylon-data-20260928-cc-visibility-2\`）
- 中间态红（已修）：第一轮 `build` 在 `tsc -b` 报 9 处 `TS2345: Property 'ccHiddenEmpty' is missing`（测试文件漏传新必填参数），而同一轮 `test` 是绿的 —— "测试绿 ≠ 能编译"的又一例

## 与 spec 的偏差

1. **回落落点**：施工单写"取值 = 门 ? 空态切面 : 常态切面，某套预设没写空态切面 ⇒ 回落常态切面"。实际实现里"没写 ⇒ 回落"发生在**预设落值**（`inheritCcEmptySlice`），读侧是纯二选一 —— 见"方案要点 3"。这是被两条既存硬约束逼出的落点选择，备选方案与切换成本已点名（报告 §8-A）。
2. **`DEFAULTS.ccHiddenEmpty` 非空**（= 出厂空态 6 件）：为保住"空态极简"这一既成行为（新装即可见）。施工单未直接规定基准值。
3. **单子必读清单外多碰 6 个文件**：`themeFieldDefs.ts` / `store.ts` / `themeDefaults.ts` / `appearance.ts` / `workbenchSkinContract.ts` / `settingsTraceability.test.ts` —— 都是"新增一个可被预设携带的主题字段"的直接依赖（缺任一项 `tsc -b` 或 skin contract 不过），非顺手优化。
4. **未 bump `THEME_SCHEMA_VERSION`**：与 `02` 文档 §四 的旧口径不同，按仓库现行口径（`migration.ts`：加字段一律不 bump）。

## 未解问题

1. ★ **空态下切显隐写错切面**（发现，未改，提请分流）：`set-cc-hidden` 写的是常态切面 `ccHidden`，而门开时读的是空态切面 ⇒ "预设带空态切面且与常态不同"时，空态里点「显示 X」可能不生效。刀 2 之前是并集模型，同样存在（那 6 件在空态里点了也没用）⇒ **非本刀引入的回归**。正确解法需要把"门"传进写入链路（超本单范围）。建议并入刀 4（显示前校验，本来就要动显隐写入入口）或另登记。
2. **存量安装的空态观感差异**：磁盘上无 `ccHiddenEmpty` 且未套预设时，空态取 `DEFAULTS` 基准（6 件），用户手改过的常态切面在空态不再参与（与刀 2 之前的并集语义不同）。项目当前无用户（规范 §7.9-②），未做迁移；若需对齐，见报告 §8-A 的备选改法。
3. 两个 factory 文件尾注释的"字段值"计数（`127` / `420`）按**原口径 +5** 更新；原口径由已删的生成脚本定义、无法复算。附带探针（扁平键数）读数为 `106` / `345`，口径不同，未据它改写注释。

## 并行交集

本刀工作分支 `feat/cc-visibility-two-layer.2`（从 main 新建），共享树上**未提交任何文件**。与在途件的交集：

- **刀 2.5**（`feat/cc-visibility-two-layer.2-5`，PR #431 评审中）：同属 #266 显隐/布局线，**同碰 `widgetDefinitions.ts` 与 `ControlCenter.solid.tsx`** —— 本刀未动横向（`detachX` 一系）与 `.cc-status-*` CSS，两边改动点在文件内不相邻，但合并时这两个文件需要过一次人工对账。本刀不含 2.5 的任何提交。
- **刀 3 / 刀 4**：本刀未动 `ccHeightState.ts` 的算式（只改注释），未动 `ccLayout`（位置不进盒子）。
- 主题字段面：新增 `ccHiddenEmpty` 会出现在 skin contract 快照与 `THEME_SETTING_KEYS`（177）里，动这些面的在途件需同步。
