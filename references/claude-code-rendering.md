# Pylon 消息渲染改造开发文档

> 文档状态：施工基线
> 更新日期：2026-07-31
> 适用项目：`G:\Project\prism-desktop`
> 参考源码：`references/claude-code-sourcemap/restored-src/src/`
> Pylon 前端：`src/`
> 约束：只改前端，不修改 `src-tauri/`，不改变既有视觉设计和 ACP 事件契约。

---

## 0. 文档目的

本文件不是 Claude Code 源码介绍，而是 Pylon 消息渲染改造的实际开发文档。

开发目标：

1. 降低流式消息期间不必要的 React 渲染。
2. 让静态历史消息可以安全跳过更新。
3. 把原始消息数据和显示层消息解耦。
4. 让 tool 状态、tool 关联、消息可见性有明确的数据层。
5. 为后续 Markdown cache 和 virtualization 保留正确的架构边界。
6. 保持当前 UI、CSS、ACP 事件、replay、持久化和取消行为不变。

核心原则：

```text
先建立测量基线，再改结构。
先改渲染边界，再改数据流。
先做低风险 memo/cache，再做 streaming 分离。
virtualization 最后做，不提前引入。
任何不确定的产品语义都不在性能改造中擅自决定。
```

---

## 1. 当前源码基线

### 1.1 Pylon 文件

| 文件 | 当前职责 | 改造阶段 |
|---|---|---|
| `src/components/chat/ChatView.tsx` | ACP 事件监听、session/replay、消息状态、列表渲染、消息子组件 | P0-P3 |
| `src/components/chat/ChatView.css` | 消息、tool、thinking、代码块、滚动容器样式 | 保持不变，必要时同步拆分 |
| `src/components/chat/GenerationFooter.tsx` | spinner、耗时、token、停止、结束摘要 | P2/P8 |
| `src/components/chat/codeHighlight.ts` | Starry Night 代码高亮 | P3 |
| `src/components/chat/toolStatus.ts` | tool 状态视觉映射 | P1 |
| `src/components/chat/acpTypes.ts` | ACP event payload 和提取函数 | P1/P2，仅补充前端类型适配 |
| `src/components/chat/sessionEventState.ts` | source 级生成状态维护 | P2 |
| `src/components/chat/replayState.ts` | replay、load generation、终止状态 | P2 |
| `src/components/chat/messagePersistence.ts` | localStorage 消息持久化 | P2，保持契约 |
| `src/components/chat/sessionRuntime.ts` | session live stats | 不直接改动，除非验证需要 |
| `src/store.ts` | Zustand 全局状态和主题 | 原则上不改消息结构 |
| `scripts/run-frontend-tests.mts` | 前端回归测试入口 | 每阶段使用 |
| `package.json` | build/test 命令 | 不修改脚本语义 |

### 1.2 Pylon 当前消息类型

`ChatView.tsx` 当前定义：

```ts
interface Message {
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

当前内部渲染组件：

```text
AssistantContent
ReasoningBlock
ToolCard
UserLine
CodeBlock
```

重要结论：

- Pylon 已经有 Thinking 折叠，不重复实现。
- Pylon 已经有消息子组件，不从零设计消息 UI。
- 当前缺少独立的 `MessageRow` 边界。
- 当前缺少显示层 `RenderMessage`。
- 当前 tool 状态和 tool 关联仍然主要由 `ChatView` 事件处理代码维护。

### 1.3 当前流式事件路径

`ChatView.tsx` 监听：

```text
peri:user
peri:update
  agent_message_chunk
  agent_thought_chunk
  tool_call
  tool_call_update
  usage_update
  available_commands_update
  config_option_update
