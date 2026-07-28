# Prism Desktop 前端 API 接口文档

更新时间：2026-07-28
后端实现：`src-tauri/src/lib.rs`
ACP transport：`src-tauri/src/acp.rs`

## 1. 接入原则

### 1.1 Tauri 参数命名

Rust 参数使用 snake_case，但 Tauri JS invoke 参数使用 camelCase：

```ts
invoke('load_persisted_session', {
  source,
  periId,
  cwd,
})
```

### 1.2 三层 Session ID

| 前端字段 | 含义 | 可否传后端 command |
|---|---|---|
| `Session.id` | Zustand 本地 ID | 不可直接传 ACP command |
| `Session.source` | Pylon 后端 session key | 传给 `source` 参数 |
| `Session.periId` | Peri 远端 sessionId | 仅传 `load_persisted_session` / `export_session` |

普通发送、mode、model、cancel、close 必须使用 `Session.source`。

### 1.3 错误处理

所有 command 都可能 reject 一个字符串错误。前端不得使用空 `.catch(() => {})` 处理用户操作：

```ts
try {
  await invoke('close_session', { source })
} catch (error) {
  showError(String(error))
}
```

常见错误：

- `agent process crashed`
- `ACP connection closed`
- `RPC timeout after 30s`
- `timed out after 300s`
- `session not found: <source>`
- `stale ACP client generation: expected X, current Y`
- `max sessions reached`
- `unknown agent: <id>`
- 附件读取、大小或 MIME 错误

出现 stale generation 时，前端应取消乐观提交、重新读取当前 Agent/session 状态。

## 2. 推荐 TypeScript 类型

```ts
export interface ConfigOptionChoice {
  id: string
  name: string
}

export interface ConfigOption {
  id: string
  type: string
  currentValue?: string
  options?: ConfigOptionChoice[]
}

export interface SessionResponse {
  sessionId: string
  modes?: unknown
  configOptions?: ConfigOption[]
}

export interface BackendSession {
  source: string
  periId: string
  persona: string
  cwd: string
  title: string
  model: string
  tokensIn: number
  tokensOut: number
  tokensTotal: number
  contextSize: number
}

export interface AgentSummary {
  id: string
  name: string
  transport: string
}

export interface AgentStatus {
  agent: string
  crashed: boolean
}

export interface PeriUserPayload {
  source: string
  content: string
  replay?: boolean
}

export interface PeriUpdatePayload {
  source: string
  sessionId: string
  update: {
    sessionUpdate: string
    [key: string]: unknown
  }
}

export interface PeriDonePayload {
  source: string
  data: {
    stopReason?: string
    [key: string]: unknown
  }
}

export interface PeriErrorPayload {
  source: string
  error: string
}
```

## 3. Session Commands

### 3.1 `new_session`

创建 Peri session，并建立 `source -> periId` 映射。

```ts
const response = await invoke<SessionResponse>('new_session', {
  source: session.source,
  persona,
  cwd: session.workdir || null,
})
```

参数：

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `source` | string | 是 | 前端 session.source |
| `persona` | string | 是 | 首轮 persona |
| `cwd` | string \| null | 否 | Agent 工作目录；空时使用 active Agent cwd |

返回：完整 Peri `session/new` response。

```json
{
  "sessionId": "uuid",
  "modes": {},
  "configOptions": []
}
```

注意：返回值不是 string。前端应保存 `response.sessionId` 为 `Session.periId`。

失败语义：

- 超过 100 个 session：`max sessions reached`
- 无 Agent/连接失败
- 非法 `sessionId`（空或 `error`）
- Agent 切换并发：stale generation error

源码：`lib.rs:212-238`。

### 3.2 `send_message`

发送文本和附件。若 source 尚无映射，后端会隐式创建 session。

```ts
const periId = await invoke<string>('send_message', {
  source: session.source,
  content: text,
  persona,
  sessionPrompt: session.prompt || null,
  attachments: paths,
})
```

参数：

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `source` | string | 是 | session.source |
| `content` | string | 是 | 用户文本或 slash command |
| `persona` | string | 是 | Profile persona |
| `sessionPrompt` | string \| null | 否 | 非空时覆盖 persona |
| `attachments` | string[] \| null | 否 | 文件路径，最多 8 个 |

返回：成功使用的 periId。

事件顺序：

```text
peri:user → peri:update... → peri:done
                        ↘ peri:error
```

首轮 persona：

- `sessionPrompt.trim()` 非空：使用 Session Prompt。
- 否则使用 persona。
- 内容以 `/` 开头时不注入 persona。

附件：

- 单文件最大 10 MiB。
- 支持 UTF-8 文本。
- 支持 PNG/JPEG/GIF/WebP 图片。
- 不支持类型返回错误，不能假装发送成功。

前端要求：

- invoke 成功后才清空文本和附件。
- 失败保留用户输入。
- 生成态按 `source` 管理，不能用单一 boolean。

源码：`lib.rs:240-378`、`acp.rs:278-350`。

### 3.3 `set_mode`

```ts
await invoke('set_mode', {
  source: session.source,
  mode: modeId,
})
```

