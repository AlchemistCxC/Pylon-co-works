# Dev Record — #514 Agent 探测与导入恢复

## 元信息

- issue：https://github.com/Teens-in-Times/Pylon-co-works/issues/514
- 分支：`codex/agent-import`
- 基线：`github/main` / `f34ca356`
- 日期：2026-10-01—2026-10-02
- 稳定署名：Codex
- 施工目录：独立 worktree，避免原共享树的在途改动。

## 目标与范围

承接用户「导入 agent 不可用，交互逻辑很差」「都不可用，有的是验证成功无法导入」反馈；从本机实例复现，修复首次导入、Windows 启动入口与版本探测的误判，并优化探测、验证、保存和使用的交互。保留现行提供方去重、revision CAS、配置备份、验证门禁及显式未验证导入政策；不手工安装或改写第三方 Agent，启动时仍会执行其自身的初始化行为。

## 改动清单

| 文件域 | 职责 | 性质 |
| --- | --- | --- |
| `src-tauri/src/lifecycle/config_cmds.rs` | 空 active 哨兵的首次保存和重载保护 | 修改 |
| `src-tauri/pylon-core/src/agent_detection/` | Windows 入口定位、版本探测状态及缓存、结构化备用入口 | 修改 |
| `src-tauri/pylon-core/src/agent_preflight.rs`、`src-tauri/src/bin/pylon-detect.rs` | 候选 DTO 测试夹具 | 修改 |
| `src/domains/agent/agentDetector.ts` | 兼容旧报告并归一化备用入口 | 修改 |
| `src/infrastructure/acp/agentClient.ts` | 已注册取消探测命令的 typed client | 修改 |
| `src/components/settings/AgentCandidateList.tsx`、`AgentRuntimePanel.tsx` | 候选优先、报告折叠、入口选择、状态反馈和显式使用 | 修改 |
| `src/components/settings/useAgentDetection.ts` | 单飞、取消顺序、迟到结果隔离 | 修改 |
| `src/components/settings/useAgentCandidateProvisioning.ts` | 草稿验证凭证、保存重试、重复导入保护及取消/卸载隔离 | 修改 |
| 对应前端与 Rust 测试 | 首次保存、入口一致性、草稿修改、取消、卸载、重试及去重 | 新增 / 修改 |
| `docs/说明书/Pylon-项目架构参考.md` | 同步当前发现与导入行为 | 修改 |

## 方案要点

1. 空配置 `agents: {}` 的 active id 是空字符串。原删除保护要求候选表包含该字符串，导致任何首次导入被拒绝。只有非空 active id 才执行现有保护，真实活动 Agent 的保护保持有效。
2. Windows npm 同名无扩展名入口是 Unix shell 脚本。自动定位选 `.exe/.cmd/.bat`，不再把该脚本交给 Windows 进程 API。折叠同一提供方后保留可选的 `alternatives`，前端选择的 executable/args 一并用于验证和保存。
3. `--version` 不被支持、无输出、等待失败或超时不能证明 ACP 不能运行。保留诊断，状态改为 `not_tested`；进程 spawn 失败仍是 `failed`。可重试探针结果不永久缓存，版本缓存的路径/参数/mtime 键和上限保持原有契约。
4. 导入保存配置，显式「使用此 Agent」再连接打开工作区。保存与配置列表刷新共用面板的 AgentClient revision 会话；失败保留草稿，同一草稿的成功握手可复用于保存重试。
5. 单个 operation 对象拥有验证/保存动作。修改、取消或卸载使旧 operation 失去所有权，迟到握手不得发起保存。保存已开始后锁定编辑；写盘成功而刷新失败仍记住已保存结果，防止重试重复创建。后续权威列表重载删除该 Agent 时退役本地记录。
6. 探测具有同步单飞及 generation 隔离；新扫描等待前一轮的取消 IPC 完成，避免旧取消命令误取消新扫描。报告和原始错误细节按需展开，关键状态及错误留在候选旁。
7. 实机复验发现保存后的自动重探测延长按钮忙碌期，并误显示「连接中」。保存结束只刷新配置列表；列表也负责校正旧发现报告的已导入标记，删除后可立即重新导入。候选操作按钮与输入用 Tailwind token 恢复样式；原 `ps-btn` / `set-input` 基础规则已退役，避免引用孤立类。保留 Settings 复杂容器样式，未整文件迁移。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| 零 Agent 首次验证成功可导入，真实 active 仍受保护 | Rust 回归通过；最终实机 Peri 从 0 到恰好 1 个配置，65ms 握手，默认项 1 个 |
| Windows 不选择 Unix launcher；备用入口参数贯穿验证与保存 | Windows 回归及 UI/IPC 测试通过；实机 Claude 两入口均为 `.cmd`，Hermes ACP 入口保存为无参数 |
| 版本超时不再标记 Agent 启动失败 | Rust 状态/缓存回归通过；实机 Hermes 显示「版本未确认」 |
| 取消、编辑、卸载后的迟到成功不导入 | 生命周期回归通过；实机取消后等待 16 秒，配置仍为 0、工作区仍为 0 |
| 保存失败可重试，刷新失败不重复创建 | 对应握手/写盘调用计数回归通过；旧报告删除后可重导入，当前配置表负责已导入状态 |
| 导入与显式使用分开 | 最终实机导入 Peri 后 active 空、工作区 0；显式使用后 connected/available=true、generation=1、工作区恰好 1 |

