# Dev Record — #266 遗留⑦ 出厂区域数据立位置一致性守卫 + order 连续化

> 入库保留。施工单 `元件定义表/15-施工单-出厂数据校验与序号整理.md`（仓外）不保留，
> 其目标、范围、方案与验收结论在此承接。

## 元信息

- issue：#266（中控遗留收尾）第 ⑦ 项
- 分支：`test/cc-factory-zone-data-guard`（基于 main `d360f9b0`）
- 提交范围：`d360f9b0..a4f2cb88`（两笔：`d87171ef` L.md 范围声明 + `a4f2cb88` 正事）
- 日期：2026-09-23

## 目标与范围

**做什么**

1. ★ 给**出厂区域数据**（`src/zones/factory/**`，50 条）立一条**与定义表一致**的机器校验 ——
   这批数据的生成脚本已随预设组装线刀3 删除（`scripts/generate-factory-zone-presets.mts`），
   **既不能重新生成、也没有任何"与真值一致"的检查**，而定义表（`domains/cc/widgetDefinitions.ts`
   每行的 `layout`）已经是元件位置的唯一真值 ⇒ 两边随时会静默漂移。
2. 顺带把出厂数据与定义表里的 `order` 从 `0/2/3/4/5/5` 整成**连续值 1..6**
   （原状里「命令行提示」与「用量」撞在同一个 5 上，同落脚处内的先后只能靠表序兜着）。

**不做什么**

- 不动定义表结构、中控渲染、呈现方案；不重新引入生成脚本（施工单 §4-4 停手条件）；
- 不改出厂数据里的 `ccHidden`（本件只管**位置**；`ccHidden` 仍无校验，见「未解问题」）；
- 不删出厂数据里的历史 `slot` 键（`ccLayoutState.ts` 明写保留：它是类型上留给老数据与出厂数据的只读历史键，运行时一律不读）；
- 不给任何条目开"用另一套排布"的口子（施工单 §4-2）。

## 改动清单

| 文件 | 大致范围 | 性质 | 行数 |
| --- | --- | --- | --- |
| `src/zones/__tests__/factoryZonePresetLayoutGuard.test.ts` | 新增守卫：携带者白名单 / 位置逐项对拍定义表 / 元件 id 集合 / 位置键登记 / 同落脚处内序号不重复（5 条用例） | 新增 | +125 |
| `src/zones/factory/terminal-cc.ts` | 5 条条目的 `ccLayout.placements` 里 `input.order` 0→1、`cc-command-hint.order` 5→6（**只改数值**） | 修改 | 10 处（+10/−10） |
| `src/zones/factory/gui-cc.ts` | `solarized` 同两处数值（0→1、5→6） | 修改 | 2 处（+2/−2） |
| `src/domains/cc/widgetDefinitions.ts` | 定义表 `input` 行 `layout.order` 0→1、`cc-command-hint` 行 5→6 | 修改 | 2 处（+2/−2） |
| `src/domains/cc/__tests__/widgetDefinitionTable.test.ts` | `DEFAULT_CC_LAYOUT` 字面量两条序号按真值更新 + 两段过期注释更正（原文写"序号沿用历史值、不许手改出厂数据"） | 修改 | 10 行（+10/−9） |
| `src/renderers/solid-workbench/__fixtures__/workbench-skin-baseline.json` | `--write` 重拍的契约快照：15 张 fixture 的 `ccLayout` 仅 input/hint 序号变化 + `generatedAt` | 修改 | 62 行（+31/−31） |

合计：6 个文件，+180 / −54（含新增测试 125 行）。

## 方案要点

### 一、守卫判据落在「数据 ↔ 定义表」之间，不另抄一份期望值

`DEFAULT_PLACEMENTS`（`src/ccLayoutState.ts`）就是**由定义表每行的 `layout` 派生**的
（`order` 取 `row.layout.order`，两个偏移取 0），所以守卫直接断言
「出厂数据的位置 == `DEFAULT_CC_LAYOUT.placements[id]`」即等价于「与定义表逐项一致」：
将来改定义表而忘了改数据、或反过来，**测试都会红**，且报错行会点名是哪个条目、哪个元件。

覆盖四项：`order` / `offsetX` / `offsetY` 逐项相等；携带者的元件 id 集合 = 可拖元件全集
（`CC_WIDGET_IDS` 6 个 + 注册轨 `cc-send-button`）；位置记录只允许出现
`order`/`offsetX`/`offsetY`（+ 历史 `slot`），出现 `gap`/`anchor`/`side` 之类**未登记的键**即红；
同一落脚处（`ccWidgetLanding`）内序号不得重复。

### 二、豁免显式列白名单（不许静默跳过）

