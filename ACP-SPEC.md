# Agent Client Protocol (ACP) 说明书

> Pylon 开发参考。基于 Peri + Hermes 源码验证。

---

## 一、传输层

stdin/stdout JSON-RPC 2.0。一行一个 JSON，换行符分隔。

```
Client → stdout → Agent stdin
Client ← stdin ← Agent stdout
```

Agent stderr → 日志用，协议层忽略。

---

## 二、initialize

客户端必须首先发送。

### 请求

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "protocolVersion": 1,
    "capabilities": {
      "tokenStats": true
    },
    "clientInfo": {
      "name": "pylon",
      "version": "0.1.0"
    }
  }
}
```

### 响应

```json
{
  "id": 1,
  "result": {
    "serverInfo": { "name": "peri", "version": "0.1.0" },
    "agentCapabilities": {
      "loadSession": true,
      "promptCapabilities": {},
      "sessionCapabilities": {
        "new": true,
        "list": true,
        "close": true,
        "resume": true,
        "fork": true
      }
    },
    "_meta": {}
  }
}
```

### 客户端能力（Peri 特有的 _meta 能力协商）

| 键 | 类型 | 说明 |
|:--|:--|:--|
| `tokenStats` | bool | Peri 在 usage_update._meta 里发 input/output/cacheReadTokens |
| `skillNames` | bool | Peri 在 available_commands_update._meta 里发 skillNames |
| `replay` | bool | Peri 在 session/load 重放消息时附加 _peri.replay 标记 |

声明 `false` 或省略 → Peri 不发对应 meta。

---

## 三、Session 生命周期

### 3.1 session/new

```json
{
  "method": "session/new",
  "params": {
    "cwd": "G:\\Project\\prism",
    "mcpServers": []
  }
}
```

响应：

```json
{
  "result": {
    "sessionId": "smrzv7udx",
    "modes": { "modes": ["default", "edit", "auto", "bypass"] },
    "configOptions": [
      { "key": "model", "value": "deepseek-v4-flash", ... },
      { "key": "mode", "values": ["default","edit","auto","bypass"], ... }
    ]
  }
}
```

注意：Peri 的 response 无 `sessionInfo` 字段（cwd/title/createdAt 缺失）。

### 3.2 session/prompt

```json
{
  "method": "session/prompt",
  "params": {
    "sessionId": "smrzv7udx",
    "prompt": [
      { "type": "text", "text": "Hello" }
    ]
  }
}
```

响应（回复完成后）：

```json
{
  "result": {
    "stopReason": "end_turn"
  }
}
```

### 3.3 session/load

```json
{
  "method": "session/load",
  "params": {
    "sessionId": "smrzv7udx",
    "cwd": "G:\\Project\\prism"
  }
}
```

Agent 先通过 `session/update` 通知重放历史消息，后发送响应。

### 3.4 session/list

```json
{
  "method": "session/list",
  "params": { "cwd": "G:\\Project\\prism" }
}
```

响应：

```json
{
  "result": {
    "sessions": [
      { "sessionId": "smrzv7udx", "cwd": "...", "title": "...", "updatedAt": "..." }
    ]
  }
}
```

### 3.5 session/set_mode

```json
{
  "method": "session/set_mode",
  "params": {
    "sessionId": "smrzv7udx",
    "mode": "auto"
  }
}
```

---

## 四、通知：session/update

Agent 在 prompt 处理过程中发送通知。

### 4.1 格式

```json
{
  "method": "session/update",
  "params": {
    "sessionId": "smrzv7udx",
    "update": {
      "sessionUpdate": "<variant>",
      // ... 变体字段
    }
  }
}
```

### 4.2 变体一览

| 变体 | 关键字段 | 说明 |
|:--|:--|:--|
| `agent_message_chunk` | `content.text` | AI 回复文本流 |
| `agent_thought_chunk` | `content.text` | AI 思考过程 |
| `user_message_chunk` | `content.text` | 用户消息回显（load 重放时） |
| `tool_call` | `title`, `toolCallId`, `rawInput` | 工具调用开始 |
| `tool_call_update` | `toolCallId`, `rawOutput`, `status` | 工具调用结果 |
| `usage_update` | `value`, `size`, `_meta` | Token 使用统计 |
| `available_commands_update` | `commands: [{name, description, input_hint}]` | 可用命令列表 |
| `session_info_update` | `cwd`, `title`, `updatedAt` | 会话元数据（Peri 缺 cwd/title） |
| `config_option_update` | `key`, `value` | 配置变更通知 |
| `plan` | `title`, `steps` | 计划模式输出 |

### 4.3 usageUpdate 详解

```json
{
  "sessionUpdate": "usage_update",
  "value": 12345,
  "size": 131072,
  "_meta": {
    "inputTokens": 12000,
    "outputTokens": 345,
    "cacheReadTokens": 8000,
    "model": "deepseek-v4-flash",
    "stopReason": "end_turn"
  }
}
```

`_meta` 仅当 `capabilities.tokenStats: true` 时存在。
`value` = inputTokens + outputTokens（累计）。
`size` = 模型上下文窗口上限。

### 4.4 availableCommandsUpdate 详解

```json
{
  "sessionUpdate": "availableCommandsUpdate",
  "commands": [
    { "name": "compact", "description": "压缩上下文" },
    { "name": "model", "description": "切换模型", "input_hint": "model name" }
  ]
}
```

在 session/new 和 session/load 后自动发送。

---

## 五、内容块（ContentBlock）

```json
// 文本
{ "type": "text", "text": "hello" }

// 图片
{ "type": "image", "mimeType": "image/png", "data": "<base64>", "uri": null }

// 资源
{ "type": "resource", "resource": { "uri": "file:///path/to/readme.md", "mimeType": "text/markdown" } }
```

皆以数组传递：`"prompt": [{ "type": "text", "text": "hello" }]`。

---

## 六、工具调用格式

### toolCall

```json
{
  "sessionUpdate": "toolCall",
  "title": "Bash",
  "toolCallId": "tc_001",
  "rawInput": { "command": "ls -la" }
}
```

### toolCallUpdate

```json
{
  "sessionUpdate": "toolCallUpdate",
  "toolCallId": "tc_001",
  "status": "completed",
  "rawOutput": "total 42\ndrwxr-xr-x ..."
}
```

---

## 七、Pylon 兼容摘要

| 功能 | Peri | Hermes | 备注 |
|:--|:--|:--|:--|
| initialize | ✅ | ✅ | tokenStats: true 获取 usage meta |
| session/new | ✅ | ✅ | mcpServers: [] 兼容双方 |
| session/prompt | ✅ | ✅ | 标准 prompt 格式 |
| session/load | ✅ | ❓ | 历史重放 |
| session/list | ✅ | ❓ | 列出持久化会话 |
| session/set_mode | ✅ | ❓ | 权限模式 |
| usageUpdate._meta | ✅ | ❓ | tokenStats cap |
| availableCommandsUpdate | ✅ | ✅ | 动态命令 |
| agentMessageChunk | ✅ | ✅ | 标准流式输出 |
| agentThoughtChunk | ✅ | ✅ | 思考过程 |
| toolCall / toolCallUpdate | ✅ | ✅ | 工具调用 |
| sessionInfoUpdate | ⚠️ 缺 cwd/title | ❓ | Peri 侧 bug |
