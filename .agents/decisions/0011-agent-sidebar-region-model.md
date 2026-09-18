# ADR-0011 Agent 左栏区块栈模型：分区取代互斥模式，区块外壳归宿主

> 入库保留。编号顺延，按编号命名。
> 产出路径：`.agents/decisions/0011-agent-sidebar-region-model.md`

- **日期**：2026-09-18
- **状态**：已采用
- **关系**：回答 `.agents/spec/154-unified-sidebar-model.md` 的**未决问题 1**（「左栏新 UI/功能占位内容 —— 待用户补充（本轮不做）」）与该文件的未决问题 3（`.sidebar-status-bar` 死 CSS 复活还是删除）。与 ADR-0009（左列统一模型）**正交且不冲突**：ADR-0009 锁的是左列**几何所有权**（宽度真值 / 唯一分割线 / 折叠 = 0 宽 / 共享 `.sidebar` 类）与**另一个**同名字段 `sidebarMode ('workspace' | 'sheet' | 'none')`；本 ADR 只改 Agent 左栏**内部的内容模型**。取代 ADR 未记载的「Agent 左栏按 `mode ('work' | 'chat')` 过滤出单个面板」的旧内容模型。

## 背景与约束

用户诉求（原话）：「左侧栏目前只服务于会话系统，太过单调，我希望能加一点别的东西，可以站位」「上面按模块分栏（具体该有什么我还没想好），下面是会话区，至于聊天这个分区我认为已经没任何存在必要了」；对契约处置的裁定：「本项目目前没有任何用户，是个 demo，也没有插件市场，更没有现成插件，准许破坏性更新并，怎么彻底怎么来」。

只读核查（webview2 MCP 实测 + file:line）确认旧模型的结构性病灶：

| 现象 | 事实 |
| --- | --- |
| 注册表退化成单面板 | `AgentSidebarContribution` 按 `mode: 'work' | 'chat'` 过滤（`sidebarRegistry.ts:49` 的 `list(mode?)`），而每个 mode **只注册了一个贡献**（`builtinPylonWorkspace.ts:30` / `:60`）。容器 `.sidebar-sections` 本来就是 `contributions.map(...)`——**堆叠在结构上早已支持**，互斥只来自 `mode` filter 加那对页签。 |
| `order` 形同虚设 | 每个 mode 只有一个贡献，排序无从生效。 |
| `when` 从未被调用 | 契约里声明了可见性谓词，全仓无调用点。 |
| 标题来源分裂 | 页签标签硬编码在 `Sidebar.tsx:153`（`'工作' / '聊天'`），面板又各自画一份 `.sidebar-section-head` 并写死标题——注册表的 `label` **无人读取**，且「工作」二字在页签与分区头重复出现。 |
| 会话被人为分成两界 | `chatSessions = !workspaceId`、`workSessions = !!workspaceId` 是同一实体的补集，却被一对互斥页签隔开。 |
| 无归属的会话无处落脚 | 去掉「聊天」页签后，无 cwd 会话需要新的归处。 |

约束：

- ADR-0009 的全部几何契约不变：`--sheet-sidebar-track-width` 唯一宽度真值、唯一分割线、折叠 = 0 宽、共享几何类 `.sidebar`、左栏 clamp 160/520、`applyWorkspaceLayoutChange` 事务、`pylon-workspace-layout-v3` 持久化键。
- **不得改名** `sidebarMode ('workspace' | 'sheet' | 'none')`（ADR-0009 约束 1）。
- 插件 API 版本策略（`docs/说明书/Pylon-插件系统说明书-开发者版.md` §6.11.3）：minor 只做加法，破坏性变更升 major 并要求重写。

## 备选方案

