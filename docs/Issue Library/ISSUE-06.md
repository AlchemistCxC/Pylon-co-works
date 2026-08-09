# ISSUE-06：冷启动、消息提交与 Agent 响应链路

> 正式编号按 Release 实施依赖关系编排。原问题编号保留在正文中，便于追溯历史记录。

## 当前状态

- 正式编号：`ISSUE-06`
- 原问题编号：`#1`
- 状态：待处理；消息重放子问题 P1 未收敛 / Release 阻塞
- 依赖：ISSUE-05
- 简介：覆盖启动快照、optimistic user message、ACP/Provider 错误可见性与会话重放。
- 来源：`docs/release-issues.md`

## 已拍板决策（2026-08-09）

### D-17：启动前统一恢复未完成 attempt

- Pylon 启动扫描在允许新发送前执行；扫描与收敛必须在 SQLite 事务中完成，避免恢复期间产生新的 pending attempt。
- 所有未完成的用户、assistant、reasoning、tool attempt 统一收敛为 `interrupted`；已经持久化的内容和工具已知输出保留。
- 未完成 tool 记录不得伪装为 succeeded/completed，也不得删除；UI 必须区分发送中断、生成中断和工具中断。
- 用户显式重试时创建新的 attempt identity，并通过 `retryOf` 指向原 attempt；禁止复用原 attempt 或自动重发。
- 启动扫描幂等；重复启动不会创建新 attempt，也不会重复追加 interrupted 事件。
- 扫描失败时阻止发送并显示恢复错误，不得静默把未知状态当作可发送。


### D-16：原始 ACP chunk 仅保留在内存诊断环形缓冲

- 原始 chunk 不写入普通消息 SQLite，也不跨应用重启持久化。
- 每个 Session 独立环形缓冲，最多保留最近 2000 个 chunk；同时设置 24 小时 TTL，数量或时间任一先达到即淘汰。
- Session 删除、Agent runtime 回收或用户执行“清除诊断”时立即清空对应缓冲。
- 诊断导出必须由用户显式触发；导出前对 prompt、tool args/result、路径、token、凭据和个人信息执行脱敏，并记录导出时的截断与脱敏统计。
- 普通消息仓库只保存合并后的逻辑消息；诊断 chunk 不参与消息分页、搜索、重放或历史保留策略。
- 缓冲达到上限时只淘汰最旧 chunk，不影响当前 prompt；诊断 UI 明确显示数据为易失、截断且不完整。


### D-15：消息历史默认永久保存

- 默认策略为永久保存，不执行自动清理。
- 按时间保留、按每个 Session 数量保留仅在用户显式选择后生效。
- 新安装、旧版本迁移、配置字段缺失或配置解析失败时都回退为永久保存，不能因默认值变化自动删除历史。
- 用户选择非永久策略时必须显示预计影响；保存策略不等于立即清理，自动清理由后端安全调度在事务边界执行。
- 手动“立即清理”是独立显式操作，实施前显示预计删除范围并要求确认；不得在修改下拉项时直接删除。


### D-01：消息重放采用后端权威稳定消息模型

- Pylon Rust 后端是消息身份、顺序和持久化的权威来源。
- 每条消息至少携带：全局唯一 `messageId`、`agentId`、`sessionId`、`source`、会话内单调 `seq`。
- `messageId` 使用全局唯一 UUID/ULID 类标识；不得从 Agent、Session、source 或 seq 拼接后再解析。
- replay 是当前会话的权威 snapshot，以 replace 语义提交；不得把 replay 当 append 流。
- load 期间的实时消息进入该会话本轮 `liveDuringLoad` 缓冲；snapshot 提交后只合并本 load generation 的实时增量。
- 禁止按 `role + sender + content` 猜测去重；禁止按数组位置识别 live additions；禁止只比较 `messages.length` 判断缓存一致。
- 所有 load/事件提交必须校验 Agent/Session 归属与 generation。

实施方案成熟度：**已有正式架构方案；数据库 schema、IPC DTO、ACP 归一化边界与迁移步骤仍需施工 Agent按真实源码细化。**

### D-02：消息仓库采用 SQLite

- Rust 后端使用 SQLite 保存 Session、Message 和发送尝试。
- 核心实体至少包括 `sessions`、`messages`、`send_attempts`。
- 建立 `UNIQUE(message_id)`、`UNIQUE(session_id, seq)` 及 `session_id + seq` 分页索引。
- 使用游标分页，不使用长历史 `OFFSET` 扫描。
- Session 删除通过事务级联清理本地消息和发送尝试。
- schema 必须版本化并提供 migration；现有 localStorage 快照降级为兼容缓存，不再是历史权威来源。

实施方案成熟度：**已有技术选型与约束，具体 schema/migration 尚未落地。**

### D-03：旧 ACP 历史采用“首屏导入 + 后台完整导入”

- 首次打开旧会话时，先导入并展示最近 100 条消息。
- 后台继续完整导入剩余 ACP 历史到 SQLite。
- 导入必须幂等，能够处理应用退出、失败重试和导入期间新消息。
- SQLite 最终成为完整历史的权威来源。

实施方案成熟度：**仅有产品与迁移方向，后台导入状态机、幂等键和失败策略尚未拍板/设计。**

### D-04：首屏与历史分页

- 首次进入会话请求最近 100 条消息。
- 向上滚动时按 `beforeSeq` 或等价游标加载更早历史。
- tool、reasoning、diff 等逻辑消息均计入消息条数。

实施方案成熟度：**已有明确措施。**

### D-05：流式消息保存为逻辑消息，原始 chunk 进入诊断层

- 第一段 assistant/reasoning chunk 创建一条 `streaming` 逻辑消息；后续 chunk 更新同一 `messageId`。
- `done/error/cancelled/interrupted` 将消息收敛为终态。
- 普通消息仓库不保存每个 chunk 为独立消息。
- Runtime 诊断层可独立记录原始 ACP chunk、request ID、时间和顺序。

实施方案成熟度：**已有明确行为方案，诊断存储保留周期尚未定义。**

### D-06：乐观用户消息失败与重试

- 发送后立即清空输入并显示用户消息。
- 最终失败时保留原消息，标记为 `failed`，显示原因并提供重试。
- 重试时原消息原地从 `failed → pending`，不追加重复用户消息。
- 原 `messageId` 保留；每次发送尝试使用独立 `attemptId`。
- 重试成功后转为已确认；再次失败则回到 `failed`。

实施方案成熟度：**已有明确行为方案。**

### D-07：关闭应用与中断恢复

- 关闭整个 Pylon 时直接退出，不等待后台 prompt 收敛，也不自动发送 cancel。
- ACP 子进程随应用退出终止；已写入 SQLite 的内容保留。
- 下次启动时，数据库中的 `streaming/pending` 消息改为 `interrupted`，保留已收到内容并允许用户重试。
- 不得自动重发，避免重复执行工具或副作用。

实施方案成熟度：**已有行为方案；进程退出前最小 flush/事务边界尚需实现设计。**

### D-08：Session 删除采用本地物理删除

- 删除本地 Session 时，物理删除 SQLite Session、消息、消息索引和发送尝试。
- 同步清理前端缓存、runtime state、FileSheet tabs 与 touched files 等会话数据。
- 若会话正在生成，删除事务先取消并等待收敛；取消或删除失败时不得前端假删除。
- 删除期间标记 `deleting`，拒绝发送、恢复及迟到事件回写。

实施方案成熟度：**已有本地级联约束；是否同步删除 Agent/ACP 侧历史仍未决策。**

## 并行执行元数据

```yaml
formal_id: ISSUE-06
status: 待处理；消息重放子问题 P1 未收敛 / Release 阻塞
lane: backend-data
priority: P0
stage: schema
size: XL
dependencies: ["01-A"]
blocks: ["06-B", "08-A"]
likely_modify: ["src-tauri/src/session/", "src-tauri/src/acp/", "src/components/chat/"]
do_not_modify: ["不以内容签名作为身份系统"]
execution_rule: "先完成任务卡依赖，再领取本 Issue 的 ready slice；跨 Lane 变更必须经 contract/checkpoint。"
```

> 此处是 Harness 的机器可读入口。Issue 级状态不等于所有 slice 完成；以 `harness/queue.json`、任务卡和 checkpoint 为准。

### D-09：Agent runtime 崩溃时，未完成 prompt 收敛为 interrupted

- runtime 崩溃触发的未完成 prompt 与应用主动退出使用同一 `interrupted` 终态语义。
- 保留已持久化的用户消息、assistant/reasoning 内容和工具记录，不自动重发。
- runtime 自动重连成功后，用户可在原消息上显式重试；重试必须使用新的 attempt identity。

