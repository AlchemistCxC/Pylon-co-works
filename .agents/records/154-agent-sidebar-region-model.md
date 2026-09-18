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


### 追加轮二（同日）：用户三条修正 + 计数移除

| 要求 | 做法 | 实机证据 |
| --- | --- | --- |
| 不要拖拽按键，改长按拖拽，模块整体左移 | 删 `.sidebar-block-grip`；长按 260ms 进拖拽（移动 >6px 取消，抬起后 320ms 吞 click）；左轨统一 `--sidebar-rail-pad` | 手柄节点 **0 个**；模块图标 x 由 24 → **6** |
| 工作区缩进与模块图标一致 | 模块头 / 组头 / 搜索 / 会话缩进全部派生自同一 rail；图标占位统一 15px | 模块图标、工作区图标、搜索图标同在 **x=6**；标题同在 **x=26** |
| 重绘搜索会话 | 从 36px 描边框改为内联行（图标 + 无框输入，hover/focus 变色）；旧 `.search-input` 规则删除 | 输入框 `border 0` / `background transparent`，行高 24 |
| 去掉工作区右侧会话数量 | 删 `.cwd-group-count` 与交叉淡出；右侧只剩 hover 显形的动作 | 计数节点 **0 个**；未显形动作 `visibility:hidden` + `pointer-events:none` |

**说明书同步**：`Pylon-插件系统说明书-开发者版.md` §6.8 补全为完整契约——注册字段表（必填/默认/语义）、注册期 fail-closed 校验清单、点击方案三选一表、`first-party-react` props 表、`isolated-surface` 的 `host:input` wire 契约与可发事件表（含 `host:create-chat-session` → `host:create-loose-session` 的更名）、长按拖拽与显隐偏好（独立键）；§1 的 `api` 取值与图标键清单（补 `messages` / `clock` / `plus`，并说明模块图标与 launch 共用同一映射）同步。

**门禁**：`tsc -b` 无输出；`eslint src/` 0 error；全量 **600 文件 / 4353 用例通过**；`check-doc-links` 通过；`check:maintenance` exit 0。


### 追加轮三（同日）：抖动修复 + 会话可折叠 + 搜索独立成模块 + 空组高度

| 用户反馈 | 根因 | 做法 |
| --- | --- | --- |
| 拖拽时疯狂抖动 | 「实时重排预览」形成反馈环：重排把被拖模块挪出光标 → 落点按新布局重算 → 挪回去 | 长按那刻**冻结**各模块头中心线，落点只由冻结几何决定；预览改为一条落点指示线 |
| 会话需要折叠 | `alwaysOpen` 此前压制了折叠 | 语义收窄为「不可隐藏」，与 `collapsible` 解耦（注册期互斥校验删除） |
| 搜索还得改进 | 「框」不在错的设计上，而在错的位置 | 搜索**独立成模块**（VSCode 搜索侧栏）：带框输入 + 清除 + 命中计数 + 按工作区分组；会话列表不再被过滤 |
| 空工作区折叠/展开有细微高度变化 | 空组仍渲染 `.cwd-group-sessions`（自带 1px/2px 内边距） | 空组不渲染该容器，折叠/展开对空组成为无操作 |

**契约收窄**：`query` / `onQueryChange` 从 props 与 isolated wire 契约移除（模块自持查询），`when` 入参只剩 `{ activeAgentId, activeSessionId }`；`alwaysOpen` 不再压制折叠。说明书 §6.8 同步（含新增「内置模块参考」段）。

**新增测试**：`SearchPanel.test.tsx`（未输入提示 / 按名命中并按工作区分组 / 工作区名命中列出全部 / 无命中空态 / 点击选中与清除 / 选中态）；CSS 契约扩到 14 条（新增落点指示线、搜索模块专属面板部件、旧内联搜索不得复活）。

**门禁**：`tsc -b` 无输出；`eslint src/` 0 error；全量 **601 文件 / 4359 用例通过**。


### 追加轮四（同日）：左栏所有按钮失效——指针捕获时机 + 两条新用例

| 用户反馈 | 根因 | 做法 |
| --- | --- | --- |
| 「让搜索可以折叠」（点标题没反应） | 长按拖拽在 **`pointerdown` 就 `setPointerCapture`**：捕获把 `pointerup` 的目标改写成捕获元素（模块头），而 `click` 派发在「按下目标」与「抬起目标」的**最近公共祖先**上 ⇒ 头内部的标题按钮、折叠钮、「打开」、头部动作全部收不到 click。**影响面不止搜索**：左栏所有按钮自长按拖拽落地（`1b4854f0`）起一直是死的。jsdom 不实现指针捕获，单测复现不出 | 捕获**推迟到长按计时器触发那一刻**（真的进拖拽才捕获，那时 click 本就要被吞，捕获无害）；补 `onPointerLeave` 取消长按（不捕获后头以外的 pointermove 收不到，`LONG_PRESS_SLOP_PX` 形同虚设）；`DRAG_CLICK_SUPPRESS_MS` 降级为「捕获不可用环境」的兜底 |

