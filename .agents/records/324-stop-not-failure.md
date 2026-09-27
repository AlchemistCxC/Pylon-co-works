# Dev Record — #324 用户主动停止被渲染为「处理失败」→ 中性结算

> 入库保留。规格文档（`.agents/spec/issue-324-stop-not-failure.md`）不保留，目标、范围、方案与验收结论在此承接。

## 元信息

- issue：[#324](https://github.com/AlchemistCxC/Pylon-co-works/issues/324)
- 分支：`kumo/prometheus`
- 提交范围：`b23d00de..<head>`
- 日期：2026-09-25

## 目标与范围

**做什么**：用户点击「停止」后，ACP 标准回包 `stopReason=cancelled` 不再进错误呈现链（错误卡 / 红色状态条 / 错误中心），改以中性 done 通道结算，前端呈现「已停止」。

**不做什么**：不改 `protocol.rs` #316 闭式判定表（`S::Cancelled => Err` 契约保留，拦截在流程层）；不做 cancel 发起方状态跟踪（agent 侧发起的 cancelled 同样中性结算——账本本就记 `TurnTerminalCause::Cancelled`）；不动 refusal / max_tokens 呈现；不动 golden trace（wire 时序零变化）。

## 根因链（实机取证 2026-09-25，0.3.0 发行实例）

点停止 → `cancel_prompt` 发 `session/cancel`（后端日志证实已发送）→ Peri 回 prompt 响应 `stopReason=cancelled` → `finalize_response` → `prompt_stop_outcome`（`pylon-acp/src/protocol.rs` `S::Cancelled => Err`）→ 错误广播（`failure.source=internal`）→ 前端 `acpNormalizer` 生成 `provider.error` 诊断 → `workbenchProjector` A04 收敛为 error → 错误卡 + ⚠ 徽标。账本层（`settle_turn_from_response`）此时已正确落 `TurnTerminalCause::Cancelled`——仅展示通道误标。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src-tauri/src/session/prompt.rs` | `finalize_response` 顶部拦截 + 新增 `is_cancelled_stop_response` / `finalize_cancelled_response` + 谓词单测 | 修改 |
| `src-tauri/src/bin/pylon-fake-agent.rs` | `prompt-cancel-respond` 场景补 `session/new` 应答（原场景只服务直连 AcpClient 的传输层测试） | 修改 |
| `src-tauri/src/test_harness.rs` | 门面新增 `cancel_prompt` 驱动方法（P5 窄值惯例） | 修改 |
| `src-tauri/tests/integration.rs` | 注册 `prompt_cancel` 切片 | 修改 |
| `src-tauri/tests/prompt_cancel/mod.rs` | E2E：send→cancel→中性结算三断言 | 新增 |
| `src/sheets/agent-workbench/agentWorkbenchSession.ts` | `handleTerminalSignal`：done 帧 `data.stopReason==='cancelled'` → summary reason `'cancelled'` | 修改 |
| `src/renderers/solid-workbench/solidWorkbenchProjectionSupport.ts` | 新增 `visibleDiagnostics`（info 级诊断不进对话面） | 修改 |
| `src/renderers/solid-workbench/WorkbenchDocumentSurface.solid.tsx` | 消费 `visibleDiagnostics`（去重逻辑一并迁移） | 修改 |
| `src/sheets/agent-workbench/__tests__/agentWorkbenchSession.terminalDelivery.test.ts` | 新增 #324 终态映射用例 | 修改 |
| `src/renderers/solid-workbench/__tests__/documentSurfaceDiagnostics.test.ts` | 新增门控三用例 | 新增 |
| `docs/说明书/Pylon-模块维护地图.md` | Native session 行补 #324 表述 | 修改 |

## 方案要点

1. **流程层拦截而非改闭式表**：#316 刚落地的「cancelled 维持 Err」契约原样保留；`finalize_response` 开头对精确 `stopReason=="cancelled"`（空白/大小写变体不享拦截，仍 fail-closed）分流到 `finalize_cancelled_response`。
2. **中性结算镜像 done 骨架**：generation 复核 → 首轮标记 → canonical 提交（done update 携 `stopReason=cancelled`，journal 落 `turn.completed`）→ window 广播 + Channel 终帧。pet 不感知（非自然完成也非失败）；B11.2 Prism persist 跳过（与 `CancelledAfterTimeout` 臂口径一致：中断回合不落摘要）。
3. **前端呈现零新增契约**：`GenerationFooter` 的 reason='cancelled'「已停止」分支、`generationLedgerSummary` 的账本 cancelled 映射、`presentPromptFailure` 的「请求已取消」文案全部**先于本 issue 存在**——内核从不给它们喂 cancelled 终态而已。本次只补活机路径 `handleTerminalSignal` 对 done+cancelled 的识别。
4. **顺带降噪**：`peri.turn-done` 等 info 级 `diagnostic.notice`（#315「只留痕」语义）不再渲染为对话面大卡——数据保留在 `document.diagnostics` 与 Runtime 日志，warning/error 照常。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| 内核：cancelled 响应走 done 通道且无错误帧 | ✅ E2E `prompt_cancel::user_cancel_settles_via_done_channel_not_error`：send_message 返回 Ok（旧路径 Err("prompt cancelled")）、journal 无 `error` update、done update 携 `stopReason=cancelled` |
| 账本 Cancelled 终因不回归 | ✅ `settle_turn_from_response` 未触碰；`terminal_cause_from_prompt_result` cancelled→Cancelled 原样 |
| #316 闭式表契约不回归 | ✅ `validates_prompt_stop_reasons` / `prompt_stop_outcome_rejects_malformed_stop_reasons` 零修改全绿 |
| 前端：done+cancelled → 「已停止」摘要 | ✅ `terminalDelivery` 新用例 + 既有 `GenerationFooter.solid.test` 「已停止」文案用例绿 |
| info 级诊断不进对话面 | ✅ `documentSurfaceDiagnostics.test` 3 用例 |
| 全量门禁 | ✅ 见证据 |

## 测试处置

- 新增：Rust `is_cancelled_stop_response_matches_exact_spelling_only`（lib）、`prompt_cancel::user_cancel_settles_via_done_channel_not_error`（integration）；前端 `agentWorkbenchSession.terminalDelivery` #324 用例、`documentSurfaceDiagnostics.test.ts` 3 用例。
- 修改/删除既有行为测试：**无**（#316 闭式表与 golden trace `cancel.jsonl` 零改动——wire 时序不变）。
- fake agent `prompt-cancel-respond` 场景属测试基建：补 `session/new` 应答使其可达内核级 E2E，对既有传输层测试（`fake_acp_prompt_cancel_returns_final_cancelled_response`）行为无影响（其断言全绿）。

## 证据

- commit：本记录随提交入库，hash 见 PR。
- 测试（均退出码 0）：
  - `cargo test --lib`：**829 passed, 0 failed**（基线 828 + 新增 1）
  - `cargo test --workspace --tests --features test-agent`：exit 0（含 integration **28 passed**，基线 27 + 新增 1）
  - `bun run test`：**4959 passed**（基线 4955 + 新增 4），1 skipped
  - `bun run check:solid`：exit 0（触 renderers 后按 skill 强制跑）
  - `cargo clippy --lib --tests --features test-agent`：零新增（残留为既有 dead_code 与 pylon-core needless_return）
- 手工验证（实机 2026-09-25，取证阶段）：旧行为下停止 → 「处理失败」卡 + 红条 + ⚠1，后端日志 `cancel_prompt: session/cancel 已发送` + `unrecognized session/update discriminator: agent_event_done` 警告，构成根因链证据。

## 与 spec 的偏差

1. spec 未决问题「info 级一律不进时间线大卡的粗粒度门控」——按倾向方案执行（`visibleDiagnostics` 过滤 info），`peri.oauth-restored` 等 info 通知随之只留在诊断数据层，PR 说明备案。
2. spec「验证 done 帧 stopReason 存续」时发现活机路径 `handleTerminalSignal` 缺 cancelled 识别（冷挂载账本路径已有），新增映射——属 spec 方案要点第 2 条的落实细化，非偏差。
3. spec 测试处置预估「可能有断言 cancelled→Err 传播的端到端测试需点名更新」——实际无此类测试（E2E 是本切片新建的）。

## 未解问题

- **实机 UI 复验未做**：需 `bun run build` → `cargo build` → 重启带真 Agent 的实例点一次停止。本切片以真实子进程 fake-agent 的内核级 E2E 覆盖了 wire→settle→journal 全链；UI 层（页脚「已停止」文案）由既有组件测试覆盖。遗留为可选项。
- agent 侧自行发起的 `stopReason=cancelled`（无用户停止）现同样中性呈现——如需区分需引入 cancel 发起方标记，属后续 issue 范畴。

## 并行交集

- 与 #331（后端质量清偿批次）同分支并行：其声明避让 `session/prompt.rs` 与 `src/**`，本切片未触其任何文件域（retention/audit/refs/route/state/canonical_flush/create）；全量门禁在其在途改动共存下跑绿。
