# Dev Record — #269 启动耗时测量基建（release 可用的前后端启动时间线）

> 入库保留。规格文档（spec）不保留，其目标、范围、方案与验收结论在此承接。

## 元信息

- issue：#269（#270「窗口先见」/#271「删 hermes 诊断链」的度量前置）
- 分支：`kumo/prometheus`
- 提交范围：`4a6ffe54..`（本条）
- 日期：2026-09-24

## 目标与范围

一次启动产生**一条**结构化「启动时间线」runtime log：Rust 相位（t0=main 首行）+ 前端相位（t0=页面 timeOrigin），两侧均含 epoch 绝对时刻便于跨端对齐。为 #270 前后对照与 #271 收益核验提供数据。

**不做什么**：不改变任何启动行为与顺序；不动 OBS-05（DEV 取证，职责不同）；不动 `startup_diagnostics`（状态快照）；不做自动基准/阈值门禁。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src-tauri/src/startup_timing.rs` | 整文件：进程 t0（`OnceLock<(Instant, SystemTime)>`）+ 相位表 + `mark`/`process_phases`/`build_timeline_fields` + 内嵌单测 | 新增 |
| `src-tauri/src/startup.rs` | `report_startup_timing` command（合并两侧相位出一条 hub 条目） | 修改（追加） |
| `src-tauri/src/lib.rs` | `mod startup_timing`、`startup_mark` pub 包装、`run()` 4 个相位、`run_setup_pipeline` 4 个相位、Builder 链改绑定 `let app`（插 `windows_created`）、invoke_handler 注册 | 修改 |
| `src-tauri/src/main.rs` | 首行 `startup_mark("process_entry")` | 修改（一行） |
| `src/app/startupTiming.ts` | 整文件：`startupMark`/`startupPhaseMarks`/`reportStartupTiming`（幂等 + isTauri 守卫 + 静默失败） | 新增 |
| `src/app/__tests__/startupTiming.test.ts` | 5 用例（顺序/形状/幂等/非 Tauri/拒绝静默） | 新增 |
| `src/main.tsx` | 模块求值起点 `main_module_eval` | 修改（插桩） |
| `src/kernel/KernelRoot.tsx` | `kernel_root_effect`（首次提交后 effect） | 修改（插桩） |
| `src/kernel/kernelBootstrap.ts` | `kernel_bootstrap_start` / `builtins_activated` / `shell_mounted` | 修改（插桩） |
| `src/App.tsx` | `app_bootstrap_start` / `hydrated` / `ready` + ready 触发上报（setStatus 包装在装配缝，`bootstrapApplication` 纯函数零污染） | 修改（插桩） |
| `docs/说明书/Pylon-模块维护地图.md` | 「应用装配」「Native host」两行补归属说明 | 修改 |

## 方案要点

- **进程相位表 + tracing 双写**：`mark` 同步追加进程级 `Vec<StartupPhase>`（report 时合并输出）并 `tracing::info!` 一条 `startup_phase`。hub 注册前的 tracing event 被 RuntimeLogLayer 丢弃（既有语义），属预期——权威出口是合并条目，tracing 只是实时旁路。
- **t0 = main 首行**：`origin()` 用 `OnceLock` 惰性初始化，`startup_mark("process_entry")` 作为 main 第一句落在最早可观测点；DLL/进程创建开销不计入（本基建不 claim 覆盖 loader 时间）。
- **前端插桩选在装配缝**：`bootstrapApplication` 是 node 可测纯函数（文件头契约「不直接依赖 Tauri」），故 ready/hydrated 打点与上报挂在 `App.tsx` 的 deps 构造处（setStatus/hydrateDomains 包装），纯函数与既有测试零改动。
- **单向时钟对齐**：两侧相位都带 epoch 毫秒；后端再补记 `receivedEpochMs`（含前端→后端 IPC 单向延迟上限）。不做时钟合成，只并排呈现。
- **静默纪律**：打点/上报任何失败（锁中毒、无后端、invoke 拒绝）一律吞掉，绝不阻断启动——观测旁路的第一契约。
- 前端模块生命周期为进程级单例（数组 + reported 旗标），测试经 `vi.resetModules` 动态 import 取全新实例，不污染生产 API。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| 前端 mark 模块单测覆盖顺序/幂等/payload 形状/非 Tauri/拒绝静默 | ✅ `startupTiming.test.ts` 5/5 |
| Rust 打点助手单测覆盖 camelCase 契约/合并形状/空侧/次序 | ✅ `startup_timing.rs` 4/4 |
| 启动路径行为零变化，既有测试零修改 | ✅ cargo lib 809 通过；kernel/app 域 179 通过 |
| clippy 基线零新增 | ✅ 现存 6 条诊断全部位于既有文件（routing.rs/create.rs/agent_detection.rs），本批文件零命中 |
| check:ipc 双向契约 | ✅ 后端 213 命令 / 前端 145 invoke，双向一致 |
| tsc 零新增 | ✅ `tsc -b` 6 错误与干净 HEAD 逐条相同（均为 #267 `mathRender.solid.tsx` 既有红，非本批产物，已报 #267） |
| release 实机时间线可见 | ⏳ 待实机验收（见未解问题） |

## 测试处置

新增：`src/app/__tests__/startupTiming.test.ts`（5 用例）、`startup_timing.rs` 内嵌 4 用例。
修改/删除既有行为测试：**无**。

## 证据

- commit：本条（`4a6ffe54..`）
- 测试：`bunx vitest run src/app/__tests__/startupTiming.test.ts` 5 passed；`cargo test --lib` **809 passed / 0 failed**（exit 0）；`bunx vitest run src/kernel src/plugin-runtime/__tests__/builtinPluginBootstrap.test.ts src/app` 30 文件/179 用例全绿；全量 `bunx vitest run` 结果见 issue 回写
- 门禁：`check:ipc` ok（213/145 双向一致）；eslint（6 个改动/新增文件）0 诊断
- 手工验证：**实机验收已过**（vite build + cargo build + 真机启动，webview2 MCP `list_runtime_logs`）：恰一条 `source="startup"` 条目（id=11），`fields.process` 10 相位、`fields.frontend` 8 相位、`receivedEpochMs` 齐备。实测读数（2026-09-24，本机无默认 agent 配置）：`process_entry=0 → config_loaded=7 → windows_created=43 → setup_enter=543（插件初始化+WebView 创建为最大段）→ persistence_ready=561 → setup_complete=565`；前端 `main_module_eval=107 → builtins_activated=186 → app_bootstrap_start=237（App chunk≈51ms）→ hydrated=356 → ready=493`；进程起点→前端 ready 全程 **1021ms**；epochMs 单调不减 ✓。

## 与 spec 的偏差

- spec 写「App chunk 挂载点：builtinPylonShell lazy import 无直挂钩子，在 App.tsx 效应链首打 App 挂载相位」→ 实施为 `app_bootstrap_start`，其与 `shell_mounted` 的差值即 chunk 拉取耗时（App.tsx 注释已说明）。无实质偏差。
- 其余按 spec 落地。

## 未解问题

1. ~~release 实机验收~~ **已完成**（debug profile 实机：插桩非 DEV 门化，debug 即代表性）。正式 release profile 的数字留待 #270 前后对照时一并在 release 构建采集。
2. `main_module_eval` 不含 import 求值与脚本前开销（与 timeOrigin 的差值可另行估算）；是否需要在 `index.html` 加内联最早 mark 受 CSP `script-src` 限制（生产无 `unsafe-inline`），当前不做。
3. 首轮实测已给出的优化坐标（供 #270/#271 决策）：① `windows_created→setup_enter` ≈ 500ms 是进程侧最大段（Tauri 插件 init + WebView2 创建，属固定地板，#270 作用不在此）；② 本机无默认 agent，`default_agent_connect_settled=12ms`——#270 的收益需在**配置了真实 CLI agent**的机器上对照测量；③ 前端 module_eval→ready 386ms，其中 hydration 119ms + agents/dictionary/status/listeners 137ms。**2026-09-24 补**：②已补测——`PYLON_AGENTS_CONFIG` 指向安装版真实 agents.yaml（默认 agent=Hermes/riccati）实测 `default_agent_connect_settled=2004ms`、`windows_created=2021ms`（连接托底窗口 2 秒），基线已回写 #270 评论区。

## 并行交集

- 共享文件改动：`src-tauri/src/lib.rs`（mod 声明/打点/注册表一行/Builder 链改绑定）、`src/main.tsx`、`src/App.tsx`、`src/kernel/KernelRoot.tsx`、`src/kernel/kernelBootstrap.ts`、`src-tauri/src/startup.rs`（追加 command）、维护地图两行。后续 #270/#271 都会动 `lib.rs`，开工前对表本条目。
- 全程 pathspec 提交；工作树中他人在途改动（若有）一律不 stage。
