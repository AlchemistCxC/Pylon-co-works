# Dev Record — #228 技术债偿还：前后端赶工痕迹清偿（六批次）

## 元信息

- issue：#228（单 issue 单 PR）
- 分支：`Ru5t/Reflector`
- 提交范围：`027ad83c..HEAD`（#228 名下 13 笔功能提交 + 2 笔 L.md chore）
- 日期：2026-09-22

## 目标与范围

用户原话：「我想清理下前后端存在的赶工痕迹……偿还技术债务」「我建议全做」。审计（三路只读侦察 + 主会话逐条抽查，两处侦察误报现场修正）后按六批次偿还：A 快赢 / B 演示与生产解耦 / C 豁免清理 / D 结构拆分 / E 健壮性 / F 测试偿还。

**不做什么**：中控区与预设系统（用户硬禁区）；#204③/#226/#229/#230/#36 在途域避让；不接真 mock 功能；不做 B10 功能开发；不改 `vitest.config.ts` 的 maxWorkers/全局超时基调（#175 裁定）；不动 wire 格式/持久化格式/公开 API。

**用户四项决策**（AskUserQuestion 落定）：mockTauri＝开发脚手架上 DEV 门；mock 块与 Prism 页保留加「演示」标识；避让在途三件；单 issue 单 PR。

## 改动清单

| 批次 | 文件（职责块粒度） | 性质 |
| --- | --- | --- |
| B | `src/main.tsx`、`scripts/check-production-excludes-solid-smoke.mjs`、`src/components/sidebar/blocks/mockBlocks.tsx`、`builtinWorkspacePlugins.ts`（Prism label） | 修改（mockTauri DEV 门 + 生产排除双探针 + 演示徽标） |
| B/A | `src/obs04/threeSourceExport.ts` → `src/domains/export/`、obs05/06/07、`builtinExportSources.ts`、`contracts/exportSource.ts`、`scripts/audit-maintenance.*`、维护地图 | 迁移（生产依赖搬出编号目录） |
| A | `src/css04/**`（删）、`src/cwd02/**`（删，测试迁 `src/infrastructure/acp/__tests__/sessionClientCwdWire.test.ts`） | 删除/迁移 |
| A | `saveGatewayRouteTransaction.ts`、`GatewaySheetView.tsx`、`WorkspaceSearchPanel.tsx`、`workspaceSearchContracts.ts`、`gatewayClient.ts`、`App.tsx`、`workspaceStore.ts`、`sessionPersistence.ts` | 修改（过期待后端文案 + 吞错注释） |
| A | `src-tauri/src/acp/{mod,replay,wire_trace,stderr_tail}.rs`、`session/prompt.rs`、`session_store.rs`、`gateway/{truncate,instance,qq/factory}.rs`、`browser_agent_cmds.rs`、`lib.rs` | 修改（过期 allow/死码/理由/eprintln→tracing） |
| C | `acp/{engine,client,turn_ledger}.rs`、`session/owner.rs`、`runtime.rs`、`error.rs`、`acp/tests.rs`、`real_acp_smoke.rs` | 修改（摘模块级 allow、删旧双实现、cfg(test) 化、预留台账） |
| E | `session/event_repo.rs`、`dispatcher/mod.rs`、`plugin_cmds.rs`、`pylon-core/cli_client.rs`、`hermes_runtime.rs`、`plugin_process/mod.rs`、`builtinBrowserCommands.ts` | 修改（expect 链清零、退避、常量化、可观测化） |
| D | `agent_config/atomic_write.rs`（+Options）、`gateway/{instance_store,credentials}.rs`、`lifecycle/mcp.rs`、`pet.rs` | 修改（原子写五处收敛） |
| D | `plugin_cmds.rs` → `plugin_cmds/` 九模块 | 拆分 |
| D | `src/identityStore.ts` → +`identityPersistence.ts`+`identityBackendSync.ts`、`src/utils/{wireGuards,deferrableDisposable,safeJson,copyFeedback,anchorPulse}.ts` 及 20+ 消费方 | 切片/收敛 |
| D | `browser_agent_cmds.rs`（CmdCx wrapper，2132→1388 行） | 收敛 |
| D | `SolidWorkbenchApp.solid.tsx`（1564→36 行，拆 5 文件）、`BrowserSheetView.tsx`（1003→640 行，拆 5 文件） | 拆分 |
| D | `session/event_repo.rs` → `session/event_repo/` 11 模块（redaction 独立成隐私单点） | 拆分 |
| D | `scripts/check-plugin-manifests.mts`（守卫改读目录拼接面） | 修改（连带） |
| F | `vitest.setup.ts`（console.error 白名单硬断言）、`vitest.config.ts`（coverage ratchet）、8 处 5s waitFor→2s、3 文件 77 处 `toBeTruthy`→`toBeInTheDocument`、`scripts/test-replay-state.test.mts` legacy 迁移 | 测试侧 |

