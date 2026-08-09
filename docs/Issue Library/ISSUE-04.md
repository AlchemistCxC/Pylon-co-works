# ISSUE-04：重连事务与生命周期快照分离

> 正式编号按 Release 实施依赖关系编排。原问题编号保留在正文中，便于追溯历史记录。

## 当前状态

- 正式编号：`ISSUE-04`
- 原问题编号：`#12`
- 状态：已交付（方案已写入）
- 依赖：ISSUE-03
- 简介：前端 command pending/error 不再覆盖后端 Agent lifecycle 快照，并处理 generation。
- 来源：`docs/release-issues.md`

## 并行执行元数据

```yaml
formal_id: ISSUE-04
status: 已交付（方案已写入）
lane: frontend-contract
priority: P1
stage: consumer
size: M
dependencies: ["02-A", "03-A"]
blocks: ["13-A"]
likely_modify: ["src/components/Settings.tsx", "src/components/settings/", "src/runtimeStore.ts"]
do_not_modify: ["不把 pending 写进 lifecycle snapshot"]
execution_rule: "先完成任务卡依赖，再领取本 Issue 的 ready slice；跨 Lane 变更必须经 contract/checkpoint。"
```

> 此处是 Harness 的机器可读入口。Issue 级状态不等于所有 slice 完成；以 `harness/queue.json`、任务卡和 checkpoint 为准。

## 原始问题记录

原问题编号：#12
严重度：P2
状态：已交付（方案已写入）

问题现象：
点击“重连”后，Settings 会在后端事实事件之外主动写入 reconnecting/error；命令失败或事件交错时，前端最终状态可能覆盖后端真实状态，并保留旧 generation/capabilities，形成例如 `status=error` 但功能层仍认为 connected 的矛盾快照。

触发条件：
1. 当前 Agent 已有状态和 capabilities。
2. 在 Settings 点击重连。
3. 让重连 command 失败，或让后端 `pylon:agent-status` 在 Promise reject/resolve 前后交错到达。
4. 观察最终 `agentStatuses[activeAgent]`。

问题根因：
Settings 把“重连命令正在提交”的 UI transaction state 与“Agent 真实生命周期”写进同一个 `AgentStatus` 对象：点击时本地改成 reconnecting，catch 时本地改成 error。后端本身已经在实际连接事务中广播 reconnecting，并在失败时依据 previous status 计算真实 fallback 状态；前端 catch 的无条件 error 可能晚于权威事件并覆盖它。对象展开还会保留旧 capabilities、generation 和 lastConnectedAt，使拼接后的状态并非任一真实 runtime 快照。

证据等级：L2 源码证据。

相关源代码：
- `G:/Project/prism-desktop/src/components/Settings.tsx:284-294`
  - 重连开始和 catch 都直接调用 `setAgentStatus` 覆写生命周期。
- `G:/Project/prism-desktop/src/components/settings/agentState.ts:18-31`
  - `beginReconnect`/`failReconnect` 直接生成 reconnecting/error 状态。
- `G:/Project/prism-desktop/src-tauri/src/lifecycle/mod.rs:60-95,128-130`
  - 后端会广播 start status，并在连接失败时按 previous status 计算 fallback 后广播；成功广播 connected。
- `G:/Project/prism-desktop/src/agent_runtime.rs:164-170`
  - 连接失败并非一律 error：Connecting/Reconnecting 回到 Disconnected，其他旧状态保持原值。
- `G:/Project/prism-desktop/src/App.tsx:97-101`
  - 后端权威事件与 Settings 本地写入落在同一个 store key，没有来源优先级或序列保护。

解决方案：

方案 A（推荐，生命周期只允许后端快照/事件写入）：
- 改动位置：`Settings.tsx`、`agentState.ts`、可新增 Settings 局部 command state 或 transaction store。
- 具体改法：
  1. 删除 `beginReconnect`/`failReconnect` 对 `agentStatuses` 的写入。
  2. `reconnecting` 本地按钮反馈使用独立 `reconnectPending`；命令错误使用独立 `reconnectCommandError`，不冒充 Agent lifecycle error。
  3. 后端 `pylon:agent-status` 与 `agent_status` 快照是 `agentStatuses` 的唯一生产来源。
  4. command reject 后主动调用一次 `agent_status` 对账；查询失败则保留最后权威状态并显示 command error。
  5. 如需防旧事件覆盖新代际，可按 generation 做单调接收：较低 generation 的事件不得覆盖较高 generation；同 generation 仍按事件到达更新。
- 影响面：Settings 按钮仍即时显示“重连中…”，但 Agent 状态标签只展示后端真实状态；错误提示与运行时错误状态分离。
- 验证方式：
  1. 点击重连后按钮 pending 立即变化，但 agentStatuses 只在后端事件到达时变化。
  2. 后端失败后报告 disconnected/crashed/connected 时，前端不得无条件改成 error。
  3. command reject 与 connected/error 事件按两种顺序交错，最终状态均与 `agent_status` 一致。
  4. 旧 capabilities 不得因对象展开拼到新的错误状态中。
  5. generation 较旧的迟到事件不得覆盖新 client 状态。
- 风险与取舍：按钮 pending 与状态标签短时间可能分别显示“请求重连中”和旧 lifecycle，这是事实上的两个维度，应在 UI 文案中明确，而不是合并成伪状态。

