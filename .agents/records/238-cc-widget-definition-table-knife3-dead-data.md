# Dev Record — #238 第③件 中控死数据清理（纯删除）

> 入库保留。施工单：`E:\Acode\FILES\任务\工作台优化\元件定义表\09-施工单-第③件-死数据清理.md`
> 规范：同目录 `00-施工规范-中控元件定义表-v1.0.md` §7（第③件行）；分支 `feat/cc-widget-definition-table`

## 元信息

- issue：[#238](https://github.com/AlchemistCxC/Pylon-co-works/issues/238)
- 分支：`feat/cc-widget-definition-table`（**未 push、未开 PR**，本地领先远端）
- 提交范围：`0fba3c68..04af4717`（`0fba3c68` L.md 声明 → `04af4717` 实现）
- 日期：2026-09-23

## 目标与范围

把中控区**确认无生产消费者的死数据**删掉。★ 本刀是**纯删除**，行为要求是**零变化**：
界面、渲染、主题字段、CSS 变量集合、契约快照**都应当没有差异**。

**删的五项**（逐条已在当前代码上重新 grep 复核，见「证据」①）：

1. 旧目录视图 `BUILTIN_CC_WIDGET_DEFINITIONS`（`src/domains/cc/widgetCatalog.ts`）；
2. 目录合并视图 `src/components/cc/widgetCatalogView.ts`（**整文件删**）+ 它自己的测试；
3. 两个内建登记贡献上的 `propertyFields`（6 + 8 条）；
4. `.modern-command-dock` 一族 CSS（`ControlCenter.css` / `chat/InputBar.css`）+ `composerVisualContract.test.ts` 里那条"CSS 文本存在"断言；
5. `chat/StatusBar.css` 里的 `.status-bar` 两块（同文件其它规则保留）。

**明确不做**（施工单 §0-2，不是遗漏）：

- `rendererKey` / `isolated-surface`（★ 用户 2026-09-23 已定**保留**，是打通插件显示的地基，属另一条线）；
- `sendVariant`（用户已定「先放着」）；
- 夹具里的 `ekg` / `tasks`（**有意的"不认识的 id"边界样本**）；
- `BUILTIN_CC_SURFACE_CONTRIBUTION` / `BUILTIN_CC_SEND_BUTTON_CONTRIBUTION` **本体**（运行时真的被注册）；
- 插件契约面 `ccWidgetTypes.ts` / `ccWidgetRegistry.ts`（`propertyFields` 是插件契约面，只是内建不再带）。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src/components/cc/widgetCatalogView.ts` | 整个文件（`mergeCcWidgetCatalog`） | **删除** |
| `src/components/cc/__tests__/widgetCatalogView.test.ts` | 整个文件（3 条用例） | **删除** |
| `src/domains/cc/widgetCatalog.ts` | 删 `BUILTIN_CC_WIDGET_DEFINITIONS` 与只服务它的 `WIDGET_PROPERTY_FIELDS` import；两个内建贡献的 `propertyFields` 删除；顺带更正那段"twelve legacy widgets"过期注释 | 修改 |
| `src/domains/cc/__tests__/widgetDefinitionTable.test.ts` | 「目录三份」那条用例的三处断言改成**直接读表** | 修改 |
| `src/plugins/core/renderer/__tests__/composerVisualContract.test.ts` | 删「现代 GUI 用独立 command dock」那条"CSS 文本存在"断言（用例名同步收窄） | 修改 |
| `.../builtin.pylon-renderers/styles/components/ControlCenter.css` | 删 `.modern-command-dock` 一族 8 行 | 修改 |
| `.../components/chat/InputBar.css` | 删 `.modern-command-dock` 一族 2 段共 16 行 | 修改 |
| `.../components/chat/StatusBar.css` | 删 `.status-bar` 规则 + 只含 `.status-bar button` 的 `@media` 块 + 一条过时小节注释 | 修改 |
| `src/renderers/solid-workbench/__fixtures__/workbench-skin-baseline.json` | 脚本重拍（**不是手改**） | 修改 |

## 方案要点

1. ★ **刀1 那三条断言改成「直接读表」，不是删掉**（施工单 §2-1 点名）：
   `widgetDefinitionTable.test.ts` 的「目录三份（名字 / 类别 / 位置）」原本断言的是
   `BUILTIN_CC_WIDGET_DEFINITIONS.map(...)` 的结果 —— 那是「表派生得对不对」的**间接**守卫。
   旧目录视图一删，**简单删断言等于白丢一层保护**，故改成直接读表行：
   - 名字 / 类别：`CC_WIDGET_IDS.map(id => resolveCcWidgetGroup(id)!)` 取 `id/label/category`；
   - 位置：同上取 `layout.x.anchor` / `layout.x.side` / `layout.order`（`offsetX/offsetY` 是插件契约
     形状里的固定 0，一并锁住）；
   - 「用量不新增属性字段（S11）」：由「目录里 `tokens` 不带 `propertyFields`」换成
     「表里 `WIDGET_PROPERTY_FIELDS.tokens` 为空」——**这才是那条断言真正要守的真值**。
   三条断言比较的**字面量一个字未改**，只是取数来源从"目录"换成"表"。
2. **`groupOf` / `defaultPlacementOf` 保留**：它们仍被两个内建贡献用（`label` / `category` / `defaultPlacement`）。
   被删的只是 `BUILTIN_CC_WIDGET_DEFINITIONS` 那段 map。
3. **`propertyFields` 只从内建贡献上摘掉，类型面不动**：`CcWidgetContribution.propertyFields`
   （`plugin-runtime/cc-widget/ccWidgetTypes.ts`）是**插件契约面**，保留；注册表 `normalize()`
   对"没有 `propertyFields`"本来就兼容（它是可选字段）。
   依据：属性面板读的是**表里**的表单 `WIDGET_PROPERTY_FIELDS`（`ControlCenter.solid.tsx`），
   登记带来的那 14 条**从来没有读者**。
4. **CSS 删除的"安全边界"**：三份样式表都不是"整文件删"，删的是**中间整块规则**。
   删中间块最大的风险是**花括号失衡 → 之后所有规则静默失效**，故本刀做了两重校验：
   ① 三份文件 `{`/`}` 计数相等（126/126、92/92、15/15）；
   ② 实机读 CSSOM，确认**每个删除区之后的尾部规则都还在**（见「证据」④）。
5. **`StatusBar.css` 顺带删掉一条过时小节注释** `/* ── cc widget separators (controlled by cc layout in ControlCenter) ── */`：
   分隔点整族已在刀5B 删除，该注释下挂的其实是 `.cc-variant-terminal` 变体规则 ⇒ 注释已误导。
   依仓库 `AGENTS.md` §6.2「顺手清理可确认的过时注释」处理。**规则一行未动。**
6. **零变化的正面证据是"没有差异"，不是"看起来一样"**：契约快照除 `generatedAt` 外逐字节相同；
   CSS 消费审计只有「消费 −2」（就是两条已死变量的引用，详见「证据」③）。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| 门禁五步 | ✅ `lint`（0 error，唯一 warning 在他人文件 `RightRailHost.tsx`）/ `build:example-plugin` / `build` / `check:solid` / `test` 全绿 |
| 全量测试对账 | ✅ **626 文件 / 4748 通过 + 1 todo**（基线 627 / 4751+1 ⇒ 文件 −1、用例 −3，恰等于被删的 `widgetCatalogView.test.ts` 3 条） |
| 契约快照重拍无差异 | ✅ 两个快照除 `generatedAt` 外**零差异**（`diff` 只有 1 行时间戳） |
| CSS 消费审计四/五项数字 | ✅ 注入 113（不变）/ 消费 **350 → 348**（−2，逐条解释见「证据」③）/ 声明 353（不变）/ 死注入 **0**（不变）/ 悬空引用 **0**（不变） |
| 实机外观一致 | ✅ 中控 cli+free 几何与刀5B 记录**逐位相同**（提示 `205.23×18.57@786.74,758.71`、组内 5 件、gap 4px、min-height 64px）；`--cc-height` 仍 109px |
| 反向验证 | ✅ 两条（见「证据」⑤）：能抓**无 fallback 的悬空引用**；**抓不到**重新引入的死数据 ⇒ 见「未解问题」1 |
| 开发记录 / 总表 / 待办 / issue 回写 | ✅ 本文件 + 仓外《中控元件总表》§3/§4 + `待办/中控死数据清理-待办.md` + #238 评论 |

## 测试处置

**删除 1 个测试文件（3 条用例）**：

| 文件 | 删了什么 | 为什么 |
| --- | --- | --- |
| `src/components/cc/__tests__/widgetCatalogView.test.ts` | 整个文件（`mergeCcWidgetCatalog` 的 3 条用例：内置优先 / 空目录 / 背景板 6 字段） | 被测对象 `mergeCcWidgetCatalog` 是**生产零消费者**的死代码，随它一起删（施工单 §0-1-2） |

**改写 1 条既有用例（不删覆盖）**：

| 文件 | 改了什么 | 为什么 |
| --- | --- | --- |
| `src/domains/cc/__tests__/widgetDefinitionTable.test.ts` | 「目录三份（名字 / 类别 / 位置）由表派生后内容不变」→「…**直接读表**后内容不变」：三处断言的取数来源由 `BUILTIN_CC_WIDGET_DEFINITIONS` 换成 `CC_WIDGET_IDS` + `resolveCcWidgetGroup` / `WIDGET_PROPERTY_FIELDS`；**比较的字面量一个字未改**；用例标题与注释同步 | 施工单 §2-1：旧目录视图被删后，这三条断言要**换成直接读表**，不能简单删掉（否则白丢一层保护） |
| `src/plugins/core/renderer/__tests__/composerVisualContract.test.ts` | 用例「Modern GUI 使用独立 command dock composer，经典终端被总作用域排除」→「经典终端被总作用域排除」：删掉断言 `toContain('[data-interface-mode="modern-gui"] .modern-command-dock .input-bar:not(.cli-mode)')`，保留另一条总作用域断言 | 它测的是**CSS 文本存在**（不证明有渲染方）；删 CSS 必须同时删它（施工单 §2-4） |

**新增**：0 条（本刀是纯删除）。**未触碰其它任何行为测试。**

## 证据

- **commit**：`04af4717`（9 文件；`git status` 干净）；**未 push、未开 PR**。
- **① 开工前 grep 复核（五项的消费者，全部确认零生产消费者）**：

  ```
  grep -rn "modern-command-dock" src/ scripts/            → 仅 CSS 2 文件 + composerVisualContract.test.ts
  grep -rn "BUILTIN_CC_WIDGET_DEFINITIONS" src/ scripts/  → 仅 widgetCatalog.ts(定义) + 两份测试
  grep -rn "mergeCcWidgetCatalog|widgetCatalogView" …     → 仅 widgetCatalogView.ts + 它自己的测试
  grep -rn "status-bar" src/                              → 仅 StatusBar.css（另有无关的 .file-status-bar / .sidebar-status-bar）
  grep -rn -- "--status-bg" src/ scripts/                 → 仅 StatusBar.css:2
  ```
  删除后同组 grep 复核：**四项均为 0 命中**（唯一残留是测试里那句解释性注释）。

- **② 门禁五步**：

  ```
  lint                 → ✖ 1 problem (0 errors, 1 warning)     # 警告在 right-panel/RightRailHost.tsx（他人文件）  EXIT=0
  build:example-plugin → EXIT=0
  build                → ✓ built in 18.75s                      EXIT=0
  check:solid          → EXIT=0
  test                 → Test Files 626 passed (626) | Tests 4748 passed | 1 todo (4749)   EXIT=0
  ```
  （改造前基线实测：`Test Files 627 passed (627) | Tests 4751 passed | 1 todo (4752)` ⇒ **−1 文件 / −3 用例**，与被删测试文件逐条对上。）

- **③ CSS 消费审计（改造前 → 改造后）**：

  ```
  改造前：CSS 消费审计通过（注入 113 / 消费 350 / 声明 353，死注入与悬空引用均为 0）
  改造后：CSS 消费审计通过（注入 113 / 消费 348 / 声明 353，死注入与悬空引用均为 0）
  ```
  逐条解释那 **−2**：把 `check-css-var-consumption.mts` 的"消费集"计算在三份改动 CSS 的
  **HEAD 版**与**改后版**上各跑一遍做差集，得到的正是：

  ```
  改后不再被消费: ["--status-bg","--status-bg-image"]
  改后新增被消费: []
  ```
  即消费数下降**完全来自** `StatusBar.css` 那条 `.status-bar` 规则引用的两个变量 ——
  它们**已在刀5A 随字段删除**，删掉引用是纯减法。
  ★ 关键点：**没有产生新的死注入**（注入数 113 不变）—— 三份 CSS 里其它变量
  （`--accent` / `--surface-canvas` / `--border` / `--text-dim` / `--surface-raised` / `--surface-overlay` /
  `--font` / `--mono` / `--msg-font` / `--chat-font` / `--input-font-size` / `--msg-line-height` /
  `--chat-line-height`）全都在别处仍被消费，所以它们的消费计数不变、也就不可能变成"注入却无人消费"。

- **④ 实机验收（普通 `cargo build` 二进制 + WebView2 调试端点）**：

  ★ 前置（踩过一次）：**前端改动必须重走 `bun run build` → `cargo build` → 重启 App**
  （`frontendDist` 编译期内嵌）。本次第一次启动用的二进制嵌的是**反向验证阶段的 dist**（混入了临时还原的
  死 CSS），发现后重新 `bun run build` + `cargo build` 再启动才算数 —— 数值结论全部取自重建后的那次。

  ```
  ① 删除项在实机里"无处可作用"（CSSOM 与 DOM 双向）：
     CSSOM 里 .modern-command-dock = 0 条规则   .status-bar = 0 条规则   --status-bg = 0 处
     DOM   里 .modern-command-dock = 0 个元素   .status-bar = 0 个元素
  ② 保留项仍活（证明三份文件被删区之后的规则没被"带走"）：
     CSSOM 里 .cc-permission-trigger = 9 条（含 4 条 [data-mode=...] 语义色）
             .cc-variant-terminal .cc-model-minimal = 1 条 ← StatusBar.css 的**最后一条规则**
             .control-center.cli-mode .cc-status-row = 2 条 / .modern-replay-continue = 1 条 ← ControlCenter.css 尾部
             .input-bar.cli-mode .input-row = 1 条 / prefers-reduced-motion 块存在 ← InputBar.css 尾部
     计算样式：.input-bar.cli-mode .input-row border = "2px solid rgb(136,136,136)"（cli 线仍在）
               .cc-status-row padding-left = "22.4px" = 1.4em（terminal-like 规则仍在）
               .cc-permission-trigger color = "rgb(167,176,170)"（[data-mode=default] 仍在）
  ③ 中控几何与刀5B 记录逐位相同（cli + free，interface-mode=terminal-like）：
     组内 5 件 model=120x28@299.4,754 / reasoning=132x28@423.4,754 / mode=132x28@559.4,754 /
            tokens=87.34x28@695.4,754 / cc-command-hint=205.23x18.57@786.74,758.71
     组 gap=4px，groupChildCount=5；hint 内层字号 13.76px、span=2、文本 "/: 命令| Shift+Enter: 换行"、
     flexBasis=auto / order=0 / transform=none / textAlign=start
     min-height=64px，--cc-min-height=64px，--cc-height=109px（落盘值未被抬高）
     ★ 分隔点回归：.cc-widget-separator = 0、.cc-status-entry = 0（刀5B 的成果保持）
     ★ 元件序列 = input, model, reasoning, mode, tokens, cc-command-hint（6 个，与改造前同）
  ④ 控制台：开机只有 1 条 error —— "切换 Agent失败 Object"，来源 first-party-pylon-shell，
     出处 `src/application/transactions/openOwnedSessionTransaction.ts:113`（切 Agent 事务）。
     与本刀触碰面（元件目录 / 三条 CSS 家族 / 登记字段）**无交集**；本环境没有可用的 Agent runtime。
     无任何 CSS / 渲染类报错。
  ```

- **⑤ 反向验证（两条）**：

  ① **故意保留一条已知死数据 ⇒ 现有门禁抓不到**（按施工单 §3-3 的做法：把四类死数据同时还原成
  改前状态 —— `widgetCatalogView.ts` 文件 + 两处 `propertyFields` + 两族死 CSS 全放回）：

  ```
  lint          → EXIT=0
  build         → EXIT=0
  check-css-var-consumption → CSS 消费审计通过（注入 113 / 消费 350 / 声明 353，死注入与悬空引用均为 0）
  test（相关 4 份）→ Test Files 4 passed (4) | Tests 50 passed (50)
  ```
  ⇒ **没有任何断言/审计能抓到"死数据回归"**（死导出、死字段、无渲染方的 CSS 文本、带 fallback 的
  悬空引用，四类全部静默通过）。**本刀缺一条「死数据不得回归」的守卫**，已计入「未解问题」1。

  ② **审计能抓的是"无 fallback 的悬空引用"**（把那条 `.status-bar` 里的 `var(--status-bg,transparent)`
  临时改成无 fallback 的 `var(--status-bg)`）：

  ```
  AssertionError: 以下 var 既未注入/声明也无 fallback（悬空引用）：
  --status-bg
      at E:\Acode\Pylon-co-works\scripts\check-css-var-consumption.mts:85:8
  AUDIT EXIT=1
  ```
  ⇒ 印证了刀5A 的遗留为何能长期不被发现：**只要写了 fallback，审计就不报**。

  （两处临时改动均已完整还原，还原后 `git status` 只剩本刀那 9 个文件；两条红/绿输出如上。）

- **⑥ 契约快照 diff（只贴差异行）**：

  ```
  -  "generatedAt": "2026-09-22T15:39:31.231Z",
  +  "generatedAt": "2026-09-23T03:02:40.371Z",
  ```
  两个快照（`workbench-skin-baseline.json` / `custom-presets-baseline.json`）**除时间戳外零差异**；
  重拍脚本自报：`主题字段 189 个；Workbench CSS variables 96 个；fixture 15 个`（与刀5B 同）。

- **⑦ dist 产物核对**（构建产物内嵌进 Rust 二进制，故顺带核一次）：

  ```
  dist 里 "modern-command-dock" = 0   "status-bg" = 0
  dist 里 "cc-permission-trigger" = 10  "cc-variant-terminal" = 2  "input-bar.cli-mode" = 13  "cc-status-group" = 5
  ```

## 与 spec 的偏差

1. **顺带删了 `StatusBar.css` 里一条过时小节注释**（`/* ── cc widget separators … ── */`）：
   施工单只点名"删 `.status-bar` 两块、其它规则要留"。该注释下挂的是 `.cc-variant-terminal` 规则、
   而分隔点整族已在刀5B 删除 ⇒ 注释已误导后来者，按仓库 `AGENTS.md` §6.2 清理。**规则一行未动**，
   如需保留注释可原样加回。
2. **顺带更正了 `widgetCatalog.ts` 那段过期注释**：原文写「The twelve legacy widgets remain catalog
   definitions, but their switch-based renderers are intentionally not registered yet」——
   目录定义已随本刀删除、且"12 个"这个数字早已不准（《中控元件总表》§4 的附注点名过它）。改为
   与现状一致的两句。属 `AGENTS.md` §6.2 的过时注释清理，同样是**注释改动、行为零变化**。
3. **`widgetDefinitionTable.test.ts` 那条用例的标题也改了**（「由表派生后内容不变」→「直接读表后内容不变」）：
   施工单只说要改断言，标题不改就名不副实。**用例数不变**（33 条），字面量不变。

## 未解问题

1. ★ **缺一条「死数据不得回归」的守卫**（施工单 §3-3 要求报告）：
   反向验证证明，把本刀删掉的四类死数据全部还原，**lint / build / check:solid / 测试全绿**。
   现状能抓的只有"**无 fallback 的悬空引用**"（CSS 审计）。
   ⇒ 若要防回归，需要新东西（例如：一条"已知死符号清单 + grep 断言"的测试，或一条
   "export 零消费者"的静态审计）。**本刀不自行发明该守卫**（属单子没提到的地方，按纪律停手报告，
   由翻译/用户决定要不要立一条）。
2. **清单外"顺手能删的"死数据（已发现、未删、已记待办）**：
   - `BUILTIN_CC_WIDGET_CONTRIBUTIONS`（`widgetCatalog.ts` 导出，**全仓零消费者**）；
   - `BuiltinCcWidgetId` / `CcWidgetRuntimeId`（同上，仅互相引用）。
   按施工单 §4-5「不要顺手删，记进待办」处理 ⇒ 已追加到
   `待办/中控死数据清理-待办.md` 的「本轮新发现（清单外，未删）」一节。
3. **`StatusBar.css` 现在名不副实**：它的 `.status-bar` 规则已删，文件里剩下的是 `.pill-mono` /
   `.prism-tag` / `.model-menu` / `.cc-permission-trigger` 等**与文件名无关**的规则。
   是否改名/拆分属结构调整，**不在本刀（纯删除）范围**，记入待办供后续决定。

## 并行交集

本次碰过的共享文件（供其他贡献者避让）：

- 中控区：`src/domains/cc/widgetCatalog.ts`、`src/domains/cc/__tests__/widgetDefinitionTable.test.ts`、
  `src/components/cc/**`（目录已随文件删除而清空）、`ControlCenter.css`、`chat/InputBar.css`、`chat/StatusBar.css`。
- 测试：`src/plugins/core/renderer/__tests__/composerVisualContract.test.ts`。
- 快照：`__fixtures__/workbench-skin-baseline.json`（只能脚本重拍）。
- ★ **与刀7（`10-施工单-刀7-删掉缩放.md`）冲突**：两者同改 `widgetDefinitionTable.test.ts` 与出厂数据 ⇒
  **不许并行开工**；本刀已先做完，刀7 可在本刀之上续做。
- ★ **仓外文档已同步**：《中控元件总表》§3/§4、`待办/中控死数据清理-待办.md`。
