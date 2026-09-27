# Dev Record — #398 删除会话接入 ACP `session/delete`

## 元信息

- issue：#398（enhancement）
- 分支：kumo/prometheus
- 提交范围：`52d52c87^..`（L.md 声明 + 本批代码/文档/记录）
- 日期：2026-09-27

## 目标与范围

**做什么**：删除会话时，若 agent 广告 `sessionCapabilities.delete`（协商 usable），在本地删除与 best-effort close 之后向 agent 发官方 `session/delete`，同步清掉 agent 侧持久会话记录；能力协商矩阵按 #98 登记制接入；前端能力快照投影 `sessionDelete`。

**不做什么**：本地删除语义（DEL-03 tombstone 顺序）零变化；`user_session_delete` 保持纯本地命令（不加 RPC）；agent 侧删除永远是 best-effort——未广告/未连接/-32601/stale generation 降级 skipped，不报错不阻断；删除按钮 UI 不按能力禁用（本地删除无条件可用）。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src-tauri/pylon-acp/src/negotiated.rs` | `CapabilityConsumer::SessionDelete` 变体；矩阵 `delete` 条目（BooleanOrObject）；delete 单测 | 修改 |
| `src-tauri/pylon-acp/src/error.rs` | `METHOD_SESSION_DELETE`（官方 `AGENT_METHOD_NAMES.session_delete`，schema 1.9.1） | 修改 |
| `src-tauri/pylon-acp/src/protocol.rs` | `session_delete_params`（官方 `DeleteSessionRequest` typed 构造）+ wire 单测 | 修改 |
| `src-tauri/pylon-acp/src/lib.rs` | `session_delete_params` 进 protocol 再导出清单 | 修改 |
| `src-tauri/src/lib.rs` | 消费者注册数组 + invoke_handler 各一行 | 修改 |
| `src-tauri/src/session/control.rs` | `delete_agent_session` 主体 + `agent_session_delete` Tauri 薄壳 + 5 个命令层测试（wire trace 落证） | 修改 |
| `src-tauri/pylon-fake-agent/src/main.rs` | `delete-session` 场景（宣告 delete + `--outcome error/not-found` 注入）；usage 同步 | 修改 |
| `src/infrastructure/acp/sessionClient.ts` | `DeleteSessionAgentSidePayload/Result` + `deleteSessionAgentSide` | 修改 |
| `src/application/transactions/removeSessionTransaction.ts` | 可选 `deleteSessionRemote` 步骤（close 之后、finalize 之前）+ 头注顺序更新 | 修改 |
| `src/application/transactions/__tests__/removeSessionTransaction.test.ts` | 3 个 #398 用例（顺序/失败不阻断/未注入一致） | 修改 |
| `src/infrastructure/acp/agentContracts.ts` | `AgentCapabilitySnapshot.sessionDelete`（权威 + raw 兜底双形状） | 修改 |
| `src/infrastructure/acp/__tests__/agentContracts.test.ts` | 7 处完整快照断言补 `sessionDelete` 键 + 2 个 #398 用例 | 修改 |
| `src/components/sidebar/useSidebarContributionProps.ts`、`src/components/SessionSettings.tsx` | 两个删除入口接线 `deleteSessionRemote`（periId 缺失跳过） | 修改 |
| `docs/说明书/Pylon-模块维护地图.md`、`docs/说明书/Pylon-项目架构参考.md` | 双形状清单纳入 delete；tombstone 段补删除链路 | 修改 |

## 方案要点

- **gate 选型**：`session/close` 用声明式配置（`close_via_rpc()`，历史包袱）而 `session/fork` 用协商矩阵 usable gate——#398 取 fork 模式（新能力无历史包袱，矩阵是 #98 定下的方向）：`capture_negotiated_snapshot` → `usable("delete")` 才发送；disconnected 客户端无广告天然跳过，不发注定失败的 RPC。close 的声明式 gate 原样不动。
- **路由与目标**：`resolve_agent_runtime`（agentId，不查 session 映射）+ **显式 periId** 参数——删除链路里 close 先行移除了 runtime 映射，owner 式路由会误报 SessionNotFound；periId 由前端 Session 携带（OWNER-02 精神：session 携带身份，绝不取 activeAgent）。
- **结果分级**：`{"outcome":"deleted"}` / `{"outcome":"skipped","reason"}` / Err 三档。skipped 是常态（多数 agent 未实现 delete）；Err 仅在「能力协商通过但 agent 删除失败」时上抛（agent 支持却失败是异常，前端 reportError 可见）。-32601（广告面与实现面不一致的老 agent）与 stale generation 与 close 同款降级。
- **官方契约**：schema 1.9.1 实证 `SessionCapabilities.delete: Option<SessionDeleteCapabilities>`（object 形状）+ `DeleteSessionRequest{session_id}` / `DeleteSessionResponse{_meta}`；方法名常量 `AGENT_METHOD_NAMES.session_delete` 已存在，直接消费。双形状收法与 list/close（#110 F2）一致，防线上显式 `true` 旧广告。
- **前端事务**：`deleteSessionRemote` 为**可选**依赖——未注入（测试/旧调用方）时行为与现状逐字一致；两个 UI 入口注入时 periId 缺失（从未连接 agent 的本地会话）直接 resolve 跳过。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| negotiated：delete 双形状 usable、非法值 fail-closed + 诊断实际接受集、消费者未注册恒不可 usable | ✅ `delete_accepts_object_and_boolean_shapes_and_requires_consumer` |
| protocol：`session_delete_params` wire = `{"sessionId":...}` | ✅ `session_delete_params_use_official_wire_shape` |
| 命令层：能力在 → wire 出现 `session/delete` + 目标 periId，outcome=deleted | ✅ `delete_sends_rpc_when_capability_usable`（fake-agent trace 落证） |
| gate：无广告 → 稳定 skipped 不发 RPC | ✅ `delete_skips_stably_without_negotiated_capability` |
| -32601 → skipped/method_not_found | ✅ `delete_downgrades_method_not_found_to_skipped` |
| agent 侧失败 → Err 上抛 | ✅ `delete_failure_propagates_after_capability_gate` |
| 事务：delete 在 close 后 finalize 前；失败仅报告；未注入一致 | ✅ 3 个 `#398` 用例，现有 calls 全序列断言零改动 |
| 契约投影：双形状/raw 兜底/结构化权威路径 | ✅ 2 个 `#398` 用例 + 7 处完整快照补键 |
| 门禁：workspace 测试 / clippy / 前端全测 / tsc | ✅ 见证据 |

