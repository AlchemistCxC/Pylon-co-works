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

---

# 遗留② · 发送按钮边框色 / 图标色改「自由选色」（2026-09-23，追加）

> **约定**：本件与 ① 同分支同 issue，**追加在同一份记录**里（施工单 §4-6 给的二选一）。
> 施工单：`E:\Acode\FILES\任务\工作台优化\元件定义表\16-施工单-发送按钮颜色改自由选色.md`
> 提交范围：`5619b62c`（L.md 声明）→ `f0b3e1c9`（实现）

## 目标与范围

把发送按钮的 **`sendButtonBorderColor`（边框）** 与 **`sendButtonIconColor`（图标颜色）** 从「白/黑/灰枚举」
改成**自由选色**——与 ① 同口径（属性声明走值）。

★ **命门 = 等价色不是纯白纯黑**：旧渲染侧（`ControlCenter.solid.tsx:630-631`）把枚举翻成
**半透明**颜色，所以新默认值 / 老数据归一化值必须照抄"现在实际输出"：

| 字段 | 枚举 | 等价色（写进字段/默认值） |
| --- | --- | --- |
| `sendButtonBorderColor` | `white` / `black` | `rgba(255,255,255,.5)` / `rgba(0,0,0,.5)`（**都半透明**） |
| `sendButtonIconColor` | `white` / `gray` / `black` | `#ffffff` / `rgba(0,0,0,.5)` / `#000000` |

**不做**：`sendButtonColor`（早已是自由色，一行未动）；`sendButtonRadius` / `sendButtonIcon` /
`sendButtonIconGenerating` / `sendButtonIconRound`（形状与圆角，仍是枚举）；① 已改的 6 个字段；
`ControlCenter.css`（只读变量，没枚举逻辑）；出厂数据的深浅（仍是"白底按钮"，不等价之外一个字没改）。

## 改动清单

| 文件 | 范围 | 性质 |
| --- | --- | --- |
| `src/themeFieldDefs.ts` | 两字段 `S(...)` → `C(...)`、去 `optionLabels`、默认取等价色 | 修改 |
| `src/domains/theme/migration.ts` | ① 的枚举映射表改成**「字段名 → 字面量」两层**（理由见下）+ 加这两键；改掉 `:88` 那句"仍是枚举"的注释 | 修改 |
| `src/renderers/solid-workbench/input/ControlCenter.solid.tsx` | **仅** 630-631 两行：去掉枚举→颜色的转换，直读字段值 | 修改 |
| `src/zones/factory/gui-cc.ts` | 出厂数据 1 套 × 2 字段 = 2 行 | 修改 |
| `src/zones/factory/terminal-cc.ts` | 出厂数据 5 套 × 2 字段 = 10 行 | 修改 |
| `src/domains/theme/__tests__/ccControlColorFreePick.test.ts` | 头部第 3 条改写 +「不越界」拆成「用户值原样穿过」+ **新增**遗留② 5 条 | 修改 |
| `src/renderers/solid-workbench/__tests__/mountSolidControlCenterPreview.solid.test.tsx` | 默认值与改值断言换等价色字面量 | 修改 |
| `src/renderers/solid-workbench/__fixtures__/workbench-skin-baseline.json` | 契约快照重拍（脚本，不手改） | 修改 |

## 方案要点

1. **映射表改成两层（① 的单层平表放不下本件）**：同一个 `'white'` 在边框字段上的等价色是**半透明**
   `rgba(255,255,255,.5)`、在图标字段上是纯白 `#ffffff` ⇒ 必须"按字段名 + 字面量"两级查表。
   改结构的同时删掉了冗余的 `LEGACY_CC_COLOR_ENUM_FIELDS` 白名单（键即表项，一处真值）。
   仍是**按字段名**而不是按值全局替换 ⇒ 幂等与"不越界"性质不变。
2. **转换点归零**：ControlCenter 那两行改直读字段值后，全仓已**没有任何地方**按枚举判断这两个字段
   （`grep sendButtonBorderColor|sendButtonIconColor` 只剩类型声明、定义表、出厂数据、测试与快照）
   ⇒ 施工单 §5-1 的停手条件未触发。
