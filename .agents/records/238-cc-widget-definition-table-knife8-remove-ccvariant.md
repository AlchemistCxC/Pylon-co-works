# Dev Record — #238 刀8 删掉「整体风格」（`ccVariant` 整套）

> 入库保留。施工单：`E:\Acode\FILES\任务\工作台优化\元件定义表\12-施工单-刀8-删掉整体风格.md`
> 规范：同目录 `00-施工规范-中控元件定义表-v1.0.md`；分支 `feat/cc-widget-definition-table`
> ★ 留档在**仓外**：`E:\Acode\FILES\任务\预设修正\备份\ccVariant-留档\`（索引 + 三段样式原文 + 回退步骤）

## 元信息

- issue：[#238](https://github.com/AlchemistCxC/Pylon-co-works/issues/238)
- 分支：`feat/cc-widget-definition-table`（**未 push、未开 PR**）
- 提交范围：`744e949d..c0157a02`（`744e949d` 刀6 终点 → `c0157a02` 实现）
- 日期：2026-09-23
- 用户口径（2026-09-23）：「（终端状态栏/玻璃工作台/轻量胶囊）**这是旧的吧？我没记得我写过这个，大概率适配有问题**……把这个去掉」；
  总口径：「**不强求零变化**，过于追求零变化修不了旧问题了」⇒ 本刀**允许视觉变化**，差异量出来如实报告。

## 目标与范围

删掉「整体风格」（`ccVariant`）**整套**：字段 / 快照 / 渲染类名 / 三段变体 CSS / 六个呈现方案里的值 /
出厂数据 / 皮肤属性 `data-cc-variant` / 设置预览的读取。

**为什么删**（施工单 §0 已论证，本刀只执行）：① 三变体共约 13 个声明，`pill` 的全部实现只有一句
`border-radius: 0` 且被内联样式压掉 ⇒ 基本没生效；② 六个呈现方案各自指定它 ⇒ 它属"**界面模式那一层**"，
设置页那个入口改了会被模式切换盖掉 ⇒ **假入口**。

**不做**：中控定义表结构（刀6 地盘）、其它 cc 字段、插件契约面中除 `data-cc-variant` 之外的部分。

## 改动清单（24 文件）

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src/themeFieldDefs.ts` | 删 `ccVariant` 字段定义 + 那条指向**并不存在的**"变体切换组件"的过时注释 | 修改 |
| `src/store.ts` | 删 `ThemeSettings.ccVariant` 类型字段 | 修改 |
| `src/domains/workbench/appearance.ts` | 删外观快照字段与其赋值 | 修改 |
| `src/renderers/solid-workbench/input/ControlCenter.solid.tsx` | class 模板去掉 `cc-variant-${appearance().ccVariant}` | 修改 |
| `.../styles/components/ControlCenter.css` | 删 `/* ── ccVariant styles ── */` 小节（glass 玻璃底/白字/淡边框 + pill 的 radius）；删 `.cc-variant-glass/.cc-variant-pill .cc-tasks-pill` 两行 | 修改 |
| `.../styles/components/chat/StatusBar.css` | 删 `.cc-variant-terminal .cc-model-minimal / .pill-mono` 块 | 修改 |
| `src/plugins/core/renderer/builtinPresentationProfiles.ts` | 六个呈现方案各自的 `ccVariant` token（含 `EXECUTION_SURFACE_TOKENS` 那一份） | 修改 |
| `src/presets/builtin.ts` | `GLASS_THEME` 的 `'pill'`、终端默认的 `'terminal'`；两处"契约字段"注释（5 → 4） | 修改 |
| `src/plugin-runtime/skin/skinResolver.ts` | 删 `data-cc-variant`（`SKIN_DATA_ATTRIBUTES` 成员 + 映射行） | 修改 |
| `src/components/SettingsPreview.tsx` | 停读 `--cc-variant` / 停写 `overrides.ccVariant`；失败占位去掉 `cc-variant-peri` 类 | 修改 |
| `src/zones/factory/{terminal-cc,gui-cc}.ts` | 出厂数据手改：`terminal-cc` **5 处** + `gui-cc` **2 处**（共 7 行 `ccVariant`) | 修改 |
| 测试 12 份 | 见「测试处置」 | 修改 |
| `__fixtures__/workbench-skin-baseline.json` | 脚本重拍 | 修改 |

### 出厂数据手改清单（真值 = 单子估计）

