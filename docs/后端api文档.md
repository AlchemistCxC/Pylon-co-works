# 后端API文档

> 项目：Pylon / Prism Desktop
> API 层：Tauri v2 command + Tauri event
> Pylon 路径：`G:\Project\prism-desktop`
> ACP 真值参考：`F:\A-I\Agent\Peri` 实际 Rust handler/schema
> 审计基线：2026-07-30

## 1. 调用规则

### 1.1 Tauri command

前端使用：

```ts
import { invoke } from '@tauri-apps/api/core'
await invoke('command_name', { camelCaseArgument: value })
```

Rust 参数使用 snake_case，Tauri 负责前端 camelCase 到 Rust 参数名的映射。例如 Rust 的 `session_prompt` 对应前端 `sessionPrompt`，`mcp_servers` 对应 `mcpServers`。

所有 command 返回 `Result<T, String>`；前端必须显示错误或执行明确回滚，不能静默吞错。

### 1.2 三层 Session ID

| 字段 | 所在层 | 用途 | 能否替代其他字段 |
|---|---|---|---|
| `Session.id` | React/Zustand | 本地实体、消息缓存 owner | 不能当 `source` 或 ACP `sessionId` |
| `Session.source` | Pylon/Tauri | command/event 路由、Rust sessions map key | 不能当 ACP `sessionId` |
| `Session.periId` | Peri ACP | 远端 session 操作 | 不能当本地 `source` |

## 2. Session / Prompt commands

### 2.1 `new_session`

Rust：`src-tauri/src/lib.rs::new_session`

请求：

```ts
{
  source: string,
  persona: string,
  cwd?: string,
  mcpServers?: McpServerConfig[]
}
```

行为：

1. 获取 session creation lock。
2. 限制内存 session 总数不超过 100。
3. `cwd` 缺省使用当前 Agent cwd。
4. 校验并序列化 MCP。
5. ACP 调用 `session/new`。
6. 解析并校验 response 中的 `sessionId`。
7. 将 `source → SessionInfo(periId, cwd, persona, generation, modes/configOptions)` 写入内存。
8. 若 source 已存在，写入新映射后尝试关闭旧 Peri session。

ACP 请求：

```json
{
  "cwd": "G:/work",
  "mcpServers": []
}
```

返回：Peri `session/new` response 原样 JSON，当前前端读取：

```json
{
  "sessionId": "...",
  "modes": { "currentModeId": "..." },
  "configOptions": []
}
```

Peri 实际 handler：`F:\A-I\Agent\Peri\peri-tui\src\acp_server\requests.rs` 的 `session/new` 分支和 `peri-tui/src/acp_stdio/session/create.rs::handle_new`。

### 2.2 `send_message`

Rust：`src-tauri/src/lib.rs::send_message`

请求：

```ts
{
  source: string,
  content: string,
  persona: string,
  sessionPrompt?: string,
  attachments?: string[],
  mcpServers?: McpServerConfig[]
}
```

行为：

- 按 `source` 加 prompt lock，同一 source 不并发发送。
- Agent crashed 时发出 `peri:error` 并返回错误。
- source 没有 SessionInfo 时自动创建 `session/new`。
- 首次且不是 slash command 时，将 `sessionPrompt`（非空优先）或 `persona` 与 content 拼接：

```text
<persona/sessionPrompt>

---

<content>
```

- 附件转为 ACP content blocks；限制和 MIME 检查在 `acp.rs::prompt_blocks`。
- ACP 调用 `session/prompt`，等待 response。
- 超时默认 300 秒，发送 `session/cancel`，等待 settle；仍不收敛则删除匹配映射并尝试 `session/close`。

返回：成功时返回远端 `periId` 字符串；错误时返回字符串错误。

ACP 请求：

```json
{
  "sessionId": "peri-session-id",
  "prompt": [
    { "type": "text", "text": "..." }
  ]
}
```

前端同时收到 `peri:user`；后续流式数据见事件章节。

### 2.3 `set_mode`

请求：

```ts
{ source: string, mode: string }
```

Pylon 先通过 source 找 `periId`，再调用 ACP：

```json
{
  "sessionId": "peri-session-id",
  "modeId": "plan"
}
```

