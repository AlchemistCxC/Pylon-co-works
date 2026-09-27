# Dev Record — #393 会话标题做成通用 ACP 能力（附 #396 存档列表形状修复）

## 元信息

- issue：#393（enhancement）· #396（bug，声明的依赖件）· 顺带修一处源码卫生（见「与 spec 的偏差」）
- 分支：`kumo/prometheus`
- 基准提交：`bbccf154`
- 用户裁决（原话要点）：显示上「用户改过名就显示用户的名字，实际存储啥的一直都以 agent 给的名字为主」；接受「本地改名不回写 Agent」的不对称；「准许动内核」。

## 目标与范围

把会话标题做成**通用 ACP 能力**：消费官方 `session_info_update.title`（含三态）与 `session/list` 的 `SessionInfo.title`，不新增私有协议。范围含内核 canonical 事实提取（用户已批准动内核）与 #396 的形状修复（#393 存档半程的依赖）。

**不做**：canonical 事件词表改名/收敛（独立议题）；预测侧内核项（#394 暂缓）；`session/list` 的 `nextCursor` 分页消费（见未解问题）。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src-tauri/pylon-session/src/event_repo/normalize.rs` | `session_info_update` 分支增 `title`/`updatedAt` 三态提取 | 修改 |
| `src-tauri/pylon-session/src/event_repo/tests.rs` | 新增三态与 `updatedAt` 两条用例 | 新增 |
| `src/domains/workbench/events/workbenchEventSchema.ts` | `SessionEvent` 增 `session.title-updated` 与 `title: string \| null`；事件类型表登记；**裸 NUL 字节改为 `\u0000` 转义** | 修改 |
| `src/domains/events/wireSemanticCorrespondence.ts` | `WORKBENCH_TYPE_FOR_WIRE.session_info_update` 增标题 fact + 口径注释 | 修改 |
| `src/domains/workbench/normalizers/acpNormalizer.ts` | 新 `sessionTitleOf` + 产出标题 fact（键存在才产出） | 修改 |
| `src/domains/events/canonicalNormalizer.ts` | TS canonical 侧同源落 `typedPayload.title/updatedAt` | 修改 |
| `src/domains/workbench/workbenchProjector.ts` | `WorkbenchSessionSurface.title` + `reduceSession` 设置/删键 | 修改 |
| `src/domains/identity/identityStore.ts` | 新增可选 `renamedByUser` + 导出 `resolveSessionDisplayName` | 修改 |
| `src/domains/identity/sessionPersistence.ts` | 持久化往返新字段（缺省不落键） | 修改 |
| `src/sheets/agent-workbench/agentWorkbenchSession.ts` | runtime 订阅把 `document.session.title` 回写绑定行 `autoName` | 修改 |
| `src/components/sidebar/SessionsPanel.tsx` | 显示名与改名预填走 `resolveSessionDisplayName` | 修改 |
| `src/components/sidebar/useSidebarContributionProps.ts` | 改名置 `renamedByUser` | 修改 |
| `src/domains/overview/persistedSessions.ts` | 兼容官方 `{sessions,sessionId}` 与旧裸数组 `{id}` | 修改 |
| `src/application/transactions/resumePersistedSessionTransaction.ts` | 存档 `title` 落 `autoName` | 修改 |
| 测试（4 文件） | 标题三态/投影设置与清空/显示名解析/官方响应形状 | 新增·修改 |
| `docs/说明书/Pylon-项目架构参考.md` | 新增 `#393` 条目（能力、三态、口径、遗留） | 修改 |
| `.agents/decisions/0030-session-title-acp-capability.md` | 本次决定 | 新增 |

## 方案要点