| 文件 | 删掉的 `ccVariant` 行 | 值 |
| --- | --- | --- |
| `src/zones/factory/terminal-cc.ts` | **5** | `"terminal"` ×5 |
| `src/zones/factory/gui-cc.ts` | **2** | `"pill"` ×1、`"terminal"` ×1 |
| **合计** | **7**（与施工单 §2-9 的"5 + 2"一致） | —— |

## 方案要点

1. **`data-cc-variant` 一并删**（§6 已裁定：仓内零消费者、文档未承诺、示例未用）⇒ 生产者
   （`skinResolver` 的属性表与映射行）、那条断言、以及 `themeFieldDefs` 里那句过时注释一起退场。
2. **预览里那个 `cc-variant-peri` 也删**：`SettingsPreview` 的失败占位 div 上写着第四个变体名
   （`cc-variant-peri`），而**全仓没有任何 `.cc-variant-peri` 样式** —— 它和真变体走的是同一条机制
   （class 模板），删变体类名时不能只删生产那一半（**清单外，见「偏差」2**）。
3. **冻结数字按真值重算**（刀6 新加的那几处，施工单已点名）：字段集合 78 → **77**、
   cc 字段 80 → **79**、容器行成员计数 9 → **8**、预设基线 6 套 188 → **187** + glass 68 → **67**。
   ★ 三处数字**都由脚本实测**（`THEME_SETTING_KEYS.length` / 逐预设 `Object.keys(effectivePresetTheme(p)).length`）后填的，不是手推。
4. **反向守卫**加进既有的 `ccDeadDataGuard`（现成手法）：三个 token `ccVariant` / `cc-variant-` /
   `ccVariant styles` 不得出现在**生产源码**里。★ 该守卫**先剥注释再扫**（第③件立的规矩）⇒
   解释性注释里可以提这些名字（本刀在两处留了说明性注释，见 `ControlCenter.css` 与 `themeFieldDefs.ts`）。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| 门禁五步 | ✅ `lint`（0 error，唯一 warning 在他人文件 `RightRailHost.tsx`）/ `build:example-plugin` / `build` / `check:solid` / `test` 全绿 |
| ★ 全量**跑两次** | ✅ 两次完全一致：`628 文件 / 4758 通过 + 1 todo` |
| 全量对账 | ✅ 与上一刀（刀6）**逐数字相同**（本刀只改断言、未增删用例） |
| CSS 消费审计 | ✅ 注入 113 / 消费 348 / 声明 353 / 死注入 0 / 悬空引用 0（与改造前逐项相同；被删的都是元素选择器，不涉及 `--var`） |
| ★ 实机逐模式 A/B | ✅ 三模式四个控件前后数值见「证据」④；终端模式**零变化**，GUI/战术蓝**失去玻璃层**（预期，见下） |
| 契约快照 | ✅ 重拍后 diff = **15 行 `ccVariant` 删除 + 1 行 `themeSettingCount` 188→187**，**无其它差异**（CSS 变量数 96 不变） |
| 反向守卫 | ✅ 加三个 token 并反向验证：把 `ccVariant` 放回 `store.ts` ⇒ 守卫**红且点名文件**；还原 ⇒ 绿 |
| 开发记录 / 总表 / issue 回写 | ✅ 本文件 + 仓外《中控元件总表》 + #238 评论 |

## 测试处置（12 份；**未增删任何用例**）