## 测试处置

- 新增 `useAgentCandidateProvisioning.test.tsx`：保存/使用分离，编辑与卸载隔离，取消旧验证，保存重试复用握手，已保存但刷新失败的去重，以及删除后重新导入。
- 新增 `useAgentDetection.test.tsx`：同步单飞、取消后旧结果不覆盖新结果、新扫描等待取消完成。
- `AgentRuntimePanel.default.test.tsx`：原自动激活用例改为显式使用；增加备用入口的验证/保存一致性。
- 增加旧探测报告仍带已导入 ID 时，权威配置列表删除后的重新导入回归；显式使用用例同时断言导入不重复探测。
- `agentDetector.test.ts`：验证结构化备用入口和畸形数据过滤。
- Rust detection：旧非零退出/空版本/超时的 `failed` 断言按新契约改为 `not_tested`，保留错误诊断及预算断言；增加 Windows Unix-launcher 排除用例，增加折叠备用入口字段断言。
- Rust config：增加首次导入空 active 与非空 active 保护断言。
- 新增配置夹具的首轮检查缺少必需 `transport` 字段，已补齐；未变更配置校验规则。
- `managed_probe_cleanup_kills_descendant_processes`：原夹具只等待 PID 文件存在，但 PowerShell `Set-Content` 仍持独占写句柄，暴露 Windows error 32；改为在原 30 秒窗口内等待读到完整可解析 PID，保留子进程退出断言与原退出预算。夹具进程隐藏窗口，避免验收期间弹窗。
- `FileViewHost.test.tsx`：全量首轮唯一失败是旧 `getByText` 断言与 CodeMirror 异步高亮拆 span 的竞态，定向复跑通过。改用已有 `waitForFileEditor` 等待内容加载，再断言 `contentDOM` 的可见文本，保留原文件内容及可编辑性验收；不改文件视图产品实现。

## 证据

- 原实例：`F:\A-I\Platform\Pylon\pylon.exe`，通过同目录 `tools/webview2-mcp/pylon-webview2-mcp.exe` 连接真实 WebView2。
- 原实例空配置：`list_agents` 返回 `[]`；Hermes ACP 握手成功（约 8.4 秒），保存报 `config_active_agent_protected: 候选配置删除了当前 active agent:`，再次 `list_agents` 仍是 `[]`。
- Claude 原始候选 `F:\A-I\Agent\bin\ccb`：进程启动失败，Win32 error 193；`ccb.cmd --acp` 可以启动，但实际 CLI 退出 1，stderr 为 `error: unknown option '--acp'`。
- `F:\Hermes\bin\hermes-acp.exe` 无参数：真实 `test_agent_candidate` 成功，7086 ms；此前版本探针超时被报为启动失败。
- 修复前生命周期回归：4 个新增前端用例全部失败；Windows launcher 回归在原逻辑下失败。
- 前端静态门禁：`bun run check:frontend:static`，exit 0（完整前端测试另用单 worker 执行，避免本机内存耗尽）。
- 完整前端首轮：664 文件，662 通过、1 跳过、1 失败；5180 用例通过、1 失败、1 跳过、1 todo，560.92 秒。唯一失败为上述文件视图旧断言。
- 定向复跑：Agent 相关四文件 + FileViewHost，共 5 文件 / 57 用例通过，exit 0，11.75 秒。
- Rust 完整门禁：终端环境 `CARGO_BUILD_JOBS=1 bun run check:rust`，exit 0；总计 1678 项通过、4 项原有忽略（fake-agent 单独 11 项 + workspace lib 1667 项），含核心探测 139 项、主 crate 966 项、ACP 186 项；构建、8 场景 ACP shadow parity 和格式检查通过。纯 pipe + `RUST_TEST_THREADS=1` 会改变既有控制台探针的 libtest 输出/句柄环境，终端下原测试通过，因此保留其源代码与断言。
- `CARGO_BUILD_JOBS=1 bun run check:clippy`，exit 0；6 crate 的 `added` 均为空；锁持有检查 17 文件 / 57 处登记，裸 allow 0 处，基线未修改。
- 最终 `bun run check:solid`、`bun run check:frontend:static` 均 exit 0；Solid 主题契约 176 个字段，CSS 消费审计死注入/悬空引用均 0。前端包含 lint、CSP、生成词表、IPC、CSS ownership/token、构建、bundle、Solid smoke、文档与边界检查；配合完整 Vitest 是 `check:frontend` 的同一子门禁集合，仅限制测试 worker 数以适配本机资源。
- 最后状态修正后的 Agent 专项：4 文件 / 54 用例通过，exit 0，7.12 秒。
- 最终完整前端：`vitest run --pool=threads --maxWorkers=2`，exit 0；664 文件中 663 通过、1 跳过，5184 用例通过、1 跳过、1 todo，193.77 秒。最后状态修正后重新执行 `check:frontend:static` 和 `check:solid`，均 exit 0。Rust 源码此后未变，前述 Rust 与 Clippy 证据仍对应最终源码。

