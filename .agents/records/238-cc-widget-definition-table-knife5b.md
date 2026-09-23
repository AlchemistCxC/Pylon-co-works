# Dev Record — #238 刀5B 命令行提示升格（普通行内元件）+ 分隔点整族删除

> 入库保留。施工单：`E:\Acode\FILES\任务\工作台优化\元件定义表\08-施工单-刀5B-命令行提示升格.md`
> 规范：同目录 `00-施工规范-中控元件定义表-v1.0.md` §7（刀5B 行）；分支 `feat/cc-widget-definition-table`

## 元信息

- issue：[#238](https://github.com/AlchemistCxC/Pylon-co-works/issues/238)
- 分支：`feat/cc-widget-definition-table`（**未 push、未开 PR**，本地领先远端）
- 提交范围：`b5dadea7..839710ca`（`b5dadea7` L.md 声明 → `839710ca` 实现）
- 日期：2026-09-23

## 目标与范围

按用户 2026-09-22 口径（施工单 §0）**大幅简化后的两件事**：

1. **命令行提示升格为普通行内元件** —— **不做「整行元件」分类**，它「有多宽占多宽」；
2. ★ **分隔点整族删除**（用户：「分割点可以不要，我当时是懒得改，实际上也确实不用」）——
   这一删顺带把第③件里的「旧 `::before` 分隔规则整族」提前做掉了。

**保留的那条表语义**：可见性按**两个正交的东西**写 ——
**显/隐两值**（`inActiveSession: 'show' | 'hide'`）+ **可扩展的状态检测条件**
（`conditions` + 一张条件表 `CC_VISIBILITY_CONDITIONS`）。★ **不做「三档」枚举**
（用户原话：「三档还是局限……万一以后不止有这三种工况呢？」）。

**不做**：不加任何「整行/行内」字段；不动布局模型/锚点（刀3）；不动碰撞算法本体（刀4，但要回归四条）；
不动缩放（刀7）、面板分块（刀6）、其余死数据（第③件剩余部分）。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src/domains/cc/widgetDefinitions.ts` | 加 `inActiveSession` / `conditions` 两字段（**替换**布尔 `alwaysVisibleInActiveSession`）+ `CcVisibilityCondition` 类型 + 条件表 `CC_VISIBILITY_CONDITIONS`；`isWidgetVisible` 判定顺序改为 `ccHidden(编辑豁免) → inActiveSession → conditions`；`WidgetVisibilityCtx` 补 `hasSession`/`hintMode`；`ALWAYS_VISIBLE_STATUS_WIDGET_IDS` 改按 `inActiveSession==='show'` 从 `STATUS_WIDGET_IDS` 派生；`cc-command-hint` 行 `draggable → true` + `inActiveSession: 'show'` + 三条条件；`input` / `cc-send-button` 补据实声明 | 修改 |
| `src/ccHeightState.ts` | `resolveVisibleStatusWidgetCount` 的入参补 `hintMode` / `hasSession`（**计数逻辑本身不改**） | 修改 |
| `src/themeFieldDefs.ts` | `ccHeight` 的 `minFn` 传 `hintMode`、**不传** `hasSession`（主题对象拿不到会话信息） | 修改 |
| `src/renderers/solid-workbench/input/ControlCenter.solid.tsx` | `renderBody` 加 `cc-command-hint` 分支；删裸渲染 `commandHint()` 与两处调用；删分隔点插入逻辑与 `cc-status-entry` 包装；`visibilityContext()`/`minHeight()` 补新 ctx 字段 | 修改 |
| `.../builtin.pylon-renderers/styles/components/ControlCenter.css` | `.cc-command-hint` 去掉整行特化；删 `.cc-widget-separator` 样式族、两条旧 `::before` 回落规则、三处整行特化规则（窄窗 / cli+peri / terminal-like） | 修改 |
| `.../solid-workbench/WorkbenchChrome.css` | 删那处 `content: none !important` 收口（它唯一的作用就是压住上面那条 `::before`） | 修改 |
| `src/zones/factory/{terminal-cc,gui-cc}.ts` | 6 套完整 cc 条目的 `ccLayout.placements` 手补 `cc-command-hint`（`order 5 / 偏移 0`） | 修改 |
| `src/renderers/solid-workbench/__fixtures__/workbench-skin-baseline.json` | 脚本重拍（不是手改） | 修改 |
| 测试 4 份 | 见「测试处置」 | 修改 |

## 方案要点

1. **可见性两件正交的事**（施工单 §1）：`inActiveSession` 答"活跃会话里要不要"（缺省 `'hide'`），
   `conditions` 答"运行期满不满足"（可多选、全部满足才可见）。**工况只会增加** ⇒ 以后加一种工况 =
   往条件表加一行 + 需要它的行引用它，不动任何行的枚举值、也不动判定顺序。
2. **判定顺序与豁免**（`isWidgetVisible`）：`ccHidden` → `inActiveSession` → `conditions`。
   前两步**编辑态豁免**（编辑时要把藏起来的元件露出来才好操作，与门户里"编辑态全显"一致）；
   **`conditions` 不豁免编辑态** —— 与升格前的裸渲染条件逐条对齐（那时没会话/非命令行模式下，编辑态也看不到提示）。
3. **★ 门户口径没破**：`passesStatusGate` 仍是 `id === 'input' || showStatusSlots() || ALWAYS_VISIBLE…`；
   提示能过门户的唯一原因就是它也被 `inActiveSession: 'show'` 标进常态放行名单 ——
   **不写这一条，它就会在活跃会话里被门户滤掉**（刀5A 实测到的"不出现"，本刀反向验证 ① 重现了它）。
4. **`ALWAYS_VISIBLE_STATUS_WIDGET_IDS` 的派生收在 `STATUS_WIDGET_IDS` 上**：该名单的语义是
   「**状态控件**里常态放行的那些」，输入栏是常驻件、不进这个概念 —— 这样输入栏不必写 `id !== 'input'`
   之类的硬编码豁免，`isWidgetVisible` 对每一行都成立。
5. **`input` / `cc-send-button` 补 `inActiveSession: 'show'`**：据实声明（它们在活跃会话里确实显示）。
   `input` 若不写，升格后「活跃会话显/隐」这条轴会**把输入栏一起收起**（停手级 bug）；
   发送按钮的渲染目前走单独一行、不经过谓词，写它是为"声明与事实一致"。
6. **提示的渲染实现搬进 `renderBody`，条件不写在渲染里**：条件已由 `isWidgetVisible` 统一裁决
   ⇒ 不可见时它**自然不计数**（`resolveVisibleStatusWidgetCount` 与渲染共用一个谓词，C2 原则不破）。
7. **分隔点整族**（四处 + 断言）：① `statusGroup()` 里的插入逻辑（连同 `cc-status-entry` 包装一起去掉，
   因为那个包装只为分隔点服务）② `.cc-widget-separator` 样式 ③ `ControlCenter.css` 里两条
   `.cc-widget + .cc-widget::before` 回落 ④ `WorkbenchChrome.css` 的 `content:none !important` 收口。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| 门禁五步 | ✅ `lint`（0 error，唯一 warning 在他人文件）/ `build:example-plugin` / `build` / `check:solid` / `test` 全绿 |
| 全量测试 | ✅ **627 文件 / 4751 通过 + 1 todo**（基线 4743 ⇒ 本刀净 +8 条新测试） |
| ★ 分隔点 = 0（四个组合各一次） | ✅ cli+free **0** / 非 cli+free **0** / cli+peri **0** / 非 cli+peri **0**（另查"文本节点恰好是 `·`"的元素也 = 0） |
| 提示只出现一份 | ✅ cli 下 `[data-widget-id="cc-command-hint"]` = **1**，`.cc-command-hint` = **1**（不是两份、不是零份） |
| `cliHintMode` 三档行为不变 | ✅ compact = 2 段；full = **3 段**（多 `| Shift+Tab: 模式`，盒宽 205→345）；hidden = **DOM 里 0 个** |
| 非 cli 不显示 | ✅ 切到标准编辑器 ⇒ 提示 0 个、组内回到 4 个元件、min-height 64 |
| `ccHidden` 能藏 | ✅ 工具栏「隐藏」⇒ 落盘 `ccHidden` 含它；编辑态仍可见（编辑豁免）；退出编辑后 DOM **0** 个；再「显示」复原 |
| 改 `ccHintFontSize` ⇒ 字号跟着变 | ✅ 16 → 17 ⇒ 提示 **14.62px**（= 17 × 0.86，实测与期望逐位相同）、CSS 变量 17px、盒 205→217 |
| **编辑工具条 6 → 7** | ✅ 7 条：输入栏 / 模型 / 思考强度 / 权限模式 / 用量 / **命令行提示** / 发送按钮 |
| 提示「有多宽占多宽」 | ✅ 盒宽 **205.23**（compact）/ 345.1（full），`flex-basis: auto`、`order: 0`、`transform: none`、`text-align: start` |
| ★ 中控高度（cli+peri 的 +25px） | ✅ **先接受并实测**：`--cc-min-height`/`min-height` **84 → 109（+25px）**（提示成了第 5 个行内元件，跨过 `>4` 阈值）；cli+free 仍 **64**；**落盘 `ccHeight` 始终 109，未被抬高** |
| ★ 回归刀4 四条 | ✅ 全部重跑通过：挡住（交集 0、停在上一被接受位置）/ 沿边滑 / 面板旁路被挡 / 悬浮豁免（另有纯函数 16 条） |
| 提示「既受约束也当障碍」 | ✅ 不是悬浮件（`CC_FLOATING_WIDGET_IDS` 不含它）⇒ 自动进障碍集（新增断言钉住） |
| 契约快照 | ✅ 15/15 fixture 各多一条 `placements['cc-command-hint']`（order 5 / 偏移 0），**CSS 变量无变化**，只多 `generatedAt` |
| 反向验证 | ✅ 两条（见「证据」⑥） |
| 开发记录 / 总表 / 第③件待办 / issue 回写 | ✅ 本文件 + 仓外《中控元件总表》 + `待办/中控死数据清理-待办.md` + #238 评论 |

## 测试处置

**新增 8 条**（`widgetDefinitionTable.test.ts` +6、`workbenchChromeCss.solid.test.ts` +2）；
**同步既有断言 4 份**（全是"契约变更引起的写法同步"，逐条点名）：

| 文件 | 改了什么 | 为什么 |
| --- | --- | --- |
| `src/domains/cc/__tests__/widgetDefinitionTable.test.ts` | 控件/容器计数去掉单独 ∪ 的 `cc-command-hint`；「可拖行」由 6 改 7 且提示 `draggable: true`；`DEFAULT_CC_LAYOUT` 键序与值各加一项；`CC_WIDGET_IDS`/`STATUS_WIDGET_IDS` 各加一项；工具条 6 → **7**；常态放行 **4 → 5**；目录三份多一条；「表尾：结构步只进表」整块改成「已升格」+ 新增可见性两组用例 | 提示升格 + 名单改派生 |
| `src/renderers/solid-workbench/__tests__/mountSolidWorkbench.solid.test.tsx` | 「中控状态行…」用例：元件序列加 `cc-command-hint`；分隔点断言由"存在"改「**不存在**」，并加"组内除元件外没有别的节点"的判据 | 语义变更：分隔点已删 |
| `src/renderers/solid-workbench/__tests__/settingsPreviewControlCenter.solid.test.tsx` | 预览里的状态元件序列加 `cc-command-hint` | 同上（升格） |
| `src/domains/theme/__tests__/themeRehydrateAlignment.test.ts` | 结构对齐后 `placements` 的键集加 `cc-command-hint` | 刀2 的"缺项补默认"语义正是要它补进来 |
| `src/renderers/solid-workbench/__tests__/workbenchChromeCss.solid.test.ts` | **新增**两组 CSS 侧守卫（分隔点整族无残留；`.cc-command-hint` 无整行特化） | 反向验证 ② 的落点 |

**未修改且保持绿**：`ccPlacementCollision.test.ts`（刀4 纯函数 16 条）、`ccHeightState.test.ts`、`presetAssembly.test.ts`、`factoryZonePresets.test.ts`。

## 证据

- **commit**：`839710ca`（14 文件，+334/−108）；`git status` 干净；**未 push、未开 PR**。
- **① 门禁五步**：

  ```
  lint                 → ✖ 1 problem (0 errors, 1 warning)     # 警告在 RightRailHost.tsx（他人文件）
  build:example-plugin → [build-example-plugin] dist/entry.js + dist/styles.css + dist/entry.d.ts 已由 src/ 重建
  build                → ✓ built in 18.28s
  check:solid          → CSS 消费审计通过（注入 113 / 消费 350 / 声明 353，死注入与悬空引用均为 0）
  test                 → Test Files 627 passed (627) | Tests 4751 passed | 1 todo (4752)
  ```

- **② 实机 · 四个组合的分隔点（普通 `cargo build` 二进制 + WebView2 调试端点）**：

  | 组合 | 分隔点（`.cc-widget-separator`） | 文本为 `·` 的节点 | 组内元件 | 提示 | min-height |
  | --- | --- | --- | --- | --- | --- |
  | cli + free | **0** | 0 | model, reasoning, mode, tokens, cc-command-hint | 1 | 64px |
  | 非 cli + free | **0** | 0 | 4 个（无提示） | 0 | 64px |
  | cli + peri | **0** | 0 | 5 个 | 1 | **109px（基线 84，+25）** |
  | 非 cli + peri | **0** | 0 | —— | 0 | 64px |

- **③ 实机 · 提示本体（cli+free）**：

  ```
  hintCount=1  hintAsWidget=1  parent=cc-widget cc-natural
  hintText="/: 命令| Shift+Enter: 换行"      （compact 档）
  hintFont=13.76px（= 16×0.86，与刀5A 一致）  hintBox=205.23 × 18.57 @ (786.74, 758.71)
  flexBasis=auto  order=0  transform=none  textAlign=start     ← 整行特化确已去掉
  groupChildCount=5 = 组内元件数                                ← 组里除元件外没有别的东西
  相邻元件间隙 = 4px × 4（组内 gap）                            ← 见「与 spec 的偏差」第 2 条
  元件盒：model 120×28 / reasoning 132×28 / mode 132×28 / tokens 87.34×28 / 提示 205.23×18.57
  ```

- **④ 实机 · 三档 / 隐藏 / 字号字段**：

  ```
  compact → span=2（cc-command-hint-key, cc-hint-secondary）              文本「/: 命令| Shift+Enter: 换行」
  full    → span=3（+ cc-hint-tertiary）                                  文本「…| Shift+Tab: 模式」盒宽 345.1
  hidden  → DOM 里 [data-widget-id=cc-command-hint] = 0，组内回到 4 个
  ccHidden（工具栏「隐藏」）→ 落盘 ccHidden 含 'cc-command-hint'；编辑态仍可见（豁免）；退出编辑后 = 0；「显示」后复原
  ccHintFontSize 16 → 17  ⇒ 提示 14.62px（期望 14.62px）· CSS 变量 17px · 盒 205.23 → 217.18
  ```

- **⑤ 实机 · 工具条与设置还原核对**：

  ```
  工具条 chips = 7：输入栏 / 模型 / 思考强度 / 权限模式 / 用量 / 命令行提示 / 发送按钮
  还原核对（localStorage['pylon-theme']）：footerLayout=free, inputMode=cli, inputVariant=cli,
    cliHintMode=compact, ccHintFontSize=16, ccHidden=["cc-send-button","attach"], ccHeight=109,
    custom.cc=true（**切换前本来就是 true**：其 ccHidden 里还留着本刀从未触碰的旧 id `attach`）,
    appliedPreset 原样
  ```

- **⑥ 反向验证（两条，贴红）**：

  ① **没写 `inActiveSession` ⇒ 活跃会话里提示消失**（临时摘掉提示那行的 `inActiveSession: 'show'`）：

  ```
  Test Files  3 failed (3) | Tests  7 failed | 120 passed (127)
  FAIL … > 中控状态行仅保留常态控件（模型）与命令提示，其余旧控件关闭
  AssertionError: expected [ 'model', 'reasoning', 'mode', …(1) ] to deeply equal [ …(2) ]
  FAIL … > 命令行提示：`inActiveSession: show` + 三条条件（少了它，活跃会话里会被门户滤掉）
  FAIL … > 常态放行 5 条（原 4 + 命令行提示）…
  FAIL … > 非 cli 模式下提示不参与高度计数（条件在同一谓词里 ⇒ 自然不计数）
  FAIL … > 它在名单、默认布局、常态放行里；仍不在空态隐藏名单
  FAIL src/…/settingsPreviewControlCenter.solid.test.tsx > … 会话态不渲染旧状态槽（A6-3）
  ```

  ② **分隔点"删一半"（CSS 还在）⇒ 被 CSS 侧守卫抓到**（临时把 `.cc-widget-separator` 样式放回一处）：

  ```
  Test Files  1 failed (1) | Tests  1 failed | 7 passed (8)
  FAIL … > 分隔点那族在两张样式表里都没有残留（"删一半"会被这条抓到）
  AssertionError: ControlCenter.css 仍有 .cc-widget-separator
  ```

  （两处临时改动均已还原，还原后全量复跑绿 —— 见 ①。）

- **⑦ 契约快照 diff 归类**：

  ```
  15 + "cc-command-hint": {     15 + "order": 5,     15 + "offsetX": 0,     15 + "offsetY": 0,     15 + },
   1 - "generatedAt": … + "generatedAt": …
  （其余零差异：**CSS 变量一个没增没减** —— 本刀不动主题字段）
  ```

## 与 spec 的偏差

1. ★ **「常态放行名单仍是 4 个」在提示也标 `'show'` 的前提下不成立，实测为 5 条**
   （model / reasoning / mode / tokens / **cc-command-hint**）。施工单 §1-3 与 §4-2 都写"仍是那 4 个"，
   但 §1 的表同时要求提示 `inActiveSession: 'show'`；而门户只放行这份名单里的 id ⇒ **必须**放行它，
   否则就是停手条件里的"提示在活跃会话里消失"。⇒ 按功能必需实现为 5 条，并同步了那条断言（不是删断言）。
   ★ 名称口径未变：该名单仍是「**状态控件**里常态放行的那些」，所以从 `STATUS_WIDGET_IDS` 派生（输入栏天然不在其中）。
2. **相邻元件间隙由"分隔点宽度 + 两侧组内间隙"缩到只剩组内间隙（实测 4px）**：
   分隔点元素本身占位（刀5A 实测其盒宽 **24.8px** @16px 字号）+ 组内 `gap: 4px` ×2 ⇒ 改造前约 **32.8px**，
   现在 **4px**（实测）。这不是"靠 `::before` 的 padding 撑出的间距"（那两条 `::before` 早被
   `content:none !important` 压成零尺寸），而是**分隔点元素自己的占位** —— 删掉它，间距自然收紧。
   施工单 §5-3 点名的正是这件事，故逐条量在此报出。**没有**用魔法数字把间距补回去（那要另定，见"未解问题"）。
3. **cli + peri 的 `+25px` 实测确认为 25px**（84 → 109），与施工单 §6-2 预估一致；用户已同意先接受。
   本次实机里它**没有造成可见变化**：用户的 `ccHeight` 本来就是 109 = 新的最小高度；
   且**落盘值全程未被抬高**（`themeFieldDefs` 的 `minFn` 拿不到会话信息 ⇒ 含 `has-session` 条件的行在那里按"不可见"计
   ⇒ 写盘路径的 min 仍是 84）。cli+free 与两种非 cli 组合的 min 都没变（64）。
4. **出厂数据多补了 6 处 `cc-command-hint` 放置项**（施工单只写了"删键"）：`ccLayout` 在类型上是完整的
   `Record<CcLayoutWidgetId, CcWidgetPlacement>`，提示升格进名单后 6 套完整 cc 条目缺项 ⇒ `tsc -b` 直接报 TS2741。
   值取默认（order 5 / 偏移 0），与 `DEFAULT_CC_LAYOUT` 一致。
5. **`input` 与 `cc-send-button` 补了 `inActiveSession: 'show'`**（施工单未点名）：前者是**必须**
   （否则升格后"活跃会话显/隐"这条轴会把输入栏一起收起），后者是"声明与事实一致"（它渲染不走这个谓词）。
6. **顺带删掉 `statusGroup()` 里的 `.cc-status-entry` 包装节点**：它只为分隔点服务（`display:contents` 的透传壳），
   分隔点删了就没人用它了（准则 02 原则 4「换新必删旧」）。
7. 施工单 §3.3-4 写的「`passesStatusGate` 按 `availability` 分支（`'cli-hint'` 不受门户）」是**旧方案（三档）的残句**，
   已随 §6-1 的简化作废；本刀按 §1 的口径实现，**门户本身未改**（提示靠"进常态放行名单"过门户）。

## 未解问题

1. **相邻元件间距要不要补回来**：分隔点删掉后按钮型元件之间只剩 4px（改造前约 32.8px）。
   视觉上是否偏挤由用户定；要补的话是 `.cc-status-group` 的 `gap` 取值问题（本刀**不自行取数**）。
2. **`--cc-min-height` 的 `+25px` 只影响 `cli + peri`**：本次实机没暴露问题（ccHeight 109 ≥ 109），
   但如果将来有用户的 ccHeight 小于 109，进 cli 模式时中控会被抬到 109。是否放宽 `>4` 阈值由用户定（本刀不许自行改）。
   ⇒ ★ **用户 2026-09-23：「这个逻辑后面要修，记一下」** ⇒ 已登记仓外待办
   `E:\Acode\FILES\任务\工作台优化\待办\中控最小高-换行档-待定档.md`（该件由"待定档"转为**待修**，
   其 §8 记了本刀之后两个前提怎么变的：这条规则**不再死**；且 `25px`（怕换行，按个数猜）与
   `21px`（提示独占一行时代的预算，现在提示是行内元件）**两笔都偏多**，按新形状真实下限约 **88px**）。
   ★ 顺带记录：**元件间距收紧（约 32.8px → 4px）用户裁定不动**。
3. **写盘路径与渲染路径的 min 计算不同源**（前者拿不到 `hasSession` ⇒ 提示不计入）：
   这是"保守不改写用户落盘高度"的有意取舍，已在 `ccHeightState.ts` 与 `themeFieldDefs.ts` 的注释里写明。
   若将来两处需要严格一致，得把会话信息也接进 `minFn` 的调用方。
4. 编辑态下 `conditions` **不豁免**（与升格前一致）⇒ 用户在**非命令行模式**进编辑态时看不到提示、也没法拖它。
   与"其余要求零变化"一致，但将来若要"编辑态全显"，这是要动的一处。

## 并行交集

本次碰过的共享文件（供其他贡献者避让）：

- 中控区：`src/domains/cc/widgetDefinitions.ts`、`src/ccHeightState.ts`、`src/themeFieldDefs.ts`（`ccHeight.minFn`）、
  `ControlCenter.solid.tsx`、`WorkbenchChrome.css`、`ControlCenter.css`。
- **预设组装线**（该线已合入 main、无并行写者）：`src/zones/factory/{terminal-cc,gui-cc}.ts`。
- 快照：`__fixtures__/workbench-skin-baseline.json`（只能脚本重拍）。
- 测试：`widgetDefinitionTable` / `mountSolidWorkbench.solid` / `settingsPreviewControlCenter.solid` /
  `workbenchChromeCss.solid` / `themeRehydrateAlignment`。
- ★ **第③件待办已同步**：`E:\Acode\FILES\任务\工作台优化\待办\中控死数据清理-待办.md` 里
  「旧 `::before` 分隔规则整族」标记为**本刀已做**（连带 `.cc-widget-separator` 样式族一起）。