实施方案成熟度：**已有状态语义；不同工具状态如何映射到 interrupted 尚需施工设计。**

### D-10：旧 ACP 历史后台导入失败时保留进度并自动重试

- 最近 100 条已经可见后，后台完整导入失败不得回滚或删除已成功写入 SQLite 的历史。
- 导入任务使用指数退避自动重试，并提供手动重试入口和可查询的错误诊断。
- 导入失败不阻止用户继续发送和接收新消息；新消息与历史导入必须通过稳定 identity/幂等键避免冲突。
- UI 明确展示“历史导入未完成”、已导入范围、最后错误和下一次重试状态，不得伪装为完整历史。
- 应用退出或 runtime 断开后，导入进度持久化；下次启动从已确认游标继续，而不是从头重复写入。

实施方案成熟度：**已有完整产品行为；指数退避参数、导入游标 schema、幂等键和手动重试 command 尚需代码级设计。**

### D-11：消息历史保留策略由用户配置

- SQLite 不采用单一硬编码清理规则；在设置中提供消息历史保留策略。
- 保留模式至少支持：永久保存、按时间保留、按每个 Session 的消息数量保留。
- 自动清理只能删除已完成、已持久化且不处于导入/发送/恢复事务中的消息；不得清理 pending、streaming、interrupted 待处理记录或正在导入的历史边界。
- 清理必须以 Session 为隔离单位并使用事务；删除后同步维护分页游标、搜索索引和数据库统计。
- 用户修改策略后，应用必须明确显示预计影响；是否立即执行清理、默认时间/数量和手动“立即清理”入口尚需实施设计。

实施方案成熟度：**已有产品决策；默认策略、可选时间/数量档位、清理调度和回收 UI 尚未拍板/设计。**

### D-12：删除 Session 时尽力同步删除 Agent 侧历史，但不阻塞本地删除

- 删除 Pylon Session 时，先检查目标 Agent 是否声明并实现 Session 删除能力。
- Agent 支持删除时，删除事务尝试同步删除 Peri/Hermes/其他 ACP Agent 侧历史。
- Agent 不支持删除、远端不可达或远端删除失败时，仍允许完成 Pylon 本地 SQLite 物理删除。
- 本地删除完成后必须明确记录并向用户显示“Agent 侧历史未删除”及失败原因，不得伪装为全链路删除成功。
- 本地删除不得因第三方 Agent 能力缺失永久阻塞；远端删除失败可提供后续重试/诊断入口，但不能重新创建本地 Session。

实施方案成熟度：**已有完整产品行为；ACP capability 名称、删除 command、远端重试记录和 UI 呈现尚需协议/代码设计。**

### D-13：应用退出时未确认的 optimistic 用户消息恢复为 interrupted

- 用户消息已经在前端 optimistic 展示，但 Rust 后端尚未确认接收时，应用直接退出不视为发送成功。
- 下次启动从 SQLite/消息仓库恢复该消息，并标记为 `interrupted`。
- 原消息、`messageId`、`clientMsgId` 和发送 attempt 保留，允许用户在原消息上显式重试。
- 不自动重发，避免应用重启造成重复 prompt、工具调用或外部副作用。
- `interrupted` 用户消息必须与 `interrupted` assistant/reasoning/tool 状态区分展示，用户能够知道是“发送确认中断”而不是 Agent 已经执行完成。

实施方案成熟度：**已有明确行为方案；后端确认点、退出 flush 边界、启动扫描和 optimistic/attempt 状态迁移尚需代码级设计。**

### D-14：permission request 必须按完整 Agent/Session context 路由

- 后台权限通知与审批响应必须携带稳定 request identity、`agentId`、`sessionId/source` 和 generation。
- permission 状态不得只按 source 或当前 active Agent 存储；迟到审批不得发送给已替换的 client generation。

实施方案成熟度：**已有安全约束，具体 DTO 与 store 结构由多 Agent contract task 冻结。**

## 原始问题记录

原问题编号：#1
严重度：P1
状态：待处理

问题现象：
宫木云汇报：
“冷启动软件进入已有会话（或新开会话）。发送消息后，输入栏消息滞留，没有渲染到对话界面（疑似是设计，期望是消息在发送后立刻从输入栏消失并渲染在对话界面上。），且agent无回应，消息生成指示器迅速进入生成结束态，期间无任何消息渲染，只有用户本人发送的消息。切换会话后消息生成指示器消失（原本为结束态）。titlebar的agent状态指示灯全灰。”

触发条件：
1. Release 冷启动 Pylon。
2. 进入已有会话，或创建新会话。
3. 输入消息并发送。
4. 观察输入栏、对话区、生成指示器和 titlebar Agent 状态灯。

问题根因：
当前已查证的唯一确定根因是：冷启动时后端已经完成默认 Agent 的初始连接/状态写入，但没有向前端广播初始 `pylon:agent-status`；前端 titlebar 只读取运行时状态表，缺少状态时按空字符串映射为全灰。因此前端没有得到冷启动 Agent readiness 的事件同步。

该根因直接解释：
- titlebar Agent 状态指示灯全灰：前端 `agentStatuses[activeAgent]` 缺失时传入空字符串，状态灯映射为 `off`。
- 发送能力判断可能把 Agent 视为未连接：`useAgentCapabilities()` 只读取 `runtimeStore.agentStatuses[targetId]`，缺失状态时能力快照不是 connected；InputBar 的发送/附件可用性依赖该快照。

对于“Agent 无回应”和“消息生成指示器迅速结束”，目前没有 Release 运行日志、ACP wire 抓包或现场控制台输出，不能把它们编造成同一个已证实的后端错误。源码同时确认存在两个会放大该现象的前端契约问题，需在现场日志补证：
1. 用户消息不是 optimistic render：前端只有收到后端 `pylon:user` 事件后才把用户消息写入 Chat runtime。
2. 输入框不是发送即清空：`InputBar` 只有等待 `invoke('send_message')` 成功返回后才执行 `setValue('')`；后端在 ACP 建会话、发送 prompt、等待 Agent 最终响应期间，IPC Promise 尚未完成时，文本会持续留在输入栏。

证据等级：
- L1 直接证据：本轮首次调查未取得 Release 现场日志/抓包；该部分标注【待验证】。
- L2 源码证据：
  - `G:/Project/prism-desktop/src-tauri/src/lib.rs:546-577`
    冷启动创建默认 runtime，并直接调用 `AcpClient::connect_with_logs(...)`；成功后只写入 `default_runtime.agent_runtime.status = Connected`，没有调用 `emit_agent_status`，也没有在 Tauri WebView 建立后广播初始状态。
  - `G:/Project/prism-desktop/src-tauri/src/lib.rs:337-351`
    `emit_agent_status` 是唯一明确广播 `pylon:agent-status` 的状态广播路径；冷启动成功分支未调用它。
  - `G:/Project/prism-desktop/src-tauri/src/lib.rs:283-334`
    `agent_status_payload` 能从后端 runtime 生成状态，但它只在 `agent_status` command 被调用时返回；前端 bootstrap 的 `list_agents` 不返回该状态 payload。
  - `G:/Project/prism-desktop/src-tauri/src/lib.rs:604-633`
    `agent_status` command 已注册，但前端启动 bootstrap 只调用 `list_agents`，未调用 `agent_status`。
  - `G:/Project/prism-desktop/src/App.tsx:88-95`
    前端启动阶段注册 `pylon:agent-status` listener，收到事件后才写入 `useRuntimeStore.agentStatuses`。
  - `G:/Project/prism-desktop/src/workspace-sheets/WorkspaceTitlebar.tsx:48-66`
    titlebar 读取 `agentStatuses[activeAgent]?.status ?? ''`，缺失时传给 `AgentStatusLights`。
  - `G:/Project/prism-desktop/src/domains/agent/statusLight.ts:11-24,41-47`
    空字符串属于未知状态，映射为 `off`，三灯全灰。
  - `G:/Project/prism-desktop/src/components/chat/chatEventController.ts:307-333`
    用户消息只有在接收到 `pylon:user` 后才 dispatch `user` 事件并进入 Chat runtime。
  - `G:/Project/prism-desktop/src/components/chat/InputBar.tsx:265-280`
    `send_message` 通过 `runSendTransaction` 等待完成；成功回调才执行 `setValue('')`，错误回调只写 `setSendError`，也不会清空输入。
  - `G:/Project/prism-desktop/src-tauri/src/session/prompt.rs:460-470,481-490,518-528,541-569`
    后端发送流程先检查 ACP 崩溃、确保 session mapping、发送 prompt，再等待 Agent response；用户回显位于 `pylon:user` emit，但整体 `send_message` command 直到 prompt 等待结束才返回。

