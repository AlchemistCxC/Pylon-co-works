# Dev Record — #394/#395/#405 原生预测接进既有预测系统 + 身份判据修正 + 噪声卡收口

> 入库保留。规格文档（spec）不保留，其目标、范围、方案与验收结论在此承接。
> 产出路径：`.agents/records/<issue>-<slug>.md`

## 元信息

- issue：#394（enhancement，预测消费点落地）、#395（bug，ghost 判据恒假）、#405（bug，peri goal_snapshot 原始 JSON 警告卡）
- 分支：`kumo/prometheus`（共享树）
- 提交范围：`15ec717f`（并入 `github/main` @ `417e2e1d` 后的基准）→ 代码提交 `ead74d26`，本记录随后
- 日期：2026-09-27
- 规格：`.agents/spec/394-395-405-prediction-wiring.md`（一次性，不入库）；决策：ADR-0033

## 目标与范围

**做什么**

1. Agent 推送的预测（Peri `peri/prediction_ready` → `assist.prediction`）接进**既有**预测系统（设置 → router → scheduler → 输入框 ghost），交互按代码补全：Tab 接受、退格 / 输入分歧拒绝。
2. 源优先级：`auto`/`fork` 下 Agent 原生预测优先，在场时不再发本地 provider 请求；`standalone` 强制本地、`off` 关闭。
3. 预测的**收敛**：接受/拒绝后 ghost 与会话卡同时消失，不复活；新预测（新 eventId）自然重现。
4. 修 #395 的身份判据（`document.sessionId`=source vs `Session.id` 恒假）。
5. #405：peri 已知簿记变体不再产可见卡；真未知变体的卡片标题取变体名而非裸 JSON。

**不做什么**

