# ISSUE-01：Release 多 Agent 产品边界

> 正式编号按 Release 实施依赖关系编排。原问题编号保留在正文中，便于追溯历史记录。

## 当前状态

- 正式编号：`ISSUE-01`
- 原问题编号：`#13`
- 状态：已交付（方案已写入）
- 依赖：无
- 简介：所有后续 Agent lifecycle、Session identity 与 GUI 路由工作的产品边界。默认单活 Release。
- 来源：`docs/release-issues.md`

## 已拍板决策（2026-08-09）

### Release 1.x 冻结契约（I01-A-DOC-01）

以下约束是当前 Release 的实施真值；本文件后续保留的并行方案只作为 2.0 设计资料，不得被任务卡、界面文案或验收结果解释为当前能力：

1. Pylon 可以配置多个 Agent，但 GUI 同一时刻只有一个 `active_agent`。多个 Agent Sheet 可以同时存在，只有 active Agent 对应的 Sheet 可以发起 GUI 业务命令。
2. 聚焦非 active Agent Sheet 必须先完成显式切换事务。切换成功后才能 focus、恢复 Session 或启用发送、附件、File/Git 等控件；切换失败或仍在 pending 时保持原上下文且禁止目标 Sheet 发令。
3. 当前 GUI 切换沿用单活生命周期：启动目标 runtime，并停止旧 GUI active runtime。Gateway 按 binding 使用其他 runtime 的既有能力不等于 GUI 支持并行 Agent，也不得改变 GUI 的路由真值。
4. Session 创建后永久归属一个 `agentId`。当前 Release 不支持原地迁移，也不提供“复制到其他 Agent”；该能力作为 2.0 独立任务重新定义迁移范围。
5. 跨层上下文采用结构化 `AgentContextKey = { agentId, source }`。`source` 是不透明值，只要求在所属 Agent runtime 内唯一；相等判断必须同时比较 `agentId` 与完整 `source`，不得用字符串拼接后 `split` 还原。
6. Session、workspace、Git 及后续 GUI 业务命令必须携带或从受验证的 Session 归属取得完整 AgentContext。兼容期允许保留旧 command wrapper，但 wrapper 必须验证 `agentId === active_agent` 后再路由，不能用 active Agent 静默覆盖调用方上下文。
7. 找不到 Agent、Session、source 或 workspace 归属时必须返回显式错误。尤其禁止从错误/缺失 source 回退到 `agent_cwd`，也禁止以同名 source 在另一个 Agent runtime 中继续执行。
8. 旧的 source-only Session/缓存需要版本化兼容迁移：先确定稳定 `agentId`，保留旧 key 到新 AgentContext 的搬迁关系；不得仅重算 source 而丢失消息、运行态或 touched files。
9. “多个 GUI Agent 同时连接、发送、生成、取消和恢复”属于 2.0 并行工作台，只有完成显式 IPC 路由、状态/事件隔离、生命周期和真实 L3 证据后才可对外宣称支持。

### D-09：首期不实现 Session 复制到其他 Agent

- 当前 Release 只实现并验证 Session 归属不可原地迁移。
- “复制到其他 Agent”保留为 2.0 独立产品任务，不进入当前 ISSUE-01 的实施 DAG，也不阻塞单活 Release。
- 当前 UI 不展示不可执行的复制入口；文档和测试不得宣称该能力已支持。
- 未来启动该能力时重新拍板复制消息、配置、附件、工具历史及不同 ACP Agent 的兼容规则。


### D-01：当前 Release 采用多 Agent 可配置、GUI 单活

- 当前 Release 采用方案 A：允许配置多个 Agent，但 GUI 通过显式切换保持单活。
- 多个 Agent Sheet 可以同时存在；非 active Agent Sheet 不得直接发送、恢复 Session 或执行 File/Git 等业务命令。
- `active_agent` 是当前 GUI runtime 选择，但不能覆盖 Sheet/Session 携带的 AgentContext；归属不一致必须报错。
- Gateway 保留按 route 使用不同 Agent runtime 的能力，但该后台能力不构成 GUI 并行承诺。
- 真正的多 Agent 并行工作台采用原方案 B，移至 2.0 独立工程。

实施方案成熟度：**Release 边界与兼容约束已冻结；代码实现按 I01 后续任务卡分片交付。**

### D-02：2.0 预留——切换 Agent Sheet 时原 Sheet 在后台继续生成

- 本节不属于 Release 1.x 验收范围，也不得作为当前 UI 行为承诺。
- 未来并行版本聚焦其他 Sheet 不取消、不停止原 Agent；不可见 Sheet 的运行状态与消息继续收敛。
- 未来 cancel 必须作用于明确的 `agentId + sessionId/source`，不得影响其他 Agent。

实施方案成熟度：**2.0 方向性约束，尚无当前 Release 任务卡。**