已排除/尚未证实的假设：
- 已排除“代码设计上完全没有用户消息事件”：后端明确广播 `pylon:user`，前端也有对应 listener；问题在事件是否成功注册、事件是否到达、source 是否匹配，尚无 Release 现场证据。
- 已排除“后端没有发送用户回显”：`session/prompt.rs:518-528` 明确存在 `USER_ECHO` 广播；但若此前 ACP 崩溃检查、建 session、Prism 注入或 prompt 构造失败，会在该广播点之前返回，需日志验证。
- 【待验证】ACP 子进程启动失败、ACP dispatcher 未启动、`pylon:user`/`pylon:update` listener 注册失败、已有会话 stale `periId`、Release 包中的 `agents.yaml`/Peri 路径不可用，均可能解释“无回应”，但本轮没有 L1 证据确认其中任何一项。

相关源代码：
- `G:/Project/prism-desktop/src-tauri/src/lib.rs:546-577`
- `G:/Project/prism-desktop/src-tauri/src/lib.rs:283-351`
- `G:/Project/prism-desktop/src-tauri/src/lib.rs:604-633`
- `G:/Project/prism-desktop/src/App.tsx:79-101`
- `G:/Project/prism-desktop/src/workspace-sheets/WorkspaceTitlebar.tsx:48-66`
- `G:/Project/prism-desktop/src/domains/agent/statusLight.ts:11-47`
- `G:/Project/prism-desktop/src/components/chat/chatEventController.ts:307-333,407-420`
- `G:/Project/prism-desktop/src/components/chat/InputBar.tsx:246-281`
- `G:/Project/prism-desktop/src-tauri/src/session/prompt.rs:460-528,541-607`

解决方案：

方案 A（推荐，修复已证实的冷启动状态同步缺口）：
- 改动位置：`G:/Project/prism-desktop/src-tauri/src/lib.rs`，默认 Agent 初始连接成功并完成 Tauri `Builder`/`setup` 后；以及 `G:/Project/prism-desktop/src/infrastructure/acp/agentClient.ts` 与 `G:/Project/prism-desktop/src/App.tsx` 的启动状态读取链。
- 具体改法：
  1. 在 `setup` 中取得主窗口后，读取 active runtime 的真实状态，调用统一的 `emit_agent_status` 广播一次 `pylon:agent-status`；不要复制 payload 构造逻辑。
  2. 更稳妥地为前端增加一次 `agent_status` command 查询，在 bootstrap 完成 `list_agents` 后写入 `runtimeStore.agentStatuses`；事件 listener 继续负责后续状态变化。
  3. 两种初始化来源只能选一个作为主路径，避免启动时重复状态闪烁；推荐“command 初始快照 + event 增量”模式，因为它不依赖 listener 注册时序。
- 影响面：不改变 ACP/会话业务行为，只补齐前端运行时状态初始化；状态灯、能力 gate、错误状态显示会从“缺失/全灰”变为真实状态。
- 验证方式：
  1. Release 冷启动，记录 `agent_status` 返回或 `pylon:agent-status` payload。
  2. 断言 titlebar 状态灯为 connected/connecting/error，而不是无状态全灰。
  3. 断开 Peri 后断言状态转为 crashed/disconnected，并能恢复为 connected。
  4. 发送一条消息，确认 InputBar 的可用性与实际 Agent 状态一致。
- 风险与取舍：增加一次 IPC 查询或一次启动事件；推荐 command 快照，代价是启动时多一次极小 IPC，收益是不会丢失早于 listener 注册的状态事件。

方案 B（修复消息显示契约，解决“输入栏滞留/用户消息不立即出现”）：
- 改动位置：`G:/Project/prism-desktop/src/components/chat/InputBar.tsx`、`G:/Project/prism-desktop/src/components/chat/chatEventController.ts` 或 `src/components/chat/sessionRuntimeStore.ts`。
- 具体改法：
  1. 发送动作进入 pending 后立即将用户消息 dispatch 到当前 source 的 Chat runtime，或者新增明确的 `send-optimistic-user` 事件。
  2. 发送成功后只负责确认/去重，不再依赖后端 `pylon:user` 才首次渲染。
  3. 发送失败时保留一条 error/system 消息并恢复可编辑输入，避免静默滞留；必须使用 client message id/round 标识，防止后端 `pylon:user` 到达后重复显示。
  4. 若保留当前后端回显作为权威，则至少在“发送请求已成功写入 ACP”后立即清空输入，但这仍不能解决事件 listener/ACP 失败时的无消息显示。
- 影响面：改变消息提交时序；用户消息会在网络/ACP 响应前出现。需要增加失败态和去重语义。【需拍板】是否接受 optimistic message 的失败回滚/错误展示。
- 验证方式：
  1. 人为延迟 `send_message` 返回，确认输入立即清空且用户消息立即出现。
  2. 模拟 `pylon:user` 迟到，确认不重复显示。
  3. 模拟 ACP 失败，确认用户消息保留、错误可见、输入可恢复。
  4. 切换会话再切回，确认 pending/failed 消息归属正确。
- 风险与取舍：需要定义消息唯一 ID、失败态以及与持久化/回放合并规则；推荐先完成方案 A，再根据产品决定是否实施方案 B。【需拍板】

方案 C（仅作为现场调查，不是修复）：
- 改动位置：Release 运行环境，不改代码。
- 具体改法：收集一次完整发送链路硬证据：
  1. Runtime 日志：`Agent lazy/initial connect started/succeeded/failed`、`Prompt started`、`Prompt connection closed`、`Session creation failed`、`Prompt completed`。
  2. Tauri 事件：确认 `pylon:user`、`pylon:update`、`pylon:done` 或 `pylon:error` 是否发出。
  3. 前端 console：确认 `注册聊天事件监听失败`、`发送消息失败`、`创建会话失败`、`恢复会话失败`。
  4. ACP stderr/stdout：确认 Peri 是否实际启动并完成 initialize/session/new/session/prompt。
- 影响面：无业务影响。
- 验证方式：以同一 source 的时间线对齐 IPC、Tauri event、ACP wire 和 runtime log，补齐当前“无回应”部分的 L1 证据。
- 风险与取舍：需要用户提供 Release 现场日志或允许下一轮直接启动 Release 并复现；本轮不以推断替代证据。

重构方案：
将“启动状态快照”和“状态增量事件”统一成显式的 Agent readiness contract：
1. 后端在 `setup` 完成后提供一次不可丢失的 `agent_status` snapshot。
2. 前端 bootstrap 先 hydrate snapshot，再注册/消费状态增量事件。
3. Chat controller 的 listener 注册状态和 Agent readiness 状态分别展示，避免把“Agent 未连接”“事件监听未注册”“发送请求等待”全部压成同一个 spinner 终态。
4. 发送事务建立明确状态机：`draft → pending → user-visible → streaming → done/error`，不要用 `invoke` Promise 是否完成同时承担 UI 清空、用户消息显示和后端业务完成三个职责。

当前结论：
【未能定位完整根因】。已定位并查证冷启动 Agent 状态未同步这一确定缺陷；“Agent 无回应/事件未渲染”的最终触发点仍需 Release 现场日志或 Tauri/ACP 抓包确认，不能据现有源码唯一归因。

---

追加调查说明（本轮，未回改前文）：

调查范围：
本轮获准读取 Peri 实际源码，并执行真实 Peri ACP wire 抓取、真实 LLM HTTP 请求、Pylon ACP 单元测试与真实 ACP 冒烟测试。未修改任何代码，未提交。

新增 L1 直接证据：

1. 真实 Peri ACP wire 已确认“prompt RPC 正常返回，但没有任何 assistant/thought/tool 事件”：
   - 抓取文件：`C:/Users/AlchemistCxC/AppData/Local/Temp/pylon-peri-wire.jsonl`
   - `initialize`：成功，返回 Peri `0.2.0`，能力包含 `loadSession=true`、`promptCapabilities.image=false`。
   - `session/new`：成功，返回 session id；配置选项显示 model alias=`sonnet`，实际模型名为 `deepseek-v4-flash`。
   - `session/prompt`：返回 `{ "stopReason": "end_turn" }`。
   - 整个 prompt 期间仅收到两个 `session/update`：`available_commands_update`、`usage_update`。
   - 没有收到 `agent_message_chunk`、`agent_thought_chunk`、`tool_call` 或 `tool_call_update`。
   - `usage_update` 为 `used=0`、`inputTokens=0`、`outputTokens=0`，`model=deepseek-v4-flash`。
   这与用户描述的“生成迅速结束、没有任何 Agent 消息”完全一致。