后端 ACP 参数使用 `modeId`。失败或 stale 时前端回滚乐观 mode。

源码：`lib.rs:380-388`。

### 3.4 `set_config_option`

用于 model、thinking effort 等 Peri config option。

```ts
const response = await invoke<unknown>('set_config_option', {
  source: session.source,
  key: 'model',
  value: modelId,
})
```

后端发送：

```json
{
  "sessionId": "<periId>",
  "configId": "model",
  "value": {
    "valueId": {
      "value": "<modelId>"
    }
  }
}
```

失败时必须回滚当前 source 的乐观配置。

源码：`lib.rs:389-397`、`acp.rs:267-275`。

### 3.5 `cancel_prompt`

```ts
await invoke('cancel_prompt', { source: session.source })
```

ACP `session/cancel` 是 notification，没有业务 response。前端不能因为 invoke resolve 就立即假定 prompt 已完全结束；最终收敛由后端 prompt response/error 控制。

源码：`lib.rs:413-421`。

### 3.6 `close_session`

```ts
await invoke('close_session', { source: session.source })
```

远端 close 成功后后端才删除本地映射。失败时映射保留，可以重试。

前端删除实体建议：

1. 调用 close。
2. 成功后删除本地 session。
3. 失败时显示错误并保留重试入口。

源码：`lib.rs:399-411`。

### 3.7 `load_sessions`

读取当前 Pylon 进程内的 session 映射，不是 Peri 持久化列表。

```ts
const sessions = await invoke<BackendSession[]>('load_sessions')
```

返回字段见 `BackendSession`。

源码：`lib.rs:423-431`。

## 4. Persisted Session Commands

### 4.1 `list_persisted_sessions`

```ts
const result = await invoke<unknown>('list_persisted_sessions')
```

返回 Peri `session/list` 原始 result。当前后端没有转换为固定 Pylon DTO；前端接入前应通过真实 Peri response 固化类型，不要猜测字段。

Agent 切换期间旧 response 会以 stale error 拒绝。

源码：`lib.rs:569-576`。

### 4.2 `load_persisted_session`

```ts
const response = await invoke<SessionResponse>('load_persisted_session', {
  source: session.source,
  periId: session.periId,
  cwd: session.workdir || null,
})
```

重要时序：Peri 在 command resolve 前通过 `peri:user` / `peri:update` replay 历史。

前端恢复状态机：

1. 进入 replaying，不进入 live generating。
2. 接收 `replay:true` 的 user events 和 replay update。
3. command resolve 作为 replay 完成边界。
4. 使用 response 的 modes/configOptions 恢复会话配置。
5. load 失败时才使用本地缓存 fallback。

源码：`lib.rs:537-567`。

### 4.3 `export_session`

```ts
await invoke('export_session', {
  periId: session.periId,
  format: 'markdown',
  outputPath,
})
```

参数：

| 参数 | 类型 | 说明 |
|---|---|---|
| `periId` | string | 远端 Peri sessionId，不是 source |
| `format` | string | `markdown` 或其他值（其他值输出 JSON） |
| `outputPath` | string | 目标文件路径 |

内容覆盖 user、assistant、reasoning、tool 和 metadata。Agent 切换导致 stale 时不会写文件。

源码：`lib.rs:578-689`。

## 5. Agent Commands

### 5.1 `list_agents`

```ts
const agents = await invoke<AgentSummary[]>('list_agents')
```

返回：

```json
[
  { "id": "peri", "name": "Peri", "transport": "subprocess" }
]
```

### 5.2 `switch_agent`

```ts
await invoke('switch_agent', { name: agent.id })
```

成功后：

- active Agent 改变。
- generation +1。
- 后端 sessions map 清空。
- notification dispatcher 重建。
- 旧 Agent 被 kill+wait。

前端必须同步清理或重建 session runtime，不能只改 Agent 标签。

失败时旧 Agent、旧 sessions 和 activeAgent 保持不变。

源码：`lib.rs:442-473`。

### 5.3 `reconnect_agent`

```ts
await invoke('reconnect_agent')
```

成功后发出 `peri:agent-status` connected event，sessions 同样被清空。

源码：`lib.rs:475-483`。

### 5.4 `agent_status`

```ts
const status = await invoke<AgentStatus>('agent_status')
```

返回：

```json
{
  "agent": "Peri",
  "crashed": false
}
```

建议前端：

- 应用启动时查询一次。
- send 失败出现 crashed/closed 时重新查询。
- 提供 reconnect 操作。
- `crashed=true` 时显示降级状态，不能让整个 UI 崩溃。

### 5.5 `reload_agents`

```ts
await invoke('reload_agents', {
  configPath: 'C:\\path\\agents.yaml',
})
```

如果不传 `configPath`，必须由进程环境提供 `PYLON_AGENTS_CONFIG`。

reload 只替换 Agent registry，不自动 switch/reconnect。

源码：`lib.rs:493-502`、`agent_config.rs:55-63`。

## 6. Pet Commands

### 6.1 `get_pet`

