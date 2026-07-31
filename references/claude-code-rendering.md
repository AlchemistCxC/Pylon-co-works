# Pylon 前端优化与 Claude Code 能力借鉴文档

> 文档状态：前端持续施工基线
> 更新日期：2026-07-31
> 适用项目：`G:\Project\prism-desktop`
> 前端目录：`src/`
> Claude Code 参考源码：`references/claude-code-sourcemap/restored-src/src/`
> 约束：只改前端，不修改 `src-tauri/`；不改变既有视觉设计、ACP event 契约、replay、persistence 和 cancel 语义，除非单独获得后端契约验收结果。

---

## 0. 文档目的

本文件是 Pylon 前端优化的总施工文档，不再局限于消息列表性能。

Claude Code 值得借鉴的内容分为五类：

```text
1. UI/展示：消息行、ToolCard、搜索、plan、permission、diff 等可见能力。
2. 交互体验：command palette、input history、queue、快捷键、焦点管理。
3. Agent 工作流表达：plan、permission、task progress、compact boundary、diff。
4. 性能和可靠性：streaming 分离、静态 memo/cache、stalled feedback、搜索索引、动态列表。
5. 纯机械/架构整理：类型、纯函数、registry、错误边界、测试和渲染数据流拆分；不属于 UI 重排。
```

当前施工必须区分：

```text
纯机械/架构整理：可以直接落地，目标是降低耦合、保留行为，不宣称 UI 改版。
UI/交互施工：必须单独描述可见变化、布局边界和用户操作语义。
协议依赖施工：先核对 Peri ACP 实际源码，不能用前端模型伪造后端能力。
```

Pylon 不是 Claude Code 的终端复刻，不能直接移植 Ink/Yoga 或 Claude Code 的固定布局。
本项目是 Tauri v2 + React 19 + TypeScript + Zustand 的桌面应用，必须优先适配现有的：

```text
ChatView.tsx 的 ACP 事件入口
Message[] 持久化格式
session/source 隔离模型
现有 CSS 变量和 message layout
Peri ACP 当前实际 payload
Pylon 的设置项、主题和 widget 系统
```

核心原则：

```text
先读现有实现，再定义借鉴边界。
先建立可验证的前端模型，再增加 UI。
先做不改变协议的纯前端能力，再处理 ACP 依赖功能。
先做低风险交互和展示改进，再做 virtualization 等复杂性能系统。
无法证明静态，就重新渲染；无法证明产品语义，就不擅自聚合或隐藏。
真实运行时证据优先于 synthetic benchmark 和理论复杂度。
```

---

## 1. 当前前端源码地图

### 1.1 ChatView 当前职责

`src/components/chat/ChatView.tsx`（约 630 行）当前承担：

```text
Session 创建、load_persisted_session、replay 编排
stale source ref 清理（clearChatSourceRefs）
live streamingText / streamingThinking
sticky/user_scrolled/jumping 滚动状态
消息列表 map（MemoMessageRow + rowRef registry）
Ctrl+F 搜索 UI（MessageSearchBar + messageRefs 定位）
持久化 effect（rendered source 兜底写入）
MessageRow、AssistantContent、CodeBlock、ReasoningBlock、ToolCard、UserLine
```

ACP 事件入口已抽出（F5.7）：

```text
src/components/chat/chatEventController.ts
  └─ peri:user / peri:update / peri:done / peri:error / peri:clear
  └─ updateSourceMessages（后台持久化 + 渲染分发）
  └─ flushStreaming / start·stopGenerating / handleClear
  └─ 单调消息 ID allocator（F5.6）
```

现有关键代码边界：

```tsx
const preparedMessages = useMemo(
  () => prepareRenderableMessages(messages),
  [messages],
)

const messageLookups = useMemo(
  () => buildMessageLookups(messages),
  [messages],
)
```

live 文本已经分离：

```tsx
streamingTextRef.current += text
setStreamingText(streamingTextRef.current)

streamingThinkingRef.current += text
setStreamingThinking(streamingThinkingRef.current)
```

tool_call 到达前 flush：

```tsx
if (!replay) flushStreaming(source)
```

消息渲染当前使用 `MemoMessageRow`（行内注册自身 ref，不接收完整 messages）：

```tsx
preparedMessages.map(renderMessage => (
  <MemoMessageRow
    key={renderMessage.message.id}
    renderMessage={renderMessage}
    reduceMotion={reduceMotion === true}
    toolVisualState={resolveRowToolVisualState(renderMessage.message, messageLookups)}
    rowRef={node => { ... }}   // messageRefs registry，供搜索定位
    highlighted={searchMatches[searchIndex]?.id === renderMessage.message.id}
  />
))
```

### 1.2 当前消息类型

`tool_call` / `tool_call_update` 已在显示层派生为 `tool_call` / `tool_result`，不改变 Raw Message 持久化格式。

`src/components/chat/messageTypes.ts`：

```ts
export interface Message {
  id: string
  role: 'user' | 'assistant' | 'tool' | 'reasoning'
  sender: string
  content: string
  time: string
  toolName?: string
  toolInput?: string
  toolOutput?: string
  toolOutputLines?: number
  running?: boolean
  toolStatus?: string
}
```

显示层已开始从 Raw Message 推导独立显示语义：

```ts
export type RenderMessage =
  | { type: 'user'; message: Message }
  | { type: 'assistant'; message: Message }
  | { type: 'reasoning'; message: Message }
  | { type: 'tool_call'; message: Message; toolId: string | null }
  | { type: 'tool_result'; message: Message; toolId: string | null }
  | { type: 'error'; message: Message }
  | { type: 'system'; message: Message; reason: 'unknown-role' }
```

当前 visibility 规则：

```text
空 assistant 且不处于 running 状态 → skip
sender === 'system' 且 role === 'assistant' → error（永远保留）
未知 role → system（reason: 'unknown-role' fallback，禁止静默丢弃）
tool 有 toolOutput → tool_result；否则 → tool_call
```

当前仍不能表达：

```text
plan / compact boundary
permission request
task progress
grouped tool presentation
```

### 1.3 当前 ACP 前端已知事件

`src/components/chat/acpTypes.ts` 当前支持：

```text
agent_message_chunk
agent_thought_chunk
tool_call
tool_call_update
usage_update
available_commands_update
config_option_update
```

外层事件：

```text
peri:user
peri:update
peri:done
peri:error
```

当前不能假设已有以下事件：

```text
permission_request
plan_update
task_progress
compact_boundary
diff_update
file_suggestion
history_search
```

任何涉及这些事件的前端施工，必须先检查 Peri 实际源码或后端交接文档。不能为了让 UI 看起来完整而伪造事件。

### 1.4 当前 InputBar

`src/components/chat/InputBar.tsx` 当前已经包含：

```text
消息发送
Enter 发送 / Shift+Enter 换行
Escape 取消生成
Ctrl+C 取消生成，但有选中文本时保留浏览器复制
Ctrl+ArrowUp 恢复上一条消息
Shift+Tab 切换 session mode
Tab/ArrowUp/ArrowDown command 选择
动态 available commands
fallback commands
/model
/compact
/new
/export
/clear
/mode
附件选择
CLI textarea overflow layout
发送错误展示
```

