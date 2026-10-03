# Dev Record — #266 CC-30 会话绑定状态提示接线

> ★ **本记录为完工后补写**（2026-10-03）：原施工单未点名「开发记录」这一条，属单子的疏漏；施工与验收本身按单完成。

## 元信息

- issue：[#266](https://github.com/AlchemistCxC/Pylon-co-works/issues/266)（**CC-30**）
- 分支：`feat/cc-binding-hint.1`（已并入 main；本地 + 远端分支已清）
- 提交范围：PR [#525](https://github.com/Teens-in-Times/Pylon-co-works/pull/525) / 合并 `afb459f0`；改动提交 `90f0d1e1`
- 日期：2026-10-02 施工与验收（提交 23:59）；2026-10-03 00:15 合入

## 目标与范围

把**零调用**的会话绑定状态机（`domains/binding/bindingState.ts`，8 态 + 中文文案）驱动起来，在输入栏上方渲染一行**悬浮**提示。

- **做**：`bindingHint(state)` 判据（唯一出处）；契约加可选字段 + `normalizeWorkbenchMountInput` 透传；宿主派生 memo；InputBar 渲染（复用既有 `.input-binding-status`）。
- **不做**：重连入口（用户已挂起）；发送禁用（`isBindingLocked` 属行为变更，另议）；不改 CSS；不加主题字段；不碰 `ControlCenter.*`。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src/domains/binding/bindingState.ts` | 新增 `BindingHint` + `bindingHint(state)`（文案非空即显示；`error` 变体仅 `restore_error`） | 修改 |
| `src/plugin-runtime/renderers/workbenchRendererFactory.ts` | `WorkbenchMountInput.bindingHint`（可选只读；注释口径仿 `agentAdvertisedModels`） | 修改 |
| `src/renderers/solid-workbench/workbenchContracts.ts` | `SolidWorkbenchInput` 同字段 + normalize 透传（`Object.freeze`） | 修改 |
| `src/sheets/agent-workbench/AgentRendererSuiteWorkbench.solid.tsx` | `bindingHintPayload` memo（读 `runtimeStoreVersion()`；`agentStatuses[sheet.agentId]` / `toAgentContextKey(sessionContext(…))` / `bindingGenerations` / `sessionBindingHealth`）并塞进 input memo | 修改 |
| `src/renderers/solid-workbench/input/InputBar.solid.tsx` | `.input-error` 旁渲染 `.input-binding-status`（error 走 `--error` 变体） | 修改 |
| `src/domains/binding/__tests__/bindingState.test.ts` | 新增 3 条（8 态覆盖） | 修改 |
| `src/renderers/solid-workbench/__tests__/mountSolidWorkbench.solid.test.tsx` | 新增 3 条（出现 / 变体 / 缺省不渲染） | 修改 |

另带（同 PR）：`.agents/records/` 三份**补写记录**（CC-02 / CC-29 / 刀2.5）——清偿「记录未落」缺项。

## 方案要点

- **渲染子树不自读 runtime store**：宿主派生纯数据、经 mount input 下发（既定口径，同 `agentAdvertisedModels`）。
- memo **必须读 `runtimeStoreVersion()`**：连接态 / 绑定代的推进不经过其他被追踪切片，漏读会停在首次快照。
- 绑定代与后端健康取 `toAgentContextKey(sessionContext(session))` 下的 `bindingGenerations` / `sessionBindingHealth`。
- 样式零改动：复用 CC-29 保留的 `.input-binding-status` / `--error`（其保留正是为本次接线）。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| 判据：`idle` / `binding_ready` 不提示；其余 6 态文案 = `bindingStatusText` | 域用例 3 条覆盖 8 态 ✓ |
| 渲染：字段透传 ⇒ 元素出现；`error` 变体；缺省不渲染 | mount 用例 3 条 ✓ |
| 门禁五步 | **翻译独立重跑 EXIT 0/0/0/0/0**；`Test Files 666 passed | 1 skipped`、`Tests 5216 passed | 1 skipped | 1 todo (5218)`（与工作者读数逐位一致） |
| 反向验证 ×2 | **翻译复跑**：RV1 `bindingState.test.ts:163:41`（1 failed | 22 passed）；RV2 `mountSolidWorkbench.solid.test.tsx:1633 / 1658`（2 failed | 99 passed） |
| 实机（重建 debug 二进制） | ready 不出现（Peri `connected`）；非 ready 出现（Hermes sheet `restore_error`、`--error` 变体、文案逐字）；悬浮几何（提示下缘 ↔ 输入栏上缘 **6px**、`position:absolute`、`z-index:11`）；**不占流**（摘除前后输入栏矩形一致） |

## 测试处置

| 文件 | 处置 |
| --- | --- |
| `bindingState.test.ts` | 新增 3 条；既有用例零改动 |
| `mountSolidWorkbench.solid.test.tsx` | 新增 3 条；既有用例零改动 |

## 证据

- commit：`90f0d1e1`（PR #525 / 合并 `afb459f0`）
- 实机关键读数：提示 `1150×32 @(25,396)`、输入栏 `1150×40 @(25,434)`、间距 6px、`position:absolute`、`z-index:11`
- 报告（仓外）：`工作台优化\报告等\15-施工单-会话绑定状态提示接线（CC-30）\2026-10-02-翻译验收报告.md`

## 与 spec 的偏差

- 单内 5 处全部按原样落地；无功能偏差。
- ★ 唯一偏差在流程面：**原单漏点名「开发记录」**（本仓 §2.4 完工判据之一）⇒ 本记录为补写，并已把该条作为教训记进单子末尾。

## 未解问题

1. 宿主 memo 的 `resolve→refine→hint` 组合链路**无直测**（三段各自有测——域判据 / 契约透传 / 渲染；组合为纯函数链）。若要补需挂 `AgentRendererSuiteWorkbench` 组件测试，另议。
2. 顺带观察（与本单无关）：Hermes sheet 的持久态是「peri 会话挂 hermes sheet」⇒ 每次启动都会以 `restore_error` 提示呈现。这是提示功能正常工作的实例；该持久态本身是否要修，另议。

## 并行交集

- `src/renderers/solid-workbench/input/InputBar.solid.tsx`、`src/plugin-runtime/renderers/`、`src/sheets/agent-workbench/`。
- `#410`（左栏 + 中控区重设计）已搁置、避让已解除；本单未碰任何 CSS。
