# Dev Record — #238 刀3 拆掉槽位层（位置改由锚点两轴声明）

> 入库保留。施工单：`E:\Acode\FILES\任务\工作台优化\元件定义表\05-施工单-刀3-拆掉槽位层.md`
> 规范：同目录 `00-施工规范-中控元件定义表-v1.0.md`（§7 刀划分）；结构冻结件 `03-结构-定义表骨架-20260922.md`
> 分支：`feat/cc-widget-definition-table`（刀1/刀2 同分支，本刀续 6 笔）

## 元信息

- issue：[#238](https://github.com/AlchemistCxC/Pylon-co-works/issues/238)
- 提交范围：`0bd91fe9..9246d5ef`（`39923182` L.md → `3d20bd70` 实现 → `3e046f9a` 序号回退+测试同步 → `3fdb095e` 快照 → `899cc9e6` 间距来源测试 → `9246d5ef` 注释）
- 日期：2026-09-22

## 目标与范围

**目标**：**彻底离开「槽位」这个二层结构** —— 不再有「先分槽、再在槽里排序」两段式。
每个元件自己声明「x 轴贴谁 + y 轴贴谁 + 间距 + 组内序号」，渲染按**落脚处** `(y.anchor, y.side)` 自动成组。

**不做**（施工单「不动」+ 停手条件）：占区碰撞约束（刀4）；`statusBg`/`statusBgImage` 废弃与命令行提示翻可拖（刀5）；
`sendVariant`；属性面板按成员分块；缩放；死数据清理；`rendererKey` / `isolated-surface`；任何版本号 bump。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src/domains/cc/widgetDefinitions.ts` | 位置改两轴 `layout{x,y,order}` + `floating` 声明 + `alignLayout` 简写；新增 `ccWidgetLanding` / `coerceInputLanding` / `ccInputLandingViolations` / `CC_FLOATING_WIDGET_IDS`；`footerLayout` 归属转入容器行；删 `anchor`/`side`/`defaultPlacement` | 修改 |
| `src/ccLayoutState.ts` | 删 `CcSlot` / `SLOT_SET` / `placement.slot` 与全部槽位判定；`CcWidgetPlacement` = order/offsetX/offsetY（+ 只读历史键 `slot?`，见偏差 B）；`DEFAULT_CC_LAYOUT` 由 `layout.order` 派生 | 修改 |
| `src/renderers/solid-workbench/input/ControlCenter.solid.tsx` | 删 `STATUS_SLOTS` 与三个槽位包装 div → 按落脚处成组（`.cc-status-group`）；保留 `.cc-input-slot` 类名；删属性面板「槽位」下拉；`data-widget-slot` → `data-widget-anchor`；发送按钮右侧偏移改由表注入 `--cc-send-anchor-gap` | 修改 |
| `src/renderers/solid-workbench/input/WorkbenchWidgets.solid.tsx` | 删两个硬编码 12px 常量，改读表 `gap`（仍加在同一元素上） | 修改 |
| `src/plugin-runtime/cc-widget/ccWidgetTypes.ts` | 插件契约 `slot` → `anchor` + 可选 `side`（`rendererKey`/`isolated-surface` 未动） | 修改 |
| `src/domains/cc/widgetCatalog.ts` | 两处 `defaultPlacement` 改由表 `layout` 派生（新形状） | 修改 |
| `ControlCenter.css` / `WorkbenchChrome.css` | 槽位类与 `:is(...)` 分组选择器退场；新增 `.cc-status-group`；分隔符规则同步；发送按钮 `right` 消费 `--cc-send-anchor-gap` | 修改 |
| `src/components/SettingsPreview.tsx` | 失败占位结构随真实结构改（三个槽位类都删） | 修改 |
| 测试 6 份 | 见「测试处置」 | 修改 |

## 方案要点

1. **落脚处 = `(y.anchor, y.side)`**：同一落点的元件归入同一容器，组内按 `order` 排。
   本刀只产生两个落点 + 一个悬浮件：
   - `cc-surface:top` → 输入栏（渲染进 `.cc-input-slot`）
   - `cc-surface:bottom` → 模型/思考强度/权限/用量（+ 命令行提示，仍走裸渲染）→ `.cc-status-group`
   - `input:center` → 发送按钮（`floating: true`，不进文档流，仍是绝对定位悬浮件）
2. **容器从表里取**，不写死字符串：`INPUT_LANDING = ccWidgetLanding('input')`、`INFO_LANDING = ccWidgetLanding('model')`。
3. **两处隐藏依赖**（施工单 §2.3）：
   - `.cc-input-slot` 类名**保留在同一个元素上**（它仍是输入栏那个盒子）⇒ 两处量宽逻辑
     （本文件 `onMount` 算 `--cc-input-text-inset-x`、`InputBar.solid.tsx` 的 `closest`）**零改动**，
     实机实测内缩变量非 0（见证据）。
   - 「input 槽只准放输入栏」的原校验 → 替代物是**表级不变量 + 兜底函数** `coerceInputLanding`：
     非输入栏若被错标到输入栏落点，**退回信息落点**（宁可换位置也不凭空消失）。
     为什么不是在"拖拽落点"拦截：拖拽现在只能改 `offset`/`order`（**改不了归属**），
     所以落点判定就是成组判定本身。
4. **间距收编**（施工单 §2.4）：值从表 `gap` 读，仍写在同一元素（inline `margin-left`）。
   实机实测内层 `margin-left` = 12px（= 表值），控件间距 33px 均匀、与改造前逐项相同 ⇒ **像素级相同，无需停手**。
5. **`footerLayout` 归属转移**（§2.7）：从「跨元件系统字段」桶移入容器行 `cc-surface` 的成员字段；
   字段与 `peri`/`free` 两种实现一字未动。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| 门禁五步 | ✅ 全绿 |
| 实机：DOM 不再有那三个槽位节点 | ✅ `document.querySelectorAll('.cc-status-primary,.cc-status-secondary,.cc-actions').length = 0` |
| 实机：信息控件 x 序列与间距与改造前逐项相同 | ✅ 两种模式逐项相同（见证据表） |
| 实机：`--cc-input-text-inset-x` 不为 0 | ✅ free 45px / peri 43.8px（= 容器宽 × 5%，与改造前一致） |
| 实机：peri / free 各量一次 | ✅ 两组都量了 |
| 实机：发送按钮右端偏移与垂直位置一致 | ✅ right 14px / top 14px / rect (1139,690,32×32) 与改造前完全相同 |
| 实机：空槽消失的间隙收益 | ✅ 量了：**0px**（与预期 4px 不同，机制见偏差 E） |
| 契约快照重拍 + 逐条 diff 说明 | ✅ 49 行：48 行是 `slot` 键删除（8 夹具 × 6 元件）+ 1 行 `generatedAt`；`order`/`offset` 一个没动 |
| 反向验证 | ✅ 四条（A 引用 `CcSlot` / B 成组失效 / C 守卫失效 / D 表 gap 改 0） |
| 开发记录 | ✅ 本文件（含 §2.8 代价） |
| 《中控元件总表》更新 | ✅ 仓外 |
| issue #238 回写 | ✅ |

## 测试处置（逐条点名）

**契约变更引起的写法同步**（判据不变，只改期望/定位方式）：

| 文件 | 改了什么 |
| --- | --- |
| `domains/cc/__tests__/widgetDefinitionTable.test.ts` | 不变量 5/6 改两轴（锚点链顺 `y.anchor` 走、终止于 `cc-surface`）；新增落脚处/悬浮件/守卫三条用例；默认布局与目录期望去 `slot`；字段计数 `cc-surface` 8→9、系统桶 7→6（`footerLayout` 归属转移） |
| `domains/cc/__tests__/ccLayoutV8.test.ts` | 4 条期望去 `slot`（**样本一字未动**，含 `slot:'status-primary'` 的历史样本） |
| `domains/theme/__tests__/themeSchemaV8Backfill.test.ts` | 4 处期望去 `slot`（样本保留） |
| `domains/theme/__tests__/structuralAlignment.test.ts`（刀2 产物） | 期望拆成 `USER_EXPECTED`（去 slot）；**样本保留 slot** —— 正好证明「slot 被丢掉、其余原样」 |
| `domains/theme/__tests__/themeRehydrateAlignment.test.ts`（刀2 产物） | 同上；种子故意带 `slot` |
| `domains/theme/__tests__/presetReducer.test.ts` | 2 处期望去 `slot`（投毒样本保留 slot） |
| `renderers/solid-workbench/__tests__/mountSolidWorkbench.solid.test.tsx` | ① 「布局槽位权威」用例 → 改为「排布权威（落脚处内按序号排）」（槽位下拉没了）；② 属性面板用例去掉槽位下拉交互并断言它已不存在；③ **新增**间距来源回归 |
| `renderers/solid-workbench/__tests__/settingsPreviewControlCenter.solid.test.tsx` | 选择器从三个槽位类 → `.cc-status-group`，并断言那三个节点不存在 |

**零删除**：没有任何测试被删（`presetAssembly.test.ts`、`factoryZonePresets.test.ts` 等保持原样通过）。

## 证据

- **commit**：`39923182` / `3d20bd70` / `3e046f9a` / `3fdb095e` / `899cc9e6` / `9246d5ef`
- **门禁（冻结态 `9246d5ef`，按顺序）**：

```text
$ bun run lint                  → LINT_EXIT=0（1 warning 在 RightRailHost.tsx，非本刀）
$ bun run build:example-plugin  → EP_EXIT=0
$ bun run build                 → BUILD_EXIT=0
$ bun run check:solid           → SOLID_EXIT=0（CSS 消费审计：注入 115 / 消费 350 / 声明 354，死注入 0）
$ bun run test                  → TEST_EXIT=0；Test Files 626 passed (626)；Tests 4722 passed | 1 todo (4723)
```
对账：刀2 终点 626/4717 → 本刀 626/4722 = **+5 用例、0 删除**（新增：落脚处/悬浮件/守卫 3 条 + 间距来源 1 条 + `(b)` 一条拆分）。

- **契约快照 diff（共 49 行，逐条说明）**：

```text
$ bun scripts/check-workbench-theme-contract.mts --write && git diff -U0 -- src/renderers/solid-workbench/__fixtures__/
-  "generatedAt": "2026-09-19T14:47:25.095Z"        ← ① 脚本重拍必然变（1 行）
+  "generatedAt": "2026-09-22T11:43:36.861Z"
-  "slot": "input" / "status-secondary" ×4 / "actions"   ← ② 共 48 行 = 8 份夹具 × 6 个元件的 slot 键删除
（没有其他 +/- 行：order / offsetX / offsetY 一个都没动）
```

- **实机数值验收（核心证据）**：真实数据 = `%LOCALAPPDATA%\com.prism.desktop\EBWebView\…\Local Storage` 的真实主题
  （外层 version 11、ccLayout v9、`ccHidden:["cc-send-button","attach"]`、cli + free）；
  方法 = 改造前用**刀2 时构建的二进制**量一次基线，改造后用**普通 `cargo build` 的新二进制**在同条件下量一次；便携模式隔离数据库。

| 项 | 改造前（刀2 二进制） | 改造后（本刀） | 判定 |
| --- | --- | --- | --- |
| `.cc-body` children（cli+free） | `[div.cc-input-slot, div.cc-status-row]` | 同 | 一致 |
| `.cc-body` display/gap/padding | flex / 5px / 2px 12px 3px | 同 | 一致 |
| 输入栏盒 | (275,686,900×40) absolute right 10px | 同 | 一致 |
| 信息容器 | `.cc-status-secondary` (299,735,570×28) | **`.cc-status-group`** (299,735,570×28) `data-cc-landing=cc-surface:bottom` | 盒子一致、类名换新 |
| model / reasoning / mode / tokens | x=299/452/617/782，y=735，h=28 | **逐项相同** | 一致 |
| 分隔符（3 个 `·`） | x=423/588/753（25×22） | 逐项相同 | 一致 |
| `--cc-input-text-inset-x` | 45px | 45px（= 900×5%） | 一致、非 0 |
| 内层 12px 间距 | `REASONING_GAP_PX`/`PERMISSION_GAP_PX` = 12 | 表 `gap` = 12（实测 margin-left 12px；控件间距 33px 均匀） | 像素一致 |
| 槽位节点数 | 3（其中 2 个零尺寸） | **0** | ✅ 拆除 |
| `--cc-send-anchor-gap` | —（无此变量） | 0px | 新增、像素中立 |
| 发送按钮 | (1139,690,32×32) right 14px top 14px | **完全相同**（且 `inInputSlot=false / inStatusGroup=false`） | 一致 |
| `.cc-body` children（default+peri） | `[div.cc-footer.cc-footer-peri]` | 同 | 一致 |
| 信息容器（peri） | `.cc-status-secondary` (277,725,896×28) | **`.cc-status-group`** (277,725,896×28) | 盒子一致 |
| model/reasoning/mode/tokens（peri） | x=277/424/584/743, y=725 | 逐项相同 | 一致 |
| 输入栏盒（peri） | (287,680,876×40) relative margin-inline 10px | 同 | 一致 |
| `--cc-input-text-inset-x`（peri） | 43.8px | 43.8px | 一致 |
| **空槽间隙收益** | 3 个 children（2 个空） | 1 个 children | **实测 0px**（见偏差 E） |
| 主题字节 | hash `7a3cece2` / 5354 B | 实测中恢复后仍是 `7a3cece2` / 5354 B | 用户数据未被改写 |

- **控制台**：本轮 3 次 reload 只出现既有的 `切换 Agent失败`（后端 `source: agent`，本机 agent 运行时不可用）——
  **没有任何来自本刀的新报错**（无 Solid/CSS/DOM 告警）。

- **反向验证**（四条，改坏 → 变红 → 改回；改回后 `git diff` 为空 = 与存档点逐字节相同）：

```text
A 把 `CcSlot` 引用塞回 ControlCenter.solid.tsx
  src/renderers/solid-workbench/input/ControlCenter.solid.tsx(4,62): error TS2305:
    Module '"../../../ccLayoutState.ts"' has no exported member 'CcSlot'.
  → check:solid SOLID_EXIT=2（★ 该文件在主 tsconfig 的 exclude 里，只能被 check:solid 抓到）
B 成组不再按落脚处过滤（所有可见控件进同一容器）
  → mountSolidWorkbench / settingsPreviewControlCenter 大面积变红（空态/会话态结构断言全崩）
C 落脚处独占守卫失效（coerceInputLanding 原样放行）
  × 非输入栏被错标到输入栏落脚处 ⇒ 退回信息落脚处
  AssertionError: expected 'cc-surface:top' to be 'cc-surface:bottom'   → 1 failed / 26 passed
D 表里 reasoning 的 gap 12 → 0
  × 间距来源 = 定义表 gap
  AssertionError: expected +0 to be 12                                   → 1 failed / 86 passed
```

## §2.8 老数据的代价（★ 有意接受，不是遗漏）

用户口径：**旧的没用旧去掉、不做适配** ⇒ 本刀**不写槽位迁移**。代价：

1. 老数据里的 `slot` 字段被**丢弃**（读盘时一律不读；由刀2 的「每次读盘结构对齐」自然消化，不需要 bump 版本号）。
2. **若用户手动拖过元件、或曾被 `input` 槽规则挡在默认位**，位置按新模型回落到**定义表声明的默认锚点/方位**
   （`order` / `offsetX` / `offsetY` 照旧保留 ⇒ 组内相对顺序与微调不丢）。
   默认排布下的用户（绝大多数）**看不出任何差别**。
3. 序号语义从「槽内序号」变成「同落脚处组内序号」——老数据的相对顺序不变 ⇒ 效果等价。

## 与 spec 的偏差

- **A. 不做 §2.6 的「顺手整理成连续序号」**。单子写「★ 顺手把出厂默认整理成连续序号（现状 2/3/4/5 中间有空档）」，
  我按纪律**没做**，序号沿用历史值（input 0 / model 2 / reasoning 3 / mode 4 / tokens 5 / 发送按钮 0）。
  理由（按停手条件 4「别处语义依赖它 ⇒ 停手并报告，不要自行扩面」）：
  ① 出厂区域预设的落盘数据 `zones/factory/**` 里就是 2/3/4/5/0，而该文件头写明「生成脚本已删，请勿手改」；
  ② 改了出厂默认会让 `presetAssembly.test.ts` 的「cc 区归一 = 规范排布」不变量失去意义（实测：`bun run test` 红在
     `presetAssembly.test.ts > ccLayout 归一：用户拖过的排布被打回规范排布`），而该文件属**预设组装线 #223 域**、不在本刀文件域内。
  ⇒ 序号语义仍按 §2.6 改了（槽内序号 → 组内序号），只是**值**没整理。**要不要整理请翻译定**（那需要同时改出厂数据 + 别人的测试）。
- **B. 运行时类型上保留了一个只读历史键 `slot?: string`**（`ccLayoutState.ts`）。行为上**一律不读**（归一化只取 order/offsetX/offsetY），
  保留它是为了让两处**不可手改的数据**继续编译：老用户 localStorage 与该出厂区域预设落盘数据（后者类型是 `Partial<ThemeSettings>`）。
  删掉它需要动 `zones/factory/**` 或放松 `ZonePresetEntry.values` 的类型 ⇒ 都是扩面。`CcSlot`（四值联合）本身**已彻底删除**（反向验证 A 印证）。
- **C. 发送按钮只把「右侧偏移的增量」改成表来源**（`--cc-send-anchor-gap` ← `layout.x.gap`，现为 0 ⇒ 像素不变）。
  剩下的 `calc()` 是**档位**（inline 贴里侧 / external 贴外沿，来自 `inputSubmitButtonMode` 功能字段）与运行期尺寸
  （输入栏高、按钮大小）的换算 —— 无法用常量表达；**垂直居中那段 `top:calc(...)` 原样保留**（单子 §2.5 即如此要求）。
- **D. `SettingsPreview.tsx` 的失败占位把三个槽位 div 都换了**（单子只点名 `:121` 的 `cc-status-primary`）。
  理由：那三个类名都已删除，留着另外两个就是悬空类名。
- **E. 「空槽间隙收益」实测 0px，与预期的 4px 不同**（值得记一笔，因为《三问核查》§2.2 从 CSS 语义**推断**过「净省 4px」）。
  实测机制：free 模式下被删的两个空节点在 flex 行**末尾**（宽度 0），它们贡献的 `gap` 落在行尾 ⇒ 不影响任何可见元素的位置；
  peri 模式下容器 `.cc-footer-status` 的 `gap:0` ⇒ 本来就无间隙。两模式的逐项坐标比对（上面那张表）证实了 0px 收益。
  ⇒ 结论：**拆槽位的收益不是"省像素"，而是"少一层结构"**（值：位置来源从 5 处收成 1 处）。
- **F. 未 bump 任何版本号**（单子允许工作者判断）：`slot` 字段的消失由「每次读盘结构对齐」（刀2）自然消化，无需版本号参与。

## 未解问题

1. 偏差 A（序号是否整理成连续值）请翻译/用户定，代价是要同时改出厂区域预设数据（生成脚本已删）与预设组装线的测试。
2. 刀4（占区不重叠）：本刀已把「发送按钮 = `floating: true`」写进表，正是刀4 的**豁免判据**；
   `offsetX/offsetY` 的自由度本刀**未动**（刀4 的议题）。
3. 刀5：`statusBg`/`statusBgImage` 废弃、`ccStatusFontSize` 收窄、命令行提示翻可拖（删裸渲染 + 工具条 6→7）。
   本刀已把命令行提示的 `layout` 写进表（`cc-surface:bottom` / order 5），翻可拖时只需把 `draggable` 置真。
4. `ccScale` 里残留的历史键（真实数据里有 `ekg` / `pct`）仍未清 —— 属死数据清理（第③件）。

## 并行交集

本刀触碰：`domains/cc/widgetDefinitions.ts`、`ccLayoutState.ts`、`renderers/solid-workbench/input/{ControlCenter,WorkbenchWidgets}.solid.tsx`、
`plugin-runtime/cc-widget/ccWidgetTypes.ts`、`domains/cc/widgetCatalog.ts`、`ControlCenter.css`、`WorkbenchChrome.css`、
`components/SettingsPreview.tsx`、8 份测试、`.agents/L.md`、契约快照。

**未触碰**：`src/zones/factory/**`（明确不碰）、`src/zones/**` 其余、`src/presets/**`、`presetAssembly.test.ts`、
`src/themeFieldDefs.ts`、`src/ccHeightState.ts`、`src/ui-demo/`、`src/layout-sketch/`、`docs/前端接口地图.md`。