| 方案 | 否决理由 |
| --- | --- |
| 加法演进：保留 `mode` 可选并新增可选 `region`，minor 升版 | 用户明确要求「怎么彻底怎么来」。留一个逐步废弃的 `mode` 会让契约里长期并存两套语义（同一个 `region: 'modules'` 的贡献还得回答 `mode` 填什么），而本项目既无插件也无用户，兼容成本为零。 |
| 只改第一方渲染：把 `.sidebar-sections` 做成区块栈 + mock 区块，插件契约原样不动 | 契约里的 `mode` 会继续是「互斥视图」语义，与新的堆叠渲染直接矛盾；下一轮仍要付同一笔迁移。 |
| 把模块区做成并列 tab（照抄右栏 `ContextPanelHost`） | 用户给的方向是**纵向堆叠的常驻区块**（参考图每块一行带图标与快捷键）。tab 天然解决「模块多了怎么办」，但代价是模块不可同屏，与该诉求相反。 |
| 把输入栏的模型/用量控件也搬进模块区 | 用户明确否掉：「模型，用量什么的还是在底部比较好」。本轮不动中控区布局。 |

## 决定

1. **分区取代模式**：`AgentSidebarMode ('work' | 'chat')` 由 `AgentSidebarRegion ('modules' | 'sessions')` 取代。左栏是两个分区的**纵向堆叠**，不是一对互斥视图：
   - `modules`（上）：常驻能力区块，`flex: 0 0 auto` + `max-height: 42%` + 自身滚动，默认可折叠；
   - `sessions`（下）：`flex: 1`，占满剩余高度，是左栏唯一的会话滚动态，默认不可折叠。
2. **区块外壳归宿主**：宿主渲染 `.sidebar-block` 外壳——标题（取自贡献的 `label`）、折叠钮、`headerActions`；贡献只画 `.sidebar-block-body`。贡献**不得**再画自己的标题。
3. **契约三处新增**：`collapsible` / `defaultCollapsed`（折叠默认值按分区给，`modules` 可折叠、`sessions` 不可）、`headerActions`（数据化的头部动作：`{ id, label, title?, icon?, disabled? }`，`icon` 复用 Workspace launch 的稳定图标键映射）。
4. **头部动作回派**：宿主渲染按钮，语义留在贡献。`first-party-react` 贡献挂载期经 `props.registerBlockActionHandler` 注册处理器；`isolated-surface` 贡献走 `host:input.blockAction`（带 `nonce`，重复点击可区分）。
5. **`order` 与 `when` 真正生效**：同一分区内按 `order` 纵向堆叠；`when(context)` 为假时区块整体不渲染。
6. **会话按 cwd 分组，无 cwd 组置底**：旧「聊天」面板并入会话区块，无 `workspaceId` 的会话落在**列表最底部的独立分组**（`无工作区`，复用既有 `.cwd-group` / `.cwd-group-sessions.is-collapsed` 折叠机制），不再占一个互斥页签。
7. **状态换形状、零存储键迁移**：`AgentWorkspaceState` 由 `{ sidebarMode }` 改为 `{ blockCollapsed: Record<string, boolean> }`。用**显式映射**而不是「塌陷 id 清单」，因为贡献可声明 `defaultCollapsed`：只记塌陷项的话，用户把默认塌陷的区块展开后无处落笔。收敛集中在 `normalizeBlockState`，旧形状（含旧 `sidebarMode`）一律回落空映射，持久化键不变。
8. **搜索归会话区**：搜索框只过滤会话，因此从整栏表头移入会话区顶部。
9. **清理 work/chat 轴的连带残留**：`workspaceMode` 这条轴被整条删除——它曾是「会话创建前置校验（`请先选择工作区`）+ 空态两套文案 + 渲染器套件门控」三件事，值来自 `sidebarMode`。删除后：创建无 cwd 会话成为合法意图（守卫删除）、空态收敛为一套文案、`MessageRenderContext` / `WorkbenchMountInput` 不再有该字段。**这是对 spec 154「中控区不碰」的已授权偏离**：只删失效语义分支，不重排中控区布局与样式（`ControlCenter.css` 一字未动）。
10. **插件 API 升 major 至 2.0**：`PYLON_PLUGIN_API_LATEST = '2.0'`，allowlist 追加 `'2.0'`（1.0–1.3 继续激活），manifest schema 的 `api` enum 同步。manifest 字段形状相对 1.3 不变，故 1.x 清单仍可解析；**引用旧 `mode` 的左栏贡献必须按 2.0 重写**。
11. **删除 CLI 命令 `layout.agent-sidebar.set`**，替代品 `layout.agent-sidebar.block.set { sheetId, blockId, collapsed }`（读改写 `blockCollapsed`，不整块覆盖）。
12. **删除 `.sidebar-status-bar` / `.sidebar-status-light` 死 CSS**（spec 154 未决问题 3 的答复）：全仓始终无渲染点，用户以「模块区放 4 个 mock」答复未决问题 1，状态灯不在其中。
13. **模块可展开成主区整页**（追加轮）：贡献可声明 `page: { title }`，点区块**标题**即把内容展开成该 Sheet 的整页——**替换聊天视图，不开新 Sheet**，Esc 或页面头部「返回」回到聊天。**标题与折叠由此分工**：标题管「打开整页」（未声明 `page` 时退化为折叠开关），折叠钮是独立控件只管折叠。页面渲染的是**同一个贡献组件**，只是 `presentation: 'page'`（区块里是 `'block'`），因此两种体量共享同一批会话/工作区数据与回调（接线抽到 `useSidebarContributionProps`，两处消费同一份）。开页状态 `activePageId` 与 `blockCollapsed` **同住 `AgentWorkspaceState`**，两者必须一起写（`patchSheetState` 是替换语义）。`activePageId` 指向已卸载或未声明 `page` 的贡献时回落 `null`，主区自然回到聊天——插件停用不会把主区锁死。
14. **左栏密度按「一行一条」收敛**（追加轮，用户点名「卡片占用高度太大、不同工作区之间大片空白、折叠按钮太显眼」）：组头 46px 两行（名称 + 9.5px 目录路径）压成 **26px 单行**，目录路径降级为 tooltip；会话行 48px 两行（名称 + 时间各一行）压成 **26px 单行**，时间右对齐；**时间与操作钮共用一个流内格子**交叉淡出（四个操作钮常驻占宽会把单行会话名挤成省略号）；组头的计数药丸退化为纯暗字；组内「暂无会话」提示删除（空组本身即说明）；会话列表缩进从 30px 收到 12px 并去掉虚线导引轨；折叠箭头（组头与区块头）默认 `opacity:.32`、悬停/聚焦才亮。