出厂 50 条里**只有 6 条携带 `ccLayout`**：terminal 桶 5 套（生成时字段补满）+ gui 桶的 `solarized`。
gui 的 `glass` / `agent-command` / `agent-map` / `focus-flow` 是**部分切片**（来源预设本身没写 `ccLayout`
⇒ 装配时该字段回默认）——**不是"故意用不同排布"，而是这条数据里没有排布**。
守卫把携带者清单**硬写成白名单**（`EXPECTED_CARRIERS`）并断言"实际携带者 == 白名单"：
多一条（谁新增了 `ccLayout`）或一条少了（谁把 `ccLayout` 删了）都红，所以这道豁免不可能悄悄扩大。
★ 结论：**没有任何条目被允许声明与定义表不同的位置。**

### 三、序号方案取 `1..6`（而非 `0..5`）

按当前实际显示顺序（输入栏在上落点；模型 → 思考强度 → 权限模式 → 用量 → 命令行提示在下落点）编号：

| 元件 | 原 order | 现 order |
| --- | --- | --- |
| input（输入栏） | 0 | **1** |
| model（模型） | 2 | 2 |
| reasoning（思考强度） | 3 | 3 |
| mode（权限模式） | 4 | 4 |
| tokens（用量） | 5 | 5 |
| cc-command-hint（命令行提示） | **5（撞号）** | **6** |
| cc-send-button（发送按钮，悬浮、自己一个落脚处） | 0 | 0 |

`1..6` 只动 2 个数值（`0..5` 要动 4 个），且动完**全局无同号**、组内升序与显示顺序一致；
序号只表达组内相对次序 ⇒ **渲染逐项不变**（下面「零变化证据」）。悬浮的发送按钮单独占一个落脚处，
`order` 仍为 0（组内只有它自己）。

### 四、施工顺序：先立校验，再改值

守卫的「位置相等」四组断言在**改造前就是绿的**（⇒ 未触发施工单 §4-1 停手条件：出厂数据此前没有漂移）；
「同落脚处内序号不重复」在改造前**是红的**（`tokens=5 / cc-command-hint=5`），改值后转绿 ——
这条红不是回归，正是"这条断言是活的"的实证（原文见「证据 · 反向验证」）。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| 门禁五步（lint → build:example-plugin → build → check:solid → test） | ✅ 全绿（lint 0 error，仅 1 条与我方无关的存量 warning） |
| 全量测试**至少两次** | ✅ 两次均 632 文件 / 4797 通过 / 1 skipped / 1 todo，两次都未撞 `PlainMessageList` #243 flake |
| 反向验证（故意改错一条 order ⇒ 新测试红；改回 ⇒ 绿） | ✅ 红/绿两条输出见「证据」 |
| 零变化证据（`factoryZonePresets` + `presetAssembly:268` 仍绿） | ✅ 两文件 33 用例全绿（`ccLayout 归一 = 规范排布` 在 12 套预设上仍成立） |
| 契约快照差异 | ✅ 仅 `order 0→1` / `order 5→6` ×15 张 + `generatedAt`，逐项已核（无其它字段变化） |
| 开发记录 + 《中控元件总表》+ issue 回写 | ✅ 本文件 + 总表 §2/§4/§10 更新 + #266 评论 |

## 测试处置

- **新增**：`src/zones/__tests__/factoryZonePresetLayoutGuard.test.ts`（5 条用例，全新文件）。
- **修改（逐个列明，均属"按真值更新"）**：`src/domains/cc/__tests__/widgetDefinitionTable.test.ts`
  - `DEFAULT_CC_LAYOUT 由表派生` 用例里的默认布局**字面量**：`input.order` 0→1、`cc-command-hint.order` 5→6。
    该字面量本就是定义表的副本，序号是本次刻意变更的真值 ⇒ 按真值更新（性质同施工单 §4-3 的"按真值更新"那一类）。
  - `目录三份（名字 / 类别 / 位置）直接读表后内容不变` 用例里的位置字面量：同上两条。
  - 两段**过期注释**更正（原文"序号沿用历史值""出厂数据不许手改、改默认会让归一不变量失去意义"）——
    本件之后方向相反：**定义表是位置唯一真值，出厂数据跟着它走，一致性由新守卫机检**。
- **未修改、未删除**任何其它既有行为测试（`ccLayoutV8.test.ts` / `factoryZonePresets.test.ts` /
  `presetAssembly.test.ts` 一字未动、仍绿）。

## 证据