peri:done
peri:error
```

当前 `agent_message_chunk` 路径：

```tsx
updateSourceMessages(source, prev => {
  const last = prev[prev.length - 1]

  if (last?.role === 'assistant' && last.running) {
    return prev.map((message, index) => index === prev.length - 1
      ? { ...message, content: message.content + text }
      : message)
  }

  return [...prev, {
    id: 'msg-' + Date.now(),
    role: 'assistant',
    sender: 'peri',
    content: text,
    time: new Date().toLocaleTimeString(),
    running: !replay,
  }]
}, replay)
```

`updateSourceMessages()` 最终会在当前 source 可见时调用：

```tsx
setMessages(next)
```

因此当前每个 live assistant chunk 都会：

```text
更新消息数组
触发 ChatView render
重新执行 messages.map
重新构造消息行 JSX
```

React 不会因此把所有 DOM 节点重新 mount，但当前没有 `MessageRow` 级 memo，历史消息仍会参与父列表渲染和子组件比较。

### 1.4 当前自动滚动

当前实现：

```tsx
useEffect(() => {
  bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
}, [messages, generating])
```

这是后续必须处理的行为风险：

```text
用户主动上滚后，历史消息更新可能把视图拉回底部。
后台 replay 可能影响当前滚动位置。
tool output 更新可能触发无意义滚动。
Thinking 展开/折叠可能触发滚动。
```

---

## 2. Claude Code 参考源码索引

以下源码是本改造的参考依据，不是直接移植目标。

| Claude Code 文件 | 实际行数 | 借鉴内容 |
|---|---:|---|
| `src/components/Messages.tsx` | 833 | 消息预处理、streaming 区、父级 memo、消息 lookup、虚拟列表接入 |
| `src/components/MessageRow.tsx` | 382 | 单行 dispatch、static/dynamic 判断、保守 comparator |
| `src/components/Message.tsx` | 626 | 消息类型和 content block 两级 dispatch |
| `src/components/Markdown.tsx` | 235 | plain text fast path、token cache、Stable Prefix |
| `src/components/VirtualMessageList.tsx` | 1081 | 动态窗口、搜索索引、稳定 handler、sticky prompt |
| `src/hooks/useVirtualScroll.ts` | 721 | height cache、offsets、overscan、二分、快速滚动限制、resize 修正 |
| `src/components/OffscreenFreeze.tsx` | 43 | Ink terminal scrollback 专用冻结机制，不直接移植 |
| `src/components/messages/AssistantToolUseMessage.tsx` | 367 | tool presentation protocol、safe parse、状态分层、错误保护 |
| `src/components/messages/AssistantThinkingMessage.tsx` | 85 | thinking 摘要/全文策略 |
| `src/utils/groupToolUses.ts` | 182 | 显示层 grouping、原始消息不变、WeakMap 缓存 |
| `src/components/messages/nullRenderingAttachments.ts` | 70 | 不可见消息过滤和 TypeScript 覆盖约束 |
| `src/state/selectors.ts` | 76 | 纯 selector 和派生状态边界 |

### 2.1 参考源码的关键实现

#### 消息预处理与窗口切片分离

Claude Code 的核心结构：

```tsx
const processedMessages = useMemo(() => {
  const normalized = normalizeMessages(messages)
  const grouped = applyGrouping(normalized, tools, verbose)
  return collapseMessages(grouped)
}, [messages, tools, verbose])

const renderableMessages = useMemo(() => {
  return processedMessages.slice(start, end)
}, [processedMessages, start, end])
```

Pylon 必须保持同样的依赖边界：滚动窗口变化不能重新执行全量消息处理。

#### MessageRow 保守 memo

Claude Code 的 comparator 重点：

```tsx
if (prev.message !== next.message) return false
if (prev.screen !== next.screen) return false
if (prev.verbose !== next.verbose) return false
if (prev.columns !== next.columns) return false

if (isMessageStreaming(prev.message, prev.streamingToolUseIDs)) return false
if (!allToolsResolved(prev.message, prev.lookups.resolvedToolUseIDs)) return false

return true
```

原则：

```text
无法证明静态，就重新渲染。
宁可多渲染，不可渲染错误。
```

#### Stable Prefix 的实际含义

Claude Code 的 `StreamingMarkdown` 使用 `marked.lexer()`，按顶层 block token 推进稳定边界：

```text
已闭合段落、列表、代码块等 block → stablePrefix
最后一个仍可能增长的 block → unstableSuffix
```

不是按 inline `strong` 或 inline `code` 闭合推进，也不保证严格 `O(增量长度)`。

#### Virtualization 的实际组成

Claude Code 的 `useVirtualScroll.ts` 使用：

```text
heightCache
Float64Array offsets
DEFAULT_ESTIMATE
OVERSCAN_ROWS
MAX_MOUNTED_ITEMS
SLIDE_STEP
useDeferredValue
scroll quantization
resize height scaling
```

Pylon 是浏览器 DOM，不移植 Ink 的 `VirtualMessageList`、`OffscreenFreeze` 或 Yoga 坐标逻辑。

---

## 3. 改造总原则和非目标

### 3.1 必须保持的行为

```text
ACP event 名称不变。
ACP payload 语义不变。
live/replay source 隔离不变。
后台 session 仍然持久化。
session 切换时旧 source 不得污染当前界面。
peri:done / peri:error / cancel 最终状态必须收敛。
tool_call 与 tool_call_update 关联不变。
localStorage key 和序列化格式不变。
当前 CSS class 和视觉布局不变。
```

### 3.2 本次不做的事情

```text
不修改 src-tauri/。
不修改 ACP 后端协议。
不重设计消息 UI。
不引入 Claude Code 的 Ink 组件。
不直接引入 virtualization。
不改变消息持久化结构。
不按换行擅自切割 assistant 消息。
不把 Thinking 折叠作为新增功能。
不为了“看起来更快”增加未经测量的复杂缓存。
```

### 3.3 推荐的最终分层

```text
ACP events
    ↓
Event adapter / source isolation
    ↓
