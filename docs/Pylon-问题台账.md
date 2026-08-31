# Pylon 问题台账

> 本台账是 [下一阶段问题清单](Pylon-下一阶段问题清单.md) 的状态明细。清单负责提出问题，台账负责记录状态、证据和下一步；状态变更只在这里落笔，再回写清单顶部的摘要表。

## 使用规则

1. 每条问题使用固定编号（P1–P20，允许小数子项如 P13.1），编号不因排序或拆分改变。
2. 状态只能使用下列词汇：`待调查`、`待施工书`、`待施工`、`施工中`、`待验收`、`首片完成`、`完成`、`阻塞`。
3. `首片完成`表示对应施工书的首片完成定义已满足；后续调参或扩展不回退该状态，除非发现回归。
4. 每次状态变化必须同时记录日期、证据路径/命令和下一步；没有证据不得标记为完成。
5. 进入施工前必须有独立施工书，并列出兼容性、性能预算和可观察性；未进入施工的问题不预设实现细节。

## 总览

| 编号 | 问题 | 当前状态 | 最近核验 | 证据 / 施工书 | 下一步 |
| --- | --- | --- | --- | --- | --- |
| [P1](#p1-流式输出节奏) | 流式输出节奏 | **首片完成** | 2026-08-31 | [流式渲染节奏施工书](Pylon-流式渲染节奏施工书.md)；`npm.cmd run check:solid` | 用真实 trace 校准速率参数 |
| [P2](#p2) | terminal-like 块间距统一 | **待验收** | 2026-08-31 | [terminal-like 块间距施工书](Pylon-terminal-like块间距施工书.md)；[spacing contract test](../src/domains/theme/__tests__/terminalLikeSpacingContract.test.ts)；`mountSolidWorkbench` 混排回归 | 在真实窗口完成一次最终视觉验收 |
| [P3](#p3-本机-acp-agent-运行时探测) | 本机 ACP Agent 运行时探测 | **首片完成** | 2026-08-31 | [本机 ACP Agent 运行时探测施工书](Pylon-本机ACP-Agent运行时探测施工书.md)；`cargo test --manifest-path src-tauri/pylon-core/Cargo.toml`；`npm.cmd run check:solid` | 真实运行时验收暂跳过 |
| [P4](#p4-连续同种工具调用聚合) | 连续同种工具调用聚合 | **首片完成** | 2026-08-31 | [连续同种工具调用聚合施工书](Pylon-连续同种工具调用聚合施工书.md)；`activityGrouping.ts`；`activityGrouping.test.ts`；`SolidWorkbenchApp.solid.tsx`；`WorkbenchChrome.css`；`npm.cmd run check:solid` | 真实窗口聚合观感验收暂跳过 |
| [P5](#p5-mcpskill插件设置管理) | MCP、Skill、插件设置管理 | **首片完成** | 2026-08-31 | [MCP、Skill、插件设置管理施工书](Pylon-MCP-Skill-插件设置管理施工书.md)；`CapabilityOption`；`buildCapabilityOptions`；`CwdSettingsPanel.tsx`；7 项相关测试；`npm.cmd run check:solid` | 真实 MCP/Skill/Hook 配置验收暂跳过 |
| [P6](#p6-全局设置页面重组) | 全局设置页面重组 | **首片完成** | 2026-08-31 | [全局设置页面重组施工书](Pylon-全局设置页面重组施工书.md)；设置域导航/标签/贡献搜索/注册表探针回归；`npm.cmd run check:solid` | 后续仅需在真实插件/渲染器包上运行探针并处理实际诊断 |
| [P7](#p7-agentsheet-空态与创建会话形态) | Agentsheet 空态与创建会话形态 | **首片完成** | 2026-08-31 | [Agentsheet 空态与创建会话形态施工书](Pylon-Agentsheet空态与创建会话形态施工书.md)；`mountSolidWorkbench.solid.test.tsx`；空态 CSS contract | 真实窗口验收暂跳过 |
| [P8](#p8-filesheet-语言插件与-git) | Filesheet 语言插件与 Git | **首片完成** | 2026-08-31 | [Filesheet 语言插件与 Git 施工书](Pylon-Filesheet语言插件与Git施工书.md)；`FileLanguageProvider`；`FileCodeEditor`；`FileWorkbenchRegistry`；19 项 Filesheet/Git 回归；`npm.cmd run check:solid` | 真实插件包 E2E 与大仓性能验收暂跳过 |
| [P9](#p9-输入内容预测) | 输入内容预测 | **首片完成** | 2026-08-31 | [输入内容预测施工书](Pylon-输入内容预测施工书.md)；双路径 router；独立 OpenAI-compatible provider；`inputPredictionSettings.test.ts`；`npm.cmd run check:solid` | 真实 endpoint 与窗口体验验证按验收阶段处理 |
| [P11](#p11-思考块折叠态与助手消息间距) | 思考块折叠态与助手消息间距 | **首片完成** | 2026-08-31 | `ChatView.css` terminal-like collapsed reasoning cadence；主题 contract | 暂跳过真实窗口验收 |
| [P12](#p12-filesheet-发送指令) | FileSheet 发送指令不可用 | **首片完成** | 2026-08-31 | `prompt.rs` camelCase IPC 注解；`DispatchBar` owner resolver；2 项 owner 测试；typed client 回归 | 实机 invoke 验收后置 |
| [P13](#p13-生成指示器时间与星芒停滞) | 生成指示器时间与星芒停滞 | **首片完成** | 2026-08-31 | `GenerationFooter.solid.tsx` 120ms repaint cap；高间隔配置测试 | 真实窗口检查 reduced-motion 体验 |
| [P13.1](#p131-生成指示器文案疯狂刷新) | 生成指示器文案疯狂刷新 | **首片完成** | 2026-08-31 | `generationIndicatorCopyMachine` 最短驻留保护；copy machine 回归 | 真实 trace 校准 waiting 阈值 |
| [P14](#p14-展开思考块自动滚动) | 展开思考块不自动滚动 | **首片完成** | 2026-08-31 | `ReasoningBlock` 内部 follow-bottom；展开态流式状态回归 | 真实窗口检查用户上滚后的跟随边界 |
| [P15](#p15-流式结束闪动) | 流式结束闪动 | **首片完成** | 2026-08-31 | `useScrollFollow` 流式更新改 auto scroll，避免 smooth 动画叠加 | 真实窗口检查终态切换观感 |
| [P16](#p16-hermes-terminal-类型与参数外漏) | Hermes terminal 类型/参数解析 | **首片完成** | 2026-08-31 | `toolResolution.ts`；`toolPresentation.test.ts` Hermes terminal/嵌入参数覆盖 | 用真实 Hermes trace 复核未登记工具的 provider overlay |
| [P17](#p17-hermes-skill-view-与工具指示器尺寸) | Hermes skill view 渲染与工具指示器尺寸 | **首片完成** | 2026-08-31 | [Hermes 工具解析与空态创建施工书](Pylon-Hermes工具解析与空态创建施工书.md)；`hermesNormalizer.test.ts`；`ChatView.css` | 真实 Hermes 窗口复核 skill 卡与预览像素一致性 |
| [P18](#p18-hermes-search-归一化) | Hermes search 解析为 unknown | **首片完成** | 2026-08-31 | Hermes title-only wire sample；`searchLinkClassification.test.ts`；agent catalog aliases | 真实 search_files/session_search trace 复核结果卡 |
| [P19](#p19-空态创建会话乐观渲染) | 空态创建会话采用乐观渲染 | **首片完成** | 2026-08-31 | `SolidWorkbenchApp.solid.tsx` optimistic projection；mount 空态创建/失败回归 | 真实窗口复核创建延迟与切换无闪动 |
| [P20](#p20-生成指示器次级文案与文案闪动) | 生成指示器次级文案过长、文案集合闪动 | **首片完成** | 2026-08-31 | `generationStateMachine.ts` 工具类型集合归一；`activityLine.ts` 参数剥离；`ChatView.css` 指示器字体契约；activity/Footer 回归 | 真实流式 trace 复核工具集合切换观感 |

## 核验记录

<a id="p1"></a>
### P1 · 流式输出节奏

**结论：首片完成。** 施工书的 Slice A/B 已落地：

- `src/renderers/solid-workbench/streamingDisplayScheduler.ts` 提供 latest-wins、Unicode grapheme 增量、更新速率上限、终态 flush、暂停/恢复和销毁清理。
- `src/renderers/solid-workbench/mountSolidWorkbench.solid.tsx` 只在 Solid 消费边界接入调度器；runtime/canonical 仍接收完整快照。
- `npm.cmd run check:solid` 已通过：Solid 边界、Workbench 皮肤 contract、product contribution boundary、A17 渲染器架构门禁均通过。
- 全量 `npm.cmd test -- --run --pool=forks --maxWorkers=2` 已复核通过：430 个文件、2653 项测试；legacy runner 4/4 通过。

<a id="p2"></a>
### P2 · terminal-like 块间距统一

调查已完成并建立了独立的 [terminal-like 块间距施工书](Pylon-terminal-like块间距施工书.md)。terminal-like 骨架现在提供唯一的 cadence token set，并清除 bubble/Claude 预设遗留的 row 外边距，避免跨预设叠加空白；[spacing contract test](../src/domains/theme/__tests__/terminalLikeSpacingContract.test.ts) 已覆盖 5 项（含四个非 GUI 预设归类和唯一间距来源），`mountSolidWorkbench` 混排/流式回归通过，当前进入 `待验收`。

核验记录（2026-08-31）：

- 状态：`待验收`
- 证据：`npm.cmd test -- --run src/domains/theme/__tests__/terminalLikeSpacingContract.test.ts src/plugins/core/renderer/__tests__/builtinPresentationProfiles.test.ts src/renderers/solid-workbench/__tests__/mountSolidWorkbench.solid.test.tsx --pool=forks --maxWorkers=2`（77 项通过）；全量 `npm.cmd test -- --run --pool=forks --maxWorkers=2`（430 文件、2653 项通过）；`npm.cmd run check:solid`。
- 结论：四个非 GUI 内置预设均解析为 terminal-like；不同块类型继续使用独立 token，预设外边距不再叠加；Solid 混排与流式/完成态回归通过。尚未在真实窗口读取最终像素边界。
- 下一步：在真实窗口完成一次 terminal-classic、terminal-modern 和自定义行高的最终视觉验收。

<a id="p3"></a>
### P3 · 本机 ACP Agent 运行时探测

已完成三段能力证据盘点并建立独立的 [本机 ACP Agent 运行时探测施工书](Pylon-本机ACP-Agent运行时探测施工书.md)。共享 catalog、受控发现和版本探针分别提供发现/可启动证据；`test_agent_candidate` 与 `test_agent_connection` 通过 `AcpClient::connect_with_generation` 提供隔离 ACP 握手证据。Slice A/B/C 已完成，真实运行时验收按用户指示后置。

核验记录（2026-08-31）：

- 状态：`首片完成`
- 证据：`cargo test --manifest-path src-tauri/pylon-core/Cargo.toml -- --nocapture`（16 项通过）；`src-tauri/pylon-core/src/agent_detection.rs`、`src-tauri/src/lifecycle/connection_test.rs`、`src-tauri/src/acp/mod.rs`。
- 结论：发现、可启动、ACP 握手已有分离入口和预算；Windows 子孙清理测试原断言为误报，已改为读取退出码后通过；候选 DTO 已增加独立 `startability` 字段并在设置页显示。
- 下一步：真实 ACP Agent 运行时验收暂按用户指示跳过。

<a id="p4"></a>
### P4 · 连续同种工具调用聚合

已完成现状盘点并建立 [连续同种工具调用聚合施工书](Pylon-连续同种工具调用聚合施工书.md)。activity 事实仍以 `toolCallId` 独立保留，组级派生视图已按 `selectActivityDisplayOrder` 后的消息锚点 segment、normalized tool key 和 parent 边界实现。

核验记录（2026-08-31）：

- 状态：`首片完成`
- 证据：`workbenchProjector.ts` 的 `reduceTool` / `selectActivityDisplayOrder` / `toolInvocationSnapshot`；`SolidWorkbenchApp.solid.tsx` 的 `CanonicalActivityList`；`SolidToolInvocationCard` 单次折叠 presenter；activity/tool projection 回归测试。
- 结论：未发现应删除的过时测试；现有测试锁定 identity、终态幂等、父子关系和三路径 parity，不能用“数组相邻”替代展示序列。
- 下一步：真实窗口聚合观感验收暂按用户指示跳过。

<a id="p5"></a>
### P5 · MCP、Skill、插件设置管理

已完成 schema、存储和权限边界盘点并建立 [MCP、Skill、插件设置管理施工书](Pylon-MCP-Skill-插件设置管理施工书.md)。结论：MCP 是 Agent 级事实、Workspace 只存选择引用；Skill/Hook 保留字符串快照并通过统一能力选项 DTO 展示；插件包和私有设置已有 API 1.0、PluginScope 与 64 KiB 命名空间隔离。

核验记录（2026-08-31）：

- 状态：`首片完成`
- 证据：`src-tauri/src/mcp.rs`（transport/数量/敏感字段校验）；`src-tauri/src/lifecycle/mcp.rs`（写序锁与原子持久化）；`src/components/settings/CwdSettingsPanel.tsx`（逗号输入与 MCP 勾选）；`src/workspaceEntities.ts`（Workspace 数组字段）；`src/plugin-runtime/packageManifest.ts`、`PackageInstallationService`、`PluginScope`、`PluginSettingsStore`。
- 结论：未发现应删除的过时测试；现有 MCP 持久化、schema、插件生命周期和 namespace 安全测试仍覆盖真实边界。逗号输入保留为兼容回退，结构化标签和悬挂引用诊断已落地；Skill registry/凭据引用属于后续 API 1.1 范围。
- 下一步：真实 MCP/Skill/Hook 配置验收暂按用户指示跳过。

<a id="p6"></a>
### P6 · 全局设置页面重组

**结论：首片完成。** Slice A 已建立设置意图归一化边界：

- `normalizeSettingsIntent` 以 `settingsDomains` 为唯一 canonical registry，校正 section 所属 domain；
- 兼容 `renderer/suite`、`renderer/catalog` 及常见旧 section 别名，不把导航兼容逻辑混入主题持久化迁移；
- 未知普通入口回退到“外观 › 全局”，插件贡献页保留 `pluginPageId` 并挂载到“插件 › 插件管理”；
- 内部 Renderer Suite 入口已改发 canonical `appearance/renderers` 事件。

核验记录（2026-08-31）：

- 状态：`首片完成`
- 证据：`src/settingsDomains.ts`；`src/components/Settings.tsx`；`src/sheets/agent-workbench/AgentRendererSuiteWorkbench.tsx`；`src/__tests__/settingsDomains.test.ts`；`src/__tests__/settingsDomainNav.test.tsx`。
- 命令：`npm.cmd test -- --run src/__tests__/settingsDomains.test.ts src/__tests__/settingsDomainNav.test.tsx --pool=forks --maxWorkers=2`（26 项通过）；`npm.cmd run check:solid`。
- Slice B 已完成：重复的是跨作用域标签，已改为带作用域的 canonical label，并增加可见字段标签唯一性守卫；未改变持久化 key。
- Slice C 已完成：插件设置页注册表投影到全局速搜，选择项保留 `pluginPageId` 并直达贡献页；opaque 页面不伪造字段级锚点。
- Slice D 已完成：`probeSettingsRegistries` 对带 settings schema 的 renderer suite/slot/kind 及 plugin settings page 做 canonical catalog/search 索引完整性、重复贡献和空标识探针；失效入口仍统一经 `normalizeSettingsIntent` 回退，不再保留新的直达旧路由。
- 核验：`rendererSettingsCatalog.test.ts` 覆盖未知 placement 回退及 renderer/plugin 注册表探针；`npm.cmd exec vitest run src/components/settings/__tests__/rendererSettingsCatalog.test.ts --pool=forks --maxWorkers=2`（2 项通过）；`npm.cmd run check:solid`。
- 下一步：在真实插件/渲染器包加载后运行探针，按实际诊断清理遗留入口。

<a id="p7"></a>
### P7 · Agentsheet 空态与创建会话形态

**结论：首片完成。** 现有空态已满足创建命令和失败恢复边界：工作区模式阻止无工作区提交，单/多工作区预选稳定，创建中冻结输入，失败保留草稿并恢复焦点；terminal-like 预设提供无圆角、无阴影样式。

核验记录（2026-08-31）：

- 状态：`首片完成`
- 证据：[Agentsheet 空态与创建会话形态施工书](Pylon-Agentsheet空态与创建会话形态施工书.md)；`src/renderers/solid-workbench/__tests__/mountSolidWorkbench.solid.test.tsx`；`WorkbenchChrome.css`。
- 未确认：真实窗口中不同终端预设的最终像素宽高与视觉密度（按用户指示暂不验收）。
- 下一步：转入 P8，盘点 Filesheet 语言插件和 Git facade seam。

<a id="p8"></a>
### P8 · Filesheet 语言插件与 Git

**结论：首片完成。** Git provider/facade 已具备可插拔边界和迟到响应保护；language-provider Slice A 已落地，插件可以按路径贡献异步 CodeMirror `LanguageSupport`，加载失败/取消回退内置语言或纯文本。

核验记录（2026-08-31）：

- 状态：`首片完成`
- 证据：[Filesheet 语言插件与 Git 施工书](Pylon-Filesheet语言插件与Git施工书.md)；`src/plugin-runtime/file-workbench/fileWorkbenchTypes.ts`；`src/plugin-runtime/file-workbench/fileWorkbenchResolver.ts`；`src/sheets/file/FileCodeEditor.tsx`；`src/plugin-runtime/file-workbench/__tests__/fileWorkbenchRegistry.test.ts`。
- 命令：`npm.cmd test -- --run src/plugin-runtime/file-workbench/__tests__ src/sheets/file/__tests__/gitPanelAcceptance.test.tsx src/sheets/file/__tests__/gitPanelMutations.test.tsx src/sheets/file/__tests__/FileCodeEditor.test.tsx --pool=forks --maxWorkers=2`（4 个文件、19 项通过）；`npm.cmd run check:solid`。
- 未确认：真实插件包提供补全/格式化的端到端体验、不同大仓扫描性能（按用户指示暂不验收）。
- 下一步：暂留在 P8 的真实窗口验收；用户要求后再转入 P9，定义输入内容预测状态机。

<a id="p9"></a>
### P9 · 输入内容预测

**结论：首片完成。** Slice A 已落地：

- `inputPredictionState.ts` 提供历史合并、前缀匹配和 Claude-like 15 秒 LLM 请求冷却器。
- `InputBar.solid.tsx` 将 SQLite canonical 用户消息投影与 session-local history 合并，显示灰色 ghost 后缀；Tab/右箭头接受、Esc 忽略，接受不写 `input-history`。
- 空草稿沿用 `assist.prediction.placeholder`，生成中、附件和 slash 命令建议时隐藏；空 Enter 可接受并发送。

核验记录（2026-08-31）：

- 状态：`首片完成`
- 证据：`src/renderers/solid-workbench/input/inputPredictionState.ts`；`InputBar.solid.tsx`；`InputBar.solid.test.tsx`；`inputPredictionState.test.ts`
- 命令：`npm.cmd exec vitest run src/renderers/solid-workbench/input/__tests__/InputBar.solid.test.tsx src/renderers/solid-workbench/input/__tests__/inputPredictionState.test.ts`（28 项通过）；`npm.cmd run check:solid`
- 未确认：真实模型 provider 的端到端请求/取消和生产 SQLite 大库性能；按当前工作节奏留到 Slice C 验证。
- Slice B 已完成：`inputPredictionProvider.ts` 提供可选 provider、400ms 防抖、15 秒冷却、AbortController、输出过滤和 session/generation 迟到结果丢弃；provider 失败回退本地历史。
- Slice C 首片已完成：新增 `createHttpPredictionProvider`，支持本地 sidecar 或远端 HTTP endpoint，统一解析 `suggestion`/`prediction`/`text` 响应；请求上下文按 24 条、6000 字符上限裁剪，避免 SQLite 大库放大网络负载；provider 已从 `WorkbenchHostPort`/`SolidWorkbenchServices` 传递到 `SolidInputBar`。当前 ACP facade 尚无独立预测 RPC，因此没有伪造 `assist.prediction` 事件作为 provider 请求。
- Slice D 已完成：新增独立预测设置（Base URL、API Key、模型、endpoint、推理等级、采样/惩罚/seed/stop、上下文上限、超时、自定义 headers）及设置页；`createPredictionRouter` 提供自动、仅 ACP Fork、仅独立模型、关闭四种路径，独立 provider 不依赖 ACP session；canonical 用户+助手消息按条数/字符上限送入模型，API key 不进入 ACP 或 renderer wire。
- 核验：`inputPredictionProvider.test.ts`、`inputPredictionSettings.test.ts` 覆盖历史/消息裁剪、OpenAI 请求体与响应解析、模式路由和异常边界；`settingsDomains.test.ts` 覆盖输入预测设置入口；`npm.cmd run check:solid` 通过。真实 endpoint 与窗口体验验证按验收阶段处理。

<a id="p11"></a>
### P11 · 思考块折叠态与助手消息间距

终端样式下折叠思考块只保留标题行，清除其内部垂直 padding，助手行间距继续由统一 `chat-row-gap` 提供，避免 padding 与 row cadence 叠加。真实窗口验收后置。

<a id="p12"></a>
### P12 · FileSheet 发送指令

代码核验确认 Tauri command 已显式声明 `rename_all = "camelCase"`，前端 `agentId/profileId/sessionPrompt` 命名与 IPC 契约一致；实测不可用的可复现缺口是同一 source 多会话时 `DispatchBar` 仅按 source 匹配并拒绝发送。现已传递 `targetSessionId`，按绑定会话精确解析 owner，source-only 歧义仍安全拒绝。

<a id="p13"></a>
### P13 · 生成指示器时间与星芒停滞

`GenerationFooter` 将重绘 tick 上限固定为 120ms，`spinnerIntervalMs` 只控制帧相位速度，不再把时间更新降到 1fps；reduced-motion 仍按设计固定静态帧。

<a id="p131"></a>
### P13.1 · 生成指示器文案疯狂刷新

文案状态机在 waiting/stalled 抢占时也遵守最短驻留时间，避免 liveness 在阈值附近震荡导致主文案疯狂切换；tool 名称集合签名改为排序后比较，消除顺序抖动。

<a id="p14"></a>
### P14 · 展开思考块自动滚动

展开且仍在流式生成时，`ReasoningBlock` 内部滚动容器自动跟随底部；用户上滚超过 24px 后暂停跟随，回到底部后恢复。

<a id="p15"></a>
### P15 · 流式结束闪动

聊天外层滚动跟随在 token/终态更新时改用 `behavior: auto`，保留用户主动回底按钮的 smooth 行为，避免每个流式 tick 叠加平滑动画。

<a id="p16"></a>
### P16 · Hermes terminal 类型与参数外漏

Hermes ACP 的 `terminal: command`、`execute_code: code` 标题与 `args`/`arguments`/`preview` 参数已在 provider adapter seam 统一收窄为机器工具名、展示标题和结构化输入；原始 wire 仍保留在 envelope raw 供审计。工具卡按机器名查询 provider 字典，因此 terminal/execute_code 的类型与摘要不会再外漏到工具名。另修正 `splitToolTitle`：冒号优先于参数括号，`print(1)`、`echo (hi)` 不会被误切。

证据：`hermesNormalizer.test.ts` 与 `ToolInvocationCard.solid.test.tsx` 覆盖 terminal、execute_code、process 及 preview 参数；工具/归一化/Workbench 定向回归 80 项通过，`npm.cmd run check:solid` 通过，`git diff --check` 通过。

状态：首片完成。后续仅需用真实 Hermes trace 复核未登记工具的 provider overlay，不再改变已稳定的 terminal/execute 解析路径。

<a id="p17"></a>
### P17 · Hermes skill view 与工具指示器尺寸

Hermes ACP start 更新只提供人类标题，不提供机器工具名；normalizer 现在将 `skill view (...)` 归一为 `skill_view`，并从标题恢复 skill/file 输入。ACP 工具内容 wrapper 会在语义边界解包为 text/markdown 可渲染 part。工具指示器显式继承聊天 rail 的字号和行高，使实际卡片与设置预览共享尺寸契约。

证据：`hermesNormalizer.test.ts` title-only、content wrapper、snake_case、completion identity 回归；`ChatView.css` `.solid-tool-invocation .term-tool-indicator`。

状态：首片完成。真实窗口像素验收后置。

<a id="p18"></a>
### P18 · Hermes search 归一化

`search: ...` 标题现在恢复为 Hermes `search_files`，`session search: ...` 保留 `session_search`；工具字典增加常见 human/qualified aliases。搜索结果归一化兼容 Hermes 的 `matches/files + path/line/content` 字段，映射为 provider-neutral `search-result`。

证据：Hermes `build_tool_start/build_tool_complete` 实际构造样本；`searchLinkClassification.test.ts`；`shared/agent-catalog.json`。

状态：首片完成。真实 Hermes search trace 复核后再调参。

<a id="p19"></a>
### P19 · 空态创建会话乐观渲染

首条请求提交时先显示本地乐观用户消息和“正在创建会话…”状态，RPC 返回前保留原表单冻结语义；创建失败撤销乐观投影、保留草稿并恢复输入焦点。乐观投影不进入 canonical transcript 或持久化。

证据：`SolidWorkbenchApp.solid.tsx`；`mountSolidWorkbench.solid.test.tsx` 创建中/失败恢复回归。

状态：首片完成。真实窗口复核长延迟和切换观感后置。

<a id="p20"></a>
### P20 · 生成指示器次级文案与文案闪动

工具运行时，生成指示器次级文案现在只显示正在运行的工具类型；`terminal: git status`、`search: pattern` 等参数不会进入文案。并行工具按排序后的去重类型集合生成标签，工具事件顺序和流式参数更新不再造成无意义的次级文案跳变。

同时，工具活动状态机在入口处剥离标题参数，React/Solid 两条 Footer 路径共享同一归一规则；terminal-like 聊天中的工具指示器改用聊天 rail 字体和字号，避免 mono 字体字形导致圆点比设置预览偏小。

证据：`generationStateMachine.test.ts`、`GenerationFooter.solid.test.tsx`、`chatIndicatorAlignment.test.ts`；`npm.cmd run check:solid`。

状态：首片完成。真实流式 trace 与窗口像素验收后置。

## 状态变更模板

```text
日期：YYYY-MM-DD
问题：P<n>
状态：<状态词>
证据：<文件、测试命令或可复现 trace>
结论：<本次确认了什么，未确认什么>
下一步：<一个可执行动作>
```
