# agent-status.v2

状态：proposed（当前后端工作区已有部分字段，尚待 BE-B0-001 冻结）
Owner：Backend
Consumers：Frontend F4/F0 Agent Sheet transaction

目标字段：

```json
{
  "agentId": "peri",
  "agentName": "Peri",
  "status": "connected",
  "generation": 1,
  "active": true,
  "available": true,
  "transport": "subprocess",
  "cwd": "G:\\Project\\prism-desktop",
  "recentError": null
}
```

兼容字段 `agent` 当前可能表达 display name，不得作为 registry key。最终以 BE-B0-001 当前源码审计结果更新。