Raw Message[] ------------- 继续负责 replay 和 persistence
    ↓
messagePipeline
    ↓
RenderMessage[] + MessageLookups + RenderDecision
    ↓
MessageRow
    ↓
消息类型组件
    ↓
Markdown / tool renderer / code renderer
```

---

## 4. 改造顺序总览

严格按以下顺序施工：

```text
P0  性能基线和 render 计数
P1  MessageRow 提取 + 保守 memo
P1  派生消息处理与列表窗口解耦
P2  streamingText / streamingThinking 视图分离
P2  自动滚底与用户滚动状态分离
P2  稳定 callback + 最小 row props
P3  Tool presentation protocol
P3  MessageLookups 和 ToolVisualState
P3  显示层 RenderMessage / grouping / visibility pipeline
P4  Markdown / code highlight cache
P4  block-level streaming Markdown
P5  单消息错误边界和 TypeScript exhaustiveness
P6  搜索索引缓存和分块预热
P7  virtualization：动态高度 cache + offsets + overscan
P8  resize 修正、scroll quantization、fast-scroll mount cap
P9  spinner stalled animation
```

每一项都必须先完成自身验收，再进入下一项。不要跨阶段同时改消息数据流、UI 结构和滚动系统。

---

# 5. P0：建立性能基线

## 5.1 目标

取得 Pylon 当前真实渲染数据，回答：

```text
流式期间 ChatView 每秒 render 几次？
历史消息实际重复 render 几次？
ReactMarkdown 是否是主要耗时？
starry-night 是否是主要耗时？
motion/react 是否产生额外开销？
自动滚底是否触发 layout/scroll 抖动？
```

## 5.2 实施方法

建议增加开发环境专用测量，不改变生产行为：

```ts
const renderCountRef = useRef(0)
renderCountRef.current += 1
```

在关键组件增加计数：

```text
ChatView
MessageRow（先临时包装或内联计数）
AssistantContent
ReasoningBlock
ToolCard
CodeBlock
```

使用 `performance.mark()` / `performance.measure()` 测量：

```text
messages.map
prepareMessages（如果已经存在）
highlightCode
scrollIntoView
```

## 5.3 测试矩阵

```text
10 条普通消息
100 条普通消息
500 条普通消息
1000 条普通消息
长 assistant Markdown
多行代码块
连续 tool call
thinking + tool call
高频 agent_message_chunk
用户上滚后继续生成
后台 session 更新
replay 恢复
取消和 error
```

## 5.4 验收

必须能得到至少以下数据：

```text
ChatView render 次数
每条消息行 render 次数
streaming 期间每秒 commit/render 次数
Markdown/highlight 调用次数
每次 highlight 平均耗时
自动滚动调用次数
```

如果没有真实数据，不得以理论复杂度作为改造收益结论。

---

# 6. P1：提取 MessageRow 并加入保守 memo

## 6.1 目标

把当前 `ChatView.tsx` 的消息列表行提取为独立组件，使静态历史消息可以跳过完整子树更新。

建议结构：

```text
src/components/chat/messages/
├── MessageRow.tsx
├── MessageRenderer.tsx
├── AssistantMessage.tsx
├── ReasoningMessage.tsx
├── ToolMessage.tsx
├── UserMessage.tsx
└── CodeBlock.tsx
```

第一阶段可以只创建：

```text
MessageRow.tsx
MessageRenderer.tsx
```

原有子组件可以暂时继续留在 `ChatView.tsx`，后续再搬运。

## 6.2 实施方法

把当前：

```tsx
{messages.map(msg => (
  <motion.div key={msg.id} ...>
    {msg.role === 'tool' && <ToolCard ... />}
    {msg.role === 'user' && <UserLine ... />}
    {msg.role === 'reasoning' && <ReasoningBlock ... />}
    {msg.role === 'assistant' && <AssistantContent ... />}
  </motion.div>
))}
```

改为：

```tsx
{messages.map(message => (
  <MessageRow
    key={message.id}
    message={message}
    reduceMotion={reduceMotion}
  />
))}
```

`MessageRow` 内部暂时保持原有 CSS class、`motion.div` 和子组件 JSX，不改变视觉。

## 6.3 comparator

第一版使用保守 comparator：

```tsx
function areMessageRowPropsEqual(prev: Props, next: Props): boolean {
  if (prev.message !== next.message) return false
  if (prev.reduceMotion !== next.reduceMotion) return false

  if (prev.message.running || next.message.running) return false

  if (prev.message.role === 'tool' || next.message.role === 'tool') {
    if (prev.message.toolStatus !== next.message.toolStatus) return false
    if (prev.message.toolOutput !== next.message.toolOutput) return false
    if (prev.message.toolInput !== next.message.toolInput) return false
  }

  return true
}