### D-03：2.0 预留——关闭 Agent Sheet 只关闭视图

- 关闭 Sheet 不取消 prompt，不停止 Agent runtime。
- 后台生成继续进行，消息继续写入后端消息仓库。
- 重新打开对应 Agent/Session Sheet 后恢复消息与运行状态。
- 只有显式 cancel/stop 才具备终止任务的语义。

实施方案成熟度：**2.0 方向性约束，尚无当前 Release 任务卡。**

### D-04：2.0 预留——Agent runtime 空闲超时自动回收

- 关闭最后一个 Sheet 不立即停止 runtime。
- 仅当无活动 prompt、无 pending permission、无 Gateway 活跃使用、无后台事务且无显式保活时进入 idle。
- 默认 idle timeout 为 15 分钟；设置提供 `5 / 15 / 30 / 永不自动停止`。
- 修改 timeout 后，已在 idle 计时的 runtime 应重新计算期限；选择永不停止时取消 timer。
- 打开 Sheet、恢复 Session 或 Gateway 消息到达时懒启动 runtime。

实施方案成熟度：**2.0 资源策略，不进入当前 Release 验收。**

### D-05：2.0 预留——同时运行的 Agent 数量设可配置上限

- 默认最多同时运行 4 个 runtime；设置提供 `2 / 4 / 8 / 不限制`。
- 达到上限时优先回收满足 idle 条件且最久未使用的 runtime。
- 不得停止正在生成、处理 permission、被 Gateway 使用或显式保活的 runtime。
- 无可安全回收项时拒绝启动新 Agent，并显示明确错误。
- GUI 与 Gateway 共用同一 runtime registry 和资源上限。

实施方案成熟度：**2.0 资源策略，不进入当前 Release 验收。**

## 并行执行元数据

```yaml
formal_id: ISSUE-01
status: 已交付（方案已写入）
lane: architecture
priority: P0
stage: contract
size: XL
dependencies: []
blocks: ["ISSUE-02", "ISSUE-06", "ISSUE-07", "ISSUE-08", "ISSUE-12", "ISSUE-13"]
likely_modify: ["src/identityStore.ts", "src-tauri/src/runtime.rs", "src-tauri/src/session/", "src/components/chat/"]
do_not_modify: ["不在单个 Issue 内一次性完成所有并行 Agent 改造"]
execution_rule: "先完成任务卡依赖，再领取本 Issue 的 ready slice；跨 Lane 变更必须经 contract/checkpoint。"
```

> 此处是 Harness 的机器可读入口。Issue 级状态不等于所有 slice 完成；以 `harness/queue.json`、任务卡和 checkpoint 为准。

### D-06：2.0 预留——Session 复制到其他 Agent

- Session 创建后永久绑定原 `agentId`，不得直接修改归属。
- 当前 Release 不提供复制入口；需要在其他 Agent 中继续时新建普通 Session。
- 未来 2.0 可以用“复制到其他 Agent”创建新的 Session identity。
- 复制后的 Session 使用新的 `sessionId`、source/ACP session mapping 和消息归属；原 Session 保留不变。
- 复制流程必须显式选择目标 Agent，并对 profile、model、工作目录、工具能力和历史兼容做校验。
- 不得通过修改前端字段把原 ACP Session 冒充为目标 Agent Session。

实施方案成熟度：**已移出当前 Release；未来启动前重新拍板复制范围和 ACP 兼容策略。**

### D-07：runtime 崩溃后自动重连，但不自动重发 prompt

- 后台或可见 Agent runtime 崩溃后，Pylon 自动尝试恢复该 Agent runtime。
- 崩溃时仍未完成的 prompt 标记为 `interrupted`，保留已收到的消息、reasoning 和工具记录。
- runtime 重连成功只恢复 Agent 可用性和 Session 恢复能力，不自动继续、重放或重新提交原 prompt。
- 用户必须显式点击重试或重新发送，避免重复执行工具、文件写入和外部副作用。
- 自动重连状态与 prompt 中断状态必须分别展示，不能以“Agent 已重新连接”伪装原任务已恢复。

实施方案成熟度：**已有明确行为方案；重连退避、重试上限和 interrupted prompt 的工具终态收敛仍需代码级设计。**

### D-08：后台 Agent 的 permission request 使用全局通知

- 任意 Agent 在不可见 Sheet 或后台 runtime 中发起权限请求时，Pylon 显示全局通知。
- 通知必须明确显示 `Agent + Session + Tool/操作摘要`，避免用户把 A 的授权误给 B。
- 点击通知可以定位、打开或聚焦对应 Agent/Session Sheet，并进入该请求的审批界面。
- 权限响应必须携带完整 Agent/Session/request/generation context，只能发送给原请求所属 runtime。
- 用户未处理时继续遵循既有安全超时策略，超时默认拒绝；不得因为请求来自后台而自动批准。

