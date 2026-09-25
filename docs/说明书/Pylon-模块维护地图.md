# Pylon 模块维护地图

本页说明当前源码的责任边界，不是将来必须照着搬目录的施工计划。术语见 [CONTEXT](../../CONTEXT.md)，命名与模块规则见 [开发规范](../../.agents/dev-standards.md)。目录清单的可执行来源是 [audit-maintenance.mts](../../scripts/audit-maintenance.mts)；用 `bun run check:maintenance` 查看当前数量、未归属文件和大文件定位。数量随代码计算，不在文档复制。

## 责任与入口

| 维护块 | 路径与入口 | 所有者、输入输出与限制 | 验证入口 |
| --- | --- | --- | --- |
| 公开契约 | `src/contracts/`、`src/sdk/` | 定义插件可消费的类型、语义和版本边界；不拥有运行时状态 | SDK / manifest / contribution 测试；`check:deps` |
| 领域 | `src/domains/`；[workbenchProjector](../../src/domains/workbench/workbenchProjector.ts) | normalized envelope → 可丢弃文档；projector 保持唯一，选择器不改 journal | `vitest run src/domains` |
| 应用装配 | `src/app/`、`src/application/`、`src/kernel/`；[applicationRuntime](../../src/application/applicationRuntime.ts) | application 层拥有应用注册和事务；kernel 负责根挂载、恢复与启动接线；`app/startupTiming.ts` 是启动相位打点（#269，release 可用旁路，ready 时一次性上报，权威出口在后端 runtime log） | `vitest run src/kernel src/application` |
| 基础设施 | `src/infrastructure/`；[runtimeClient](../../src/infrastructure/tauri/runtimeClient.ts) | UI / domain 边界到 IPC、存储、传输；处理错误和取消，不决定产品布局 | `vitest run src/infrastructure`；`check:boundaries` |
| 插件宿主 | `src/plugin-runtime/`；[pluginCompositionRoot](../../src/plugin-runtime/pluginCompositionRoot.ts) | 拥有 registry、activation、权限与资源 Scope；产品通过贡献接入 | `vitest run src/plugin-runtime` |
| 第一方产品 | `src/plugins/`；[builtinProductPlugins](../../src/plugins/product/builtinProductPlugins.ts) | 产品定义激活依赖，`plugins/core` 提供产品实现；不因 core 名称变成 Kernel | `vitest run src/plugins`；产品贡献/样式门禁 |
| 工作台宿主 | `src/host/`、`src/sheets/agent-workbench/`；[agentWorkbenchSession](../../src/sheets/agent-workbench/agentWorkbenchSession.ts) | 拥有会话绑定、generation、订阅和文档更新；renderer 经 Host Port 发命令 | `vitest run src/host src/sheets/agent-workbench` |
| 渲染器 | `src/renderers/`；[SolidWorkbenchApp](../../src/renderers/solid-workbench/SolidWorkbenchApp.solid.tsx) | 消费 document / appearance / commands；拥有局部 UI 与 DOM 清理，不另建会话数据源 | `vitest run src/renderers`；`check:solid`；实际 UI 检验 |
| 工作区 UI | `src/sheets/`、`src/workspace-sheets/`、`src/components/` | Sheet 激活、设置与已有组件；agent-workbench 子目录优先归宿主块。chat 含历史编排，迁移前逐个核实 | 对应组件/Sheet 测试；`check:first-party-styles` |
| CLI | `src/cli/` | 语法和执行适配，复用命令责任方，不重建 session 生命周期 | `vitest run src/cli` |
| 观测 | `src/obs04/`—`src/obs07/` | 冷启动、删除取证、stderr 样本与三源导出 DEV 触发器；只读证据，触发器在 main 动态接入。#228 起三源采集器下沉 `src/domains/export/`（生产 `core.export.*` 与 DEV 钩子同源） | `vitest run src/domains/export src/obs04 src/obs05 src/obs06 src/obs07` |
| 历史策略 | `src/css01/` | 已有样式取证基线；目录编号本身不是删除或合并的证据（`src/css04/`、`src/cwd02/` 已作为零引用死代码删除，#228；cwd wire 行为锁迁 `src/infrastructure/acp/__tests__/`） | 各目录测试；样式与边界门禁 |
| 窄工具 / 演示 | `src/utils/`、`src/demo/` | 窄工具按消费者归属；demo 数据不能当真实 Agent 结果 | 对应工具测试；生产 bundle 检查 |
| 前端根文件 | `src/*` 的直接文件、`src/presets/`、`src/zones/` | 入口（main/App/index.css/声明文件）与主题/预设集群（`store.ts`、themeFieldDefs、themeFieldRenderer、themePresetState、customPresets、tokenFormat、`presets/`、`zones/`，归 #266 中控/预设域）；#351 起其余根级 store/持久化/错误件已按域下沉，不吸收新增子目录以掩盖归属缺失 | `lint`、`build` 与消费者测试 |
| 测试支撑 | `src/test-utils/` | mock 形状与 fixture 工厂（如 `tauriCoreMock.ts`）；仅测试代码消费，不进生产构建 | `lint` 与消费它的套件 |
| Native ACP | `src-tauri/pylon-acp/src/`（引擎核）+ `src-tauri/src/acp/`、`dispatcher/`、`lifecycle/`（宿主适配） | #247 起协议引擎核（engine/client/negotiated/replay/wire_trace/policies/interaction_queue）独立 crate，结构化日志经 `runtime_sink` 端口注入；宿主侧保留实例注册与 harness 表征测试，传输、协商、通知路由、实例连接；lifecycle 锁序与 generation 保持一个入口。#98 起：`acp/negotiated.rs` 是能力协商快照唯一真源（canonical 矩阵 + 四态 + 消费者注册表，session 建立/重连探针/agent_status 消费同一份；#110 F2：`list`/`close` 为**双形状**——ACP 标准的 object 与线上旧广告的显式 `true` 都算广告，其它值仍 fail-closed），`acp/interaction_queue.rs` 是 permission/elicitation/question 等 client request 的统一 request-id 队列（FIFO、单一 Active、cancel/timeout/disconnect drain 终态、冷挂载快照），`session/fork.rs` 是 `session/fork` raw RPC 消费者（能力 usable gate + 受限 envelope + parent/child 登记） | Rust ACP / dispatcher / lifecycle 测试；`check:acp-shadow`；#316 宿主 fs/terminal 双门控（`host_tools.rs` `HostToolsPolicy::resolve` 是广告与门禁**单一解析源**，`initialize_plan::build_initialize_plan` 消费同一结论注入/裁剪 initialize 广告）+ elicitation 标准 form（广告 `{form:{}}`、`AcpKind::ElicitationComplete` 收敛、GUI 表单卡 `ElicitationRequestCard`）+ `classify_session_update`（SessionUpdate typed-first + 宽容别名 fallback 的变体分类唯一入口）+ stopReason/protocolVersion 官方判定（`prompt_stop_outcome`/`validate_protocol_version`）；strict fs 沙箱根权威归会话工作区（SessionInfo.cwd），不取 agent 自报参数；#348/#349 起：崩溃控制帧单一构造点 `crash_control_frame` + 传输失败分类 `transport_failure_reason`（干净关闭 = 子侧传输 future 返回 `Ok`，不发帧；`Some` 臂只覆盖非 EOF 物理 IO 错误）、`SUPPORTED_PROTOCOL_VERSIONS` 只接受 v1（fail-closed，拒绝发生在发出 `initialize` 之前的计划层）、`process::hide_console_window` 覆盖全部生产 spawn；revive 的 `session/load` 与 `session/persist` 同构走 replay capture（预插 `replay_loading` 槽 → `begin_replay_capture` → 回放内容丢弃，journal 仍是唯一 durable 权威） |
| Native session | `src-tauri/pylon-session/src/`（存储核）+ `src-tauri/src/session/`（命令编排） | #247 起存储核（event_repo/msg_repo/retention/turn_rollup/user_data/persistence_bootstrap，`SessionError` 错误域）独立 crate，结构性禁止触达 tauri；宿主 session 事务、journal 与 replay；持久化提交先于发布，删除 tombstone 阻止复活（#110 F3：删除在写 tombstone 的同一事务内清扫该 owner 的 canonical 事件；遗留垃圾由墓碑清扫 + WAL checkpoint 的后台维护兜底；#110 F5：建立期按「agent 显式 model > profile.model > 响应回显」落 `session.model-updated`）。#324 起：用户主动停止（prompt 响应 `stopReason=cancelled`）由 `session/prompt.rs` `finalize_response` 在 #316 闭式表之前拦截、改走 done 通道中性结算（账本 Cancelled 终因与 #99 settle 不变；`protocol.rs` 闭式表契约不动；前端 `agentWorkbenchSession` 终态映射 + `GenerationFooter` reason='cancelled' 「已停止」呈现） | Rust session / event_repo / replay 测试 |
| Native host | `src-tauri/src/` 其余模块 | Tauri 命令注册、文件/终端/Gateway/安装等 native adapters；专业子目录优先归属；`startup_timing.rs` 是进程启动相位表（#269，t0=main 首行，`report_startup_timing` 合并前后端相位出一条 source="startup" 日志） | host 库测试、构建与 Clippy |
| 可复用 Agent 能力 | `src-tauri/pylon-core/src/` | catalog、检测、preflight、launch plan、AgentDef 值类型（`agent_config`）、hermes 启动适配、correlation 身份契约、provider_adapter 投影；保持受控探测与配置身份区分 | workspace 化后随 `cargo test --workspace --lib` 进门禁；Clippy 走 workspace 单跑 |
| Native 基础 / 宠物 | `src-tauri/pylon-foundations/src/`、`src-tauri/pet-core/src/` | 基础类型与独立宠物领域；不从 renderer 或 Tauri UI 反向导入 | 同上（单锁单 target，`--workspace` 一条命令覆盖全 crate） |
| canonical 契约单源 | `src-tauri/pylon-canonical-types/src/` | canonical 事件类型词表、wire 判别符映射与 identity 推导（owner key / eventId / sequence）。**唯一事实源**：TS 侧词表由 `scripts/generate-canonical-event-types.mjs` 从它生成，写入侧 `pylon-session/src/event_repo/` 与计算核同时消费（#220 WP1，ADR-0018） | `cargo test --workspace --lib`；`check:canonical-types`（TS 生成物是否同步） |
| 保留策略契约单源 | `src-tauri/pylon-session/src/retention.rs` | 保留策略档位/默认值（TIME_DAYS_TIERS / COUNT_LIMIT_TIERS / DEFAULT_*）。**唯一事实源**：TS 侧常量由 `scripts/generate-retention-policy.mjs` 从它生成到 `historyRetentionPolicy.contract.ts`，`historyRetentionPolicy.ts` 只引入再导出并承担读取/校验/影响提示（#331/U3 裁决；此前为逐字双写无门禁） | `cargo test --workspace --lib`；`check:retention-policy`（TS 生成物是否同步，在 check:frontend 链内） |
| 前端计算核（WASM，**2026-09-21 起只剩流式**） | `src-tauri/pylon-compute/src/streaming/` | 流式文本管线（stable/unstable 切分、揭示预算引擎 D1/D2）的**计算层**，`wasm-bindgen` 出口。纯函数：不读时钟/store/registry、不做 IO、不发明活性判定（权威在运行时内核，ADR-0017）。出口分「纯内层 + wasm 薄壳」两层（`JsError` 在非 wasm 目标会 panic）。**投影与 events 的 Rust 侧已删、回退 TS**（ADR-0018）：投影在 `src/domains/workbench/workbenchProjector.ts`（活实现），events 一直就在前端 TS（`src/domains/events/**`、`infrastructure/events/canonicalEventBatch.ts`）。产品路径的编排与 DOM 消费仍在 JS，`src/wasm/` 是构建产物 | `cargo test --workspace --lib`、`check:rust`；**等价性**对照见 `scripts/compute-parity/`（parity 门禁，只对流式两项）；**性能**读数见 `scripts/perf-bench/`（`bun scripts/perf-bench.mts`，产品路径绝对成本；2026-09-22 起取代已废除的 wasm↔TS 比值跑器）；markdown 回归见 `markdownComputeParity.test.ts` 的快照锁 |
| markdown 解析（WASM） | `src-tauri/pylon-markdown/src/` | comrak（GFM + math_dollars/footnotes，#267）解析 → 与 TS `MarkdownRenderNode` 同形状的渲染模型，**整块进/整块（行数组）出**。**代码高亮自 2026-09-22 起不在本 crate**（#241，ADR-0020）：原 syntect 语法机器 + 14 份 vendored tmLanguage 语法（`assets/`，由 `gen/generate-assets.mjs` 从 starry-night 导出）编译后常驻 wasm 线性内存且**只涨不落**（#240 实测占渲染器可控内存 ~30%），整条退役，改为前端 Lezer（`src/components/chat/lezerHighlight.ts`，应用内文件编辑器同一套引擎）。不含 DOM 与缓存编排（那些留 JS：`renderers/solid-workbench/chat/markdownRenderModel.ts` 解析缓存/graft、`renderers/solid-workbench/chat/codeBlockDomLifecycle.ts` 高亮 DOM 生命周期——视口门控、圈外降级+行缓存、帧预算调度，#221） | `cargo test -p pylon-markdown --lib`；`parity/` 只剩语料与 Rust 快照（126 条，含 #267 数学/脚注用例，供 `markdownComputeParity.test.ts`） |
| 构建与工具 | `src-tauri/*` 的构建文件、`scripts/` | 开发、审计、打包工具；不是产品运行时依赖 | 脚本测试、发行校验、`check:docs` |