export const MessageRow = React.memo(MessageRowImpl, areMessageRowPropsEqual)
```

消息对象引用变化时直接重新渲染，不尝试深比较 content。

## 6.4 注意事项

不能只比较：

```tsx
prev.message.id === next.message.id
```

因为 assistant chunk 和 tool update 都可能保持相同 id、替换整个消息对象。

不能把完整 `messages` 数组作为 row prop：

```tsx
<MessageRow messages={messages} index={index} />
```

需要的派生值在父层提前计算。

## 6.5 验收

```text
消息视觉与改造前一致。
assistant streaming 仍然实时更新。
tool output/status 仍然更新。
Reasoning 展开/折叠正常。
复制按钮正常。
历史静态消息 render 次数下降。
npm run build 通过。
npm run test:frontend 通过。
git diff --check 通过。
```

---

# 7. P1：分离消息预处理和列表窗口

## 7.1 目标

建立显示层处理边界，为 grouping、lookup 和 virtualization 做准备。

新增：

```text
src/components/chat/messagePipeline.ts
src/components/chat/messageTypes.ts
```

## 7.2 类型设计

保留持久化/事件层 `Message`，新增显示层类型：

```ts
export type RenderMessage =
  | { type: 'user'; message: Message }
  | { type: 'assistant'; message: Message }
  | { type: 'reasoning'; message: Message }
  | { type: 'tool'; message: Message }
  | { type: 'tool_group'; messages: Message[] }
  | { type: 'system'; message: Message }
```

第一阶段可以只实现一对一映射：

```text
Message → RenderMessage
```

不要一开始引入复杂 grouping。

## 7.3 处理边界

```ts
const preparedMessages = useMemo(
  () => prepareMessages(messages),
  [messages],
)

const visibleMessages = useMemo(
  () => preparedMessages.slice(start, end),
  [preparedMessages, start, end],
)
```

关键要求：

```text
滚动 start/end 变化时不重新处理全部 messages。
MessageRow 不接收完整原始数组。
原始 messages 仍由 replay/persistence 使用。
```

## 7.4 验收

```text
prepareMessages 输出顺序与当前 messages 一致。
message id 保持稳定。
localStorage 数据不变化。
replay 测试不变化。
滚动窗口变化不会重复调用 prepareMessages。
```

---

# 8. P2：分离 streamingText 和 streamingThinking

## 8.1 目标

让已提交历史消息不随着每个 live chunk 改变。

目标状态：

```ts
messages: Message[]
streamingText: string
streamingThinking: string
streamingSource: string | null
```

`messages` 继续负责：

```text
replay
localStorage
完成后的历史显示
session 切换恢复
```

`streamingText` 只负责当前 live 预览。

## 8.2 实施顺序

### 第一步：只增加独立预览状态

暂时不切换事件提交逻辑，先验证渲染结构：

```tsx
<MessageList messages={messages} />
<StreamingAssistantText text={streamingText} />
<StreamingThinking text={streamingThinking} />
```

### 第二步：live agent message chunk 进入预览状态

只对：

```text
replay === false
source === 当前有效 source
```

的 `agent_message_chunk` 写入 `streamingText`。

### 第三步：定义 flush

```text
peri:done：提交最终 assistant message，清空 streamingText
peri:error：按现有语义保留已收文本，再追加错误消息
cancel：保留已收文本，结束生成状态
tool_call：必须明确是否先 flush assistant 文本
session switch：丢弃旧 source 的 streamingText
replay：不进入 streamingText，直接写 replay messages
```

### 第四步：保持回退路径

施工期间保留一个明确的 fallback 开关或可快速回滚的事件路径。不要同时改 replay、persistence、cancel 三套逻辑。

## 8.3 禁止事项

```text
禁止按换行直接切割消息。
禁止改变消息持久化格式。
禁止让 replay 事件进入 live streaming state。
禁止只依据当前 sessionId 判断 source，有效 source 必须同时校验。
```

## 8.4 验收矩阵

```text
连续 assistant chunk 正确合并。
thinking chunk 不污染 assistant text。
tool_call 前后的 assistant 文本顺序正确。
peri:done flush 一次且不重复。
peri:error 不丢文本。
cancel 不残留 running 状态。
后台 source 不显示到当前 session。
replay 不出现 streaming footer。
session 切换不串消息。
```

---

# 9. P2：自动滚底和用户滚动状态分离

## 9.1 目标

只有用户原本在底部时，新内容才自动跟随底部。

状态模型：

```ts
type ScrollFollowState =
  | 'sticky'
  | 'user_scrolled'
  | 'jumping'
