# Pylon Backend API Reference

> 18 Tauri commands + 8 frontend events + 2 JSON-RPC method groups

---

## 一、Tauri Commands（invoke）

### 1.1 会话核心

#### `new_session`

创建新的 ACP 会话。

| 参数 | 类型 | 必填 | 说明 |
|:--|:--|:--|:--|
| `source` | `String` | ✅ | 前端 tab/session 唯一标识 |
| `persona` | `String` | ✅ | 系统提示词/人设 |
| `cwd` | `Option<String>` | ❌ | 工作目录，不传则用 agent 默认 cwd |

**返回**：Peri `session/new` 的完整 JSON 响应
```json
{
  "sessionId": "smrzv7udx",
  "modes": {
    "modes": ["default", "accept_edit", "auto", "bypass"]
  },
  "configOptions": [
    {"configId": "model", "valueId": {"value": "opus"}, ...},
    {"configId": "mode", "valueId": {"value": "default"}, ...},
    {"configId": "thinking_effort", "valueId": {"value": "medium"}, ...}
  ]
}
```

---

#### `send_message`

发送消息到当前会话，流式返回。

| 参数 | 类型 | 必填 | 说明 |
|:--|:--|:--|:--|
| `source` | `String` | ✅ | 会话标识 |
| `content` | `String` | ✅ | 用户消息文本 |
| `persona` | `String` | ✅ | 人设（仅首次发送时注入 system prompt） |
| `sessionPrompt` | `Option<String>` | ❌ | 覆盖本次的人设 |
| `attachments` | `Option<Vec<String>>` | ❌ | 附件文件路径列表 |

**返回**：`peri_id: String` — session ID

**副作用**：
- `emit("peri:user", {source, content})` — 回显用户消息
- `emit("peri:update", {...})` — 流式推送（每 chunk/N条）
- `emit("peri:done", {source, data: {stopReason}})` — 完成
- `emit("peri:error", {source, error})` — 超时/崩溃/连接断开
- 自动更新 `PetState` 情绪（curious→excited/error）
- 自动更新 `SessionInfo` 元数据（title/model/tokens）

---

#### `set_mode`

切换会话权限模式。

| 参数 | 类型 | 说明 |
|:--|:--|:--|
| `source` | `String` | 会话标识 |
| `mode` | `String` | `default` / `accept_edit` / `auto` / `bypass` |

**返回**：`()` — 无返回值。Peri 随后推送 `configOptionUpdate` 通知。

---

#### `close_session`

关闭会话，通知 Peri 释放资源。

| 参数 | 类型 | 说明 |
|:--|:--|:--|
| `source` | `String` | 会话标识 |

**返回**：`()`

---

#### `cancel_prompt`

取消正在运行的 prompt。

| 参数 | 类型 | 说明 |
|:--|:--|:--|
| `source` | `String` | 会话标识 |

**返回**：`()`

---

#### `set_config_option`

切换会话配置（模型/思考深度/上下文）。

| 参数 | 类型 | 说明 |
|:--|:--|:--|
| `source` | `String` | 会话标识 |
| `key` | `String` | `model` / `mode` / `thinking_effort` / `context_1m` |
| `value` | `String` | 对应值 |

**返回**：Peri `set_config_option` 的完整 JSON 响应（含 `configOptions` 列表）

---

### 1.2 会话列表与持久化

#### `load_sessions`

获取当前活跃会话列表（内存中）。

**无参数**

**返回**：
```json
[{
  "source": "tab-1",
  "periId": "smrzv7udx",
  "persona": "You are a helpful assistant",
  "cwd": "G:\\Project\\prism",
  "title": "重构 ACP 协议",
  "model": "opus",
  "tokensIn": 12000,
  "tokensOut": 345,
  "tokensTotal": 12345,
  "contextSize": 131072
}]
```

---

#### `load_persisted_session`

从 ThreadStore 加载历史会话。

| 参数 | 类型 | 说明 |
|:--|:--|:--|
| `source` | `String` | 前端会话标识 |
| `periId` | `String` | Peri session ID |

**返回**：`()`
**副作用**：`emit("peri:update", ...)` — 重放历史消息

---

#### `list_persisted_sessions`

列出 Peri ThreadStore 中持久化的会话。

**无参数**

**返回**：
```json
{
  "sessions": [
    {
      "sessionId": "smrzv7udx",
      "cwd": "G:\\Project\\prism",
      "title": "重构 ACP 协议",
      "updatedAt": "2026-07-26T02:15:00Z"
    }
  ]
}
```

---

#### `export_session`

导出会话历史为 Markdown 或 JSON。

| 参数 | 类型 | 说明 |
|:--|:--|:--|
| `periId` | `String` | Peri session ID |
| `format` | `String` | `markdown` 或 `json` |
| `outputPath` | `String` | 输出文件绝对路径 |

**返回**：`()`

---

### 1.3 Agent 管理

#### `list_agents`

列出 `agents.yaml` 中注册的所有 agent。

**无参数**

**返回**：
```json
[{"id": "peri", "name": "Peri", "transport": "subprocess"}]
```

---

#### `switch_agent`

切换到指定 agent（kill 旧子进程 + 连接新子进程）。

| 参数 | 类型 | 说明 |
|:--|:--|:--|
| `name` | `String` | agent ID（对应 agents.yaml 的 key） |

**返回**：`()`
**副作用**：清空全部活跃会话

---

#### `reconnect_agent`

重新连接当前 agent（崩溃后恢复）。

**无参数**

**返回**：`()`
**副作用**：`emit("peri:agent-status", {status: "connected"})`

---

#### `agent_status`

查询 agent 连接状态。

**无参数**

**返回**：
```json
{"agent": "peri", "crashed": false}
```