Peri 实际处理：`peri-tui/src/acp_server/requests.rs` 的 `session/set_mode`，stdio typed handler 为 `acp_stdio/session/config.rs::handle_set_mode`。

成功后 Pylon 更新该 source 的内存 mode。

### 2.4 `set_config_option`

请求：

```ts
{ source: string, key: string, value: string }
```

Pylon ACP 映射：

```json
{
  "sessionId": "peri-session-id",
  "configId": "model",
  "value": {
    "valueId": { "value": "deepseek-chat" }
  }
}
```

当前 Pylon `acp.rs::set_config_option` 负责构造上述 ACP payload；Peri typed stdio handler `handle_set_config_option` 接收 `SessionConfigOptionValue::ValueId`。

支持的 Peri 实际 config ID 包括：

- `mode`
- `model`
- `thinking_effort`
- `context_1m`

Peri 对未知 ID 当前记录 debug 并继续生成配置响应；产品层不能据此声称未知选项已生效。

返回：Peri `SetSessionConfigOptionResponse`，Pylon 不裁剪，前端读取其中的 `configOptions`。

### 2.5 `close_session`

请求：

```ts
{ source: string }
```

行为：source 找到 periId，调用 ACP `session/close`，成功且 generation 仍匹配后删除本地映射。关闭失败时保留本地映射，便于重试。

### 2.6 `cancel_prompt`

请求：

```ts
{ source: string }
```

行为：source 找到 periId，发送 ACP `session/cancel` notification，不等待完整 prompt response。最终终止由 ACP prompt response 或 session/update/error 收敛。

Peri 实际通知处理：

```json
{ "sessionId": "peri-session-id" }
```

代码证据：`F:\A-I\Agent\Peri\peri-tui\src\acp_server\notify.rs` 的 `session/cancel` 分支；stdio prompt 实现见 `acp_stdio/session/prompt.rs`。

### 2.7 `load_sessions`

返回当前 Pylon 进程内的 session 快照数组：

```json
[
  {
    "source": "local:demo",
    "periId": "...",
    "persona": "...",
    "cwd": "...",
    "title": "...",
    "mode": "...",
    "configOptions": [],
    "model": "...",
    "tokensIn": 0,
    "tokensOut": 0,
    "tokensTotal": 0,
    "contextSize": 0
  }
]
```

它不是 Peri `session/list`。

### 2.8 `load_persisted_session`

请求：

```ts
{
  source: string,
  periId: string,
  cwd?: string,
  mcpServers?: McpServerConfig[]
}
```

调用 ACP `session/load`：

```json
{
  "sessionId": "peri-id",
  "cwd": "G:/work",
  "mcpServers": []
}
```

Peri 实际行为：先通过 `session/update` replay 历史，再返回 load response；Pylon 的 notification dispatcher 将 replay update 转为 `peri:user` / `peri:update`。

### 2.9 `list_persisted_sessions`

无请求体。Pylon 以当前 Agent cwd 调用 ACP `session/list`，返回 Peri 原始 JSON。当前前端没有稳定消费 UI，不能宣称历史选择器已完成。

### 2.10 `export_session`

请求：

```ts
{
  periId: string,
  format: string,
  outputPath: string
}
```

Pylon 重新调用 ACP `session/load` 收集指定 `periId` 的 replay update：

- `format === "markdown"`：输出 Markdown。
- 其他值：输出 JSON 序列化内容。
- 写入 `outputPath`。

必须使用 `periId`，不能传 `source`。

## 3. Agent commands

### 3.1 `list_agents`

返回 agents YAML 当前 registry：

```json
[
  { "id": "peri", "name": "Peri", "transport": "subprocess" }
]
```

### 3.2 `switch_agent`

请求：

```ts
{ name: string }
```

行为：

1. 校验 registry 存在目标 Agent。
2. 发 `peri:agent-status` connecting。
3. 连接并 initialize 新 ACP child。
4. 连接失败：保留旧 client，恢复为原有/合理 fallback 状态并返回错误。
5. 连接成功：替换 client、递增 generation、清空 Pylon 内存 session、重启 notification dispatcher、kill 旧 child。
6. 发 connected。