- commit：`a4f2cb88`（正事）、`d87171ef`（L.md 范围声明）
- 门禁（关键行）：
  - `bun run lint` → `✖ 1 problem (0 errors, 1 warning)`（warning 在 `src/components/right-panel/RightRailHost.tsx`，与本次改动无关、未触碰该文件）
  - `bun run build` → `✓ built in 16.77s`
  - `bun run check:solid` → `运行时边界门禁通过…无新增越界` / `ZONE_FIELDS 一致性契约通过（187 个主题字段）`
  - `bun run test`（第 1 次）→ `Test Files 632 passed | 1 skipped (633)`、`Tests 4797 passed | 1 skipped | 1 todo (4799)`
  - `bun run test`（第 2 次）→ 同上（`632 passed` / `4797 passed`）
- 聚焦测试：`bun run test src/zones/__tests__/factoryZonePresetLayoutGuard.test.ts src/domains/cc/__tests__/widgetDefinitionTable.test.ts src/domains/cc/__tests__/ccLayoutV8.test.ts src/zones/__tests__/factoryZonePresets.test.ts src/__tests__/presetAssembly.test.ts` → `5 passed (5) / 76 passed (76)`
- 反向验证（改错 `terminal/cc/claude` 的 `model.order` 2→9）：
  `AssertionError: terminal/cc/claude 的「model」位置必须等于定义表声明（widgetDefinitions.ts 那一行的 layout）: expected { order: 9, offsetX: +0, offsetY: +0 } to deeply equal { order: 2, offsetX: +0, offsetY: +0 }`
  → 改回后 `Tests 5 passed (5)`，`git diff --stat` 回到预期的 12 处数值改动。
- 契约快照：`bun scripts/check-workbench-theme-contract.mts --write` → `Workbench 皮肤 contract 通过；内置预设 10 个；自定义预设 0 个；主题字段 187 个；Workbench CSS variables 96 个；fixture 15 个`；
  diff 统计逐行 = `15 × {"order": 0→1}` + `15 × {"order": 5→6}` + `generatedAt` 一行，无其它。
- 手工验证：无（纯数据/声明与测试改动，几何渲染路径未动）。

## 与 spec 的偏差

- 施工单 §2.1 提到"若该条目还带 `gap` / `anchor` / `side` 一类声明 ⇒ 同样必须与定义表那行一致"：
  出厂数据的**位置记录里没有**这类键，故按等价且更强的形式落地 —— **只允许 `order`/`offsetX`/`offsetY`
  （+ 历史 `slot`），出现任何其它键即红**，要求后来者先登记再对拍。
- 施工单 §3.4 预期契约快照"无差异（除时间戳）"：实际**有差异**，因为快照里记着默认布局的字面序号
  （15 张 fixture 各含一份 `ccLayout`）。差异只有 input/hint 两处序号 ×15 + 时间戳，已逐项核对，属预期。
- 施工单 §2.2 提示"建议 `1..6` 或 `0..5`"：取 `1..6`（理由见「方案要点 · 三」）。

## 未解问题

1. **出厂数据文件头仍写「请勿手改」**（`src/zones/factory/*.ts` 逐字相同的一段），而本件之后
   `order` 这一项**必须与定义表同步手改**（否则守卫红）。两种口径并存容易误导下一位作者。
   建议把该段注释改为"值随定义表/预设来源变化时需同步更新，位置一致性由守卫测试机检"（**未擅自改**，
   施工单 §2.2 明写"只改数值"，交翻译定）。
2. 出厂数据的 `ccHidden`（7 套预设默认藏起发送按钮）同样**没有**与任何真值对拍；本件只覆盖位置。
3. 施工单 §3 写本件与「深色配色」「成员级显隐」**文件面不重叠**，实测**不成立**：两条支线
   （`refactor/cc-member-visibility`、`feat/cc-widget-free-colors`）都改了 `widgetDefinitions.ts`
   与 `widgetDefinitionTable.test.ts`，后者还改了同一份契约快照与 `zones/factory/{terminal-cc,gui-cc}.ts`。
   三条各自基于 main ⇒ **后合入者需解冲突**（本件只动 2 个数值，冲突面极小）。
4. 顺带发现（未处理）：`widgetDefinitionTable.test.ts` 里位置字面量是定义表的**第二份副本**
   （本次就是它先红、再按真值更新）；若要减少这类副本，可考虑让该用例只做"逐条等于表"的关系断言。
   属独立方向，不在本件范围。

## 并行交集

本次触碰的共享文件（供其他贡献者避让）：

- `src/domains/cc/widgetDefinitions.ts`（2 行）
- `src/domains/cc/__tests__/widgetDefinitionTable.test.ts`（2 处字面量 + 注释）
- `src/zones/factory/{terminal-cc,gui-cc}.ts`
- `src/renderers/solid-workbench/__fixtures__/workbench-skin-baseline.json`（契约快照，`--write` 重拍）
- `.agents/L.md`、`.agents/records/266-factory-zone-data-guard.md`