3. **`widgetDefinitions.ts` 一字未动**：发送按钮是**注册轨**控件、**没有属性面板表单**
   （定义表里它只给布局四项）⇒ ① 里那 6 项的 `chips → color` 在本件没有对应面。
4. **`noCssVar: true` 保留**：与 `sendButtonColor` 等既有无 var 自由色字段同写法，也满足
   `settingsCompleteness` 的「color 字段必有 CSS var 消费，`noCssVar` 豁免」。

### ★ 空值的新含义（写进记录以免后来者困惑）

自由色**允许空串**。`sendButtonBorderColor = ''` / `sendButtonIconColor = ''` 时 CSS 变量为空 ⇒
`ControlCenter.css` 的 fallback 生效（边框 `rgba(255,255,255,.5)` / 图标 `#fff`）。
契约快照的 `schema-boundary-min` fixture 正是取空串（color 类型 min 档统一如此，与 ① 的 6 个字段同款）。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| 门禁五步（lint → build:example-plugin → build → check:solid → test） | ✅ 全绿；全量**跑了 4 次**：① 632 文件 / 4802 用例通过；② **1 红**（无关游走 flake，见下）；③④ 连续全绿 632 / 4802 |
| ★★ 零变化证据：老数据归一化后**画出来的颜色**与改造前逐项相同，半透明档没丢 | ✅ 单测（浏览器规范化后逐档比对 + 非空守卫）+ **实机**（用户磁盘上就是 `"white"`×2 的老数据） |
| 实机：改成任意颜色（含带 alpha 的 `rgba`）⇒ 边框/图标跟着变 | ✅ 变量与**渲染后的** `border-color` / `stroke` / `fill` 逐项命中（见证据） |
| 反向验证：把这两键从映射里拿掉 ⇒ 等价断言必红 | ✅ 3 条变红（含"半透明"那条），原文已留证 |
| 契约快照重拍 + 逐条 diff | ✅ 31 增 31 删，**逐条可解释** |
| 开发记录（追加）/《中控元件总表》/ #266 回写 | ✅ 本节 + 仓外总表（发送按钮行 + §10）+ issue 评论 |

## 测试处置

| 测试 | 处置 | 原因 |
| --- | --- | --- |
| `ccControlColorFreePick.test.ts` | 头部第 3 条"不越界"改写成"遗留② 同口径"；原「不越界」用例的**两条枚举断言**换成"用户值原样穿过"；**新增** 5 条（默认档等价 / 逐档等价 / 半透明专测 / 缺键补默认 / 幂等） | 施工单点名：它**故意**钉住"这两项仍是枚举"，与新口径矛盾 |
| `mountSolidControlCenterPreview.solid.test.tsx` | 断言/夹具换 §1 等价色字面量（详见"与单的偏差"第 2 条） | 同文件同契约面，施工单点名 |
| `widgetDefinitionTable.test.ts` / `ccSettingsGrouping.test.ts` | **未改**（只列键名，键名不变） | 施工单 §3 明示不用改；全量绿复核 |

## 证据

- **门禁**（关键行）：

  ```text
  bun run lint                → EXIT=0  ✖ 1 problem (0 errors, 1 warning)   ← 存量 warning，非本单文件
  bun run build:example-plugin→ EXIT=0  dist/entry.js … 已由 src/ 重建
  bun run build               → EXIT=0  ✓ built in 9.01s
  bun run check:solid         → EXIT=0  ZONE_FIELDS 一致性契约通过（187 个主题字段）/ CSS 消费审计通过（死注入与悬空引用均为 0）
  bun run test                → 632 passed | 1 skipped (633) / 4802 passed | 1 skipped | 1 todo (4804)   （跑 4 次，见下）
  ```

- **全量 4 轮的真相（不遮红）**：第 2 轮红 1 条 ——
  `src/renderers/solid-workbench/chat/__tests__/PlainMessageList.solid.test.tsx > #243：换代把窗口收敛到新会话尾部，不按旧会话规模扩满`
  `AssertionError: expected [ 'b0', 'b1', 'b2', 'b3', 'b4', …(7) ] to include 'b299'`。
  判定为**并发饱和型游走 flake、非本单产物**，依据三条：
  ① 本单 diff 不触碰 `chat/**`、虚拟化、滚动或测量链（8 个文件逐一可核）；
  ② 该文件**隔离连跑 3 次全绿**（`Tests 16 passed`）；
  ③ 紧随其后的第 3、4 轮**连续全绿**（同机同负载）。属于 #141 / #175 / issue-129 那类既有案底
  ⇒ **未修**（不在本单文件域内），已在"未解问题"留档。
