# Dev Record — #217 活性权威上移内核：在途回合成为一等事实（ADR-0017 落地）

> 入库保留。规格文档（spec）不保留，其目标、范围、方案与验收结论在此承接。
> 产出路径：`.agents/records/issue-217-turn-liveness-kernel-authority.md`

## 元信息

- issue：#217（refactor；ADR：`.agents/decisions/0017-turn-liveness-authority-in-kernel.md`）
- 分支：`Ru5t/Reflector`
- 提交范围：`1fa9e867..<head>`（基准 79e2e16f）
- 日期：2026-09-21

## 目标与范围

把「这个会话有没有在途回合」的权威从前端推断（#213 的 `turnClocks` 时钟）迁到**内核事实**：
`SessionInfo` 上的在途回合标记（语义严格为「本进程已派发 prompt、尚未收到终态」）经既有
冷挂载查询面暴露，前端以 `livenessSource: 'kernel'` 消费，优先级 kernel > clock > document；
kernel 可用时停用 applyLive 的两条「采纳实时帧」启发式。

**不做**：行级 `running` 投影语义不动；`turnClocks` 保留（elapsed 起点 + 终态摘要）；
不新增落盘字段、不改 journal 契约、不改 `turn_ledger.rs` 本体；无内核表态宿主行为不变。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src-tauri/src/session/model.rs` | `TurnInFlightMark` 结构 + `SessionInfo.turn_in_flight` 字段与 mark/clear/force_clear/turn_in_flight 四方法 + 2 个单测 | 修改 |
| `src-tauri/src/session/prompt.rs` | `report_settle` 内按键清理（三条终态臂唯一汇聚点）；`publish_prompt_failure` 头部 force-clear 防御纵深；出站成功处与 `turn_ledger.begin` 同点置位；3 个新单测 | 修改 |
| `src-tauri/src/runtime.rs` | `AgentRuntime.turn_in_flight_anomalies` 计数；`cold_mount_turn_snapshot` 输出 `turnInFlight`/`turnInFlightAnomaly`/`turnInFlightAnomalies` + 失配告警；快照三态契约测试 | 修改 |
| `src-tauri/src/session/persist.rs` | 无改动（`turn_snapshot` 组装既有代码自动携带新字段） | — |
| `src/infrastructure/acp/sessionClient.ts` | `ColdMountTurnSnapshot` 增 `turnInFlight?/turnInFlightAnomaly?`；normalizer 布尔守卫透传 | 修改 |
| `src/domains/workbench/generationLedgerSummary.ts` | 新增 `resolveKernelLiveness`（缺字段/畸形返回 undefined，不猜） | 修改 |
| `src/domains/workbench/workbenchRuntime.ts` | `livenessSource` 类型扩 `'kernel'`（snapshot/merge input/apply options）；`applyLivenessAuthority` 接受 kernel | 修改 |
| `src/sheets/agent-workbench/agentWorkbenchSession.ts` | `kernelLivenessBySource` map + `effectiveLiveness`（kernel > clock）；发送入口置 true、终帧/回滚置 false、refresh 收快照（false 观测不覆盖活动本地时钟的新鲜度守卫）；applyLive 两条启发式在内核表态可用时停用；`settleRuntimeLiveness`/`reconcileTurnClock`/bind 活动分支改经有效权威；refresh 终态证据同步收敛内核事实 | 修改 |
| `docs/说明书/Pylon-项目架构参考.md` | 活性段落同步（标记、清理纪律、wire 字段、前端优先级链与新鲜度守卫） | 修改 |
| 测试 | `generationLedgerSummary.test.ts`（+resolveKernelLiveness 组）、`livenessAuthority.test.ts`（+#217 三来源优先级组，6 例） | 修改 |

## 方案要点

1. **标记键化**（`generation, turn_id`）：客户端替换后，旧代际迟到的终态不得误清新回合的
   标记——`clear_turn_in_flight` 键不匹配返回 false 且不动标记。
2. **清理纪律**：置位只有一处（出站成功）；清理汇聚于 `report_settle`（Response /
   ConnectionClosed / CancelledAfterTimeout 三臂必经）+ `publish_prompt_failure` 的
   force-clear；映射移除随条目结构性消失。等待 future 被取消等残余由诊断读数显形。
3. **诊断读数**：`cold_mount_turn_snapshot` 查询时对比标记 vs 账本在途（`turn` 记录无
   `terminal`），失配 ⇒ `turnInFlightAnomaly: true` + `tracing::warn!` + 计数递增。
   这是 ADR 风险条款（「更难自查的永久生成中」）的防线。
4. **journal 终态行 ≠ 内核活性事实**（实现中踩过的坑）：bind 阶段的 `canonicalHasTerminal`
   是文档历史（重放的 done 行与本回合是否在途无关），不据此置内核表态——否则重放会话的
   新回合启发式被错误停用（rebind 指示器用例抓到）。内核事实只来自：冷挂载快照
   `turnInFlight`（refresh）、账本/journal 终态证据（refresh，与 #99 封钟同纪律）、终帧、
   本地生命周期（发送/回滚）。
5. **新鲜度守卫**：refresh 观测到 `turnInFlight=false` 而该 source 本地时钟活动时不覆盖
   （load 链与发送竞态下本地生命周期更新；内核真收敛则终帧随后到达自会落静）；true 一律
   采纳（跨窗口在途回合的唯一正确来源）。
6. **发送入口先行申报**：`projectOptimisticUser` 置 kernel=true，使权威立即切换 kernel
   （快照刷新前不再依赖时钟）；发送被拒回滚置 false。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| K1 Rust 单测（置位/按键清理/force-clear/report_settle 汇聚/挂起-超时生命周期/快照三态契约） | ✅ 7 例全绿 |
| K2 wire 字段经 `load_persisted_session` 到达前端（契约测试 + 真机 IPC 响应体） | ✅（见证据） |
| K2 说明书同步 | ✅（架构参考活性段落） |
| K3 三来源优先级用例（kernel=false 压重放尾行与实时帧 / kernel=true 抬起 / 无表态回退 clock / 终帧落静 / 合并层权威） | ✅ 6 例全绿 |
| K3 既有用例不回退（#213 livenessAuthority、#99 terminalDelivery、rebind indicator 等） | ✅ 前端全量 4548 passed |
| K4 真机：在途 spinner / 回合截断收敛 / 重启后未终结会话不复活生成态 | ✅（见证据） |
| K4 真机：他端先开回合 | ⚠️ 真机不可构造（fake agent 无法被第二个独立客户端驱动），由单测「kernel=false 时实时帧不再被采纳」+ 合并层用例覆盖 |

## 测试处置

- 新增：`turn_in_flight_mark_keyed_clear_semantics`、`turn_in_flight_force_clear_is_unconditional_and_reported`（model.rs）；
  `report_settle_clears_keyed_in_flight_mark`、`in_flight_turn_mark_tracks_hanging_prompt_until_timeout`（prompt.rs，
  后者以 `prompt-silent` fake agent + select! 轮询捕捉挂起窗口的标记置位）；
  `cold_mount_turn_snapshot_exposes_in_flight_mark_lifecycle`（runtime.rs）；
  `resolveKernelLiveness (#217)` 组（2 例）；`#217 活性权威上移内核` 组（6 例）。
- 修改既有行为测试：无（`send_prompt_core_success_has_one_authoritative_user_row` 末尾追加了
  标记已清的断言，属新增断言非行为变更）。

## 证据

- commit：本次提交（`Ru5t/Reflector`，pathspec 提交）
- 测试：
  - `cargo test --lib` → **1111 passed, 0 failed**（4 ignored）；`cargo test` 全 target 绿；
    `cargo fmt --check` clean；clippy 无本改动引入的告警（现存告警均在未触碰文件）
  - `bunx vitest run` → **616 files / 4548 tests passed**（1 todo，0 failed）
  - `tsc -p tsconfig.solid.json --noEmit` → exit 0
- 真机（debug 构建 + `PYLON_AGENTS_CONFIG` 指向 fake agent 配置，webview2-mcp 验收）：
  1. **在途**：FakeHang（prompt-silent，首 token 预算 90s）发送后挂起窗口内可见
     `.term-spinner-row`：文本 `✴仍在等待后端响应(21s)…■ 停止`（896×38 @ y=124），后端日志
     `Prompt started`（session=local:smua9wugn）。
  2. **回合被截断**：FakeTimeout（first_token 4s / settle 2s）发送 → 后端日志
     `Prompt timed out (no content streamed)`（timeoutKind=first-token，actualElapsedMs=4013）+
     `cancelled prompt accept-timeout did not settle within 2s; removed local session mapping`；
     前端页脚 `.term-summary-error` 文本 `!处理失败 8s`，无 spinner。
  3. **重启后未终结会话**：挂起中 `taskkill /T /F` 强杀进程树（spinner 21s/90s）→ 重启 →
     打开会话：用户行恢复可见（`bodyHasMsg=true`）、**spinner 行为 0 个**（`spinRows=[]`）、
     无 running 骨架行；且 `load_persisted_session` 真实 IPC 响应体（requestId 9548.171）内
     `"turn":{"turnInFlight":false,"turnInFlightAnomaly":false,"turnInFlightAnomalies":0,"turn":null}`——
     K2 新 wire 字段在真机到达前端且内核标记正确为否。

## 与 spec 的偏差

- bind 阶段不给内核表态置否（spec 未预先排除）：rebind 用例证明 journal 终态行不是内核事实，
  已在实现注释与说明书注明。
- K4「他端先开回合」真机场景降级为单测覆盖（fake agent 架构无法被第二客户端驱动），spec 的
  验收表未预判此限制。

## 未解问题

- elapsed 起点在「跨窗口在途」场景从本窗看见时刻起算（内核标记不携带 startedAt 的最小契约
  选择）；后续若需要可经 `turn.startedAtMs` 透传，不影响本片。

## 并行交集

- `src-tauri/src/session/model.rs`、`prompt.rs`、`runtime.rs`；前端 workbench/会话层文件；
  `docs/说明书/Pylon-项目架构参考.md`。未触碰 `turn_ledger.rs`、`dispatcher/**`、`persist.rs`、
  `tools/**`。开工时树上他人在途域：`event_repo.rs`、`pylon-compute/`、`pylon-canonical-types/`、
  `src/infrastructure/compute/`（#218/其他）——全程未改写、未连带提交。
- 附注：验收用 debug 构建启动时按 ADR-0008 对本机 `com.prism.desktop` 旧版数据库（v14）执行了
  「旧数据全丢」重建（v15）；验收产生的两个测试会话（fake-hang/fake-timeout）留在会话列表，可从
  History 删除。