实施方案成熟度：**已有完整产品行为；全局通知宿主、聚焦事务、并发请求队列和超时 UI 尚需代码级设计。**

## 原始问题记录

原问题编号：#13
严重度：P1
状态：已交付（方案已写入）

问题现象：
宫木云询问：
“我们现在到底支不支持多 Agent？”

当前产品外观允许同时打开多个 Agent Sheet，前端也保存了 `sheet.agentId`、`sheetAgentStates[agentId]` 和 `agentStatuses[agentId]`；后端则维护 `agentId → AgentRuntime` 注册表，Gateway 可以按 route 将不同平台 source 投递到不同 Agent。用户因此会自然理解为“每个 Agent Sheet 都绑定自己的 Agent，会话、消息、文件和 Git 操作不会串线”。

实际行为不是完整多 Agent：GUI 业务 command 没有携带 `agentId`，后端统一通过全局 `active_agent` 选择 runtime。聚焦一个非 active Agent Sheet 不会自动切换 Agent，Session 也没有 agentId 归属。因此视觉上的 Agent/会话/工作区目标与命令实际执行目标可能分离，存在消息、会话恢复、文件和 Git 操作进入错误 Agent runtime 的风险。

触发条件：
1. 配置至少两个 Agent，例如 Peri 与 Hermes。
2. 分别打开两个 Agent Sheet，或在 Agent A 下建立会话/打开 File Sheet 后切换到 Agent B。
3. 聚焦旧 Agent Sheet、旧会话或旧 File Sheet，但不重新执行 `switch_agent`。
4. 执行发送消息、恢复会话、取消生成、读取文件、Git status/diff 等操作。
5. 命令按全局 active Agent 路由，而不是按当前 Sheet/Session 所标示的 Agent 路由。

问题根因：
多 Agent 架构只在后端 runtime registry 和 Gateway route 层完成，GUI command contract、前端 Session identity 和运行时状态 key 仍是单 active Agent 模型。具体表现为：
1. 后端存在独立的 `AgentRuntimeManager`，但 GUI commands 通过 `require_runtime()` 读取全局 `active_agent`，IPC payload 不含 agentId。
2. `SheetRecord.agentId` 仅用于 Agent Sheet identity/展示，`AgentSheetView`、`ChatView`、`InputBar` 未将它传入业务 command。
3. 前端 Session 没有 agentId；消息、live stats、mode/config、touched files 等均只以 source 为 key。后端 source 在 per-Agent runtime 内只需局部唯一，前端却隐式要求跨 Agent 全局唯一。
4. GUI `switch_agent` 会停止旧 active runtime，而 Gateway 又允许按 route 懒启动多个 runtime；两种入口对“多个 Agent 是否可同时存活”的生命周期语义不一致。
5. File/Git commands 同样按 active runtime 查 source；Git 查找失败还会回退当前 active Agent cwd，可能把错误工作区数据展示为目标 Sheet 数据。

证据等级：L2 源码证据。

已确认的当前能力边界：
- 支持：配置多个 Agent。
- 支持：后端保存多个隔离的 AgentRuntime。
- 支持：Gateway 按 source route 到不同 Agent，并可懒启动对应 runtime。
- 支持但有 #9～#12 缺陷：GUI 在多个 Agent 间切换。
- 不支持：多个 Agent Sheet 同时作为独立、可交互的运行上下文。
- 不支持：Session 绑定并持久化 agentId。
- 不支持：GUI command 按 agentId + source 精确路由。
- 不支持：不同 Agent 使用相同 source 时的前端状态隔离。
- 不支持：旧 Agent 在 GUI 切换后继续稳定运行。

相关源代码：
- `G:/Project/prism-desktop/src-tauri/src/runtime.rs:18-35,80-130`
  - 每个 AgentRuntime 已隔离 ACP client、dispatcher、sessions、generation、生命周期和自动重连；注册表按 agentId 存储。
- `G:/Project/prism-desktop/src-tauri/src/lib.rs:719-738`
  - Gateway ingest 根据 `binding.agent_id` 取得/创建目标 runtime，不绑定时才回退 active Agent；这是当前真实多 Agent 路由路径。
- `G:/Project/prism-desktop/src-tauri/src/gateway/route.rs:37-79,298-323`
  - EntityBinding 明确保存 source → agentId/profileId/sessionKey。
- `G:/Project/prism-desktop/src-tauri/src/session/prompt.rs:9-30`
  - GUI `send_message` payload 不含 agentId，命令入口通过 `require_runtime()` 选择全局 active runtime。
- `G:/Project/prism-desktop/src-tauri/src/session/create.rs:180-230`
  - `new_session` 同样只按 active runtime 建会话。