command 已从 InputBar 抽离到：

```text
src/components/chat/commandRegistry.ts
src/components/chat/commandParser.ts
```

Input history（F4.2）已实现：

```text
ArrowUp/ArrowDown 在无 command suggestion 时浏览 history
history 按 session/source 隔离（historyBySourceRef），session switch 清理游标
Ctrl+ArrowUp 保留恢复上一条消息兼容行为
只记录发送成功的文本
```

Queued message（F4.2）已实现：

```text
生成中提交后续文本 → queuedMessages（可编辑/取消/清空）
sendQueued 逐条发送，成功即移除
不改变后端 send_message 契约
```

### 1.5 当前 GenerationFooter

`src/components/chat/GenerationFooter.tsx` 已有：

```text
spinner frame
中文/英文/自定义 spinner verb
spinner interval
elapsed time
token count
停止按钮
完成/取消/错误 summary
自定义完成、取消、错误 marker
stalled 检测（F6 已完成）：lastTokenAt 驱动
  active：最近 3 秒内有 token
  waiting：3 秒至 10 秒无 token
  stalled：超过 10 秒无 token
```

stalled 状态只使用局部 timer 状态（tick），不写入 Zustand；收到 token 立即回到 active。

### 1.6 当前 ToolCard

`ChatView.tsx` 内部的 `ToolCard` 已有：

```text
折叠/展开
tool name
tool summary
output
outputLines
Bash ANSI 输出转换
sanitizeHtml
tool visual status
status color
status indicator glow
连续 tool connector
Read/Grep/Glob/Edit/Write 输出行数摘要
结构化 diff 候选 → DiffCard（9f5fa3a 接入）
  diffPresentation.ts::normalizeDiffPayload（对象/JSON + unified diff 双路解析）
  isDiffCandidate 由 ToolPresentationModel 判定
```

当前仍缺少：

```text
diff 行模型与词级 diff（当前 makeLines 为逐行逐列简单比对，无 hunk/行号/词级）
tool progress 与最终 result 的独立 presentation
相邻 tool 的 derived grouping
工具输出搜索文本的专用 getSearchText
```

### 1.7 当前性能能力

已完成的纯机械/架构能力：

```text
renderMetrics、MessageRow memo、streamingText / streamingThinking 分离
sticky/user_scrolled/jumping 自动滚底
ToolVisualState、MessageLookups、ToolPresentationModel
静态 code highlight cache、plain-text fast path、MessageRenderBoundary
messageSearchIndex 纯函数 API 和分块预热
F5.6 单调消息 ID allocator（替换 Date.now() 消息 key）
F5.7 chatEventController 模块化
F5.9 包体懒加载（Settings/Launcher/Prism/RightPanel 按需分包）
```

已接入 UI：

```text
transcript search（F5 已完成）：Ctrl+F / MessageSearchBar / 上一个·下一个 / 命中序号
message highlight/navigation（F5）：messageRefs registry + scrollIntoView
stalled generation feedback（F6 已完成）：GenerationFooter activity 状态
```

已有观测接口：

```js
window.__PYLON_RENDER_METRICS__.snapshot()
window.__PYLON_RENDER_METRICS__.reset()
```

已有搜索 API：

```ts
getMessageSearchText(message)
messageMatchesQuery(message, query)
warmMessageSearchIndex(messages, batchSize)
```

---

## 2. Claude Code 借鉴原则

### 2.1 可以直接借鉴的内容

已完成的纯机械/架构项目不再作为待办重复列出；以下列表只保留可继续借鉴的方向。

这些内容不依赖 Claude Code 的终端渲染环境，适合转化为 Pylon React 实现：

```text
visibility 先于 grouping、render cap、virtualization
tool progress 与最终 result 的独立 presentation
Edit/Write diff presentation
工具输出搜索文本的专用 getSearchText
input history
queued commands/messages
stalled spinner feedback
compact boundary 的显示模型
plan/task/diff 的卡片化表达原则
permission UI 的风险和决策分层
```

### 2.2 不能直接移植的内容

以下内容只能借鉴原则，不能复制源码：

```text
Ink Box/Yoga 坐标系统
VirtualMessageList 的终端 scrollback 假设
OffscreenFreeze
固定 200 条 render cap
终端列宽作为唯一 layout 约束
终端 focus context
ANSI 输出作为唯一消息格式
Claude Code 专有 tool schema
Claude Code 专有 permission callback
Claude Code 专有 session state
```

### 2.3 Pylon 特有约束

Pylon 必须保留：

```text
CSS 变量驱动的主题系统
classic / claude / bubble message layout
free / peri footer layout
CLI 模式与普通输入模式
右侧 panel 和 workspace sheet
session source 与 session id 双层模型
localStorage 消息快照格式
Tauri invoke/listen
现有 ACP payload 兼容逻辑
用户自定义 spinner、tool indicator、connector、字体和布局
```

---

## 3. 总体目标架构

目标不是把所有组件立即拆成几十个文件，而是逐步形成以下边界：

```text
ACP events
    ↓
Event adapter / source isolation
    ↓
Raw Message[] + live generation state
    ↓
messagePipeline
    ↓
RenderMessage[] + RenderDecision + MessageLookups
    ↓
MessageRow
    ↓
MessageRenderBoundary
    ↓
MessageRenderer
    ├── UserMessage
    ├── AssistantMessage
    ├── ThinkingMessage
    ├── ToolCallMessage
    ├── ToolResultMessage
    ├── SystemMessage
    ├── ErrorMessage
    ├── PlanMessage
    └── Task/Permission presentation
```

Input 侧目标：

```text
InputBar
    ↓
input state machine
    ├── editing
    ├── command_suggesting
    ├── history_browsing
    ├── queued
    ├── sending
    ├── cancelling
    └── error
```

Tool 侧目标：

```text
raw ACP tool payload
    ↓
normalizeToolInput
    ↓
ToolPresentationModel
    ↓
ToolVisualState
    ↓
ToolCard / DiffCard / ProgressCard
```

关键边界：

```text
Raw Message[] 继续负责 replay/persistence。
RenderMessage[] 负责显示语义，不回写原始数据。
streaming state 不进入已提交历史，直到 flush。
UI grouping 不能改变 Message[]。
搜索索引不能重新 parse Markdown。
任何未识别状态必须有 fallback。
```

---

## 4. 施工总路线

### 阶段 F0：现状基线和证据闭环

状态：已接入观测，真实 ACP runtime 基线仍待补齐。

任务：

```text
确认 ChatView、InputBar、GenerationFooter、ToolCard 的真实 render 行为。
确认 live/replay/background/session switch/cancel 的事件顺序。
记录 streaming 期间 ChatView、MessageRow、Markdown、highlight、scroll 次数。
区分真实 Tauri/Peri runtime、浏览器 mock、synthetic DOM、React benchmark。
```

验收：

```text
npm run build
npm run test:frontend
git diff --check
真实 runtime 日志或录屏/抓包证据归档
```

