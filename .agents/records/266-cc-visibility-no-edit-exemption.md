# Dev Record — #266 中控显隐：编辑态**去豁免** + 退「变淡」（刀 1 · 显隐与布局两层模型）

> 入库保留。施工单：`E:\Acode\FILES\任务\工作台优化\待办\05-施工单-显隐去豁免与退变淡（刀1）.md`；
> 规范：`E:\Acode\FILES\任务\工作台优化\方向-显隐与布局的两层模型（待立项）-20260927.md` §六。
> 施工单是一次性的、不入库；其目标、范围与验收结论由本记录承接。

## 元信息

- issue：**#266**（总账 ·【待立项】显隐与布局的两层模型 · **刀 1**）
- 分支：`feat/cc-visibility-two-layer.1`（基于**远端** `origin/main @ 417e2e1d` = PR #404 合并点；建后已 `git branch --unset-upstream`）
- 提交范围：`417e2e1d..工作树`（**未提交** —— 施工单要求不 commit / 不 push / 不开 PR）
- 日期：2026-09-27

## 目标与范围

**要达成**：编辑态下被藏起来的元件**不再在场**（不再渲染），取代此前"在场但 `opacity: 0.18` 淡显"的做法。

依据（"淡"与"在场"拆不开，规范 §4.2.1）：`isWidgetVisible = 编辑态豁免 || 不在名单里` ⇒ 编辑态下被藏件照常渲染，"淡"的类按名单判 ⇒ 两者合起来才是"看得见但不显眼"。
**单去掉"淡"、留着"在场"，会比现状更糟**（编辑态下被藏的件照常显示、完全看不出被藏）⇒ 本刀两件一起去。

