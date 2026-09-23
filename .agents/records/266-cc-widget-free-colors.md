# Dev Record — #266 遗留① 控件底色/文字色改「自由选色」

> 入库保留。施工单：`E:\Acode\FILES\任务\工作台优化\元件定义表\13-施工单-控件改自由选色.md`
> 总账 issue：[#266](https://github.com/AlchemistCxC/Pylon-co-works/issues/266)（本件是其中第 ① 项）

## 元信息

- issue：[#266](https://github.com/AlchemistCxC/Pylon-co-works/issues/266)
- 分支：`feat/cc-widget-free-colors`（从 `main@d360f9b0` 开；**未 push、未开 PR**，按交单口径先本地做完待复核）
- 提交范围：`807f1326`（L.md 声明）→ `490fcd46`（实现）
- 日期：2026-09-23

## 目标与范围

把模型 / 思考强度 / 权限这三组控件的**底色与文字色**从「白/黑两档枚举」改成**自由选色**。

**用户口径（2026-09-23）**：① 「控件底色应该是自由选色，我当时懒得做，现在补一下」；② 「文字也可以自由选色」；
③ ★ 总口径「**属性声明一律走值**」（颜色即字段值，不引入任何"模式级"落点）；④ 「**不是说不要深色吗还写什么**」——
**本件不碰"深色"那一层**。

**不做**：不给"深色预设"填任何值（出厂数据只做**等价颜色**替换，不改深浅）；不动呈现方案、不动 `uiScheme`；
不动中控结构 / 布局 / 定义表行；不碰 `sendButtonBorderColor` / `sendButtonIconColor`（同名枚举，仍是枚举）。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src/themeFieldDefs.ts` | 6 个字段定义改 `S(...)` → `C(...)`、默认值改等价颜色、`permissionTextColor` 默认 `''` | 修改 |
| `src/domains/theme/migration.ts` | 新增 `normalizeLegacyCcColorEnums` + 挂进每次读盘路径 `normalizeThemeValues` | 修改 |
| `src/domains/cc/widgetDefinitions.ts` | 属性面板 6 项 `kind:'chips'` → `'color'`；`CcColorPropertyKey` / `CcStringPropertyKey` 收编；成员 note 同步 | 修改 |
| `src/renderers/solid-workbench/input/WorkbenchWidgets.solid.tsx` | 三组控件的 `bg()`/`fg()`/权限 `color()` 改直读颜色 + 过期注释同步 | 修改 |
| `src/renderers/solid-workbench/input/ControlCenter.solid.tsx` | **仅** `renderBody` 的 `tokens`（用量胶囊）样式两行改直读模型字段 | 修改 |
| `src/zones/factory/gui-cc.ts` | 出厂数据 6 行等价颜色替换 | 修改 |
| `src/zones/factory/terminal-cc.ts` | 出厂数据 30 行（5 套）等价颜色替换 | 修改 |
| `src/domains/cc/__tests__/widgetDefinitionTable.test.ts` | 属性表单条目断言 `chips:` → `color:` | 修改 |
| `src/domains/theme/__tests__/themeFieldCopy.test.ts` | 两个字段不再是枚举 ⇒ 从「关键枚举」断言移除 | 修改 |
| `src/domains/theme/__tests__/themeSchemaV8Backfill.test.ts` | 归一化期望 `'mode'` → `''` | 修改 |
| `src/renderers/solid-workbench/input/__tests__/WorkbenchWidgets.solid.test.tsx` | `'mode'`/`'white'` → `''`/`'#ffffff'` | 修改 |
| `src/domains/theme/__tests__/ccControlColorFreePick.test.ts` | **新增**：老数据等价 / 幂等 / 不越界 | 新增 |
| `src/renderers/solid-workbench/__fixtures__/workbench-skin-baseline.json` | 契约快照重拍（脚本，不手改） | 修改 |

## 方案要点

1. **走值（不引入模式层）**：6 个字段变成 `type: 'color'`，值就是颜色本身。★ 保留 `noCssVar: true`
   （与 `sendButtonColor` 等既有自由色字段同写法，同时满足 `settingsCompleteness.test.ts` 的「color 字段必有 CSS var 消费，`noCssVar` 豁免」）。
2. ★ **`permissionTextColor` 留空 = 原来的「跟模式」档**：消费端 `value || undefined` ⇒ **不写 inline color**，
   交给 CSS `[data-mode]` 语义色。`C(...)` 的自由色**允许空串**（既有先例：`titlebarBg` / `inputBorderColor` / `cliLineColor`）
   ⇒ 施工单 §4-1 的停手条件（"自由色与跟模式档无法共存"）**未触发**。
   UI 可达性：属性面板与设置页都按自由色渲染，**清空输入即回到该档**；另加了一句 `hint` 说明留空语义。
3. **归一化落在 `migration.ts` 的 `normalizeThemeValues`**（不是 `themeFieldDefs.ts`）：该函数正是「**每次读盘无条件跑一次**」
   的那个 pass（`alignThemeStructure` → persist `merge`），且已有「历史字段特殊规则」段落，与「`inputFocusRingEnabled` 老布尔值 → shown/hidden」同类。
   - 映射：`white → #ffffff`、`black → #000000`、`permissionTextColor: 'mode' → ''`；
   - **只映射这 6 个字段**（按字段名白名单，不是按值全局替换）⇒ `sendButtonBorderColor`/`sendButtonIconColor` 的同名枚举不受牵连；
   - **幂等**：颜色串在映射表里查不到 ⇒ 原样穿过。
4. **消费端直读**：三组控件 `bg()`/`fg()` 直接返回字段值；权限 `color()` 空值返回 `undefined`（`style` 对象丢弃该键）；
   用量胶囊两行改为直读模型字段（胶囊与模型底色/文字色逐位相同）。
5. **出厂数据**：按字段名逐处替换（生成脚本已删 ⇒ 手改 + `sed` 按字段名替换），共 36 行；**只求等价，不改深浅**。

### ★ 有意的语义变化（施工单点名要写进记录）

`permissionTextColor` 的默认值由 `'mode'` 变成 **`''`**，老数据里的 `'mode'` 也归一到 `''`。
二者在消费端是**同一条路径**（都不写 inline color），所以**可见行为不变**；
但**数据层语义表述变了**（"枚举档位" → "空值"）⇒ `themeSchemaV8Backfill.test.ts` 的期望随之更新。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| 门禁五步（lint → build:example-plugin → build → check:solid → test） | ✅ 全绿（全量 **跑了两次**：632 文件 / 4797 用例通过 / 1 skipped / 1 todo，两次一致） |
| 老数据等价（构造 `modelBgColor: "white"` 等旧数据 ⇒ 归一等价 ⇒ 渲染色逐项相同） | ✅ 单测（画出来的色用浏览器 CSS 规范化后逐项比对）+ **实机**（用户磁盘上就是老数据） |
| 自由选色 ⇒ 三组控件跟着变 | ✅ 实机 6/6 字段逐项数值命中 |
| 权限文字色留空 ⇒ 仍是语义色 | ⚠️ **控件侧正确**（inline color 为空 ⇒ 交 CSS）；但**语义色被一条同族通用规则压住** ⇒ **先存缺陷，非本刀引入**（见「未解问题」） |
| 用量胶囊随模型（预期） | ✅ 实机：胶囊 bg/color 与模型**逐位相同** |
| 契约快照重拍 + 逐条 diff | ✅ 91 行变更**逐条可解释**（见证据） |
| 反向验证（拿掉映射 ⇒ 等价断言必须红） | ✅ 2 条断言变红，原文已留证 |
| 开发记录 / 《中控元件总表》 / #266 回写 | ✅ 本文件 + 仓外总表 + issue 评论 |

## 测试处置

| 测试 | 处置 | 原因 |
| --- | --- | --- |
| `widgetDefinitionTable.test.ts` | 改断言：`chips:modelBgColor` 等 6 项 → `color:…` | 属性面板控件类型变了（施工单点名，预期） |
| `themeFieldCopy.test.ts` | 删除 `permissionBgColor` / `permissionTextColor` 两条枚举断言 | 两字段不再是 select（施工单点名） |
| `themeSchemaV8Backfill.test.ts` | 期望 `'mode'` → `''` | 有意的语义变化（施工单点名） |
| `WorkbenchWidgets.solid.test.tsx` | 夹具 `'mode'`/`'white'` → `''`/`'#ffffff'` | 同上（施工单点名） |
| `ccControlColorFreePick.test.ts` | **新增** 5 条 | 施工单 §3-2/§3-5 要求的「老数据等价」靶子 + **反向验证对象** |

其余测试**未改**（`selectCcProperties.test.ts` / `ccSettingsGrouping.test.ts` 只列键名，键名不变）。

## 证据

- commit：`807f1326`（L.md 声明）、`490fcd46`（实现，13 文件 / +358 −161）
- 测试：
  - `bun run lint` → `✖ 1 problem (0 errors, 1 warning)`（warning 在 `RightPanel/RightRailHost.tsx`，非本单文件，先存）
  - `bun run build:example-plugin` → `dist/entry.js … 已由 src/ 重建`
  - `bun run build` → `✓ built in 14.51s`
  - `bun run check:solid` → 全链条通过（含 `ZONE_FIELDS 一致性契约通过（187 个主题字段）`、`CSS 消费审计通过`）
  - `bun run test` ×2 → `Test Files 632 passed | 1 skipped (633)` / `Tests 4797 passed | 1 skipped | 1 todo (4799)`（两次相同）
- 反向验证（原文）：
  - `AssertionError: expected { modelBgColor: 'white', …(5) } to deeply equal { modelBgColor: '#ffffff', …(5) }`
  - `AssertionError: modelBgColor：老枚举 white 画出来应是同一个色: expected { modelBgColor: 'white' } to deeply equal { modelBgColor: 'rgb(255, 255, 255)' }`
  - `Tests 2 failed | 3 passed (5)` → 改回后 `5 passed`
- 契约快照 diff（`workbench-skin-baseline.json`，91 增 91 删）逐条解释：
  - `generatedAt` 时间戳（脚本设计如此）1 条；
  - 13 个 fixture × 6 字段：`white→#ffffff` / `black→#000000` / `mode→''`；
  - `schema-boundary-min`：该 fixture 用 `boundaryValue(key,'min')`，自由色取 **`''`**（旧枚举取 `options[0]='white'`）；
  - `schema-boundary-max`：自由色取 **`'#abcdef'`**（旧枚举取 `options.at(-1)='black'`）。
  - `主题字段 187 个`不变（字段数没动）。
- 实机（普通 `cargo build` 二进制 + 调试端点 9222；`bun run build` → `cargo build` → 重启，三步齐）：
  - 自检：`typeof window.__TAURI_INTERNALS__.invoke` = `"function"`
  - ★ **用户磁盘上就是老数据**：`{"modelBgColor":"white","modelTextColor":"black","reasoningBgColor":"white","reasoningTextColor":"black","permissionBgColor":"white","permissionTextColor":"mode"}`；
    渲染结果 `background: rgb(255,255,255)` / `color: rgb(0,0,0)` / 权限 **inline color = `""`（不写）** ⇒ 与改造前逐项等价
  - 改成任意颜色后（写盘 → 重载走真实读盘路径）：`#ff0000→rgb(255,0,0)`、`#00e5ff→rgb(0,229,255)`（模型）、
    `#123456→rgb(18,52,86)`、`#abcdef→rgb(171,205,239)`（思考强度）、`#ff00ff→rgb(255,0,255)`、`#ffff00→rgb(255,255,0)`（权限）
  - **用量胶囊**：`rgb(255,0,0)` / `rgb(0,229,255)` —— 与模型逐位相同（施工单记的"预期"）
  - 权限文字色置 `''` 后重载：`inline color = ""`（确实不写死）—— 但 computed 为 `rgb(89,99,93)`=`--text-dim`（见下）
  - 还原用户原值后重载：渲染回到 `rgb(255,255,255)` / `rgb(0,0,0)` / 权限不写色；工作树与用户数据已复位
  - 取证后**已关闭带调试端口的实例**；开工前的数据备份在仓外 `%TEMP%\pylon-backup-266-freecolor-215555\`
- 未改任何契约快照以外的 JSON；快照由 `bun scripts/check-workbench-theme-contract.mts --write` 重拍。

## 与 spec（施工单）的偏差

1. ★ **多改了一处消费端**：`ControlCenter.solid.tsx` 里**用量胶囊**那两行 `background`/`color` 原来也是「枚举→颜色」映射
   （`=== 'black' ? '#000' : '#fff'`）。施工单 §1 点名「用量胶囊借用模型字段（会跟着一起变）」、§3 验收也要求胶囊随模型，
   但 §2 清单 #3 只列了 `WorkbenchWidgets.solid.tsx` 四处。**不改这两行，胶囊在自定义颜色下不会跟模型**（会退回 `#fff`），
   属同一类改动（§2 #3「消费端改直读颜色」，且 §1 已把这条隐式耦合写在案）⇒ 按最小改动一并改掉，**该文件仅动这两行**。
2. **给 `permissionTextColor` 加了一句 `hint`**（施工单 §2.1 的示例行没有）：该字段的核心语义是"留空=跟模式"，
   不加提示用户无法知道"清空输入"是有意义的一档。非行为改动、只影响设置页/属性面板的提示文案。
3. **新增了一个测试文件**（`ccControlColorFreePick.test.ts`）：施工单 §3-2 要求"老数据等价"断言、§3-5 要求对它做反向验证，
   必然要有一条新断言；放在新文件里以**零改动**既有断言为准（未改 `structuralAlignment.test.ts` 等未点名文件）。

## 未解问题

1. ★ **权限文字色"留空"时，语义色（自动黄 / 绕过红 / 编辑紫）实际不生效 —— 先存缺陷，非本刀引入。**
   实测（WebView2，绕过确认模式）：控件 inline color 为空 ⇒ 交 CSS，但 computed = `rgb(89,99,93)`（`--text-dim`），不是 `--tool-err`(`#f43f5e`)。
   归因：`.cc-permission-trigger[data-mode="bypass"]`（StatusBar.css，表 13）与
   `.solid-workbench-control-center-slot :is(.cc-model-trigger, .cc-permission-trigger, …)`（WorkbenchChrome.css，表 14）
   **特异度相同，后者靠后 ⇒ 后者赢**。实验：临时停用表 14，computed 立刻变 `rgb(244,63,94)`。
   ⇒ 改造前后**行为相同**（旧 `'mode'` 与新的 `''` 走的是同一条"不写 inline color"路径），故**未在本刀修**（修它会改视觉效果、且属另一件事）。
   已记入仓外《中控元件总表》§10 待定行。
2. **出厂深色预设仍是"白底控件"**：终端 5 套 + GUI 3 套 `uiScheme: 'dark'`，但 cc 切面控件底色仍是 `#ffffff`（等价替换自 `white`）。
   施工单 §2.4 明确定调"**不给深色预设填值**（那是内容/设计决定）" ⇒ 本刀不动，留作后续内容决定。
3. 属性面板（编辑模式）本机未点开（需在界面里手动进编辑态），`kind: 'color'` 的**渲染形态**以单测契约为据
   （`widgetDefinitionTable.test.ts` 精确锁定 6 项的 `color:` 类型），实机只验到"值 → 渲染色"这条链。

## 并行交集

- 本轮触碰的共享文件（供其他人避让）：`src/themeFieldDefs.ts`、`src/domains/theme/migration.ts`、
  `src/domains/cc/widgetDefinitions.ts`、`src/renderers/solid-workbench/input/WorkbenchWidgets.solid.tsx`、
  `src/renderers/solid-workbench/input/ControlCenter.solid.tsx`（仅用量胶囊两行）、`src/zones/factory/*-cc.ts`、
  `src/renderers/solid-workbench/__fixtures__/workbench-skin-baseline.json`。
- ★ 与 #266「成员级显隐收编」那条线**文件域重叠**（`themeFieldDefs.ts` / `widgetDefinitions.ts`）：那条线已**停手待分流**
  （`refactor/cc-member-visibility` 上只有 L.md 两条登记，无源码改动）⇒ 本分支从 `d360f9b0` 干净开出，无冲突。