禁止：

```text
不能用 mock ACP 数据宣称生产性能收益。
不能仅凭 messages.map 超过 16.7ms 启动 virtualization。
```

### F1.5：结构化 Diff presentation

优先级：中。

当前状态：基础版已完成（9f5fa3a 接入），增强待办：

```text
diffPresentation.ts::normalizeDiffPayload 已支持对象/JSON（oldText/newText/old/new/before/after）
  与 unified diff（@@/---/+++ 头检测）双路解析。
ToolPresentationModel::isDiffCandidate 判定，ToolCard 内渲染 DiffCard。
无法识别时继续使用普通 pre 文本。
```

待增强（对照 `references/claude-code-sourcemap/.../components/StructuredDiff/Fallback.tsx`）：

```text
当前 makeLines 是逐行逐列简单比对（无 hunk 语义、无行号、无词级 diff）。
参考 CC 行模型：transformLinesToObjects + processAdjacentLines（相邻 remove+add 配对）
  + calculateWordDiffs + CHANGE_THRESHOLD=0.4 回退整行 + numberDiffLines 行号。
400 行截断与 (truncated) 标注。
```

施工前置：

```text
先检查现有 ACP tool payload 和已持久化 toolOutput 是否包含 old/new、patch 或 unified diff。
不能仅凭 Edit/Write 工具名判定存在可渲染 diff。
```

不做：

```text
不扩展 ACP 协议。
不改变 Message 持久化格式。
不自动推断风险或成功状态。
不把 diff 改成独立页面或重排 ChatView。
```

### 阶段 F2.1：RenderMessage visibility pipeline

优先级：高。

当前状态：主要派生已完成，剩保守 fallback 核对：

```text
tool_call / tool_result / error / system(unknown-role) 纯派生类型已存在
  （messageTypes.ts::toRenderMessage，messagePipeline 消费）。
error message 永远保留（sender === 'system' 且 role === 'assistant'）。
未知 role → system（reason: 'unknown-role'），禁止静默丢弃。
空 assistant 且非 running → skip（decideMessageVisibility）。
test-render-decision-exhaustive / test-message-types-exhaustive 已覆盖。
```

仍缺：

```text
plan / compact boundary / permission / task progress 显示类型（依赖 ACP payload）。
```

目标：

```text
继续使用 Raw Message[] → RenderMessage[] → RenderDecision 的纯派生链。
保持 message 顺序、id、persistence 和 replay 语义。
```

不做：

```text
不修改 Message 持久化格式。
不新增 ACP event。
不做 tool grouping。
不做 UI 重排或 virtualization。
```

### 阶段 F3：Compact boundary 和 session recovery presentation

优先级：高。

当前基础：

```text
InputBar 已发送 /compact。
ChatView 已有 replay/load_persisted_session。
session persistence 已存在。
```

Claude Code 借鉴点：

```text
compact 前后边界明确。
用户知道上下文发生了压缩。
恢复过程不是空白等待。
恢复失败可以定位和重试。
```

前端第一版：

```text
将 /compact 作为普通发送事务继续发送。
等待现有 ACP 事件，不伪造 compact 成功。
如果后端输出能识别 compact summary，则在 pipeline 生成 system/compact row。
如果暂时无法识别，只完善前端 compact pending/error 状态。
```

候选显示类型：

```ts
{ type: 'compact_boundary'; message: Message; summary?: string }
```

不能做：

```text
不能根据 token 数自行宣称 compact 已完成。
不能从普通 assistant 文本中猜测 compact boundary。
不能删除 localStorage 历史来模拟压缩。
```

### 阶段 F4.2：Input history 和 queued message

优先级：高。

当前状态：**已完成**（9f5fa3a 接入）。

```text
command registry、live/fallback command 归一化和 slash command parser（更早完成）。
Input history：按 session/source 隔离（historyBySourceRef）；ArrowUp/ArrowDown
  在无 command suggestion 时浏览；Ctrl+ArrowUp 保留恢复上一条兼容行为；
  session switch 清理游标；只记录发送成功的文本。
Queued message：生成中提交后续文本 → queuedMessages（可编辑/取消/清空）；
  sendQueued 逐条发送成功即移除；不改变 send_message 契约。
```

验证：`test-input-history-ui.mts`、`test-queued-message-ui.mts`。

不做：

```text
不重排 InputBar。
不改变 command 执行语义。
不把队列伪装成后端已接受。
```

### 阶段 F5：Chat search UI

优先级：中高。

当前状态：**已完成**（9f5fa3a 接入）。

```text
src/components/chat/MessageSearchBar.tsx 已实现（query/matchIndex/matchCount/前后导航/关闭）。
搜索状态在 ChatView 内部（searchOpen/searchQuery/searchIndex useState），未单独拆
  messageSearchState.ts（保持现状，不为拆而拆）。
Ctrl+F 打开当前 session 搜索；session 切换清空 query 与命中。
messageMatchesQuery 纯函数索引，不重新 parse Markdown。
命中消息按原始 message id 定位：messageRefs registry → scrollIntoView（smooth, center）。
命中行加 term-row-search-active class 短时高亮。
后台 session 不参与当前视图搜索。
```

性能要求（已满足）：

```text
query 变化时只做 indexOf。
搜索文本使用已有 messageSearchIndex 的 WeakMap<Message, string>。
不得每次键入都 JSON.stringify tool output。
不得创建第二个 React root。
```

剩余边界：

```text
“结果存在但当前不可见”状态：第一版 scrollIntoView 直接定位；DOM 节点缺失
  （如消息未挂载）时静默跳过——大列表/虚拟化接入后再补可见性提示。
```

### 阶段 F6：GenerationFooter stalled feedback

优先级：中高，纯前端，低风险。

当前状态：**已完成**（9f5fa3a 接入）。

```tsx
GenerationFooter 新增 props：lastTokenAt?: number
```

```ts
const idleMs = lastTokenAt ? Math.max(0, Date.now() - lastTokenAt) : elapsedMs
const activity = idleMs > 10000 ? 'stalled' : idleMs > 3000 ? 'waiting' : 'active'
```

```text
active：保持现有 spinner。
waiting：显示“等待响应”，动画降速。
stalled：显示稳定省略号和“仍在等待后端响应”，不显示错误。
收到 token：立即回到 active（ChatView 在 user/chunk/thought 事件更新 lastTokenAt）。
peri:done/peri:error/cancel：沿用现有 summary。
```

实现约束（已满足）：

```text
不修改 ACP event 名称。
不把 timer 状态写入 Zustand（tick 为 GenerationFooter 局部 state）。
stalled timer 不触发历史 MessageRow 重渲染（仅 Footer 自身）。
不把“无 token”误判为后端失败。
```

### 阶段 F7：Plan presentation

优先级：依赖 ACP。

Claude Code 参考：

```text
Plan message
Plan approval
Plan step list
Enter/exit plan mode
Rejected plan
```

前端准备工作：

```text
先扩展 RenderMessage 类型和 PlanCard 纯展示组件。
先支持已有文本/结构化 payload 的保守显示。
先不模拟批准成功。
```

