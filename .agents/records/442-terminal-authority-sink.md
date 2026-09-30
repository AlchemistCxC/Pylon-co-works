# Dev Record — #442 终态/回合权威字段下沉（turnBoundary / 终帧 turnId / 账本广播）

> 入库保留。规格文档（spec）不保留，其目标、范围、方案与验收结论在此承接。

## 元信息

- issue：#442（refactor(workbench): 终态/回合权威字段下沉——turnBoundary/终帧 turnId/账本广播，消前端三个重复状态机）
- 分支：`kumo/442-terminal-authority-sink`（独立 worktree `G:/Project/prism-team-workdir/pylon-442`，共享树只动 L.md——#448 会话在共享树在途）
- 提交范围：`8572cb02（github/main）..bdf12a49+`（三步各自独立提交，可逐个回滚）
- 日期：2026-09-30
- 前序决策：ADR-0017 / ADR-0029 / ADR-0034（本 issue 是三者「权威下沉」的收口刀）

## 目标与范围

**做什么**（issue 三步，全部落地）：
1. load 响应顶层 `turnBoundary{kind,startedAtMs?,endedAtMs?}` + `turn.startedAtMs` 透传——后端判据移植（照抄前端 `latestTurnBoundary` 含「同序号取 anchor」），前端「或」判定与 duration 扫描在字段可用时退役。
2. 终帧 additive `turnId`（done/error 双路径）——前端 stamps 猜测退役。
3. `pylon:turn-settled {source, turn}` 账本广播——终态收敛主轨与 Channel 注册生命周期解耦。

**不做什么**（维持 issue 界定）：TurnClock 不下沉（elapsed 计时渲染留前端）；不动 `publish_route.rs` 投递选路；golden trace 基线不动（三步全在 Tauri 层，不进 ACP wire trace）；`generationLedgerSummary.ts` 词表映射只读复用；browser 预览（IS_TAURI=false）document/localStorage 轨零改动；发送门控与 workbenchRuntime merge 仲裁属「后续阶段」，未动。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `pylon-session/src/turn_boundary.rs` | 新模块：`latestTurnBoundary`/`deriveCanonicalTurnDuration` 判据移植 + `TurnBoundary` wire 类型 + 16 例黄金用例 | 新增 |
| `pylon-session/src/event_repo/{repo,service}.rs` | tail 查询 `turn_boundary_rows`（四类边界行四标量列，cap 512） | 修改 |
| `pylon-session/src/event_repo/tests.rs` | journal 探测 4 例（升序投影/open/terminal/unknown） | 修改 |
| `src-tauri/src/runtime.rs` | `cold_mount_turn_snapshot` 改 `cold_mount_facts`（JSON 快照 + 类型化账本记录单次读） | 修改 |
| `src-tauri/src/session/persist.rs` | `PersistedSessionLoadResult.turnBoundary` 组装（账本暖 → 权威映射；账本空 → journal 判据；探测失败降级缺省）+ 映射单测 | 修改 |
| `src-tauri/tests/b11_inject/mod.rs` | load 响应 `turnBoundary` 端到端形状断言 | 修改 |
| `src-tauri/src/session/prompt/settle.rs` | done 载荷 additive `turnId`（=flow.request_id=账本 key turn_id）；三条终态臂 Published 后广播 turn-settled | 修改 |
| `src-tauri/src/session/prompt/ingest.rs` | error 载荷 additive `turnId`（新出参）；防御结算 Published 后同样广播 | 修改 |
| `src-tauri/src/session/prompt/wait.rs` | `send_prompt_core_impl` 增 `attempted_turn_id` 出参（账本 begin 后置位） | 修改 |
| `src-tauri/src/session/prompt/ledger.rs` | `report_settle`/`settle_turn_from_response` 返回 CAS 结果；`turn_settled_payload_if_published`（Published 才产出，Late/UnknownTurn 静默）+ `emit_turn_settled` 薄壳 | 修改 |
| `src-tauri/src/session/prompt/tests.rs` | Step2 终帧 2 例 + Step3 广播门控/载荷 1 例 | 修改 |
| `pylon-acp/src/turn_ledger.rs` | 新只读口 `active_turn_id_for_session`（与防御结算同选择序） | 修改 |
| `pylon-foundations/src/event_names.rs` | `TURN_SETTLED="pylon:turn-settled"` + ALL_EVENT_NAMES 登记 | 修改 |
| `src/infrastructure/acp/sessionClient.ts` | `PersistedTurnBoundary` 类型 + 逐字段守卫归一化；`turn.startedAtMs`/`terminal.settledAtMs` 透传 | 修改 |
| `src/domains/chat/chatReplayCoordinator.ts` | outcome 携带 `turnBoundary` | 修改 |
| `src/sheets/agent-workbench/agentWorkbenchLifecycle.ts` | `onCanonicalRefresh` 增第四参 | 修改 |
| `src/sheets/agent-workbench/AgentRendererSuiteWorkbench.tsx` | refresh 经 options 传权威边界 | 修改 |
| `src/sheets/agent-workbench/agentWorkbenchSession.ts` | publishFoldedDocument：「或」判定退役（open=权威未收敛，同时拦住账本归档越收敛）；duration 两端取权威（`durationSource:'turn-boundary'`）；终帧 turnId 透传时钟；`listenTurnSettled` 注入缝 + `handleTurnSettled` 收敛主轨 + destroy 清理 | 修改 |
| `src/sheets/agent-workbench/agentWorkbenchTurnClock.ts` | `terminal(..., turnId?)`：身份戳按精确匹配结算（错配不动戳——宁留内核 false 快照收敛），缺省维持猜测回退 | 修改 |
| `src/infrastructure/events/{canonicalEventFeed,pylonStreamWireEvents}.ts` | 终帧信号 turnId 守卫；`subscribeTurnSettled` + `canonicalTurnSettledFromPayload`；wire 名单增 turnSettled | 修改 |
| `src/domains/workbench/generationFooterContracts.ts` | durationSource 增 `'turn-boundary'` | 修改 |
| `docs/说明书/Pylon-项目架构参考.md` | 权威链路段 + TurnClock 段三处表述同步（turnBoundary/「或」退役/主轨换轴） | 修改 |