## 方案要点

1. **expect 链清零**：event_repo 归一化「校验后 11 处 expect("checked")」合并为单 10 元组 match，成功路径携带强类型值——消灭校验/提取分离的隐式耦合；既有错误文案逐字保留，测试零修改。
2. **豁免摘除的三分法**：真死码删（含 `wait_prompt_with_cancel` 旧双实现、`SdkEngineHandles`）、仅测试消费挂 `#[cfg(test)]`、预留 API 挂理由+台账（约 25 项，含过期卡号 #97/#98→#99 勘误）；`owner.rs` 模块级 allow 以 OWNER-02 已落地为据摘除。
3. **拆分纪律**：纯搬移，公开 API/tauri 命令路径零改动（glob re-export 兜住）；event_repo 拆分做了原文件↔拼接面 `diff -w` 全量审计与 `#[test]`/`fn` 计数对账（56=56 / 131=131）。
4. **行为差异不悄悄统一**：原子写收敛用 `AtomicWriteOptions` 显式保留各站历史行为（mcp/pet 不 fsync 点名留裁决）；browser wrapper 保留不经 finish、不写审计的裸 denial 出口；CLI 就绪事件订阅需三段式改法（无终态闩锁），本轮常量化+记录方向。
5. **测试偿还**：console.error 从全局容忍改 37 文件显式白名单+白名单外硬断言（回收计划成文）；coverage 阈值 ratchet 至实测基线 floor−1；预算回收只做有据降档（5s→2s，等待对象是微任务级刷帧），4s 流式揭示两处只写回收条件不硬改。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| 前端全量测试 | 622 文件 / 4678 用例通过（+1 todo），EXIT 0 |
| Rust 全量测试 | `cargo test --workspace --lib` 1344 用例，EXIT 0（两次进程类测试负载型偶发，隔离 3 连绿，有 #160/3ce3aa14 前科） |
| clippy 基线 | 4 crate（pylon/pylon-core/pylon-foundations/pet-core）零新增，每批次后均复验 |
| `bun run build` 全链 | EXIT 0（build:wasm + tsc -b + vite build） |
| 生产产物排除 | 236 个 JS assets，无 Solid smoke / demo seed / mockTauri（扩版守卫常驻 check:frontend） |
| `check:solid` / `check:docs` / lint / csp / canonical-types / ipc / first-party-styles / tailwind-tokens / deps / acp-shadow / boundaries | 全部 EXIT 0 |
| coverage 阈值 ratchet | 58/44/59/61 → 79/72/79/83（实测 80.48/73.10/80.95/84.12） |
| tsc -b | 零错误（#226 的两处预存错误已由归属会话 `12e89a67` 修复） |
| 死代码清场 | css04/cwd02 删除；replay 死别名、records()/mark()/wait_prompt_with_cancel/TurnLedger::release 等删除 |
| expect 链 | event_repo 归一化主路径 11→0；dispatcher 通知回路 3→0 |

## 测试处置

- **既有行为测试零降级**；event_repo/dispatcher 拆分相关测试断言零改动。
- 同步点名的契约变更：`saveGatewayRouteTransaction.test.ts`（旧文案断言 + 新增「业务失败不误判 blocked」用例）、`WorkspaceSearchPanel.test.tsx`、`workspaceSearchContracts.test.ts`（用例名）、`acp/tests.rs`+`real_acp_smoke.rs`（7 处 `wait_prompt_with_cancel`→`wait_prompt_with_recovery`）。
- 批次F 新增/改造：白名单机制（37 文件，含后补 `sheetLayoutSidebarCollapsedReactive`——canonical feed node 噪音跨文件漂移，3 连跑验证）、`test-replay-state.test.mts` 迁移、`sessionClientCwdWire.test.ts`（自 cwd02 迁入）。
- 新增守卫：`check-production-excludes-solid-smoke.mjs` 扩版（mockTauri 双探针）。