必须先确认：

```text
Peri 是否发送 plan 相关 sessionUpdate。
是否有 plan id。
是否有 plan step status。
批准/拒绝是否有明确 ACP command。
```

如果协议没有这些字段，施工结果只能是：

```text
保留未来 RenderMessage 类型设计。
增加 fallback system message。
不增加虚假的 Plan mode 行为。
```

### 阶段 F8：Permission request UI

优先级：依赖 ACP，安全价值高。

Claude Code 借鉴：

```text
权限请求不是普通 tool output。
用户能看到具体 command/path。
allow once、session allow、deny 分开。
拒绝原因可见。
Edit/Write 优先展示 diff。
未知权限类型 fallback。
```

候选组件：

```text
src/components/chat/PermissionRequestCard.tsx
src/components/chat/permissionPresentation.ts
src/components/chat/permissionState.ts
```

候选模型：

```ts
interface PermissionRequestModel {
  requestId: string
  toolName: string
  summary: string
  risk: 'low' | 'medium' | 'high' | 'unknown'
  decision: 'pending' | 'allowed' | 'denied' | 'expired'
  options: Array<'allow_once' | 'allow_session' | 'deny'>
}
```

不能做：

```text
不能只根据 toolName 推断风险等级并自动放行。
不能把前端按钮点击当作后端已接受，必须等待真实响应。
不能把 permission UI 混入普通 ToolCard 后静默处理。
```

### 阶段 F9：Task progress/detail

优先级：依赖 ACP。

Claude Code 对后台 task、shell、agent task 有独立表达。

Pylon 第一版如果得到 task id，可以建立：

```text
TaskProgressCard
TaskStatusBadge
TaskDetailPanel
```

状态统一为：

```text
queued
running
waiting
completed
failed
cancelled
unknown
```

必须确认：

```text
task id 是否稳定。
toolCallId 是否能关联 task。
是否有 progress update。
后台 task 是否可以单独取消。
session switch 后 task 是否继续运行。
```

前端不得从 tool output 文本正则猜 task 状态作为正式语义。

### 阶段 F10：Diff presentation

依赖：优先检查现有 ACP payload 和 `react-diff-viewer` 是否可用。

`package.json` 已有：

```text
react-diff-viewer
```

建议顺序：

```text
1. 识别现有 tool output 中是否有 old/new 或 patch。
2. 增加纯函数 normalizeDiffPayload。
3. 无法识别时保留普通 pre output。
4. 可识别时在 ToolCard 内增加 DiffCard。
5. 再考虑独立 DiffDialog。
```

安全和视觉要求：

```text
diff 不能改变 tool 的完成/失败状态。
长行允许横向滚动。
差异颜色必须使用现有主题变量或新增主题变量。
不在 diff 中执行 HTML。
不因为 diff renderer 抛错而击穿 ChatView。
```

### 阶段 F11：block-level streaming Markdown

条件性任务。

只有 profiling 证明 `ReactMarkdown` 在高频 chunk 下是主要瓶颈时施工。

当前已有：

```text
isPlainTextContent(text)
streaming 消息明确绕过 plain-text fast path
静态 assistant plain text 原生文本节点
```

正确边界：

```text
稳定的顶层 block → stable prefix
最后持续增长 block → unstable suffix
stable prefix 可以复用 token/AST 结果
unstable suffix 每个 chunk 重新处理
```

禁止：

```text
不能按换行直接切割 Markdown。
不能缓存 ReactNode。
不能在 streaming 中途因为当前 chunk 看起来纯文本就切换 renderer。
不能把 block-level streaming 和 virtualization 同卡施工。
```

### 阶段 F12：virtualization

当前暂缓。

启动条件：

```text
真实 React/Tauri runtime 证明 1000+ 消息不可接受。
MessageRow memo、cache、pipeline、scroll protection 已不足。
DOM/Fiber/Markdown 子树确认是主要瓶颈。
用户实际体验不可接受，而不是 synthetic layout 超过预算。
```

实现必须包含：

```text
heightCache
message key 稳定
ResizeObserver
累计 offsets
binary search
overscan
top/bottom spacer
动态高度修正
sticky bottom
user_scrolled protection
rAF scroll quantization
fast-scroll mount cap
```

不能直接移植：

```text
Ink/Yoga 坐标
OffscreenFreeze
终端 scrollback
固定 render cap
```

---

## 5. 状态和数据契约规则

### 5.1 Raw Message 与 RenderMessage

必须保持：

```text
Raw Message[] 是 replay/persistence 的事实来源。
RenderMessage[] 是纯派生显示模型。
RenderMessage 不能被 localStorage 直接持久化。
UI 展示 grouping 不得修改 Raw Message[]。
```

### 5.2 source 隔离

任何新状态都必须回答：

```text
它是否按 source 存储？
它是否只属于当前渲染 session？
后台 source 更新是否能污染当前 UI？
session switch 时如何清理？
replay 是否进入该状态？
```

当前已经存在的 source 级状态包括：

```text
messagesBySourceRef
replayingSourcesRef
generationStartRef
generationFramesRef
loadGenerationRef
cancelStateRef
sessionLiveStats
liveGeneratingSources
```

新增长期状态优先按 source 存储，不要把后台 session 的 task/search/input 状态放入单一全局字段。

### 5.3 replay 与 live

必须保持：

```text
replay event 不进入 streamingText。
replay event 不显示 GenerationFooter running。
load generation 过期时丢弃旧响应。
后台 replay 消息仍然持久化。
当前 source 校验必须同时考虑 source 和 session owner。
```

### 5.4 tool 关联

当前 tool id 约定：

```text
tool_call → id: tool-${toolId}
tool_call_update → 根据 toolId 更新同一条 tool message
```

新增 tool presentation 不得依赖数组位置。
缺失 tool id 时必须 fallback，不得把所有缺失 id 的 tool update 更新到最后一条 tool。

### 5.5 状态穷举

所有新的有限状态都必须有 fallback：

```ts
function assertNever(value: never): never {
  throw new Error(`未处理的消息状态: ${String(value)}`)
}
```

后端未知状态：

```text
优先归一化为 unknown。
不能静默当作 completed。
不能因为 UI 没有分支就丢弃消息。
```

---

## 6. 性能规则

### 6.1 memo

`MessageRow` comparator 必须保守：

```text
message 引用变化 → 默认重新渲染。
reduceMotion 变化 → 重新渲染。
toolVisualState 变化 → 重新渲染。
running 变化 → 重新渲染。
toolStatus/toolInput/toolOutput 变化 → 重新渲染。
无法证明静态 → 重新渲染。
```

不能只比较：

```ts
prev.message.id === next.message.id
```

不能把完整 `messages`、Zustand state、session list 传给每个 row。

### 6.2 cache

允许缓存：

```text
静态 code highlight：language + code，当前容量 128。
搜索文本：WeakMap<Message, string>。
工具 presentation 的纯派生结果：仅当 key 和生命周期明确。
Markdown token/AST：只有 profiling 证明必要时。
```

禁止：

