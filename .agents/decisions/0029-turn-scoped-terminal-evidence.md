# ADR-0029 回合终态证据按回合作用域判定（活性权威唯一解析）

> 入库保留。编号顺延，按编号命名。
> 产出路径：`.agents/decisions/0029-turn-scoped-terminal-evidence.md`

- **日期**：2026-09-27
- **状态**：已采用（用户于 2026-09-27 就「全量重构」拍板；本 ADR 承接该决定中涉及权威模型的那一半）

## 背景与约束

ADR-0017 把「这个会话现在有没有在途回合」的事实上移到内核（`livenessSource: 'kernel'`），
并保留 `'clock'`（本进程回合时钟）与 `'document'`（无主机夹具）两级降级。

本次（#390）暴露的是**另一处**权威缺口：**「本回合是否已收敛」的 journal 侧判据一直是回合无关的**。

`hasCanonicalTurnTerminal()`（`canonicalTurnDuration.ts:77`）返回的是「rows 里**曾经**出现过
`turn.completed|turn.failed|turn.unit`」。它被 `publishFoldedDocument` 当作「**当前回合**已收敛」
使用，于是只要该会话历史上完成过任何一个回合，任何一次 canonical 重读（bind / refresh /
草稿提交 / 被拒回滚）都可能把在途回合判成已收敛：

1. `settleFromDocument` 封存回合时钟——而它是当时**唯一**不看内核权威的时钟写入者
   （`reconcile` 与 `activeUnsettledClock` 都遵守「内核说在途则让位」）；
2. 封存后 `touch`/`reconcile`/`terminal` 的 live 摘要写入全部 no-op，**误封不可逆**；
3. 于是页脚显示上一轮的 `displayOnly` 摘要：耗时是静态值（不走秒）、spinner 停，
   真实终帧到达也改不回来。

实测读数（单测注入确定性链路）：在途回合中 `bind` → `{generating:false, summary:{elapsedMs:1000,
reason:'done', displayOnly:true}}`；同一场景带内核账本 `turnInFlight:true` 则正常。即
ADR-0017 的权威设计有效，**但四个 canonical 重读入口里只有一个接了账本**
（`bind`/`onDraftCommit`/`resolveDraft`/`reloadFromJournal` 都没接）。

约束：

- 不得反推（缺证据即 `unknown`，宁可判「未收敛」——随后到达的终帧可自愈；误判「已收敛」
  会不可逆封存）。
- 必须保住 ADR-0017 的兼容矩阵：新前端 + 旧内核仍须永久保持 `'clock'` 权威，不得由前端
  自造内核表态。
- `turn.unit` 只在回合收敛时出现（内核在写 `turn.completed|failed` 的**同一事务**内追加），
  故可作为终态边界。

## 备选方案

| 方案 | 否决理由 |
| --- | --- |
| A · 给 `settleFromDocument` 补上内核守卫即可 | 不够。①journal 侧判据本身仍是错的，只要内核未表态（旧内核、尚未 refresh）塌陷照旧；②没有解决"读早于在途事实"这一竞态。 |
| B · 四个读入口各自补传账本 | 治标：`bind` 手头没有账本快照（冷装载路径），仍会塌陷；且把「活性输入一致」寄托在每个调用者接线（本次缺陷正是"某个写入者忘带守卫"）。 |
| C · 每层各加一条新鲜度/权威守卫 | 已有五张 Map + 四层融合各带手写守卫，本次缺陷就是该模式第 N 次复发（#204③ 的 elapsed 归零、#213、#217 同源）。 |
| **D · 判据回合作用域化 + 守卫单源化**（采用） | — |

## 决定

1. **journal 侧终态证据按回合作用域判定**（新 `latestTurnBoundary(events): 'terminal' | 'open' | 'unknown'`）：
   只看**最新**回合边界——尾行是终态边界 ⇒ `'terminal'`；尾行是 `user.message` 锚点 ⇒ `'open'`；
   无边界 ⇒ `'unknown'`。同序号畸形输入取锚点（宁可未收敛）。
   `hasCanonicalTurnTerminal` 保留原语义，但文档明确**不得**用于"当前回合是否收敛"。

2. **活性写入守卫单源化**：回合时钟五个 Map 合并为一条 per-source 记录，所有写入者共用同一组
   守卫（内核让位规则、封存新鲜度规则）。`settleFromDocument` 补齐两道守卫：
   内核表态在途则不让位；读发起之后时钟仍观测到帧则不让位（读已过时）。

3. **封存可恢复**：`terminal()` 在「条目已封存但从未写过 live 摘要」时用真终帧补写一次，
   消除"误封即本回合不可恢复"。

4. **文档终态不得越过活性权威**：`mergeWorkbenchRuntimeSnapshot` 的 `documentIsTerminal` 硬覆盖
   在权威（kernel/clock）明确表态「在途」时不执行。

5. **`lastTokenAt` 随帧推进**并随权威保留（不只 `generationStart`）：「最近一次收到帧」是
   stall 判定的分子，此前只在时钟内部更新、快照里停在回合起点 ⇒ 长流式回合被顶成假
   「等待响应 / 仍在等待后端响应」。

6. **回合身份由宿主给出**：渲染层不再本地铸号（`generation-N`），改用宿主 `turnEpoch`
   （每个真实回合 +1，进程内单调、不落 wire）。最短展示计时的闩锁保留——它防的是 canonical
   投影的瞬态 `startTime=0` 哨兵。

## 后果

- **正面**：切页/重读不再能把在途回合压成上一轮摘要（三症状的同一根因）；误封可被真终帧恢复；
  「新写入者忘带守卫」这一类缺陷在结构上被消除（守卫只有一份实现，五 Map 合一）；假 stalled
  消失。
- **负面 / 代价**：新增一个判据函数（`latestTurnBoundary`）与一个入参（`readStartedAt`）；
  `lastTokenAt` 进入 `displayGateSignature` 的既有字段后，0 文本事件也会放行发布——这是**正确**的
  （它影响 stall 判定），代价由调度器 ≤60/s 合流吸收。
- **风险**：`latestTurnBoundary` 依赖「`turn.unit` 只在回合收敛时出现」这一内核契约。若内核
  将来改成一回合多单元行且中途落盘，该判据会把在途判成收敛。防线：该契约写在
  `canonicalUnit.ts` 头注，判据函数处亦标注来源；真机验收场景含长回合。
- **未做**（记录在案，不属本 ADR 决定范围）：把 elapsed 的**所有权**整体上移到宿主快照。
  代价是 60Hz 更新会否掉 display-gate 的抑制收益；本批只把闩锁的**重置触发**改为宿主回合身份。

## 证据

- 根因：`src/domains/events/canonicalTurnDuration.ts`（`hasCanonicalTurnTerminal` 回合无关语义）、
  `src/sheets/agent-workbench/agentWorkbenchSession.ts`（`publishFoldedDocument` 的
  `hasTerminalEvidence`、`bind` 的 `withLedgerEvidence: false`）、
  `src/sheets/agent-workbench/agentWorkbenchTurnClock.ts`（`settleFromDocument` 缺内核守卫）。
- 回归护栏：`src/__tests__/replay/agentWorkbenchSession.indicatorStability.test.ts`（6 例，
  其中 2 例在还原旧判据后必红——已实测）、
  `src/__tests__/replay/canonicalTurnDuration.test.ts`（`latestTurnBoundary` 11 例）。
- 前序：ADR-0017（内核活性权威）、`.agents/records/issue-99-acp-base-comm-reliability.md`、
  `.agents/records/issue-213-*`、`.agents/records/issue-217-turn-liveness-kernel-authority.md`。