```ts
const pet = await invoke<PetState>('get_pet')
```

```ts
interface PetState {
  mood: 'idle' | 'curious' | 'excited' | 'sleepy' | 'error' | 'happy'
  happiness: number
  first_chunk_at_ms: number | null
  messages: number
  total_tokens: number
  tools_succeeded: number
  name: string
  memories: string[]
  msg?: string
}
```

`msg` 是消费式字段：读取后后端会清空。

### 6.2 `pet_action`

```ts
await invoke<PetState>('pet_action', {
  action: 'rename',
  value: '豆豆',
})
```

支持 action：

- `poke`
- `feed`
- `rename`
- `daily`
- `sleepy`
- `nostalgia`

未知 action 返回错误。

## 7. Tauri Events

所有事件都必须按 `payload.source` 路由。后台 source 的事件不能因为当前页面不是该 session 而丢弃。

### 7.1 `peri:user`

```ts
const unlisten = await listen<PeriUserPayload>('peri:user', ({ payload }) => {
  routeUserMessage(payload.source, payload.content, payload.replay === true)
})
```

Payload：

```json
{
  "source": "frontend-source",
  "content": "text",
  "replay": false
}
```

live send 和 replay 都可能产生该事件。`replay:true` 不得启动生成态。

### 7.2 `peri:update`

后端在 Peri 原始 `session/update` params 上增加 `source`。

```json
{
  "source": "frontend-source",
  "sessionId": "peri-id",
  "update": {
    "sessionUpdate": "agent_message_chunk"
  }
}
```

已知 `sessionUpdate`：

- `user_message_chunk`
- `agent_message_chunk`
- `agent_thought_chunk`
- `tool_call`
- `tool_call_update`
- `usage_update`
- `available_commands_update`
- `config_option_update`
- `session_info_update`

必须使用 snake_case。

### 7.3 `peri:done`

```json
{
  "source": "frontend-source",
  "data": {
    "stopReason": "end_turn"
  }
}
```

仅在业务 response 合法且 generation 未变化时发出。

### 7.4 `peri:error`

```json
{
  "source": "frontend-source",
  "error": "error text"
}
```

前端必须读取 `payload.error`，不能 stringify 整个 payload。

### 7.5 `peri:agent-status`

当前只在 reconnect 成功后发送：

```json
{ "status": "connected" }
```

应用启动失败的 disconnected 状态需要通过 `agent_status` 主动查询。

## 8. 前端接入状态检查表

| 接口 | 当前前端使用 | 接入要求 |
|---|---|---|
| new_session | 已使用 | 保持完整 response 类型 |
| send_message | 已使用 | 失败保留输入/附件 |
| set_mode | 已使用 | source 隔离、失败回滚 |
| set_config_option | 已使用 | source 隔离、失败回滚 |
| cancel_prompt | 已使用 | 不静默 catch |
| close_session | 已使用 | 失败保留 session 并提示 |
| load_sessions | 待确认 | 用于进程内状态恢复/诊断 |
| list_persisted_sessions | 待接入 | 先以真实 response 固化 DTO |
| load_persisted_session | 已使用 | replay 状态机 |
| export_session | 已使用 | periId 与 source 不混用 |
| list_agents | 已使用 | Agent 设置页 |
| switch_agent | 已使用 | 成功后清理 session runtime |
| reconnect_agent | 待接入 | Agent 错误页自愈 |
| agent_status | 待接入 | 启动状态/崩溃状态 |
| reload_agents | 待接入 | 需要 configPath 或环境变量 |
| get_pet | 待确认 | msg 为消费式 |
| pet_action | 待确认 | action 白名单 |
| peri:user/update/done/error | 已使用 | 应用级按 source 路由 |
| peri:agent-status | 待接入 | reconnect 状态反馈 |

## 9. 推荐封装

不要在组件中散落 invoke/listen。建议建立：

```text
src/api/backend.ts          // command wrappers + DTO
src/runtime/sessionEvents.ts // 全局事件监听与 source 路由
src/runtime/agentState.ts    // status/switch/reconnect/reload
```

示例：

```ts
export const backend = {
  newSession: (args: NewSessionArgs) => invoke<SessionResponse>('new_session', args),
  sendMessage: (args: SendMessageArgs) => invoke<string>('send_message', args),
  closeSession: (source: string) => invoke<void>('close_session', { source }),
  agentStatus: () => invoke<AgentStatus>('agent_status'),
}
```

事件监听必须在应用级只注册一次，并在 cleanup 中执行所有 unlisten。

## 10. 前端联调验收

1. Agent 不可用时 UI 启动并显示 reconnect。
2. A 生成时切 B，A 事件继续完整落入 A 仓库。
3. A/B mode、model、generating 各自隔离。
4. send/close/cancel/config 失败均向用户显示，且不丢输入或本地实体。
5. replay 不重复、不启动 spinner；load resolve 后完成恢复。
6. switch Agent 后旧 Agent 的迟发 done/update 不进入 UI。
7. export 使用 periId，其他会话 command 使用 source。
8. 所有 event variant 按 snake_case 解析。