```text
无限缓存大型 tool output。
缓存 ReactNode。
缓存未包含 theme/display config 的 Markdown 结果。
streaming 文本复用静态消息 cache。
```

### 6.3 滚动

当前规则：

```text
距离底部 <= 48px → sticky。
用户上滚 → user_scrolled。
程序回底 → jumping，短时锁住 scroll 事件。
只有 sticky 才跟随新消息。
```

任何新消息功能都必须测试：

```text
底部生成
用户上滚后生成
tool output 展开
Thinking 展开
搜索定位
session replay
窗口 resize
```

### 6.4 React render 与 timer

spinner、search highlight、copy feedback 等短周期 UI：

```text
尽量局部 state。
不要写入 Zustand 全局 state。
不要使历史 MessageRow 重新渲染。
不要在每个 chunk 创建不必要的闭包和数组。
```

---

## 7. CSS 和视觉规则

### 7.1 不改变既有视觉

现有视觉基础必须保留：

```text
.term-row-* 消息行 class
.term-assistant
.term-reasoning
.term-tool
.term-tool-head
.term-tool-body
.term-code-block
.term-spinner
.term-summary
messageLayout: classic / claude / bubble
```

### 7.2 新状态优先使用数据属性

推荐：

```tsx
<div className="term-tool" data-status={status} data-activity={activity}>
```

CSS：

```css
.term-tool[data-status="failed"] { ... }
.term-tool[data-status="cancelled"] { ... }
.term-spinner[data-activity="stalled"] { ... }
```

避免把大量动态颜色直接拼进 class name。

### 7.3 主题变量

新增颜色前先检查 `store.ts` 的 `ThemeSettings` 和设置 UI。
不能只在 CSS 写死一个颜色就结束。

工具状态优先复用：

```text
--tool-ok
--tool-run
--tool-err
--tool-name
--tool-summary
--tool-conn
```

Diff、permission、plan 新增颜色必须考虑：

```text
light/dark uiScheme
透明背景
用户自定义 chat transparency
messageLayout
prefers-reduced-motion
```

### 7.4 可访问性

已有折叠组件必须继续提供：

```text
button type="button"
aria-expanded
aria-controls
稳定 body id
```

新增 suggestion、search、permission、plan UI 必须补充：

```text
aria-label
键盘焦点顺序
Escape 关闭语义
当前选中项 aria-selected
错误消息 aria-live（只在必要范围使用）
```

---

## 8. 安全规则

前端渲染边界：

```text
Markdown 普通文本走 ReactMarkdown。
代码高亮 HTML 必须经过 sanitizeHtml。
Bash ANSI 转 HTML 必须先 escape，再 sanitize。
工具输入不能未经 normalize 就深度读取。
未知工具必须 fallback。
单条 renderer 出错不能击穿 ChatView。
```

危险 sink 审计范围：

```text
dangerouslySetInnerHTML
ANSI 转 HTML
Markdown 自定义 renderer
Diff renderer
工具 output
```

permission UI 特别要求：

```text
前端按钮不是权限事实。
必须等待后端确认。
未知权限请求不得自动 allow。
权限范围和 session/source 必须明确。
```

---

## 9. 前端测试和验收

### 9.1 统一命令

每张施工卡完成后执行：

```bash
npm run build
npm run test:frontend
git diff --check
```

`npm run test:frontend` 会自动执行 `scripts/test-*.mts`。
新增专项测试脚本必须符合该命名规则，并且使用 Node `--experimental-strip-types` 可执行。

### 9.2 当前已有专项测试方向

与消息渲染/交互相关的已有测试（完整清单以 `scripts/test-*.mts` 为准）：

```text
test-markdown-fast-path.mts
test-message-render-boundary.mts
test-message-search-index.mts
test-message-types-exhaustive.mts
test-render-decision-exhaustive.mts
test-tool-status-exhaustive.mts
test-diff-presentation.mts               // F1.5 normalizeDiffPayload
test-input-history-ui.mts                // F4.2 history
test-queued-message-ui.mts               // F4.2 queued message
test-message-id-allocator.mts            // F5.6 单调消息 ID
test-chat-regression-contract.mts        // F5.7 控制器接线契约
test-replay-termination.mts / test-replay-tool-ids.mts / test-replay-tool-settlement.mts
test-source-event-isolation.mts / test-chat-clear-sink.mts / test-cancel-transaction-wiring.mts
```

新施工必须优先为纯函数增加测试，再接入 React 组件。

### 9.3 消息事件矩阵

涉及 ChatView、RenderMessage、ToolCard 的施工必须覆盖：

```text
peri:user
live agent_message_chunk
live agent_thought_chunk
tool_call
tool_call_update completed
tool_call_update failed
usage_update
available_commands_update
config_option_update
peri:done
peri:error
cancel_prompt
load_persisted_session
replay
session switch
后台 source 更新
```

### 9.4 InputBar 矩阵

```text
空输入 Enter
普通文本 Enter
Shift+Enter
slash command 部分匹配
Tab/ArrowUp/ArrowDown 选择
未知 command
/model 无参数
/mode 无 session
/compact 失败
/export 取消 save dialog
Escape
Ctrl+C 有选中文本
Ctrl+C 无选中文本且 generating
Ctrl+ArrowUp
Shift+Tab
附件选择和取消
```

### 9.5 Tool presentation 矩阵

```text
Bash 普通输出
Bash ANSI 输出
Read 多行输出
Grep 多匹配输出
Glob 无匹配输出
Edit/Write changed lines
tool running
tool completed
tool failed
tool cancelled
unknown status
unknown tool
异常 rawInput
异常 rawOutput
恶意 HTML
超长 output
```

### 9.6 真实运行时验收

必须区分证据等级：

```text
L1：纯函数单元测试。
L2：Node runner / DOM harness。
L3：浏览器 React benchmark。
L4：真实 Tauri + 真实 Peri ACP runtime。
L5：用户手动体验和实际操作反馈。
```

不能用 L1/L2/L3 伪装成 L4。

---

## 10. 任务拆分和提交规则

每张施工卡必须是可单独验收的行为，不按“随便拆一个文件”划分。

推荐任务卡格式：

```text
任务：F1.1 ToolPresentationModel
目标：ToolCard 不再自行解析状态和摘要。
范围：纯函数、类型、ToolCard props、专项测试。
不改：src-tauri、Message persistence、ACP event 名称。
验收：focused test、build、test:frontend、diff check。
风险：现有 toolInput 已经是字符串，不能假设原始 object 还存在。
回滚：恢复 ToolCard 原 props。
```

前端改动提交前：

```bash
git status --short
git diff --stat
git diff --check
```

工作区存在其他 lane 或用户改动时：

```text
不得整体 git add。
不得整体 commit。
不得回滚无关文件。
只提交当前施工卡归属文件。
```

需要更新本文档时，只更新本文件对应阶段和真实验证结果，不写未运行的 PASS。

## 11. 当前状态

### 11.1 已完成：纯机械/架构整理

以下项目已经完成，从待办问题中移除；它们不构成 UI 重排：