1. **内核**：`typed_payload` 只在**键存在**时落 `title`/`updatedAt`；`null`（或空白串）原样落 `null`——清空是事实，不能与「不改」压平。
2. **语义层三态收敛为两态**：「缺席 = 不修改」由**事件不存在**表达，所以 `session.title-updated` 一旦出现就是明确表态（`null` = 清空）。
3. **重放无需额外通路**：canonical 行带 `rawPayload`，`canonicalRowToWorkbench` 用原始 update 再走同一套 normalizer（`agentWorkbenchProjection.ts:213`），所以 live / 重放 / 重启三路自动一致。
4. **回写判据取 store 当前值**而非 `binding.boundSession`：普通元数据更新后 bind 会因绑定键未变而早返回，用旧对象比会在每次发布时误判「变了」并反复写盘。
5. **显示口径**：`resolveSessionDisplayName` = 用户改名 > Agent 标题 > 本地生成名；存储侧 `autoName` 恒为 Agent 值。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| 内核三态提取（缺席/null/值） | ✅ `cargo test -p pylon-session --lib session_info_update` 3/3 |
| `updatedAt` 同口径 | ✅ 同上 |
| 前端全量单测 | ✅ `bun run test` 660 文件 / **5083 passed**（1 skipped / 1 todo） |
| 受影响 crate 全量 | ✅ `cargo test -p pylon-session --lib` **181 passed** |
| clippy（基线外新增诊断） | ✅ `bun run check:clippy` EXIT=0，`added: []` |
| 格式 | ✅ `cargo fmt --all --check` 干净 |
| 跨语言词表单源 | ✅ `check:canonical-types`「与 Rust 单源一致（22 项）」 |
| lint | ✅ 0 error（1 条既有 warning 在未触碰的 `GatewaySheetView.tsx`） |
| 类型检查 | ✅ `tsc -b` 干净 |
| 真机验收 | ⏳ 见「未解问题」——需重建二进制并重启 App |

## 测试处置

- 新增：`kernel_ingest_session_info_update_carries_title_tri_state`、`..._carries_updated_at`（Rust）；`acpNormalizer` 标题三态 4 例；`sessionSurfaceProjection` 标题设置/覆盖/清空 + 不污染其它字段；`sessionDisplayName` 4 例；`typedClients` 官方 `ListSessionsResponse` 形状 1 例。
- **修改既有契约断言（1 处，已披露）**：`src/application/transactions/__tests__/resumePersistedSessionTransaction.test.ts` 的 partial 期望新增 `autoName: '存档名'` —— 这是本次刻意引入的行为（存档 title = Agent 名 → 落 `autoName`），不是测试迁就实现。

## 证据

- 内核：`cargo test -p pylon-session --lib session_info_update` → `3 passed; 0 failed`。
- 前端：`bun run test` → `Test Files 660 passed | 1 skipped (661)`；`Tests 5083 passed | 1 skipped | 1 todo (5085)`。
- crate 全量：`cargo test -p pylon-session --lib` → `181 passed; 0 failed`。
- clippy：`bun run check:clippy` → EXIT=0，各 crate `added: []`。
- 词表：`bun run check:canonical-types` → 「与 Rust 单源一致（22 项）」。
- 真机原始载荷（本次调查取证，v0.3.1-FMF 实例）：`canonical_events` seq 171 = `{"sessionUpdate":"session_info_update","title":"Riccati 助手介绍","updatedAt":"2026-09-27T11:08:35.935003600+00:00"}`；`list_persisted_sessions` 返回 `{sessions:[{sessionId,cwd,title,updatedAt}…]}` 295 条。

## 与 spec 的偏差

- 未写 `.agents/spec/` 规格文档（该目录 gitignore，为一次性工作文档）——本次范围与验收直接落在本记录与 ADR-0030。
- **计划外改动 1 处**：`src/domains/workbench/events/workbenchEventSchema.ts` 第 262 行原本内嵌一个**裸 NUL 字节**（`${event.type}<NUL>${JSON.stringify(event)}`，来自 #375-d），导致 `file`/`grep`/Read 把该文件当二进制（我读它时被拒）。改为等价的 `\u0000` 转义（运行时字符串逐字节相同），文件恢复纯文本。全仓扫描确认仅此一处。

## 未解问题

1. **真机验收未做**：内核改动需重建二进制（`bun run build` → `cargo build` → 重启）才能观察，本轮只到单测与门禁层。
2. **`nextCursor` 未消费**：Hermes 的 `session/list` 分页（页大小固定、游标 = 上页最后一个 `session_id`），存档列表在 Hermes 下只显示第一页；Peri 一次给全量不受影响。已记入 #396 遗留。
3. **canonical 事件类型未收敛**：`session_info_update` 在 Rust 侧定型 `session.model-updated`、TS 侧 `session.mode-updated`（用户已明确 mode/model 是两回事，本次不处理）。
4. `title` 到达时机异步（官方 `session/new`/`session/load` 不含 title），界面须容忍「先无名、后到达」——已在实现与文档中写明，未加额外的加载态。

## 并行交集

仅本分支自身改动；未触碰他人在途文件域（`.agents/L.md` 无需留言）。