```

## 9.2 实施方法

替换无条件：

```tsx
useEffect(() => {
  bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
}, [messages, generating])
```

改为：

```text
监听 scrollTop、scrollHeight、clientHeight。
距离底部小于阈值时视为 sticky。
用户向上滚动后切换为 user_scrolled。
新消息到达时仅 sticky 状态跟随底部。
用户点击回到底部后恢复 sticky。
```

推荐使用 `requestAnimationFrame` 合并滚动事件，不把实时 scrollTop 放入 Zustand。

## 9.3 验收

```text
底部生成时持续跟随。
上滚阅读历史时不被新 chunk 拉回底部。
后台 session 更新不影响当前 session。
点击回底按钮正常。
tool output 展开不会意外跳底。
Thinking 展开不会意外跳底。
```

---

# 10. P2：稳定 callback 和最小 row props

## 10.1 目标

减少长列表每次 render 产生的短命闭包，并让 `MessageRow` comparator 真正有效。

避免：

```tsx
messages.map(message => (
  <MessageRow
    onClick={() => setExpanded(message.id)}
    onMouseEnter={() => setHovered(message.id)}
  />
))
```

推荐：

```tsx
const handlersRef = useRef({ onExpand, onHover })
handlersRef.current = { onExpand, onHover }

const handleRowClick = useCallback((message: Message) => {
  handlersRef.current.onExpand(message.id)
}, [])
```

## 10.2 props 规则

`MessageRow` 只接收：

```text
message
isActive
isUserContinuation
hasContentAfter
renderState
lookups
stable callbacks
```

不接收：

```text
完整 messages 数组
整个 Zustand state
不相关的 spinner/token 状态
整个 session 列表
```

---

# 11. P3：Tool presentation protocol

## 11.1 目标

把 tool 的输入解析、摘要、进度、输出和错误处理从 `ChatView.tsx`/`ToolCard` 中分离出来。

Claude Code 参考：

```text
AssistantToolUseMessage.tsx
Tool.ts 的 inputSchema
renderToolUseMessage
renderToolUseProgressMessage
renderToolUseQueuedMessage
```

## 11.2 Pylon 目标接口

第一版只定义前端展示协议：

```ts
export interface ToolPresentation {
  getSummary(input: unknown): string
  getSearchText?(output: unknown): string
  renderInput?(input: unknown): React.ReactNode
  renderOutput?(output: unknown): React.ReactNode
}
```

使用 registry 或保守 fallback：

```ts
const toolPresentation = resolveToolPresentation(toolName)
const summary = toolPresentation.getSummary(input)
```

未知工具仍显示通用 ToolCard，不得因为没有专用 renderer 而丢消息。

## 11.3 输入安全边界

```text
rawInput
→ normalizeToolInput
→ safe presentation model
→ render
```

不得直接把任意 payload 当作结构化对象深度读取。renderer 失败时：

```text
记录 reportRuntimeError
保留通用工具名和基础输入摘要
不击穿整个 ChatView
```

## 11.4 验收

```text
Bash/Read/Write/Edit/Grep/Glob/Task 摘要保持不变。
未知 tool 仍有 fallback 显示。
异常 input 不让列表崩溃。
输出 sanitizer 仍然生效。
现有 tool status 颜色和连接线不变。
```

---

# 12. P3：MessageLookups 和 ToolVisualState

## 12.1 MessageLookups

新增纯派生函数：

```ts
interface MessageLookups {
  toolById: Map<string, Message>
  resolvedToolIds: Set<string>
  failedToolIds: Set<string>
  runningToolIds: Set<string>
}
```

构建时机：

```tsx
const lookups = useMemo(
  () => buildMessageLookups(preparedMessages),
  [preparedMessages],
)
```

`MessageRow` 不再扫描完整消息数组寻找 tool 关联。

## 12.2 ToolVisualState

把不稳定的后端状态归一化为前端有限状态：

```ts
type ToolVisualState =
  | 'queued'
  | 'running'
  | 'waiting'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'unknown'
```

处理路径：

```text
ACP tool status
→ normalizeToolStatus
→ ToolVisualState
→ ToolCard
```

未知状态必须落到 `unknown`，不能静默当作 completed。

## 12.3 验收

```text
tool_call 初始状态正确。
tool_call_update completed/failed 正确。
错误和取消状态正确。
未知状态有稳定 fallback。
MessageRow 只依赖 lookups，不扫描完整数组。
```

---

# 13. P3：RenderMessage、visibility、grouping pipeline

## 13.1 pipeline 顺序

推荐顺序：

```text
normalize
→ filter null/empty messages
→ attach tool relationships
→ derive visibility
→ optional grouping
→ derive MessageLookups
→ MessageRow
```

## 13.2 可见性决策

新增纯函数：

```ts
type RenderDecision =
  | { kind: 'render'; message: RenderMessage }
  | { kind: 'skip'; reason: string }
  | { kind: 'collapse'; message: RenderMessage }