```text
render metrics 观测接入。
MessageRow 提取和保守 memo。
消息显示层一对一 pipeline。
streamingText / streamingThinking 分离。
sticky/user_scrolled/jumping 自动滚底和 callback wiring。
ToolVisualState 归一化、MessageLookups 预计算、ToolPresentation registry。
静态 code highlight cache、plain-text fast path。
单消息 MessageRenderBoundary。
RenderMessage / RenderDecision / ToolVisualState exhaustiveness。
messageSearchIndex 纯函数 API 和分块预热。
ToolPresentationModel 接入 ToolCard。
ToolCard 状态标签、output label、长输出边界、错误输出 label。
ChatView 浏览器 mock display 场景。
RenderMessage 的 tool_call / tool_result 派生类型。
InputBar command registry、live/fallback command 归一化和 slash command parser。
F5.6 单调消息 ID allocator（chatEventController 持有，替换 Date.now() 消息 key）。
F5.7 chatEventController 模块化（事件入口/reducer/replay/持久化迁出 ChatView）。
F5.8 MessageBubble 死代码删除（868b0be）。
F5.9 包体懒加载（主 JS 943.64 → 843.30 kB / gzip 295.40 → 268.29 kB）。
F4.1 Agent 状态类型对齐后端（connecting/inactive + agentId/generation/lastConnectedAt）。
F7.3 ccCliCustomized/ccPositions/ccLayoutVersion legacy 字段删除与迁移清理。
F7.4 Settings/App/presets 类型收敛（as any 清除）。
D1-D6 CC 机械变换（13.1）：消息静态化 / useMinDisplayTime / grapheme 截断 /
  Pet normal 不 setState / useBlink 共享时钟 / 隐藏 Unicode 净化（降级方案）。
```

### 11.2 已完成：局部可见修正（不是 UI 重排）

```text
Claude message layout 的 user/assistant/reasoning/tool 左侧内容轨道统一。
ToolCard 增加状态文字、输出/错误 label 和长输出内部滚动。
F5 Chat search UI：Ctrl+F / MessageSearchBar / 命中高亮与定位（term-row-search-active）。
F6 GenerationFooter stalled feedback：waiting/stalled 文案与降速动画。
F4.2 Input history（按 source 隔离）与 queued message（可编辑/取消/逐条发送）。
DiffCard：tool output 中可识别的结构化/统一 diff 以 diff 卡片展示。
```

这些修改只修正既有消息轨道和工具反馈展示，不改变整体页面分栏、session/sidebar/workspace 结构或 InputBar 布局。

### 11.3 当前未完成问题

```text
真实 ACP 流式 runtime 性能基线尚未形成持久化报告。
F1.5 结构化 diff 增强：DiffCard 基础版已有，缺行模型/词级 diff/行号/截断（对照 CC StructuredDiff）。
F3 Compact boundary / recovery presentation 尚未实现。
F7-F9 Plan/Permission/Task UI 尚未实现，也未确认 ACP 是否提供对应事件。
F11 block-level streaming Markdown 尚未实现。
F12 virtualization 尚未实现；当前因用户实测 2000 条全量列表可接受而暂缓。
F5 search 的“结果存在但当前不可见”提示（DOM 缺失时静默跳过）。
```

### 11.4 当前优先级

```text
F1.5 结构化 diff 增强：对照 references 的 StructuredDiff 行模型升级 diffPresentation；先核对现有 ACP payload。
F3   Compact boundary / recovery presentation：只基于真实 ACP 输出，不猜测 compact 成功。
F7-F9 Plan/Permission/Task：先核对 Peri ACP 实际 payload。
F2.1 剩余：plan/compact/permission/task 显示类型（依赖 ACP）。
F11  block-level streaming Markdown：只有 profiling 证明必要时施工。
F12  virtualization：启动条件仍是真实 Tauri/React runtime 证据。
```

---

## 12. 下一张施工卡

建议施工卡：`F1.5 结构化 diff 增强`。

目标：

```text
把 diffPresentation.ts 的逐行简单比对升级为 CC StructuredDiff 行模型：
  normalizeDiffPayload 保持双路解析（对象/unified）不变。
  增加行模型纯函数：行类型化、相邻 remove+add 配对、词级 diff、
  CHANGE_THRESHOLD=0.4 回退、行号（numberDiffLines）、400 行截断标注。
  DiffCard 消费行模型；无法识别时继续普通 pre 文本。
保留现有 tool 状态、sanitizer、错误边界和主题变量。
```

不改：

```text
不扩展 ACP 协议。
不修改 Message 持久化格式。
不改变 ToolCard 布局与折叠语义。
不把 diff 改成独立页面。
```

验收：

```bash
npm run build
npm run test:frontend
git diff --check
```

---

## 13. Claude Code 优秀设计参考库

> 本库条目均对照 `references/claude-code-sourcemap/restored-src/src/` 源码核实（路径+符号+摘要），
> 并标注与我们仓库的对应现状。类型：`机械变换`（搬代码/纯函数，不改行为）/ `工程设计`（架构/抽象）/ `UI 设计`（可见变化）。
> 难度：1 低 / 2 中 / 3 高。排序：类型优先，难度其次，同类型按建议施工顺序。

### 13.1 机械变换（低风险，可直接开工）

> 状态：D1-D6 已于 2026-07-31 落地（`test-cc-mechanical-adaptations.mts` 回归）。

**D1. 消息静态化判定 `shouldRenderStatically`** — 机械变换 · 难度 1 · ✅ 已完成

- CC 源码：`components/Messages.tsx:779` `shouldRenderStatically(message, streamingToolUseIDs, inProgressToolUseIDs, siblingToolUseIDs, screen, lookups)`；消费点 `components/MessageRow.tsx:155`
- 摘要：transcript 模式恒 static；user/assistant 无 tool 关联恒 static；有 tool 关联时——streaming/in-progress/未决 PostToolUse hook 保持动态，兄弟 tool 全部 resolved 才 static；system `api_error` 恒动态（出现下一条非错误消息即隐藏）；collapsed_read_search 在 prompt 模式恒动态（防回合间闪烁）
- 我们现状：已落地 `messagePipeline.ts::isMessageStatic`（保守子集：running/tool_call 动态，其余静态）；`ChatView.tsx` MessageRow 静态行跳过 motion 入场动画（`skipEntrance`）

**D2. `useMinDisplayTime` 最小展示时长** — 机械变换 · 难度 1 · ✅ 已完成

- CC 源码：`hooks/useMinDisplayTime.ts`（30 行全文）
- 摘要：每个值至少展示 minMs；与 debounce（等安静）/throttle（限速）不同——elapsed >= minMs 直接更新，否则 setTimeout 补足剩余时长。用途示例：`components/messages/CollapsedReadSearchContent.tsx` 中 `ln(incomingHint, MIN_HINT_DISPLAY_MS)`
- 我们现状：已移植 `src/components/chat/useMinDisplayTime.ts`；GenerationFooter stalled 文案接入（`useMinDisplayTime(verb, 1200)`，Hook 在组件顶层无条件调用）

**D3. grapheme 宽度截断（Intl.Segmenter）** — 机械变换 · 难度 1 · ✅ 已完成