2. 同一台机器对 Peri 当前配置的真实 DeepSeek HTTP 请求已返回：
   - URL：配置中的 `https://api.deepseek.com/chat/completions`。
   - HTTP 状态：`402`。
   - 响应：`Insufficient Balance`，错误码 `invalid_request_error`。
   - 请求耗时：约 `592ms`。
   - 凭据未写入文档；只验证了当前配置存在 API key、base URL 为 `https://api.deepseek.com`、模型为 `deepseek-v4-flash`。

3. Pylon 自身真实 ACP 冒烟测试通过，但它只验证协议握手、`session/new` 和 prompt 低层 RPC，不代表 LLM 业务成功：
   - 命令：`cargo test --lib real_acp_smoke -- --ignored --nocapture`
   - 结果：2 passed。
   - 该测试使用当前 `agents.yaml` 默认 Agent，但成功断言的 prompt round trip 仅说明 Peri 返回了合法 ACP stop reason；不能证明有 `agent_message_chunk`。

4. Pylon fake ACP wire 单元测试通过：
   - 命令：`cargo test --lib acp::tests::fake_acp_subprocess_completes_initialize_new_and_prompt_wire -- --nocapture`
   - 结果：1 passed。
   - 说明 Pylon 的低层 ACP stdin/stdout、pending response 和 JSON-RPC 传输链路在可控 fake Agent 下工作。

新增唯一根因：
本轮已将“Agent 无回应、生成迅速结束”的根因定位为：DeepSeek API 账户余额不足导致 Peri 的 LLM 调用失败；Peri 随后仍把 ACP `session/prompt` 结束响应映射为 `stopReason=end_turn`，而实际错误事件没有进入 Pylon 当前消费的标准 `session/update` 通道，因此 Pylon 看到的是“无内容 + 正常结束”，最终表现为生成指示器迅速结束且没有 Agent 回复。

证据链：
- L1：真实 DeepSeek HTTP 返回 402 `Insufficient Balance`。
- L1：真实 Peri wire 同一 prompt 只有 `available_commands_update`、`usage_update`，无任何 assistant/thought/tool 事件，最后 `stopReason=end_turn`。
- L2：Peri `F:/A-I/Agent/Peri/peri-agent/src/llm/openai/stream.rs:54-70`：非 2xx 响应解析为 `AgentError::LlmHttpError`，不会生成文本 chunk。
- L2：Peri `F:/A-I/Agent/Peri/peri-agent/src/agent/stages/reason.rs:251-289`：LLM 失败时产生 `TurnError`，随后返回错误，不产生正常回答；错误还会发 `AgentExecutionFailed`。
- L2：Peri `F:/A-I/Agent/Peri/peri-acp/src/session/executor_helpers.rs:556-581`：`LoopResult::Error` 会发送 `AgentExecutionFailed`，但错误被映射为 `PromptStopReason::EndTurn`（除取消和最大轮数外，默认走 EndTurn）。
- L2：Peri `F:/A-I/Agent/Peri/peri-tui/src/acp_stdio/session/prompt_exec.rs:157-188`：无论 `result.ok` 是否为 false，都把该 stop reason 作为 ACP `PromptResponse` 返回给外部客户端。
- L2：Peri `F:/A-I/Agent/Peri/peri-acp/src/session/event_sink.rs:371-388`：stdio sink 的 `push_event` 只把可映射的标准 `SessionUpdate` 发给客户端；`AgentExecutionFailed` 在 `event/mapper.rs:201-205` 属于“其他事件”，不生成标准 `SessionUpdate`。
- L2：Peri `F:/A-I/Agent/Peri/peri-acp-types/src/peri_caps.rs:4-6,22-30`：`agentEvent` 与 `agentEventDone` 是自定义能力，默认 false。
- L2：Pylon `G:/Project/prism-desktop/src-tauri/src/lib.rs:604-633`：command 注册与 ACP dispatcher 链路只消费 `pylon:update`/`pylon:done`/`pylon:error` 等 Pylon 事件；Pylon 初始化 caps 也没有声明 Peri 自定义 `agentEvent` 通道。
- L2：Pylon `G:/Project/prism-desktop/src-tauri/src/dispatcher/mod.rs:734-765`：仅处理 `SessionUpdate`、权限请求和崩溃；未知 ACP notification 直接记录后丢弃。

因此，本轮不再把“Agent 无回应”标为未定位：
- 已定位业务失败根因：DeepSeek 当前账户余额不足。
- 已定位错误可见性缺陷：Peri 把 LLM 错误对应的执行结果归为 ACP `end_turn`，且错误事件不走标准 `session/update`；Pylon 因而收不到可渲染的错误消息。

对原条目中“用户本人发送的消息”现象的修正说明：
本轮 wire 证据确认后端低层确实没有生成 Agent 内容；但用户消息在 Pylon ChatView 中仍依赖 `pylon:user` 回显，且 InputBar 仍等待 `send_message` Promise 成功才清空。故“只有用户消息”同时由两层问题造成：
1. 业务层：LLM 失败，没有 assistant 内容。
2. 前端层：用户回显/输入清空时序不具备 optimistic 行为。

方案修正：

方案 D（当前业务根因，优先处理）：
- 改动位置：非 Pylon 代码，需在 DeepSeek 账户/Provider 侧补充余额或切换到可用 Provider/model。
- 具体改法：为当前 Peri 配置对应的 DeepSeek 账户充值，或将 `C:/Users/AlchemistCxC/.peri/settings.json` 中 active provider 切换到余额正常的 provider；不要在 Pylon 的 `agents.yaml` 里伪造模型名替代凭据问题。
- 影响面：恢复真实 LLM 调用，Pylon 现有 ACP 流式链路应收到 `agent_message_chunk`；不改变 Pylon 业务代码。
- 验证方式：
  1. 直接 HTTP 请求不再返回 402。
  2. 真实 Peri wire 中出现 `agent_message_chunk` 或 `agent_thought_chunk`，且 usage outputTokens > 0。
  3. 通过 Pylon 发送消息后出现 `pylon:update`，随后 `pylon:done`，不再是空内容快速结束。
- 风险与取舍：属于外部账户配置变更，不涉及代码风险。

方案 E（P1，修复错误被伪装为正常结束）：
- 改动位置：优先 `F:/A-I/Agent/Peri/peri-acp/src/session/executor_helpers.rs:556-581` 与 `F:/A-I/Agent/Peri/peri-tui/src/acp_stdio/session/prompt_exec.rs:183-188`；Pylon 侧配合 `G:/Project/prism-desktop/src-tauri/src/session/prompt.rs:571-607`。
- 具体改法：
  1. Peri 的 `LoopResult::Error` 不应在 ACP response 中统一转成 `EndTurn`；新增或使用明确的错误 stop/error response，至少保证外部客户端能区分 execution failed 与正常 end_turn。
  2. Peri 将 `AgentExecutionFailed` 转成标准 `session/update` 可消费的错误事件，或扩展 ACP error response；不能只放在默认关闭的 `agentEvent` 自定义通道。
  3. Pylon 收到 ACP prompt error 时广播 `pylon:error`，不要等到“合法 stopReason”后当成功完成；前端 reducer 已有 error 终态路径可消费。
  4. Pylon 对“`pylon:done` 但没有任何 assistant/thought/tool 内容”的回合增加诊断日志或协议告警，避免空成功静默结束。
- 影响面：会把当前静默失败变成明确错误消息；正常成功回合行为不变。
- 验证方式：用 fake LLM/HTTP 402 stub：
  1. Peri 返回业务错误；
  2. wire 不得只出现 `stopReason=end_turn`；
  3. Pylon 最终收到 `pylon:error`，ChatView 渲染错误消息；
  4. 余额恢复后仍能收到 assistant chunk 并正常 `pylon:done`。
- 风险与取舍：需要同时修改 Peri 与 Pylon 的协议契约；推荐先在 Peri 侧修正错误语义，再在 Pylon 侧加防御性空回合告警。

方案 F（P1，Pylon 前端交互契约，仍需产品拍板）：
- 保持原方案 B：发送后 optimistic render 用户消息并立即清空输入；后端错误用 error 消息收敛；通过 client message id 或 round 去重迟到 `pylon:user`。
- 该方案不能修复余额不足本身，但能避免用户消息在后端错误/等待期间滞留输入栏，并让失败回合在 UI 中可见。

