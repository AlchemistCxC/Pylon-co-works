# Dev Record — #381 前端审查清理（死垫片 / 零引用导出 / 私有副本收敛 / 双向依赖解环）

## 元信息

- issue：#381（refactor，assignee AlchemistCxC）
- 分支：`kumo/prometheus`
- 日期：2026-09-27
- 背景：前端双域审查（视图/渲染层 + 状态/基础设施层并行调查，约 500 文件）发现的清理项总账。审查中四项初判经深挖后**被既有决策或语义裁决推翻**，一并记录于此（见「裁决与不做」）。

## 目标与范围

清掉审查确认的死垫片、零引用导出、可收敛的复制实现；解开 `sheets` ↔ `workspace-sheets` 双向依赖；给 `periId` 补领域术语。

**不做什么**（各有归属或决策，防范围失控）：

- 主题根文件集群（`store.ts` / `themeFieldDefs` / `themePresetState` / `customPresets` / `themeFieldRenderer` / `tokenFormat`）——**#266 风暴区**，#351 spec 已明确避让，归 #266 线处置。
- `workbenchProjector.ts`（redact 双份、`as unknown as` 密集、上帝文件拆分）与 `workbenchEventSchema.ts`（isRecord/fnv1a/mapper 重复）——**#375/#376 在途施工域**，本轮不触碰，待其落地后另起。
- `threeSourceExport` 改走 `canonicalEventRepository`——深挖后**否决**：取证工具有意保留 raw wire 形态（不经 `normalizeCanonicalEventRow`、不启用 `capTypedPayload`、200 页截断保护、revision 容错取 -1）。收敛前提是 repository 先提供 raw 读出口（现有 `exportRaw` 仅单行），已在 #381 转发项 2 说明，防止后人误「修复」破坏取证语义。
- `themeDefaults.ts` 的 `as unknown as ThemeSettings`——文件头「Q1：不做类型体操」+ `test-defaults-completeness.mts` 运行时断言是既有决策。
- `kernel/kernelAcceptanceControls.ts`——非死代码（`KernelRoot.tsx` 与测试在用），仅缺摘除时间点，不动。
- obs04~07/css01 目录命名（工单号目录）、`renderers/` 冗余层、双引擎镜像常量机制化——架构级，留 #381 决策口。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src/components/chat/acpTypes.ts` | 整文件（8 行转发垫片，零引用） | 删除 |
| `src/components/right-panel/workspaceApi.ts` | 整文件（18 行转发垫片，零引用） | 删除 |
| `src/components/chat/diffPresentation.ts` | 整文件（转发垫片） | 删除 |
| `src/components/chat/DiffCard.tsx` | import 直连 `domains/tool/diffPresentation.ts` | 修改 |
| `src/components/chat/__tests__/sessionModeState.test.ts` | 垫片 import 改直连 `infrastructure/acp/chatContracts.ts` | 修改 |
| `src/components/right-panel/__tests__/workspaceApi.test.ts` | 垫片 import 改直连 `infrastructure/tauri/workspaceContracts.ts` | 修改 |
| `src/domains/activity/taskPill.ts` | 整文件（`resolveTaskPill`/`TaskPill` 零引用） | 删除 |
| `src/domains/agent/builtinAgentDescriptors.ts` | 删 `registerBuiltinAgentDescriptors`（注册已由 adapter 插件激活生命周期接管） | 修改 |
| `src/domains/rendererContent/rendererContentRegistry.ts` | 删 6 个零引用 list/resolve 函数 | 修改 |
| `src/domains/permission/approvalMode.ts` | 删 `nextApprovalMode`/`applyApprovalModeChange`/`ApprovalModeChangeOptions`/`FALLBACK_APPROVAL_MODE` | 修改 |
| `src/domains/agent/agentRegistry.ts` | 删 `resolveAgentInteractionEnvelope`/`resolveAgentActivity` 及孤儿 import | 修改 |
| `src/domains/workbench/workbenchAppearanceStore.ts` | 删 `snapshotRevision` 及孤儿 import | 修改 |
| `src/domains/workbench/workbenchSkinContract.ts` | 删 `WORKBENCH_DOM_CLASSES` | 修改 |
| `src/plugin-runtime/testing/pluginRuntimeHarness.ts` | 删 `createTestPluginRuntime`（`TestPluginRuntime` 类有消费者，保留） | 修改 |
| `src/domains/workbench/diffSnapshot.ts`、`terminalSnapshot.ts`、`content/contentPartSchema.ts` | 私有 `isRecord` → import `utils/wireGuards` | 修改 |
| `src/domains/workbench/normalizers/normalizerSupport.ts` | `isRecord` 改为 wireGuards 的 re-export（normalizers 共享出口不变） | 修改 |
| `src/domains/cc/ccLayoutState.ts` | `clamp` → `clampFinite`（非有限值落 0），加语义注释 | 修改 |
| `src/infrastructure/persistence/legacyKeyMigration.ts` | `clamp` → `clampRound`（先 round），加语义注释 | 修改 |
| `src/application/transactions/archiveOwnerResolver.ts` | conflict 文案提为导出常量 `ARCHIVED_OWNER_CONFLICT_MESSAGE` | 修改 |
| `src/application/transactions/openOwnedSessionTransaction.ts` | 手抄 conflict 文案改引常量 | 修改 |
| `src/plugin-runtime/pluginCompositionRoot.ts` | 内联 invoke 适配器改用 `tauriInvokeTransport` | 修改 |
| `src/infrastructure/events/pylonStreamWireEvents.ts` | 新增：`pylon:update/user/done/error` wire 事件名 + union 单一来源 | 新增 |
| `src/infrastructure/acp/chatClient.ts`、`src/components/chat/streamChannel.ts`、`streamingSend.ts`、`src/infrastructure/events/canonicalEventFeed.ts` | 流式事件字面量改引常量/派生 union | 修改 |
| `src/main.tsx` | 六段 DEV 动态 import 块收敛为 `DEV_TRIGGER_INSTALLERS` 表 + 单点循环，补安装失败 catch | 修改 |
| `src/sheets/SolidMount.tsx`、`solidStoreBridge.ts`、`__tests__/SolidMount.test.tsx` | 迁至 `src/host/`（React→Solid 桥机制件归位宿主层） | 重命名 |
| sheets/workspace-sheets 共 13 个消费文件 | import 随迁 | 修改 |
| `CONTEXT.md` | Agent language 节补 `periId` 术语条 | 修改 |

