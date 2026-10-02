# Dev Record — #266 CC-02 发送按钮编辑态不出现（判据收成一处）

> ★ **本记录为 2026-10-02 补写**（原单完工时漏落）。补写依据 = 仓外归档施工单 `已处理\03-施工单-发送按钮编辑态不出现（CC-02）-已结案.md` + 2026-10-02 翻译实机复核（`origin/main @ 1a285642`）。入库保留。

## 元信息

- issue：[#266](https://github.com/AlchemistCxC/Pylon-co-works/issues/266)（CC-02）
- 分支：`fix/cc-02-send-button-edit-mode`（已并入 main）
- 提交范围：PR [#404](https://github.com/AlchemistCxC/Pylon-co-works/pull/404) / 合并 `417e2e1d`
- 日期：原施工 2026-09-24 ~ 09-27；记录补写 2026-10-02

## 目标与范围

编辑模式下，若发送按钮被藏（预设 `ccHidden` 含 `cc-send-button`），工具条给出「＋ 发送按钮」入口但按钮本体不在场。根因：**同一个事实、同一文件里两处各判一遍**——`sendButtonMode()` 带编辑态豁免，渲染处用裸 `ccHidden`。

- **做**：判据收成一处；编辑工具栏那一格如实反映显隐；补一条工具栏用例。
- **不做**（2026-09-26/27 用户拍板收窄）：「变淡」那一套（给按钮加 hidden 标记 / 幽灵态 CSS / 内置件一起淡，第 2/3/4 步）——随「去编辑态豁免」那把刀（刀 1，PR #426）整体退场；「可拖」是另一件事（拖动入口只挂在内置件包装层），不在本单。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src/renderers/solid-workbench/input/ControlCenter.solid.tsx` | 判据收口（见下「方案要点」）；编辑清单行标改用 `hiddenWidgetIds()` | 修改 |
| `src/renderers/solid-workbench/__tests__/mountSolidControlCenterPreview.solid.test.tsx` | 新增「编辑态 + 某内置件在隐藏名单 ⇒ 工具栏那一格呈隐藏态」用例 | 新增 |

## 方案要点

- 在场判据唯一入口 = `isWidgetVisible('cc-send-button', visibilityContext())`：`sendButtonMode()` 与渲染处共用（渲染 `<Show when={ccSendButtonRegistered() && sendButtonMode()}>`）。
- 名单组装只有一处（`hiddenWidgetIds()`）；裸值只在该组装处读。
- ★ **10-02 复核订正**：原单设计的具名入口 `sendButtonHidden()` 在现行 main 已不存在——已进一步收成 `isWidgetVisible(...)` 直调（**判据仍单点**，形式更紧）；刀 4 之后裸名单读取点由「组装处两行」扩为 **4 处**——新增的两处在**编辑列两个开关**，各读自己那份表（`ccHidden` / `ccHiddenEmpty`），这是刀 4 的**有意设计**（注释在案：不要用合并后的名单判某个开关的态）。**不构成回归。**

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| 编辑态 + 被藏 ⇒ 在场且外观与内置件一致（原 (B) 口径） | 已随 2026-09-27 收窄**改判**：刀 1 去掉编辑态豁免 ⇒ 被藏件**不在场**为正确行为；本单实际交付 = 「判据收成一处 + 清单如实 + 补测」 |
| 编辑工具栏那一格如实 | 2026-09-25 施工；09-27 收尾补测（含反向验证）通过；**09-25 翻译验收通过** |
| **10-02 实机复核**（当前 main、debug 构建） | **通过**：编辑清单 7 行行标与在场实况 **7/7 一致**；「显示 发送按钮」往返切换（按钮出现、`opacity=1`、无 `.cc-hidden` 幽灵类）后还原；空态对照一致；本段操作无 console 错误 |

## 测试处置

| 文件 | 处置 |
| --- | --- |
| `mountSolidControlCenterPreview.solid.test.tsx` | **新增**「工具栏那一格与控件状态一致」用例（含反向验证：把行标判据改回裸名单 ⇒ 必须变红） |
| 其余相关用例（ccSettingsGrouping / widgetDefinitionTable 等） | 无改动 |

## 证据

- commit：`417e2e1d`（PR #404）
- 测试：当年定向用例 + 收尾补测全绿；**原始输出已随报告目录清理**（本记录为补写，以下为 10-02 可复现证据）
- 10-02 手工验证与读数：
  - `grep -rn "appearance().ccHidden" src` ⇒ 4 处（`:294/:295` 组装 + `:821/:822` 刀4 开关，均带注释）
  - 实机：`＋/●` 行标 ↔ `.cc-send-button` 在场/缺席逐项一致；显示往返后按钮 `opacity="1"`；`.cc-hidden` 计数 0
- 复核报告（仓外）：`E:\Acode\FILES\任务\工作台优化\报告等\CC-02与CC-29实机复核\2026-10-02-翻译验收报告.md`

## 与 spec 的偏差

- 原 (B) 定案的「0.18 幽灵态」被 2026-09-27「不要变淡」+ 刀 1（去编辑态豁免）取代——第 2/3/4 步已回退，仅保留判据收口与清单如实。

## 未解问题

- 发送按钮「可拖」与「属性面板微调对其是否有效」：另登记（归档单 §四 4.2）。

## 并行交集

- 中控区四文件：`ControlCenter.solid.tsx` / `ControlCenter.css` / `WorkbenchWidgets.solid.tsx` / `InputBar.*`。