`check:maintenance` 覆盖上述根下受 Git 管理或未忽略的新 TS/JS（含 m/c 变体）、Rust、Python、PowerShell、shell 源文件；排除 tests、fixtures、vendor、target、node_modules、声明文件与打包资源。CSS、图片、配置及文档不是该源码计数的对象，分别由样式、主题、manifest、bundle 和文档门禁维护。Rust 行数包含内联单测，只能用于定位；不能由行数断言生产复杂度。资源 SDK 是构建产物，不能当作第二份可编辑实现。

新增目录的归属在 `moduleDefinitions` 显式登记；未知前端子目录会导致检查失败。该清单按目录责任归类，**不能替代 import 依赖检查**，后者仍由现有 runtime / renderer / contribution 门禁负责。

## 会话与渲染边界

```mermaid
flowchart LR
  A[ACP notification / session response] --> B[Native session journal / frontend host]
  B --> C[Normalized envelopes]
  C --> D[唯一 Workbench projector]
  D --> E[WorkbenchDocument]
  E --> F[Solid / renderer slots]
  F --> G[Host Port commands]
  G --> B
```

图是责任流，不表示每个响应都写入 native journal。session response 的补充投影和浏览器旧消息桥接有各自来源与信任级别，不能借重构升级为 authoritative replay。

