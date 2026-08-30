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
| [P2](#p2) | terminal-like 块间距统一 | **施工中** | 2026-08-31 | [terminal-like 块间距施工书](Pylon-terminal-like块间距施工书.md)；[spacing contract test](../src/domains/theme/__tests__/terminalLikeSpacingContract.test.ts) | 完成混排几何验收并补回归证据 |
| [P3](#p3-本机-acp-agent-运行时探测) | 本机 ACP Agent 运行时探测 | **待调查** | — | [问题清单第 3 项](Pylon-下一阶段问题清单.md#3-本机-acp-agent-运行时探测) | 盘点发现、启动、握手证据 |
| [P4](#p4-连续同种工具调用聚合) | 连续同种工具调用聚合 | **待调查** | — | [问题清单第 4 项](Pylon-下一阶段问题清单.md#4-连续同种工具调用聚合) | 确认 activity projection 分组边界 |
| [P5](#p5-mcpskill插件设置管理) | MCP、Skill、插件设置管理 | **待调查** | — | [问题清单第 5 项](Pylon-下一阶段问题清单.md#5-mcpskill插件设置管理) | 盘点 schema、存储和权限边界 |
| [P6](#p6-全局设置页面重组) | 全局设置页面重组 | **待调查** | — | [问题清单第 6 项](Pylon-下一阶段问题清单.md#6-全局设置页面重组) | 盘点注册表、旧键迁移和搜索索引 |
| [P7](#p7-agentsheet-空态与创建会话形态) | Agentsheet 空态与创建会话形态 | **待调查** | — | [问题清单第 7 项](Pylon-下一阶段问题清单.md#7-agentsheet-空态与创建会话形态) | 确认空态创建命令边界 |
| [P8](#p8-filesheet-语言插件与-git) | Filesheet 语言插件与 Git | **待调查** | — | [问题清单第 8 项](Pylon-下一阶段问题清单.md#8-filesheet-语言插件与-git) | 盘点语言插件和 Git facade seam |
| [P9](#p9-输入内容预测) | 输入内容预测 | **待调查** | — | [问题清单第 9 项](Pylon-下一阶段问题清单.md#9-输入内容预测) | 定义预测状态机和隐私策略 |

## 核验记录

<a id="p1"></a>
### P1 · 流式输出节奏

**结论：首片完成。** 施工书的 Slice A/B 已落地：

- `src/renderers/solid-workbench/streamingDisplayScheduler.ts` 提供 latest-wins、Unicode grapheme 增量、更新速率上限、终态 flush、暂停/恢复和销毁清理。
- `src/renderers/solid-workbench/mountSolidWorkbench.solid.tsx` 只在 Solid 消费边界接入调度器；runtime/canonical 仍接收完整快照。
- `npm.cmd run check:solid` 已通过：Solid 边界、Workbench 皮肤 contract、product contribution boundary、A17 渲染器架构门禁均通过。

全量 `npm.cmd test` 在当前工作树仍有 34 项失败（含 identity hydration、设置导航、空态创建和 legacy runner 等），因此这里仅依据施工书规定的 Solid/架构门禁确认首片，不把全量测试误记为通过；后续提交应单独处理这些回归。

<a id="p2"></a>
### P2 · terminal-like 块间距统一

调查已完成并建立了独立的 [terminal-like 块间距施工书](Pylon-terminal-like块间距施工书.md)。现有 terminal-like CSS 已提供唯一 cadence token seam，并新增 [spacing contract test](../src/domains/theme/__tests__/terminalLikeSpacingContract.test.ts)（3 项通过）；尚未完成混排 DOM 几何验收，当前为 `施工中`。

<a id="p3"></a>
### P3 · 本机 ACP Agent 运行时探测

当前未建立本台账要求的三段能力证据，保持 `待调查`。

<a id="p4"></a>
### P4 · 连续同种工具调用聚合

当前未建立 activity projection 的分组和展开持久化证据，保持 `待调查`。

<a id="p5"></a>
### P5 · MCP、Skill、插件设置管理

当前未完成 schema、存储和权限边界盘点，保持 `待调查`。

<a id="p6"></a>
### P6 · 全局设置页面重组

当前未完成注册表、旧键迁移和搜索索引盘点，保持 `待调查`。

<a id="p7"></a>
### P7 · Agentsheet 空态与创建会话形态

当前未完成命令边界和创建行为核验，保持 `待调查`。

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
