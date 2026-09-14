# Dev Record — hook 系统一次性收敛与全量接线（API 1.3，#37 并入）

## 元信息

- issue：#37（验收阻塞项并入）；其余为会话内决策（用户 13 项裁决）
- 分支：`Ru5t/Reflector`
- 提交范围：`cf8f4919..<本次>`
- 日期：2026-09-15

## 目标与范围

用户原话：「目标是一次性做好 hook 系统，并完成接线」。

**做**：废弃 agent.hook 七 phase 契约单层化；词表定稿 API 1.3（23 锚点）并全量接线；`permission.request` 落地（allow/deny/modify + #37 身份规范化）；per-session opt-in 保持 + 插件 picker；per-anchor 超时预算；Hook 诊断面板；锚点集一致性门禁；文档同步。

**不做**：dangerousHooks 升级执行门禁（用户裁决维持仅校验）；权限沙箱；PR 创建（用户自择单大 PR，本地分域 commit）。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src/contracts/agentHook.ts` | 全文件 | 删除 |
| `src/contracts/cwdPoints.ts` | 全文件（CwdHookProvider/CwdPanelProvider 均无消费方） | 删除 |
| `src/host/hookPipeline.ts` | 全文件（含死参数 timeoutMs、无消费的 trace API 包装） | 删除 |
| `src/plugin-runtime/hooks/hookPhaseAdapter.ts` | 全文件（HOOK_PHASE_MAP、registerHookPhaseRunner） | 删除 |
| `src/components/chat/hookRuntime.ts` | 全文件（re-export shim） | 删除 |
| `src/plugin-runtime/hooks/hookTypes.ts` | 词表 24→23（-agent.chunk/-message.agent.committed +permission.request）、每锚点事件 schema、HOOK_TIMEOUT_BUDGET_MS | 重写 |
| `src/plugin-runtime/hooks/hookRuntime.ts` / `hookRegistry.ts` | 默认超时改取预算表 | 修改 |
| `src/plugin-runtime/packageManifest.ts` | LATEST 1.3、SUPPORTED 增 1.2、`apiVersionAtLeast(>=1.2)` 谓词替代 `===LATEST`（修升版误拒隐患） | 修改 |
| `src/application/transactions/sessionHookTransactions.ts` | 重写为直接 invoke + `{source,content,blocks}` 统一方言 + opt-in fail-closed | 重写 |
| `src/application/hooks/canonicalHookProjection.ts` | canonical→turn.*/tool.* 投影（durable-before-publish 订阅） | 新增 |
| `src/application/transactions/removeSessionTransaction.ts` | closing→deleting→deleted→closed 通知序列（notifySessionHook 依赖） | 修改 |
| `src/components/SessionSettings.tsx` / `Sidebar.tsx` | 接线通知序列 | 修改 |
| `src/identityStore.ts` / `agentWorkbenchSessionCreation.ts` / `pylonCliDomainPorts.ts` / `agentWorkbenchLifecycle.ts` | 字段收敛（hooks 入参删除，hookPluginIds 单源）、锚点名迁移 | 修改 |
| `src/components/settings/CwdSettingsPanel.tsx` | Hook 文本框 → 已激活插件多选 picker（未激活 id 保留声明可移除） | 修改 |
| `src/components/settings/HookDiagnosticsPanel.tsx` + Settings/settingsDomains | 新 section（trace/熔断/每锚点注册者） | 新增 |
| `src-tauri/src/hook_bridge.rs` | `PermissionHookDecision` 四态解释（modify 只允许原 optionId 子集）、`resolve_local_source` 身份规范化、`spawn_notification_hook`、4 个新锚点常量 | 修改 |
| `src-tauri/src/dispatcher/mod.rs` | 权限缝重排：规范化→tool.beforeCall gate→permission.request(modify)；bypass/auto 与 UI emit 用过滤后 options | 修改 |
| `src-tauri/src/session/prompt.rs` | context.beforeBuild/afterBuild、turn.started（spawn 不阻塞） | 修改 |
| `scripts/check-hook-anchor-parity.mts` + `package.json` | 锚点门禁（手册全等 + Rust ⊆ TS）并挂入 check:solid | 新增 |
| `docs/说明书/`（开发者版 §6.2/§3.1/§8、用户版） | 词表全名清单、permission.request 协议、版本表 1.3 | 修改 |

## 方案要点

1. **单层化**：三效应映射——observe→notification、gate→pipeline+cancel、transform→pipeline+event 改写。`HOOK_TIMEOUT_MS=50` 死常量随层清除。
2. **唯一方言**：`message.user.beforeSend` 全宿主只有 `{source, content, blocks}`；transform 改写 `content`/`blocks`；CLI 域 blocks 恒空数组。
3. **modify 协议**：`{action:'continue', event:{...event, options}}`，Rust 逐项校验 optionId ∈ 原集合（未知/重复/空 → 整体 Pass + 放行常规流程），防伪造授权选项。
4. **身份规范化**（#37）：`resolve_local_source(manager, agentId, periId)`——owner 优先、跨 runtime 歧义/未命中 → `None` + `tracing::warn!` 可诊断跳过，fail-open 至常规审批流；不做无 owner 全局回退。
5. **投影落点**：`pluginEventBus` 的 durable-before-publish 扇出（sink append 成功后才 publish），replay 不经 sink 天然不重复；`turn.failed(stopReason=cancelled)` 细分为 `turn.cancelled`，与 Rust turn.started 缝不双发。
6. **超时预算**：gate 类（beforeSend/received/permission/tool.beforeCall）3000ms、通知类 1000ms，`HOOK_TIMEOUT_BUDGET_MS` 单源；registry normalize 取表。
7. **通知锚点 spawn**：context.*/turn.started 在 Rust 发送链 `tokio::spawn` 派发，1s 预算，失败仅 debug 日志。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| 七 phase 文件删除、全仓 grep 零残留 | ✅ `grep HOOK_PHASE_MAP\|registerHookPhaseRunner\|HookPhase` 零命中 |
| `HOOK_NAMES` = 23（含 permission.request，无 agent.chunk/message.agent.committed） | ✅ |
| 锚点门禁脚本绿且注入漂移即红（实测 permission.requestX → exit 1） | ✅ |
| API 1.3 + 1.2 manifest dangerousHooks 兼容（`>=1.2` 谓词） | ✅ 回归测试 |
| GUI 删除序列 closing→deleting→deleted→closed | ✅ removeSessionTransaction 测试（含失败路径只发 closing） |
| canonical 投影映射 + opt-in 过滤 | ✅ canonicalHookProjection 测试 |
| Rust 权限钩子：allow/deny/modify/不可映射诊断 | ✅ hook_bridge 11 测试；全量 972 绿 |
| tool.beforeCall cancel → reject 应答短路 | ✅ dispatcher 顺序实现 + 解释器单测 |
| context.*/turn.started spawn 不阻塞 | ✅ cargo build + prompt 测试不红 |
| CLI 方言迁移（只认 content） | ✅ sessionHookTransactions 测试 |
| picker 持久化 + 文本框移除 | ✅ CwdSettingsPanel.hookPicker 测试 |
| 诊断面板渲染 | ✅ HookDiagnosticsPanel 测试 |
| 文档一致 | ✅ 手册 §6.2 全名清单与代码逐项一致（门禁保证） |

## 测试处置

- 新增：`sessionHookTransactions.test.ts`（重写自 `components/chat/__tests__/hookRuntime.test.ts`，后者删除）、`canonicalHookProjection.test.ts`、`HookDiagnosticsPanel.test.tsx`、`CwdSettingsPanel.hookPicker.test.tsx`、removeSessionTransaction 通知序列 2 例、packageManifest api=1.3 describe 块、hook_bridge 权限四态 + 身份规范化 2 例。
- 修改：`hookRegistry.test.ts`（超时断言取预算表）、`packageManifest.test.ts`（agent.chunk → turn.started）、`sessionCreationPaths.test.ts`（mock 路径）、`sessionSourceIsolation.test.ts`（hooks 入参 → hookPluginIds）。
- 删除：`hookPhaseAdapter` 相关测试（随文件）。
- 存量修复（非 hook 域，红歼）：`workbenchEventSchema.test.ts` 补 `assistant.text.delta.batch`/`thinking.delta.batch` 投影向量（#81 L1 遗漏）。

## 证据

- 测试：Rust `cargo test --lib` 972 通过 0 失败；四包 `cargo fmt --check` 绿；前端 lint 0 error；vitest 全量见下（门禁节）。
- 门禁：`bun scripts/check-hook-anchor-parity.mts` exit 0（漂移注入实测 exit 1）。

## 与 spec 的偏差

1. **turn.cancelled 改为 canonical 投影单源**：spec 原计划 Rust cancel 缝派发；实施发现 normalizer 已把 wire `cancelled` 标注为 `turn.failed(stopReason='cancelled')`（canonicalNormalizer.ts:216），走投影可避免与终态锚点双发，且少一处 Rust 缝。spec 未决问题节已预告此假设。
2. **context.beforeBuild 的 `blockCount`**：构建前无块数，payload 仅 `after` 携带 `blockCount`；schema `ContextBuildEvent` 相应调整。
3. 其余按 spec 与用户 13 项决策落实；两项用户自择偏离推荐（dangerousHooks 仅校验、单大 PR）已在决策记录标注后果。

## 未解问题

- dangerousHooks 仅校验 + 权限钩子 modify 的组合意味着「已启用 + opt-in」插件可改写权限选项甚至短路授权，无知情确认环节——与 D16 全信任前提自洽，但手册已明示其权力；后续如需收紧，接 D4 危险档门禁即可（词表门禁已就位）。

## 并行交集

`package.json`（check:solid 链）、`src/plugin-runtime/hooks/*`、`src/identityStore.ts`、`src/components/Sidebar.tsx`、`src/components/SessionSettings.tsx`、`src-tauri/src/dispatcher/mod.rs`、`src-tauri/src/session/prompt.rs`、`src-tauri/src/hook_bridge.rs`、开发者手册——改动期间请基于本分支最新提交 rebase。