当前已分开的责任：

- [sessionResponseProjection](../../src/sheets/agent-workbench/sessionResponseProjection.ts)：响应选项、模型/模式与 envelope 值转换（#304：存在标准 configOptions 时不再合成 legacy model/mode 候选；事件 id 含 sequence，kind 区分会话建立与选择器更新）。去重（只与**最近一条**响应 + 当时 session 快照比对，故 A→B→A 不被永久吞掉）、session owner、订阅与顺序留在 host。
- [messageSnapshotProjection](../../src/sheets/agent-workbench/messageSnapshotProjection.ts)：旧消息快照转换。调用者负责读取存储；转换不提升历史数据的权威性。
- [toolConnectorProjection](../../src/renderers/solid-workbench/toolConnectorProjection.ts)：连线身份、legacy 优先去重与 appearance 解析。布局测量、DOM 注册和卸载留在挂载组件。
- [interactionProjection](../../src/domains/workbench/interactionProjection.ts)：interaction 的脱敏与终态保留策略。类型引用不引入反向运行时依赖，事件次序/去重仍由父 projector 管理。

## 判断是否需要继续拆分

| 已核验的现状 | 维护判断 |
| --- | --- |
| `kernel/applicationRuntime*` 的 deprecated 转发已于 2026-09-13 删除：`src/kernel/` 只剩根挂载/恢复组件与启动接线，测试直接依赖 `src/application/applicationRuntime.ts` | 该维护判断已执行完毕；保持单一 application 入口，不再产生第二转发层 |
| `lifecycle/mod.rs` 的后半部为内联测试，连接/切换/重连通过 `do_connect_and_replace` 共享锁序 | 不为缩短文件搬动锁和并发流程；后续行为变更与对应 characterization 测试一起处理 |
| `dispatcher/` 已有 `routing`、`canonical_flush`、`crash_reconnect`、`interaction_route`、`host_tools_gate`、`permission_route`、`fallback_route` 缝模块（#317 批次二）；宠物事件在 sessions 锁内收集、锁外按序应用。#336/U2b：主泵 `start_notification_dispatcher` 为编排入口（复位+装配+spawn），循环骨架在 `NotificationPump::{new,run,pump_step,route_frame}`——分支各一行模块调用，`route_frame` 的 return true/false 精确映射原 continue/break；flush 环境经 `flush_context()` 现场构造（#335 `CanonicalFlushContext` 字段清单唯一处）。#334：逐帧热路径 payload 经 `Arc<Value>` 共享进 ingest（ingest 先、publish 后取回唯一引用），reducer 走 `AcpSessionState::apply_session_update` 零拷贝入口，`turn_ledger` 拆 active/terminal 双表（单 Mutex）后 `note_session_activity` 只扫 active 表 | 继续拆块必须保持锁外副作用时序；路由顺序与锁持有范围不得随重构改变（对照基准 = `route_frame` 分支次序与 `pump_step` biased 优先级） |
| OBS 04—07 的采集对象、trace 包装与返回 API 不同 | 不把相似安装守卫抽成泛用全局注册器；保留 DEV 隔离和各自证据语义 |
| 根 store 已随 #351 下沉各域（identity 经 `app/ports/identityCrossDomainPort` 单向装配）；plugins/renderers 仍有 10 个 global store import 在 legacy 白名单 | 白名单仅报告存量消费点；不能通过新增豁免宣称模块化完成 |

