# ISSUE-05：Agent 切换后状态快照对账

> 正式编号按 Release 实施依赖关系编排。原问题编号保留在正文中，便于追溯历史记录。

## 当前状态

- 正式编号：`ISSUE-05`
- 原问题编号：`#9`
- 状态：已交付（方案已写入）
- 依赖：ISSUE-04
- 简介：切换成功后以 agent_status 末尾快照对账，避免 resetAll 清掉目标状态。
- 来源：`docs/release-issues.md`

## 并行执行元数据

```yaml
formal_id: ISSUE-05
status: 已交付（方案已写入）
lane: frontend-contract
priority: P1
stage: transaction
size: M
dependencies: ["02-A", "03-A", "04-A"]
blocks: []
likely_modify: ["src/application/transactions/", "src/runtimeStore.ts"]
do_not_modify: ["不重新引入 active_agent 业务路由"]
execution_rule: "先完成任务卡依赖，再领取本 Issue 的 ready slice；跨 Lane 变更必须经 contract/checkpoint。"
```

> 此处是 Harness 的机器可读入口。Issue 级状态不等于所有 slice 完成；以 `harness/queue.json`、任务卡和 checkpoint 为准。

## 原始问题记录

原问题编号：#9
严重度：P1
状态：已交付（方案已写入）

问题现象：
Agent 切换成功后，后端已经连接到目标 Agent，但前端可能丢失该 Agent 的真实生命周期状态；titlebar 状态灯变灰，发送/附件能力 gate 可能进入未连接态。目标 Agent 原本已连接时，该问题稳定发生；新连接目标还存在事件与 Promise resolve 的时序竞争。

触发条件：
1. 当前 active Agent 为 A。
2. 目标 Agent B 已有 connected runtime，或切换过程中后端广播了 B 的 connected 状态。
3. 在设置页执行切换到 B。
4. 切换 command 成功返回后观察 `runtimeStore.agentStatuses`、titlebar 状态灯和 InputBar 能力 gate。

问题根因：
Agent 切换事务在 `switch_agent` command 成功返回后无条件调用 `runtimeStore.resetAll()`；该 action 会清空整个 `agentStatuses`。后端的 `connecting`/`connected` 事件可能已在 command resolve 前到达并写入 store，随后又被前端清除。若目标 runtime 原本已经 Connected，后端 switch 快路径只更新 active agent、停止旧 runtime 后直接返回，不补发目标状态事件，因此清空后没有增量事件可以恢复。

证据等级：L2 源码证据。

相关源代码：
- `G:/Project/prism-desktop/src/application/transactions/switchAgentTransaction.ts:21-36`
  - `await deps.switchAgent(agentId)` 成功后依次执行 `resetRuntime()`、`setActiveAgent()`，没有重新查询状态。
- `G:/Project/prism-desktop/src/components/Settings.tsx:271-280`
  - Settings 将 `resetRuntime` 接为 `useRuntimeStore.getState().resetAll()`。
- `G:/Project/prism-desktop/src/runtimeStore.ts:102-110`
  - `resetAll()` 明确把 `agentStatuses` 重置为 `{}`。
- `G:/Project/prism-desktop/src-tauri/src/lifecycle/mod.rs:289-296`
  - 非 active 目标已经 Connected 时，后端只更新 `active_agent`、停止旧 runtime 后直接 `return Ok(())`，不发送 `pylon:agent-status`。
- `G:/Project/prism-desktop/src-tauri/src/lifecycle/mod.rs:304-320`
  - 普通连接路径会广播 connecting/connected，但事件可能早于 command Promise resolve，被随后执行的 `resetAll()` 清除。
- `G:/Project/prism-desktop/src/App.tsx:97-101`
  - Agent 状态事件直接写入同一个 `runtimeStore.agentStatuses`，因此与切换后的清空存在竞争。

解决方案：

方案 A（推荐，切换后以快照对账，Agent 状态不参与会话 runtime 清空）：
- 改动位置：`switchAgentTransaction.ts`、`runtimeStore.ts`、`Settings.tsx`，复用 `agentClient.agentStatus()`。
- 具体改法：
  1. 将 `resetAll()` 拆为会话运行时清理与 Agent 状态清理两个 action，例如 `resetSessionRuntime()` 只清 `sessionConfig/sessionModes/sessionLiveStats/liveGenerating/permission`，不清 `agentStatuses`。
  2. switch 成功后先设置 active Agent，再调用 `agent_status` 获取目标 Agent 的权威快照，并通过 `normalizeAgentStatus` 写入对应 id。
  3. 状态事件继续作为增量来源；command 快照作为切换事务末尾的最终对账，消除事件早到/晚到竞争。
  4. 若快照查询失败，只报告诊断错误，不把目标状态伪造为 connected/error；保留已收到的事件值或 unknown 状态。
- 影响面：不改变后端 Agent 切换和进程生命周期，只改变前端切换后的 runtime 清理边界与状态同步时序。
- 验证方式：
  1. A→已连接 B：切换后 B 状态保持 connected，generation/capabilities 与 `agent_status` 一致。
  2. A→未连接 B：记录 connecting→connected，最终不得被清空为无状态。
  3. 模拟 `pylon:agent-status` 在 command resolve 前、后分别到达，最终快照一致。
  4. 切换后旧会话 live stats 被清理，但 Agent 状态仍存在。
  5. titlebar、Sheet tab、Settings、InputBar 同时读取到同一目标状态。
- 风险与取舍：增加一次很小的 IPC 查询；相比依赖事件时序更可靠。拆分 `resetAll` 时需核对权限 pending 是否应随 Agent 切换清理，推荐清理会话/权限状态但保留 Agent 状态表。