**不做**
- 空态盒子（刀 2）、高度模型（刀 3）、显示前校验（刀 4）、对应指示（刀 5）；
- CC-29 那批悬空规则；`set-cc-hidden` 开关本身（它是清单的显隐入口，保留）；
- `resolveVisibleStatusWidgetCount` 的去留（留给刀 3）；
- `cc-edit` 类与编辑器其它机制（含拖拽碰撞守卫自己的 `editMode` 参数 —— 另一套机制）。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src/domains/cc/widgetDefinitions.ts` | `WidgetVisibilityCtx` 删 `editMode?: boolean`；`isWidgetVisible` 谓词体收成 `return !ctx.hidden.includes(id)`；谓词上方注释按新口径改写 | 修改 |
| `src/renderers/solid-workbench/input/ControlCenter.solid.tsx` | `visibilityContext()` 只回 `{ hidden }`（不再传编辑态）；删 `sendButtonHidden()` 与它的注释；删发送按钮 `hidden` 入参；`renderWidget` 类名去掉 ` cc-hidden`（共 3 处 `cc-hidden` 消失）；`sendButtonMode()` 上方注释同步 | 修改 |
| `src/renderers/solid-workbench/input/WorkbenchWidgets.solid.tsx` | `SolidCcSendButton` 去掉 `hidden?: boolean` prop 声明与 `${props.hidden ? ' cc-hidden' : ''}` 类名拼接 | 修改 |
| `.../builtin.pylon-renderers/styles/components/ControlCenter.css` | 删"幽灵态"两条规则（`.cc-widget.cc-hidden` / `.cc-send-button.cc-hidden` 的 `opacity` 与 `:hover`）及其说明注释 | 修改（删除） |
| `src/domains/cc/__tests__/widgetDefinitionTable.test.ts` | 两处去掉 `editMode: true` 入参/断言（该键已不存在）；一条改名 | 修改（断言改写） |
| `src/renderers/solid-workbench/__tests__/mountSolidControlCenterPreview.solid.test.tsx` | 一条反转、一条改写为新用例、一条改写为"清单入口"新用例、一条只清注释；import 补 `fireEvent` | 修改（断言改写 + 新增） |
| `src/renderers/solid-workbench/__tests__/mountSolidWorkbench.solid.test.tsx` | ①「中控编辑工具栏可隐藏、恢复、重置并退出」的 `cc-hidden` 断言改 `toBeNull()` + 补"回到场"；②「04b 空态 + 编辑模式：4 个状态控件豁免可见」整体反转改名 | 修改（断言改写） |
| `.agents/records/266-cc-visibility-no-edit-exemption.md` | 本记录 | 新增 |

★ **代码/测试改动共 7 个文件**（上表前 7 行）。契约快照 `workbench-skin-baseline.json` 按施工单要求重拍过（`--write` EXIT=0），**零数据漂移**，收口前该文件已与 `HEAD` 一致 ⇒ **最终工作树里没有 fixture 改动**（明细见"证据"末条）。

## 方案要点

1. **判据收成一处**：`isWidgetVisible` 从此只有一件事 —— 隐藏名单。上下文 `WidgetVisibilityCtx` 相应收成 `{ hidden }`，`editMode` 这个字段**从类型上删除**（不是留着不用）⇒ 后人要复活编辑态豁免，必须显式改类型，是一个编译期可见的动作。
2. **"退变淡"是三处一起**：CSS 两条幽灵态规则 + `renderWidget` 的类名注入 + 发送按钮的 `hidden` prop。三处都删干净，`sendButtonHidden()` 随之失去消费者一并删（减重），发送按钮回归"按 `sendButtonMode()` 决定渲不渲染"的单一路径。
   ★ 注意发送按钮是**独立组件**（不挂 `.cc-widget`），所以它的在场/不在场由 `sendButtonMode()` 走**同一个谓词**决定 —— 本刀之后它不再需要"在场 + 标记"这种表达。
3. **回退 CC-02 的第 2/3/4 步**（本刀的直接连带）：那三步是「给按钮加 `hidden` 标记 → 幽灵态 CSS 扩到 `.cc-send-button` → 内置件一起用名单（为了一起淡）」，属"变淡"那一套，**整段撤掉**。CC-02 的第 1 步（判据收成一处）与第 5 步（工具栏如实）**保留** —— 第 5 步的断言在本刀未改，仍然绿（它只查清单、不查画布）。
4. **另一消费者天然不受影响**：`ccHeightState.resolveVisibleStatusWidgetCount` 传的是 `{ hidden }`、**从来没传过编辑态** ⇒ 它的计数语义本来就是"非编辑态的在场件数"。本刀对该文件**一行未改**，其测试未红 —— 这也是"没越界"的一个读数。
5. **编辑器障碍集天然自洽**：障碍集由 `measureWidgetBox` 实测（`querySelector('[data-widget-id=…]')` 拿不到节点就 `undefined`、被过滤）⇒ 被藏件**没有节点 ⇒ 不可能是障碍**，旧代码里"看不见的障碍挡住拖拽"这一症状随本刀消失。这一点在实机做了读数（见"证据"）。
6. **注释同步**（`AGENTS.md` §6.2）：`sendButtonMode()` 上方原写"编辑态豁免不再手抄" —— 豁免整族撤掉后这句会误导后来者，已改写；`widgetDefinitionTable` 与新用例里引用 `cc-hidden` 的措辞一并清掉（顺带让 `grep -rn "cc-hidden" src/ --include=*.tsx` 的读数只剩动作名 `set-cc-hidden`）。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| 谓词不再含编辑态 | ✅ `grep -c "editMode" src/domains/cc/widgetDefinitions.ts` = **0**；谓词体 = `return !ctx.hidden.includes(id)` |
| "淡"整族清干净 | ✅ `grep -rn "cc-hidden" src/ --include=*.css` = **0**；选择器形式 `grep -rn "\.cc-hidden" src/` = **0**；`.tsx` 严格读数 = **1**，唯一命中是**动作名** `set-cc-hidden`（施工单 §三 明确保留） |
| `sendButtonHidden` 已无残留 | ✅ `grep -rn "sendButtonHidden" src/` = **0** |
| 另一消费者未受影响 | ✅ `ccHeightState.ts` 未出现在 diff 里；`ccHeightState.test.ts` 3 passed、一行未改 |
| ★ 实机：编辑态下被藏件不在场 | ✅ 编辑态点「隐藏 模型」⇒ `querySelector('[data-widget-id="model"]')` = **null**、全页同查 = **null**、中控在场件 6 → 5、全页 `.cc-hidden` 计数 **0** |
| ★ 实机：清单是唯一入口且如实 | ✅ 该格 `dim=true`、文案 `＋ 模型`、开关 `aria-label="显示 模型"`；点它 ⇒ 节点回来（`opacity: 1`、`cc-widget cc-natural cc-edit`、无幽灵类）、清单回到 `● 模型` |
| 编辑器不回归 | ✅ 障碍集：被藏件 `measurable:false` 不入集；实拖「思考强度」左移 40px ⇒ `translate(-40px, 0px)` 完整接受；拖回 ⇒ `(none)`；进出编辑态各 2 次正常；重放窗口内控制台 0 条记录 |
| 门禁 + 快照 | ✅ 五步全 EXIT=0（详见"证据"）；快照 `--write` EXIT=0 且**零数据漂移**（仅 `generatedAt` 变），收口时该文件已回到与 `HEAD` 一致 ⇒ 最终工作树无 fixture 改动 |
| 反向验证（新用例改坏） | ✅ 见下节「★ 教训」—— 正确造坏后**红 3 条** |
| 说明书漂移 | ✅ `docs/说明书/` 未涉及本刀语义（施工单未点名） |

## ★ 教训：本次改动是**两处一起**，只还原一处是**静默空操作**

这是本刀最值得写下来的一条，因为它会让**反向验证本身失效**（测试全绿、你却以为"造坏没生效/新用例没用"）。

**机制**：编辑态豁免需要**两处同时在位**才生效 ——

1. 谓词里那半句：`ctx.editMode === true || …`（`widgetDefinitions.ts`）
2. **调用方把编辑态传进上下文**：`visibilityContext()` 里 `editMode: appearance().ccEditMode`（`ControlCenter.solid.tsx`）

把 `editMode` 从 `WidgetVisibilityCtx` 类型里删掉之后，**只把谓词改回带豁免**，`ctx.editMode` 拿到的是 `undefined`（调用方根本没传） ⇒ `undefined === true` 为假 ⇒ 豁免**不会生效**。
后果：**整文件 7 passed 全绿**，看起来像"新用例是假测试"或"造坏失败"，实际上造坏是**空操作**。正确的造坏必须**两处一起还原**。

**实测两半都留了证据**（原始输出见报告目录）：

| 造坏方式 | 结果 | 含义 |
| --- | --- | --- |
| **两处一起**还原（谓词带豁免 + 调用方传 `editMode`） | ❌ **3 failed / 4 passed** —— 两条新用例（发送按钮不在场 / 清单入口）+ **既有**「04b 空态极简：…编辑态下仍不在场」 | 守卫是**双重**的：既有用例也会挡 |
| **只还原调用方**（谓词仍带豁免，即谓词=带豁免、上下文=不传） | ✅ **7 passed**（全绿） | ★ **静默空操作**：造坏没生效，反向验证看不出任何异常 |

★ 另一条同源的坑（本轮实际踩到）：第一次跑反向验证时我用了 `-t "刀1"` 过滤测试名，**既有的「04b 空态极简」那条被 skip 掉**，于是只看到 2 条红、误以为"只有新用例在守"。
⇒ **反向验证不要用名字过滤**，要跑整个文件/整组；`skipped` 计数要当回事。

**为什么守卫是双重的**：两条新用例检查的是**新语义**（DOM 缺失），而既有的「04b 空态极简」用例本来就在断言"空态下这些件不渲染"，我把它的编辑态那一半反转成"仍不在场"之后，它同时也是"编辑态不豁免"的守卫 ⇒ 谁把豁免放回来，两处一起红。

## 测试处置

**改写**（均为施工单 §五 点名的"按新语义校准"，非擅自改动行为测试）：

1. `mountSolidControlCenterPreview.solid.test.tsx`「04b 空态极简：发送按钮空态隐藏、**编辑模式豁免可见**，选择器始终不显示」→「…编辑态下**仍不在场**…」：靶子反转，并加**正控**（断言编辑工具栏已出现）防"根本没进编辑态导致假绿"。
2. `mountSolidControlCenterPreview.solid.test.tsx`「CC-02 编辑态豁免吃的是同一份隐藏名单：预设 `ccHidden` 藏了发送按钮，编辑态它仍在场」→「★ 刀1：编辑态下被预设 `ccHidden` 藏起来的发送按钮**不在场**（DOM 缺失）」：靶子反转（**新增用例之一**）。
3. `mountSolidControlCenterPreview.solid.test.tsx`「CC-02 第 4 步同源：空态 + 编辑态下内置件带同一个「藏着了」标记」→「★ 刀1：清单是隐藏件唯一入口 —— 被藏件不在场、清单如实说「已隐藏」、点「显示」它回来」：靶子换成"入口可用"（**新增用例之二**）。
4. `mountSolidControlCenterPreview.solid.test.tsx`「CC-02 第 5 步收口：工具栏那一格与控件同源」：**断言未改**（只清了一句引用已删幽灵态的注释）⇒ **仍绿**，与施工单 §五 的预期一致（判据没串）。
5. `widgetDefinitionTable.test.ts`「命令行提示：没有会话 / 标准输入模式下照样可见」：删掉 `editMode: true` 那一行（该键已不存在）。
6. `widgetDefinitionTable.test.ts`「`ccHidden` 仍能藏它；编辑态豁免（把藏起来的元件露出来）」→「`ccHidden` 仍能藏它 —— 判据只有名单（★ 刀1：编辑态豁免已撤，编辑态同样不显示）」。
7. `mountSolidWorkbench.solid.test.tsx`「中控编辑工具栏可隐藏、恢复、重置并退出」：`toHaveClass('cc-hidden')` → `toBeNull()`，并在点「显示 模型」后**补一条"回到场"**断言。
8. `mountSolidWorkbench.solid.test.tsx`「04b 空态 + 编辑模式：4 个状态控件豁免可见，选择器仍不显示」→「…状态控件**不再豁免**（仍不在场）…」：整体反转 + 加"编辑工具栏已出现"正控。
   ★ 这条**不含 `cc-hidden` 字样**，按施工单 §五 的字面 grep 扫不到 —— 是**首次全量跑才暴露**的（详见"与 spec 的偏差 2"）。

**新增**：无独立新增文件；两条"新用例"是在既有文件内改写的（上表 2、3）。

**未删除**任何测试文件；除上表 8 条外无其它测试被修改（`ccHeightState.test.ts` 明确未动）。

## 证据

- commit：**无**（施工单要求不 commit / 不 push / 不开 PR）⇒ 证据以"分支 + 工作树"形式留存
- 门禁（复跑，原始输出见报告目录）：
  - `bun run lint` **EXIT=0**（0 error / 1 既有 warning，在 `src/sheets/gateway/GatewaySheetView.tsx`，非本次文件）
  - `bun run build:example-plugin` **EXIT=0**
  - `bun run build` **EXIT=0**
  - `bun run check:solid` **EXIT=0**（CSS 消费审计：注入 106 / 消费 347 / 声明 363，**死注入与悬空引用均为 0**）
  - `bun run test` **EXIT=0**，`Test Files 660 passed | 1 skipped (661)`、`Tests 5091 passed | 1 skipped | 1 todo (5093)`
  - `bun scripts/check-workbench-theme-contract.mts --write` **EXIT=0**（"内置预设 10 个；自定义预设 0 个；主题字段 176 个；Workbench CSS variables 89 个；fixture 15 个"）
  - ★ **契约快照的最终状态**：`--write` 的产出相对 `HEAD` **只有 `generatedAt` 一行**（本刀不涉及主题数据 ⇒ **零数据漂移**，那个时间戳是 `--write` 的固有产物）。收口时该文件已与 `HEAD` **完全一致**（`git diff` 为空、`generatedAt` 回到 `2026-09-27T04:19:30.692Z`、mtime 2026-09-28 15:27 —— **不是本轮的 `--write` 所写**）⇒ **最终工作树里没有 fixture 改动**，`git status` 只剩 7 个代码/测试文件 + 本记录。此处如实登记，以免后人据"快照被改过"去找一个已不存在的差异。
- 反向验证（原始输出落 `报告等\05-…（刀1）\`）：两处一起造坏 → `Tests 3 failed | 4 passed (7)`；只还原调用方 → `Tests 7 passed (7)`（静默空操作）；复原后 → `Tests 7 passed (7)`
- 实机（Pylon × WebView2 153.0.4234.48，`tauri dev`）：
  - **"读的是不是本轮产物"自检**：页面 `http://127.0.0.1:1430/` 加载 `assets/index-DXvSLw_c.js` + `assets/index-Cko_xyGH.css`，两者 mtime = 本轮 `bun run build` 时间；服务端 `/index.html` 的资源清单与磁盘 `dist/index.html` **逐项相同**（`tauri dev` 无 `devUrl`，assets 从磁盘现读）；打包后 CSS 里 `cc-hidden` 命中 **0**；`typeof window.__TAURI_INTERNALS__.invoke === "function"`
  - ★ **方法学一条**：skill 里"读 `document.styleSheets`(CSSOM) 核对选择器"这招在本机**不成立** —— `cssRuleCount = 0`、连正控选择器都查不到（本应用/该 WebView2 版本下样式表不可经 CSSOM 读）。**亏得先跑了正控**，否则"`cc-hidden` 未命中"会被误当成"旧规则已删"。改用上述"服务端 index.html ↔ 磁盘 dist 逐项比对 + 打包 CSS grep"。
  - 读数数值见"验收标准与结果"；交互走真实 UI（设置 → 中控台 → 进入布局编辑器 → 工具栏「隐藏 模型」/「显示 模型」→ 退出编辑），拖拽用 CDP `Input.dispatchMouseEvent` 真实指针序列，读数用 `querySelector` + `getBoundingClientRect` + inline `transform`
  - 控制台：重放窗口（全局 seq 72→114，覆盖"进编辑器→隐藏→显示→退出"整套）内 console 记录 **0 条**（error / exception / log 全 0）；同窗口网络面 **25 条**、状态码全 **200**、`failed` 全 `null` —— 作正控证明该窗口确实覆盖了操作