- `G:/Project/prism-desktop/src-tauri/src/session/control.rs:1-190`
  - close/cancel/mode/config 等控制命令沿用 active runtime 选择。
- `G:/Project/prism-desktop/src-tauri/src/workspace_cmds.rs:8-88`
  - 文件/搜索命令通过 active runtime 查 source；Git 路径查找失败后回退 `state.agent_cwd()`。
- `G:/Project/prism-desktop/src-tauri/src/lifecycle/mod.rs:218-235,316-320`
  - GUI 切换会 abort 旧 dispatcher、kill 旧 ACP 并置 Disconnected，属于单活语义。
- `G:/Project/prism-desktop/src/identityStore.ts:25-41,154-170`
  - Session 不含 agentId；本地 source 只由 `local:` + name 构造，没有跨 Agent identity。
- `G:/Project/prism-desktop/src/runtimeStore.ts:32-54,72-100`
  - 会话 live stats/mode/config 只按 source 建索引。
- `G:/Project/prism-desktop/src/components/chat/sessionRuntimeStore.ts:57-98`
  - ChatRuntimeState 是 `Record<source, SourceChatRuntime>`，没有 Agent 维度。
- `G:/Project/prism-desktop/src/workspaceStore.ts:39-66,162-166`
  - touchedFiles 只按 source 建索引；sheetAgentStates 虽按 agentId 记忆 profile/session，但不是 command routing contract。
- `G:/Project/prism-desktop/src/sheets/AgentSheetView.tsx:21-51`
  - AgentSheetView 未消费 `sheet.agentId`，只把全局 activeSession 传给 ChatView/ControlCenter。
- `G:/Project/prism-desktop/src/workspace-sheets/SheetTabStrip.tsx:19-23,105-127`
  - 聚焦 Agent Sheet 只调用 focus，不会把 `sheet.agentId` 切成 activeAgent；非 active Sheet 仍可进入。
- `G:/Project/prism-desktop/src/components/Sidebar.tsx:33-41`
  - 会话列表只按 profileId 过滤，不按 agentId 过滤。
- `G:/Project/prism-desktop/src/workspace-sheets/SheetLayout.tsx:60-80`
  - 每 Agent profile/session 记忆是部分预留，但恢复 effect 不随 activeAgent 变化重新执行；全局 activeSession 仍可能写入新 Agent 记忆。
- `G:/Project/prism-desktop/src/sheets/OverviewSheetView.tsx:65-78`
  - 恢复最近会话时使用当前 activeAgent 打开 Agent Sheet，没有从会话快照恢复原 Agent 归属。

已排除的假设：
- 已排除“后端完全不支持多 Agent”：AgentRuntimeManager、per-Agent session map、Gateway route 和 Inspector agentId 均证明后端存在真实多 Agent 基础。
- 已排除“Agent Sheet 的 agentId 已决定后端命令目标”：当前 send/new/close/cancel/workspace IPC 均未传 agentId，后端仍读全局 active_agent。
- 已排除“source 天然跨 Agent 全局唯一”：后端 session map 位于各 AgentRuntime 内，数据模型只要求 runtime 内唯一；前端没有 agentId 维度却依赖全局唯一，是未声明的隐式约束。

解决方案：

方案 A（当前 Release 已采用；加固“单活多 Agent 切换”）：
- 目标：Release 1.x 明确定义为“可配置多个 Agent，但 GUI 同时只有一个 active Agent；切换会停止旧 Agent”。先消除误路由和假多 Agent 外观，不在 Release 阶段直接扩张成并行工作台。
- 改动位置：
  - `src/identityStore.ts`、`sessionPersistence.ts`
  - `src/workspace-sheets/SheetTabStrip.tsx`、`SheetLayout.tsx`
  - `src/application/transactions/switchAgentTransaction.ts`
  - `src/components/Sidebar.tsx`、`SessionSettings.tsx`
  - `src/sheets/file/*`
  - `src-tauri/src/workspace_cmds.rs`
  - 与 #9～#12 的 Agent lifecycle 修复链