Release 相关补充：
- `G:/Project/prism-desktop/scripts/pack_release.py:17-36` 只把 `pylon.exe` 和 `target/release/resources/**` 打进 zip，不打包 `agents.yaml`。
- `G:/Project/prism-desktop/src-tauri/src/agent_config.rs:515-531,597-607`：Release 优先读取 exe 同目录 `agents.yaml`；若 zip 未附带该文件则回退编译期嵌入配置。
- 当前 Release zip 实际内容已核验：只有 `pylon.exe` 与 `resources/fonts/SGr-IosevkaSS18.ttc`。这不是本轮“无回应”的根因，因为当前执行的真实 Peri wire 已确认底层失败来自 DeepSeek 402；但它会使 Release 无法热改外部 `agents.yaml`，并可能让用户误以为修改了配置却未生效。

本轮最终结论：
1. 【已定位】Agent 无回应/生成迅速结束的业务根因：DeepSeek API 返回 HTTP 402 `Insufficient Balance`。
2. 【已定位】错误静默化根因：Peri LLM error → `LoopResult::Error` → ACP `stopReason=end_turn`，且 `AgentExecutionFailed` 不映射为标准 SessionUpdate；Pylon 因此只能看到空回合正常结束。
3. 【已定位】前端输入滞留/用户消息显示延迟：Pylon 发送事务等待完整 `send_message` 返回，用户回显依赖后端 `pylon:user`，属于独立的前端交互契约问题。
4. titlebar 全灰仍是原先已定位的冷启动 Agent 状态快照缺失问题。

---

追加调查说明（Hermes Agent 新发现，本轮，未回改已有条目）：

用户新增复现：
“有一个新发现，就是 Hermes 有余额但是 Pylon 依然表现出：发送消息无回应（复现：切换 agent 到 Hermes，开新会话，发送消息，消息滞留，生成指示器空转。300s 后弹出超时）。”

对外部结论的核验结果：
外部结论的核心方向成立：Pylon 启动 Hermes 时必须固定 Hermes profile/runtime 环境；但其中“Pylon 只把 agents.yaml 的 env 传给子进程，因此子进程拿不到父进程环境”这一表述不准确。

源码事实是：
- `G:/Project/prism-desktop/src-tauri/src/acp/mod.rs:460-473` 使用 `Command::new(...).args(...).stdin(...).stdout(...).stderr(...)` 启动子进程；Windows 子进程默认继承 Pylon 自身环境。
- `G:/Project/prism-desktop/src-tauri/src/acp/mod.rs:465-469` 的 `current_dir` 与 `cmd.env(k, v)` 只是在继承环境上设置工作目录和覆盖/增加指定变量，并没有清空未列出的父环境。
- 因此，`agents.yaml` 的 `env` 不是“唯一能传递环境的机制”，但它是 Release GUI 场景中最可靠、可审计、与启动器脱钩的 profile 固定机制。

Hermes 实际配置链已查证：
- `F:/Hermes/hermes-agent/acp_adapter/entry.py:101-113,235-240`：Hermes ACP 启动时调用 `_load_env()`，从 `get_hermes_home()/.env` 加载环境变量。
- `F:/Hermes/hermes-agent/hermes_constants.py:55-77`：`HERMES_HOME` 已设置时直接使用该目录；未设置时才回退平台默认目录。
- `F:/Hermes/hermes-agent/acp_adapter/session.py:597-645`：ACP session 创建时读取 Hermes config，并通过 `resolve_runtime_provider(...)` 解析 provider、base_url、api_key，随后构造 Agent。
- 当前正确可用的 Profile 已实际验证为 `F:/Hermes/profiles/riccati`，其中 `.env` 与 `config.yaml` 均存在。
- 当前 `F:/Hermes/active_profile` 内容为 `l-m`。这说明 `HERMES_HOME=F:/Hermes` 不是 Riccati profile，而是 Hermes root；启动 Hermes bare ACP 时会依赖 active profile 机制，当前可能落到 `l-m`，不能把它当作 Riccati runtime。
- 当前 `F:/Hermes/config.yaml` 的 model provider 为 `nous`，而 `F:/Hermes/profiles/riccati/config.yaml` 的 provider 为 `deepseek`、model 为 `deepseek-v4-flash`、base URL 为 `https://opencode.ai/zen/go/v1`。两者不是同一份配置。

新增 L1 复现实验证据：

1. Pylon 同等 subprocess 配置、明确 `HERMES_HOME=F:/Hermes`：
   - ACP `initialize` 成功。
   - `session/new` 成功。
   - `session/prompt` 返回 `stopReason=end_turn`，但唯一 Agent 文本为 `HTTP 401: Invalid API key.`。
   - stderr：Hermes 加载 `F:/Hermes/profiles/l-m/.env`，实际请求 `https://opencode.ai/zen/go/v1`，返回 `HTTP 401: Invalid API key.`。
   - 抓包：`C:/Users/AlchemistCxC/AppData/Local/Temp/hermes-root-active-wire.jsonl`
   - stderr：`C:/Users/AlchemistCxC/AppData/Local/Temp/hermes-root-active-stderr.log`

2. Pylon 同等 subprocess 配置、明确 `HERMES_HOME=F:/Hermes/profiles/riccati`：
   - ACP `initialize`、`session/new`、`session/prompt` 全部成功。
   - 收到 `agent_thought_chunk`、`agent_message_chunk`，最终文本为“收到”。
   - prompt response 含 `stopReason=end_turn`、`inputTokens=16764`、`outputTokens=38`，并记录实际 API 调用成功。
   - 抓包：`C:/Users/AlchemistCxC/AppData/Local/Temp/hermes-riccati-wire.jsonl`
   - stderr：`C:/Users/AlchemistCxC/AppData/Local/Temp/hermes-riccati-stderr.log`

3. 清除 `HERMES_HOME`、`DEEPSEEK_API_KEY` 后启动 Hermes：
   - `initialize` 成功，但 `session/new` 返回 JSON-RPC `-32603 Internal error`：`No LLM provider configured`。
   - 这条实验没有复现 300s 超时，而是更早失败；它证明“未固定 Hermes_HOME 时，Hermes 可能落入错误配置/无 Provider 配置”，但不能把 300s 超时本身直接归因于该单一分支。

4. Pylon 真实 ACP 冒烟测试使用：
   - `PYLON_AGENTS_CONFIG=C:/Users/AlchemistCxC/AppData/Local/Temp/pylon-hermes-no-env.yaml`，并清除 `HERMES_HOME`、`DEEPSEEK_API_KEY`：prompt smoke 在 `session/new` 处直接失败，命令退出码 101。
   - 同样的 `pylon-hermes-env.yaml` 增加 `env.HERMES_HOME: F:\Hermes\profiles\riccati` 后，prompt smoke 通过。
   - 两份临时验证配置没有写回项目；Pylon 代码没有修改。

当前唯一已证实根因：
Hermes 有余额不等于 Pylon 启动的 Hermes 子进程使用了有余额的 Hermes profile。Release GUI 进程启动链没有可靠固定 `HERMES_HOME`，而 Hermes root `F:/Hermes` 当前 active profile 为 `l-m`；该 runtime 与可用的 `riccati` profile 不同。实际验证显示：使用 root/active profile 会进入 `l-m` 配置并收到 401，使用 `F:/Hermes/profiles/riccati` 才能成功完成 prompt。因此本问题的根因是 Hermes ACP 子进程的 profile/runtime 选择不确定或错误，导致实际使用错误的 key/base URL，而不是“DeepSeek 账户余额不足”。

关于“300s 超时”的精确结论：
- Pylon 的 `G:/Project/prism-desktop/src-tauri/src/session/prompt.rs:551-558` 对默认 ACP 协议使用 `prompt_timeout=300s`，超时后才发送 `session/cancel`。
- `G:/Project/prism-desktop/src-tauri/src/acp/jsonrpc.rs:133-169` 的 `wait_prompt_with_cancel` 在 300s 内没有收到 prompt response 才进入取消结算，因此“300s 后弹超时”证明的是 Pylon 没有收到 Hermes 的 prompt response；它不能单独证明 Hermes 没有收到 API 错误或没有产生内容。
- 本轮可控环境中，Hermes 对 root 错误会很快发送错误文本并 `end_turn`，对 Riccati 正常发送文本并 `end_turn`；Release 现场的 300s 版本仍需要读取 Pylon/Hermes 对应时间段的真实 stderr/wire，排除“ACP response 被阻塞、Pylon listener/dispatcher 未启动、Hermes 进程路径不是当前 wrapper”等分支。