方案 B（仅后端补发，不推荐单独采用）：
- 改动位置：`src-tauri/src/lifecycle/mod.rs` 的全部 switch 成功出口。
- 具体改法：在目标已连接快路径和普通成功路径末尾统一广播当前状态。
- 影响面：增加状态事件，不改变连接行为。
- 风险与取舍：仍无法消除前端 `resetAll()` 与事件的竞争；只能作为事件完整性增强，不能替代方案 A。

---

### 源码复核后的实施细化

1. 将 `runtimeStore.resetAll()` 拆成 `resetSessionRuntime()` 与必要的 permission 清理；明确不清 `agentStatuses`。
2. 扩展 `SwitchAgentDeps` 注入 `fetchAgentStatus`/`applyAgentStatus`，事务顺序改为：后端 switch 成功 → `setActiveAgent` → 查询目标快照 → 写入目标 status → dispatch switched。
3. 后端 `lifecycle::switch_agent` 的“目标已 connected 快路径”当前直接 return，建议补广播作为后端完整性增强，但不能代替前端末尾对账。
4. 对 command resolve 前后到达的 status event 做测试，最终以快照为准；失败时不伪造 connected。

可行性：高，且 #10～#12 完成后改动边界清晰。

---


## 逐项验收清单

### 6.6 问题 #9：Agent 切换后状态快照对账

#### 等级 1：测试通过

| 相关功能 | 验收行为表现 | 验收地址 | 结果 |
|---|---|---|---|
| runtime reset 边界 | `resetSessionRuntime()` 清会话 live state/permission，但保留 `agentStatuses` | `src/runtimeStore.ts` Vitest | [ ] |
| switch 事务顺序 | switch success→set active→fetch status→apply status→dispatch switched | `src/application/transactions/switchAgentTransaction.ts` tests | [ ] |
| 事件竞争 | status event 在 Promise resolve 前后到达，最终均以快照对账且不变 unknown | switch transaction/integration tests | [ ] |

#### 等级 2：前端网页验收通过（仅限前端）

| 相关功能 | 验收行为表现 | 验收地址 | 结果 |
|---|---|---|---|
| A→已连接 B | mock 切换完成后 B 的灯、标签、发送 gate 保持 connected，不出现短暂全灰终态 | `http://localhost:5173/` → Settings/Overview 切换 Agent | [ ] |
| 会话状态清理 | 切换后旧 Session spinner/token/permission 清空，但两 Agent 的 status 记录仍可展示 | `http://localhost:5173/` → Agent Sheet + titlebar | [ ] |

#### 等级 3：真实应用验收通过

| 相关功能 | 验收行为表现 | 验收地址 | 结果 |
|---|---|---|---|
| 已连接快路径 | 切到已 connected 的目标 runtime 后，titlebar 与 InputBar 仍是 connected | 真实应用 → Settings/Overview 切换 Peri/Hermes | [ ] |
| 新连接路径 | connecting→connected 事件即使早于 command 返回也不被清空 | 真实应用 → 启动未连接 Agent 后切换；Runtime Sheet | [ ] |
| 快照失败 | `agent_status` 对账失败时显示 unknown/诊断错误，不伪造成功 | 真实应用 → 故障注入后的切换 | [ ] |

## 施工日志

| 2026-08-09 | 拍板决策同步 | 已将本轮已确认的产品决策与当前实施成熟度写入“已拍板决策”。未形成措施的内容明确标注为仅有决策。 | 关联未决策项见 `未决策项.md` |
| 日期 | 类型 | 记录 | 证据/备注 |
|---|---|---|---|
| 2026-08-09 | 文档拆分 | 从 `docs/release-issues.md` 拆分为 `ISSUE-05`；保留原问题记录、追加调查、修复记录与三级验收内容。 | 本文件生成于 Issue Library 初始化 |
|  |  |  |  |


## 本轮源码核验与可验收子任务（2026-08-09）

### 逐条源码核验矩阵

| 原主张 | 判定 | 当前源码证据 | 方案修正 |
|---|---|---|---|
| switch 事务会清空目标状态 | 属实 | `src/runtimeStore.ts:102-108` 的 `resetAll` 清 `agentStatuses`；Settings/Overview 调用该 reset | 拆分 session runtime reset；switch 成功后 fetch/apply 目标 agent_status。 |
| 只补后端广播即可解决 | 不属实 | `src/App.tsx:90-100` 已有快照和 listener 两条写入链 | 前端事务末尾快照对账是必需；后端广播只是完整性增强。 |


> 本节是本轮对当前源码的增量审计与执行切分。原编号只用于追溯；以下 task id 才是 Harness v2 的执行单位。

### 核验结论
- ✅ 原问题方向与当前相关源码结构一致；本轮将方案拆成独立 producer/consumer/test 子任务，最终验收仍需按证据等级执行。

### 子任务清单

| Task ID | 类型 | 归属 | 依赖 | 验收标准 | 最低证据 |
|---|---|---|---|---|---|
| `I05-A-FE-01` | FE | A | I04-A-FE-01 | 切换事务末尾 agent_status 对账；switch 成功后 fetch/apply 目标快照；reset 不清 agentStatuses。 | L1 |
| `I05-A-TEST-01` | TEST | S | I05-A-FE-01 | 切换状态竞态测试；覆盖事件早到/晚到和查询失败，不伪造 connected。 | L2 |

### 本轮施工日志

| 2026-08-09 | 源码核验 + 任务切分 | 已对照当前源码建立证据结论；按一张卡一个独立可验收结果切分，B 视觉任务仅在基座/契约明确后进入。 | `docs/Issue Library/harness-v2/` |
