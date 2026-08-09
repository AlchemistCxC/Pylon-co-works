# ISSUE-02：Agent lifecycle 与 capabilities 解耦

> 正式编号按 Release 实施依赖关系编排。原问题编号保留在正文中，便于追溯历史记录。

## 当前状态

- 正式编号：`ISSUE-02`
- 原问题编号：`#10`
- 状态：已交付（方案已写入）
- 依赖：ISSUE-01
- 简介：将生命周期连接状态与能力协商状态拆开，避免 capability 缺失误判断线。
- 来源：`docs/release-issues.md`

## 并行执行元数据

```yaml
formal_id: ISSUE-02
status: 已交付（方案已写入）
lane: backend-contract
priority: P0
stage: producer
size: M
dependencies: ["01-A"]
blocks: ["03-A", "04-A", "05-A"]
likely_modify: ["src/infrastructure/acp/", "src/runtimeStore.ts", "src-tauri/src/lifecycle/"]
do_not_modify: ["不实现真正多 Agent UI"]
execution_rule: "先完成任务卡依赖，再领取本 Issue 的 ready slice；跨 Lane 变更必须经 contract/checkpoint。"
```

> 此处是 Harness 的机器可读入口。Issue 级状态不等于所有 slice 完成；以 `harness/queue.json`、任务卡和 checkpoint 为准。

## 原始问题记录

原问题编号：#10
严重度：P1
状态：已交付（方案已写入）

问题现象：
Agent 生命周期状态与功能可用性可能互相矛盾：后端明确报告 connected，但 Agent 未声明 `agentCapabilities` 时，前端仍把它判为未连接并禁用发送/附件；反之，重连中或错误状态若仍携带旧 capabilities，前端可能把它判为已连接。

触发条件：
1. 连接一个 initialize 成功但响应未包含 `agentCapabilities` 的合法 Agent；或让已连接 Agent 进入 reconnecting/error，ACP client 中仍保留上一代 capabilities。
2. 后端返回/广播 AgentStatus payload。
3. 观察 titlebar 状态与 InputBar 的发送、附件 gate。

问题根因：
前端能力快照使用 `capabilities !== null && capabilities !== undefined` 作为 `connected` 判据，而没有使用权威生命周期字段 `status === 'connected'`。但后端的 capabilities 只是 initialize 协商结果：Agent 未声明能力时为 null，不代表连接失败；生命周期非 connected 时，当前 ACP 对象也可能仍持有旧能力值。因此“能力是否声明”和“连接是否成立”被错误合并成同一个布尔真值。

证据等级：L2 源码证据。

相关源代码：
- `G:/Project/prism-desktop/src/infrastructure/acp/agentContracts.ts:33-52`
  - `connected` 完全由 capabilities 是否为空推导。
- `G:/Project/prism-desktop/src/infrastructure/acp/useAgentCapabilities.ts:12-16`
  - InputBar 等消费方从该快照读取连接状态。
- `G:/Project/prism-desktop/src/components/chat/InputBar.tsx:69-75,323-330`
  - 发送/附件 availability 和文件选择 gate 依赖能力快照的 `connected`。
- `G:/Project/prism-desktop/src-tauri/src/acp/mod.rs:549-554`
  - capabilities 仅从 initialize response 的可选 `agentCapabilities` 字段提取；字段缺失时保持 None。
- `G:/Project/prism-desktop/src-tauri/src/lib.rs:328-360`
  - payload 的 lifecycle `status` 与 `capabilities` 分别构造；capabilities 从 ACP client 读取，不是连接状态字段。

解决方案：

方案 A（推荐，拆分生命周期与能力协商语义）：
- 改动位置：`agentContracts.ts`、相关测试和 `InputBar.tsx` 消费逻辑。
- 具体改法：
  1. `connected` 唯一按 `status?.status === 'connected'` 推导。
  2. 能力快照新增 `negotiated` 或 `capabilitiesKnown`，按 capabilities 是否为 object 推导；不得反向影响 connected。
  3. capabilities 缺失时，对具体能力返回 unknown/保守默认；发送基础文本只依赖 connected 和会话有效性，图片等扩展功能再依赖具体能力。
  4. reconnecting/connecting/disconnected/crashed/error 一律 connected=false，即使 payload 暂时携带 capabilities。
  5. 如需避免旧能力误用，后端在非 connected payload 中明确输出 `capabilities:null`，但前端仍须以 status 为连接真值。
- 影响面：修复功能 gate；未声明 capabilities 的已连接 Agent 将可进行基础文本操作，扩展能力仍按保守策略处理。
- 验证方式：建立矩阵测试：
  1. connected + capabilities object → connected=true、negotiated=true。
  2. connected + capabilities null/缺失 → connected=true、negotiated=false。
  3. reconnecting/error/crashed + capabilities object → connected=false。
  4. disconnected + capabilities null → connected=false。
  5. InputBar 基础发送与生命周期一致，图片附件只受 promptImage 影响。
- 风险与取舍：需要明确“能力未声明”的各功能默认值。基础文本发送应遵循 ACP 基线放行；图片、fork、resume 等扩展能力建议保守禁用或显示“能力未确认”。

重构方案：
将 Agent runtime contract 显式分为：
```text
Lifecycle：status / lastError / lastConnectedAt / generation
Negotiation：capabilitiesKnown / capabilities
Availability：由 lifecycle + 单项 capability 派生
```
禁止任何消费方通过 capabilities 是否存在反推进程连接状态。

---

### 源码复核后的实施细化