## 方案要点

1. **账本存在即权威**：`turnBoundary` 组装时账本记录优先——journal 终态行的落盘时序（settle → done 广播 → persist 窗口）从构造上退出结论，这正是前端被迫「两路取或」的时序裂缝。账本为空（重启后的历史会话）才走 journal tail 判据（移植版），查询失败降级字段缺省。
2. **判据移植逐条照抄 + 黄金用例**：`latest_turn_boundary_kind`（argmax + 同序号取 anchor）与 span 状态机（首有效锚点起点、终态闭合、同回合多条终态不重替换、终态早于起点整行跳过）逐条对照 TS 源；16 例 Rust 黄金用例全部对应 `canonicalTurnDuration.test.ts` 现有用例。**一处记录在案的有意差异**：`turn.unit` 内嵌 segments 锚点恢复（#199）不移植——那是 compact 读路径裁剪 `user.message` 行后的恢复手段，本模块直查库、顶层锚点行恒可见。
3. **同序号畸形输入的 span 定序**：terminal 先于 anchor 处理（anchor 视为更新），与 kind 判据「同序号取 anchor ⇒ open」自洽——open 时时间戳给出的是**当前回合**起点。
4. **终帧 turnId 不伪造**：done 恒有（settle 时手里必有 turn_key）；error 经 out-param（账本 begin 后置位；校验类失败发生在 begin 前则帧缺省该键）。
5. **stamps 退役 = 精确匹配而非删除**：`markKernelSettled` 在 turnId 在场时按「active 戳 turnId 段 == 帧身份」匹配，一致才落 settled；错配**不动身份戳**（宁留给内核后续 false 快照收敛，也不把错误回合记成 settled——错标会让 stale 快照漏过守卫二）。turnId 是 per-runtime 单调 request id，后缀匹配即全局无歧义。
6. **turn-settled 至多一次**：广播门控在 CAS 结果上（`Published` 才产出载荷），Late/UnknownTurn 静默——终态事实由赢家唯一发布；窗口广播单轨，与 Channel 注册无关，`stop_agent_runtime` 清注册后仍可达（「至多一次」投递模型的永久假在途就此消灭）。
7. **未映射 cause 的收敛语义**：词表认不出的 cause 仍收敛活性（内核说 settle 就是 settle）并封存时钟，但不伪造 reason 摘要——宁可「无摘要的静止」，不把失败报成成功。
8. **单次读取防响应内矛盾**：`cold_mount_facts` 让 turn 快照与 turnBoundary 出自同一账本读（两次读取之间 settle 不再产生「快照说在途、边界说已收敛」的自相矛盾响应）。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| 新字段契约测试（后端形状钉子 + 前端归一化用例）绿 | ✅ Rust：turn_boundary 16 例 + repo 探测 4 例 + ledger 映射 1 例 + b11 端到端形状 + 终帧 2 例 + 广播 1 例；TS：sessionClient 归一化 5 例 |
| `bun run test` / `check:frontend` 组成项 / `check:clippy` / `check:acp-shadow` 绿 | ✅ 全量 vitest 657 文件 5110 用例通过（详见证据）；clippy 全 crate `added: []`；acp-shadow exit 0 parity 全 true；tsc 0 错、eslint 0 error、check:ipc / check:canonical-types 过 |
| stamps 猜测/「或」判定/duration 扫描在字段可用时不再参与（回退轨仅在字段缺失时激活） | ✅ 测试钉死：turnBoundary terminal 直接封存（journal 读早于终态行落盘场景）；open 权威否决（不压塌、不越收敛）；字段缺失回退轨逐字一致（`agentWorkbenchSession.turnBoundary.test.ts` 4 例 + `terminalDelivery` 回退例）；turnId 匹配精确结算、错配不动戳、旧内核缺省猜测（terminalDelivery 3 例） |
| 终帧丢失场景（clear Channel 后）由账本广播收敛，无永久假在途 | ✅ `terminalDelivery`「converges a lost-terminal-frame turn from the broadcast」例 + 广播门控至多一次（Rust Late 静默） |

