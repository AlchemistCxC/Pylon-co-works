# Pylon 后端 API 参考文档

> 面向前端开发者（React/TypeScript）。后端是 Tauri v2 Rust 应用，通过 `invoke()` 调用命令，通过 `listen()` 接收事件。

---

## 架构概览

```
┌─────────┐  invoke()   ┌──────────────┐  stdin/stdout   ┌──────────┐
│  React  │ ◄─────────► │ Rust Backend │ ◄─────────────► │ Peri.exe │
│  前端   │  listen()   │  (Pylon)     │  JSON-RPC 2.0   │ (ACP)    │
└─────────┘             └──────────────┘                 └──────────┘
```

- 后端是**薄桥接层**：只翻译 Tauri invoke → ACP JSON-RPC，不做业务逻辑
- 一个 Rust 进程管理多个 session（map 以 `source` 为 key）
- 每次 invoke 可以触发多个 event 推送回前端

---

## 数据类型

### SessionInfo（前端可见字段）

| 字段 | 类型 | 说明 |
|:-----|:-----|:-----|
| `source` | `string` | 前端指定的 session 唯一标识（如 tab id） |
| `periId` | `string` | Agent 端 session ID，用于 load/export 等操作 |
| `persona` | `string` | 创建时传入的 persona 文本 |
| `cwd` | `string` | 会话工作目录 |
| `title` | `string` | 会话标题（来自 `sessionInfoUpdate` 通知） |
| `model` | `string` | 当前模型名 |
| `tokensIn` | `number` | 输入 token 累计 |
| `tokensOut` | `number` | 输出 token 累计 |
| `tokensTotal` | `number` | total token 累计 |
| `contextSize` | `number` | 模型上下文窗口上限 |

### AgentDef

| 字段 | 类型 | 说明 |
|:-----|:-----|:-----|
| `id` | `string` | agent key（如 `"peri"`） |
| `name` | `string` | 显示名（如 `"Peri"`） |
| `transport` | `string` | 传输方式，目前固定 `"subprocess"` |

### PersistedSession

| 字段 | 类型 | 说明 |
|:-----|:-----|:-----|
| `sessionId` | `string` | session ID |
| `cwd` | `string` | 工作目录 |
| `title` | `string` | 会话标题 |
| `updatedAt` | `string` | ISO 时间戳 |

### PetState

| 字段 | 类型 | 说明 |
|:-----|:-----|:-----|
| `mood` | `string` | 心情：`idle`/`curious`/`excited`/`sleepy`/`error`/`happy` |
| `happiness` | `number` | 0-100 |
| `messages` | `number` | 总消息数 |
| `totalTokens` | `number` | 累计 token |
| `toolsSucceeded` | `number` | 成功工具调用次数 |
| `name` | `string` | 名字（默认 `"豆豆"`） |
| `msg` | `string?` | 一次性气泡消息，读取后清空 |
| `memories` | `string[]` | 记忆片段（最多 10 条） |

---

## Tauri Commands

通过 `invoke('command_name', { ... })` 调用，返回 Promise。

### 1. new_session — 创建新会话

```
invoke('new_session', {
  source: string,    // 前端会话标识（如 tab id）
  persona: string,   // persona/soul 内容
  cwd?: string,      // 工作目录，默认取当前 agent 的 cwd
}): Promise<{
  sessionId: string,
  modes: { modes: string[] },
  configOptions: ConfigOption[],
}>
```

- 内部调用 ACP `session/new`
- 返回完整的 Peri response（含 modes + configOptions）
- session 上限 100 个

### 2. send_message — 发送消息并等待回复

```
invoke('send_message', {
  source: string,            // 会话标识
  content: string,           // 用户输入文本
  persona: string,           // persona 文本（用于自动创建 session 时）
  sessionPrompt?: string,    // 首条消息前插入的 persona/soul（优先级高于 persona 字段）
  attachments?: string[],    // 附件文件路径数组
}): Promise<string>          // 返回 peri session ID
```

**行为细节**：

- 如果 `source` 对应的 session 不存在，自动调用 `new_session` 创建
- **首条消息**且非 `/` 命令开头时，persona 自动前置到消息开头：`{persona}\n\n---\n\n{content}`
- `sessionPrompt` 优先级高于 `persona`——传了 sessionPrompt 就用它，忽略 persona
- attachments 以 `[Attached: 文件名]\n` 前缀注入
- 超时 300 秒后返回 error

**事件流**（按顺序）：

