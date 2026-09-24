# Dev Record — #317 代码异味清偿批次一（机械修复层）

> 入库保留。规格文档（spec，`.agents/spec/317-smell-cleanup-batch1.md`）不保留，目标、范围、方案与验收结论在此承接。
> 产出路径：`.agents/records/317-smell-cleanup-batch1.md`

## 元信息

- issue：[#317](https://github.com/AlchemistCxC/Pylon-co-works/issues/317)
- 分支：`kumo/filesheet-stage0`
- 提交范围：见「证据」小节 commit 列表
- 日期：2026-09-25

## 目标与范围

承接 2026-09-25 全仓异味审计（三路并行调查，全部发现逐行复核），清除其中**机械修复层**条目：调试残留、死分支、类型守卫统一、41+ 处内联 invoke 适配器收口、`transaction.rs` 七连 `expect`、`workspaceClient` 裸方法。

**不做什么**（架构裁断留给用户，待后续批次）：`dispatcher/mod.rs` 931 行函数拆分、`createAgentWorkbenchSessionRuntime` 680 行工厂拆分、命令边界错误类型五套统一、双持久化惯用法统一、其余 >900 行文件切分、`#[allow(dead_code)]` 清理（受控预留）。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src/domains/workbench/workbenchProjector.ts` | `reduceMessage` 调试行删除；`mergeActivityTerminal` 死分支删除 + 注释改述真实不变量 | 修改 |
| `src/renderers/solid-workbench/chat/content/FileReference.solid.tsx` | 裸 `as unknown as` 统一为 `asFileish`/`asDocument` 守卫；`visiblePath` 增加 `undefined` 防御 | 修改 |
| `src/infrastructure/acp/tauriTransport.ts` | `tauriInvokeTransport` 共享 transport | 新增 |
| `src/App.tsx`、`src/components/**`（8 文件）、`src/sheets/**`（10 文件）、`src/workspace-sheets/activateAgentSheet.ts`、`src/application/transactions/openOwnedSessionTransaction.ts`、`src/plugin-runtime/process/processRuntimeServices.ts`、`src/plugins/core/file/builtinFileWorkbench.ts`、`src/infrastructure/acp/chatClient.ts`、`src/components/chat/streamingSend.ts` | 内联 `invoke: (cmd, args) => invoke(...)` 适配器替换为 `invoke: tauriInvokeTransport`；随之清理未使用的 `@tauri-apps/api` invoke import | 修改 |
| `src/infrastructure/tauri/gitContracts.ts` | `normalizeGitText` 宽容文本归一化 | 修改 |
| `src/infrastructure/tauri/workspaceClient.ts` | `gitShowFile`/`gitDiff` 接 `normalizeGitText`（返回 `Promise<string>`）；删除零调用死方法 `getWorkspaceRoot` | 修改 |
| `scripts/check-ipc-contract.mts` | IPC_EXEMPT 登记 `get_workspace_root` | 修改 |
| `src-tauri/src/plugin_cmds/transaction.rs` | `run_plugin_write` 公共骨架（写锁→root→spawn_blocking→JoinError 映射 `PluginError::Transaction`）；`validate_source_path` 入口校验 helper；7 命令改调用，7 处 `.expect` 归零 | 修改 |

## 方案要点

1. **transport 收口用最小调用点改动**：共享函数签名 `(cmd: string, args?: unknown) => Promise<unknown>` 与各 typed client 的 `ClientTransport` 兼容，调用点一行替换；不强行把 48 文件的直连 `@tauri-apps/api` 全部搬进 infrastructure（超范围）。
2. **`mergeActivityTerminal` 为等价重写**：终态保护实际来自「仅补缺字段」语义（`filled[key] === undefined` 才赋值），原 `if (key === 'status') continue` 位于循环末尾无效果；删除死分支、注释改述真实不变量，行为逐位一致。
3. **JoinError 映射选 `PluginError::Transaction`**（"plugin task aborted: …"）：panic/取消统一走既有事务失败错误码，前端不新增错误形状。
4. **`getWorkspaceRoot` 删除的连锁**：该 client 方法零调用方，此前靠宽匹配门禁把 `'get_workspace_root'` 字符串误算为消费；删除后在 `IPC_EXEMPT` 显式登记（零消费保留面），门禁口径恢复诚实。
5. **FileReference 的 `path` 防御**：`presentFileContentPath` 对 `undefined` 会炸（`path.length`），防御前置在 `visiblePath` 包装层；缺失时 Show 不渲染该行（原行为是 undefined 传播进 DOM 属性）。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| 既有测试全绿且未修改任何测试 | ✅ vitest 全量 648 文件 / 4924 通过（1 skipped/1 todo），测试文件零改动 |
| tsc 类型检查 | ✅ `tsc -b` 零错误（修复迁移残留 2 处 unused import 后） |
| eslint 改动文件 | ✅ 46 个改动 TS 文件零告警 |
| `check:ipc` | ✅ 216 注册 / 147 invoke / 52 豁免，双向一致 |
| boundary 门禁 | ✅ runtime-boundaries / renderer-architecture / product-contribution / solid-workbench-boundaries / tailwind-token-purity 全过 |
| Rust 编译 | ✅ 独立 worktree（HEAD + 本次 transaction.rs）`cargo check -p pylon` 通过 |
| 生产 console.log 归零 | ✅ `__DEBUG_ECHO__` 2 处删除 |
| 内联适配器归零 | ✅ 48 处替换（rg 复核残留 0） |
| transaction.rs expect 链归零 | ✅ `cargo fmt` 后 `.expect(` 计数 0 |

## 测试处置

未修改、未删除任何测试。

## 证据

- commit：（见 issue 评论与 git log `31318aca..`）
- 测试：`vitest run` exit 0（4924 passed）；`tsc -b` exit 0；`eslint` 改动文件 exit 0；`cargo check -p pylon`（worktree）exit 0；`cargo test -p pylon --lib plugin` 见下方结果
- 说明：主工作树 Rust 编译被 #316 在途中间态阻塞（`dispatcher/mod.rs` 引用 `crate::acp::ActivityFlags` 待其接线，非本批次文件域），故 Rust 验证在 `../pylon-317-verify` 独立 worktree（HEAD + transaction.rs 单文件复制）完成，与主树改动等价。

## 与 spec 的偏差

- 适配器实际替换 **48 处**（spec 估 41）：rg 以 `(cmd|command)` 两种参数名形态补充发现，口径更全。
- `workspaceClient`：spec 写「三方法对齐归一化或注释豁免」；实际 `gitShowFile`/`gitDiff` 接归一化，`getWorkspaceRoot` 确认零调用后**删除**（比注释豁免更彻底），并在 `check-ipc-contract.mts` 登记豁免——删除动作连带暴露并修复了门禁宽匹配的误算盲区。
- 其余与 spec 一致。

## 未解问题

- 批次二（架构裁断待用户）：dispatcher 拆分、`createAgentWorkbenchSessionRuntime` 拆分、错误类型统一、持久化惯用法统一、巨型文件切分。
- 工作树遗留未跟踪的 `package-lock.json` / `pnpm-lock.yaml` / `pnpm-workspace.yaml`（仓库只用 bun.lock；非本批次产物，未清理——共享树上非我产出，留待归属者处理）。

## 并行交集

- `workbenchProjector.ts`：含 ADR 通审任务在途的 1 行注释措辞同步（:4 "scope 收窄"，其 L.md 条目已预告），与本次编辑不同行，随本批次 pathspec 一并入库。
- 本次新增 `IPC_EXEMPT` 一项，改动 `scripts/check-ipc-contract.mts`（开工时无在途改动）。
- 其余触碰文件开工时均无他人在途改动（逐一核对过 `git status`）。
