# ISSUE-03：Agent unknown 状态统一

> 正式编号按 Release 实施依赖关系编排。原问题编号保留在正文中，便于追溯历史记录。

## 当前状态

- 正式编号：`ISSUE-03`
- 原问题编号：`#11`
- 状态：已交付（方案已写入）
- 依赖：ISSUE-02
- 简介：统一无权威快照时的 unknown 语义，消除 Settings、titlebar、Sheet、InputBar 状态矛盾。
- 来源：`docs/release-issues.md`

## 并行执行元数据

```yaml
formal_id: ISSUE-03
status: 已交付（方案已写入）
lane: frontend-contract
priority: P1
stage: consumer
size: S
dependencies: ["02-A"]
blocks: []
likely_modify: ["src/components/settings/", "src/domains/agent/"]
do_not_modify: ["不修改后端 lifecycle"]
execution_rule: "先完成任务卡依赖，再领取本 Issue 的 ready slice；跨 Lane 变更必须经 contract/checkpoint。"
```

> 此处是 Harness 的机器可读入口。Issue 级状态不等于所有 slice 完成；以 `harness/queue.json`、任务卡和 checkpoint 为准。

## 原始问题记录

原问题编号：#11
严重度：P2
状态：已交付（方案已写入）

问题现象：
同一个“尚未取得 Agent 状态”的时刻，Settings 显示“已连接”，titlebar 显示全灰，Agent Sheet tab 显示 disconnected，InputBar 功能 gate 也按未连接处理。

触发条件：
1. `runtimeStore.agentStatuses[activeAgent]` 缺失，例如冷启动状态查询失败、切换后状态被清空或 listener 尚未送达。
2. 同时查看 Settings、titlebar、Agent tab 和 InputBar。

问题根因：
`normalizeAgentStatus` 在 payload 缺少 status 且 crashed 不为 true 时默认返回 connected；Settings 用 `normalizeAgentStatus({}, activeAgent)` 作为缺失状态 fallback。其他消费者没有使用该 fallback：titlebar 用空字符串，Sheet tab 用 disconnected，能力 hook 用 undefined。缺失状态没有统一语义，且 Settings 的默认 connected 属于无事实依据的乐观伪状态。

证据等级：L2 源码证据。

相关源代码：
- `G:/Project/prism-desktop/src/components/settings/agentTypes.ts:36-53`
  - payload.status 缺失时默认 connected。
- `G:/Project/prism-desktop/src/components/Settings.tsx:215-235,488-495`
  - Settings 对缺失状态调用 `normalizeAgentStatus({}, activeAgent)` 并展示状态标签。
- `G:/Project/prism-desktop/src/workspace-sheets/WorkspaceTitlebar.tsx:48-66`
  - 缺失状态传空字符串，状态灯为 off。
- `G:/Project/prism-desktop/src/workspace-sheets/SheetTabStrip.tsx:19-23`
  - active Agent 缺失状态回退 disconnected；非 active 回退 inactive。
- `G:/Project/prism-desktop/src/infrastructure/acp/useAgentCapabilities.ts:12-16`
  - 缺失状态直接传 undefined，能力层按未连接处理。

解决方案：

方案 A（推荐，定义统一 unknown 状态）：
- 改动位置：`agentTypes.ts`、Settings/titlebar/SheetTabStrip/statusLight、相关测试。
- 具体改法：
  1. 给 `AgentConnectionStatus` 增加 `unknown`，表示 active Agent 尚未取得权威快照；`inactive` 只表示非 active Agent。
  2. `normalizeAgentStatus` 在 status 缺失且 crashed 不为 true 时返回 unknown，不得默认 connected。
  3. 建立单一 selector，例如 `selectAgentStatus(agentId, activeAgent, statuses)`：非 active → inactive；active 且无快照 → unknown；有快照 → 后端状态。
  4. Settings、titlebar、Sheet tab、capability hook 全部使用该 selector，不各自写 fallback。
  5. unknown 使用明确文案“状态未知/等待状态”，视觉为灰；功能写操作保守禁用，但不得显示为后端明确 disconnected。
- 影响面：只统一缺失状态的展示和 gate，不改变后端生命周期。
- 验证方式：
  1. 无状态快照时四个消费者都得到 unknown。
  2. 非 active Agent 统一得到 inactive。
  3. 后端 connected/disconnected/error 事件到达后全部同步更新。
  4. 非法 status 字符串仍归 error，并显示“未知 Agent 状态”。
- 风险与取舍：新增一个前端状态值，需要补 CSS/标签测试；收益是消除“Settings 假绿、其他位置全灰/红”的矛盾。

方案 B（最小改动）：
- 缺失状态统一使用 disconnected。
- 风险与取舍：实现简单，但把“尚未查询到”伪装成“后端已确认断开”，诊断真实性较差，不推荐。

---

### 源码复核后的实施细化