**实机数值证据**（`D:\pylon-acceptance-target\debug\pylon.exe`，CDP 9222；probe 挂在 document 捕获阶段）：

| 测点 | 修复前 | 修复后 |
| --- | --- | --- |
| 点击搜索模块标题的事件目标链 | `pointerdown@.sidebar-block-toggle` → `pointerup@.sidebar-block-head` → **`click@.sidebar-block-head`** | `pointerdown@.sidebar-block-toggle` → `pointerup@.sidebar-block-toggle` → **`click@.sidebar-block-toggle`** |
| 点击后 `data-collapsed` | `false`（无反应，落盘无该键） | `true`；`.sidebar-block-body` 节点 1 → **0**；落盘 `blockCollapsed["builtin.sidebar.module.search"]=true` |
| 自动化模块的独立折叠钮（`onTitleClick:'page'`） | `true`（无反应） | `false`，body 重新出现 |
| 头部动作「打开」（定时模块） | 无反应 | `.agent-sheet-page` 出现、标题「定时」、`data-page-open="true"`；Esc 后回 `false` |
| 长按拖拽（按住 450ms 后移动） | — | `data-dragging="true"`，落点指示线 **1** 条；拖到 y=345 → 指示线 y=395（末尾插入点）；抬起后落盘次序 `[automation, search, scheduled, extensions, sessions, tasks]` 与渲染次序一致；再拖回 y=140 次序复原 |
| 唯一仍改派到头的场景 | — | 拖拽自身（那时 click 本就该被吞） |

**新增用例（2 条，该文件共 15 条）**：① 捕获时机——按下不捕获、长按到点才以 `pointerId` 捕获；做过**变异校验**：把捕获挪回 `pointerdown`，该用例即红。② `pointerleave` 取消长按——按下后离开模块头，计时器到点也不进拖拽。

**门禁**：`tsc -b` 无输出；`eslint src/` 0 error（仅既有 `RightRailHost` warning）；全量 **601 文件 / 4361 用例通过**（+2）。


### 追加轮五（同日）：折叠动效统一 + 常驻模块钉栈底

| 用户反馈 | 根因 | 做法 |
| --- | --- | --- |
| 「折叠动效啥的，目前只有部分地方有」 | 模块体折叠时**直接不渲染**（卸载即消失），而同一栏的工作区组早就有 `grid-template-rows: 1fr → 0fr` 的收起动画 | 模块体常驻，折叠改为 CSS 收行高 + 淡出（同一手法）；子元素补 `min-height:0` 让 0fr 收得下去；折叠态加 `inert`（高度 0 挡不住键盘焦点） |
| 同上（隐藏的一半） | 工作区组的时长是**字面毫秒**（180ms/140ms），而 `prefers-reduced-motion: reduce` 是把 `--motion-*` token 压到 1ms —— 字面值不跟着归零 | 两侧时长一律取 token，reduced-motion 由既有集中覆盖生效 |
| 「会话相关…始终位于模块最下方」 | `order: 900` 只是**初次**次序；`applyModulePrefs` 不钉底，拖拽写的是完整次序 —— 实测能把会话拖到最上面 | `alwaysOpen` 语义追加「钉在栈底」：收纳时强制分区、常驻模块不响应长按拖拽、落点钳在钉区之前（`dropIndexAt` 取 `min(index, pinnedStart)`） |

**实机数值**（WebView2 真窗口，重建二进制后 rAF 采样 `.sidebar-block-body` 高度）：

- 折叠（会话模块，60px）：`60 → 52.2 → 32.4 → 20.7 → 13.6 → 8.8 → 5.5 → 3.1 → 1.6 → 0`，~180ms 收敛到 0；`inert` false → true。
- 展开：`0 → 7.8 → 27.7 → 39.3 → 46.4 → 51.2 → 54.5 → 56.8 → 58.4 → 59.4 → 59.9 → 60`，~200ms 到终值；`inert` 回到 false。
- 计算值 `grid-template-rows 0.18s cubic-bezier(0.2,0,0,1), opacity 0.12s …`（来自 token）。
- 正向副作用：模块体不再卸载，模块内状态跨折叠保留 —— 实测搜索模块输入 `peri` → 折叠 → 展开，输入框仍是 `peri`。

**新增/改写测试**：`Sidebar.blocks.test.tsx`「折叠后不渲染 body」→「仍挂载但 inert / 零高」+ 新增「展开态不 inert」+ 新增「常驻模块固定栈底（长按不进拖拽、落点不入钉区）」；`Sidebar.blocks.css.test.ts` 新增「模块体过渡走 token + 0fr 规则」与「左栏折叠动画不得再出现字面毫秒时长」（变异校验：把组时长改回 180ms 即红）；`sidebarModulePrefs.test.ts` 新增「旧偏好把常驻排前面也会被纠正」。

**门禁**：`tsc -b` 无输出；`eslint` 0 error；全量 **601 文件 / 4386 用例通过**。