- CC 源码：`utils/truncate.ts:63` `truncateToWidth`/`:108` `truncateToWidthNoEllipsis`/`:82` `truncateStartToWidth`/`:16` `truncatePathMiddle`/`:160` `wrapText`；segmenter 懒初始化在 `utils/intl.ts`（`getGraphemeSegmenter`）
- 摘要：按**显示列宽**而非字符数截断，用 Intl.Segmenter grapheme 边界迭代，不拆坏 emoji/CJK 组合字符
- 我们现状：已移植 `src/utils/textWidth.ts`（零依赖：`graphemeWidth`/`stringWidth`/`truncateToWidth`/`truncateStartToWidth`，宽度区间含 CJK 全角与常用 emoji 区）；`truncateToolSummary` 换用（显示宽度语义）；tsconfig lib 升至 ES2022（Intl.Segmenter 类型）

**D4. `useMemoryUsage` 模式：normal 态不 setState** — 机械变换 · 难度 1 · ✅ 已完成

- CC 源码：`hooks/useMemoryUsage.ts`（`setMemoryUsage(prev => ...)`，`status === 'normal'` 时返回 prev 即 null，不触发重渲染）
- 摘要：10s 轮询但状态无变化时不产生新 state，整树零重渲染
- 我们现状：已落地 `PetCompanion.tsx::save`——轮询数据持久化序列化相等时返回旧引用

**D5. `useBlink` 共享动画时钟 + 失焦暂停** — 机械变换 · 难度 1 · ✅ 已完成（备用件，无消费点）

- CC 源码：`hooks/useBlink.ts`（`useAnimationFrame(enabled && focused ? intervalMs : null)`，所有实例从同一 time 派生 blink 状态 → 同步闪烁；失焦恒亮）
- 摘要：动画实例共享时钟，多元素同步；不可见/失焦时暂停帧循环
- 我们现状：已移植 `src/components/chat/useBlink.ts`（Web 等价：模块级共享时钟 + 订阅者计数启停 + `document.hasFocus()`/visibilitychange；`blinkVisible` 纯逻辑可测）

**D6. 隐藏 Unicode 净化** — 机械变换 · 难度 2 · ✅ 已完成（降级方案）

- CC 源码：`utils/sanitization.ts:25` `partiallySanitizeUnicode`（NFKC 迭代归一化 + `\p{Cf}\p{Co}\p{Cn}` 显式危险范围剥离双保险）、`:71` `recursivelySanitizeUnicode`（递归对象/数组）
- 摘要：输入侧防隐藏控制字符/组合字符注入（prompt 注入与显示欺骗）
- 我们现状：已落地 `src/utils/unicodeSanitizer.ts`——**降级方案**（按用户决策）：只剥 `[\p{Cf}\p{Co}\p{Cn}]`，不做 NFKC（不改写正常输入）；`InputBar` 发送内容发送前净化；`recursivelyStripHiddenUnicode` 备用

### 13.2 工程设计（抽象/架构，中等风险）

**E1. 工具渲染注册表（每 Tool 五态渲染函数）** — 工程设计 · 难度 2 · 顺序 1

- CC 源码：`Tool.ts:577-636`（`renderToolResultMessage?`/`renderToolUseMessage`/`renderToolUseProgressMessage?` 为 Tool 接口可选字段）；每工具目录一个 `UI.tsx` 导出纯渲染函数（`BashTool/UI.tsx`：verbose/condensed 双态、长命令截断、sed 伪装文件编辑、ctrl+b 后台化提示；`FileWriteTool/UI.tsx` 同理）；消费点 `components/messages/AssistantToolUseMessage.tsx`（三态 queued/in-progress/resolved + `inputSchema.safeParse` 防御）
- 摘要：工具渲染按 toolName 注册，UI 与工具逻辑同目录但文件分离，渲染函数纯导出
- 我们现状：`src/components/chat/ChatView.tsx` ToolCard 单组件由 ToolPresentationModel 驱动（已归一化，但无按工具注册）
- 任务分解：① 定义 `ToolRendererRegistry`（name → 渲染函数）② ToolCard 内部改为查表，默认回退现有 model 渲染 ③ 逐个工具（Bash/Read/Grep/Edit/Write）注册 ④ 测试
- 不做：不改变 ToolCard 布局与折叠语义

**E2. keybindings action 注册表 + context 优先级** — 工程设计 · 难度 2 · 顺序 2

- CC 源码：`keybindings/useKeybinding.ts:33`（action 字符串 + context + chord 序列 + `stopImmediatePropagation` 防冲突）；`keybindings/parser.ts`（ctrl/control/cmd/super 别名归一化）；`keybindings/defaultBindings.ts`（平台感知）；`keybindings/reservedShortcuts.ts`（锁定 ctrl+c/d 不可重绑）；`hooks/useCommandKeybindings.tsx`（`command:<name>` 绑定等价输入 `/name`）
- 摘要：键位 = 配置驱动（action 字符串）而非散落硬编码；上下文栈解析优先级
- 我们现状：`src/components/chat/InputBar.tsx` 键位散落硬编码（Ctrl+ArrowUp/ArrowDown/Shift+Tab/Esc/Ctrl+C）
- 任务分解：① 抽出 `keybindingRegistry.ts`（action → handler，支持 context）② InputBar 现有键位迁移 ③ `command:` 映射到 commandRegistry ④ 测试（冲突/上下文）
- 不做：不引入可配置键位 UI（仅内部注册表）

**E3. FileReadCache mtime 失效缓存** — 工程设计 · 难度 2 · 顺序 3

- CC 源码：`utils/fileReadCache.ts`（`FileReadCache` 单例；`fs.statSync` 每次比对 `mtimeMs`，脏则重读；`getCacheStats` 调试）
- 摘要：读缓存以 mtime 为失效键，避免重复读大文件
- 我们现状：右栏 `src/components/right-panel/workspaceApi.ts` 每次展开/读取都 `invoke('read_workspace_text')`
- 任务分解：① 确认后端 `read_workspace_text` 返回 mtime（无则前端缓存最近读取，按 path+size 键）② 前端 LRU 缓存（~50 条）③ 测试
- 阻塞：需核对后端 DTO（B2.2 范围）

**E4. 原子写三件套（后端参考）** — 工程设计 · 难度 2 · 顺序 4

- CC 源码：`utils/file.ts:362` `writeFileSyncAndFlush_DEPRECATED`（`${target}.tmp.${pid}.${Date.now()}` → `writeFileSync(flush: true)` → `renameSync` 原子覆盖；失败清 tmp 并降级非原子写；`O_EXCL('wx')` 锁另见 pidLock）
- 摘要：崩溃安全写文件：临时文件 + flush + rename，防止半写文件
- 我们现状：前端 localStorage 直写（sessionPersistence/sheetPersistence/theme）无此问题；`src-tauri` 侧会话/配置写文件可参考
- 任务分解：作为后端 B 范围参考条目，前端不实施

**E5. 工具组折叠 GroupedToolUseContent** — 工程设计 · 难度 3 · 顺序 5