15. **模块栈统一为一维（追加轮）**：删除 `AgentSidebarRegion` 分区层——用户要求「把会话抽取成一个常开模块」。会话成为普通模块（`alwaysOpen: true`、`order: 900`），与插件模块走同一条路、同一套外壳/图标/点击语义/拖拽/显隐。左栏因此是**一个滚动容器**（`.sidebar-modules`），每个模块都是内容高度，不再有「其中一个模块自己滚动」的特例。搜索框从栏头移入会话模块**内部**（`onQueryChange` 仍由宿主持有，`when` 与其它模块看到的 query 不会漂移）。
16. **点击方案由模块声明**（用户归纳的三种）：`onTitleClick: 'expand'`（默认）标题展开/折叠；`'page'` 标题进入主区整页（此时宿主另给独立折叠钮，因为标题已被占用）；**「都要」= `expand` + 声明 `page`**——宿主在模块头自动补一个「打开」按钮。`onTitleClick: 'page'` 而无 `page` 在注册期即拒绝（点了没处去是死路）；`alwaysOpen` 与 `collapsible: true` 同时声明同样拒绝（不做静默取一）。
17. **模块可带图标**（`icon`，复用 Workspace launch 的稳定键映射，新增 `messages` / `clock` 键）；**未知键安全降级**。
18. **拖拽重排 + 显隐设置**：顺序与显隐是**跨 Sheet 的界面偏好**，落在独立 key `pylon-sidebar-modules-v1`（`sidebarModulePrefs`），**不写进 ADR-0009 锁定的 `pylon-workspace-layout-v3`**。拖拽用 pointer 事件 + 指针捕获（并做特性检测：jsdom 无 `setPointerCapture`，缺了它拖拽退化但仍可用），拖拽中只改渲染次序做预览、抬起才落库。设置入口在「设置 → 侧栏 → 模块」；`alwaysOpen` 的模块列出但开关禁用。
19. **工作区组头的折叠按钮删除**（用户要求），折叠功能保留——**整个组头就是开关**。相应地 `.cwd-group-arrow` 规则删除，CSS 契约测试钉住它不得复活。
20. **字号 token 收敛到会话同源**：模块标题、组名、模块行名统一用 `--sidebar-name-size`，次要文字统一用 `--sidebar-meta-size`（新增消费，fallback 11px）；预设值 `sidebarNameSize` 13→14、`sidebarGroupSize` 11→12。注意：**已应用的主题保存的是自己的值**，要看到放大需重新应用预设或直接调该字段（本次已在实机把 `sidebarNameSize` 调到 14 验证）。
21. **组间距与空态收紧**：`.cwd-group` 下边距 4px→1px，`.workspace-empty` 上边距 32px→8px。

