# Dev Record — #520 退役残留清偿批（React→Solid 收官后全仓复查）

> 入库保留。规格文档（spec）不保留，其目标、范围、方案与验收结论在此承接。
> 产出路径：`.agents/records/520-retirement-residue-sweep.md`

## 元信息

- issue：#520（已 CLOSED，本批为收官后残留清偿，只评论不重开）
- 分支：`kumo/prometheus`
- 提交范围：`1f086bc4..e68e38b3`（d9d02a5b L.md 声明 → 24c19494 A 域 → a6fd92d1 B 域 → 3a8f5b04 C 域 → e68e38b3 D 域）
- 日期：2026-10-03

## 目标与范围

用户指令：复查 React 退役（#520/ADR-0035）是否彻底，找「退役不彻底、写法不干净、赶工、遗留」，随后修复。四路只读侦察（生产代码残留 / 测试体系 / 文档与注释 / 赶工痕迹）+ 四 agent 分域并行修复。

**不做什么**：不动语义决策项（resetAll 废弃方向、appearance 双实现合并、测试-only 诊断导出簇、契约 Props 收窄）；不重开 #520；不碰 `src-tauri/Cargo.toml`（在途）。

## 改动清单（按域）

| 域 | 大致范围 | 性质 |
| --- | --- | --- |
| A | `useAgentPanelFeedback.solid.ts` toast 定时器互斥 + onCleanup + 新回归测试；`rightPanelTypes.ts` Workspace/Logs 死状态机层删除（连同仅测死码的 2 个测试文件）；`kernelBootstrap.ts` 迁移兼容分支删除；`ElicitationRequestCard.solid.tsx` 桥时代 re-export 删除；`sidebarBridgeTypes.ts` 孤儿岛类型删除；`sheetSidebarState.ts` 3 个零消费导出删除；`themeFieldRenderer` 导出面收窄；`zustandWorkbenchAppearanceStore` → `themeProjectedWorkbenchAppearanceStore` 文件/工厂/测试更名；`demoData.ts` React 源码快照改 Solid 终态示意 | 修改/删除/重命名/新增 |
| B | `StreamingIdentity` 650ms、`InputBar` 600/50ms 真睡改 scoped fake timers；17 处 `setTimeout(0)` → `flushTask()`；`DocsSheetView.boundsSync`/`pluginRuntime` 短睡改 fake timers；`src/test/fakeEventBus.ts` 死资产删除；3 处双重 cleanup 拆除；`vitest.setup.ts` 三处垫片注释对齐现役消费者 | 测试修改/删除 |
| C | 插件系统说明书(开发者版) 10 处、项目架构参考 4 处 React 现状表述改 first-party-solid/Solid 内核口径；dev-standards/CONTEXT 对齐；`check-renderer-architecture` 退役 SmokeHost react 豁免（零豁免）、`check-solid-workbench-boundaries` 死变量删除；`vite.config` vendor-motion 死规则删除；`vitest.config` react-dom/react-shared → jsdom-mock/jsdom-shared；code-stats 标签；src-tauri 3 文件注释（仅注释，fmt 绿） | 文档/门禁/配置 |
| D | 46 个零消费 `XxxProps` 去 export + 9 个死空接口删除；桥 parity 死引用族 14 处、「React 岛/薄壳」现状表述、application/skin/domains 层 React 订阅语义注释全量清偿（#515/#520 编号迁移登记保留）；4 个第一方 manifest 删 `reactVersion`、schema 补 deprecated 说明；plugin-runtime 协议注释 `.tsx` 实名改 `.solid.tsx` | 注释/导出面/manifest |

## 方案要点