- **反向验证（原文）**：把 `sendButtonBorderColor` / `sendButtonIconColor` 两键从映射表注释掉后 ——

  ```text
  FAIL … #266 遗留② … > 两个字段的枚举字面量被搬成等价颜色（默认档）
    AssertionError: expected { sendButtonBorderColor: 'white', …(1) } to deeply equal { sendButtonBorderColor: 'rgba(255,255,255,.5)', …(1) }
  FAIL … > ★ 等价性：归一化后画出来的颜色与改造前逐档相同
    AssertionError: sendButtonBorderColor：老枚举 white 画出来应是同一个色: expected { sendButtonBorderColor: 'white' } to deeply equal { Object (sendButtonBorderColor) }
  FAIL … > ★ 半透明那一档没丢：边框白档仍是 rgba(255,255,255,.5)，不是纯白
    AssertionError: expected 'white' to be 'rgba(255, 255, 255, 0.5)'
  Test Files 1 failed (1) / Tests 3 failed | 7 passed (10)
  ```

  改回后：`Test Files 1 passed (1) / Tests 10 passed (10)`。
- **契约快照 diff（31 增 31 删）逐条解释**：`generatedAt` 时间戳 1 条（脚本设计如此）；
  **13 个 fixture** × 2 字段 `white → rgba(255,255,255,.5)` / `#ffffff`；
  `schema-boundary-min` × 2 字段 → `""`（color 型 min 档统一空串，见"空值的新含义"）；
  `schema-boundary-max` × 2 字段 → `"#abcdef"`（该 fixture 原先就是这两个字段的 `black` 档）。
  ⇒ 15 个 fixture × 2 字段 = 30 行 + 时间戳，无第 4 类差异；`主题字段 187 个`不变。