对原 #1 根因说明的修正：
- 原文已将“Agent 无回应”归因于 DeepSeek 402；该结论只适用于先前实际抓取的 Peri/DeepSeek 配置，不适用于当前新增的 Hermes 复现。
- Hermes 新复现的业务根因应独立记录为“错误 Hermes profile/runtime 导致错误凭据/endpoint”，并与 Peri 的 DeepSeek 402 证据分开，不覆盖、不混淆。
- 本轮发现还暴露出一个独立的错误可见性问题：Hermes 即使收到 401，也会发送文本 chunk 后返回 `end_turn`；Pylon 若没有收到这些 chunk 而最终等到 300s，则应继续追查 ACP response 回传链，而不是只看最终超时。

推荐方案 G（推荐，固定 Hermes Profile，不向 YAML 写入明文 API key）：
- 改动位置：`G:/Project/prism-desktop/agents.yaml` 的 `agents.hermes` 段。
- 具体改法：增加：
  ```yaml
  env:
    HERMES_HOME: F:\\Hermes\\profiles\\riccati
  ```
  保留 key 在 Hermes profile 的 `.env`，不要把 `DEEPSEEK_API_KEY` 明文写进项目仓库的 `agents.yaml`。
- 影响面：只改变 Hermes ACP 子进程使用的配置 profile；不改变 Pylon 的 ACP wire 契约。
- 验证方式：
  1. 以 Release 同等环境启动并确认 Hermes stderr 出现 `Loaded env from F:\\Hermes\\profiles\\riccati\\.env`。
  2. 确认 provider=`deepseek`、base URL=`https://opencode.ai/zen/go/v1`、model=`deepseek-v4-flash`。
  3. `session/prompt` 必须收到 `agent_thought_chunk`/`agent_message_chunk` 与最终 response。
  4. Pylon 侧发送消息不得等满 300s；若仍超时，抓取同一 session 的 ACP stdout/stderr 继续定位。
- 风险与取舍：路径绑定到本机 Hermes 安装，Release 迁移到其他机器时会失效；更好的长期方案是通过用户设置选择 Hermes profile，而不是把开发机绝对路径硬编码进仓库配置。【需拍板】

推荐方案 H（长期，Release 可迁移）：
- 改动位置：Pylon Agent 配置/设置 UI 与 `src-tauri/src/agent_config.rs` 配置加载层；不把 secret 落盘到项目 YAML。
- 具体改法：为 Agent 增加非 secret 的 `env_file` 或 `hermes_profile` 配置语义：
  1. `hermes_profile: riccati` 由 Pylon 解析为用户 Hermes 根目录下的 profile 路径。
  2. Windows GUI 启动时显式构造 `HERMES_HOME`，并在 runtime diagnostics 中只记录 profile 路径与 provider 名，不记录 key。
  3. 启动后通过 ACP initialize/session/new 的诊断 payload 暴露实际 agentInfo、modelId、provider/base_url（脱敏），避免“有余额但实际没用上”无法判别。
  4. 对 Hermes spawn 失败、session/new error、prompt response timeout 分别记录结构化日志，不把三者归并成一个 spinner。
- 影响面：新增配置语义和诊断能力；不改变正常 Agent 对话行为。
- 验证方式：跨机器使用不同 Hermes profile，确认 Pylon 能根据用户选择启动对应 profile；模拟 profile 不存在时应在连接阶段显示明确错误，而不是等 300s。
- 风险与取舍：需要产品/配置契约设计；推荐作为后续架构修复。

推荐方案 I（防御性超时与错误可见性）：
- 改动位置：`G:/Project/prism-desktop/src-tauri/src/session/prompt.rs:551-569`、`src-tauri/src/acp/transport.rs`、Hermes ACP 连接诊断路径。
- 具体改法：
  1. 将 Hermes 专用 prompt timeout 从默认 300s 下调为较短值，或使用 `acp.prompt_timeout_secs` 配置；该字段已支持配置化。
  2. session/new 返回 JSON-RPC error 时立即向前端发 `pylon:error`，不要进入等待 prompt 的 300s 路径。
  3. 对已收到 `agent_message_chunk`/`agent_thought_chunk` 但未收到最终 response 的回合，区分“流式内容已到、终态缺失”与“完全无输出”。
  4. 日志增加 request id、session id、agent id、HERMES_HOME（仅路径）和 response/notification 时间线。
- 影响面：改变超时等待时间与错误展示时机；正常回合不变。
- 验证方式：fake Hermes 分别模拟：无 provider、401、只发 chunk 不发 response、完全无输出；确认前端分别显示连接错误、业务错误、终态超时、无输出超时。
- 风险与取舍：过短 timeout 可能误杀慢模型；应先用 Hermes/Peri 分 agent 配置，不要全局统一下调。

本轮最终结论：
1. 【已定位】Hermes 新复现不是余额问题，而是 Pylon 启动的 Hermes 子进程未可靠固定到可用 `riccati` profile；root/active profile 实际加载 `l-m`，验证结果为 401，riccati profile 验证结果为正常回复。
2. 外部结论关于“需要通过 agents.yaml env 固定 Hermes 环境”的方向正确；但“Pylon 不继承父进程环境”不成立。准确说法是：继承关系依赖 Release GUI 启动环境，不能作为稳定的 profile 选择契约。
3. 推荐立即在 `agents.hermes.env` 固定 `HERMES_HOME`，不写明文 API key；长期改为用户可选择、跨机器可迁移的 `hermes_profile` 配置。
4. 300s 超时的最终 response 丢失点尚保留【待验证】；本轮已证明 profile 选择错误这一上游根因，并为正确 profile 建立了成功 wire 对照。

---

修复记录（2026-08-08，查证后实施）：

方案 A（已实施）——冷启动 Agent 状态同步缺口：
- 查证属实：`src-tauri/src/lib.rs` 冷启动连接默认 agent 成功只写 `status=Connected`，不广播 `pylon:agent-status`；前端 bootstrap 只注册 listener 不查初始状态。
- 修复：前端在 bootstrap `list_agents` 后调用已注册的 `agent_status` command 拉取初始快照写入 `runtimeStore.agentStatuses`（command 快照 + event 增量，避免重复状态闪烁）。
  - `src/infrastructure/acp/agentClient.ts`（新增 `agentStatus()`）
  - `src/app/bootstrap/bootstrapApplication.ts`（可选 `fetchAgentStatus`/`applyAgentStatus` 步骤，失败不降级）
  - `src/App.tsx`（传入实现，key 约定与 `pylon:agent-status` listener 一致）
- 验证：titlebar 状态灯从“全灰/未知”变为真实状态；发送/附件 gate 随真实连接状态恢复。

方案 G 演进（已实施，替代硬编码路径）——`hermes_profile` schema 支持 + 自动探测：
- 查证属实：`exe: hermes` 命中 PATH 的 `hermes.bat`（设置 `HERMES_HOME=F:\Hermes` 但不带 `-p`），Hermes 走 active_profile 机制（`l-m` → 401）；`riccati` profile（deepseek + opencode.ai）可用。
- 修复：
  - `AgentDef` 新增 `hermes_profile` 字段（profile 名或路径，相对路径按配置目录解析）。
  - 新模块 `src-tauri/src/hermes.rs`：`detect_hermes_home`（env → PATH 脚本解析 → 平台默认）、`list_profiles`、`resolve_profile_dir`、`hermes_home_override`。
  - `src-tauri/src/acp/mod.rs`：`hermes_profile` 存在时注入 `HERMES_HOME=<profile 目录>`。
  - `src-tauri/src/startup.rs`：`StartupDiagnostics.hermesProfile`（只暴露 profile 名与 resolved，不暴露路径）。
  - `agents.yaml`：hermes 段配置 `hermes_profile: riccati`（可迁移；换机器改 profile 名即可）。
  - 前端 `runtimeLogContracts.ts`/`RuntimeSheetView.tsx`：Runtime 调试页展示探测结果。
- 验证：真实 Hermes 端到端冒烟（`real_acp_smoke::hermes_configured_profile_real_prompt_round_trip`）通过——注入后 Hermes 加载 `riccati/.env` 并完成真实 prompt。