## 证据

- commits：`cc810219` `f7d94c08` `c6b9e894` `325cea07` `1e0899d1` `e8d6d9ce` `ee78e991` `edd1b5b0` `519c96d8` `abaa4c45` `205e9327` `313d187d` + manifest 守卫修正（本记录所在批）。
- 测试：`bunx vitest run` EXIT 0（622/4678）；`cargo test --workspace --lib` EXIT 0（1344）；clippy 基线 4×exit 0；`bun run build` EXIT 0；`check:solid` EXIT 0（manifest 守卫修正后）；生产排除 EXIT 0。
- 预留 API 台账：engine/turn_ledger/owner 摘除过程与全仓约 25 项预留清单（位置/卡号/摘除条件）在施工报告中，已并入 issue #228 回写评论。

## 与 spec 的偏差

1. D-Rust agent 初报「clippy 9 条新增」为误读（实为 reduced 段 + 基线外套件），主会话复验 4 crate 零新增。
2. `plugin_cmds` 拆分连带 `check-plugin-manifests.mts` 读取面漂移（单文件→目录拼接），随拆分修正——spec 未预见，守卫语义不变。
3.批次F 实测发现 scripts 域 12 个 legacy 文件中 11 个早已是现代形态，实际仅迁 1 个。
4. `architecture 参考`、`维护地图`、`CodeBlock` 计时器接入等因 #221 在途域未动（见未解问题）。

## 未解问题（遗留，均已定位非本轮引入）

1. **dispatcher 913 行巨函数拆分**：延后——#229/#230 对该文件有在途声明（其一行 enqueued_at 已随 `66a87542` 落地，条目在 L.md 至合并）；拆分方案（reconnect/flush-batch/notify-fanout）已在 issue 留档。
2. **FileTabView 5 个 effect 的状态机收敛**：属行为语义重构，超出本轮「不改行为」约束，需另立 spec。
3. **CodeBlock 同形计时器接入 copyFeedback hook**：#221 域，hook 已就绪、接入指引在其文档头。
4. **`架构参考.md` 的 `event_repo.rs` 字样**（:109 等）：该文件 #221 在途中，路径漂移待归属会话顺手改（现在解析到 `event_repo/` 目录，链接未断）。
5. **agentWorkbenchLifecycle 2.4s 启动竞态根治**：需后端 connected 前缓冲恢复请求，突破本轮 wire 不变约束，另立 issue。
6. **pylon-markdown 8 条 + pylon-core/agent_detection 1 条 clippy 警告**：HEAD 既有（pylon-markdown 不在基线 crate 集；基线由维护方按需重建）。
7. **plugin_process 忙轮询事件化**：替换面超阈值，评估结论与草案已写入 `EXIT_POLL_INTERVAL` 注释。
8. **mcp/pet 原子写不 fsync**：历史行为显式保留（`sync_temp:false`），是否加 sync 待拍板。
9. **canonical feed 兜底监听无 window 守卫**（白名单 B 类根因）：产品侧补守卫后白名单可逐文件回收。
10. **mock 四块/Prism「接真」**：按用户决策保留演示标识，特性化另立 issue。

## 并行交集

- 全程 pathspec；期间与 #204③/#226（workbench 投影/perf）、#221（高亮 DOM 生命周期：`CodeBlock`/`MarkdownContent`/`ChatView.css`/`架构参考`/`维护地图`）、#229/#230（CLI/permission/private_interaction/dispatcher 一行）、#231（统计脚本）四个在途会话共存，零连带提交事故；唯一搭车：本批次给 `reject_interaction_request` 补的 2 行理由注释随并行会话 `66a87542` 入库（内容正确，无碍）。
- 工作树 node_modules 曾被整体清空一次（非本会话产物），已按 `bun.lock` 恢复（545 包）；详见 L.md 2026-09-22 03 条目。