1. `AgentConnectionStatus` 增加 `unknown`，同步更新 `knownStatus`、`statusLabel`、灯光映射、Sheet tab 文案和测试。
2. 新增 `selectAgentStatus(agentId, activeAgent, statuses)`，active 且无快照返回 unknown，非 active 返回 inactive；Settings 不再调用 `normalizeAgentStatus({}, activeAgent)` 伪造 connected。
3. `agent_status` command 返回失败时保持 unknown，并显示“状态查询失败”诊断；不得把查询失败转换成 disconnected。
4. 以同一 selector 驱动 titlebar、Settings、SheetTabStrip、InputBar，做缺失/非法/后端事件到达三类测试。

可行性：高，但属于跨组件契约迁移，不能只改 `agentTypes.ts`。

---


## 逐项验收清单

### 6.4 问题 #11：统一 unknown 状态

#### 等级 1：测试通过

| 相关功能 | 验收行为表现 | 验收地址 | 结果 |
|---|---|---|---|
| status normalize | payload 缺少 status 时返回 `unknown`，不再默认 connected | `src/components/settings/agentTypes.ts` Vitest | [ ] |
| 单一 selector | active 无快照→unknown；非 active→inactive；非法字符串→error | Agent status selector 测试文件 | [ ] |
| 全消费方一致性 | Settings、titlebar、SheetTabStrip、capability hook 对同一输入得到同一语义 | 对应组件/contract tests | [ ] |

#### 等级 2：前端网页验收通过（仅限前端）

| 相关功能 | 验收行为表现 | 验收地址 | 结果 |
|---|---|---|---|
| 无快照首帧 | Settings、titlebar、Agent tab 同时显示“状态未知/等待状态”，不出现假绿或明确断开 | `http://localhost:5173/` → titlebar + Settings + Agent tab | [ ] |
| 快照到达 | 注入 connected/error mock event 后，所有位置同一帧更新为相同状态 | `http://localhost:5173/` → 全局 Agent 状态区域 | [ ] |

#### 等级 3：真实应用验收通过

| 相关功能 | 验收行为表现 | 验收地址 | 结果 |
|---|---|---|---|
| 冷启动查询失败 | 临时使 `agent_status` 查询失败时，应用显示 unknown 和诊断错误，不伪装 disconnected/connected | 真实应用 → 冷启动；Runtime Sheet | [ ] |
| 后续事件恢复 | Agent status 事件到达后，Settings/titlebar/tab/InputBar 同步恢复真实状态 | 真实应用 → Agent 重连/启动流程 | [ ] |

## 施工日志

| 2026-08-09 | 拍板决策同步 | 已将本轮已确认的产品决策与当前实施成熟度写入“已拍板决策”。未形成措施的内容明确标注为仅有决策。 | 关联未决策项见 `未决策项.md` |
| 日期 | 类型 | 记录 | 证据/备注 |
|---|---|---|---|
| 2026-08-09 | 文档拆分 | 从 `docs/release-issues.md` 拆分为 `ISSUE-03`；保留原问题记录、追加调查、修复记录与三级验收内容。 | 本文件生成于 Issue Library 初始化 |
|  |  |  |  |


## 本轮源码核验与可验收子任务（2026-08-09）

### 逐条源码核验矩阵

| 原主张 | 判定 | 当前源码证据 | 方案修正 |
|---|---|---|---|
| 无快照时当前会伪造 connected | 属实 | `src/components/Settings.tsx:235`；`src/components/settings/agentTypes.ts:36-41` | 增加 `unknown`；active 且无快照为 unknown，非 active 才是 inactive。 |
| 状态只需改 Settings | 不属实 | `src/App.tsx:93-100`、Sheet tab CSS、InputBar 均消费状态 | 用单一 selector 驱动 Settings/titlebar/tab/InputBar，并做一致性测试。 |


> 本节是本轮对当前源码的增量审计与执行切分。原编号只用于追溯；以下 task id 才是 Harness v2 的执行单位。

### 核验结论
- ✅ 原问题方向与当前相关源码结构一致；本轮将方案拆成独立 producer/consumer/test 子任务，最终验收仍需按证据等级执行。

### 子任务清单

| Task ID | 类型 | 归属 | 依赖 | 验收标准 | 最低证据 |
|---|---|---|---|---|---|
| `I03-A-FE-01` | FE | A | I02-A-FE-01 | 引入 unknown 并统一状态 selector；无权威快照显示 unknown，不伪造 connected/disconnected；所有消费点使用同一 selector。 | L1 |
| `I03-A-TEST-01` | TEST | S | I03-A-FE-01 | 状态缺失/失败/事件矩阵测试；Settings、titlebar、SheetTabStrip、InputBar 表现一致。 | L2 |

### 本轮施工日志

| 2026-08-09 | 源码核验 + 任务切分 | 已对照当前源码建立证据结论；按一张卡一个独立可验收结果切分，B 视觉任务仅在基座/契约明确后进入。 | `docs/Issue Library/harness-v2/` |