方案 B（已实施，用户拍板）——前端乐观渲染契约：
- 查证属实：InputBar 等 `send_message` 整回合返回（最长 300s）才清空输入；用户消息依赖后端 `pylon:user` 回显才渲染。
- 修复：
  - `src/components/chat/sessionRuntimeStore.ts`：新增 `optimistic-user`/`confirm-user` 事件；`optimistic-user` 立即渲染用户消息并启动生成态，`confirm-user` 按 `clientMsgId` 去重确认。
  - `src/components/chat/chatEventController.ts`：`pylon:user` listener 对同内容乐观消息只确认不重复追加；handle 暴露 `sendOptimisticUser`/`confirmUser`。
  - `src/components/chat/InputBar.tsx`：发送动作 pending 后立即 `sendOptimisticUser` + 清空输入；失败保留乐观消息（错误由 `pylon:error` 或可见提示呈现）。
  - `src/components/chat/messageTypes.ts`：`Message.clientMsgId`。
- 验证：reducer 测试覆盖乐观渲染/去重/迟到回显/失败收敛（error 回合保留用户消息 + assistant error 消息）。

验证基线：`cargo test --lib` 416 passed（+3 ignored 真实冒烟）；前端 vitest 178 passed（34 files）；tsc/lint 干净。

---

修复记录（2026-08-08，续，方案 I）：

方案 I（已实施）——防御性超时与错误可见性：
- 查证现状：
  1. `acp.prompt_timeout_secs` 已支持配置化（`agent_config.rs AcpProtocolConfig`，`prompt.rs` 已消费），只是 agents.yaml 未启用。
  2. session/new 失败（Hermes 无 provider/401 等在此时失败）只记日志 + 传播 Err，**不发 `pylon:error`**——用户看到"消息滞留 + 生成指示器空转"。
  3. 超时路径只有统一文案 `timed out after 300s`，不区分"流式内容已到、终态缺失"与"完全无输出"。
  4. 日志缺 request id / agent id / HERMES_HOME（仅路径）。
- 修复：
  - `agents.yaml`：hermes 段新增 `acp.prompt_timeout_secs: 90`（分 agent 配置，Peri 保持 300s 默认，不全局下调防误杀慢模型）。
  - `src-tauri/src/session/prompt.rs`：`ensure_session_mapping` 失败时立即广播 `pylon:error` + 记 `Prompt session ensure failed` 日志（不再静默传播）；超时分支区分 `hasStreamedContent`（读取 `last_response_text` 是否非空）并随日志输出 `requestId`/`sessionId`/`agentId`；连接关闭分支同样补充三字段。
  - 新增测试：`session_new_failure_logs_ensure_failed_and_returns_error`（session/new JSON-RPC error → Err + 日志）；`prompt_timeout_without_content_logs_distinguished_fields`（1s 参数化超时 → 快速返回 + hasStreamedContent=false + 三字段）。
- 验证：`cargo test --lib` 418 passed（+3 ignored）；真实 Hermes 端到端冒烟通过（36.3s，hermes_profile + 新超时配置组合正常）；前端 178 passed 无回归。

---

### 源码复核后的实施细化

1. 冷启动链保持 `list_agents → agent_status → registerListeners`；快照查询应在 listener 注册前完成，但要用 cancelled guard 防止卸载后迟到写入。
2. `agentStatus()` 当前只查询 active agent；若后续允许后台 runtime 状态展示，再升级为 `list_agent_statuses`，不要在 #1 偷渡多 Agent contract。
3. 发送事务按 `draft → pending → optimistic user → streaming → done/error` 分层：清空输入只绑定 optimistic dispatch，不绑定整个 `send_message` Promise。
4. 错误回合至少保留 client message id、source、generation；迟到 `pylon:user` 只 confirm，不重复追加。
5. Release 验收要分开确认：Peri 402、Hermes 401/profile、ACP prompt response、`pylon:update/done/error`、前端 reducer；“titlebar 已亮”不证明 LLM 成功。

可行性：高，文档已有实施记录，当前源码也已存在 `agentStatus()`、bootstrap 快照和 optimistic action；后续重点是回归与 Release 现场证据。

---

验收修复记录（2026-08-09，Release 验收发现并修复）：

问题 1：发消息无回应（有时有回应但极慢）：
- 根因（探针实证）：Hermes（deepseek via opencode.ai）prompt 首 token 延迟实测 ~92s（initialize 3s、session/new 19s、prompt 回复 92s）。方案 I 把 hermes `prompt_timeout_secs` 调到 90s → 90s < 92s，Pylon 在回复即将到达时误判超时（发 session/cancel + 移除会话映射）→ "无回应"。
- 修复：`agents.yaml` hermes 段 `prompt_timeout_secs: 90 → 180`（留 2 倍余量；Peri 保持 300s）。
- 证据：探针 wire 抓取显示 Hermes 完整 prompt 流程 92s 完成（thought/message chunks + end_turn），180s 充裕。

问题 2：每次回到有回应的会话，消息复制一遍：
- 根因（两轮独立验证迭代定位）：`commitReplay` 合并 live 增量与 replay 权威时按 **id 去重**——但 reducer 的 live/replay 共享单调 seq，同一逻辑消息的两个副本 id 恒不同（user-3 vs user-7），id 去重是死代码。
- 修复：`chatEventController.ts` 新增 `mergeReplayMessages` + `messageDedupKey`，按**内容签名**（role+sender+content；tool 消息从 id 内嵌 toolCallId 派生 `tool-` 前缀）去重。commitReplay 使用该函数。
- 迭代：第一版读 `m.toolCallId` 字段（reducer 从不写入）→ tool 签名坍缩为 `tool:` 误删不同调用；改为 id 派生后修复（与 `domains/tool/id.ts` 既有 `slice(5)` 约定一致）。
- 已知限制（文档化）：load 窗口内连发字节相同内容且历史亦含时，只留权威一份（概率极低，load 完成后不受影响）。
- 测试：`mergeReplayMessages` 6 个纯函数用例 + `replayE2E.test.ts` 端到端（真实 controller+reducer 复刻对抗场景：live 乐观消息 vs replay 权威、live tool 消息不被误删）。
- 验证：独立验证 3 轮（FAIL→FAIL→PASS）；`vitest` 186 passed（35 files）；tsc/lint 干净；`cargo test --lib` 418 passed（4 ignored，含 hermes_connect_idle 冒烟）。

问题 2 追加（2026-08-09 夜，用户复测仍失败——串会话 + 复读叠加依旧存在）：

**问题定位**：上述补丁式修复（内容签名去重 / persona 前缀剥离 / !eventReplay 条件）只解决了单条消息的重放去重，未触及重放合并模型的根本缺陷：
- 旧 `commitReplay` 用 `liveAdditions = existing.messages.slice(cached.length)` 按**位置**识别 load 期间 live 增量——切换会话时 messages 与 cached 的位置对应被破坏，导致叠加。
- 切换会话时旧 source 的 `replaying` 缓冲残留未清，新一轮 load 的完整重放追加到残留 → 重复。
- 多个会话切换时，`initSource` 对已存在 source 直接返回内存消息，与 localStorage cached 不同步 → 串会话/串显示。

**重放重新设计（已实施，2026-08-09 夜）**：
- `src/components/chat/sessionRuntimeStore.ts`：`SourceChatRuntime` 新增 `loadBaseSeq?: number`（load 开始时的 seq 快照）。
- `src/components/chat/chatEventController.ts`：
  - `initSource`：切换回会话时清空残留 `replaying` + 设 `loadBaseSeq = 当前 seq`；cached 与内存不同步时重置为 cached。
  - `commitReplay`（重写，移除 slice）：以 `replaying` 为权威整体重建 messages；live 增量 = messages 中 id 尾部数字 > `loadBaseSeq` 的消息（乐观 user/流式 assistant/tool）；按内容签名去重后并入；清 replaying/loadBaseSeq。
- `scripts/test-settings-layout.mts:105` 契约断言更新为新方案。
- 新增测试：`sessionSwitch.test.ts`（多次切换不叠加不串 / load 期间发新消息正确合并 / load 未完成残留切回不重复）。
- 基线：`vitest` 190 passed（36 files）；`cargo test --lib` 422 passed；tsc/lint 干净；release 已重建（02:20）。