## 验证

`bun scripts/audit-maintenance.mts --naming` 额外输出生产 TS 绑定命名发现；它复用 ESLint 配置，不维护第二套规则。`bun run lint` 是包含测试代码的命名门禁。Rust casing 由 Rust lint 维护，语义名与单位仍需 code review。

整体入口是 `check:frontend` 与 `check:solid`——#179 起 `check:solid` 同入 CI 前端 job，本地与远端同一套边界门禁——再加上当前 CI 的 Rust 测试 / ACP shadow parity / workspace 单跑 Clippy。#184 起 CI 拆为多并行 job；#193 起为 frontend（静态门禁 `check:frontend:static` + main 专用覆盖率）/ frontend-test（vitest `--shard` 分片矩阵）/ rust-test / rust-clippy / rust-shadow 五个 job：`check:frontend` 本地语义保留（含测试），CI 上 vitest 走 frontend-test 分片（650+ 个测试文件，数量随代码计算，对半并行），覆盖率门禁只在 main push 执行（阈值仍拦住合入后的 main）；Tauri core mock 统一走 `src/test-utils/tauriCoreMock.ts` 工厂（形状单一来源，行为仍 per-file）；#193 曾试点 react-shared 组 jsdom 环境共享（`isolate: false`），因实测收益微小（environment 累计仅降 ~16s）且与隔离组时序敏感测试的抖动相关而**回退**——DOM 套件维持 per-file 隔离；`check:acp-shadow` 与 golden trace generator 的 cargo 调用统一 `--features test-agent` 指纹；`check:maintenance` 已接入 `check:docs`，随前端 CI 执行。各阶段的测试日志和 CI 结果放在本次工作记录，避免把一次绿色运行写成永久保证。