```

将以下逻辑集中处理：

```text
空 assistant
无可见输出的内部事件
不可见 system/attachment
tool result 是否已经由 grouped tool 包含
错误消息是否必须保留
```

不可见消息必须在：

```text
render cap 前
消息计数前
virtualization offset 前
```

过滤。

## 13.3 grouping

Claude Code `applyGrouping()` 的规则：

```text
原始 messages 不改变。
只合并支持 grouped rendering 的 tool。
至少两个相同类型 tool 才合并。
tool result 随 grouped message 关联。
verbose/transcript 可关闭 grouping。
```

Pylon 第一版只实现：

```text
tool_call 与 tool result 的 derived 关联
```

连续 tool 合并必须等产品展示语义明确后再做。

## 13.4 缓存

稳定 tools 数组可以使用：

```ts
const groupingCache = new WeakMap<Tools, Set<string>>()
```

仅当 tools 数组引用具有稳定生命周期时使用。不要在每次 render 都重建支持 grouping 的 tool 集合。

---

# 14. P4：Markdown 和 code highlight cache

## 14.1 先做低风险缓存

先不要实现 Stable Prefix，先处理静态内容：

```text
静态 assistant content cache
静态 code highlight cache
纯文本 fast path
```

缓存 key：

```text
Markdown：content + relevant display config
Code：language + code + relevant theme/config
```

必须有容量上限或生命周期清理，不能无限保留大段 tool output。

## 14.2 ReactMarkdown 注意事项

```text
静态消息：content 不变时复用派生结果。
streaming 消息：不要把缓存结果误用于仍在变化的文本。
CSS/theme 变化：缓存必须失效或 key 必须包含主题版本。
```

## 14.3 code highlight 注意事项

当前 `CodeBlock` 已经通过 `useEffect` 调用 `highlightCode()`，依赖：

```tsx
[language, code, isMultiLine]
```

缓存不能破坏：

```text
取消中的异步请求
组件卸载后的 setState 防护
sanitizeHtml
language fallback
```

## 14.4 验收

```text
静态历史 Markdown 不重复解析。
streaming Markdown 仍然实时更新。
代码高亮结果不串 language/code。
主题切换后颜色正确。
HTML sanitizer 仍然覆盖所有 innerHTML sink。
```

---

# 15. P4：block-level streaming Markdown

只有 P0 profiling 证明 Markdown 是主要瓶颈时才施工。

## 15.1 实施方法

新增独立组件：

```text
StreamingMarkdown.tsx
```

算法：

```text
strip 输入中的展示过滤标签
从上一次 stable boundary 开始解析
使用 Markdown parser 的顶层 block token
最后一个非空 block 作为 unstable suffix
前面的 block 作为 stable prefix
stable prefix 交给静态 Markdown renderer
unstable suffix 每个 chunk 重新解析
```

## 15.2 明确限制

```text
不是 inline token 级冻结。
不是严格 O(增量长度)。
单个持续增长的 paragraph 仍然会重复解析。
文本重置或 session 切换时必须清空 boundary。
```

## 15.3 验收样例

```text
普通段落 + 空行 + 新段落
未闭合代码块
已闭合代码块后继续文本
列表连续追加
表格流式追加
链接和强调标记跨 chunk
文本 reset
session switch
```

---

# 16. P5：单消息错误边界和类型穷举

## 16.1 单消息错误隔离

参考 Claude Code 的局部错误保护，为 Pylon 增加：

```text
MessageRenderBoundary
```

边界范围：

```text
单条 MessageRow
或单个 ToolCard / Markdown renderer
```

失败时：

```text
当前消息显示降级占位
记录工具名、消息 ID、渲染阶段
其他消息继续显示
```

不要让单个恶意/异常 Markdown 或 tool renderer 击穿整个 ChatView。

## 16.2 TypeScript exhaustiveness

对 tool status、RenderMessage type、visibility reason 使用穷举检查：

```ts
function assertNever(value: never): never {
  throw new Error(`未处理的消息状态: ${String(value)}`)
}
```

新增消息类型时，必须明确选择：

```text
有可见输出的 renderer
或明确加入 null-rendering 列表
```

---

# 17. P6：搜索索引缓存

当前 Pylon 没有 transcript search，本阶段是预留设计，不得提前增加 UI。

参考 Claude Code：

```ts
const searchTextCache = new WeakMap<Message, string>()
```

规则：

```text
搜索文本按 Message 引用缓存。
首次提取时 lower-case。
输入 query 时只做 indexOf。
tool 自定义 getSearchText 优先。
全量预热按 500 条分块并让出事件循环。
消息清空/session 切换后允许 WeakMap 自然回收。
```

不要：

```text
每次键入都重新 parse Markdown。
每次键入都 JSON.stringify tool output。
为了搜索再创建第二个 React root。
```

---

# 18. P7：Virtualization

## 18.1 启动条件

只有以下数据成立时才进入本阶段：

```text
1000+ 消息普通列表已经成为主要瓶颈。
MessageRow memo 仍不能满足性能目标。
DOM/fiber 数量和 Markdown 子树数量是主要开销。
已完成自动滚底和用户滚动状态。
消息 key 稳定。
```

几十条消息不需要 virtualization。几百条先做 memo/cache。数千条再考虑虚拟列表。

## 18.2 定义

Virtualization 不是分页，也不是删除历史消息：

```text
全部 Message 数据仍在内存。
只挂载视口附近的 DOM。
未挂载区域由 top/bottom spacer 占位。
```

## 18.3 浏览器实现要求

Pylon 当前滚动容器：

```css
.chat-view {
  overflow-y: auto;
}
```

实现至少需要：

```text
heightCache：按 message key 缓存高度
offsets：累计高度数组
measure：ResizeObserver 或 callback ref
二分查找窗口起点
topSpacer / bottomSpacer
overscan
动态高度变化后的 offset 失效
展开/折叠刷新高度
窗口 resize 修正
sticky bottom
用户上滚保护
```

## 18.4 未测量高度

参考 Claude Code 的原则：

```text
未测量高度使用偏低估计。
低估会多挂载消息，高估容易制造空白。
```

不要在 resize 时清空所有高度 cache。优先：

```text
按旧宽度/新宽度比例缩放估计。
保留当前窗口。
下一轮用真实 DOM 高度覆盖。
```

## 18.5 滚动性能

不要：

```tsx
onScroll={() => setScrollTop(element.scrollTop)}
```

改为：

```text
requestAnimationFrame 合并 scroll event
按滚动区间量化 React window 更新
视觉滚动由浏览器原生处理
React 只在挂载窗口需要改变时更新
```

## 18.6 快速滚动保护

需要限制：

```text
MAX_MOUNTED_ITEMS
MAX_NEW_ITEMS_PER_COMMIT
overscan
fast-scroll mode
```

快速 PageUp/拖动时不要一次性挂载几百个新消息。可以让窗口分几帧追上目标，避免同步长任务。

## 18.7 不可移植的 Claude Code 机制

禁止直接复制：

```text
Ink Box/Yoga 坐标
useTerminalViewport
OffscreenFreeze
ScrollBoxHandle
terminal scrollback 规则
```

---

# 19. P8：resize、scroll quantization、fast-scroll mount cap

如果 virtualization 已完成，再单独处理三个问题：

## 19.1 resize

触发源：

```text
chat 宽度变化
right panel 开关
sidebar 宽度变化
全局字体变化
chat font size/line height 变化
```

处理：

```text
标记受影响高度 cache
按宽度比例缩放旧估计
保留可见窗口
使用 ResizeObserver 更新真实高度
不要全量清空并重新挂载
```

## 19.2 scroll quantization

普通 wheel event 不能每次触发完整 React commit。使用：

```text
scroll event → rAF 合并
scrollTop → 区间 bin
bin 未变化 → 不更新 React window
bin 变化 → 更新窗口
```

## 19.3 fast-scroll mount cap

快速滚动时：

```text
限制一次新增 MessageRow 数量。
保持当前已挂载内容作为临时边界。
避免白屏优先于精确立即到达目标。
用户停止滚动后补齐窗口。
```

验收重点：

```text
快速拖动不冻结。
连续 PageUp 不产生长任务。
滚动停止后窗口最终正确。
不会出现永久空白。
```

---

# 20. P9：spinner stalled animation

当前 `GenerationFooter` 已经具备：

```text
spinner frame
spinner verb
interval
elapsed time
token count
stop button
completed/cancelled/error summary
```

闲置检测属于体验增强，不属于消息列表主线。

只有 profiling 证明 spinner timer 造成问题时才增加：

```text
3 秒无 token：降速
10 秒无 token：静态省略号
恢复 token：立即恢复
```

不得让 spinner 的 timer 更新触发历史 MessageRow 重渲染。

---

## 21. 每阶段统一验证

每个阶段完成后执行：

```bash
npm run build
npm run test:frontend
git diff --check
```

涉及消息事件时必须覆盖：

```text
live assistant chunk
thinking chunk
tool call
tool update
peri:done
peri:error
cancel_prompt
replay/load_persisted_session
session switch
```

涉及渲染安全时额外覆盖：

```text
异常 Markdown
异常 code highlight
未知 tool
异常 tool input
异常 tool output
HTML sanitizer sink
单消息 renderer throw
```

涉及滚动时额外覆盖：

```text
底部生成
用户上滚后生成
点击回底
tool output 展开
Thinking 展开
窗口 resize
session replay
```

---

## 22. 当前执行任务

当前已完成施工卡：

```text
P0：性能基线观测接入
P1：MessageRow 提取 + 保守 memo
P1：消息显示层 pipeline（一对一映射 + 空 assistant visibility）
P2：streamingText / streamingThinking 视图分离
P2：sticky / user_scrolled / jumping 自动滚底
P2：稳定滚动 callback wiring
P3：ToolVisualState 归一化
P3：MessageLookups 预计算
P3：ToolPresentation 基础 registry
P3：MessageRow 最小 toolVisualState props
P4：静态 code highlight cache
```

已完成提交：

```text
2b0a09c perf(chat): add render metrics and memoized message rows
 a366065 perf(chat): isolate live streaming message preview
 f293a7e perf(chat): preserve user scroll position during streaming
 ff93cd0 perf(chat): stabilize scroll callback wiring
 a1e516d perf(chat): normalize tool states and precompute lookups
 cd2bdf0 perf(chat): isolate tool presentation summaries
 0176350 perf(chat): cache static code highlighting
 81cb094 perf(chat): narrow memoized row tool props
