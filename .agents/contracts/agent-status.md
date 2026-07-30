# agent-status.v2

状态：frozen（BE-B0-001；后端字段契约已冻结，真实 Tauri list/status/event 仍属于 checkpoint 验收）
Owner：Backend
Consumers：Frontend Agent Sheet / Settings / Workspace Sheet status indicator

## 身份规则

- `agentId`：Agent registry key，唯一稳定身份；切换参数、状态表 key 和 Agent Sheet `agentId` 都使用它。
- `agentName`：registry entry 的展示名称，只用于 UI 文案，不得作为 key。
- 兼容字段 `agent`：保留旧消费者兼容，值是 display name；deprecated，不得重新用于身份解析。
- `list_agents[].id` 与 `agent_status.agentId` 必须指向同一个 registry key。
- payload 不包含 registry 的 `args` 或 `env`。

## `list_agents` 返回

```json
{
  "id": "peri",
  "name": "Peri",
  "transport": "subprocess",
  "available": true,
  "active": true,
  "cwd": "G:\\Project\\prism-desktop"
}
```

`available` 仅表示该 registry Agent 是当前 active runtime 且生命周期状态为 `connected`；`active` 表示该 Agent 是当前 active runtime。当前后端只有单 active runtime，不代表多 Agent 并行。

## `agent_status` command 与 `peri:agent-status` event

两者共享以下字段和语义：

```json
{
  "agentId": "peri",
  "agentName": "Peri",
  "agent": "Peri",
  "status": "connected",
  "transport": "subprocess",
  "cwd": "G:\\Project\\prism-desktop",
  "lastError": null,
  "recentError": null,
  "error": null,
  "lastConnectedAt": "2026-07-31T00:00:00+08:00",
  "generation": 1,
  "active": true,
  "available": true,
  "crashed": false
}
```

字段说明：

- `status`：稳定枚举 `connecting`、`connected`、`reconnecting`、`crashed`、`disconnected`、`error`。
- `generation`：当前 ACP client generation；用于识别旧事件/旧响应，不能当作 Agent ID。
- `active`：当前 `agentId` 已在 registry 中且是 active runtime。
- `available`：当前 `agentId` 存在且 runtime status 为 `connected`。
- `lastError`：最近一次 runtime 错误；无错误为 `null`。
- `recentError`：新消费者优先读取的错误别名，与 `lastError` 同值。
- `error`：旧消费者兼容别名，与 `lastError` 同值；deprecated。
- `crashed`：仅表示 ACP child 已崩溃/连接 stdout 已关闭；不得据此推导 Agent registry 配置错误。

## 兼容策略

新代码应按以下顺序读取：

1. 身份：`agentId`；旧 payload 缺失时才使用调用上下文中的 fallback，不使用 `agentName` 作为 key。
2. 展示：`agentName`；旧 payload 才回退到 `agent`。
3. 错误：`recentError`，再回退 `lastError`/`error`。

`agent`、`error` 是 deprecated 兼容字段；后端暂不删除，避免旧前端在契约冻结期间失效。Frontend adapter 迁移不属于 BE-B0-001。
