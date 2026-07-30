# workspace.v1

状态：merged（基础 command）；分页/version 为 proposed。

基础 command：

- `get_workspace_root { source }`
- `list_workspace_entries { source, relativePath? }`
- `read_workspace_text { source, relativePath }`

约束：root 由 `source → SessionInfo.cwd` 解析；前端不传绝对 root。当前前端 adapter/preview 单一真值仍需 FE-F1-002 收敛。分页、mtime/version 需后续 Backend producer task 冻结。
