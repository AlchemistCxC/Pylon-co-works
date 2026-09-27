# ADR-0033 预测源优先级与一次性预测的消费口径

> 入库保留。编号顺延，按编号命名。
> 产出路径：`.agents/decisions/NNNN-<slug>.md`

- **日期**：2026-09-27
- **状态**：已采用
- **相关**：#394 / #395 / #405，#315（peri 扩展通道）、ADR-0030（标题分口径）

## 背景与约束

- **官方 ACP 没有聊天输入预测**：唯一的 prediction 是 NES（`nes/suggest` 要 `uri/version/position`，面向文档与代码编辑，挂 `unstable_nes`，Peri 与 Hermes 均不支持）。因此聊天预测只有两条来源：**Agent 私有推送**（Peri `peri/prediction_ready`，caps 门控）与**本地 provider**（设置里的 OpenAI 兼容服务 / ACP fork）。
- 本地预测系统已经存在：设置（`domains/inputPrediction/inputPredictionSettings.ts` 的 mode/参数）→ router（`fork`/`standalone`/`auto`）→ scheduler（去抖/限流/可取消）→ 输入框 ghost（`InputBar.solid.tsx`）。
- Peri 的推送在 #315 已被消费成 `assist.prediction`，但只渲成一张会话卡：卡片**只有按钮没有消费**（实测点「忽略」后卡片原样），且空文本帧（Peri 用同一通道的 `set_title` 动作发会话标题）会渲成一张无字空卡。
- 用户要求：把内容预测**接进既有预测系统**（ghost 交互：Tab 接受、退格或输入分歧拒绝，类似代码补全），并「检测到是 Peri 内置系统就转向 Peri 原生」。

## 备选方案

| 方案 | 否决理由 |
| --- | --- |
| 维持会话卡为唯一呈现面，只把按钮语义补全 | 与用户要的代码补全式交互不符；预测仍横在会话流里，且空文本帧仍成卡 |
| 把「已消费」做成宿主/文档面事实（新语义事件或 runtime 命令） | 需改 `agentWorkbenchSession` 的文档/命令管线（与 #375/#376 在途域重叠），并为一次性 UI 状态引入新契约面；收益是第三方 renderer suite 共享该状态——本轮不值这个代价，登记为遗留 |
| 原生预测与本地 provider 并行竞速，取先到者 | 产生无谓请求，且两个来源会互相覆盖；用户明确要「转向 Peri 原生」 |
| 原生预测优先，且在场时不发本地请求 | 采用（原生态是同一屏内质量更高的预测，且省一次网络请求） |

## 决定

1. **源优先级**：`mode=auto|fork` 时 **Agent 原生预测优先**，它在场即**不调度**本地 provider 请求；`standalone` 表「强制本地」（忽略原生），`off` 表关闭预测。
2. **一次性实例与消费**：文档里的预测带实例身份（`assist.prediction.eventId`，投影层从信封取）；消费标记存在 per-session 的 `sessionUi`（`SessionUiKey = 'assist-prediction-consumed'`，值 = 实例键：eventId 优先、无 eventId 回退文本）。ghost 与会话卡**共用**该标记 ⇒ 接受/拒绝后两侧同时收敛；新预测带新 eventId，不命中旧标记，自然重现。
3. **交互面**：输入框 ghost 是预测的呈现面——空草稿给全文；草稿是预测前缀时续显剩余；**Tab/→/空草稿 Enter 接受**（填草稿 + 消费）；**空草稿退格**与**输入分歧**（草稿不再以预测为前缀）**拒绝**（消费）。会话卡保留为「来源与忽略」的次要面，但**空文本不渲卡**、接受/忽略同样消费。
4. **身份口径**：文档按 provider source 建键，渲染器判「这份文档是不是本会话的」用宿主提供的 `sessionSource` 比对，不再拿身份域 `Session.id` 与 source 混比。

## 后果

- 正面：预测只有一条呈现路径（与本地预测同构），键位语义与代码补全一致；同一预测不会在卡片与 ghost 上重复滞留；Peri 的空文本帧与回合簿记帧不再产生噪声卡；原生预测在场时不再有本地请求开销。
- 负面：消费状态属 **renderer 侧**（`sessionUi`），第三方 renderer suite 不共享——同一会话换 suite 时「已消费」不延续。会话卡与 ghost 仍会同时呈现**未被消费**的预测（两处同一建议）。
- 风险：按前缀续显意味着「用户已输入的部分」与预测耦合——预测文本被改写（新 eventId）时旧前缀不再匹配会被计为「分歧」并消费掉（可接受：新预测是新建议）。

## 证据

- 源优先级与消费：`src/renderers/solid-workbench/input/InputBar.solid.tsx`（`nativePrediction` / `prediction` / 分歧 effect / scheduler 抑制 / 键位）、`src/domains/workbench/session/assistPrediction.ts`
- 实例身份：`src/domains/workbench/workbenchProjector.ts` 的 `reduceAssist`；类型 `src/domains/workbench/session/sessionSurface.ts`
- 卡片门与消费：`src/renderers/solid-workbench/WorkbenchDocumentSurface.solid.tsx`、`src/host/renderer-suite/rendererSemanticCommand.ts`
- 身份判据：`src/renderers/solid-workbench/workbenchContracts.ts`（`sessionSource`）、`src/sheets/agent-workbench/AgentRendererSuiteWorkbench.tsx`
- 测试：`src/renderers/solid-workbench/input/__tests__/InputBar.solid.test.tsx`（原生预测 6 例）、`src/domains/workbench/session/__tests__/assistPrediction.test.ts`、`src/domains/workbench/__tests__/sessionSurfaceProjection.test.ts`、`src/renderers/solid-workbench/__tests__/mountSolidWorkbench.solid.test.tsx`（预测卡 3 段）
- 噪声卡收口：#405 的 periNormalizer 静默集合 + 未知卡标题（`src/domains/workbench/normalizers/periNormalizer.ts`、`src/domains/workbench/workbenchProjector.ts`）