重构方案：
将前端 Agent 状态分为：
```ts
interface AgentRuntimeSnapshot {
  lifecycle: AgentConnectionStatus
  generation: number
  capabilities: unknown | null
  lastConnectedAt?: string | number
  recentError?: string
}

interface AgentCommandState {
  switchPending?: string
  reconnectPending: boolean
  commandError?: string
}
```
`AgentRuntimeSnapshot` 只接受后端输入，`AgentCommandState` 只描述 UI 操作事务，禁止互相覆盖。

---

### 源码复核后的实施细化

1. `Settings.tsx` 删除 `setAgentStatus(...beginReconnect/failReconnect...)`，新增本地 `reconnectPending` 与 `reconnectCommandError`。
2. `agentStatuses` 的写入口只保留 `pylon:agent-status` listener 与 `agent_status` 快照；若 command reject，立即查询快照对账，查询失败才保留旧权威值。
3. generation 规则先在后端确认：若 generation 是每次替换单调递增，则前端丢弃更低代际；若某些事件无 generation，需按事件来源和 request/session 时间线处理，不能强行比较 undefined。
4. 重点覆盖“本地 catch 晚到”“connected 事件早到”“旧 capabilities 展开残留”三种交错。

可行性：高。现有问题集中在 Settings 本地写入与后端事件共用一个 store key。

---


## 逐项验收清单

### 6.5 问题 #12：重连 command state 与 runtime snapshot 分离

#### 等级 1：测试通过

| 相关功能 | 验收行为表现 | 验收地址 | 结果 |
|---|---|---|---|
| reconnect transaction | 点击重连只更新 `reconnectPending`，不直接写 `agentStatuses` | `src/components/Settings.tsx`、agent command state 测试 | [ ] |
| 失败后快照对账 | command reject 后查询 `agent_status`；查询失败保留最后权威状态 | Settings/agent transaction Vitest | [ ] |
| 事件乱序与 generation | connected 事件早到、catch 晚到、旧 generation 迟到均不覆盖新快照 | runtimeStore/Agent status reducer tests | [ ] |

#### 等级 2：前端网页验收通过（仅限前端）

| 相关功能 | 验收行为表现 | 验收地址 | 结果 |
|---|---|---|---|
| 按钮 pending 与状态标签分离 | 点击重连后按钮显示“重连中”，状态标签保持最后权威状态，直到 mock event 到达 | `http://localhost:5173/` → Settings → Agent 与连接/Agent | [ ] |
| command error | mock command reject 后显示独立操作错误，不把状态标签强制改成 error | `http://localhost:5173/` → Settings Agent 区域 | [ ] |

#### 等级 3：真实应用验收通过

| 相关功能 | 验收行为表现 | 验收地址 | 结果 |
|---|---|---|---|
| 真实重连成功 | 后端依次广播 reconnecting→connected，前端没有本地伪状态覆盖 | 真实应用 → Settings → Agent → 重连；Runtime Sheet | [ ] |
| 真实重连失败 | 后端最终报告 disconnected/crashed/原状态时，前端展示与 `agent_status` 一致，另行显示 command error | 真实应用 → 使 ACP 启动失败后重连 | [ ] |

## 施工日志

| 2026-08-09 | 拍板决策同步 | 已将本轮已确认的产品决策与当前实施成熟度写入“已拍板决策”。未形成措施的内容明确标注为仅有决策。 | 关联未决策项见 `未决策项.md` |
| 日期 | 类型 | 记录 | 证据/备注 |
|---|---|---|---|
| 2026-08-09 | 文档拆分 | 从 `docs/release-issues.md` 拆分为 `ISSUE-04`；保留原问题记录、追加调查、修复记录与三级验收内容。 | 本文件生成于 Issue Library 初始化 |
|  |  |  |  |


## 本轮源码核验与可验收子任务（2026-08-09）

### 逐条源码核验矩阵

| 原主张 | 判定 | 当前源码证据 | 方案修正 |
|---|---|---|---|
| reconnect command state 覆盖权威 lifecycle | 属实 | `src/components/Settings.tsx:287,293` 直接 `setAgentStatus`；`src/runtimeStore.ts:100` 共用同一 map | pending/error 改成本地 command state；agentStatuses 只收后端事件/快照。 |
| generation 已完整防迟到覆盖 | 未能证明 | 前端写入口未在 `setAgentStatus` 层校验 generation | 冻结 generation 比较规则，补旧事件晚到/新事件早到交错测试。 |


> 本节是本轮对当前源码的增量审计与执行切分。原编号只用于追溯；以下 task id 才是 Harness v2 的执行单位。

### 核验结论
- ✅ 原问题方向与当前相关源码结构一致；本轮将方案拆成独立 producer/consumer/test 子任务，最终验收仍需按证据等级执行。

### 子任务清单

| Task ID | 类型 | 归属 | 依赖 | 验收标准 | 最低证据 |
|---|---|---|---|---|---|
| `I04-A-FE-01` | FE | A | I03-A-FE-01 | 拆分 reconnect command state 与 lifecycle snapshot；pending/error 不写入 agentStatuses；command reject 后对账权威快照。 | L1 |
| `I04-A-BE-01` | BE | A | I03-A-FE-01 | 校验 runtime generation 迟到事件收敛；旧 generation 事件不能覆盖新 runtime；快照与事件语义一致。 | L1 |
| `I04-A-TEST-01` | TEST | S | I04-A-FE-01, I04-A-BE-01 | 重连交错回归；覆盖 catch 晚到、connected 早到、旧 capabilities 残留。 | L1 |

### 本轮施工日志

| 2026-08-09 | 源码核验 + 任务切分 | 已对照当前源码建立证据结论；按一张卡一个独立可验收结果切分，B 视觉任务仅在基座/契约明确后进入。 | `docs/Issue Library/harness-v2/` |