```

### 22.1 当前实现边界

已建立的前端分层：

```text
ACP events
    ↓
ChatView source isolation / replay / persistence
    ↓
Message[] 原始消息
    ↓
messagePipeline → RenderMessage[]
    ↓
MessageLookups / ToolVisualState
    ↓
MemoMessageRow
    ↓
AssistantContent / ReasoningBlock / ToolCard
    ↓
ReactMarkdown / Starry Night
```

当前关键文件：

```text
src/components/chat/renderMetrics.ts
src/components/chat/messageTypes.ts
src/components/chat/messagePipeline.ts
src/components/chat/messageLookups.ts
src/components/chat/toolPresentation.ts
src/components/chat/toolStatus.ts
src/components/chat/codeHighlight.ts
src/components/chat/ChatView.tsx
```

P0 开发环境观测接口：

```js
window.__PYLON_RENDER_METRICS__.snapshot()
window.__PYLON_RENDER_METRICS__.reset()
```

已观测指标：

```text
ChatView.render
MessageRow.render
AssistantContent.render
ReasoningBlock.render
ToolCard.render
CodeBlock.render
messages.map
highlightCode.call
scrollIntoView.call
streamingText.render
streamingThinking.render
markdown.parse
CodeBlock.highlight（measures）
messages.map（measures）
```

### 22.2 已验证结果

最近一次完整验证：

```text
npm run build       PASS
npm run test:frontend PASS
 git diff --check   PASS