### 最终实机证据

- 前端静态门禁重新构建 `dist/` → `CARGO_BUILD_JOBS=1 cargo build --manifest-path src-tauri/Cargo.toml --bin pylon`，exit 0，30.71 秒 → 独立便携目录启动。最终二进制 SHA-256：`cecb93cacd6290ac59bb1ad3415f61c6cd77f60f5f4e8419a5bfd2fd49dc2979`；PID 18308，调试端口 9223，WebView2 154；配置和数据均与用户安装隔离。
- MCP 自检：1 个可连接 page；`1+1=2`，Tauri invoke 类型为 function；初始宿主命令错误数 0；初始 `list_agents=[]`。`webview_snapshot` 定位操作，实际导入/取消/使用点击命中自身，`hitIsSelfOrDescendant=true`。
- 发现恰好 3 个提供方候选（Claude Code、Peri、Hermes），报告默认折叠。1200×800 视口下 document clientWidth/scrollWidth 均为 1200。操作按钮实测 minHeight/height=32px、边框 1px、主题背景非透明；选择后的入口与实际启动预览一致。
- Hermes 验证取消后等待 16 秒：`list_agents=[]`、sheetCount=0、反馈「已取消本次验证」，可立即重试。
- Peri 首次成功：ACP 65ms；110ms 内「使用此 Agent」可用，探测状态 false；注册表恰好 1 项，default=true、active=false、available=false、状态 stored，工作区 0。显式使用后 `agent_status` 为 connected、available=true、generation=1，active=peri，工作区恰好 1。
- Claude `ccb.cmd --acp`（879ms）与备用 `ccb-bun.cmd --acp`（971ms）均实际返回 `unknown option '--acp'`；就地显示握手失败，未写入配置，已连接 Peri 保持可用。
- 本轮 Hermes 启动进入自身「finishing an interrupted source update」路径，15 秒隔离验证超时；此前重建轮次已验证其成功握手及首次保存。最终轮按已有高置信豁免显式保存未验证配置：注册表恰好 2 项，默认项仍恰好 1，Hermes executable 为 `hermes-acp.exe`、args=[]、active=false、状态 stored；不伪造连接成功。随后显式连接失败，Peri 后端仍 connected/available=true，未新增 Hermes 工作区。
- 未捕获浏览器异常 0（扫描 10 条控制台记录）；这些记录包括预期的版本/第三方握手诊断，以及零 Agent 的最近会话诊断。后端 error 日志 1 条，为实测 Hermes 切换失败。没有把这些处理过的失败算作「全部零错误」。
- 一次过宽选择器误命中隐藏参数按钮，弃用该操作后按新快照 ref 重验 Claude 备用入口。末尾验收窗口被最小化到 144×19；该阶段点击/截图不计布局证据，宿主 unminimize 的权限拒绝也不计产品修复结论。最终已核实路径后关闭 PID 18308，用户安装实例未覆盖。

复验方法：从当前源码执行上述构建，使用独立零配置 `agents: {}`，设置 `PYLON_AGENTS_CONFIG`、独立 `WEBVIEW2_USER_DATA_FOLDER`、`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223 --remote-allow-origins=*` 启动；运行项目 MCP 的 `webview_targets` → 自检 → 设置页快照 → 验证/取消/导入/显式使用 → `list_agents` / `agent_status` 对账。现场请求和原始数值保留在隔离工作树 `.agents/spec/native-final-*.json` / `native-final-evidence.log`，构建与全量门禁日志保留在同目录；规格文档按约定不入库。

## 与 spec 的偏差

使用隔离 worktree 保持共享树安全。系统编译期间出现内存/页面文件不足，用户反馈聊天 harderror；改用单任务、低并发检查，用户关闭雷电模拟器释放资源。完整前端测试的 Windows fork worker 启动卡住，改用单线程池复跑同一测试范围，未删除或弱化测试。

Hermes 在早一轮已完成成功握手与零态保存；最后重新构建后，它自身进入中断源码更新恢复。最终 Peri 覆盖完整成功链路，Hermes 覆盖已有未验证保存政策及真实连接失败，不把此前成功或保存成功当作最终连接可用证明。

## 未解问题

本机 Claude 的两个入口均不支持其声明的 `--acp`；Hermes 在本轮进入自身中断更新恢复，最终未通过 ACP 连接；Codex 的 ACP 适配器未安装。这些安装/第三方能力限制不能由 Pylon 的保存成功替代，不修改既有 15 秒测试预算或 60 秒生产连接预算。本 PR 交付源码与独立 debug 验收产物，不覆盖用户发行实例，不宣称所有本机第三方 Agent 已修好。

## 并行交集

原共享树未暂存或提交；上述文件只在 `codex/agent-import` worktree 修改。`.agents/L.md` 范围声明已独立提交；合入后可移除。
