# Dev Record — #238 第③件补遗（删零消费者残件 + 补「死数据不得回归」守卫）

> 入库保留。前情：第③件死数据清理（`04af4717`，记录 `238-cc-widget-definition-table-knife3-dead-data.md`）
> 分支 `feat/cc-widget-definition-table`

## 元信息

- issue：[#238](https://github.com/AlchemistCxC/Pylon-co-works/issues/238)
- 分支：`feat/cc-widget-definition-table`（**未 push、未开 PR**）
- 提交范围：`66c2e8f1..a49b581d`（`66c2e8f1` L.md 声明 → `a49b581d` 实现）
- 日期：2026-09-23

## 目标与范围

第③件收口时留下三件事，本轮落实（都很小）：

1. **删两样零消费者的残件**（旧目录视图一族仅剩的）；
2. ★ **加一条「死数据不得回归」的守卫测试**（本轮重点）；
3. 往验收技能里补一条坑。

**不做**：不动 `rendererKey` / `isolated-surface`（用户已定保留）、`sendVariant`（先放着）、
夹具里的 `ekg` / `tasks`；不动插件契约面；不动缩放（刀7）与面板分块（刀6）；
★ 本轮**不动《中控元件总表》**（只删两个无人用的导出/类型，不影响表的口径）。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src/domains/cc/widgetCatalog.ts` | 删 `BUILTIN_CC_WIDGET_CONTRIBUTIONS` 导出 + `BuiltinCcWidgetId` / `CcWidgetRuntimeId` 两个类型名；连带删掉因此不再被用的 `CC_WIDGET_IDS` import | 修改 |
| `src/domains/cc/__tests__/ccDeadDataGuard.test.ts` | 新增守卫测试（4 条用例） | **新增** |
| `.agents/skills/webview2-acceptance/SKILL.md` | 坑清单首位补一条「实机验收必须从当前源码重建产物」 | 修改 |

## 方案要点

1. **先各自 grep 再删**（本单要求）：三个名字在生产侧**各自零消费者** ——
   `BUILTIN_CC_WIDGET_CONTRIBUTIONS` 只有它自己的定义行；`BuiltinCcWidgetId` / `CcWidgetRuntimeId`
   只互相引用。★ **运行时注册不经过这个数组**：`plugins/core/cc/builtinCcWidgetPlugin.ts` 直接
   `registerWidget(BUILTIN_CC_SURFACE_CONTRIBUTION)` / `(BUILTIN_CC_SEND_BUTTON_CONTRIBUTION)`
   —— 所以删导出与注册无关，删后 `check:solid` 与全量测试照绿。
   ★ `CcWidgetRuntimeId` 将来插件通道可能要用 ⇒ 到那时**重新引入即可（显式动作）**，本轮先删。
2. **守卫测试的写法**（仿先例 `workbenchChromeCss.solid.test.ts`，刀5B 建的同款 CSS 侧守卫）：
   - **读生产源码文本**扫描四个"不得回归"的 token（跳过 `__tests__` / `__fixtures__` ——
     测试里的说明性文字**会提到**这些名字；并剥掉块注释/行注释，做法与先例同款）；
   - 额外的**精确选择器**断言：`.status-bar` 用 `/\.status-bar(?![\w-])/`，
     避开 `.file-status-bar` / `.sidebar-status-bar` 这类无关类（前一个字符必须是 `.`，故天然不命中）；
   - **结构断言**（不是文本匹配）：`Object.hasOwn(BUILTIN_CC_SURFACE_CONTRIBUTION, 'propertyFields') === false`；
   - **防空转**：先断言扫描面非空（生产源码 > 300 个文件、其中 `.css` > 10 个），
     免得 walk 写坏导致守卫假绿；`propertyFields` 那组另加"两条贡献本体仍在"的正控。
3. ★ **不做成教条**：测试头注释写明「若将来确要用其中任何一项，**改这条测试是一个显式动作** ——
   改哪一条、为什么改都会进 diff」。意义是：把"死数据悄悄回来"变成"有人主动决定它回来"。
4. **技能补的坑**具体到可执行：`bun run build` → `cargo build` → 重启，**三步缺一不可**；
   并给了自检手法（在页面里读 CSSOM，核对这一轮刚改过的选择器在不在，而不是看界面像不像）。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| 门禁五步 | ✅ `lint`（0 error，唯一 warning 在他人文件 `RightRailHost.tsx`）/ `build:example-plugin` / `build` / `check:solid` / `test` 全绿 |
| 全量测试对账 | ✅ **627 文件 / 4752 通过 + 1 todo**（补遗前 626 / 4748+1 ⇒ **+1 文件 / +4 用例**，正是新守卫的 4 条） |
| 新守卫反向验证（红 → 绿） | ✅ 把五项全部放回去 ⇒ **3 条用例红、逐项点名文件**；还原 ⇒ 4 条全绿（见「证据」③） |
| CSS 消费审计未受影响 | ✅ 注入 113 / 消费 348 / 声明 353 / 死注入 0 / 悬空引用 0（与第③件一致；本刀不碰 CSS） |
| 总表 | ✅ **本轮不动**（施工单点名），已在此说明 |
| 开发记录 / 待办 / issue 回写 | ✅ 本文件 + `待办/中控死数据清理-待办.md`（两条遗留标记为已办）+ #238 评论 |

## 测试处置

**新增 1 个测试文件 / 4 条用例**（`ccDeadDataGuard.test.ts`）；**未修改、未删除任何既有测试**。

## 证据

- **commit**：`a49b581d`（3 文件）；`git status` 干净；**未 push、未开 PR**。
- **① 删前三样 grep（全仓零消费者）**：

  ```
  grep -rn "\bBUILTIN_CC_WIDGET_CONTRIBUTIONS\b" src/ scripts/ shared/
  → src/domains/cc/widgetCatalog.ts:48（定义行，无消费者）
  grep -rn "\bBuiltinCcWidgetId\b" …
  → widgetCatalog.ts:53（定义）/ :54（被下一行引用）
  grep -rn "\bCcWidgetRuntimeId\b" …
  → widgetCatalog.ts:54（定义，无消费者）
  ```
  删后复跑同组 grep：**三项均为 0 命中**。

- **② 门禁五步**：

  ```
  lint                 → ✖ 1 problem (0 errors, 1 warning)   # 警告在 right-panel/RightRailHost.tsx（他人文件）  EXIT=0
  build:example-plugin → EXIT=0
  build                → EXIT=0
  check:solid          → EXIT=0；CSS 消费审计通过（注入 113 / 消费 348 / 声明 353，死注入与悬空引用均为 0）
  test                 → Test Files 627 passed (627) | Tests 4752 passed | 1 todo (4753)   EXIT=0
  ```
  **对账**：补遗前 626 / 4748+1 → 补遗后 627 / 4752+1 ⇒ **+1 文件 +4 用例** = 新守卫 4 条。

- **③ 反向验证（红 → 绿）** —— 把守卫覆盖的**五项全部**放回去（`BUILTIN_CC_WIDGET_DEFINITIONS` 导出、
  `src/components/cc/widgetCatalogView.ts` 里的 `mergeCcWidgetCatalog`、`ControlCenter.css` 的
  `.modern-command-dock` 规则、`StatusBar.css` 的 `.status-bar` 规则（带 `--status-bg`）、
  发送按钮贡献上的 `propertyFields`）：

  ```
  FAIL  #238 第③件 · 死数据不得回归 > 四项被删的死数据在生产源码里零命中（任何一项回来即红）
  AssertionError: 第③件删掉的死数据又回到了生产源码；若确要用，改这条测试是显式动作: expected [ …(4) ] to deeply equal []
  +   "components/cc/widgetCatalogView.ts → mergeCcWidgetCatalog（目录合并视图（文件已整删））",
  +   "domains/cc/widgetCatalog.ts → BUILTIN_CC_WIDGET_DEFINITIONS（旧目录视图（生产零消费者））",
  +   "plugins/…/styles/components/chat/StatusBar.css → --status-bg（statusBg / statusBgImage 留下的 CSS 变量引用）",
  +   "plugins/…/styles/components/ControlCenter.css → modern-command-dock（一族无渲染方的 CSS（ControlCenter.css / InputBar.css））",

  FAIL  #238 第③件 · 死数据不得回归 > `.status-bar` 选择器零命中（用精确边界，避开 `.file-status-bar` 这类无关类）
  AssertionError: `.status-bar` 那一块（该类无渲染方）又回到了样式表: expected [ Array(1) ] to deeply equal []

  FAIL  #238 第③件 · 死数据不得回归 > 两个内建贡献不再带登记字段 propertyFields（那 14 条从来没有读者）
  AssertionError: expected true to be false // Object.is equality

   Test Files  1 failed (1) | Tests  3 failed | 1 passed (4)
  ```

  ⇒ 四项 token 扫描、`.status-bar` 精确选择器、`propertyFields` 结构断言**三组全部按设计抓到**，
  且报错信息逐条点名"哪个文件 → 哪个 token"。
  ★ 顺带验证了精确边界：同一次扫描里 `FileSheet.css` 的 `.file-status-bar` **没有被误判**。

  还原（`rm` 探针文件 + 从备份逐份还原三份源码，均目录内文件）后：

  ```
   Test Files  1 passed (1) | Tests  4 passed (4)
  ```
  `git status` 只剩本刀该有的改动（`widgetCatalog.ts` 修改 + 新测试文件），无探针残留。

## 与 spec 的偏差

无。（施工单三步逐条照做；守卫覆盖项、反向验证、技能补坑均按单子。）

## 未解问题

1. 守卫只覆盖**第③件删掉的**那几项（单子点名范围）。`不认识的死数据`（例如将来新增的零消费者导出）
   仍没有通用守卫 —— 要通用化得做"export 零消费者"静态审计或维护一张死符号清单，属另一件事，**本轮不做**。
2. `CcWidgetRuntimeId` 被删是**暂时**的：插件通道打通时重新引入（显式动作，见守卫注释与 L.md 声明）。
   ⇒ 已记入待办，避免将来有人看到它缺失而误以为是漏删。

## 并行交集

本次碰过的共享文件：

- `src/domains/cc/widgetCatalog.ts`（与刀7 无关，刀7 不碰此文件）、
  `src/domains/cc/__tests__/ccDeadDataGuard.test.ts`（新增，独立文件）、
  `.agents/skills/webview2-acceptance/SKILL.md`。
- ★ 与刀7（`10-施工单-刀7-删掉缩放.md`）的冲突面**未变化**：仍同改 `widgetDefinitionTable.test.ts`
  与出厂数据 ⇒ **不可并行**；本补遗**未碰**这两个面，刀7 可续做。
