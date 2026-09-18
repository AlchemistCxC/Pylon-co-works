# Dev Record — #154（续）Agent 左栏区块栈模型：分区取代互斥模式 + 模块可展开成主区整页

> 入库保留。规格文档（spec）不保留，其目标、范围、方案与验收结论在此承接。

## 元信息

- issue：AlchemistCxC/Pylon-co-works#154（**续做**；本记录承接 `.agents/spec/154-unified-sidebar-model.md` 的**未决问题 1「左栏新 UI/功能占位内容 —— 待用户补充」**与未决问题 3）
- 路线决策：`.agents/decisions/0011-agent-sidebar-region-model.md`
- 分支：`Ru5t/Reflector`
- 提交范围：`a91d8d32..HEAD`
- 日期：2026-09-18

## 目标与范围

用户三轮原话（逐字）：

1. > 「关于工作区和会话，现在卡片占用的高度太大了，并且不同工作区之间其中有大片空白，视觉上非常空旷，折叠按钮也太显眼」（附参考图，声明「不一定要与这种完全相同」）
2. > 「我希望模块不是你现在做的这种只能折叠的，还要有能通过点击打开新页面（不是新sheet，而是替换聊天视图的新页面的功能）」
3. > 「左侧栏目前只服务于会话系统，太过单调…上面按模块分栏…下面是会话区，至于聊天这个分区我认为已经没任何存在必要了」
4. 契约处置裁定：> 「本项目目前没有任何用户，是个 demo，也没有插件市场，更没有现成插件，准许破坏性更新并，怎么彻底怎么来」

**做什么**

- 左栏由「按 `mode ('work' | 'chat')` 过滤出的单个面板」改为「**两个分区的纵向堆叠区块栈**」：`modules`（常驻能力区块，贴顶、自身滚动、默认可折叠）+ `sessions`（会话列表，占满剩余）。
- 区块**外壳**（标题 / 折叠钮 / 头部动作）归宿主渲染，贡献只画内容；`label` / `order` / `when` 第一次真正生效。
- 模块可声明 `page`，点标题把内容**展开成该 Sheet 的主区整页**（替换聊天视图，不开新 Sheet，Esc/返回可退）。
- 会话按 cwd 分组，**无 cwd 组置底**；「聊天」互斥页签删除。
- 左栏密度按「一行一条」收敛：组头与会话行都是 26px 单行；折叠箭头去显眼化。
- 顺手修掉 spec 154 阶段 3 已登记的两处缺陷（`.search-input` 17px、`.cwd-group-toggle` 的 62px 手抄预留）与会话行隐藏操作钮的命中问题。

**不做什么**

