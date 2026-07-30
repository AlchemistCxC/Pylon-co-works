# prism.v1

状态：proposed。

当前后端已有固定 loopback `PrismClient` 和大量 Tauri command，但 route/DTO 尚未完成全量审计。HTTP 真值为 `G:\Project\prism` 当前 route/handler。

已确认 Prism 的若干删除操作是 POST delete route + query，而不是统一 HTTP DELETE。FE-F2 在 BE-B3-001 冻结 read contract 前不得接生产 CRUD。
