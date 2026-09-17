# Dev Record — issue 68 生成指示器偶发不出现（残留面：终帧交付与账本证据）

> 入库保留。规格文档（spec）不保留，其目标、范围、方案与验收结论在此承接。
> 产出路径：`.agents/records/issue-68-generator-indicator-terminal-delivery.md`

## 元信息

- issue：#68（OPEN，本次在其下补评论登记残留面）
- 分支：`Ru5t/Reflector`
- 提交范围：`<base>..<head>`（见「证据 · commit」，提交后回填）
- 日期：2026-09-17

## 目标与范围

**目标**：把「生成指示器偶发不出现」这条 #68 现象的运行时链路查清并修掉可确定性论证的缺口。

**做了什么**：
1. 用 `pylon-webview2` MCP 在运行中的应用上装探针（DOM 状态时间轴 / 宿主帧事件 / 回调普查），实测 #68 原案；
2. 修两条**不依赖一次性 IPC Channel 注册**的终态证据：终帧 window 广播兜底、#99 冷挂载 turn 账本接入 `refresh`。

**不做什么（明确边界）**：
- **不动** `workbenchRuntime.mergeRuntimeSnapshot` 里「running 投影清掉 summary + terminalFence」那条分支。它是 #68 现症状的一个候选根因（见「未解问题」），但本次**未拿到运行时复现**，按 §4「不猜」不施治。
- 不改后端 `send_channel_terminal` 的 `take` 语义、不改 `clear_update_channels` 的调用面。
- 不引入 queue/steer 语义变更。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src/domains/workbench/generationLedgerSummary.ts` | 账本终态 → 摘要 reason 的纯映射（含词表外不映射） | 新增 |
| `src/domains/workbench/__tests__/generationLedgerSummary.test.ts` | 上者的表驱动测试 | 新增 |
| `src/infrastructure/events/canonicalEventFeed.ts` | 导出 `canonicalTerminalKindFromEvent`/`canonicalTerminalSourceFromPayload`/`canonicalTerminalSignalFromFrame`；新增 `subscribeWindowTerminalFrames`；`emitTerminal` 改用共用构造 | 修改 |
| `src/components/chat/chatReplayCoordinator.ts` | `ReplayLoadOutcome.turn` 字段 + 从 `PersistedSessionLoadResult.turn` 填充 | 修改 |
| `src/components/chat/__tests__/chatReplayCoordinator.test.ts` | 钉「账本随 outcome 上抛」与「缺失时不臆造」 | 修改 |
| `src/sheets/agent-workbench/agentWorkbenchSession.ts` | `listenTerminalFallback` 依赖缝 + 终态收敛单入口 `handleTerminalSignal`；`ledgerTerminalBySource`（按 source 归档、回合起点清空）；`refresh(session, ledgerTurn)` 的终态证据改为「journal 终态行 ∨ 账本已收敛」 | 修改 |
| `src/sheets/agent-workbench/agentWorkbenchLifecycle.ts` | `onCanonicalRefresh` 增第三参 `turn` 并在 load 完成处传入 | 修改 |
| `src/sheets/agent-workbench/AgentRendererSuiteWorkbench.tsx` | 把 `turn` 透给 `sessionRuntime.refresh` | 修改 |
| `src/sheets/agent-workbench/__tests__/agentWorkbenchSession.terminalDelivery.test.ts` | 两条兜底路径 + 不臆造 + 跨回合失效 | 新增 |
| `docs/说明书/Pylon-项目架构参考.md` | §8 两处：账本字段的消费端、终帧双路收敛 | 修改 |

## 方案要点

### 已确证的缺口一：终帧只有一条投递路径

- 后端 `session/prompt.rs::send_channel_terminal` 用 **`take` 语义**（发送即注销注册）；`lifecycle/mod.rs::stop_agent_runtime` 会 `clear_update_channels`。
- 前端 `streamChannel.ts` 的 Channel 回调是 `activeStreams.get(source)?.handler(frame)`——`activeStreams` 条目在 `streamingSend` 的 invoke 被拒时会被 `close(source)` 移除，此后该 source 的帧被**静默丢弃**。
- 而 `finalize_response` / `publish_prompt_failure` 两条收尾路径虽都无条件 `emit_event_all` 广播，**全仓却没有任何 `pylon:done`/`pylon:error` 的 window 监听**（`listen(` 仅见 `pylon:user`/`agent-status`/`runtime-log` 等）。即广播是死信。
- 结论：Channel 一丢，终态就没有第二次投递——文档投影照旧收敛到「不在生成」，快照落到 `generating:false, summary:null`，footer 两样都不渲染。

**修法**：`subscribeWindowTerminalFrames` 订阅同一条广播，与主轨**共用** `canonicalTerminalSignalFromFrame`（两条路的终帧判定不各自演化），重复投递由 TurnClock 幂等（首个终态 wins）吸收。放在 infrastructure（feed 是帧契约与 `listen` 的归属地），sheets 层只依赖一个现成函数，不新增直连 Tauri 的依赖。

### 已确证的缺口二：#99 账本没有消费端

- `ColdMountTurnSnapshot.turn`（`turn.phase`/`turn.terminal.cause`）随 `load_persisted_session` 回到前端、`sessionClient.ts` 已归一化，注释自述意图是「前端不再依赖一次性的 Tauri event」，但 `src/` 内**无任何 `outcome.turn` 消费者**。
- 后端事件顺序是 **done 先于 persist**（`prompt.rs` 收尾注释原文），因此一次 canonical 重载读到的 journal 可能尚无终态行；此时 `refresh` 的 `canonicalHasTerminal` 为假 ⇒ 既不封存时钟、也不补 displayOnly 摘要 ⇒ 摘要彻底缺席（切 sheet 触发的新一轮重读才会补上——与报告描述的恢复方式一致）。

**修法**：`ReplayLoadOutcome.turn` → `onCanonicalRefresh` → `refresh(session, ledgerTurn)`；终态证据改为「journal 终态行 ∨ 账本已收敛」。两点防御：
- 账本 reason **按 source 归档**（`ledgerTerminalBySource`）：`refresh` 对同 source 会去重（`refreshInFlight`），一次早于收敛发起的重载可能与携带账本的那次同窗，入参会被丢掉；归档可让在途那次用上它。
- **回合起点清空归档**（`turnClockStart`）：否则上一回合的终态会被当成本回合证据，把在途新回合判成已收敛。
- cause 映射**词表外一律 `undefined`**（维持现状），不把失败报成成功、也不把成功报成失败；`EmptyTurn` 按后端语义算**合法成功**（tool-only 回合）。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| 探针可在运行中的应内观测指示器状态跃迁（活动 sheet 作用域） | 达成（`window.__GENPROBE`） |
| 冷启动 + 空态首条消息，摘要首次渲染即出现（#68 原案是否仍成立） | 达成：3/3 命中（冷启动那轮 18s），未见原案 |
| Channel 帧丢失时终帧仍能收敛（广播兜底） | 达成（单测） |
| journal 读早于终态行落盘时摘要仍能补出（账本兜底） | 达成（单测） |
| 账本在途/词表外 cause 不得臆造摘要 | 达成（单测） |
| 全量前端测试无回归 | 达成：3922 passed / 581 files |

## 测试处置

新增 3 个测试文件/区段，无修改或删除既有测试：
- `src/domains/workbench/__tests__/generationLedgerSummary.test.ts`（新增）
- `src/sheets/agent-workbench/__tests__/agentWorkbenchSession.terminalDelivery.test.ts`（新增）
- `src/components/chat/__tests__/chatReplayCoordinator.test.ts`（追加 2 例）

## 证据

- commit：（提交后回填）
- 测试（名称 + 退出码）：
  - `vitest run`（全量）→ 0，`Test Files 581 passed` / `Tests 3922 passed`
  - `tsc -p tsconfig.solid.json --noEmit` → 0
  - `eslint <改动文件>` → 0
  - `check-runtime-boundaries.mts` / `check-renderer-architecture.mts` / `check-dependency-imports.mjs` / `check-ipc-contract.mts` → 0
- 手工验证（真机，`F:\A-I\Platform\Pylon\pylon.exe` v0.2.0，构建于 2026-09-17 22:20，含 `145fa8c3`）：
  - 应用冷启动（22:20 起、零会话、零生成）后于空态发出首条 prompt：footer 由 `term-spinner-row` 正确切到 `term-summary term-summary-done`「处理耗时 18s」，computed style `display:flex` / 可见 / 高 30px；
  - 另两轮（新 sheet 空态首条消息）同样正常（3s）；
  - 宿主帧序列实测含 `pylon:done`（payload 带 `source` 与 `turn.completed` canonicalEvent），确认窗口广播确实发出。

### 探针（本次建立，可复用）

页面内 `window.__GENPROBE`：`state()` 按**活动 sheet** 作用域读 footer（spinner/summary/computed 盒模型/creationState/sessionId）；`dump()` 给状态跃迁时间轴 + 1Hz 心跳 + 自动标记 `ANOMALY-summary-cleared-spinner-back`。另经 `Page.addScriptToEvaluateOnNewDocument` 注册了新文档注入版（reload 后自动重装；该注册属调试会话，不持久化进应用）。

**探针限制（实测，勿重复踩）**：
- `window.__TAURI_INTERNALS__.invoke` 与 `callbacks` 均 `configurable:false/writable:false`，**无法包装**；Channel 帧不走 `callbacks` 映射表（回合中 40ms 普查键数恒为 0），故**前端帧级旁路做不到**，判断终帧到没到只能靠后端日志 + DOM。
- sheet 是 keep-alive（活动 `display:contents`、非活动 `display:none`，footer 不卸载），**多个 workbench 同时在 DOM 里**；`document.querySelector('.term-summary')` 会命中隐藏 sheet（本次探针一度被骗到读到 `h:0/w:0`），必须按活动 sheet 取根。

## 与 spec 的偏差

本次按用户指示「直接修已发现的问题」进行，未先落 `.agents/spec/` 规格化文档；目标/范围/方案/验收结论一并承接于本记录。

探索期曾据 `runtime.rs:139` 的注释判断 `reconnect_agent`/`restart_agent_runtime` 会清空通道注册表并据此设计验证方案——**该前提有误**：二者都走 `connect_and_replace`，不清注册表；唯一入口是 `switch_agent`（及移除 agent 的 `remove_stale_runtimes`）。该段注释与代码行为不一致，见「未解问题」。

## 未解问题

1. **`mergeRuntimeSnapshot` 的「running 投影清掉 summary + terminalFence」分支**（`workbenchRuntime.ts`，注释自述 *the fence above outlives the evidence…*）与 `normalizeRuntimeSnapshot` 自述的不变量（*the fence is only cleared by a turn-epoch advance or an explicit null*）**相互矛盾**：前者用一次「看起来在途」的投影就清掉 fence。若该投影只是一次**早于终态行的读**，被清掉的就是刚落地的合法终态。本次依赖的两次 canonical 重载（activate → `waitForAgentReady` → `startPersistedLoad`；后端 done 先于 persist）让它有可乘之机。**未复现，故未改**——施治需要先构造出该分支可命中且可重复的时序，再决定收紧口径（倾向：只有更新回合的证据才有权清 fence）。
2. **`runtime.rs::take_update_channel` 的文档漂移**：注释称会在 "generation bump" 被调用，全仓无此调用点。会让读者误判注册表生命周期，建议就地订正注释或补上调用。
3. `refresh` 仍是唯一的账本入口；`bind` 直接调 `loadAll`（只拿 rows，无账本）。若要覆盖「bind 读早于终态行」的情形，需要把账本也接到 bind，本次未做（改动面更大、且 bind 后紧跟的那次 canonical 重载已覆盖主要窗口）。

## 并行交集

本次碰过的共享文件（供其他贡献者避让）：
`src/infrastructure/events/canonicalEventFeed.ts`、`src/components/chat/chatReplayCoordinator.ts`、`src/sheets/agent-workbench/agentWorkbenchSession.ts`、`src/sheets/agent-workbench/agentWorkbenchLifecycle.ts`、`src/sheets/agent-workbench/AgentRendererSuiteWorkbench.tsx`、`docs/说明书/Pylon-项目架构参考.md`。