```
peri:user     → { source, content }                     // 用户消息回显
peri:update   → 多次，见下方「事件」章节
peri:done     → { source, data: stopResult }            // 回复完成
peri:error    → { source, error }                       // 仅在出错时
```

### 3. set_mode — 切换会话模式

```
invoke('set_mode', {
  source: string,
  mode: string,  // 如 "default" | "edit" | "auto" | "bypass"
}): Promise<void>
```

### 4. set_config_option — 修改配置选项

```
invoke('set_config_option', {
  source: string,
  key: string,     // 如 "model"、"thinking_effort"、"context_1m"
  value: string,   // 配置值
}): Promise<object>  // 返回 agent 的完整 configOptionUpdate
```

- 常用 key：`model`、`thinking_effort`、`context_1m`、`mode`

### 5. close_session — 关闭会话

```
invoke('close_session', {
  source: string,
}): Promise<void>
```

- 关闭前端 session 并通知 agent 释放资源（ThreadStore、cancel tokens）
- 失败不抛错（best-effort）

### 6. cancel_prompt — 取消正在运行的 prompt

```
invoke('cancel_prompt', {
  source: string,
}): Promise<void>
```

- Fire-and-forget：agent 收到后以 `stopReason: "cancelled"` 结束当前 prompt

### 7. load_sessions — 获取当前所有 session 列表

```
invoke('load_sessions'): Promise<SessionInfo[]>
```

### 8. list_agents — 列出可用 agent

```
invoke('list_agents'): Promise<AgentDef[]>
```

### 9. switch_agent — 切换 agent

```
invoke('switch_agent', {
  name: string,  // agent id（如 "peri"）
}): Promise<void>
```

- **会杀死当前 agent 进程**，启动新 agent
- **清空所有 session**（前端需重新创建 session）

### 10. reconnect_agent — 重连当前 agent

```
invoke('reconnect_agent'): Promise<void>
```

- 杀死旧进程，重新 spawn
- 成功后 emit `peri:agent-status` 事件

### 11. agent_status — 查询 agent 状态

```
invoke('agent_status'): Promise<{
  agent: string,
  crashed: boolean,
}>
```

### 12. reload_agents — 重新加载 agents.yaml

```
invoke('reload_agents'): Promise<void>
```

### 13. get_pet — 获取电子宠物状态

```
invoke('get_pet'): Promise<PetState>
```

- `msg` 字段是一次性的：读取后清零

### 14. pet_action — 宠物交互

```
invoke('pet_action', {
  action: string,    // "poke" | "feed" | "rename" | "daily" | "sleepy" | "nostalgia"
  value?: string,    // 仅 rename 时需要（新名字）
}): Promise<PetState>
```

| action | 效果 |
|:-------|:-----|
| `poke` | happiness +5，mood → happy |
| `feed` | happiness +15，mood → happy |
| `rename` | 改名字，需传 value |
| `daily` | happiness -5（每日衰减） |
| `sleepy` | 检测是否超过 30s 无响应 → mood 变 sleepy |
| `nostalgia` | 随机回忆一条记忆 |

### 15. load_persisted_session — 加载持久化会话

```
invoke('load_persisted_session', {
  source: string,    // 前端新建的 session 标识
  periId: string,    // 从 list_persisted_sessions 取到的 sessionId
}): Promise<void>
```

- Agent 会通过 `peri:update` 重放历史消息（`userMessageChunk` + `agentMessageChunk`）
- 加载完成后 session 状态为 `hasFirstPrompt: true`

### 16. list_persisted_sessions — 列出持久化会话

```
invoke('list_persisted_sessions'): Promise<{
  sessions: PersistedSession[],
}>
```

### 17. export_session — 导出会话

```
invoke('export_session', {
  periId: string,       // session ID
  format: string,       // "markdown" | "json"
  outputPath: string,   // 输出文件路径（绝对路径）
}): Promise<void>
```

- `"markdown"` 格式：提取所有 `agentMessageChunk` 拼接为 Markdown
- `"json"` 格式：所有 session/update 消息 JSON prettified

---

## 事件（Events）

前端通过 `listen('event_name', callback)` 订阅。所有事件 payload 均为 JSON 对象。

### peri:update — 会话状态更新（核心事件）

```typescript
listen('peri:update', (event) => {
  const payload: {
    source: string,       // 由后端注入
    sessionId: string,
    update: {
      sessionUpdate: string,  // 变体名（见下表）
      // ... 变体特定字段
    }
  }
})
```

**变体一览**：