---

#### `reload_agents`

重新加载 `agents.yaml`（热加载，无需重启）。

**无参数**

**返回**：`()`

---

### 1.4 宠物系统

#### `get_pet`

获取宠物当前状态。

**无参数**

**返回**：
```json
{
  "mood": "curious",
  "happiness": 65,
  "messages": 523,
  "totalTokens": 142000,
  "toolsSucceeded": 87,
  "name": "豆豆",
  "memories": ["重构 ACP 协议", "修复 sessionId 过滤"],
  "msg": "在想了在想了"   // 当前气泡文本，取后即清空
}
```

`msg` 仅在宠物有新发言时存在。取后前端显示气泡 3-5 秒。

---

#### `pet_action`

触发宠物互动。

| 参数 | 类型 | 说明 |
|:--|:--|:--|
| `action` | `String` | 见下表 |
| `value` | `Option<String>` | 仅 `rename` 需要 |

**action 类型**：

| action | 效果 | value |
|:--|:--|:--|
| `poke` | 点击/逗宠物 → mood=happy, happiness+5 | — |
| `feed` | 喂食 → mood=happy, happiness+15 | — |
| `rename` | 改名 | 新名字 |
| `daily` | 每日衰减 happiness-5 | — |
| `sleepy` | 检查是否发呆超 30s | — |
| `nostalgia` | 随机回溯一条记忆 → msg=前缀+记忆内容 | — |

**返回**：同 `get_pet` 的完整 JSON（含可能新产生的 `msg`）

---

### 1.5 事件 emit（后端推送）

| 事件名 | 触发时机 | payload |
|:--|:--|:--|
| `peri:user` | 用户消息已发送 / load 重放的 userMessageChunk | `{source, content}` |
| `peri:update` | ACP 通知（agentMessageChunk, toolCall, usageUpdate, plan, sessionInfoUpdate, configOptionUpdate, availableCommandsUpdate 等） | `{sessionId, update: {sessionUpdate: "...", ...}, source}` |
| `peri:done` | prompt 完成 | `{source, data: {stopReason}}` |
| `peri:error` | prompt 超时(300s) / ACP 连接断开 / agent 崩溃 | `{source, error}` |
| `peri:agent-status` | agent 重连成功 | `{status: "connected"}` |

`peri:update` 的 `update.sessionUpdate` 变体列表：

| 变体 | 关键字段 |
|:--|:--|
| `agentMessageChunk` | `content.text` |
| `agentThoughtChunk` | `content.text` |
| `userMessageChunk` | `content.text`（load 重放） |
| `toolCall` | `toolCallId`, `title`, `rawInput` |
| `toolCallUpdate` | `toolCallId`, `rawOutput`, `status` |
| `usageUpdate` | `value`, `size`, `_meta.{inputTokens,outputTokens,model}` |
| `plan` | `entries: [{content, priority, status}]` |
| `sessionInfoUpdate` | `title`, `updatedAt` |
| `configOptionUpdate` | `configOptions` |
| `availableCommandsUpdate` | `commands: [{name, description}]` |

---

## 二、ACP JSON-RPC 方法

所有 ACP 调用由 Rust 后端代理，前端不直接调用。仅供理解数据流。

| 方法 | 方向 | 说明 |
|:--|:--|:--|
| `initialize` | → | 能力协商（tokenStats, skillNames, replay） |
| `session/new` | → | 创建会话 |
| `session/prompt` | → | 发送消息 |
| `session/load` | → | 加载历史会话 |
| `session/list` | → | 列出持久化会话 |
| `session/set_mode` | → | 切换权限模式 |
| `session/set_config_option` | → | 切换模型/配置 |
| `session/close` | → | 关闭会话 |
| `session/cancel` | → | 取消正在运行的 prompt（notification，无 id） |
| `session/update` | ← | 通知（所有流式事件） |

---

## 三、agents.yaml 格式

```yaml
agents:
  peri:
    name: Peri
    transport: subprocess
    exe: F:\A-I\Agent\Peri\target\release\peri.exe
    args: ["acp", "--model", "deepseek-v4-flash"]
    cwd: G:\Project\prism
    default: true         # 标记为默认 agent
  hermes:
    name: Hermes
    transport: subprocess
    exe: hermes
    args: ["acp"]
    cwd: .
```

---

## 四、宠物 `get_pet` / `pet_action` 返回的完整字段定义

```typescript
interface PetState {
  mood: "idle" | "curious" | "excited" | "sleepy" | "error" | "happy";
  happiness: number;        // 0-100
  messages: number;          // 总发送消息数
  totalTokens: number;       // 累计 token 用量
  toolsSucceeded: number;    // 完成工具调用次数
  name: string;              // 基础名（默认"豆豆"）
  memories: string[];        // 最多 10 条记忆片段
  msg?: string;              // 当前气泡文本（可选，取后清空）
}

// 成长阶段（前端可本地计算）
type GrowthStage = 0 | 1 | 2 | 3;
// 0: 小{name}  1: {name}酱  2: {name}师傅  3: 老{name}

// Token 阈值: <50K → 0, 50K-500K → 1, 500K-5M → 2, >5M → 3
// Tool 阈值:  <20 → 0,  20-100  → 1, 100-300 → 2, >300 → 3
// 最终阶段 = max(token_tier, tool_tier)
```

---

## 五、常量

| 常量 | 值 | 说明 |
|:--|:--|:--|
| `PROMPT_TIMEOUT_SECS` | 300 | prompt 超时 |
| `MAX_SESSIONS` | 100 | 活跃会话上限 |
| `BROADCAST_CAP` | 256 | ACP 广播通道容量 |
| `WRITE_CHAN_CAP` | 256 | stdin 写通道容量 |