## 方案要点

- **isRecord 收敛边界**（勘误后）：本批只收敛本有 import 的文件（3 处）+ 共享出口 re-export（1 处）。**全仓独立盘点实为 13 份非 wireGuards 副本**（初稿误记 11 份，审查 M1 勘误），除已收敛 4 份外保留 9 份，各有理由：零 import 纯模型文件×3（`fileContentValidation`/`lifecycleModel`/`goalModel`——为 3 行样板引入对外依赖违背零依赖姿态）；谓词不同×1（`sessionSurface.ts` 为 `Record<string, JsonValue>`）；语义不同×1（`markdownRenderModel.ts` 缺数组排除）；**初稿漏盘点×2**（`sheets/agent-workbench/agentWorkbenchProjection.ts:267`、`sessionResponseProjection.ts:9`——与 wireGuards 同款，属可收敛项，因所在域有他人在途改动本轮不动，待其落地后随批收敛）；在途×2（`workbenchProjector.ts`/`workbenchEventSchema.ts`）。
- **clamp 改名而非合并**：两份同名不同义（`clampFinite` 非有限落 0 vs `clampRound` 先 round），改名消除复制粘贴时的选型陷阱，不合并保语义。
- **pylon 流式事件常量化**：新建 `infrastructure/events/pylonStreamWireEvents.ts` 作单一来源，`chatClient`/`streamChannel` 的 union 类型从常量派生，`canonicalEventFeed`/`streamingSend` 的运行时判定改引常量。window CustomEvent 类事件已有 `domains/events/pylonCustomEvents.ts` 注册表，不在本次范围。
- **SolidMount 迁 host/**：机制件原住 `sheets/` 导致 `workspace-sheets` 反向依赖 `sheets`（壳层→内容层逆流）。迁 `src/host/`（宿主接缝语义）后 workspace-sheets→sheets import 清零。**solid 编译面实为「目录枚举 × `.solid.tsx` 后缀」双条件**（`vite.config.ts:10`/`vitest.config.ts:9` 正则枚举 renderers\/solid-workbench|sheets|workspace-sheets|components 四目录；tsconfig 两处 include 同构）——`src/host/` 不在枚举内，**未来往 host/ 放 `.solid.tsx` 文件会被静默排除出 solid 编译面**（审查 M2 勘误；vite.config.ts:8 既有注释「凡 .solid.tsx 后缀即 solid 编译」的说法不准确）。本批三文件均不带 `.solid` 后缀，迁移前后都不在 solid 编译面内，「零配置变更」对本批成立。vitest 分组按文件内容判定，`SolidMount.test.tsx` 随迁不受影响。
- **main.tsx 收敛**：数组表保留每钩子 id 语义；安装顺序 = 表序（mock-tauri 首位）；补 `.catch` 上报（原先 rejection 未处理，取证钩子故障会以 unhandled rejection 冒烟）。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| `tsc -b` 全绿 | ✓（每批后跑，最终 0 error） |
| `npm run check:boundaries`（运行时边界门禁） | ✓ 通过，无新增越界 |
| 全量前端测试 `npm run test` | 见下方证据 |
| 被删符号全仓 grep 零残留 | ✓ |
| `workspace-sheets` 对 `../sheets` import 清零 | ✓ |

## 测试处置

- `sessionModeState.test.ts` / `workspaceApi.test.ts`：仅 import 源随垫片删除改直连真实定义，断言零变更。
- `SolidMount.test.tsx`：随文件迁移，内容零变更。
- 无删除/改写的用例语义。

## 证据

- `npx tsc -b`：0 error（每批次后各跑一次）。
- `npm run test`（vitest 全量）：**Test Files 656 passed | 1 skipped (657)；Tests 5041 passed | 1 skipped | 1 todo (5043)**，Duration 109s，exit 0。1 skipped 为既有 `sessionScale.probe` 探针。
- `npm run check:solid`：solid 编译面 tsc + 8 项门禁全过（运行时边界「32 条遗留白名单仅报告；无新增 invoke/store/CustomEvent 越界」、CSS 消费审计 0 死注入 0 悬空、ZONE_FIELDS 187 字段一致、plugin manifests、context panel 接线、hook anchor parity 23 锚点全等）。
- `grep -rn "from '../sheets" src/workspace-sheets`：空。
- **N3 复验**（审查后追加）：`npx vite build` ✓ built in 34s；dist 全量 grep 取证钩子特征串（`__pylonExportThreeSources`/`installMockTauri`/`pylonColdStartSnapshot`/`pylonDeleteForensics`/`__pylonStderrSamples`）**零命中**——表驱动收敛后生产 bundle 仍不携带 DEV 钩子，「零暴露」声明成立。

## 遗留

- #381 转发项：redact 单入口化（待 #375 落地）、repository raw 读出口与取证收敛、domains→components 逆流 26 处、命名方言收敛（双代事件模型、resolveToolSemantic/Type、三 renderer 注册面）、`renderers/` 冗余层、coverage/ 目录归位、obs 工单号目录命名、双引擎镜像常量机制化。
- `fnv1a` 两份近似拷贝：权威份在 `workbenchEventSchema.ts`（在途），待其落地后随批收敛。
- isRecord 剩余两份可收敛副本（`agentWorkbenchProjection.ts`/`sessionResponseProjection.ts`，在途域），待 #375 落地后随批收敛。

## 独立审查勘误（2026-09-27，审查员 agent）

独立审查结论「可合并，0 blocker / 0 major」。三处记录与表述勘误已回写本文：
1. **M1**：isRecord 全仓盘点初稿记 11 份，实为 13 份，漏 `agentWorkbenchProjection.ts`/`sessionResponseProjection.ts` 两份同款副本（上文已更正）。
2. **M2**：「solid 编译面目录无关」说法不实，实为目录枚举 × 后缀双条件，`src/host/` 不在白名单（上文已更正）；建议后续单独修配置或纠正 `vite.config.ts:8` 的既有注释。
3. **N2**：批1 commit message「零引用导出×12」计数不准，实删导出符号 15 个（6+3+2+1+1+1+1）；历史不改，以本节为准。
4. **N3**：main.tsx 表驱动后 tree-shake 依赖顶层常量剪除，已跑 `vite build` 复验生产 bundle 不携带 demo/mockTauri 与 obs 取证钩子（证据见下）。