| 文件 | 改了什么 | 为什么 |
| --- | --- | --- |
| `__tests__/defaultPresets.test.ts` | `TERMINAL_CONTRACT` 5 → 4 项（去 `ccVariant`）；`setState` 样本去掉它；一条注释同步 | 施工单 §2-11 |
| `__tests__/effectivePresetTheme.test.ts` | `BASELINE_FIELD_COUNTS`：6 套 188 → 187、glass 68 → 67（agent-* 36 不变） | 施工单 §2-14，**脚本实测** |
| `domains/cc/__tests__/ccSettingsGrouping.test.ts` | 冻结清单 78 → **77** 项（去 `ccVariant`）；注释说明 | 施工单点名（刀6 新增的冻结数字） |
| `domains/cc/__tests__/widgetDefinitionTable.test.ts` | 「80 个」→ 79、`toHaveLength(80)` → 79、`total` 80 → 79、逐组计数 `'cc-surface': 9 → 8`、成员↔字段 map 去掉 `ccVariant` | 同上 |
| `domains/cc/__tests__/ccDeadDataGuard.test.ts` | **新增 3 个 token**（`ccVariant` / `cc-variant-` / `ccVariant styles`） | 施工单 §4-4 |
| `domains/interface/__tests__/interfaceMode.test.ts` | `CC_INPUT_TOKEN_KEYS` 去掉 `'ccVariant'` | 该名单是"界面模式 token 字段"，字段没了必须同步 |
| `domains/theme/__tests__/themeFieldCopy.test.ts` | 「模糊字段表达真实作用域」那条的样本由 `ccVariant` 换成 `ccLayout` | 字段删了，样本必须换（用例数量不变） |
| `plugin-runtime/skin/__tests__/skinResolver.test.ts` | 样本 token 换成 `cliOverflowMode`；`data-cc-variant` 断言改为**断言它不存在** | 属性删了 —— 反向锁住 |
| `plugin-runtime/skin/__tests__/skinSchema.test.ts` | 删 `ccVariant?.cssVar` 断言；options 样本换成 `cliHintMode` | schema 由 defs 派生 |
| `plugins/core/renderer/__tests__/builtinPresentationProfiles.test.ts` | 样本 token 去掉 `ccVariant`；`COMPLETE_CC_INPUT_TOKENS` 9 → 8 | 契约字段清单同步 |
| `components/__tests__/SettingsPreview.solidMigration.test.tsx` | 不再注入 `--cc-variant`；类名断言反转为「**不含任何 `cc-variant-` 类**」 | 预览也不再带变体类 |
| `__tests__/customPresets.test.ts` | **未改**（该文件不含 `ccVariant`） | —— |

## 证据

- **commit**：`c0157a02`（24 文件）；`git status` 干净；**未 push、未开 PR**。
- **① 门禁五步**：

  ```
  lint                 → ✖ 1 problem (0 errors, 1 warning)   # 警告在 right-panel/RightRailHost.tsx（他人文件）  EXIT=0
  build:example-plugin → EXIT=0
  build                → EXIT=0
  check:solid          → EXIT=0；CSS 消费审计通过（注入 113 / 消费 348 / 声明 353，死注入与悬空引用均为 0）
  test                 → Test Files 628 passed (628) | Tests 4758 passed | 1 todo (4759)   EXIT=0
  ```
- **② 全量跑两次（施工单要求）**：

  ```
  RUN#1  628 passed (628) | 4758 passed | 1 todo (4759)   Duration 157.56s
  RUN#2  628 passed (628) | 4758 passed | 1 todo (4759)   Duration 100.47s
  ⇒ 两次一致，没有刀6 验收时那种 flake。
  ```
- **③ 契约快照 diff（逐条）**：

  ```
  15 行删除 = 15 份 fixture 各一行 `"ccVariant": …`（13 × "terminal" + 2 × "pill"）
   1 行变更 = "themeSettingCount": 188 → 187
  其余零差异（`cssVariableCount` 仍 96 —— 该字段是 noCssVar，从来不发变量）
  ```