- 具体改法：
  1. Session 增加必填 `agentId`，新建时取当前 activeAgent；持久化 schema 升级并迁移旧数据。旧 Session 无 agentId 时绑定迁移时的 active/default Agent，并标注一次性迁移来源。
  2. 本地 source 改为跨 Agent 可判别形式，例如 `local:<agentId>:<sessionId>`；不要再由可重复 name 直接构造。显示名称与 source identity 分离。
  3. Sidebar 按 `session.agentId === activeAgent && profileId === activeProfileId` 过滤；SessionSettings 明确展示只读 Agent 归属，首期不允许直接改归属。
  4. 点击非 active Agent Sheet 时不直接 focus：先执行 `switch_agent(sheet.agentId)`；成功后恢复该 Agent 的 profile/session 记忆并 focus，失败则停留当前 Sheet。切换过程中禁用该 Sheet 的 send/attach/file/git 控件。
  5. AgentSheetView 增加一致性 guard：`sheet.agentId !== activeAgent` 时只渲染“未激活，点击切换”，不得挂载可发送的 ControlCenter。
  6. 修正 `SheetLayout` 的恢复 effect 依赖：activeAgent 变化时读取 `sheetAgentStates[activeAgent]`；恢复完成前不得把旧 activeSession 写入新 Agent 记忆。推荐增加 `restoringAgentContext` transaction gate。
  7. File Sheet identity 至少保存 `agentId + source`；当前 activeAgent 与 File Sheet agentId 不一致时禁止请求，提示先切换 Agent。
  8. 删除 Git 的错误 cwd fallback：source 在目标 runtime 不存在时返回 `session_not_found/git_error`，不得静默使用当前 active Agent cwd。
  9. 状态与能力链按 #9～#12 收口：切换结束后 `agent_status` 对账，生命周期只由后端快照/事件写入。
  10. UI 文案明确“切换 Agent 会停止当前 Agent”；如果当前 Agent 正在生成，切换前阻止并说明，或执行可见的 cancel/stop transaction。【需拍板：生成中切换是禁止，还是确认后取消并切换；推荐首期禁止】
- 影响面：保持当前后端单活 GUI 语义，不支持多个 GUI Agent 同时生成；会改变 Session 持久化 schema、source 格式和 Agent Sheet 聚焦行为。Gateway 多 Agent 路由继续存在，但 GUI 不再伪装成并行工作台。
- 验证方式：
  1. Peri/Hermes 各创建同名会话，source 不冲突，Sidebar 只显示 active Agent 的会话。
  2. 点击非 active Agent Sheet 必须先完成 switch；失败时绝不进入可发送状态。
  3. 切换后恢复各自 profile/activeSession，不把 A 会话写入 B 的 sheetAgentStates。
  4. 旧 Agent File Sheet 在 activeAgent 不一致时停止请求，不展示新 Agent cwd 数据。
  5. A 正在生成时触发切换，行为符合拍板策略且不产生孤儿 spinner/错误取消。
  6. 冷启动迁移旧 Session 后，每条 Session 都有稳定 agentId；重启后不漂移。
  7. Gateway 路由到非 GUI active Agent 的消息仍可处理，且 GUI 不把其后台状态误展示为当前 active 状态。
- 风险与取舍：这是最小可上线边界，能阻断错 Agent 操作，但不会提供真正的并行多 Agent。Session schema/source 迁移必须有版本和兼容测试；不能直接重写 source 导致历史消息缓存丢失，需建立旧 key → 新 key 搬迁。

方案 B（2.0 预留，升级为真正的多 Agent 工作台）：
- 目标：每个 Agent Sheet、Session、File Sheet 都携带稳定 AgentContext；多个 Agent runtime 可以同时连接、生成和展示状态，不再依赖全局 active_agent 决定 command 目标。
- 改动位置：前后端 Agent/Session/Sheet/IPC 全链路，核心包括：
  - `src-tauri/src/session/*`、`workspace_cmds.rs`、`export.rs`、`lifecycle/mod.rs`
  - Agent status/list commands 与事件 payload
  - `src/identityStore.ts`、`runtimeStore.ts`
  - `src/components/chat/*`
  - `src/workspace-sheets/*`、`src/sheets/file/*`
  - message/session/workspace 持久化 schema