## 测试处置

- 修改：`agentContracts.test.ts` 7 处完整 `toEqual` 快照断言补 `sessionDelete: false` 键（契约变更：快照接口新增字段，样本输入均无 delete 广告故值为 false）；`negotiated.rs` 新测试初稿的「消费者未注册 → Advertised」断言修正为 `Negotiated`（delete 无声明维度，fact 链与 fork AC7 同态）。既有用例语义零变化。
- 新增：上述验收表全部用例。

## 证据

- commit：见 PR（代码 / 说明书 / 记录分 pathspec 提交）
- 测试：`cargo test --workspace --lib` exit 0（922+187+9+36+133+87+22+0+181 = 1577 passed / 0 failed）；`bun run test` exit 0（660 文件 5088 passed / 1 skipped）；`bun run check:clippy` 6 crate `added: []`；`bun run check:frontend` exit 0；`rustfmt --check` 改动文件干净（已 format）
- 手工验证：fake-agent 冒烟 `--scenario delete-session` initialize 回 `{"sessionCapabilities":{"delete":{},"loadSession":{}}}` ✓
- 排障记录：pylon-fake-agent 的 bin 有 `required-features = ["test-agent"]` 门控——`cargo build -p pylon-fake-agent`（无 features）是**静默空操作**（0.14s Finished、产物不动），测试因此拿到旧 bin 报 unknown scenario exit 2；须 `cargo build -p pylon-fake-agent --features pylon-fake-agent/test-agent`

## 与 spec 的偏差

- spec 写 gate reason `delete_capability_unavailable` 单值；实现区分了 `delete_capability_consumer_unregistered`（已广告未注册）便于诊断——与 fork 的 reason 推导同构。
- 其余按 spec 落地。

## 未解问题

- 无。后续可参考：`session/list`（矩阵已登记 SessionList 消费者）尚未在删除侧联动——agent 侧会话清单导入属 #364 域。

## 并行交集

- `src-tauri/src/lib.rs`（仅消费者数组 + invoke_handler 两行，与在途 #361 声明的 init_tracing/run() 区域不相邻）
- `docs/说明书/Pylon-模块维护地图.md`、`Pylon-项目架构参考.md`（追加点状条目，未动他人段落）
