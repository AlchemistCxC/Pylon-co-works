# Dev Record — #306 权限弹窗面板背景越界引用 `--settings-surface` 致全透明

> 入库保留。规格文档（spec）不保留，其目标、范围、方案与验收结论在此承接。
> 产出路径：`.agents/records/306-permission-dialog-transparent-panel.md`

## 元信息

- issue：[#306](https://github.com/AlchemistCxC/Pylon-co-works/issues/306)
- 分支：`kumo/prometheus`
- 提交范围：`79a1cb11..HEAD`（本 issue 相关：`d5576edb` L.md 声明、`3c58383a` 修复、本文档提交）
- 日期：2026-09-24
- 触发来源：用户反馈「权限确认页面的透明度过高，不利于交互」

## 目标与范围

**要达成**：工具权限请求弹窗（`PermissionDialog`）与其同款缺陷副本（`SessionOwnerRecoveryDialog`）的面板恢复为可辨识的不透明表面，遮罩恢复为可感知的压暗；面板与背后聊天内容重新形成层级。

**不做什么**（本轮明确不做，见「未解问题」）：

- 不改权限请求的**渲染位置**（弹出式 → 聊天视图内联），也不改其承载路径。
- 不动**插件化外观接口**（用户提议、尚未裁断）。
- 遮罩**不加全屏模糊**（用户明确要求）。
- 不新增遮罩主题 token（现有 token 体系无 scrim 档；新增要走主题字段完整链，未采纳）。
- 不改 `PlainMessageList.solid.tsx` 等任何聊天渲染/虚拟化代码。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src/components/PermissionDialog.tsx` | 顶部 doc 注释 + `OVERLAY`/`DIALOG` 两个样式常量 | 修改 |
| `src/components/SessionOwnerRecoveryDialog.tsx` | 顶部 doc 注释 + `OVERLAY`/`DIALOG` 两个样式常量 | 修改 |
| `src/components/__tests__/topLevelDialogTokenScope.test.ts` | 新增：顶层弹窗 token 作用域静态断言（3 用例） | 新增 |

`docs/说明书/` 已 grep（`权限弹窗` / `PermissionDialog` / `工具权限请求`）无命中，无表述需同步。

## 方案要点

### 根因（实测确认，两条独立叠加）

1. **面板悬空引用。** `bg-[var(--settings-surface)]` / `shadow-[var(--settings-shadow)]` 的这两个 token 只在 `.settings-surface`（`SettingsCommon.css:1-6`）与 `[data-interface-mode="terminal-like"] .agent-settings-dialog` 上声明。两个弹窗都挂在 `App` 顶层（`App.tsx:558` / `App.tsx:536`），祖先链上没有带该类的元素。CSS 自定义属性引用不到时，整条属性在 computed-value time 无效并落到初始值 ⇒ `background-color: transparent`、`box-shadow: none`。仓库里同类组件（`ProfileEditor`、`SessionSettings`、`CwdSettingsPanel`、`HookDiagnosticsPanel`）都把 `settings-surface` 挂在自己根节点上，这两个弹窗漏了。
2. **遮罩用的 token 不是遮罩。** `color-mix(in srgb, var(--bg-panel) 60%, transparent)` 的 `--bg-panel` 在明/暗基础方案是 `rgba(0,0,0,0.03)` / `rgba(255,255,255,0.04)`（`index.css:124`、`:207`）——面板内层叠用的 3~4% 表面着色 token，取 60% 后只剩约 1.9% 黑。仅当皮肤/预设把它覆盖成不透明色（如 tactical-blue 的 `--bg-panel: #101c30 !important`）时遮罩才显现 60% 压暗，观感随皮肤在两极之间跳。

### 处置

- 面板改消费**全局声明**的 `--surface-overlay`（`index.css:74` 基础块 + 各 scheme 覆盖）与 `--shadow-float`（`index.css:82`）。选择依据：`--surface-overlay` 是各 surface token 中最不透明的一档（最差情形基础块约 96.6% 不透明，light/dark scheme 与 skin 为完全不透明），符合模态面板的层级要求；与 `.dialog-content` 以 `--dialog-bg` 兜底到 `--surface-overlay` 是同一先例。
- 遮罩改用与仓库既有模态基线 `.dialog-overlay`（`SettingsCommon.css:127`）一致的固定 `rgba(0,0,0,0.3)`，不加 `backdrop-filter`。
- 两个文件顶部原注释「`--settings-*` 为 Settings 域供给的 token，color-mix 遮罩为存量值原样平移」已过期且具误导性（它把缺陷描述成了有意设计），按 AGENTS §6.2 一并改写为记录真实根因的注释。

### 为什么回归判据放在源码层

jsdom 不解析 CSS 层叠，`var()` 落到 initial（面板变透明）在单测里**不可观测**——这也是该缺陷能长期存活、且既有 `PermissionDialog.test.tsx`（纯 jsdom 行为断言）一条都拦不住的原因。行为判据只能靠真机 computed style；于是新增的测试改钉「引用的 token 是否全局声明过」这一可静态判定的不变量：顶层弹窗消费的每个无 fallback `var(--x)` 必须在 `index.css` 里声明（带 fallback 的写法合法，故排除）。注释先剥离，避免散文里的 token 名污染判据。

## 验收标准与结果

真机（Vite dev server + 浏览器，`?demo-permission=1` 种入待审请求）computed style 前后对照：

| 验收项 | 修复前 | 修复后 | 结果 |
| --- | --- | --- | --- |
| 面板 `background-color` | `rgba(0, 0, 0, 0)` | `color(srgb 0.983059 0.982745 0.98949)`（完全不透明） | 通过 |
| 面板 `box-shadow` | `none` | `color(srgb 0 0 0 / 0.22) 0px 24px 72px 0px` | 通过 |
| 遮罩 `background-color` | `color(srgb 0 0 0 / 0.0188235)`（≈1.9%） | `rgba(0, 0, 0, 0.3)` | 通过 |
| 遮罩 `backdrop-filter` | `none` | `none`（按要求不加模糊） | 通过 |
| 面板上 token 解析 | `--settings-surface` / `--settings-shadow` 均为空 | `--surface-overlay` / `--shadow-float` 均可解析 | 通过 |
| 视觉：聊天正文是否穿透 | 正文与弹窗 prompt/按钮文字重叠 | 不再穿透（截图确认） | 通过 |

面板几何未变（466×160 @ (407,280)），即本改动不触及布局。

## 测试处置

- **新增** `src/components/__tests__/topLevelDialogTokenScope.test.ts`（3 用例）。
- **未修改**既有 `PermissionDialog.test.tsx`（8 用例）、`SessionOwnerRecoveryDialog.test.tsx`（2 用例）——它们断言的是接线行为，与本次样式改动无契约关系，且均保持绿。
- **变异核验**：把 `PermissionDialog.tsx` 的 `DIALOG` 常量回退成 `--settings-surface` / `--settings-shadow`，新用例 **2 条转红**，断言逐字点名 `--settings-surface`、`--settings-shadow`；恢复后转绿。证明判据有牙齿而非恒真。
- **既有红灯（非本次引入）**：`src/components/__tests__/SettingsPreview.solidMigration.test.tsx` > 「挂载 Solid 中控、保留 cc 高亮并实时响应背景主题」稳定失败（`AssertionError: expected null not to be null`）。已用 pathspec 限定暂存把本次两处改动收起后复跑，**依旧红** ⇒ 与本次改动无关，属既有问题，登记在「未解问题」。
- `src/components/__tests__/Settings.pluginPageDedupe.test.tsx` 在全量并发跑时偶发 2 条红、单跑通过 ⇒ 并发抖动，非本次引入。

## 证据

- commit：`d5576edb`（L.md 施工声明，仅该文件）、`3c58383a`（修复，3 文件 77+/6-）、本文档提交
- 测试：
  - `bunx vitest run src/components/__tests__/topLevelDialogTokenScope.test.ts src/components/__tests__/PermissionDialog.test.tsx` → **2 files / 11 tests passed**
  - `bunx vitest run src/components/__tests__` → 138 passed / 3 failed，其中 1 条为上述既有红灯、2 条为并发抖动（单跑通过）
  - `bunx tsc -b` → 无输出（通过）
  - 门禁：`check:first-party-styles`（23 files 通过）、`check:tailwind-tokens`（104 行通过）、`scripts/check-css-var-consumption.mts`（注入 113 / 消费 348 / 声明 355，0 悬空）均通过
- 手工验证：真机 computed style 对照表见上；截图两轮（修复前/后）
- issue 回写：[#306](https://github.com/AlchemistCxC/Pylon-co-works/issues/306)

## 与 spec 的偏差

**未落 `.agents/spec/` 规格文档。** 本轮经会话对齐即开工：缺陷单一、根因在实测中收敛（含遮罩取值与「不加模糊」两条用户口径），改动面为 2 个样式常量 + 1 条静态判据。规格化的边际价值低于其成本，故未落地；对齐结论与实测数据全部并入本文档与 issue。若后续把渲染位置/插件外观接口纳入本 issue 范围，应补 spec。

## 未解问题

1. **门禁盲点（防再犯的关键缺口）。** `scripts/check-css-var-consumption.mts` 的 B 项（悬空引用必须有 fallback）收集 `declared` 的方式是把**全部 CSS 拼起来跑全局正则**，不区分选择器作用域——token 在任一作用域声明过就认为全仓引用合法。因此「声明了但不在消费元素作用域内」这类悬空引用（正是 #306）不被拦截，这也解释了 `a7accb3e` 把 `PermissionDialog.css` 平移成 utility 时能带着坏引用过门禁合入。真正的作用域感知需要 CSS 选择器祖先推理，非小改；本次新增的是按组件钉住的静态断言，**不是**这条通用门禁。是否要做通用门禁待用户裁断。
2. **渲染位置未定。** 侦察结论：仓库已把「内联」定为交互内容的默认呈现方式（`interactionRenderKindCatalog.ts` 的 `presentation: 'inline' | 'modal'`，默认 `inline`），且 `SolidInteractionCard` 已实现两种呈现与完整外观设置；但 ACP 权限请求走的是**另一条**路径（`pylon:interaction` → `permissionController` → `runtimeStore.permission` → 本弹窗），全仓无 `interaction.requested` 的生产产生方，故内联卡片在生产里从未被激活。用户倾向「弹出式不太好」，但改动涉及权限路径的既有不变量（#209 本地收口、P1-1 按 agent 分片、后端唯一计时/倒计时、FIFO 队列），需先裁断再做。
3. **插件化外观接口。** 用户提议。侦察结论：`interaction.*` 渲染 kind 已带 `RendererSettingsSchema`（交互布局/外观、安全交互布局/外观：呈现方式、最大宽度、选项密度、确认顺序、倒计时样式、危险色/待处理色/已响应色/已过期色）与 `defaultTokens`，并已挂到「设置 → 外观 → 渲染器」；插件可经 `context.renderer.registerContentRenderer` 注册替代实现。故「外观可定制」在 `interaction.*` 路径上已成立，缺的是把 ACP 权限请求接上该路径。项目纪律要求插件自定义 UI 消费 `VISUAL_SEMANTIC_TOKENS` 而非复制宿主透明度/阴影/动画毫秒值（`docs/说明书/Pylon-插件系统说明书-开发者版.md`），本 issue 的缺陷正是违反该纪律的形态。
4. **既有红灯**：`SettingsPreview.solidMigration.test.tsx` 的中控挂载用例稳定失败（见「测试处置」），与 #306 无关，未修（不在本轮范围）。

## 并行交集

本次触碰的共享文件，供其他贡献者避让：

- `src/components/PermissionDialog.tsx`
- `src/components/SessionOwnerRecoveryDialog.tsx`
- `src/components/__tests__/topLevelDialogTokenScope.test.ts`（新增）
- `.agents/L.md`（施工声明条目，合并后按「只留在途」摘除）

**共享树状况**：施工期间工作树持续有他人/他 issue 在途改动（先后观察到 #301 的两个虚拟化测试文件与 `.agents/records/301-fixture-scroll-geometry.md`，其后为 `src-tauri/src/browser/mod.rs`）。全程未 abort、未宽暂存，一律 pathspec 提交，未连带任何在途内容。`docs/说明书/` 与 `src/renderers/**`、`src-tauri/**`、`src/plugins/**` 本次零改动。