### 3.3 `reconnect_agent`

无请求体。对当前 active Agent 建立新 subprocess ACP client；成功后替换 client、递增 generation、清空 Pylon 内存 session；失败不应破坏旧 connected client。

### 3.4 `agent_status`

返回：

```json
{
  "agent": "Peri",
  "status": "connected|connecting|reconnecting|crashed|disconnected|error",
  "transport": "subprocess",
  "cwd": "G:/work",
  "lastError": null,
  "lastConnectedAt": "1720000000000",
  "generation": 1,
  "crashed": false
}
```

`lastConnectedAt` 实际为空或时间戳字符串；上例中的 `` 仅表示可选值，不是合法业务内容，实际 JSON 不应包含 NUL。

### 3.5 `reload_agents`

请求：

```ts
{ configPath?: string }
```

未传路径时使用 `PYLON_AGENTS_CONFIG` 或配置路径解析结果。当前 command 只替换 Agent registry，不自动重连 active ACP client。

## 4. Workspace commands

### 4.1 `get_workspace_root`

请求：`{ source: string }`

返回：

```json
{
  "source": "local:demo",
  "path": "G:/work",
  "exists": true,
  "readable": true
}
```

root 来自 Pylon `SessionInfo.cwd`，不接受前端任意 root。

### 4.2 `list_workspace_entries`

请求：

```ts
{
  source: string,
  relativePath?: string,
  includeHidden?: boolean
}
```

返回数组项：

```json
{
  "name": "src",
  "relativePath": "src",
  "kind": "directory|file|symlink|other",
  "size": 1234,
  "modifiedAt": 1720000000000,
  "hidden": false,
  "expandable": true
}
```

默认忽略构建/依赖目录和隐藏项；路径 traversal、绝对路径、越界 symlink 被拒绝或过滤。

### 4.3 `read_workspace_text`

请求：

```ts
{
  source: string,
  relativePath: string,
  maxBytes?: number
}
```

返回：

```json
{
  "relativePath": "src/main.ts",
  "content": "...",
  "bytesRead": 1024,
  "totalBytes": 2048,
  "truncated": true,
  "encoding": "utf-8"
}
```

NUL、非 UTF-8、非文件、越界路径返回错误。

## 5. RuntimeLogHub commands/events

### 5.1 `list_runtime_logs`

请求可选：

```ts
{
  query?: {
    level?: string,
    source?: string,
    session?: string,
    search?: string,
    limit?: number
  }
}
```

返回倒序 `RuntimeLogEntry`：

```json
{
  "id": 12,
  "timestamp": "1720000000000",
  "level": "debug|info|warn|error",
  "source": "acp|agent-stderr|prompt|session|frontend|...",
  "session": "local:demo",
  "message": "...",
  "fields": {}
}
```

容量默认 2000；查询 limit 不超过容量。

### 5.2 `clear_runtime_logs`

无请求体。清空 ring buffer，但不重置递增 ID。

### 5.3 `push_frontend_log`

请求：

```ts
{
  level: string,
  source?: string,
  session?: string,
  message: string,
  fields?: Record<string, unknown>
}
```

后端会执行 level 归一化、消息截断和敏感字段脱敏。

### 5.4 `pylon:runtime-log`

后台 dispatcher 对每条 RuntimeLogHub 新写入广播：

```json
{
  "id": 12,
  "timestamp": "...",
  "level": "info",
  "source": "acp",
  "message": "...",
  "fields": {}
}
```

当前前端 LogsPanel 主要通过 `list_runtime_logs` 读取；真实 event 联动仍需验收。

## 6. MCP command

### 6.1 `set_mcp_servers`

请求：`{ servers?: McpServerConfig[] }`

`McpServerConfig`：

```ts
{
  id?: string,
  name?: string,
  transport: 'stdio' | 'sse' | 'streamable-http' | 'http' | string,
  enabled: boolean,
  command?: string,
  args?: string[],
  env?: Record<string, string>,
  url?: string,
  headers?: Record<string, string>,
  oauth?: {
    enabled?: boolean,
    clientId?: string,
    clientSecret?: string,
    scopes?: string[]
  },
  disabled?: boolean
}
```