- 具体改法：
  1. 定义唯一上下文键：
     ```ts
     interface AgentContextKey {
       agentId: string
       source: string
     }
     ```
     序列化 key 推荐使用结构化对象或安全编码函数，禁止手写 `${agentId}:${source}` 后再靠 split 解析。
  2. 所有 Agent 相关 IPC 显式携带 `agentId`：`new_session`、`send_message`、`close_session`、`cancel_prompt`、`load_persisted_session`、`set_mode`、`set_config_option`、export、workspace、Git。后端改用 `runtime_for_agent(agent_id)`，不得在这些命令中调用 `require_runtime()`。
  3. `active_agent` 降级为“当前 UI 默认/标题栏选择”，不再是业务路由真值；Gateway 和 GUI 都通过显式 agentId 选 runtime。
  4. Session 必填 agentId；后端 session DTO、持久化摘要和恢复列表都返回 agentId。恢复最近会话时先定位原 Agent，不使用当前 activeAgent 猜测。
  5. Chat runtime、session live stats、mode/config、generation/cancel、message persistence、touched files 全部由 source key 升级为 AgentContextKey。
  6. Tauri chat 事件 payload 保持/补齐 agentId：`pylon:user/update/done/error` 均携带 `{ agentId, source, generation }`；前端 listener 用 agentId+source 路由，避免两个 runtime 的同 source 串流。
  7. Agent Sheet 的 `sheet.agentId` 成为真实 runtime 绑定；每个 Agent Sheet 独立 activeSession/profile 和记忆。聚焦 Sheet 不需要 kill/switch runtime，只改变 UI focus。
  8. 生命周期 command 拆分：`activate_agent_ui(agentId)` 仅改变 UI 默认值；`start_agent/stop_agent/reconnect_agent(agentId)` 显式控制某个 runtime。删除 `switch_agent` 中“启动目标后杀旧 Agent”的隐式副作用，或保留为兼容命令但 UI 不再使用。
  9. `agent_status` 升级为 `agent_status(agentId)`，并新增 `list_agent_statuses()` 返回完整 registry 快照；状态事件始终带 agentId，Gateway 懒启动也更新状态 registry。
  10. Permission request、auto reconnect、session expiry、runtime log 必须保持 agentId；前端权限弹窗按 AgentContextKey 响应，禁止把 A 的 approval 发给 B 的 client generation。
  11. 资源策略参数化：允许配置最大同时连接 Agent 数、每 Agent session 上限、空闲 runtime 自动停止时间；否则真正多 Agent 会常驻多个 LLM/ACP 子进程。
  12. Gateway 与 GUI 共用 runtime，不因 UI focus 变化停止 Gateway 正在使用的 Agent；stop 前检查活动 prompt、平台 binding 和 pending permission，并要求显式确认。
- 影响面：这是架构级升级，会改变 IPC 契约、前端状态 key、Session/source 持久化和 Agent 生命周期产品语义；正常单 Agent 行为可通过默认 agentId 保持，但需要完整迁移层。
- 验证方式：
  1. Peri 与 Hermes 同时 connected，各自 Agent Sheet 同时发送，事件、spinner、token、cancel 完全隔离。
  2. 两 Agent 使用相同 source 字符串，前端消息和后端 session 仍不串线。
  3. A/B 并行生成，取消 A 不影响 B；A 崩溃自动重连不改变 B 状态。
  4. Gateway 路由到 A、GUI 操作 B，同步运行；聚焦/关闭 B Sheet 不停止 A 平台会话。
  5. 每个 Agent 独立 profile、activeSession、File Sheet、Git root 和 touched files。
  6. 重启后恢复 Agent+Session 归属；旧 schema 迁移无消息缓存丢失。
  7. 迟到的旧 generation 事件携带 agentId+generation，被对应 runtime 丢弃，不污染其他 Agent。
  8. list_agent_statuses 与真实进程、dispatcher、capabilities 一致，并覆盖后台 Gateway runtime。
- 风险与取舍：改动面大，不适合作为临近上线的紧急修复。最大的迁移风险是现有 source-only key 与本地缓存；最大的运行风险是多个 ACP 进程同时常驻。应按下面的阶段计划逐步落地，不允许一次性同时改所有命令而无兼容层。

拍板结果：Release 1.x 定义为“多 Agent 可配置、GUI 单活切换”，执行方案 A；方案 B 作为 2.0 架构目标。后端多 runtime/Gateway 能力可以保留，但不得在 1.x UI、任务卡或发布说明中宣称 GUI 并行交互。

2.0 重构资料（方案 B 的分阶段实施计划，不属于当前 Release DAG）：

阶段 0：Release 隔离护栏
1. 完成 #9～#12。
2. Session 增加 agentId，修正 Sheet 聚焦/切换 guard。
3. File/Git 移除错误 cwd fallback。
4. 明确单活产品文案与生成中切换策略。
5. 交付标准：任何 GUI command 都不能在 Sheet/Session Agent 归属不一致时执行。

阶段 1：身份与持久化升级
1. 定义 AgentContextKey 与统一 encode/equality helpers。
2. Session/message/workspace persistence schema 升级；实现旧 source-only 数据迁移。
3. runtimeStore/chatRuntime/touchedFiles 改为 AgentContextKey。
4. 此阶段后仍可使用单活后端，但前端数据已不会跨 Agent 冲突。

阶段 2：IPC 显式路由
1. 先改只读 commands：workspace/Git/inspector/export，增加 agentId 并移除 active runtime fallback。
2. 再改 session control：load/new/close/mode/config/cancel。
3. 最后改 send_message 与事件 payload；引入兼容 wrapper，旧调用在开发期记录 deprecated 告警，全部迁移后删除。
4. 每个 command 都增加“agentId 不存在”“source 不属于该 runtime”“generation stale”测试。

阶段 3：多 runtime 生命周期产品化
1. 新增 start/stop/reconnect(agentId) 和 list_agent_statuses。
2. UI focus 与 runtime lifecycle 解耦，删除 switch 即 kill 旧 Agent 的默认语义。
3. 增加并发上限、空闲回收、活动 prompt stop guard。
4. Gateway 与 GUI 共用 lifecycle policy。