- 删除类改动一律 grep 全仓（含测试）复核零消费者后才动手；有消费者的逐个跳过（如 `SheetLauncherProps`/`WorkspaceTitlebarProps`/`FileTabViewProps`）。
- manifest 的 `reactVersion`：核实 `packageManifest.ts` 契约**没有** manifest 级 `runtime` 字段（正规形态在 `PluginUiSurface` 注册 API 侧），且 4 个第一方 manifest 的 reactVersion 无任何运行时消费者——按最小诚实路径直接删除，schema 保留字段并标 deprecated 兼容别名。若需要 manifest 级 runtime 元数据属契约扩张，需另行登记 issue。
- fake timers 转换以「负断言语义不弱化」为第一约束：须在生产定时器排入之前启用假时钟，`finally` 还原防混钟泄漏（pluginRuntime 用例的 watchdog 若落真实时钟会误触发白名单告警）。
- `emptyStateFirstPrompt` 5ms sleep 承重保留：`elapsedMs` 依赖 `Date.now()` 1ms 分辨率，换 `flushTask()` 可能落同毫秒致 `> 0` 断言翻车，已注释钉死。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| `bun run lint` | 0 error 0 warning |
| `bunx tsc -b` + `bun run check:solid`（tsc solid 工程 + 全部边界门禁链） | 全绿（过程中抓出并清偿 9 个死空接口 + 1 处新测试类型错） |
| `bun run test` 全量 | **655 文件 / 5119 passed，0 failed**（1 skipped 为有意 probe，1 todo 为既登记缺口） |
| `bun scripts/check-renderer-architecture.mts` / `check-solid-workbench-boundaries.mjs` / `check-plugin-manifests.mts` / `check-bundle-size.mjs` / `bun run check:docs` | 全绿 |
| `cargo fmt --all --check` | 绿（src-tauri 仅注释行改动） |

## 测试处置

- 删除：`right-panel/__tests__/{workspaceModel,rightPanelTypes}.test.ts`（仅测死状态机层）、`src/test/fixtures.test.ts` 的 FakeEventBus describe、`zustandWorkbenchAppearanceStore.test.ts`（随更名）。
- 新增：`settings/__tests__/useAgentPanelFeedback.solid.test.tsx`（3 用例，含 timer 互斥回归）。
- 修改：B 域 17 个测试文件（竞态清偿，用例数与断言语义均不缩减）。

## 证据

- commit：24c19494 / a6fd92d1 / 3a8f5b04 / e68e38b3
- 测试：`bun run test` → Test Files 655 passed, Tests 5119 passed, exit 0；门禁与 lint 见上表。
- 手工验证：未做实机验收（本批无 UI 行为面改动；唯一行为修复 toast 互斥有单测钉住）。

## 与 spec 的偏差

- 侦察称 `cohereDisplaySnapshot` 全仓零消费，复核发现同文件仍有 3 处存活调用——整删会破编译，降级为去 export，整删需先重设计调用点（见未解问题）。
- 侦察建议 manifest 加 `runtime` 字段，核实后契约不存在，改为直接删除 reactVersion（见方案要点）。

## 未解问题（供登记/裁决，均为语义或 API 决策，未擅动）

1. `runtimeStore.resetAll` 的 `@deprecated` 方向标反：生产 4 处全走 `resetAll`（不清 agentStatuses），「推荐」的 `resetSessionRuntime` 仅测试消费——保留哪个语义需裁定（两种行为不同）。
2. appearance 命令双实现：`themeProjectedWorkbenchAppearanceStore`（生产）与 `reduceAppearanceCommand`/`createStaticWorkbenchAppearanceStore`（fixture+测试）语义当前对齐但无单一真源，漂移温床。
3. `streamingDisplayScheduler.cohereDisplaySnapshot` 已私有化但整删需重设计 3 处同文件调用点。
4. settings 诊断导出簇（`probeSettingsRegistries`/`buildRendererSettingsCatalog` 等）生产零调用仅测试消费——是删是留作公共诊断 API 需裁定。
5. `workspaceClient.ts:15` deprecated string 形态仅旧测试喂养（与 kernelBootstrap 同模式，本批只清了 kernel 一处）。
6. contracts/plugin-runtime 三处零消费契约 Props（`RendererMountProps`/`FileViewRendererProps`/`IsolatedPluginSurfaceProps`）收窄属第三方 API 决策。
7. vitest B 类 console.error 白名单 11 条的根因（canonicalEventFeed 环境守卫）按其既定计划清零后删机制；本轮全量跑未出现 0 命中死条目。
8. `src/__tests__/replay/crossLayerComposition.test.ts:54` 的 `it.todo`（游标层聚合 gap）为已知缺口占位，建议登记 issue 跟踪。

## 并行交集

- 本批全程共享树作业，未 commit 他人在途文件；`src-tauri/Cargo.toml` 保持原样（幻影行尾改动，非本批）。
- C 域动过 `src-tauri/src/{browser/mod.rs,docs_sheet/mod.rs,session/prompt/tests.rs}` 注释行——后续动这三个文件者注意。
- `vitest.config.ts` 分组改名（react-* → jsdom-*）与 B 域测试改动有交叉验证，均已在新分组下跑绿。