## 后果

- 正面：左栏从「一次只看一个视图」变为「常驻能力 + 会话轨」的同屏结构；注册表的 `order` / `when` / `label` 三个字段第一次真正生效；模块区成为可插件化的扩展点（分区内的区块栈）。
- 正面：顺手消灭三处长期缺陷——`.search-input` 的 `flex:1` 在纵向 flex 里压掉声明高度（实测 17px vs 声明 36px，spec 154 阶段 3 已登记）、`.cwd-group-toggle` 的 `padding-right:62px` 手抄预留（加第三个动作会静默压字）、会话行隐藏操作钮在淡入窗口内仍吃点击（`elementFromPoint` 命中「会话设置」）。
- 负面：`AgentSidebarContribution` 是文档化的公开契约，`mode → region` 是破坏性变更，按策略升 major 至 2.0；任何引用旧 `mode` 的左栏贡献需重写。
- 负面：`WorkspacesPanel` / `ChatSessionsPanel` 两个文件被 `SessionsPanel` 取代并删除，`Sidebar.sections.test.tsx` / `WorkspacesPanel.test.tsx` 随之改名改写。
- 风险：模块区上限用 `max-height: 42%` 的百分比——依赖 `.sidebar` 有确定高度（布局层 flex 拉伸提供）。若将来左栏高度变为 auto，百分比会失效并退化为内容高度，模块区可能挤占会话区。
- 风险：`.sidebar-block-body` 之外，贡献若自行渲染固定高度的头部，会与宿主头部重复——契约已写明「贡献不得再画标题」，但无静态门禁强制，只能靠 review。

## 证据

- 契约：`src/plugin-runtime/sidebar/sidebarTypes.ts`（`AGENT_SIDEBAR_REGIONS` / `region` / `collapsible` / `headerActions`）、`sidebarBlockState.ts`（`normalizeBlockState` / `isBlockCollapsed` / `toggleBlockCollapsed`）、`sidebarRegistry.ts`（region 与 headerActions 校验、`list(region?)`）
- 宿主：`src/components/Sidebar.tsx`（两区 + 区块外壳 + 动作回派）、`src/components/sidebar/SessionsPanel.tsx`（工作区分组 + 底部无 cwd 组）、`src/components/sidebar/useBlockActionHandler.ts`
- 样式：`builtin.pylon-workspace/styles/components/Sidebar.css`（`.sidebar-region` / `.sidebar-block*` / `.search-input` 修复 / `.cwd-group-meta` 流内交叉淡出）
- 状态：`src/workspace-sheets/agentWorkspaceState.ts`、`src/plugins/core/sheet/builtinWorkspaceCommands.ts`（CLI 命令换代）
- 契约测试：`src/plugin-runtime/sidebar/__tests__/sidebarRegistry.test.ts`（region 校验 / order / headerActions 校验）、`src/components/__tests__/Sidebar.blocks.test.tsx`（堆叠顺序 / 标题来源 / `when` 门控 / 折叠落库 / 不可折叠 / 动作回派 / 损坏状态回落）、`src/components/__tests__/SessionsPanel.test.tsx`（含「无 cwd 组在最底部」）、`src/workspace-sheets/__tests__/workspaceStore.integration.test.ts`（新形状往返 + 旧 `sidebarMode` 零迁移）
- 版本：`src/plugin-runtime/packageManifest.ts`、`shared/pylon-plugin-manifest.schema.json`
- 实机：见 `.agents/records/` 对应开发记录的实测数值