## 测试处置

- 新增：Rust 25 例（turn_boundary 16、repo 探测 4、ledger 映射 1、终帧 2、广播 1、b11 扩展断言）；前端 16 例（归一化 5、turnBoundary 行为 4、终帧归属 3、广播收敛 4）。
- 修改既有测试：`b11_inject` 增 `turnBoundary` 形状断言（additive）；`sessionClientColdMountTurn` 的键集断言随新增字段更新措辞（语义不变）；`vitest.setup.ts` 白名单登记新测试文件（同族 feed 注册噪音源，B 类既有分类）；`prompt/tests.rs` 的 `publish_prompt_failure` 直接调用点随新参数补 None。
- 无既有行为测试被删除或改判。

## 证据

- commit：Step1 `8e820999`（17 文件）、Step2 `ff7b6932`（8 文件）、Step3 `bdf12a49`（10 文件）、docs+record 收口提交。
- 测试：`cargo test -p pylon --lib` 965 passed/0 failed；`-p pylon-session --lib` 201/0；`-p pylon-foundations --lib` 87/0（event_names 三条 wire 契约含新事件）；`bun run test` 657 文件 / 5110 用例全过（1 例先红为 worktree 缺 `build:example-plugin` 产物，补建后复绿——环境序，非代码）；`check:clippy` exit 0（`added: []` ×6 crate）；`check:acp-shadow` exit 0（parity 全 true，golden 基线未动）；`tsc -b` 0 错。
- 手工验证：未做实机验收（调试端口被在用便携实例占用，同 #394 遗留配方）；三步均为 wire additive + 门禁语义测试钉死，实机复验可在合并后按 webview2-acceptance 配方补。

## 与 spec 的偏差

- spec「duration 扫描退役」落点从「时钟 seedFromBoundary」收窄为「displayOnly 摘要耗时取权威两端」（`durationSource: 'turn-boundary'`）——open 回合的 elapsed 起点播种（turnBoundary.startedAtMs → 时钟）**未做**：判定臂已由字段替代，播种属显示增强，转未解问题。
- spec 预告的「report_settle 返回值形态」落定为返回 `SettleOutcome` + 独立 payload 纯函数（可单测门控）。
- 其余按 spec 执行。

## 未解问题

1. **open 回合 elapsed 播种**：`turnBoundary.startedAtMs`（open）可作时钟 `generationStart` 的权威回退（他端先开回合场景本进程无起点）——显示增强，建议随「后续阶段（发送门控问内核）」一并评估。
2. **实机复验**：三场景（重启后打开终态会话 / 在途回合切页重读 / stop 后 Channel 清注册）建议按 `.agents/skills/webview2-acceptance` 配方跑一轮真机读数。
3. **平台源（window=None）的 turn-settled**：与 done/error 同口径跳过窗口广播；平台会话的前端收敛仍走账本快照轨（load/refresh）。若未来平台源需要 WebView 镜像，需另立投递面。

## 并行交集

- 共享树只动过 `.agents/L.md`（开工声明，单独提交 `255748df`）。
- 本 worktree 触及的共享面：`agentWorkbenchSession.ts`（#448 已声明错峰避让本文件，其条目明写「agentWorkbenchSession.ts（#442 错峰）」）、`canonicalEventFeed.ts` / `sessionClient.ts`（近期批次均已合入 main，无在途交集）。
- `generationFooterContracts.ts` durationSource union 为 additive 扩展；`pylon-foundations/event_names.rs` 登记为 additive（三条契约测试自动覆盖）。
