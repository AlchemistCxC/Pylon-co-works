# Dev Record — #390 生成指示器状态机不稳定（切页塌成上一轮已完成 / 时间不更新 / 秒数冻住）

> 入库保留。规格文档（spec）不保留，其目标、范围、方案与验收结论在此承接。
> 产出路径：`.agents/records/390-indicator-state-machine-refactor.md`

## 元信息

- issue：[#390](https://github.com/AlchemistCxC/Pylon-co-works/issues/390)
- 分支：`kumo/prometheus`
- 提交范围：`f06fd787..de4d69f9`（代码 + 测试）；本记录与 ADR-0029、说明书行为随后续文档提交
- 日期：2026-09-27

## 目标与范围

用户原话：

> 「生成指示器状态机不稳定，包括但不限于：切换页面会导致状态混乱，时间不更新，一直显示已完成，请你充分调并给出重构方案」

> 「真机有时候 spinner 和秒数都停，然后就是开工，把这问题修了，需要决策就用 ask 问我」

用户裁定（AskUserQuestion）：**全量重构（大 PR）**；真机验收 **先落代码，再由用户构建实例复验**。

**做**：回合作用域化终态证据；活性守卫单源化（五 Map 合一）；封存可恢复；文档终态不越权；
`lastTokenAt` 随帧推进；footer 回合身份改由宿主给出。含回归测试、ADR、说明书同步。

**不做**：
- `src-tauri/**`（缺陷纯前端，内核账本契约不动）。
- `src/domains/workbench/workbenchProjector.ts`（#389 在途脏文件，§2.1 避让）。
- 工具行指示器（#389 的 `ToolBody.solid.tsx` / `domains/tool/status.ts`）。
- `src/workspace-sheets/**`（页签保活维持现状，仓库主已裁定）。
- **elapsed 所有权整体上移**（见「与 spec 的偏差」）。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src/domains/events/canonicalTurnDuration.ts` | 新增 `latestTurnBoundary` 三态判据；`hasCanonicalTurnTerminal` 加「不得用于当前回合」文档约束 | 修改 |
| `src/domains/workbench/generationFooterContracts.ts` | `GenerationFooterInput` 增 `turnId`（宿主回合身份，可选） | 修改 |
| `src/domains/workbench/workbenchRuntime.ts` | `documentIsTerminal` 硬覆盖不越过活性权威；`applyLivenessAuthority` 保 `lastTokenAt` | 修改 |
| `src/sheets/agent-workbench/agentWorkbenchProjection.ts` | 新增 `canonicalLatestBoundaryFromRows` | 修改 |
| `src/sheets/agent-workbench/agentWorkbenchTurnClock.ts` | 五 Map → 一条 per-source 记录；共享守卫；封存两道守卫；终帧补写摘要 | 修改（内部结构重写，公共接口不变） |
| `src/sheets/agent-workbench/agentWorkbenchSession.ts` | 重读路径改用回合作用域判据 + `readStartedAt`；`applyLive` 写 `lastTokenAt` | 修改 |
| `src/renderers/solid-workbench/chat/GenerationFooter.solid.tsx` | 删除本地铸号 `generation-N` 与 `generationSerial`，改宿主 `turnEpoch` 身份 | 修改 |
| `src/renderers/solid-workbench/WorkbenchContent.solid.tsx` | 传 `turnId={snapshot().turnEpoch}` | 修改 |
| `src/__tests__/replay/agentWorkbenchSession.indicatorStability.test.ts` | 新增 6 例回归护栏 | 新增 |
| `src/__tests__/replay/canonicalTurnDuration.test.ts` | 新增 `latestTurnBoundary` 6 例（含旧判据对照） | 修改 |
| `src/renderers/solid-workbench/chat/__tests__/GenerationFooter.solid.test.tsx` | 新增宿主 `turnId` 开新回合 1 例 | 修改 |
| `vitest.setup.ts` | 新测试文件登记进 B 类 console.error 白名单 | 修改 |
| `.agents/decisions/0029-turn-scoped-terminal-evidence.md` | 新 ADR | 新增 |
| `docs/说明书/Pylon-模块维护地图.md` | 「工作台宿主」行补活性权威单源与回合作用域判据约束 | 修改 |

## 方案要点

### 1. 根因（同一处，解释全部三个症状）

「**本回合**是否已收敛」的 journal 侧判据一直是**回合无关**的：
`hasCanonicalTurnTerminal()` 返回「rows 里曾经出现过终态」。它被
`publishFoldedDocument` 当作当前回合的收敛证据使用。于是只要该会话历史上完成过任一回合，
任何一次 canonical 重读都可能把在途回合判成已收敛：

1. `settleFromDocument` 封存回合时钟——当时**唯一**不看内核权威的时钟写入者
   （同模块 `reconcile` / `activeUnsettledClock` 都遵守「内核说在途则让位」）；
2. 封存后 `touch` / `reconcile` / `terminal` 的 live 摘要写入全部 no-op，**误封不可逆**；
3. 页脚显示上一轮的 `displayOnly` 摘要：耗时是静态值（不走秒）、spinner 停、真实终帧改不回来。

用户看到的「状态混乱 / 时间不更新 / 一直显示已完成」是**同一个快照**的三种描述；
「spinner 和秒数都停」是同一屏幕的另一种描述（摘要视图的 marker 与耗时都是静态值）。

### 2. 修复

- **判据回合作用域化**：`latestTurnBoundary(events)`——只看**最新**回合边界。尾行是终态边界
  ⇒ `'terminal'`；尾行是 `user.message` 锚点 ⇒ `'open'`；无边界 ⇒ `'unknown'`。同序号畸形输入
  取锚点（宁可判「未收敛」——随后到达的终帧可自愈；误判「已收敛」会不可逆封存）。
  依赖的内核契约：`turn.unit` 只在回合收敛时出现（内核在写 `turn.completed|failed` 的**同一
  事务**内追加，见 `canonicalUnit.ts` 头注）。
- **守卫单源化**：五个 Map 合并为一条 `SourceTurnRecord`（`clock` / `ledgerTerminal` / `kernel`
  / `stamps` / `clockOnlyStart`），所有写入者走同一组守卫。这消除的是**缺陷类**：本次封存漏守卫
  正是「每个写入者自带一套手写守卫」模式的又一次复发（#204③ 的 elapsed 归零、#213、#217 同源）。
- **封存两道守卫**：内核表态在途则不让位；读发起之后时钟仍观测到帧（`lastTokenAt >
  readStartedAt`）则不让位——读已过时。
- **封存可恢复**：`terminal()` 在「条目已封存但从未写过 live 摘要」时用真终帧补写一次
  （`summaryWritten` 标志；`start` 会重置，故不会跨回合误补）。
- **文档终态不越权**：`documentIsTerminal` 硬覆盖在权威明确表态「在途」时不执行——这是独立于
  journal 判据的第二条塌陷路径。
- **`lastTokenAt` 随帧推进**：此前 `clock.touch` 只改时钟内部条目，快照里的 `lastTokenAt` 停在
  回合起点（文档派生那一路在 append-delta 下也不推进）⇒ 长流式回合里 `idleMs` 无界增长，
  页脚被顶成假「等待响应 / 仍在等待后端响应」。现在随帧写进快照并随权威保留（取较大值，
  单调不回退）。附带收益：页脚多了一条随帧推进的重绘驱动。
- **回合身份归宿主**：`turnEpoch` 每个真实回合恰好 +1（发送入口的乐观投影与 live user 起手），
  渲染层不再本地铸号。最短展示计时的**闩锁保留**（见偏差一节）。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| 在途回合中 bind 切走切回：`generating === true` 且 `summary === null` | 通过（还原旧判据后必红，已实测） |
| 在途回合中 refresh（不带账本）：同上 | 通过（还原旧判据后必红，已实测） |
| 真终帧写的是 `live-monotonic` 摘要而非上一轮 `displayOnly` 值 | 通过 |
| `latestTurnBoundary` 三态 + 边界情形 | 通过（11 例） |
| 长流式回合 `lastTokenAt` 单调推进 | 通过 |
| 会话确有终态且无在途时钟时仍补 `displayOnly` 摘要（#99 兜底不回退） | 通过 |
| 前一回合已完成时 bind 仍恢复 `displayOnly` 摘要（既有行为不回退） | 通过 |
| footer 宿主推进 `turnId` 即开新回合（重抽预设词 + 重开计时） | 通过 |
| 全量前端测试 | `bun run test` → 659 文件 / 5072 passed / 1 skipped / 1 todo |
| `bun run lint` | 0 error（1 条既有 warning：`GatewaySheetView.tsx` 不在本批范围） |
| `bun run check:solid` | exit 0（含 tsc 与全部契约脚本） |
| `bun run check:clippy` | exit 0；6 crate `"added": []` |
| 真机复验 | **未做**——按用户裁定由用户构建带 `--remote-debugging-port=9222` 的实例复验（见未解问题） |

## 测试处置

- **新增**：`src/__tests__/replay/agentWorkbenchSession.indicatorStability.test.ts`（6 例）；
  `src/__tests__/replay/canonicalTurnDuration.test.ts` 内 `#390 latestTurnBoundary` 描述块（6 例）；
  `GenerationFooter.solid.test.tsx` 内宿主 `turnId` 用例（1 例）。
- **修改**：无既有用例的断言被改写。`vitest.setup.ts` 白名单新增一条（B 类 feed 注册噪音，
  与新测试文件同族——按该文件既有登记规程办理）。
- **删除**：无。
- 前三个 `latestTurnBoundary` 用例内含**旧判据对照断言**（同一份行 `hasCanonicalTurnTerminal`
  返回 `true`），把「旧判据回合无关」这一事实钉进测试，避免后来者把两者混用。

## 证据

- commit：`de4d69f9`（代码 + 测试，12 files / +603 −178）；`6d1feb24`（L.md 施工声明）。
- 测试：`bun run test` → `659 passed | 1 skipped (660)`，`5072 passed | 1 skipped | 1 todo (5074)`，exit 0；
  `bun run check:clippy` → exit 0，6 crate `added: []`；`bun run check:solid` → exit 0；`bun run lint` → 0 error。
- 手工验证（护栏反证）：把 `canonicalLatestBoundaryFromRows` 临时还原为回合无关旧判据后，
  `indicatorStability` 的两例核心用例红
  （`AssertionError: 在途回合切回后必须仍为生成态: expected false to be true` /
  `不带账本的重读不得压熄在途生成态`），恢复后 6/6 绿——证明新增用例是真护栏而非描述现状。
- 探针实测读数（临时探针，已删除，结论并入 issue 与 ADR-0029）：

  | 场景 | 结果 |
  | --- | --- |
  | 在途回合中 `bind`（切走再切回） | 塌陷：`generating:false` + 上一轮 `displayOnly` 摘要 |
  | 在途回合中 `refresh` 不带账本 | 塌陷：同上（`elapsedMs:1000, reason:'done'`） |
  | 在途回合中 `refresh` 带账本 `turnInFlight:true` | 正常：`generating:true, summary:null, livenessSource:'kernel'` |
  | 塌陷后真实终帧到达 | 仍是那条陈旧摘要，live 摘要永远写不出来 |

## 与 spec 的偏差

1. **未做「elapsed 所有权整体上移宿主快照」**（spec 第 6 项的后半）。
   原因：`effectiveStartTime` 闩锁是被测试钉住的**载荷**，不是冗余——它防的是 canonical 投影
   的瞬态 `startTime=0` 哨兵（`GenerationFooter.solid.test.tsx:116-171`「同一运行回合收到瞬态
   0 起点时不把经过时间重置为 1s」）。把它换成「直接 `now - props.startTime`」会让 elapsed
   退回 0–1s；而要让宿主保证 `generationStart` 全程稳定，需要 host 在发送入口就给出稳定起点
   （`echo.project` 的 `now()` 已是稳定值，但空态未绑定路径的起点仍由 bind 后的 canonical
   echo 承担）。本批改为**把闩锁的重置触发从本地边沿改为宿主回合身份**——去掉本地铸号与手写
   边沿检测这一层，保留泄漏防护。整体上移需先定宿主起点契约，另行登记。
2. **spec 的验收判据 8 条全部达成**；实际额外做了：`documentIsTerminal` 不越权、
   封存可恢复（终帧补写摘要）——这两条是实现过程中发现的**独立**塌陷/不可恢复路径，
   不属于原判据但同源，一并修掉。

## 未解问题

1. **真机「spinner 和秒数都停」的机制未在实机区分**：摘要视图静止（本轮已修，是我的工作
   解释）与走秒时钟真冻住（未复现）两者读屏相同。已留可区分的诊断：摘要视图显示
   「处理耗时 / 已停止 / 处理失败」，生成中态显示预设词（如「思考中」）。请用户按裁定构建
   带 9222 的实例复验；若为后者（生成中态下 spinner 与秒数同时停住），需要新登记，
   疑因是页面可见性节流或第二条时钟，与本次权威模型无关。
2. **`lastTokenAt` 进门禁的发布代价未实测**：该字段本就在 `displayGateSignature` 内，随帧推进
   会让 0 文本事件也放行发布。语义上正确（它影响 stall 判定），代价由调度器 ≤60/s 合流吸收，
   但未跑 `perf-bench` 取证。
3. **`latestTurnBoundary` 依赖「`turn.unit` 只在回合收敛时落盘」这一内核契约**：若内核将来改成
   一回合多单元行且中途落盘，判据会把在途判成收敛。已在该函数与 `canonicalUnit.ts` 双向标注。

## 并行交集

本批碰过的共享文件（供其他贡献者避让）：

- `src/sheets/agent-workbench/agentWorkbenchSession.ts`、`src/domains/workbench/**`：与
  #375/#376 的声明域重叠（其改动已入库）；本批已按 pathspec 提交，未带入他人 hunk。
- `src/domains/workbench/workbenchProjector.ts`：**未碰**（#389 在途脏文件）。
- `vitest.setup.ts`、`docs/说明书/Pylon-模块维护地图.md`：与 #375/#376 的声明域重叠，
  仅改本批相关行。
- `.agents/L.md`：本批声明条目随该文件单独提交（`6d1feb24`）；**合入后须撤条**。
