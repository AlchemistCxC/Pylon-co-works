# Handoff: I05-A-TEST-01

- 角色/模式：开阳（S）/ `longrun-a`
- 类型：TEST；依赖：I05-A-FE-01（已合 main，merge `3a89a23`）
- Base commit：`74d2621`（main HEAD，含 I05-A-FE-01 依赖合并）
- 证据等级：**L2**（源码证据：真实 test/lint/build/diff-check 输出 + 新增竞态测试）
- 状态：`review_pending`，本卡证据交付；done 由人工（宫木云）验收

## 目标与验收

- objective：切换状态竞态测试
- AC-1：切换状态竞态测试；覆盖事件早到/晚到和查询失败，不伪造 connected（address `docs/Issue Library/ISSUE-05.md`，等级 1「事件竞争」行 + 方案 A 验证方式 3）

## 新增测试

`src/application/transactions/__tests__/switchAgentRace.test.ts`（6 用例，store-backed 集成式，接线对齐 Settings.tsx / OverviewSheetView.tsx / App.tsx listener）：

| 用例 | 覆盖点 | 对应验收 |
|---|---|---|
| 事件早到：switch 挂起期间到达的 connected 事件不被 reset 清空，最终以快照对账且不变 unknown | 事件在 command resolve 前写入 agentStatuses，`resetAll()`（→resetSessionRuntime）只清会话 runtime 不清 agentStatuses，末尾快照对账收敛 | AC-1 事件早到 / ISSUE-05 方案 A 验证 3 |
| 事件在快照查询挂起期间到达：末尾快照以对账为准收敛，不回退 unknown | fetch 挂起期间事件到达，最终以快照 gen 为准 | AC-1 事件早到 |
| 事件晚到：快照 apply 后到达的低代次事件被 generation guard 拒绝，保持 connected | 晚到旧事件 gen 4 < 快照 gen 5 → `shouldAcceptAgentStatus` 拒绝，不回退 | AC-1 事件晚到 / ISSUE-05 方案 A 验证 3 |
| 事件晚到：快照后到达的新代次事件被接受，状态单调收敛 | 晚到新事件 gen 6 > 快照 gen 5 → 接受 | AC-1 事件晚到 |
| 查询失败：不伪造 connected，切换仍成功，状态保持 unknown 并报告对账错误 | fetch 抛错 → reportError('对账 Agent 状态')，result ok，agentStatuses 无该 Agent → selectAgentStatus 归 unknown | AC-1 查询失败 / ISSUE-05 方案 A 改法 4 |
| 查询失败：早到 connecting 事件保留原值，不被清空也不被伪造为 connected | fetch 抛错但事件已到 → 保留 connecting 原值，不伪造 connected | AC-1 查询失败 / 方案 A 改法 4 |

既有测试覆盖核对（ISSUE-05 等级 1 验收行）：
- `resetSessionRuntime()` 清会话 live state/permission 但保留 agentStatuses → 已有 `src/components/settings/__tests__/runtimeReset.test.ts`（通过）。
- switch 事务顺序 switch success→set active→fetch status→apply status→dispatch switched → 已有 `switchAgentTransaction.test.ts`（通过）。

## 验证命令执行结果（task yaml commands.focused / broader，逐条真实输出）

| 命令 | 结果 | 证据等级 | 真实输出摘录 |
|---|---|---|---|
| `npm run test`（focused） | 通过 | L2 | `Test Files 52 passed (52) / Tests 285 passed (285)`（含新增 6 用例；45 files/213 → 52/285 为本卡新增 + 其他已合卡的用例增长） |
| `npx vitest run src/application/transactions/__tests__/switchAgentRace.test.ts` | 通过 | L2 | `Test Files 1 passed (1) / Tests 6 passed (6)` |
| `npm run lint` | 通过 | L2 | `eslint src/` 退出 0（`ESLINT_EXIT=0`，含新测试文件无告警） |
| `npm run build` | 通过 | L2 | `tsc -b && vite build` ✓ built in 5.56s；tsc 类型检查通过（含新测试文件） |
| `git diff --check` | 通过 | L2 | 退出 0，无 whitespace error |
| `python docs/Issue Library/harness/scripts/validate_harness.py` | 失败（非本卡引入） | — | 报 I08-A-BE-01.md:7 / I08-A-FE-01.md:50 / I11-A-BE-01.md:19 三处绝对路径，均为他卡 handoff 既有问题，本卡文件不在其列 |

## 竞态结论（AC-1）

- 事件早到：切换事务 `resetAll` 只清会话 runtime，`agentStatuses` 保留 → 早到事件与末尾 agent_status 快照对账后收敛，**不变 unknown**（用例 1、2 通过）。
- 事件晚到：晚到事件经 `shouldAcceptAgentStatus` 代次单调守卫，低代次旧事件被拒、新代次事件被收，**不回退 unknown**（用例 3、4 通过）。
- 查询失败：`fetchAgentStatus` 抛错只 `reportError` 诊断，不伪造 connected；切换仍成功；无事件时归 unknown、有早到事件时保留原值（用例 5、6 通过）。
- 未改动任何业务实现代码；仅新增测试文件（scope.allow 内）。

## 工作区

```text
?? src/application/transactions/__tests__/switchAgentRace.test.ts
!! docs/Issue Library/harness/handoffs/I05-A-TEST-01.md   （/docs/ 在 .gitignore 内，为内部协作文档不入库）
```

（node_modules/、dist/ 由 npm install / build 产生，gitignore 覆盖不显示。）

## 阻塞与失败证据

- `validate_harness.py` 三处绝对路径失败来自 I08-A-BE-01 / I08-A-FE-01 / I11-A-BE-01 的 handoff（他卡范围），**不在本卡 scope，未触碰**；本卡文件无绝对路径。
- 首次跑新测试文件时 1 用例因 mock switchAgent 覆盖丢失 call 记录断言失败，已修正（记录 push 移到 override 内），随后 6/6 全绿。此为本卡开发过程证据，非最终状态。
- 等级 2（前端网页验收 localhost:5173）与等级 3（真实应用）不在本卡证据要求内（required_level L2 源码证据）；本卡只覆盖等级 1 测试通过面。

## 下一条确定动作

1. 玉衡审查本卡测试与 handoff；通过后由集成流程合并 main。
2. 等级 2/3 验收由人工在浏览器/真实应用复验（mock 切换 A→已连接 B、故障注入快照失败）。
3. `validate_harness.py` 的他卡绝对路径问题建议另行派单清理。

## 不得假定

- 本卡 L2 只证明等级 1 测试面（Vitest 源码证据）通过；不构成等级 2 前端网页验收或等级 3 真实应用验收。
- 竞态收敛依赖 `shouldAcceptAgentStatus` 代次单调守卫与 `resetSessionRuntime` 保留 agentStatuses；若未来事件 payload 无 generation，顺序不可比时仍按到达序接受（既有 `agentStatusGeneration.test.ts` 覆盖）。