1. `agentContracts.ts` 的 `resolveCapabilitySnapshot()` 改为接收生命周期 status：`connected = status?.status === 'connected'`。
2. `capabilitiesKnown = isPlainObject(status?.capabilities)` 单独输出；未声明能力不影响基础文本发送，图片仅由 `promptImage` 决定。
3. 对 `connecting/reconnecting/error/crashed/disconnected` 强制清理或忽略旧 capabilities，避免旧 ACP client 能力穿透到新代际。
4. 补纯函数矩阵测试，并从 `useAgentCapabilities()`、`InputBar`、附件选择器反查所有消费点；禁止其他组件再次自行判断 capabilities。

可行性：高。后端 `lib.rs` 已分别输出 status/capabilities，优先前端修复，不需要先改 ACP 协议。

---


## 逐项验收清单

### 6.3 问题 #10：生命周期与 capabilities 解耦

#### 等级 1：测试通过

| 相关功能 | 验收行为表现 | 验收地址 | 结果 |
|---|---|---|---|
| capability snapshot 矩阵 | `connected + null capabilities` 仍 connected；非 connected + 旧 capabilities 必须 disconnected | `src/infrastructure/acp/agentContracts.ts` 及对应 Vitest | [x] ✅ `agentContracts.test.ts`（I02-A-TEST-01） |
| 基础文本与扩展能力 gate | 基础文本只依赖 lifecycle；图片只依赖 `promptImage`；能力未知时扩展项保守禁用 | `src/components/chat/InputBar.tsx`、`useAgentCapabilities.ts` 测试 | [x] ✅ `useAgentCapabilities.test.tsx` + `agentContracts.test.ts` gate（I02-A-TEST-01） |
| typed status payload | lifecycle 与 capabilities 分字段 normalize，不相互反推 | `src/infrastructure/acp/__tests__/typedClients.test.ts` | [x] ✅ `typedClients.test.ts`（I02-A-TEST-01） |

#### 等级 2：前端网页验收通过（仅限前端）

| 相关功能 | 验收行为表现 | 验收地址 | 结果 |
|---|---|---|---|
| connected + 未声明能力 | mock Agent 显示已连接，文本输入可发送；图片入口显示能力未确认或只允许文本 | `http://localhost:5173/` → Agent Sheet InputBar | [ ] |
| reconnecting + 旧能力 | 状态切为重连中时，发送和附件立即不可用，不受旧 capability object 影响 | `http://localhost:5173/` → Agent Sheet / titlebar | [ ] |

#### 等级 3：真实应用验收通过

| 相关功能 | 验收行为表现 | 验收地址 | 结果 |
|---|---|---|---|
| 合法无 capabilities Agent | initialize 成功但不声明 `agentCapabilities` 时，titlebar 显示 connected，基础文本可发送 | 真实应用 → 配置该 fake/真实 ACP Agent 后打开 Agent Sheet | [ ] |
| 重连代际 | Agent 进入 reconnecting/error 时，即使后端 payload 暂留旧 capabilities，功能 gate 仍关闭 | 真实应用 → Settings 重连；Runtime Sheet 查看 payload | [ ] |

## 施工日志

| 2026-08-09 | 拍板决策同步 | 已将本轮已确认的产品决策与当前实施成熟度写入“已拍板决策”。未形成措施的内容明确标注为仅有决策。 | 关联未决策项见 `未决策项.md` |
| 日期 | 类型 | 记录 | 证据/备注 |
|---|---|---|---|
| 2026-08-09 | 文档拆分 | 从 `docs/release-issues.md` 拆分为 `ISSUE-02`；保留原问题记录、追加调查、修复记录与三级验收内容。 | 本文件生成于 Issue Library 初始化 |
|  |  |  |  |


## 本轮源码核验与可验收子任务（2026-08-09）

### 逐条源码核验矩阵

| 原主张 | 判定 | 当前源码证据 | 方案修正 |
|---|---|---|---|
| capability 缺失会影响连接判断 | 属实 | `src/infrastructure/acp/agentContracts.ts:34-55`；`src/components/chat/InputBar.tsx:71-74,324-330` | 生命周期 `connected` 与 capability-known 分开输出，所有组件只消费统一 selector。 |
| 需要先改后端协议 | 不属实 | 当前前端已有 `resolveCapabilitySnapshot` 归一层 | 第一切片只改前端纯函数和 consumer；后端仅在事件代际缺失时补 contract。 |


> 本节是本轮对当前源码的增量审计与执行切分。原编号只用于追溯；以下 task id 才是 Harness v2 的执行单位。

### 核验结论
- ✅ 原问题方向与当前相关源码结构一致；本轮将方案拆成独立 producer/consumer/test 子任务，最终验收仍需按证据等级执行。

### 子任务清单

| Task ID | 类型 | 归属 | 依赖 | 验收标准 | 最低证据 |
|---|---|---|---|---|---|
| `I02-A-FE-01` | FE | A | I01-A-BE-01 | 生命周期与 capabilities selector 解耦；connecting/error/crashed 等代际不继承旧 capabilities；基础文本发送不因能力缺失禁用。 | L1 |
| `I02-A-TEST-01` | TEST | S | I02-A-FE-01 | capability 状态矩阵回归；覆盖 connected、缺失 status、非法 capabilities、旧代际。 | L1 |

### 本轮施工日志

| 2026-08-09 | 源码核验 + 任务切分 | 已对照当前源码建立证据结论；按一张卡一个独立可验收结果切分，B 视觉任务仅在基座/契约明确后进入。 | `docs/Issue Library/harness-v2/` |
