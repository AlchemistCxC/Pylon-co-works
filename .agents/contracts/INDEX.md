# Contract Index

契约状态：`proposed`、`frozen`、`merged`、`verified`。

Frontend 只有在 `frozen` 及以上时才能接生产 invoke/event；`proposed` 只允许类型草案、normalizer 测试和 unavailable shell。

当前契约：

- `agent-status.md`：Agent list/status/event 身份字段。
- `session.md`：Session/source/periId 和事件作用域。
- `workspace.md`：Workspace command 基础形状。
- `prism.md`：Prism command 状态，未完成 route audit 前不视为 frozen CRUD DTO。