阶段 4：并行工作台验收
1. 多 Agent Sheet 独立会话/状态/文件域。
2. 多 Agent 并行 prompt、cancel、crash/reconnect 压测。
3. 同 source 冲突、迟到事件、切 Sheet、关闭 Sheet、重启恢复的组合测试。
4. 真实 Peri + Hermes + Gateway 三路并行运行证据通过后，才可对外声明“支持多 Agent 并行工作台”。

### 源码复核后的实施细化

1. **先锁定 Release 1.x 单活语义**：在 `SheetTabStrip`/`AgentSheetView` 入口增加“聚焦非 active Agent 先 switch”的 transaction，不允许仅 focus 后继续挂载可发送控件。
2. **先迁移 identity，再迁移 command**：`identityStore.Session` 增加 `agentId` 前，必须给旧 `local:<name>` 建立一次性迁移映射；不能直接按新格式重算，否则 `sessionRuntimeStore`、`touchedFiles` 和本地持久化会丢引用。
3. **删除错误 cwd fallback 是硬要求**：`workspace_cmds.rs` 当前 `git_workspace_root()` 在 source 解析失败时回退 `state.agent_cwd()`，这会把错误 Agent 的仓库冒充目标仓库；单活方案也必须改为显式 `git_error/session_not_found`。
4. **当前 Release 的兼容切片**：先引入 `AgentContextKey` 的结构化 helper 和兼容 wrapper，只改只读 workspace/Git command；其余并行 IPC 改造留待 2.0 任务重新冻结。
5. **验收证据**：至少用 Peri/Hermes 同名 source、同名 session、同时 Gateway 路由三组场景证明“不串线”；不能只看 Sheet title 或 `agentStatuses` 的 key。

可行性：方案 A 可作为 Release 收口；方案 B 是架构项目，不能压缩成一次前端改动。

---


## 逐项验收清单

### 6.2 问题 #13：Release 多 Agent 产品边界与路由隔离

#### 等级 1：测试通过

| 相关功能 | 验收行为表现 | 验收地址 | 结果 |
|---|---|---|---|
| Session identity 与旧数据迁移 | 旧 Session 加载后获得稳定 `agentId`；同名 Session 不产生相同的新 source；损坏/旧 schema 有兼容结果 | `src/identityStore.ts`、`src/sessionPersistence.ts` 及对应 Vitest | [ ] |
| Agent Sheet 聚焦 guard | 点击非 active Agent Sheet 时先执行 switch；switch 失败不 focus、不挂载可发送控件 | `src/workspace-sheets/SheetTabStrip.tsx`、`src/sheets/AgentSheetView.tsx` 组件/事务测试 | [ ] |
| File/Git 路由保护 | source 不属于当前 Agent 时返回明确错误；不得 fallback 到 `agent_cwd` | `src-tauri/src/workspace_cmds.rs` focused Rust tests | [ ] |
| AgentContext 隔离 | 两个 Agent 使用相同 source 时，消息、runtime、touched files 测试数据不串 key | `src/runtimeStore.ts`、`src/components/chat/sessionRuntimeStore.ts`、`src/workspaceStore.ts` | [ ] |

#### 等级 2：前端网页验收通过（仅限前端）

| 相关功能 | 验收行为表现 | 验收地址 | 结果 |
|---|---|---|---|
| 多 Agent Sheet 外观边界 | 页面同时存在 Peri/Hermes Sheet 时，非 active Sheet 显示“未激活/先切换”，发送、附件、文件、Git 控件不可操作 | `http://localhost:5173/` → Overview 打开两个 Agent Sheet | [ ] |
| Session 列表隔离 | 切换 mock active Agent 后，Sidebar 只显示该 Agent 的 Session；同名 Session 可区分 | `http://localhost:5173/` → Agent Sheet 左栏 | [ ] |
| 切换 pending/error | mock switch pending 时目标 Sheet 不提前激活；失败后停留原 Sheet并显示错误 | `http://localhost:5173/` → Agent Sheet tab / Overview Agent 列表 | [ ] |

#### 等级 3：真实应用验收通过

| 相关功能 | 验收行为表现 | 验收地址 | 结果 |
|---|---|---|---|
| 单活切换 | Peri→Hermes 切换时旧 runtime 按产品约定停止，目标 runtime 成功连接；失败不误路由 | 真实应用 → Overview/Settings/Agent Sheet | [ ] |
| 同名会话隔离 | Peri 与 Hermes 各创建同名会话，消息、恢复、FileSheet、Git root 均归属正确 | 真实应用 → 两个 Agent Sheet + File Sheet | [ ] |
| Gateway 与 GUI 共存 | Gateway 路由到非 GUI active Agent 时仍按 binding 投递，GUI 不把后台会话冒充当前会话 | 真实应用 → Gateway Sheet；真实 QQ 路由；Runtime 日志 | [ ] |
| 证据地址 | 保存 switch 日志、agentId/source、ACP session id 和 Git root 对照 | `Runtime Sheet`；本轮验收日志目录 | [ ] |