- 仓外文档：施工单与规范（见文首路径）；报告目录 `E:\Acode\FILES\任务\工作台优化\报告等\05-施工单-显隐去豁免与退变淡（刀1）\`（含 `2026-09-27-工作者汇报.md` 与 5 份原始输出；★ 按项目口径，单子完工后该目录要清）

## 与 spec 的偏差

1. **额外改了一处注释**：`sendButtonMode()` 上方原写"★ CC-02：编辑态豁免不再手抄，改由 isWidgetVisible 承担" —— 施工单只点名 `visibilityContext()` 的注释，但豁免整族撤掉后这句会**误导后来者**（`AGENTS.md` §6.2 顺手清理可确认的过时注释）。同一文件、同一机制，已在汇报里显式登记。
2. **多改了施工单「必读文件清单」之外的一个测试文件**（`mountSolidWorkbench.solid.test.tsx`，2 处）：施工单 §五 已有该类别的授权（"其它任何断言 `cc-hidden` / `hidden` prop 的用例 ⇒ 逐个点名同步"），其中 ① 直接对号；②「04b 空态 + 编辑模式」**不含 `cc-hidden` 字样**、grep 扫不到，是**首次全量跑才暴露**的，按新语义校准并在测试内加了正控。**已显式上报**，可回退。
3. **验收判据 2 的 `.tsx` 严格读数是 1 而非 0**：唯一命中是**动作名** `set-cc-hidden`，而施工单 §三 明确"不动 `set-cc-hidden` 这个开关本身" —— 两条相抵，按 §三 保留。要做到字面 0 只能改动作名（跨 `appearance.ts` 与两个 store），不在本单范围。**已上报**。
4. **反向验证的第一次读数不完整**：第一次我用 `-t "刀1"` 过滤，把既有的「04b 空态极简」用例 skip 掉，只看到 2 条红。复核后按"不加名字过滤"重跑，正确读数是 **3 条红**（见"★ 教训"）。

## 未解问题

1. **`set-cc-hidden` 动作名与验收判据 2 的字面冲突**（见"偏差 3"）⇒ 要不要为了字面 0 而改动作名，请翻译裁。
2. **`resolveVisibleStatusWidgetCount` 仍在**：本刀未动（施工单留给刀 3 决定去留）。它今天无生产消费者（最小高已是常量），刀 3 若恢复"按组算保底"，粒度也对不上 ⇒ 建议按"死数据"处置（删或立守卫）。
3. **"一个提前被藏起来的件"在编辑态的可达性**：本刀之后，被藏件在画布上完全不可见，唯一入口是编辑工具栏清单。清单目前只到"哪一格 + ＋/● + 显示/隐藏"，**没有"画布上的件对应清单哪一格"的指示**（刀 5 的题）。用户已明确"后面加一个指示"。
4. **退出编辑器时的重叠校验**：规范 §四已定案"不做重叠检测"，本条**不是遗留**，此处仅备忘：`ControlCenter.solid.tsx` 退出编辑器三处仍是直接 dispatch 关掉，不校验 —— 与定案一致。
5. **网络**：开工时 `git fetch origin main` 连不通（连接重置 / 超时各一次），分支基线用的是**本地已有的** `origin/main @ 417e2e1d`，未与真远端核对是否又前进 ⇒ 若远端已推进，本支需并一次 main 再核验。

## 并行交集

本分支改动的文件（请其他贡献者避让）：

- `src/domains/cc/widgetDefinitions.ts`（★ 高频共享：近期的 `266-cc-visibility-as-value`、`266-cc-widget-free-colors`、`238-cc-widget-definition-table-knife*` 都动过它）
- `src/renderers/solid-workbench/input/{ControlCenter.solid.tsx,WorkbenchWidgets.solid.tsx}`
- `src/plugins/product/packages/builtin.pylon-renderers/styles/components/ControlCenter.css`
- 测试：`src/domains/cc/__tests__/widgetDefinitionTable.test.ts`、`src/renderers/solid-workbench/__tests__/{mountSolidControlCenterPreview,mountSolidWorkbench}.solid.test.tsx`
- 本文件

（契约快照 `workbench-skin-baseline.json` **不在最终改动集内** —— 见"证据"末条。）

★ **与后续刀的关系**：刀 2（空态盒子）也要动 `widgetDefinitions.ts`（`EMPTY_STATE_HIDDEN_WIDGET_IDS` 与 `resolveCcHiddenWidgetIds`）⇒ 与刀 2 同文件，开 PR / 合并时需过一次合并。本刀与刀 2 的**区域不重叠、语义不冲突**（本刀动谓词与上下文，刀 2 动名单组装）。

★ **本刀回退了 CC-02 的 3 步**（详情见"方案要点 3"）⇒ 若有人基于 `fix/cc-02-send-button-edit-mode` 分支继续工作，需知它的第 2/3/4 步产物在这里被撤掉。