- **④ ★ 实机逐模式 A/B（普通 `cargo build` 二进制 + 调试端点；A/B 两次构建，同一份 localStorage）**

  量的是 `border / border-radius / background / color`（+ backdrop-filter），控件 = 模型触发器 / 权限触发器 / 用量胶囊：

  ```
  ── BEFORE（刀8 之前）──────────────────────────────────────────────
  终端 terminal-like  （.control-center 带 cc-variant-terminal）
    model      border 1px solid rgba(0,0,0,0) | radius 0 | bg rgb(255,255,255) | color rgb(0,0,0) | backdrop none
    permission 同上，color rgb(167,176,170)
    usagePill  同上，bg rgb(255,255,255) | color rgb(0,0,0)
    .cc-tasks-pill  该状态不存在（null）
  现代 GUI  modern-gui（cc-variant-glass）
    model      border 1px solid rgba(255,255,255,0.08) | radius 0 | bg rgba(255,255,255,0.06) |
               color rgba(255,255,255,0.85) | backdrop blur(10px)
    permission 同上（白字 —— 语义色被 !important 压掉）
    usagePill  同上
  战术蓝 tactical-blue（cc-variant-glass，同 EXECUTION_SURFACE_TOKENS）
    与「现代 GUI」逐字相同
  ── AFTER（本刀）──────────────────────────────────────────────────
  终端 terminal-like  （.control-center **无**变体类）
    model      border 1px solid rgba(0,0,0,0) | radius 0 | bg rgb(255,255,255) | color rgb(0,0,0) | backdrop none
    permission color rgb(167,176,170)
    usagePill  bg rgb(255,255,255) | color rgb(0,0,0)
  现代 GUI  modern-gui（无变体类）
    model      border 1px solid rgba(0,0,0,0) | radius 0 | bg rgb(255,255,255) | color rgb(0,0,0) | backdrop none
    permission color rgb(183,190,208)      ← 语义色回来了
    usagePill  bg rgb(255,255,255) | color rgb(0,0,0)
  战术蓝 tactical-blue（无变体类）
    model/permission/usagePill 与「现代 GUI」同形（permission color rgb(164,181,204)）
  ⇒ 实机同时确认：三模式的 `.control-center` 类名都不再含 `cc-variant-*`。
  ```

  **差异归类（哪些预期、哪些不该出现）**：

  | 模式 | 差异 | 归类 |
  | --- | --- | --- |
  | 终端 | **无差异**（四个控件逐项相同） | ✅ 预期 —— `.cc-variant-terminal` 那两条只命中 `.cc-model-minimal` / `.pill-mono`，而当前结构里模型触发器是 `.cc-model-trigger` ⇒ 本来就没作用 |
  | 现代 GUI / 战术蓝 | 三个控件**失去** `backdrop-filter: blur(10px)` + 半透明白底 + 白字淡边框，回到**字段值**（白底黑字、透明边框） | ✅ **预期**（§3 明写：glass 那三条带 `!important`、确实在生效）；这正是"删掉错层机制"要付的代价 |
  | 现代 GUI / 战术蓝 | 权限控件颜色从**被强制的白字**回到**语义色**（`rgb(183,190,208)` / `rgb(164,181,204)`） | ✅ 预期，且属**改善**（语义色回归，信息量回来） |
  | 全部 | `.cc-tasks-pill` 在三种模式下都**不存在**（该元素当前状态没渲染）⇒ 被删的两条 `.cc-variant-* .cc-tasks-pill` 规则**在本机量不到效果** | ⚠️ 如实报告：无法用实机证明那两条规则的影响（静态看它们只改 `border-radius:0`） |

  ★ **可读性提示（施工单 §5-1 要求点名，不作为停手理由）**：
  现代 GUI / 战术蓝 下，控件从"半透明玻璃胶囊 + 白字"变成"**不透明白底黑字**"。
  在**战术蓝**这种深色界面上，白块是硬对比 —— 黑字在白底上的对比度其实**更高**（不算变差），
  但**观感变化明显**（玻璃感没了）。⇒ 请你看一眼定夺：若希望深色模式下的控件不是白块，
  那是"给控件按模式定一套底/字色"的另一件事（本刀只负责把错层机制拿掉，未自行配色）。
- **⑤ 反向守卫（红→绿，贴红）**：把 `ccVariant: string` 放回 `store.ts` 的 `ThemeSettings`：

  ```
  FAIL  ccDeadDataGuard > 四项被删的死数据在生产源码里零命中（任何一项回来即红）
  AssertionError: 第③件删掉的死数据又回到了生产源码；若确要用，改这条测试是显式动作:
    expected [ Array(1) ] to deeply equal []
  +   "store.ts → ccVariant（「整体风格」字段（刀8 整套删除））",
  Test Files 1 failed | Tests 1 failed | 3 passed (4)
  ```
  还原后：`Test Files 1 passed (1) | Tests 4 passed (4)`。
- **⑥ 停手条件逐条核对（开工前）**：
  1. ~~实机差异比预期大~~ —— 本条已作废（用户「不强求零变化」）⇒ 改为逐模式量出并报告（见 ④）。
  2. `data-cc-variant` 仓外消费者：**仓内零命中已复核**（生产者 / 一条断言 / 一句过时注释，说明书与示例插件零命中，
     连读它的 CSS 选择器都没有）⇒ 按 §6 执行删除。★ **仓外（外部皮肤/插件）我无法核查**，按 §6 的裁定办理。
  3. 皮肤相关测试是否**要求保留**该 token：`skinSchema.test.ts` 与 `skinResolver.test.ts` 只是**引用**它，
     无"必须存在"的语义 ⇒ 同步即可，**不构成停手**；也没有皮肤契约快照把它钉住。
  4. 快照差异：只有清单内的两类（见 ③）。
  5. `ccVariant` 参与别的判断：全仓无 `if (ccVariant …)` / 无按值分支（grep 核实）⇒ 不触发。

