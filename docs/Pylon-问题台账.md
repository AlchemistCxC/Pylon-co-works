# Pylon 问题台账

> 本台账是 [下一阶段问题清单](Pylon-下一阶段问题清单.md) 的状态明细。清单负责提出问题，台账负责记录状态、证据和下一步；状态变更只在这里落笔，再回写清单顶部的摘要表。

## 使用规则

1. 每条问题使用固定编号（P1–P9），编号不因排序或拆分改变。
2. 状态只能使用下列词汇：`待调查`、`待施工书`、`待施工`、`施工中`、`待验收`、`首片完成`、`完成`、`阻塞`。
3. `首片完成`表示对应施工书的首片完成定义已满足；后续调参或扩展不回退该状态，除非发现回归。
4. 每次状态变化必须同时记录日期、证据路径/命令和下一步；没有证据不得标记为完成。
5. 进入施工前必须有独立施工书，并列出兼容性、性能预算和可观察性；未进入施工的问题不预设实现细节。

## 总览

| 编号 | 问题 | 当前状态 | 最近核验 | 证据 / 施工书 | 下一步 |
| --- | --- | --- | --- | --- | --- |
| [P1](#p1-流式输出节奏) | 流式输出节奏 | **首片完成** | 2026-08-31 | [流式渲染节奏施工书](Pylon-流式渲染节奏施工书.md)；`npm.cmd run check:solid` | 用真实 trace 校准速率参数 |
| [P2](#p2) | terminal-like 块间距统一 | **待验收** | 2026-08-31 | [terminal-like 块间距施工书](Pylon-terminal-like块间距施工书.md)；[spacing contract test](../src/domains/theme/__tests__/terminalLikeSpacingContract.test.ts)；`mountSolidWorkbench` 混排回归 | 在真实窗口完成一次最终视觉验收 |
| [P3](#p3-本机-acp-agent-运行时探测) | 本机 ACP Agent 运行时探测 | **施工中** | 2026-08-31 | [本机 ACP Agent 运行时探测施工书](Pylon-本机ACP-Agent运行时探测施工书.md)；`cargo test --manifest-path src-tauri/pylon-core/Cargo.toml`；`npm.cmd run check:solid` | 进入验收（用户要求暂跳过），转查 P4 |
| [P4](#p4-连续同种工具调用聚合) | 连续同种工具调用聚合 | **施工中** | 2026-08-31 | [连续同种工具调用聚合施工书](Pylon-连续同种工具调用聚合施工书.md)；`activityGrouping.ts`；`activityGrouping.test.ts`；`SolidWorkbenchApp.solid.tsx`；`WorkbenchChrome.css`；`npm.cmd run check:solid` | 验收暂跳过；转入 P5 schema、存储和权限边界盘点 |
| [P5](#p5-mcpskill插件设置管理) | MCP、Skill、插件设置管理 | **施工中** | 2026-08-31 | [MCP、Skill、插件设置管理施工书](Pylon-MCP-Skill-插件设置管理施工书.md)；`CapabilityOption`；`buildCapabilityOptions`；`CwdSettingsPanel.tsx`；7 项相关测试；`npm.cmd run check:solid` | 验收暂跳过；转入 P6 设置注册表与旧键迁移盘点 |
| [P6](#p6-全局设置页面重组) | 全局设置页面重组 | **首片完成** | 2026-08-31 | [全局设置页面重组施工书](Pylon-全局设置页面重组施工书.md)；设置域导航/标签/贡献搜索回归；`npm.cmd run check:solid` | 进入 Slice D：失效入口清理与注册表完整性探针 |
| [P7](#p7-agentsheet-空态与创建会话形态) | Agentsheet 空态与创建会话形态 | **首片完成** | 2026-08-31 | [Agentsheet 空态与创建会话形态施工书](Pylon-Agentsheet空态与创建会话形态施工书.md)；`mountSolidWorkbench.solid.test.tsx`；空态 CSS contract | 暂跳过真实窗口验收；转查 P8 Filesheet 语言插件与 Git |
| [P8](#p8-filesheet-语言插件与-git) | Filesheet 语言插件与 Git | **待调查** | — | [问题清单第 8 项](Pylon-下一阶段问题清单.md#8-filesheet-语言插件与-git) | 盘点语言插件和 Git facade seam |
| [P9](#p9-输入内容预测) | 输入内容预测 | **待调查** | — | [问题清单第 9 项](Pylon-下一阶段问题清单.md#9-输入内容预测) | 定义预测状态机和隐私策略 |

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

已完成三段能力证据盘点并建立独立的 [本机 ACP Agent 运行时探测施工书](Pylon-本机ACP-Agent运行时探测施工书.md)。共享 catalog、受控发现和版本探针分别提供发现/可启动证据；`test_agent_candidate` 与 `test_agent_connection` 通过 `AcpClient::connect_with_generation` 提供隔离 ACP 握手证据。Slice A/B/C 已完成，当前按用户指示跳过验收并转入 P4。

核验记录（2026-08-31）：

- 状态：`施工中`
- 证据：`cargo test --manifest-path src-tauri/pylon-core/Cargo.toml -- --nocapture`（16 项通过）；`src-tauri/pylon-core/src/agent_detection.rs`、`src-tauri/src/lifecycle/connection_test.rs`、`src-tauri/src/acp/mod.rs`。
- 结论：发现、可启动、ACP 握手已有分离入口和预算；Windows 子孙清理测试原断言为误报，已改为读取退出码后通过；候选 DTO 已增加独立 `startability` 字段并在设置页显示。
- 下一步：P3 验收暂按用户指示跳过，转入 P4 activity projection 分组边界盘点。

<a id="p4"></a>
### P4 · 连续同种工具调用聚合

已完成现状盘点并建立 [连续同种工具调用聚合施工书](Pylon-连续同种工具调用聚合施工书.md)。结论：当前 activity 以 `toolCallId` 独立保留，尚无组级派生视图；连续性应按 `selectActivityDisplayOrder` 后的消息锚点 segment、normalized tool key 和 parent 边界判定。

核验记录（2026-08-31）：

- 状态：`施工中`
- 证据：`workbenchProjector.ts` 的 `reduceTool` / `selectActivityDisplayOrder` / `toolInvocationSnapshot`；`SolidWorkbenchApp.solid.tsx` 的 `CanonicalActivityList`；`SolidToolInvocationCard` 单次折叠 presenter；activity/tool projection 回归测试。
- 结论：未发现应删除的过时测试；现有测试锁定 identity、终态幂等、父子关系和三路径 parity，不能用“数组相邻”替代展示序列。
- 下一步：P4 验收暂按用户指示跳过，转入 P5 schema、存储和权限边界盘点。

<a id="p5"></a>
### P5 · MCP、Skill、插件设置管理

已完成 schema、存储和权限边界盘点并建立 [MCP、Skill、插件设置管理施工书](Pylon-MCP-Skill-插件设置管理施工书.md)。结论：MCP 是 Agent 级事实、Workspace 只存选择引用；Skill/Hook 目前是字符串快照；插件包和私有设置已有 API 1.0、PluginScope 与 64 KiB 命名空间隔离，但缺少统一能力选项 DTO。

核验记录（2026-08-31）：

- 状态：`施工中`
- 证据：`src-tauri/src/mcp.rs`（transport/数量/敏感字段校验）；`src-tauri/src/lifecycle/mcp.rs`（写序锁与原子持久化）；`src/components/settings/CwdSettingsPanel.tsx`（逗号输入与 MCP 勾选）；`src/workspaceEntities.ts`（Workspace 数组字段）；`src/plugin-runtime/packageManifest.ts`、`PackageInstallationService`、`PluginScope`、`PluginSettingsStore`。
- 结论：未发现应删除的过时测试；现有 MCP 持久化、schema、插件生命周期和 namespace 安全测试仍覆盖真实边界。当前体验缺口集中在逗号文本、悬挂引用不可见和 Skill 无 registry。
- 下一步：P5 验收暂按用户指示跳过，转入 P6 设置注册表与旧键迁移盘点，保持旧存储字段和新会话快照语义。

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
- 未确认：renderer/plugin 贡献是否需要更细的统一注册表完整性探针、旧设置字段的进一步清理。
- 下一步：按施工书 Slice D 清理失效入口并补齐注册表完整性探针。

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

当前未完成语言插件和 Git facade seam 盘点，保持 `待调查`。

<a id="p9"></a>
### P9 · 输入内容预测

当前未定义预测状态机、键盘交互和隐私策略，保持 `待调查`。

## 状态变更模板

```text
日期：YYYY-MM-DD
问题：P<n>
状态：<状态词>
证据：<文件、测试命令或可复现 trace>
结论：<本次确认了什么，未确认什么>
下一步：<一个可执行动作>
```
