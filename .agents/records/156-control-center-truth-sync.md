# Dev Record — #156 中控三控件修复与「值来源」同步

> 入库保留。施工单（00–06）不保留在本仓库，其在用户工作区；本记录承接目标、范围、方案与验收结论。
> 产出路径：`.agents/records/156-control-center-truth-sync.md`

## 元信息

- issue：[#156](https://github.com/AlchemistCxC/Pylon-co-works/issues/156)（中控三控件现象单）
- 分支：`feat/preset-v2`
- 提交范围：基线 `e6f68c1b`（刀2）；本批包含 15 个改动文件 + 3 条新增用例
- 日期：2026-09-18

## 目标与范围

**要达成什么**——把中控三个控件（模型选择 / 权限档位 / 思考强度）从"点了没反应、静默降级、菜单空盒"修到"点选有效、候选面来自 agent、两处显示一致"。

**做了什么**（按施工单编号，施工单在用户工作区 `E:\Acode\FILES\任务\工作台优化\`）：

| 单 | 内容 |
|---|---|
| 00 | 中控三连修：权限候选词汇（`accept_edits`/`dont_ask`，撤销 v1 的窄表）、用量 pill 回退、闸门补 `setConfigOption`、模型/权限菜单空态占位、**切换成功后显示跟随**（B10：本地已确认写入落成 canonical fact） |
| 02 | 用量 pill 对齐：删掉三个控件上的 `margin-top: height()/2`（"当前值冒充候选面"之外的另一个半高把戏） |
| 03 | 权限菜单虚空：`optionIds` 会把当前值插进候选列表 ⇒ 只有当前值时**不再**丢弃兜底表（`advertisedChoices`） |
| 05 | peri 实测暴露的两条：模型切换镜像改走 canonical fact（**F1/F2**，原先用"只带一项的合成响应"会整体替换 `session.options`，连带清空 mode/思考强度两类候选面）；思考强度控件删掉硬编码键名，改用 catalog 的 `isReasoningOption`（**F3**）；`session.config-updated` 空列表不覆盖（**F4**） |
| 06 | 中控读 `session.mode/model`、配置面板读 `options[].value`，两处各写各的 ⇒ **S1** 本地写入同时写对应 option 值、**S2** agent 的 `config_option_update` 同时产 `session.mode-updated`/`session.model-updated`；并修掉"同一 journal 行的多条事件共用一个行级 `coverage`、被投影器按跨度整条丢弃"的**重放丢事件**（早于本批就存在的潜伏 bug，`session_info_update` 一行三 fact 同样中招） |

**不做什么**——不改 `optionIds` 的快照契约；不给模型补本地兜底名单；不动 canonical 事件种类；不动禁区（`src/ui-demo/`、`src/layout-sketch/`、`docs/前端接口地图.md`）。

## 改动清单

| 文件 | 性质 |
| --- | --- |
| `src/components/chat/sessionModeState.ts` | 接受集纳入 `accept_edits`/`dont_ask`，拆出 `MODE_CYCLE` |
| `src/host/renderer-suite/rendererSuiteCommandGate.ts`（+test） | 闸门白名单补 `setConfigOption` + 编译期穷尽守卫 |
| `src/renderers/solid-workbench/input/workbenchOptionCatalog.ts`（+test） | `advertisedChoices`（只有当前值 ⇒ 回落兜底表）；模型/权限/思考强度候选解析 |
| `src/renderers/solid-workbench/input/WorkbenchWidgets.solid.tsx`（+test） | 模型菜单空态占位；删三个控件的半高 margin；思考强度改用 `isReasoningOption` |
| `src/sheets/agent-workbench/AgentRendererSuiteWorkbench.tsx` | `setModel`/`setMode`/`setConfigOption` 三处镜像统一改走本地已确认 fact |
| `src/sheets/agent-workbench/agentWorkbenchSession.ts`（+test） | `LocalSessionFact` 入口（model/mode/option）；一行多事件时 `coverage` 只盖第一条 |
| `src/domains/workbench/workbenchProjector.ts` | `session.config-updated` 空列表不覆盖 |
| `src/domains/workbench/normalizers/acpNormalizer.ts`（+test） | config 包除 options 外补产 mode/model 两条 fact（与 `session_info_update` 同一范式） |
| `.../styles/.../WorkbenchChrome.css` | 菜单空态占位样式 |

## 验收与证据

- **门禁四步全绿**：`build:example-plugin` → `build` → `check:solid` → `test`（最终 582 files / 3929 passed；基线 3918，+11 条新增用例）。
- **反向验证**（每条修复都做过"改坏→变红→改回"）：权限候选收紧 → 静默降级；用量半高 margin → 掉第二行；`advertisedChoices` 撤掉 → 菜单空盒；F1/F2 改回合成响应 → **三个菜单同时塌**；F3 恢复硬编码键名 → `config_option_not_found`；F4 撤守卫 → 空列表清空候选面；覆盖率改回全盖 → 重放只进一条事件。
- **真机复验**（开发版 + WebView2 调试端口，由翻译做）：
  - 权限：点 `dont_ask` → agent 日志 `mode switched to dont_ask`，中控显示随动 ✓
  - 模型（Peri）：菜单出 peri 真候选 `fable/opus/sonnet/haiku`，可切换、可换回 ✓
  - 思考强度（Peri）：点 `high` → 中控随动、无报错、journal 有对应宣告 ✓
  - **两处一致**：点选后与重载后，中控与「配置」面板都等于 agent 宣告的真值（连做两次重载 + 一次完整"写入→重载"闭环）✓
- **agent 侧实证**：journal `raw_payload` 里有 peri 的宣告原文（`model`/`thinking_effort`/`mode` 的当前值与候选），确认"写入真的落到 agent"，不是文档自说自话。

## 遗留（不在本批）

1. 会话恢复路径仍丢 agent 上报的候选面（Rust 只读 `session/load` 响应的 `sessionId`）→ 对 Hermes 这类"只在开局报一次"的 agent，恢复会话后中控仍退回本地兜底表。
2. 「谁是唯一真值源」：中控读 `session.mode/model`、配置面板读 `options[].value`，本批靠**双写**保持一致；收敛为单一真值源属架构决策（建议 ADR）。两套语义判定器口径亦待统一（`infrastructure/findConfigOption` vs 渲染层 `optionKind`）。
3. 思考强度控件的对称守卫（`reasoning` 那条仍无"只有当前值"回落）。
4. 展开右侧栏时中控那一排会换行（内容 555px > 可用约 554px）。
5. 「恢复遗留会话归属」弹窗只有"确认恢复/稍后处理"，**没有"丢弃"出路**；localStorage/迁移残留的无法解析条目会反复弹（本机两条 2026-08-03 的遗留空壳已用"确认恢复"归位、弹窗消除）。
6. 切换 Agent 后，被停下的那个 agent 在 `list_agents` 里报 `crashed: true`（判据是"子进程 stdout 关闭"，不区分"主动停"与"崩溃"）。