**分界（形态 B，已落地）**：用户在「纯留白 / 层底+留白+吸顶 / 上缘渐变」三案中选 B。

- 留白：栈的统一 gap 是 6px，常驻区再补 `margin-top:4px` → 实测间隔 **10px**。
- 层底：常驻区整块 `background:var(--bg-panel)`。**第一版写成 `color-mix(--bg-panel 52%)` 是无效的**——本主题的 `--bg-panel` 本身就是 `rgba(0,0,0,.03)`，再乘系数算出来是 1.6% 黑，肉眼不可辨；直接用 token 才与搜索输入框的填充同款（实测计算值 `rgba(0,0,0,0.03)`）。
- 吸顶：标题 `position:sticky; top:0`，底用近不透明 `--surface-panel`（本主题 `#FAF9F5`，实测 92%）+ `backdrop-filter:blur(8px)`。**必须先做留白与层底**：实色底挡得住行文字，而 `--bg-panel` 的 3% 挡不住。
- 实机数值（窄视口 1200×430 让常驻区高于可视区）：滚动到位时**常驻区顶已滚到 -114px，标题仍停在栈顶 +8px**（栈顶 padding 8px），即吸顶生效；间隔 10px。
- 不画线由 CSS 契约测试钉住（断言常驻区规则体不含 `border`）。


### 追加轮六（2026-09-19）：会话行只留两个动作 + 选中改阴影 + 两列对齐

| 用户反馈 | 根因 | 做法 |
| --- | --- | --- |
| 选中会话的「框」改用阴影 | 选中态是 `border-color: accent` + 一层 ring | 边框恒为透明，选中改为 `box-shadow: inset 3px 0 0 accent, 0 1px 2px …, 0 2px 8px …`（左侧强调条本身也是 inset 阴影） |
| 「会话设置和删除会话完全不见了」 | 四点：① 显形态只有 `opacity:.62`，再叠上 `--text-dim` 是两层压暗；② 四个按钮挤在 `min-width:40px` 的 tail 里；③ 名字被挤成 `sessio…` | 行上**只留两个动作**：置顶（左，占工作区图标那一列）+ 设置（右，`title` 写明「重命名 / 归档 / 导出」）；显形态提到 `.88`；tail `min-width` 收到 22px。删除/导出/归档从行上撤出（设置页里仍有删除） |
| 会话名缩进、图标列对齐 | 会话列表容器统一内缩 26px，行内第一个元素是运行点，于是名字落在 x=43，与工作区名（x=26）差 17px | 容器内缩归零，改为**行内自带图标槽**：行内容盒起于 x=6（1px 边框 + `rail-2` 内边距）→ 置顶槽 15px 与工作区图标同列；+5px 间距 → 会话名 x=26 与工作区名同列。运行点移到名字与时间之间（不再占最左列） |
| 置顶语义 | 会话模型没有置顶字段 | `Session.pinned?`（identityStore，随会话持久化）+ `WorkspaceSession.pinned?`（插件视图）+ props 回调 `onToggleSessionPin?`；接线处排序改为「置顶优先 → 最近活跃」（`sort` 稳定，同档保原序）。契约纯加法 → 插件 API 升 **2.3** |

**置顶按钮的可见性**：平时不可见（与组头动作同一套 opacity + visibility/pointer-events 门控），**已置顶的行常驻显示**（否则看不出这条为什么排最前），粗指针下常驻可点。

**测试**：`SessionsPanel` 新增两条（行上恰好两个动作、旧动作不得复活、置顶按钮不冒泡到选中行、已置顶的 `aria-pressed`/`data-pinned`、设置钮 `title` 含三件事）；`Sidebar.agentSessions` 改写删除按钮用例 + 新增「置顶排在所属工作区最前（即使更久没活跃）」（直接对 props 接线钩子断言）；`Sidebar.blocks.css` 新增三条（两列对齐同源、选中必须是阴影且边框透明、两个动作的存在与门控 + 旧类名不得复活）；`Sidebar.css` 的键盘焦点契约改为断言置顶钮与设置钮各自的 `:focus-visible` 焦点环（顺带给设置钮补上真正的 `outline` 焦点环——原先只有与 `:hover` 共用的描边样式）。

**门禁**：`tsc -b` 无输出；`eslint` 0 error；全量 **601 文件 / 4392 用例通过**。

**实机验证的缺口（如实记录）**：本轮的**两列 x 值**（置顶槽 6 / 会话名 26）没有拿到实机读数——两个环境当前都没有会话行：dev 浏览器 profile 里 `invoke('workspace_list')` 返回 8 个工作区，但左栏显示空态（疑似 bootstrap 水合问题，不是本轮改动：本轮只改类型、样式与会话行渲染）；验收实例的数据目录没有会话，现场用「无工作区 ＋」建会话没成功（后端未生成）。同一份几何此前在实机量到过工作区组头：图标 x=6 / 名字 x=26，与本轮的目标列一致；行内两列由 CSS 契约用例按同一 token 算术钉住。