- 不给 ACP 加私有预测方法、不声明 NES（官方 NES 面向文档编辑，Peri/Hermes 均不支持，见 #394 正文）。
- 不向 agent 回传 accept/reject（Peri 无对应 wire 通道；仅本地收敛 + 诊断留痕）。
- 不动 `src-tauri/**`（无 Rust 改动）、不动 `agentWorkbenchSession.ts`（#375/#376 在途域）。
- 不改本地 provider 的「空草稿才请求」策略（只把原生源置于其前）。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src/domains/workbench/normalizers/periNormalizer.ts` | `SILENT_ACP_EVENT_VARIANTS` + `silentPeriEvent`；`mapAcpEventValue` 文档注释 | 修改 |
| `src/domains/workbench/workbenchProjector.ts` | `event.unknown` 卡 message 取变体名；`reduceAssist` 带 `envelope.eventId` | 修改 |
| `src/domains/workbench/session/assistPrediction.ts` | 预测实例键 / 可显示文本 / 消费标记读写（新模块） | 新增 |
| `src/domains/workbench/sessionUiStore.ts` | `SessionUiKey` 增 `assist-prediction-consumed` | 修改 |
| `src/domains/workbench/session/sessionSurface.ts` | `AssistSnapshot.prediction.eventId?` | 修改 |
| `src/renderers/solid-workbench/workbenchContracts.ts` | `WorkbenchMountInput.sessionSource`（必填）+ `SolidWorkbenchInput.sessionSource?` + normalize | 修改 |
| `src/renderers/solid-workbench/input/InputBar.solid.tsx` | `sessionDocument` 判据、`nativePrediction`、ghost 三分支、分歧 effect、scheduler 抑制、Tab/退格/Esc/Enter 键位、ghost `data-prediction-source` | 修改 |
| `src/renderers/solid-workbench/input/inputPredictionState.ts` | `PredictionSource` 增 `native`、`PredictionCandidate.instanceKey?` | 修改 |
| `src/renderers/solid-workbench/WorkbenchDocumentSurface.solid.tsx` | 预测卡门控（空文本 / 已消费不渲） | 修改 |
| `src/host/renderer-suite/rendererSemanticCommand.ts` | `assist.accept` / `assist.reject` 消费当前预测实例 | 修改 |
| `src/sheets/agent-workbench/AgentRendererSuiteWorkbench.tsx` | mount input 传 `session.source` | 修改 |
| `src/components/settings/InputPredictionSettingsPanel.tsx` | 来源选项文案 + 原生优先提示 | 修改 |
| `src/domains/workbench/coverage/periCoverage.ts` | peri-26 条目：消费面与 set_title 说明、fixture 补录 | 修改 |
| `docs/说明书/Pylon-项目架构参考.md` | 新增 #394/#395/#405 段（与 #393/#315 段并列） | 修改 |
| `.agents/decisions/0033-prediction-source-precedence.md` | ADR：源优先级与一次性预测消费口径 | 新增 |
| 测试：`periNormalizer.test.ts`、`workbenchProjector.test.ts`、`sessionSurfaceProjection.test.ts`、`assistPrediction.test.ts`（新）、`InputBar.solid.test.tsx`、`mountSolidWorkbench.solid.test.tsx`、`rendererSemanticCommand.test.ts`、`rendererSuiteHost.test.ts`、`thirdPartySolidRenderer.integration.test.ts` | 见「测试处置」 | 修改/新增 |

## 方案要点

- **实例身份**：预测是「一次性事实」。投影层把信封 `eventId` 落进 `assist.prediction.eventId`，消费标记键 = eventId（无则回退 `text:<预测文本>`），存 per-session `sessionUi`。ghost 与卡片读同一标记 ⇒ 双侧收敛；新 eventId 不命中旧标记 ⇒ 自然重现。
- **消费触发**：Tab/→/空草稿 Enter 接受（填草稿 + 消费）；空草稿退格与**输入分歧**（草稿不再是预测前缀）拒绝。分歧判定放 `createEffect` 而非 memo —— memo 必须纯净，写 sessionUi 是副作用。
- **ghost 呈现**：空草稿给全文；草稿是前缀时 `text.slice(draft.length)` 续显（既有渲染天然支持，此前被「草稿非空直接 return」挡掉）。
- **原生优先**：scheduler effect 在 `nativePrediction() !== null && mode !== 'standalone'` 时提前 return 并 cancel ⇒ 不发无谓请求。
- **#405 静默策略**：已知但无展示价值的变体（`goal_snapshot` 实测全字段 null、`turn_committed`、`state_snapshot`）不产事件、只留 info 诊断；`visibleDiagnostics` 过滤 info ⇒ 不进时间轴。非空 `goal_snapshot` 本轮同样静默（缺真实样本，映射到 `goal.updated` 属猜测；goal 生命周期另经 goal tool 通道到达），已在 issue 记为遗留。
- **未知卡标题**：`event.unknown` 的 message 取 `未识别的 <originalType> 事件`，原始载荷仍在诊断 `data`（「事件详情」）。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| 空文本 `prediction_ready` 不产卡、`goal_snapshot` 不产卡 | ✅ 单测（normalizer 静默用例 + 预测卡门控用例三段） |
| 原生预测进 ghost，Tab 接受并消费 | ✅ `InputBar.solid.test.tsx` 新增 6 例 |
| 前缀续显 / 输入分歧拒绝 / 空草稿退格拒绝 | ✅ 同上 |
| 原生在场不发本地请求 | ✅ 同文件（越过 400ms 去抖窗口后 `provider.predict` 零调用） |
| #395 判据：source 匹配才用文档 | ✅ 正反两例（不匹配时原生与文档历史都不参与；匹配时历史参与补全） |
| 消费后卡片消失、`queuedCommand` 不受影响 | ✅ `mountSolidWorkbench.solid.test.tsx` 三段 |
| 全量前端测试 | ✅ 661 文件 / 5104 用例通过（1 skipped / 1 todo） |
| 静态门禁 | ✅ `bun run lint` 0 error；`check:solid`（含 A17/R1–R4/C16 覆盖口径）exit 0；`check:frontend:static` exit 0；`check:clippy` exit 0（无新增诊断） |
| **真机验收** | ❌ **未做**（见「未解问题」） |

## 测试处置

- **修改**（契约变更引起，均为如实更新而非放松）：
  - `src/domains/workbench/__tests__/sessionSurfaceProjection.test.ts`：assist 投影期望加上 `eventId`（新契约：预测实例可被消费）。
  - `src/domains/workbench/__tests__/workbenchProjector.test.ts`：`event.unknown` 诊断期望改为 message=`未识别的 future_event 事件`，并补断言诊断 `data` 仍是原事件（原始载荷不丢）。
  - `src/host/renderer-suite/__tests__/rendererSemanticCommand.test.ts`：`makeHost` 补 `document` reader（新接线读取文档里的预测实例）；assist 用例补断言 `assist-prediction-consumed` 被写入。
  - `src/host/renderer-suite/__tests__/rendererSuiteHost.test.ts`、`src/plugin-runtime/renderers/__tests__/thirdPartySolidRenderer.integration.test.ts`、`src/renderers/solid-workbench/__tests__/mountSolidWorkbench.solid.test.tsx`：`WorkbenchMountInput` 构造点补 `sessionSource`（必填字段；测试填 `null` = 不收紧判据，行为不变）。
- **新增**：
  - `src/domains/workbench/session/__tests__/assistPrediction.test.ts`（4 例：实例键、空文本、消费与重现、无身份不消费）。
  - `periNormalizer.test.ts`：`set_title` 空文本帧不产 placeholder；已知簿记变体静默（`goal_snapshot` / `turn_committed` / `state_snapshot`）。
  - `InputBar.solid.test.tsx`：新增 describe「Agent 原生预测（#394）」6 例。
  - `mountSolidWorkbench.solid.test.tsx`：预测卡三段（空文本 / 已消费 / `queuedCommand` 仍渲）。

## 证据

- commit：`ead74d26`（代码 + 文档 + ADR；本记录为随后的 `docs(record)` 提交）
- 测试（名称 + 退出码）：
  - `bun run test` → 661 passed / 1 skipped（662 文件）、5104 passed（5106 用例），EXIT=0
  - `bun run lint` → 0 error（1 warning 在 `src/sheets/gateway/GatewaySheetView.tsx`，非本次改动）
  - `bun run check:solid` → EXIT=0（Solid 边界 166 文件、A17 R1–R4 + Suite completeness + C16 口径合规）
  - `bun run check:frontend:static` → EXIT=0
  - `CARGO_INCREMENTAL=0 bun run check:clippy` → EXIT=0（各 crate `added: []`）
  - `bunx vitest run src/domains/workbench/coverage` → 21 passed（peri-26 条目更新后覆盖门禁仍绿）
- manual：无（未做真机，见下）。

## 与 spec 的偏差

1. **spec 写「非空 `goal_snapshot` 走 `goal.updated`」，实际一律静默**：没有真实非空样本，映射到 `goal.updated` 是猜测，且失败投影会再产一张卡；改为全静默 + info 诊断，映射留给有样本时的跟进。
2. **spec 未写「本地请求抑制」的 `standalone` 例外**：实现里 `standalone` 明确排除原生源（表「强制本地」），已在 ADR-0033 与设置文案写明。
3. **spec 未写 `esc` 也要消费原生预测**：实现里 Esc 与退格对原生源同为消费（否则 Esc 后草稿回到空会复活）。
4. **spec 未写「空草稿 Enter 也接受原生预测」**：为与既有 `llm` 源键位一致而补上（空草稿 Enter 原本什么也不发）。

## 未解问题

1. **真机验收未做**：调试端口 9222 被用户正在使用的便携实例占用，而本会话的 MCP 服务固定连 9222；另起 dev 实例需换端口（`--port`）或释放 9222，二者都不宜由我单方面处置。**复现配方**（供用户或后续会话）：`bun run build`（已由 check:frontend:static 产出新 dist）→ `CARGO_INCREMENTAL=0 cargo build`（src-tauri，重新内嵌 dist）→ 以 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=<可用端口>"` 启动 dev 实例并配置 Peri → 在 Peri 会话发一句话，回合末应出现 ghost（`[data-prediction-source="native"]`），Tab 接受、退格拒绝、无 JSON 卡与空预测卡。**本轮 jsdom 已覆盖同一批断言**（键位为 onKeyDown/onInput，无指针捕获类改派）。
2. **消费标记在 renderer 侧**（`sessionUi`）：第三方 renderer suite 不共享「已消费」状态。
3. **卡片与 ghost 并存**：未被消费的预测仍在会话流里有一张卡（与 ghost 同一内容）。是否移除卡片为产品面裁决，本轮保留并收口。
4. **Hermes/其他 provider**：本轮只把「原生源」定义为文档里的 `assist.prediction`（谁推谁生效，无 provider 白名单）；Hermes 目前不推预测，若将来推同名字段即自动获得同一套交互。
5. `peri-25` 的 followUp（剩余零输出变体逐项补 fixture 或 policy test）仍在：本轮只把三个已知簿记变体移出 unknown 兜底，未穷举 peri AcpEvent 全变体。

## 并行交集

- 触碰（共享文件，供避让）：`src/domains/workbench/**`（normalizers/projector/sessionUiStore/session/coverage）、`src/renderers/solid-workbench/**`（input/WorkbenchDocumentSurface/mount 契约与测试）、`src/host/renderer-suite/**`、`src/sheets/agent-workbench/AgentRendererSuiteWorkbench.tsx`（仅一行 mount input）、`src/components/settings/InputPredictionSettingsPanel.tsx`、`docs/说明书/Pylon-项目架构参考.md`、`.agents/{spec,decisions,records}/`。
- 明确未碰：`src-tauri/**`、`pylon-session/**`、`src/sheets/agent-workbench/{agentWorkbenchSession,agentWorkbenchLifecycle}.ts`（#375/#376 在途）、`src/workspace-sheets/**`。
- 观测到他人未提交在途：`src/plugins/core/interfaceMode/builtinInterfaceModes.ts`（非本批产物，未触碰）。
