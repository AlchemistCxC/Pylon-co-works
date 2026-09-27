# ADR-0030 会话标题做成通用 ACP 能力（内核定型 + 存储/显示分口径）

> 入库保留。编号顺延，按编号命名。
> 产出路径：`.agents/decisions/NNNN-<slug>.md`

- **日期**：2026-09-27
- **状态**：已采用

## 背景与约束

ACP 官方**已经**提供会话标题能力，且两个在用的 Agent 都已经在发，Pylon 全链路丢弃：

- `SessionInfoUpdate.title/updatedAt`（`agent-client-protocol-schema 1.9.1` `src/v1/client.rs:546`）：`MaybeUndefined<String>` 三态——字段缺席 = 不修改、`null` = 清空、字符串 = 设置。文档原话：「Agents send this notification to update session information like title or custom metadata.」
- `session/list` 的 `SessionInfo.title`（`agent.rs:1761`），响应是包装对象 `{sessions:[…]}` + `nextCursor`（`agent.rs:1610`）。
- Peri v3.18.0（通知 + 列表实测）、Hermes（`acp_adapter/server.py:393` 的 turn prologue 自动起标题 + `server.py:677` 的列表）都发。
- `session/new` / `session/load` 响应**不含** title ⇒ 标题必然异步到达。

Pylon 侧的丢弃点：内核 canonical 定型无标题事实（`pylon-canonical-types/src/lib.rs:157`）、`event_repo::normalize.rs` 只提 `model`、前端 `acpNormalizer.ts:57-83` 只拆 mode/status/model、`runtimeStoreSessionState.ts:65-88` 同样。本地 `Session.autoName` 字段早已存在且持久化往返，但**全仓零读写**。

约束：`Session` 是 identity 域的持久化契约（`sessionPersistence.ts`，`PersistedSession = Session` 单源）；`Session.name` 有 19 处非测试读取点（12 个文件）；跨语言契约以 Rust 为单源。

## 备选方案

| 方案 | 否决理由 |
| --- | --- |
| 纯前端解析（live 读 wire、重放读 `rawPayload`，零内核改动） | 内核 canonical 层继续「有 title 无事实」，双栈口径漂移面扩大（#315 的全部教训就是收敛这类漂移）；title 是标准字段，内核已为同一包的 model/mode 定型 |
| 把「用户改过名」做成**必需**字段 | 15+ 个测试文件的 `Session` 字面量要跟着改，纯增噪音无收益 |
| 不加字段：用空 `name` 表示「未改名」 | `session.name` 的 19 处读取点（侧栏/搜索/无障碍 label/导出/sheet 标题）都要重新定义空名语义，风险面最大 |
| 用户改名写回 Agent | ACP 无 client→agent 改标题的方法（`session_info_update` 是 Agent→Client 单向通知），物理上做不到 |

## 决定

1. **内核定型**：`session_info_update` 包内 `title`/`updatedAt` 落 `typed_payload`，三态保真（键存在才落；清空落 `null`）。canonical 事件类型**不改名**（仍 `session.model-updated`）——词表级收敛是独立议题，不在本次扩面。
2. **语义层**：新增 workbench 语义事件 `session.title-updated`（`title: string | null`），「缺席 = 不修改」由**事件不存在**表达；登记进 `wireSemanticCorrespondence` 单源表；投影到 `WorkbenchSessionSurface.title`，清空时删键。
3. **存储/显示分口径**：`autoName` = Agent 给的标题（每帧覆盖写，Agent 清空回落 `''`）；用户改名置新增的可选标记 `renamedByUser`，**不动存储**；显示由 `resolveSessionDisplayName` 收口为「用户改名 > Agent 标题 > 本地生成名」。
4. **接受不对称**：本地改名不回写 Agent，Agent 亦不会知道被改名。
5. **存档通路**：`session/list` 的 `title` 落 `autoName`；`persistedSessions` 的 normalize 兼容两代形状（官方包装 + `sessionId` / 旧裸数组 + `id`）。

## 后果

- 正面：标题成为标准 ACP 能力（Peri/Hermes 零适配）；清空语义完整（可撤回）；用户改名不会被 Agent 覆盖；存档列表恢复（#396 连带修复）。
- 负面：`Session` 加一个可选持久化字段；`autoName` 从死字段变成活字段，两处旧注释（`workbenchSessionBindingKey` 附近「metadata 更新会重建绑定」）需按现行为理解——绑定键不含 name/autoName，回写不会触发整页重折。
- 风险：标题到达时机异步（首个回合后），界面必须容忍「先无名、后到达」；Hermes 的 `nextCursor` 分页未消费（Peri 一次给全量），存档列表在 Hermes 下只显示第一页。

## 证据

代码与测试：

- 内核三态提取：`src-tauri/pylon-session/src/event_repo/normalize.rs`（`session_info_update` 分支）；测试 `event_repo::tests::kernel_ingest_session_info_update_carries_title_tri_state`、`..._carries_updated_at`。
- 语义事件与单源表：`src/domains/workbench/events/workbenchEventSchema.ts`（`SessionEvent.title`）、`src/domains/events/wireSemanticCorrespondence.ts`（`WORKBENCH_TYPE_FOR_WIRE.session_info_update`）、`src/domains/workbench/normalizers/acpNormalizer.ts`（`sessionTitleOf`）。
- 投影：`src/domains/workbench/workbenchProjector.ts`（`WorkbenchSessionSurface.title` + `reduceSession` 删键分支）；测试 `src/domains/workbench/__tests__/sessionSurfaceProjection.test.ts`。
- 身份域：`src/domains/identity/identityStore.ts`（`autoName` / `renamedByUser` / `resolveSessionDisplayName`）、`src/domains/identity/sessionPersistence.ts`；测试 `src/domains/identity/__tests__/sessionDisplayName.test.ts`。
- 回写与显示：`src/sheets/agent-workbench/agentWorkbenchSession.ts`（`unsubscribeSessionTitle`）、`src/components/sidebar/SessionsPanel.tsx`、`src/components/sidebar/useSidebarContributionProps.ts`。
- 存档形状：`src/domains/overview/persistedSessions.ts`、`src/application/transactions/resumePersistedSessionTransaction.ts`；测试 `src/infrastructure/acp/__tests__/typedClients.test.ts`。