## 施工日志

| 2026-08-09 | 拍板决策同步 | 已将本轮已确认的产品决策与当前实施成熟度写入“已拍板决策”。未形成措施的内容明确标注为仅有决策。 | 关联未决策项见 `未决策项.md` |
| 日期 | 类型 | 记录 | 证据/备注 |
|---|---|---|---|
| 2026-08-09 | 文档拆分 | 从 `docs/release-issues.md` 拆分为 `ISSUE-01`；保留原问题记录、追加调查、修复记录与三级验收内容。 | 本文件生成于 Issue Library 初始化 |
| 2026-08-09 | 产品拍板（已由 I01-A-DOC-01 收口） | Session 不允许原地迁移 Agent；复制能力已移出当前 Release，未来 2.0 若启动则创建全新 Session identity。 | D-09、D-06 |
| 2026-08-09 | 产品拍板 | runtime 崩溃后自动重连；未完成 prompt 标记 interrupted，不自动重发。 | 对应未决策项：runtime 崩溃恢复策略 |
| 2026-08-09 | 产品拍板 | 后台 Agent permission request 使用全局通知，显示 Agent/Session/Tool，点击定位对应 Sheet；超时默认拒绝。 | 对应未决策项：后台 permission request 展示 |
| 2026-08-09 | I01-A-DOC-01 契约冻结 | Release 1.x 统一为多 Agent 可配置、GUI 单活；并行 GUI 与 Session 复制移至 2.0。冻结结构化 AgentContext、切换前置 guard、旧数据兼容和 workspace/Git 禁止 cwd fallback 约束。 | `INDEX.md`、`harness/tasks/I01-A-DOC-01.yaml` |
|  |  |  |  |


## 本轮源码核验与可验收子任务（2026-08-09）

### 逐条源码核验矩阵

| 原主张 | 判定 | 当前源码证据 | 方案修正 |
|---|---|---|---|
| GUI/状态仍围绕 active Agent | 属实 | `src/App.tsx:92-100,116-117`；`src/runtimeStore.ts:38-63` | 当前 Release 先完成单活路由 guard，不把多 Sheet 外观当多 runtime 并行。 |
| Session/Workspace command 存在全局 runtime 风险 | 部分属实 | `src-tauri/src/workspace_cmds.rs` 使用 runtime/workspace 解析；`src/identityStore.ts:29` Session 以 source 为核心 | 引入结构化 AgentContextKey；source 解析失败必须报错，禁止 cwd fallback。 |
| 当前 Release 要实现 Session 跨 Agent 复制 | 不属实 | 当前源码无复制事务或稳定 ACP 跨 Agent 映射 | 已拍板移出本 Release，作为 2.0 独立产品任务。 |


> 本节是本轮对当前源码的增量审计与执行切分。原编号只用于追溯；以下 task id 才是 Harness v2 的执行单位。

### 核验结论
- 🟡 产品边界决策本身已明确，但“Release 单活”不能证明所有 workspace/Git 路由已经隔离；当前源码仍存在全局 runtime/store 与 `require_runtime()` 路径，必须以行为证据验收。证据：`src/runtimeStore.ts:54-102`、`src-tauri/src/workspace_cmds.rs`。

### 子任务清单

| Task ID | 类型 | 归属 | 依赖 | 验收标准 | 最低证据 |
|---|---|---|---|---|---|
| `I01-A-DOC-01` | DOC | A | 无 | 冻结 Release 单活边界与 AgentContext 兼容约束；INDEX 与任务卡明确单活/不承诺并行，禁止 source/cwd fallback 串线。 | L1 |
| `I01-A-BE-01` | BE | A | 无 | 结构化 AgentContextKey 与 workspace 路由 guard；同名 source/session 在错误 Agent 上返回显式错误，不回退 agent_cwd。 | L1 |
| `I01-A-FE-01` | FE | A | I01-A-BE-01 | Sheet 聚焦非 active Agent 的切换事务；点击非 active Agent 先完成 switch，再允许发送/业务 command。 | L2 |
| `I01-A-TEST-01` | TEST | S | I01-A-BE-01, I01-A-FE-01 | Release 三链路真实证据采集；记录 Agent ready、ACP prompt response、assistant content，三者不以状态灯替代。 | L3 |

### 本轮施工日志

| 2026-08-09 | 源码核验 + 任务切分 | 已对照当前源码建立证据结论；按一张卡一个独立可验收结果切分，B 视觉任务仅在基座/契约明确后进入。 | `docs/Issue Library/harness-v2/` |
