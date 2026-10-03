# Dev Record — #266 刀 2.5 横向：声明式脱离 + 不折行 + 宽度算式

> ★ **本记录为 2026-10-02 补写**（原单完工时漏落）。补写依据 = 仓外归档施工单 `已处理\08-施工单-横向声明式脱离与宽度算式（刀2.5）-已结案.md` + 2026-10-02 静态复核（`origin/main @ 1a285642`）。入库保留。

## 元信息

- issue：[#266](https://github.com/AlchemistCxC/Pylon-co-works/issues/266)（【待立项】显隐与布局的两层模型 · **刀 2.5**）
- 分支：`feat/cc-visibility-two-layer.2-5`（已并入 main）
- 提交范围：PR [#431](https://github.com/AlchemistCxC/Pylon-co-works/pull/431) / 合并 `b5768d76`
- 日期：2026-09-28；记录补写 2026-10-02

## 目标与范围

下边组（模型 / 思考强度 / 权限 / 用量 / 命令行提示那一行）的**横向**三件事：

1. **去折行**（行数恒 1——下游刀 3 的高度算式依赖这条）；
2. **声明式脱离**：件可声明「贴哪条边 + 距离」（`detachX`）；**未声明 = 照旧排队**（默认逐像素不变），声明了的件**脱离队列独立定位、允许与队列重叠**；
3. **宽度算式**：与高度同构（`resolveCcMinWidth`），作**约束值**暴露。

- **不做**：高度算式（刀 3）；显示前校验（刀 4）；显隐 / 谓词（刀 1）；横向滚动 / 强制撑宽；任何**默认**排布观感的改变。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `…/components/chat/ControlCenter.css` | 下边组去 `flex-wrap`（原三处）——`.cc-status-row` 改 `nowrap`（原 `row-gap:3px` 一并去掉）；新增 `.cc-widget.cc-detach-x` 定位规则（渲染侧给内联 `left/right`） | 修改 |
| `src/domains/cc/ccHeightState.ts` | 新增宽度算式族：`CcMinWidthGroup` / `resolveCcMinWidth` / `resolveCcWidthGroups`（与高度同族；声明了 `detachX` 的件自成一"组"） | 修改 |
| `src/domains/cc/widgetDefinitions.ts` | 组定义新增可选 `detachX`（`CcDetachX`：`anchor` + `side` + `gap`） | 修改 |
| `src/renderers/solid-workbench/input/ControlCenter.solid.tsx` | 消费：`isDetached()` / 挂 `cc-detach-x` / 内联定位；`minWidth()` 接算式 | 修改 |

## 方案要点

- **为什么"声明式"**：用量胶囊 / 命令行提示是**内容撑**（宽不可反推），若走"反推每件宽度再重排"必然走样 ⇒ 默认保持排队、**只有声明了才脱离**，默认观感零变化。
- **不强制**：窗口窄于最小宽时**不**引入横向滚动 / 强制撑宽——算式只把"最小宽"作为约束值算出来并暴露（供刀 4「显示前校验」横纵同口径取 max 使用，见 `ccShowVerdict.ts`）。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| 折行已去 | **10-02 复核**：`.cc-status-row` 为 `flex-wrap:nowrap`（CSS 注释在案：「原 `flex-wrap:wrap` 与只在折行时才生效的 `row-gap:3px` 一并去掉」）；余下 `flex-wrap` 仅编辑列两处（与本组无关） |
| 默认形状不变（未声明 = 排队） | 施工时按「与改造前逐条一致」验收通过（原始读数已随报告目录清理）；10-02 复核：未声明件**不挂** `cc-detach-x`（注释在案「默认排布因此逐像素不变」） |
| 声明式脱离生效 / 允许重叠 | 施工时验收通过（2026-09-28/29，翻译复核记录见总表） |
| 宽度算式在库 | **10-02 复核**：`ccHeightState.ts` 的 `resolveCcMinWidth` / `resolveCcWidthGroups`；消费面 `ccShowVerdict.ts` 与 `ControlCenter.solid.tsx` |
| 门禁 + 快照 | 施工时五步全绿 + 契约快照重拍（原始输出已清理） |

## 测试处置

| 文件 | 处置 |
| --- | --- |
| 下边组布局 / 类名相关用例（mountSolidWorkbench / ControlCenter 相关） | 按新语义校准；新增「未声明 = 排队 / 声明 = 脱离 + 可叠」用例 |
| `src/domains/cc/__tests__/*`（ccLayoutState 相关） | 位置声明默认值 / 归一化随之同步 |

## 证据

- commit：`b5768d76`（PR #431）
- 10-02 静态复核命令（可复现）：
  - `grep -n "flex-wrap" …/components/ControlCenter.css` ⇒ 下边组 `nowrap`
  - `grep -rn "resolveCcMinWidth\|resolveCcWidthGroups" src` ⇒ 算式与消费面在库
  - `grep -rn "detachX" src/domains/cc/` ⇒ `CcDetachX` 类型 + 组声明读取在库
- 存档点：`savepoint/cc-266-knife3`（`b25fa6a9`，刀 3 用；刀 2.5 无独立存档点）

## 与 spec 的偏差

- 无（单内两条形态定案：① 声明式脱离；② 窄窗不强制——按原样执行）。

## 未解问题

- 无（下游刀 3 已按「不折行 ⇒ 行数恒 1」接续完成并合入）。

## 并行交集

- `ControlCenter.css`（中控样式面）；`ccHeightState.ts` / `widgetDefinitions.ts` / `ControlCenter.solid.tsx`（中控域与渲染面）。