- ADR-0009 锁定的几何面分毫未动：`--sheet-sidebar-track-width` 唯一宽度真值、唯一分割线、折叠 = 0 宽、共享几何类 `.sidebar`、左栏 clamp 160/520、`applyWorkspaceLayoutChange` 事务、`pylon-workspace-layout-v3` 持久化键，以及**另一个**同名 `sidebarMode ('workspace' | 'sheet' | 'none')`。
- 中控区**布局与样式**不碰（`ControlCenter.css` 一字未动）。仅删了两处已失效的语义分支（会话创建守卫与一个下拉项文案），见「与 spec 的偏差」。
- 输入栏的模型/用量控件**不搬进**模块区（用户明确否掉：「模型，用量什么的还是在底部比较好」）。
- 不做真实的定时/自动化能力：模块区四个区块是 **mock**，只验证模型与排版。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src/plugin-runtime/sidebar/sidebarTypes.ts` | `AgentSidebarRegion` / `presentation` / `page` / `collapsible` / `headerActions`；props 增 `presentation`、`registerBlockActionHandler`、`onCreateLooseSession` | 修改 |
| `src/plugin-runtime/sidebar/sidebarRegistry.ts` | region 与 `headerActions`、`page` 校验；`list(region?)` | 修改 |
| `src/plugin-runtime/sidebar/sidebarBlockState.ts` | **新增**：折叠映射 + `activePageId`、`normalizeBlockState`、`isBlockCollapsed`、`toggleBlockCollapsed`、`openBlockPage`、`closeBlockPage`、`resolveOpenPage` | 新增 |
| `src/components/Sidebar.tsx` | 重写为两区 + 区块外壳 + 动作回派 + 点标题开页 | 修改 |
| `src/components/sidebar/SessionsPanel.tsx` | **新增**（取代 `WorkspacesPanel`）：工作区分组 + 底部无 cwd 组，单行紧凑排版 | 新增（旧名 `WorkspacesPanel.tsx`） |
| `src/components/sidebar/ChatSessionsPanel.tsx` | 删除（并入会话区块） | 删除 |
| `src/components/sidebar/useSidebarContributionProps.ts` | **新增**：贡献 props 唯一接线处（Sidebar 与页面宿主共用） | 新增 |
| `src/components/sidebar/AgentSheetPageHost.tsx` | **新增**：主区整页宿主 + `useOpenSidebarPage` | 新增 |
| `src/components/sidebar/FirstPartyContribution.tsx` | **新增**：不透明 `component` 的收窄边界 | 新增 |
| `src/components/sidebar/useBlockActionHandler.ts` | **新增**：贡献向宿主注册区块头动作处理器 | 新增 |
| `src/components/sidebar/blocks/mockBlocks.tsx` | **新增**：4 个 mock 区块（前两个带 `page`，且做 `block`/`page` 两种密度） | 新增 |
| `src/components/Sidebar.tsx` 相关 CSS `builtin.pylon-workspace/styles/components/Sidebar.css` | 区块栈 / 两区高度策略 / 密度收敛 / 整页样式 / search-input 修复 | 修改 |
| `src/workspace-sheets/agentWorkspaceState.ts` | `{ sidebarMode }` → `{ blockCollapsed, activePageId }`（零存储键迁移） | 修改 |
| `src/sheets/AgentSheetView.tsx` | 停读 `sidebarMode`；整页打开时主区交给页面宿主 | 修改 |
| `src/plugins/product/builtinPylonWorkspace.ts` | 注册 1 个会话区块 + 4 个模块区块（含 `page`） | 修改 |
| `src/plugins/core/sheet/builtinWorkspaceCommands.ts` | `layout.agent-sidebar.set` → `layout.agent-sidebar.block.set`（读改写，不整块覆盖） | 修改 |
| work/chat 轴清理（`workspaceMode` 共 18 文件） | `plugin-runtime/renderers/rendererTypes.ts`、`renderers/solid-workbench/{workbenchContracts,SolidWorkbenchApp.solid,input/ControlCenter.solid,settingsPreviewControlCenter.solid}`、`sheets/agent-workbench/{agentWorkbenchSessionCreation,AgentRendererSuiteWorkbench}`、`domains/workbench/agentEmptyState.ts`、`components/chat/AgentEmptyState.tsx` 及各自 `__tests__` | 修改 |
| `src/plugin-runtime/packageManifest.ts` + `shared/pylon-plugin-manifest.schema.json` + `src-tauri/resources/sdk/…schema.json` | 插件 API 升 major 至 `2.0`（allowlist 追加、minor 顺序表、schema enum） | 修改 |
| `src/workspace-sheets/launchIcons.tsx` | **新增**：Workspace launch 与区块头共用的稳定图标键映射（从 `SheetLauncher` 抽出） | 新增 |
| `src/components/SettingsPreview.tsx` | 预览跟随新左栏结构（模块区 + 会话区、单行会话行） | 修改 |
| 测试 | `Sidebar.blocks.test.tsx`、`Sidebar.blocks.css.test.ts`、`AgentSheetPageHost.test.tsx`、`SessionsPanel.test.tsx` **新增**；`Sidebar.agentSessions.test.tsx` 改写；`Sidebar.sections.test.tsx`、`WorkspacesPanel.test.tsx` 删除（主体已被上面两个覆盖） | 见「测试处置」 |
| 文档 | 本记录、ADR-0011、`docs/说明书/Pylon-插件系统说明书-开发者版.md`（§1 api 表、§6.8、§6.11.3）、`docs/说明书/Pylon-CLI-命令表.md`、`.agents/L.md` | 新增 / 修改 |

## 方案要点

1. **容器早就支持堆叠**。`.sidebar-sections` 本来就是 `contributions.map(...)`，互斥完全来自 `mode` filter 加那对页签。所以「换模型」的实际改动比看起来小：`order` 与 `when` 是现成原语，只是过去每个 mode 只挂一个贡献，它们无从生效。
2. **标题只能有一个来源**。旧模型里页签标签硬编码在 `Sidebar.tsx`、面板又各画一份 `.sidebar-section-head` 并写死标题，注册表的 `label` 无人读取——同一个词出现在两处。改成宿主渲染区块头后，这类重复在结构上不可能再发生。
3. **折叠状态用显式映射而非塌陷清单**。贡献可声明 `defaultCollapsed`；若只记塌陷项，用户把默认塌陷的区块展开后无处落笔（从清单移除 → 又回落默认塌陷），方向即反转。
4. **整页复用同一贡献组件**。页面不是新注册的第二种组件，而是同一个组件在 `presentation: 'page'` 下的体量。代价是贡献要自己分两档排版，收益是数据/回调天然一致——为此把接线抽到 `useSidebarContributionProps`，`Sidebar` 与页面宿主消费同一份，杜绝「整页里删掉的会话，区块里还显示」这类分裂。
5. **标题与折叠分工**。标题管「打开整页」，折叠钮是独立控件。未声明 `page` 的区块标题退化为折叠开关，不可折叠又无页面的区块标题不渲染成按钮（点它无处可去）。
6. **页面直接接管主区**（不搞绝对定位覆盖）。`.main` 是 `.agent-sheet-keep-alive` 的直接子元素、参与 `flex:1 1 auto` 布局，包装一层就会打破这条 CSS 契约；因此页面自己也挂 `.main` 并整体替换聊天区。取舍：开页时聊天区不挂载，返回时经 lifecycle 重读历史——与「切会话」同一条既有路径。
7. **密度**：组头去掉目录路径行（降级 tooltip）、会话行压成单行且时间右对齐、**时间与操作钮共用流内格子交叉淡出**（四个操作钮常驻占宽会把单行会话名挤成省略号）、计数药丸退化纯暗字、组内空提示删除、缩进 30px→12px、折叠箭头默认淡到 `.32`。

## 验收标准与结果

### 门禁

| 门禁 | 结果 |
| --- | --- |
| `bunx tsc -b` | 通过（无输出） |
| `bun run lint`（eslint src/） | 0 error / 1 warning（`RightRailHost.tsx` 的既存 `exhaustive-deps`，非本次产物） |
| `bunx vitest run`（全量） | **599 文件 / 4342 用例通过**，2 todo，0 失败 |
| `bun run check:first-party-styles` | 通过（23 文件） |
| `bun scripts/check-css-var-consumption.mts` | 通过（注入 117 / 消费 356 / 声明 354，死注入与悬空引用均为 0） |

### 实机（webview2 MCP，`vite build` + `cargo build` 后重启；视口 1200×800）

| 判据 | 实测 |
| --- | --- |
| 分组顺序（无 cwd 组置底） | `prism-desktop` → `无工作区` |
| 组头高度 | 26px ×2（原 46px 两行） |
| 模块区块头高度 | 26px ×4 |
| 目录路径行 | 已不在 DOM（`pathLinePresent: false`），降级为 `title` |
| 会话两行栈 | 已不在 DOM（`sessionInfoPresent: false`），单行 `session-tail` |
| 时间右对齐 | 预览实测 `metaRightEdge 327 ≈ rowRightEdge 328`；`min-height: 26px`、`padding: 1px 6px`、`font-size: 10.5px`、`margin-top: 0` |
| 折叠箭头默认淡出 | `.cwd-group-arrow` computed `opacity` = **0.32** |
| 区块按 order 堆叠 | scheduled y=44 → automation y=191 → tasks y=303 → extensions y=394（order 100/200/300/400） |
| 模块区不压缩内容 | 四块 `scrollHeight == height`（147/112/91/28），无一被压；分区 240×318（max-height 42%）自身滚动 |
| `.search-input` 高度 | **36px**（原实测 17px） |
| 点标题开整页 | 点「定时」→ 主区变 `[240,44 960x756]` 的 `.agent-sheet-page`，标题 `定时`，`presentation:'page'` 的宽版内容渲染；左栏该区块 `data-page-open="true"` 并高亮 |
| 页面替换聊天视图 | 页面打开时 `chatMainPresent: false`（聊天区不挂载） |
| 「返回」 | 页面消失、聊天区回来；`blockCollapsed` 未被抹掉（替换语义下两个字段一起写） |
| ADR-0009 共线判据 | 标题栏左格右缘 = 左栏右缘 = 240；宽度真值 `--sheet-sidebar-track-width` = 240px |

**实机抓到、单测抓不到的一个缺陷（已修）**：模块区块保留默认 `flex-shrink:1`，被分区的 `max-height` 各自压扁（自然高 418px 压成 111/85/69/51），内容溢出到下一个区块头上，看着像四块互相重叠。修法 `.sidebar-region[data-region="modules"] > .sidebar-block { flex:0 0 auto }`，并写进静态契约测试。

### 未能实机验证的判据

- **会话行的真实数据表现**（名称省略、悬停时操作钮顶替时间）：本机 dev 数据目录里 **0 个会话**，造一个需要真实 agent 调用、会消耗用户额度，未获授权。已用「设置页左栏预览」的真实渲染行量到上述数值（该预览带缩放，故只取结构与相对位置，绝对高度由 CSS 契约测试钉住）。
- **ADR-0009 的折叠态 0 宽与拖拽**：本轮未触碰该路径，未复测；`sidebarUnifiedModel.css.test.ts` 与既有行为测试全绿。

## 测试处置

**新增**

- `src/plugin-runtime/sidebar/__tests__/sidebarRegistry.test.ts`：region 过滤 / shadow transaction / order + 新增「region 非法即拒绝」「headerActions 校验」。
- `src/components/__tests__/Sidebar.blocks.test.tsx`：两区堆叠顺序、标题取自 `label`、搜索框归会话区、`when` 门控、折叠落库（断言含 `activePageId`）、独立折叠钮与不可折叠区块无折叠控件、损坏/旧模型状态回落、区块头动作回派、**点标题开页并把 `activePageId` 落库**、打开态 `data-page-open`。
- `src/components/__tests__/Sidebar.blocks.css.test.ts`：13 条静态契约（防压缩、两区高度策略、`search-input` 不得 `flex:1`、区块外壳部件、`cwd-group` 元格、会话行命中门控、折叠可见性兜底、会话行单行档、时间/操作同格、组头单行且路径行不得复活、折叠箭头默认淡出、折叠钮与标题是两个控件、整页部件齐备）。**做过变异核验**：删掉防压缩规则该用例即红，还原即绿。
- `src/components/__tests__/AgentSheetPageHost.test.tsx`：`presentation='page'` 交付、返回清空 `activePageId` 且保留折叠状态、Esc 关闭、无 `page` 声明的贡献解不出来、id 指向已卸载贡献回落 `null`。
- `src/components/__tests__/SessionsPanel.test.tsx`：取代 `WorkspacesPanel.test.tsx`（原 5 例逐条保留并适配新交互：区块头动作走注册处理器、设置对话框、保存、折叠持久化、几何分层；新增无 cwd 组置底、搜索双区过滤、整表空态）。

**改写**

- `src/components/__tests__/Sidebar.agentSessions.test.tsx`：面板从两个旧面板收敛到 `SessionsPanel`；`onCreateChatSession` → `onCreateLooseSession`；`state={{ sidebarMode }}` 参数删除。
- `src/workspace-sheets/__tests__/workspaceStore.integration.test.ts`：原「持久化 Agent sidebarMode」改为新形状往返；新增「`activePageId` 与折叠一起往返」；原旧值用例保留为「旧 `sidebarMode` 落盘值收敛为空状态（零迁移）」。
- `src/sheets/__tests__/AgentSheetView.rendererMode.test.tsx`：删除「`sidebarMode` 经 Host input 传给 Solid（`data-workspace-mode`）」一例——其契约已不存在；**等价强度的替代**在 `Sidebar.blocks.test.tsx`（sheet state 到达左栏、损坏值回落）与 `workspaceStore.integration.test.ts`（codec 往返）里。文件内 30 处已失效的 `sheet({ sidebarMode: 'work'|'chat' })` 夹具统一简化为 `sheet({})`，并把一处依赖「改 sheet state 触发更新传播」的用例改为切 `activeSession`（该用例原本靠 `sidebarMode` 变化触发，字段废除后会静默不再触发——已定位并修正）。
- `src/renderers/solid-workbench/__tests__/mountSolidWorkbench.solid.test.tsx`：清掉 21 处已失效的 `workspaceMode` 输入字段。
- `src/plugin-runtime/sidebar/__tests__/sidebarRegistry.test.ts`、`src/plugin-runtime/__tests__/packageManifest.test.ts`、`src/plugin-runtime/renderers/__tests__/{rendererRegistry,thirdPartySolidRenderer.integration}.test.ts`、`src/host/renderer-suite/__tests__/rendererSuiteHost.test.ts`、`src/components/chat/__tests__/AgentEmptyState.test.tsx`、`src/application/transactions/__tests__/sessionCreationPaths.test.ts`、`src/plugins/core/commandSet/__tests__/builtinCliCommandCoverage.test.ts`：随 work/chat 轴清理与 CLI 命令换代适配。

**删除**

- `src/components/__tests__/WorkspacesPanel.test.tsx`（→ `SessionsPanel.test.tsx`）、`src/components/__tests__/Sidebar.sections.test.tsx`（「工作/聊天互斥切换」的主体已不存在，覆盖并入 `Sidebar.blocks.test.tsx`）。

**没有降级断言**：每一处改写都保留了原断言的强度（多为「同一性质换新字段/新交互」），删除的两处均为契约已不存在且替代用例已覆盖同一性质。

## 证据

- commit：见本记录同批提交（`a91d8d32..HEAD`）
- 测试：`bunx vitest run` → 599 passed / 4342 passed / 2 todo / 0 failed（exit 0）
- 静态门禁：`bunx tsc -b` 无输出；`eslint src/` 0 error；`check:first-party-styles` 23 文件通过；CSS 变量审计 0 死注入 / 0 悬空引用
- 手工验证（webview2 MCP 实测值）：见「验收标准与结果 · 实机」表
- 实机构建：`bunx vite build` + `CARGO_TARGET_DIR=D:/pylon-acceptance-target cargo build --bin pylon`（**未使用仓库默认 `target/`**：G: 盘已 100% 满，构建缓存 30G，未删除用户缓存）

## 与 spec 的偏差

1. **偏离「中控区不碰」**（已在 L.md 与批准方案中声明）：彻底删掉 work/chat 轴必须动 `ControlCenter.solid.tsx` 的两处——一个「请先选择工作区」提交守卫 + 一个工作区下拉项文案，以及 `src/renderers/solid-workbench/**` 的字段透传。**只删失效语义分支，未重排中控区布局与样式**（`ControlCenter.css` 一字未动）。用户已批准「怎么彻底怎么来」。
2. **`sidebarMode` 的处置比 spec 设想更彻底**：spec 只把「左栏新占位」列为未决；实际把「互斥视图」这个内容模型整体换掉，并连带清了 `workspaceMode` 这条轴。
3. **新增了 spec 未提的整页机制**（`page` + `presentation`）：来自用户在追加轮的明确要求。
4. **插件 API 升 major 至 2.0**：spec 未提，但按 `docs/说明书` §6.11.3 的既定策略，破坏性契约变更必须升 major，否则文档与代码自相矛盾。
5. **`spec/154-unified-sidebar-model.md` 的未决问题 1 与 3 已答复**（1 → 区块栈 + 4 个 mock；3 → 删除死 CSS），该文件是不入库的一次性文档，结论收在此处与 ADR-0011。

## 未解问题

1. **`AgentSidebarContribution` 的破坏面只在文档层面收口**。升到 2.0 后，1.x 清单仍可解析与激活，但引用旧 `mode` 的左栏贡献会在运行时静默落不到任何分区（`grouped[value.region]` 拿到 `undefined`）。当前无第三方插件，未加运行时告警；若将来要对外开放，应在注册期对未知 `region` 直接抛错——**校验已经这么做**（`region 非法` 即拒绝），但 `mode` 字段本身不会被识别为错误，因为它是未知字段而非非法值。是否要在 2.0 清单上显式拒绝 `mode` 字段，留待有插件时决定。
2. **模块区上限 `max-height: 42%` 依赖 `.sidebar` 有确定高度**（由布局层 flex 拉伸提供）。若左栏高度变为 auto，百分比失效并退化为内容高度，模块区可能挤占会话区。当前无此路径。
3. **契约写明「贡献不得再画自己的标题」，但没有静态门禁强制**，只能靠 review。
4. **开整页时聊天区不挂载**（取向：与切会话同一路径）。若将来要求「开页期间后台流式仍可见/不中断」，需改为保挂载 + 覆盖层，届时要先解决 `.main` 作为 keep-alive 直接子元素的 CSS 契约。
5. 上一轮已记录、仍未做的：spec 154 阶段 2（标题栏排布）与阶段 4（设置迁入 sheet 体系）。

## 并行交集

- **⚠️ 与 #116（Fisher）重叠**：`src/components/Sidebar.tsx` 同时出现在 #116 的文件域声明中。本轮**重写了该文件**（删模式页签、加区块外壳与两区）。已在 `.agents/L.md` 声明并提请注意。
- 本轮碰过的共享文件，供其他贡献者避让：`builtin.pylon-workspace/styles/components/Sidebar.css`、`src/workspace-sheets/{agentWorkspaceState,SheetLauncher}.tsx`(+ 新增 `launchIcons.tsx`)、`src/sheets/AgentSheetView.tsx`、`src/renderers/solid-workbench/{workbenchContracts.ts,SolidWorkbenchApp.solid.tsx,input/ControlCenter.solid.tsx,settingsPreviewControlCenter.solid.tsx}`、`src/plugin-runtime/renderers/rendererTypes.ts`、`src/plugin-runtime/packageManifest.ts`、`shared/pylon-plugin-manifest.schema.json`、`src-tauri/resources/sdk/pylon-plugin-manifest.schema.json`、`src/components/SettingsPreview.tsx`、`src/domains/workbench/agentEmptyState.ts`、`src/components/chat/AgentEmptyState.tsx`。
- **未触碰**：`ControlCenter.css`、`src-tauri/**`（除资源 schema 副本）、`tools/webview2-mcp/**`、`src/index.css`、`src/styles/tailwind.css`。


---

## 追加轮（同日）：模块栈一维化 + 插件化留位 + 排布与显隐

用户 8 条要求，逐条落点：

| # | 要求 | 做法 |
| --- | --- | --- |
| 1 | 会话抽取成常开模块 | 删 `AgentSidebarRegion`；会话改注册为 `alwaysOpen: true` + `order: 900` 的普通模块，与插件模块同构 |
| 2 | 字体 token 同步 + 略放大 | 模块标题/组名/行名统一 `--sidebar-name-size`、次要文字统一 `--sidebar-meta-size`；预设值 13→14 / 11→12 |
| 3 | 给插件化留位置 | 模块与页面都在同一条公开注册表上（`registerAgentSidebarContribution` + `page`），新增第三方 isolated-surface 模块+页面的契约测试 |
| 4 | 工作区间空白太多 | `.cwd-group` 下边距 4→1px、`.workspace-empty` 上边距 32→8px、组内空提示此前已删 |
| 5 | 插件选点击方案/图标/页面 | `onTitleClick: 'expand' \| 'page'`、`icon`（稳定键）、`page`；「都要」= expand + page（宿主自动补「打开」） |
| 6 | 搜索放进会话模块 | 移入 `.session-module-search`；`onQueryChange` 由宿主持有 |
| 7 | 拖拽调整模块排布 | 模块头手柄 + pointer 捕获；拖拽中预览、抬起落库到 `pylon-sidebar-modules-v1` |
| 8 | 设置页声明模块显隐 | 「设置 → 侧栏 → 模块」`SidebarModulesPanel`；`alwaysOpen` 项列出但禁用 |
| 附 | 去掉工作区折叠按钮、保留折叠 | 删除 `.cwd-group-arrow`，整组头即开关 |

**门禁**：`tsc -b` 无输出；`eslint src/` 0 error（1 条既存 warning）；全量 **600 文件 / 4350 用例通过**。

**实机复核（webview2 MCP，重建后重启）**：模块栈次序 `scheduled→automation→tasks→extensions→sessions`（order 100/200/300/400/900）；每个模块有手柄与图标；`automation` 有独立折叠钮（`onTitleClick: 'page'`）；`scheduled` 头部自动出现「打开」（expand + page = 都要）；`sessions` `data-always-open="true"`、无折叠钮、带「工作区」动作；搜索框在会话模块内部且高 **36px**；组头 **26px**、组间 **3px**、组头箭头**已不在 DOM**；`--sidebar-name-size` = 14px，模块标题/组名/会话名 computed 均为 **14px**（同源）；设置 → 侧栏 → 模块面板列出 5 个模块（「定时/自动化 可展开为页面」「会话 常开」）。

**本轮未做**：模块显隐的**实测**只到「面板正确渲染 5 行」；勾选/取消勾选的实机效果未逐项复核（单元测试已覆盖 `applyModulePrefs` 的隐藏与 `alwaysOpen` 例外）。拖拽的实机手势（真实指针拖动）未做——jsdom 无指针几何，单元测试用合成的 pointermove 覆盖了落库路径；**实机拖拽请用户验一下手感**。

**⚠️ 实测期间观察到的现象（需用户确认归属）**：复核过程中主题由 Solarized 浅色变为 **Nord**（`appliedPreset` 五个分区全为 `nord`）。本轮我只改过主题的一个字段（`sidebarNameSize` 13→14），未点击任何预设行。若这不是用户自己所点，则「编辑某个字号字段会连带套用预设」是严重缺陷，需要单独立项排查。