| sessionUpdate | 关键字段 | 说明 |
|:--------------|:---------|:-----|
| `agentMessageChunk` | `content: { text: string }` | AI 回复文本流（delta） |
| `agentThoughtChunk` | `content: { text: string }` | AI 思考过程（cot） |
| `userMessageChunk` | `content: { text: string }` | 用户消息回显（load 重放时） |
| `toolCall` | `title, toolCallId, rawInput` | 工具调用开始 |
| `toolCallUpdate` | `toolCallId, rawOutput, status` | 工具调用结果（status: "completed"/"error"） |
| `usageUpdate` | `value, size, _meta: { inputTokens, outputTokens, model, ... }` | Token 使用统计 |
| `sessionInfoUpdate` | `title, cwd, updatedAt` | 会话元数据（标题等） |
| `configOptionUpdate` | `key, value` 或 `configOptions[]` | 配置变更 |
| `availableCommandsUpdate` | `commands: [{ name, description, input_hint }]` | 可用命令列表 |
| `plan` | `title, steps` | 计划模式输出 |

**注意**：
- 每条 `peri:update` 都带 `source` 字段（后端注入），前端按 `source` 路由到对应 tab
- `agentMessageChunk` 是**增量**文本，前端自行拼接
- `usageUpdate` 的 `value` 是**累计** token，`size` 是上下文窗口上限

### peri:done — Prompt 回复完成

```typescript
listen('peri:done', (event) => {
  const payload: {
    source: string,
    data: {
      stopReason: string,  // "end_turn" | "cancelled" | "max_tokens" | ...
    }
  }
})
```

- 每条 prompt 只触发一次
- 收到此事件后，该 prompt 的所有 `peri:update` 已发送完毕

### peri:error — 错误事件

```typescript
listen('peri:error', (event) => {
  const payload: {
    source: string,
    error: string,  // 错误描述
  }
})
```

触发场景：
- Agent 进程崩溃（`"agent process crashed"`）
- Prompt 超时（`"timed out after 300s"`）
- ACP 连接断开

### peri:user — 用户消息回显

```typescript
listen('peri:user', (event) => {
  const payload: {
    source: string,
    content: string,  // 用户输入文本
  }
})
```

- `send_message` 调用时立即发送
- `load_persisted_session` 重放历史时也会发送

### peri:agent-status — Agent 连接状态

```typescript
listen('peri:agent-status', (event) => {
  const payload: {
    status: string,  // 目前只有 "connected"
  }
})
```

- 仅 `reconnect_agent` 成功后发送

---

## 前端典型工作流

### 1. 应用启动

```
list_agents()        → 获取可用 agent 列表
agent_status()       → 确认连接状态
get_pet()            → 获取宠物初始状态
list_persisted_sessions() → 获取历史会话列表
```

### 2. 创建新 Chat Tab

```
new_session(tabId, persona, cwd) → 获取 modes + configOptions
开始监听 peri:update / peri:done / peri:error / peri:user
```

### 3. 发送消息

```
send_message(tabId, text, persona)
→ 立即收到 peri:user（回显）
→ 多次 peri:update（流式 agentMessageChunk + usageUpdate + toolCall...）
→ 最终 peri:done
```

### 4. 恢复历史会话

```
list_persisted_sessions()                     → 选一个 sessionId
load_persisted_session(newTabId, sessionId)   → 触发 replay
→ peri:update 流（userMessageChunk + agentMessageChunk 交替出现，重建对话）
```

### 5. 导出会话

```
export_session(periId, "markdown", "C:\\Users\\...\\export.md")
```

---

## 注意事项

1. **`source` 是前端定义的**：不一定是 tab id，只要能唯一标识即可，后端只做 map key
2. **Mutex 锁**：后端用 `std::sync::Mutex`（不是 tokio），所以每个 invoke **同步执行**，不会并发修改 session map
3. **session 上限 100**：超出返回 `"max sessions reached"`
4. **agent crash**：如果 agent 进程意外退出，`agent_status()` 会返回 `crashed: true`，前端应调用 `reconnect_agent()`
5. **ACP 协议**：后端是薄封装——更多协议细节见 `ACP-SPEC.md`
6. **宠物自动更新**：宠物在 send_message / usageUpdate / toolCall 时自动更新状态，前端可定时调 `get_pet()` 拉取最新
7. **`pet_action("sleepy")`**：前端可定时（如每秒）调用来检测发呆状态；如果首条 agent chunk 后 30s 无响应，mood 变 sleepy
8. **Tauri 窗口**：无边框（`decorations: false`）、透明背景（`transparent: true`），前端需自行实现窗口拖拽和关闭按钮