- CC 源码：`components/messages/GroupedToolUseContent.tsx`（同类工具多次调用聚合为组，结果按 tool_use_id 建 Map，`renderGroupedToolUse` 一次渲染）；配套 `CollapsedReadSearchContent.tsx`（Read/Search/Grep 折叠为一行，useRef 记 max count 防 debounce 抖动、elapsed>=2s 才显示耗时）
- 摘要：连续同类工具折叠为组/一行，降低滚动噪音
- 我们现状：无折叠；Raw Message[] 不允许 UI 层改动（只加显示层派生）
- 任务分解：① 纯函数 `groupAdjacentTools(messages)`（不修改 Raw）② 折叠行渲染 + 展开 ③ 折叠状态按 source 隔离 ④ 测试
- 约束：显示层聚合不进入持久化（对齐 5.1 契约）

### 13.3 UI 设计（可见变化，需视觉验收）

**U1. Byline 元信息行** — UI 设计 · 难度 1 · 顺序 1

- CC 源码：`components/design-system/Byline.tsx:37`（自动过滤 null/undefined/false children，` · ` 分隔，inline 元信息）
- 摘要：元信息拼接原语
- 我们现状：`src/components/chat/ChatView.tsx` ToolCard/GenerationFooter 手写字符串拼接
- 任务分解：① 小组件 ② ToolCard footer/GenerationFooter 替换 ③ 浏览器验收（暗色/窄宽）

**U2. ProgressBar 八分块字符** — UI 设计 · 难度 1 · 顺序 2

- CC 源码：`components/design-system/ProgressBar.tsx:26`（`BLOCKS = [' ','▏','▎','▍','▌','▋','▊','▉','█']`）
- 摘要：字符级进度条的 8 分块精度
- 我们现状：`src/components/ControlCenter.tsx` EkgWidget bar 已用 CSS 渐变实现同效果
- 任务：可选（CSS 已覆盖），仅当需要行内字符进度时采用；低优先

**U3. Dialog 确认/取消键位 + 二次确认** — UI 设计 · 难度 2 · 顺序 3

- CC 源码：`components/design-system/Dialog.tsx`（`useKeybinding("confirm:no", onCancel)` Esc/n 取消；app:exit 二次确认 "Press X again to exit"；Byline 快捷键提示）
- 摘要：对话框内置确认键位语义，破坏性动作二次确认
- 我们现状：SessionSettings 关闭无确认；删除 Profile/清除会话无二次确认
- 任务分解：① Dialog 键位语义组件 ② SessionSettings 关闭确认接入 ③ 浏览器验收（焦点/Esc）
- 约束：不改变现有对话框布局，只加确认层

**U4. Ratchet 棘轮 minHeight 防跳动** — UI 设计 · 难度 2 · 顺序 4

- CC 源码：`components/design-system/Ratchet.tsx`（`useRef(maxHeight)` + `useLayoutEffect` 测量，只增不减，`Math.min(height, rows)` 上限，engaged 时施加 minHeight）
- 摘要：流式内容容器高度只增不减，防 streaming/搜索高亮造成布局跳动
- 我们现状：ChatView streaming 时消息区高度随文本增长自然跳动
- 任务分解：① 移植 Ratchet（React DOM 版）② 仅 streaming 期间启用 ③ 浏览器验收
- 风险：与 sticky 滚动/搜索定位的交互需测试（6.3 滚动规则）

**U5. 错误消息分类渲染** — UI 设计 · 难度 2 · 顺序 5

- CC 源码：`components/messages/AssistantTextMessage.tsx`（错误文案 9 类 sentinel 分类：rate-limit/API key/token revoked/超时等各走专属 UI，含 CtrlOToExpand 截断提示；分类逻辑在 services 层提取，组件只消费分类结果）
- 摘要：错误不是统一红字，按类别给出可行动文案
- 我们现状：`src/components/chat/ChatView.tsx` error/system 统一 `term-row-error` 红字（ChatView.tsx:690-692）
- 任务分解：① 纯函数 `classifyErrorMessage(error)`（rate-limit/授权/超时/网络/通用）② 分类文案 ③ 接入 error 渲染分支 ④ 测试 + 浏览器验收
- 约束：不改变消息持久化格式与事件语义

### 13.4 协议/后端配合（中期，先核对 ACP）

**P1. 系统提示词分节 memoize** — CC `constants/systemPromptSections.ts:20`（`systemPromptSection` 与 `DANGEROUS_uncachedSystemPromptSection`，cacheBreak 显式声明哪些节每轮重算）→ 后端 ACP 提示词构建参考
**P2. git 三件套** — CC `utils/gitDiff.ts:148` `parseGitNumstat`（tab/二进制 '-'/文件名含 tab）、`:200` `parseGitDiff`（diff --git 切文件、hunk 正则、`''+line` 破 V8 sliced-string）、`:312` `isInTransientGitState`（fs.access 查 MERGE_HEAD/CHERRY_PICK_HEAD/REVERT_HEAD 不 spawn）；`utils/git/gitConfigParser.ts:36` `parseConfigString`（零依赖，引号/转义/内联注释对照 git config.c）→ F3 Git Sheet 解析与冲突状态检测直接移植
**P3. task 增量输出 + 轮询 GC** — CC `utils/task/framework.ts`（`registerTask` 替换保留 UI 状态、`updateTaskState` 同引用跳过重渲染、`pollTasks` 1s + outputOffset 增量读取、终态 GC 驱逐）→ F8.3 Runs Sheet 参考模型
**P4. Permission 7 步流水线** — CC `utils/permissions/permissions.ts` `hasPermissionsToUseToolInner`（rule→tool checkPermissions→safetyCheck→mode→alwaysAllow→passthrough→ask）+ `types/permissions.ts` allow/ask/deny 判别联合 → F8 施工卡落地时参考
**P5. 主题预设目录化加载** — CC `outputStyles/loadOutputStylesDir.ts:26`（memoize + 目录扫描 .md → 样式名）→ 我们 `src/presets.ts` 硬编码数组可目录化；低优先
**P6. 后台任务 stall watchdog** — CC `tasks/LocalShellTask/LocalShellTask.tsx`（45s 无输出增长 + 尾部匹配交互提示正则才通知）→ 与 F6 stalled 互补的后台任务通知模型

### 13.5 施工优先级

```text
✅ 已完成（D1-D6 机械变换）：
  D1 消息静态化 → D2 useMinDisplayTime → D3 grapheme 截断 → D4 Pet normal 不 setState → D5 useBlink → D6 Unicode 净化
近期（B 类工程设计，需小步拆）：
  E1 工具渲染注册表 → E2 keybinding 注册表 → E3 FileReadCache（需后端 mtime）
UI 验收型（与对应功能卡一起做）：
  U1 Byline → U3 Dialog 确认 → U4 Ratchet → U5 错误分类
协议/后端配合（等 B 编号或先核对 ACP）：
  P1-P6
```

本文档只保留未完成问题和当前施工边界；已完成问题不再重复进入路线，纯机械/架构整理统一归档在 11.1；CC 可借鉴设计统一归档在本章参考库。

---