返回实际发送给 ACP 的已过滤 server JSON 数组。disabled 或 disabled=true 的服务不序列化；stdio 要求 command；HTTP 要求 http/https URL。

当前值只保存在 Pylon 进程内 `runtime_mcp`，没有磁盘持久化或 Settings UI。

## 7. Pet commands

### 7.1 `get_pet`

无请求体。执行 daily visit，消费一次性 `msg`，返回 `pet::view` 加可选 `msg`。

### 7.2 `pet_action`

请求：

```ts
{
  action: 'poke' | 'feed' | 'rename' | 'daily' | 'sleepy' | 'nostalgia' | 'restore',
  value?: string
}
```

`restore` 的 value 必须是 JSON 编码的 PetState；未知 action 返回错误。返回更新后的 PetView 和可选一次性 msg。

## 8. Pylon Tauri events

### 8.1 `peri:user`

```json
{ "source": "local:demo", "content": "用户文本", "replay": false }
```

live send 由 `send_message` 直接发出；replay user update 由 ACP notification dispatcher 在 `_meta.periReplay=true` 时发出。

### 8.2 `peri:update`

```json
{
  "sessionId": "peri-id",
  "source": "local:demo",
  "update": {
    "sessionUpdate": "agent_message_chunk|agent_thought_chunk|tool_call|tool_call_update|usage_update|available_commands_update|config_option_update|session_info_update",
    "content": { "text": "..." },
    "_meta": {}
  }
}
```

实际 dispatcher 将 ACP `session/update` params 加入 source；未知 session、旧 generation、缺 sessionId/update 的消息被丢弃。

### 8.3 `peri:done`

由 Pylon `send_message` 收到合法 prompt response 后发出：

```json
{ "source": "local:demo", "data": { "stopReason": "end_turn|cancelled|..." } }
```

历史 replay 的结束也由前端根据 load/replay 状态处理，不能简单等同 live done。

### 8.4 `peri:error`

```json
{
  "source": "local:demo",
  "error": "..."
}
```

可能来自 Agent crashed、ACP response error、非法 stopReason、generation 失效、连接关闭或 timeout。

### 8.5 `peri:agent-status`

```json
{
  "agent": "Peri",
  "status": "connecting|connected|reconnecting|crashed|disconnected|error",
  "transport": "subprocess",
  "cwd": "...",
  "lastError": "...",
  "lastConnectedAt": "1720000000000",
  "generation": 2,
  "crashed": false
}
```

### 8.6 `pylon:runtime-log`

格式见 RuntimeLogHub 章节。

## 9. ACP method 对照表

| Pylon command/行为 | ACP method | 实际 Peri 证据 |
|---|---|---|
| Agent connect | `initialize` | `peri-tui` ACP server initialize handler |
| `new_session` | `session/new` | `requests.rs` / `acp_stdio/session/create.rs` |
| `send_message` | `session/prompt` | `acp.rs::prepare_prompt`、Peri prompt handler |
| `set_mode` | `session/set_mode` | Peri typed/config handler |
| `set_config_option` | `session/set_config_option` | Peri typed/config handler |
| `load_persisted_session` | `session/load` | Peri replay before response |
| `list_persisted_sessions` | `session/list` | Peri ACP server/session control |
| `close_session` | `session/close` | Peri request handler |
| `cancel_prompt` | `session/cancel` notification | Peri notify handler |
| streaming | `session/update` notification | Peri notifier/event sink |

## 10. 已知 API 风险

- Pylon `set_config_option` 的 Rust 后端接收 string key/value，再由 ACP 客户端构造 typed `ValueId`；必须以实际抓包确认 JSON 形状。
- Peri 同时存在 stdio typed handler、TUI ACP server handler 等路径；不能把某一路径的内部 Rust 类型直接当成 Pylon wire response。
- `session/list`、`export_session` 当前有后端代码，但前端没有完整产品级消费/验收链路。
- `push_frontend_log` 已注册但当前前端源码未找到调用点，属于可用 command，不是已接入 UI 功能。
- API 文档中的“已核对”不等于“真实运行已验收”；真实验收必须有 JSON-RPC 抓包、Tauri event 日志或可复现运行记录。