## 与 spec 的偏差

1. **出厂数据处数与施工单一致**（5 + 2 = 7）—— 与刀7 那次不同，这次单子的估计是准的。
2. **清单外但必要的连带（三处，均已一并处理）**：
   - `SettingsPreview.tsx:119` 的 **`cc-variant-peri`** 类（第四个变体名，全仓无对应样式）——
     与真变体同一机制（class 模板），只删生产那一半会留下"预览与生产不一致"，一并删；
   - `skinSchema.test.ts` / `themeFieldCopy.test.ts` / `interfaceMode.test.ts` /
     `builtinPresentationProfiles.test.ts` / `SettingsPreview.solidMigration.test.tsx` 这五份测试
     **不在施工单 §2 的 16 处里**，但它们引用被删的字段/属性（其中四处会**编译不过**）⇒ 属必然连带，逐个同步；
   - `themeFieldDefs.ts` 里那条"变体切换组件读 store 值（data-cc-variant）"的过时注释 —— 全仓并不存在这样一个组件，随字段删除一起清理。
3. ★ **一次操作失误（已恢复，如实披露）**：做 A/B 的"改造前"构建时，我本想"备份改动 → 回退指定文件"，
   但当时工作树**已经提交干净**（`git status` 为空）⇒ 取文件清单的命令产出空列表，`git checkout HEAD~1 -- <空清单>`
   被 git 解释成 **`git checkout HEAD~1`（整树切到游离 HEAD）**。后果与恢复：
   - 分支引用**未受影响**（`feat/cc-widget-definition-table` 始终指向 `c0157a02`，事后核对过）；
   - 工作树短暂处于 `744e949d`（刀6 终点）的游离态 —— 这恰好就是我要的"改造前"内容，**A/B 的 BEFORE 构建与实测都在该状态完成**；
   - 收尾用 `git switch feat/cc-widget-definition-table` 回到分支，`git status` 干净、内容与 `c0157a02` 一致。
   ★ 教训：**在"已提交干净"的树上不要用"按 git status 生成文件清单 + checkout 指定路径"这套手法** ——
   清单为空时它退化成整树切换。以后做 A/B 直接用 `git switch --detach HEAD~1`（意图明确）或临时 worktree。
4. **实机未能量到 `.cc-tasks-pill`**（三模式下该元素都不存在）⇒ 那两条规则的影响只能静态判断（见 ④ 表末行）。

## 未解问题

1. ★ **深色模式下控件变白块的观感**（见 ④ 的可读性提示）—— 需要你定夺是否要给控件按模式配一套底/字色。
   本刀**未自行配色**（单子只说把错层机制去掉）。
2. **老用户 localStorage 里残留的 `ccVariant` 键**：字段没了 ⇒ 由 `store.ts` 的 `partialize` 白名单在下次写盘时修剪
   （与刀5A / 刀7 同处置）。实机已确认：切一次界面模式后该键从 `pylon-theme.state` 消失。
3. **`SetupPreview` 失败占位的类名**：去掉 `cc-variant-peri` 后它就是 `control-center` —— 与真实中控同类名但无 `data-control-center` 属性，
   仍可区分；若将来要更稳的判据（例如加 `data-preview-placeholder`），属另一件事，本刀未动。
4. **`sendVariant`**（僵尸字段）仍在（用户已定「先放着」）—— 与本刀无关，只是提醒它还在。

## 并行交集

- 中控区：`themeFieldDefs.ts`、`store.ts`、`domains/workbench/appearance.ts`、
  `renderers/solid-workbench/input/ControlCenter.solid.tsx`、`ControlCenter.css`、`chat/StatusBar.css`、
  `plugins/core/renderer/builtinPresentationProfiles.ts`、`presets/builtin.ts`、
  `plugin-runtime/skin/skinResolver.ts`、`components/SettingsPreview.tsx`、`zones/factory/{terminal-cc,gui-cc}.ts`。
- 快照：`__fixtures__/workbench-skin-baseline.json`（**只能脚本重拍**）。
- 测试 12 份（见「测试处置」）。
- ★ **本刀与刀6 的冲突面已解除**（刀6 先做、已收口）；刀6 与本刀是同一条线上的最后两刀。
- 仓外文档已同步：《中控元件总表》；★ 留档**留在仓外**，未搬进仓库。