- **实机**（`bun run build` → `cargo build --manifest-path src-tauri/Cargo.toml --bin pylon`（44.25s，确实重编译并内嵌新 dist）
  → 启动 `src-tauri/target/debug/pylon.exe`（调试端点 9222，`tauri.conf.json` 内置）→ 页面目标 `8A5F7343…`，`http://tauri.localhost/`）：
  自检 `typeof window.__TAURI_INTERNALS__.invoke` = `"function"`。
  量法：在**真实 `[data-control-center]` 内**插入按钮与图标的**真类名**探针（`.cc-send-button` /
  `.cc-send-icon--stroke` / `--solid`，与 `WorkbenchWidgets.solid.tsx:133-145` 同构），读 `getComputedStyle`
  后立即移除 —— 量的是**真实 WebView2 + 真实样式表 + 真实继承来的 CSS 变量**。

  | 场景（写盘 → 重载走真实读盘路径） | 变量 | **渲染结果** |
  | --- | --- | --- |
  | ★ 用户磁盘上的老数据 `"white"` / `"white"`（未改动） | `rgba(255,255,255,.5)` / `#ffffff` | 边框 `rgba(255, 255, 255, 0.5)`、图标 `rgb(255, 255, 255)` ← 与改造前逐位相同 |
  | 老枚举 `"black"` / `"gray"` | `rgba(0,0,0,.5)` / `rgba(0,0,0,.5)` | 边框 `rgba(0, 0, 0, 0.5)`、图标 `rgba(0, 0, 0, 0.5)` |
  | 自由色 `rgba(0,128,255,.25)` / `#ff00aa` | 原样 | 边框 `rgba(0, 128, 255, 0.25)`（**alpha 保留**）、图标 `rgb(255, 0, 170)` |
  | 还原用户原值 `"white"` / `"white"` | 回到 `rgba(255,255,255,.5)` / `#ffffff` | 回到 `rgba(255, 255, 255, 0.5)` / `rgb(255, 255, 255)` |

  取证后**已关闭带调试端口的实例**（`tasklist` 无 `pylon.exe`）；开工前备份在仓外
  `%TEMP%\pylon-backup-266-legacy2-224004\`（Roaming 全量 + Local 全量），**只改过 `pylon-theme` 里那两个键**、
  已还原并复核。
- 未改任何契约快照以外的 JSON；快照由 `bun scripts/check-workbench-theme-contract.mts --write` 重拍。
  ★ 顺带确认该脚本**不带 `--write` 时只做内存自校验、不与磁盘快照比对**（原样返回"通过"）——
  与 00 文档「只写不验」一致，别把它当"快照仍一致"的证据。

## 与施工单的偏差

1. **映射表结构从"单层平表"改成"两层按字段表"**（施工单 §3-3 只说"把这两个键加进那张表"）：
   同一个 `'white'` 在两字段上的等价色不同，平表**表达不了**；两层表在"单表"语义内是唯一不引入
   第二张平行表的写法。副作用：删掉了 ① 的字段白名单常量（表键即白名单），净减一处结构。
2. **点名的测试文件里多改了几行**（施工单 §3-6 列的是 `:162/:166/:187/:192/:194`）——
   同一文件、同一类改动（"换成 §1 的等价色字面量"），但为让该文件与新契约自洽必须一并改：
   `:182` `'#fff'`→`'#ffffff'`、`:191` 同、`:195` `'#000'`→`'#000000'`。
   （`:190`/`:193` 未动，因为我把 `:187`/`:192` 的**改值**直接取成与既有期望相同的等价色。）
3. **放宽了共享助手 `asCssColor` 的参数类型**（`'background' | 'color'` → 追加 `'borderColor' | 'stroke'`）：
   纯类型放宽，既有 6 个字段的调用与行为不变；不放宽 `bun run build` 的 `tsc -b` 直接 TS2345。
4. **新增的等价断言里加了"非空守卫"**（对照臂必须是有效色）：避免将来 jsdom 解析退化时，
   `'' === ''` 让这条断言变成**永远绿的空断言**。

## 未解问题

1. ★ **`PlainMessageList.solid.test.tsx` 的 `#243` 窗口收敛用例在全量并发下偶发红**（本轮第 2 次全量命中 1 条，
   隔离连跑 3 次全绿、随后两轮全量全绿）。属既有游走 flake 家族（#141 / #175 / issue-129 案底），
   **不在本单文件域**，未修。复现线索：失败时窗口停在会话**头部**（`b0..b11`）而非尾部，
   是"`waitFor` 抢在虚拟化测量/贴底收敛之前"的时序型断言。建议归属渲染器线处置。
2. **设置页外观未在本机点开**（同 ① 的取证限制）：打开设置会写入持久化的设置页导航状态
   （ADR-0013），对用户数据有额外副作用 ⇒ 不拿它做验收动作。该面由契约测试兜底：
   两字段仍在 `cc-settings-grouping` 的**可渲染 cc 字段集合（77 项）**里，全量绿。
   ★ 另注：发送按钮**没有属性面板**（注册轨控件，定义表只给布局四项），所以"用户怎么改"只有设置页一条路。
3. **出厂深色预设仍是"半透明白边框 + 白图标"**（终端 5 套 + GUI 3 套 `uiScheme: 'dark'`）：
   等价替换的必然结果，**不给深色预设填值**是既定口径（① 同款遗留），留作后续内容决定。

## 并行交集

- 本轮触碰的共享文件（供其他人避让）：`src/themeFieldDefs.ts`、`src/domains/theme/migration.ts`、
  `src/renderers/solid-workbench/input/ControlCenter.solid.tsx`（**仅 630-631 两行**）、
  `src/zones/factory/*-cc.ts`、`src/renderers/solid-workbench/__fixtures__/workbench-skin-baseline.json`、
  `src/domains/theme/__tests__/ccControlColorFreePick.test.ts`、
  `src/renderers/solid-workbench/__tests__/mountSolidControlCenterPreview.solid.test.tsx`。
- 与 ① 的差异：**未触碰** `src/domains/cc/widgetDefinitions.ts`、`WorkbenchWidgets.solid.tsx`。