```

Build 仍有既有 warning，非本次引入：

```text
@tauri-apps/plugin-dialog 动态/静态导入混用
主 bundle 超过 500 kB
```

前端施工 commit 未包含用户已有改动。交接时工作区存在其他 lane/用户改动，尤其注意不要覆盖或回滚：

```text
src/App.css
src/workspace-sheets/SheetTabStrip.tsx
src-tauri/ 下用户已有改动
FINAL-AUDIT-20260731.md
references/claude-code-rendering.md
scripts/agent-workflow/sync_kanban.py
```

### 22.3 重要语义和风险记录

```text
1. live agent_message_chunk / agent_thought_chunk 已进入独立 streaming state；replay 仍直接写 replay buffer。
2. tool_call 到来前会 flush 当前 live streaming 文本，保持 tool 前后顺序。
3. peri:done / peri:error / cancel 会保留并 flush 已收到的 live 文本。
4. session switch 会清空 streaming state，避免旧 source 污染当前界面。
5. sticky 状态才自动滚底；用户上滚后不会被新 chunk 拉回底部。
6. MessageRow comparator 使用消息对象引用和必要 tool 字段，无法证明静态时重新渲染。
7. ToolPresentation 只负责输入摘要；未知 tool 仍走 fallback。
8. ToolVisualState 未知后端状态归一化为 unknown，不静默当作 completed。
9. code highlight cache 使用 language+code key，容量上限 128，并复用相同 key 的 pending Promise。
10. 尚未实现 Markdown ReactNode cache；直接缓存 ReactNode 会有 theme、hook 和 stale element 风险。
11. 尚未实现 block-level streaming Markdown、单消息 ErrorBoundary、virtualization。
12. 当前真实 ACP 流式 runtime 数据仍未形成持久化基线报告；P0 目前是观测接入，不要把 mock 数据当作生产性能结论。
```

### 22.4 下一张施工卡

优先级建议：

```text
P4：plain-text fast path
```

实施边界：

```text
仅对确认不含 Markdown 结构的静态 assistant 文本绕过 ReactMarkdown。
streamingText 不进入该 fast path。
含代码、链接、列表、表格、blockquote、强调标记等内容继续使用 ReactMarkdown。
先加纯函数判定和专项回归，再接入 AssistantContent。
不缓存 ReactNode，不改变 CSS 和 Markdown 语义。
```

完成后再评估：

```text
P4：block-level streaming Markdown（只有 profiling 证明必要才做）
P5：单消息错误边界和 TypeScript exhaustiveness
P6：搜索索引缓存
P7：virtualization
```

P0 未形成真实 ACP runtime 数据前，不得以理论复杂度替代运行时证据，也不要提前做 virtualization。

本文件后续随着每张施工卡的真实验证结果更新，不以 Claude Code 的理论结构替代 Pylon 的运行时证据。