**现状（2026-08-09 最新验收结论）：未收敛，停止继续修复。**
- 用户已对 02:20 Release 及后续两轮重放修复 Release 进行真实应用验收，复读/串会话现象仍可复现；因此此前“controller 级模拟测试全绿”“原子 replay snapshot”“loadBaseMessageIds 仅合并本轮 live 增量”等实现均不得标记为修复完成。
- 已尝试但未获真实验收通过的路径：内容签名去重、persona 前缀剥离、`!eventReplay` 分流、`loadBaseSeq`、`loadBaseMessageIds`、后端 command 返回 replay snapshot、dispatcher 抑制 load 期间 replay 增量、snapshot 原子提交。
- 当前自动化证据仅证明受控模型通过：前端 36 files / 192 tests、replay focused 8 tests、后端 422 passed、lint/build/diff check 通过；这些证据不能替代真实 GUI 竞态验收。
- 当前状态：问题 #1 中的会话重放子问题保持 **P1 未收敛 / Release 阻塞**。不得继续宣称“不叠加、不串会话”，不得提交或发布当前重放修复为已完成方案。
- 后续若重新启动调查，必须先取得一次真实失败的完整证据：精确操作序列、受影响 sessionId/source/periId、`load_persisted_session` response replay 数量与顺序、同时间线 `pylon:user/update/done/error`、切换前后 `pylon-msgs-*` localStorage 快照、controller runtime 每 source 消息摘要。没有这组证据前，不再追加猜测式去重补丁。

---


## 逐项验收清单

### 6.7 问题 #1：冷启动、消息提交与 Agent 无回应链路

#### 等级 1：测试通过

| 相关功能 | 验收行为表现 | 验收地址 | 结果 |
|---|---|---|---|
| bootstrap 初始快照 | 顺序为 `list_agents → agent_status → registerListeners`；取消后迟到结果不写 store | `src/app/bootstrap/__tests__/bootstrapApplication.test.ts` | [ ] |
| optimistic user message | pending 后立即渲染并清空输入；迟到 `pylon:user` 只 confirm 不重复 | `src/components/chat/__tests__/chatEventInvariants.test.ts`、`chatRuntimeBridge.test.ts` | [ ] |
| error/timeout 收敛 | session/new error、无内容 timeout、已有流内容 timeout 分别进入明确错误路径 | `src-tauri/src/session/prompt.rs` focused Rust tests；Chat reducer tests | [ ] |
| Hermes profile | `hermes_profile` 能解析并注入正确 `HERMES_HOME`，不记录 secret | `src-tauri/src/hermes.rs`、`real_acp_smoke.rs` | [ ] |

#### 等级 2：前端网页验收通过（仅限前端）

| 相关功能 | 验收行为表现 | 验收地址 | 结果 |
|---|---|---|---|
| 乐观消息 | 点击发送后输入框立即清空，用户消息立即进入对话区，生成态开始 | `http://localhost:5173/` → Agent Sheet → Chat/InputBar | [ ] |
| 迟到回显/错误 | mock `pylon:user` 不重复；mock error 后保留用户消息并显示 assistant/system error | `http://localhost:5173/` → Agent Sheet 对话区 | [ ] |
| 冷启动状态壳 | mock 初始 status 后 titlebar、Settings、InputBar gate 一致 | `http://localhost:5173/` → titlebar + Agent Sheet | [ ] |

#### 等级 3：真实应用验收通过

| 相关功能 | 验收行为表现 | 验收地址 | 结果 |
|---|---|---|---|
| Release 冷启动 | 进入已有/新会话时状态灯不是无事实全灰；发送可用性与真实 Agent 状态一致 | Release `pylon.exe` → Agent Sheet | [ ] |
| Peri 成功链 | direct HTTP 可用；ACP wire 有 assistant/thought chunk；Pylon 收到 update→done；UI 有回复 | Release/真实应用 → Peri 会话；Runtime Sheet；ACP wire 文件 | [ ] |
| Hermes 成功链 | stderr 确认加载目标 profile；prompt 不等满 timeout；UI 收到真实回复 | Release/真实应用 → Hermes 会话；Runtime Sheet | [ ] |
| 故障可见性 | 402、401、无 provider、session/new error、prompt timeout 分别显示可辨别错误 | Release/真实应用故障注入；Runtime Sheet | [ ] |

## 施工日志

| 2026-08-09 | 拍板决策同步 | 已将本轮已确认的产品决策与当前实施成熟度写入“已拍板决策”。未形成措施的内容明确标注为仅有决策。 | 关联未决策项见 `未决策项.md` |
| 日期 | 类型 | 记录 | 证据/备注 |
|---|---|---|---|
| 2026-08-09 | 文档拆分 | 从 `docs/release-issues.md` 拆分为 `ISSUE-06`；保留原问题记录、追加调查、修复记录与三级验收内容。 | 本文件生成于 Issue Library 初始化 |
| 2026-08-09 | 产品拍板 | runtime 崩溃时未完成 prompt 统一收敛为 interrupted，禁止自动重发。 | 与 ISSUE-01 D-07 对齐 |
| 2026-08-09 | 产品拍板 | 旧 ACP 历史后台导入失败保留已导入数据，指数退避自动重试，并提供手动重试与诊断。 | 对应未决策项：后台导入失败策略 |
| 2026-08-09 | 产品拍板 | SQLite 消息历史保留策略进入设置，支持永久、按时间和按 Session 数量保留。 | 对应未决策项：消息保留策略 |
| 2026-08-09 | 产品拍板 | 删除 Session 时，Agent 支持则同步删除远端历史；不支持/失败不阻塞本地删除，但必须明确记录残留。 | 对应未决策项：Agent 侧历史删除 |
| 2026-08-09 | 产品拍板 | 未被后端确认的 optimistic 用户消息在重启后恢复为 interrupted，保留并允许原地重试，不自动重发。 | 对应未决策项：应用退出时 pending 用户消息恢复语义 |
| 2026-08-09 | 产品拍板 | permission request/response 必须按 Agent/Session/request/generation 精确路由。 | 与 ISSUE-01 D-08 对齐 |
|  |  |  |  |


## 本轮源码核验与可验收子任务（2026-08-09）

### 逐条源码核验矩阵

| 原主张 | 判定 | 当前源码证据 | 方案修正 |
|---|---|---|---|
| optimistic 与 replay 控制器已经存在 | 属实 | `src/components/chat/chatEventController.ts:39-45,285-404,438-468` | 保留现有结构作为调查对象，不再追加无真实证据的去重补丁。 |
| SQLite 消息仓库已经完成 | 不属实 | 当前 `src-tauri/Cargo.toml`/源码未发现 `rusqlite`/`sqlx` 消息仓库实现 | 先做 `I06-A-DATA-01` schema/事务/恢复 vertical slice。 |
| 自动化测试证明复读已修复 | 不属实 | 本 Issue 最新施工日志明确真实 GUI 仍复现；自动化只证明受控模型 | `I06-A-FE-03` 先采集真实完整时间线，L1 不替代 L3。 |
| chunk/恢复/保留策略未决 | 已拍板 | ISSUE-06 D-15/D-16/D-17 | 直接转为实现卡，不再阻塞于产品决策。 |


> 本节是本轮对当前源码的增量审计与执行切分。原编号只用于追溯；以下 task id 才是 Harness v2 的执行单位。

### 核验结论
- ✅ optimistic/replay 相关实现与测试确实存在，但 Issue 自己的施工日志明确记录真实应用仍可复现复读/串会话；因此状态必须保持阻塞，受控测试不能升级为 L3。证据：`src/components/chat/chatEventController.ts:285-407`、本文件施工日志最新结论。

### 子任务清单

| Task ID | 类型 | 归属 | 依赖 | 验收标准 | 最低证据 |
|---|---|---|---|---|---|
| `I06-A-DATA-01` | DATA | A | I05-A-FE-01 | 消息仓库 schema 与 attempt/interrupted 契约；当前源码无 SQLite 实现时不得宣称已完成；先冻结 schema、事务和 recovery 状态。 | L1 |
| `I06-A-FE-02` | BE | A | I06-A-DATA-01 | 冷启动与 optimistic send 收敛；发送后输入清空、user optimistic 渲染、失败/退出恢复为 interrupted，不自动重发。 | L1 |
| `I06-A-FE-03` | FE | A | I06-A-FE-02 | 真实 replay 失败证据采集与模型重建；在继续补丁前保存精确切换序列、source/session、IPC replay、localStorage、runtime 摘要；未取得证据不得宣称修复。 | L3 |
| `I06-B-UX-01` | UX | B | I06-A-FE-02 | 消息流式/中断状态的沉浸视觉承载；只改已冻结视觉承载层，interrupted/pending/streaming 可辨识，提供 reduced-motion。 | L2 |
| `I06-A-TEST-01` | TEST | S | I06-A-FE-03 | 真实 Tauri/ACP/SQLite Release 验收；分别证明 runtime、ACP 响应、消息持久化与 UI，不用受控 mock 替代。 | L3 |

### 本轮施工日志

| 2026-08-09 | 源码核验 + 任务切分 | 已对照当前源码建立证据结论；按一张卡一个独立可验收结果切分，B 视觉任务仅在基座/契约明确后进入。 | `docs/Issue Library/harness-v2/` |
