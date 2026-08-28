# Pylon 外观并行施工总契约

> **状态：INTEGRATED（A/B/C 已合并）**  
> 版本：0.9｜更新时间：2026-08-29  
> 本文是三条并行施工线路的公共契约。它不替代 [Pylon-外观设计施工书](./Pylon-外观设计施工书.md)，也不并入渲染引擎施工台账。可复制的启动 prompt、状态机和根 agent 复核闸门见 [派发 Prompt 与工作流](./Pylon-外观并行施工-派发Prompt与工作流.md)；所有未冻结的实现判断见 [自治冻结清单](./Pylon-外观并行施工-自治冻结清单.md)。

## 0. 使用规则

1. 子 agent 启动前必须完整阅读本文、[自治冻结清单](./Pylon-外观并行施工-自治冻结清单.md)、自己的线路文件、[Pylon-外观设计施工书](./Pylon-外观设计施工书.md) 和 [Pylon-插件系统说明书-开发者版](./Pylon-插件系统说明书-开发者版.md) 中与任务相关的章节。
2. 本契约中的“拥有”表示可写文件所有权；“只读”表示可以阅读、引用和运行验证，但不得编辑。三条线路之间不得共享可写文件。
3. 根 agent（本线程）拥有本文和原始施工书；子 agent 不得直接编辑这两份文件。每条线路只允许更新自己的线路文件中的进度、证据和例外登记。
4. 用户已确认 B-01～B-26 基线归类并授权完全自治；三个 agent 已通过 PREFLIGHT，B-18 已完成根复核。各线路只在根 agent 分配的隔离 worktree/branch 中按授权序列施工。
5. 发现需求需要改动不在所有权表中的文件、业务逻辑、数据流、接口契约或持久化格式时，立即停在当前卡片并向根 agent 提问；根 agent 无法在既有决策中裁决时，再向用户提问。不得自行扩展范围。
6. 不得另立中央：新增视觉能力必须挂接现有 `themeFieldDefs.ts`、`visualSemantics.ts`、`themeCssSnapshot.ts`、Preset Provider、Presentation Profile、Font Registry、Skin/Workbench Contract 或 UI Surface；不得创建平行 palette/font/preset/mode/Sheet registry、第二套字段映射或第二套 CSS 变量真值。
7. 子 agent 只运行自己文件所有权相关的 targeted lint/test/visual QA；不得主动运行全量测试或全仓库 build。测试只保护长期契约不变量，不测试 preset/plugin/Sheet 数量、顺序、固定文案、具体像素/颜色、CSS class、DOM 层数或当前组件树。

## 1. 权威依据与查证结论

### 1.1 权威文档

| 顺序 | 文档 | 用途 |
|---|---|---|
| 1 | `docs/Pylon-外观设计施工书.md` | 阶段 0 证据、B-01～B-26 候选、Q1～Q6 决策、最终基线归类草案。未被本契约明确覆盖的内容，以该文档为准。 |
| 2 | `docs/Pylon-插件系统说明书-开发者版.md` | Interface Mode、Presentation Profile、Renderer、UI Surface、作用域 CSS 和插件视觉语义边界。 |
| 3 | 本文及三份线路文件 | 并行开发时的文件所有权、公共契约、任务卡和交接规则；若与原始施工书冲突，以根 agent 先记录变更后执行。 |

### 1.2 已查证的架构边界

- `InterfaceModeContribution` 是宿主 Application Shell 契约；自定义 mode 已拍板为现有 `terminal-like`/`modern-gui` 下的命名视觉套件，不创建新 mode id、chrome、workbench、shell 槽位或新的 mode registry。
- 现有 `CustomPreset`/`PresetBundleV2` 可承载 theme、presentation 和 renderer 贡献；本施工包不得借外观改造修改其持久化格式、迁移格式或业务接口。
- 外部 Sheet/侧栏可以拥有自己的圆角、阴影、密度、图标、材质和断点；宿主只强制语义、可访问性、布局安全预算和必要的 surface 能力。
- 预览和源码核验已经发现 480px 请求宽度下主区/输入栏被固定左右栏挤压、mode 切换后 palette/background 未成套、terminal-like CLI 聚焦前后无可见变化等证据；完整证据仍以原始施工书 B-01～B-26 表为准。
- 当前工作树中已有的用户/其他并行改动属于受保护状态；三条线路不得覆盖、格式化或回滚。2026-08-28 最新保护快照包括：`src-tauri/Cargo.lock`、`issue.md`、`src/components/Sidebar.tsx`、`src/components/settings/CwdSettingsPanel.tsx`、`src/components/sidebar/ChatSessionsPanel.tsx`、`src/components/sidebar/WorkspacesPanel.tsx`、`src/domains/workbench/workbenchCommandFacade.ts`、`src/identityStore.ts`、`src/infrastructure/acp/sessionClient.ts`、`src/plugin-runtime/session-creation/sessionCreationTypes.ts`、`src/plugin-runtime/sidebar/sidebarTypes.ts`、`src/plugins/core/sessionCreation/builtinSessionCreation.ts`、`src/renderers/solid-workbench/SolidWorkbenchApp.solid.tsx`、`src/sessionPersistence.ts`、`src/sheets/agent-workbench/agentWorkbenchSessionCreation.ts`。其中 `src/components/chat/messageLookups.ts` 与 B-18 测试属于本外观任务；其余均视为外部改动。

## 2. 已冻结的六个总闸门

以下是 Q1～Q6 已拍板内容。它们是施工硬约束，不是三条线路重新讨论的候选方案。

| 闸门 | 冻结结论 | 对并行施工的直接约束 |
|---|---|---|
| Q1 视觉所有权 | **B：语义契约 + 几何自由** | 宿主强制语义 token、对比度、焦点、状态、布局槽位和安全边界；插件内部几何、材质、密度、图标和断点可自定义。 |
| Q2 语义与可访问性底线 | **A：WCAG + 完整状态底线** | 普通文本 ≥ `4.5:1`，大文本 ≥ `3:1`，非文本控件/边界 ≥ `3:1`；键盘控件有可见 `focus-visible`；hover/active/disabled/loading/空态/错误态有可辨识反馈；有可读名称；`prefers-reduced-motion` 下关闭非必要动效。内置和外部插件均适用。 |
| Q3 主题与 mode 优先级 | **B：mode/profile 完整 palette 套件** | 宿主每个 mode/profile 对背景、前景、边界和状态色成套应用；插件局部颜色在自己的 namespace 映射，不被宿主几何覆盖。 |
| Q3a 用户自定义 palette | **B：切换重置；另存全局自定义 mode** | 未保存散落覆盖不跨 mode 携带；保存的自定义套件不修改内置套件。 |
| Q3b 自定义 mode 身份 | **A：现有 mode 下的命名套件** | 运行时继续使用原宿主 mode id 和生命周期；不得创建新的 Interface Mode。 |
| Q4 布局与响应式 | **A：宿主预算 + 能力协商** | 先保护中心 workbench/消息列/CLI 输入的最小预算，侧栏/Sheet 按优先级收缩；插件声明最小宽度、可收缩/可堆叠能力和恢复入口；内部断点自由；收起不删除操作。 |
| Q5 尺度、密度与动效 token | **C：仅宿主强制、插件自愿采用** | 窗口壳、共享 primitive、内置组件和宿主契约表面消费语义 token；外部插件内部可使用自有 token/直接值。插件仍受 Q2/Q4；宿主模式专属直接值登记并静态扫描。 |
| Q6 状态与交互反馈 | **C：语义底线 + 插件自定义状态** | 宿主不规定统一 tone、glyph、动画、空态或操作显现配方；插件可自定义，但不得误标源状态，且必须满足 Q2。B-18 的 `cancelled → completed` 展示映射仍必须修正。 |

## 3. 范围边界（所有线路共用）

### 3.1 允许

- CSS、CSS 变量、主题/Presentation Profile 的表现字段映射；
- 组件 DOM 的表现结构、class、布局、可见状态反馈、hover/active/focus/disabled/loading/空态/错误态呈现；
- 过渡、动画、焦点环、响应式断点、字号缩放下的排版表现；
- 纯展示映射和 ARIA/焦点处理，前提是输入/输出数据契约和业务语义不变；
- 新增只读的视觉 QA fixture、computed-style 断言和截图/录屏脚本，且放在本线路拥有的测试文件中。

### 3.2 禁止

- 后端调用、业务逻辑、领域状态机、数据流、命令行为、会话生命周期；
- `CustomPreset`、`PresetBundleV2`、localStorage/persistence schema、迁移版本和接口契约；
- 新增或修改 `InterfaceModeContribution` 的生命周期、注册表、mode id、workbench 类型或 shell 槽位；
- 为了视觉统一删除操作、快捷键、语义标签、ARIA 名称或已有恢复入口；
- 修改其他线路拥有的文件，或对整个 `src/` 执行会重写他线文件的格式化/排序命令；
- 将外部插件内部几何差异自动判为缺陷；只有违反 Q2/Q4 或宿主契约时才整改。

### 3.3 特殊高风险文件

以下文件只读，除非根 agent 明确下达单文件授权：

`src/App.tsx`、`src/store.ts`、`src/customPresets.ts`、`src/domains/theme/presetReducer.ts`、`src/application/transactions/activateInterfaceMode.ts`、`src/application/transactions/applyPresentationProfile.ts`、`src/plugin-runtime/interface-mode/interfaceModeTypes.ts`、`src/plugin-runtime/pluginActivationContext.ts`、`src/domains/workbench/workbenchSkinContract.ts`。

如果 B-18 或 Q3 palette 修复看起来必须改这些文件，先停工提问；不得以“只是 UI”自行突破。

## 4. 公共契约（跨线路 ABI）

### 4.1 主题与 token

- `src/index.css` 的全局语义变量由线路 B 独占维护；线路 A/C 只能消费，不得重命名或删除已有变量。
- 已存在的 token 命名族包括 `--ui-space-*`、`--ui-radius-*`、`--shadow-*`、`--motion-*`、`--text`、`--border` 以及插件文档中列出的 `--surface-*`、`--state-*`、`--font-*` 语义变量；具体值由现有 `index.css`/ThemeSettings/Profile 链路提供，组件不得硬编码。
- DF-02 已冻结宿主默认尺度基线：spacing `4/8/12/16/24/32/48px`；radius `none=0px`、`xs=2px`、`sm=4px`、`md=6px`、`lg=8px`、`pill=999px`；motion `fast=120ms`、`standard=180ms`、`slow=260ms`，缓动使用现有 easing；阴影仅使用现有 `--shadow-soft`/`--shadow-raised`/`--shadow-float`。不得新增 `xl` 或改写这些数值；插件可通过 namespaced token/settings 使用自己的值。
- DF-04 已冻结宿主默认 type ABI：`interface` xs/sm/md/lg = 11/12/13/14px、行高 1.25、默认 `--font-system`；`content` = 12/13/15/17px、行高 1.5，terminal-like 默认 `--font-mono-default`、modern-gui 默认 `--font-system`；`code` = 10/11/12/13px、行高 1.55、默认 `--font-mono-default`。组件只消费角色 token；插件通过现有 FontContributionRegistry/Presentation Profile/renderer settings 注入自己的角色值。125%/150% 按角色整体放大。
- 线路 A/C 若缺少语义 token：在自己的线路文件添加“契约请求”（用途、消费组件、拟议名称、回退值），不要直接编辑 `index.css`。
- 宿主模式专属直接值必须在所属线路的“例外登记”中写明 selector、值、原因、替代 token 和验收范围；外部插件内部直接值不建立统一例外清单。

### 4.2 palette、scheme 与 mode

- 运行态只识别现有 `data-interface-mode="terminal-like|modern-gui"` 和 `data-ui-scheme="dark|light"`；不得添加自定义 mode id。
- mode/profile 切换的视觉目标是完整 palette 套件，不是只换几何 token；线路 B 负责宿主 palette 投影，线路 A/C 负责消费后的表现验证。
- “完整 palette”指最终解析后的宿主 12 角色完整，不要求每个 `PresentationProfileContribution` 或插件 payload 物理声明全部角色；Profile 继续是经 `themeFieldDefs` 验证的 delta，缺失角色由当前 mode/preset 安全 fallback 补齐。
- 自定义 mode 是现有 mode 下的命名套件；不能借 CSS 或组件外观创建第三种 shell。
- DF-03p 已冻结：内置/自定义 preset 的显式角色色板优先保留；缺失或低于 Q2 的单个角色只回退到该 preset 绑定的 mode/scheme 安全值，不跨套件借色。旧 Theme-only preset 通过运行时 adapter 推导缺失角色，不改 `CustomPreset`/`PresetBundleV2` 持久化格式；Presentation Profile 局部透明表面只能从当前角色派生。
- DF-03a/DF-03b 已冻结：四套宿主默认 palette 和 ThemeSettings→角色映射复用现有 `VISUAL_SEMANTIC_TOKENS`/`themeFieldDefs`/`themeCssSnapshot` 链路；不得另建 palette registry 或第二套字段映射。精确角色表与对比度数据以 [自治冻结清单 DF-03a](./Pylon-外观并行施工-自治冻结清单.md) 为唯一 ABI；其中色值是宿主 fallback，preset/plugin 显式角色合格时优先。
- 公共角色/变量名冻结为：`surface.canvas → --surface-canvas`、`surface.panel → --surface-panel`、`surface.raised → --surface-raised`、`content.text → --content-text`、`content.muted → --content-muted`、`stroke.default → --stroke-default`、`accent → --accent`、`state.success → --state-success`、`state.warning → --state-warning`、`state.danger → --state-danger`、`state.focusRing → --state-focus-ring`、`connector.default → --connector-default`。新增名称只可加入现有 `VISUAL_SEMANTIC_TOKENS`；旧变量通过同一投影链路成为兼容 alias，组件不得另造局部同义变量。

### 4.3 布局

- 中心 workbench、消息列和 CLI 输入是 Q4 的优先预算，`terminal-like` 在所有回归中先验收。
- 侧栏/Sheet 收缩只改变呈现占位，操作必须保留在既有 launcher、键盘或恢复入口中。
- 插件内部断点、圆角、阴影和密度不要求与宿主相同；只要不越出宿主槽位、不破坏内容预算和 Q2 底线。
- DF-05a/DF-05b 的默认预算和阅读宽度通过现有 Workspace/Sheet 结构与作用域 CSS 变量表达，不新增 layout registry 或 `kind → width` 映射；`WORKSPACE_SIDEBAR_COLLAPSED_WIDTH` 继续来自 `themeCssSnapshot.ts`。

### 4.4 状态、焦点与动效

- 不要求跨插件唯一 tone/glyph；要求源状态不误标、状态有可读名称和可辨识反馈。
- `cancelled`、`completed`、`queued`、`running`、`waiting`、`failed`、`unknown` 的标签/ARIA 不能被错误合并为另一语义；多个状态共享视觉 tone 是允许的。
- 所有键盘控件必须有可见 `focus-visible`；CLI 可使用父行 `focus-within`、边线、accent 或其他终端语言，但聚焦前后 computed 值必须可测不同。
- 插件动画节奏可自定义；非必要动效在 `prefers-reduced-motion: reduce` 下必须关闭。
- DF-06/DF-08/DF-09 已冻结：状态至少有可见 label/等价文本、正确 ARIA 和一种非颜色线索；宿主 focus-visible 默认 `2px + 2px offset`；running/waiting/loading 可使用 token 动效，终态默认静态。
- DF-07 已冻结：宿主复用现有 `VISUAL_SEMANTIC_TOKENS.surface`/Skin surface 的三层层级并单层单材质 recipe；插件内部材质/层级自由，但不得穿透宿主 modal/z-index 或违反 Q2/Q4。

### 4.5 DOM/selector ABI

- 跨线路优先使用现有 DOM、class、`data-interface-mode`、`data-ui-scheme` 和状态属性；不为了样式重命名已有语义节点。
- 线路 B 若确实需要新增 class/data 属性，必须使用 `data-pylon-*` 或已有组件命名空间，并在 B 线路文件的“公共契约发布快照”记录属性名、生产组件、允许值和 CSS 消费线路；根 agent 确认后 A/C 才能消费。
- 线路 A/C 不得自行猜测或创建 B 线路状态属性；需要新状态钩子时提交契约请求。伪类（`:hover`、`:focus-visible`、`:focus-within`、`:disabled`）优先于新属性。
- DOM/ARIA 改动只能增加表现/可访问性信息，不得改变事件处理、条件渲染业务分支、数据结构或操作语义。
- DF-01 已冻结：command suggestion 的交互节点统一落地为 `button type="button"`；保留现有 click、Enter、Arrow 选择结果和 `cmd-item` 视觉 class 兼容，不改建议数据、过滤条件或提交逻辑。线路 B 拥有 `InputBar.tsx` 纯 DOM/ARIA 改动，线路 A 只拥有 `InputBar.css`。

## 5. 源码地图（已核对的施工入口）

### 5.1 宿主壳、标题栏和全局样式

- `src/App.tsx`：根布局、mode contribution、shell surface 挂载（只读）。
- `src/index.css`：全局主题变量、focus-visible、reduced-motion（线路 B 拥有）。
- `src/plugins/product/packages/builtin.pylon-shell/styles/App.css`：标题栏、窗口壳、mode 选择器和宿主布局（线路 A 拥有）。
- `src/plugins/product/packages/builtin.pylon-shell/styles/components/Settings.css`：Settings 覆盖层/GUI 表面（线路 C 拥有）。
- `src/components/Settings.tsx`：Settings DOM/交互语义（线路 B 拥有，CSS 由线路 C 拥有）。
- `src/components/WorkspaceTitlebar.tsx`：标题栏结构与 tab/窗口按钮（只读；样式由线路 A 调整）。

### 5.2 会话、CLI、工具和状态

- `src/components/chat/ChatView.tsx`：消息/工具/推理 DOM 与展示映射入口（线路 B 拥有；renderer CSS 由线路 A 拥有）。
- `src/components/chat/InputBar.tsx`：CLI 输入 DOM/状态入口（线路 B 拥有；CSS 由线路 A 拥有）。
- `src/components/chat/messageLookups.ts`、`src/components/chat/chatRowPipeline.ts`：展示行状态查找/管线（线路 B 拥有，仅允许纯展示映射修正）。
- `src/domains/tool/status.ts`：工具视觉状态单一真值（线路 B 拥有；不得改领域业务状态机）。
- `src/components/chat/toolIndicatorMotion.ts`：工具 indicator 动效类（线路 B 拥有）。
- `src/renderers/solid-workbench/chat/ToolInvocationCard.solid.tsx`、`ToolCard.solid.tsx`：Solid 工具/状态呈现（线路 B 拥有）。
- `src/plugins/product/packages/builtin.pylon-renderers/styles/components/chat/ChatView.css`、`InputBar.css`：消息、工具、推理、CLI 表现（线路 A 拥有）。

### 5.3 Sheet、侧栏和插件表面

- `src/plugins/product/packages/builtin.pylon-workspace/styles/components/Sidebar.css`：侧栏宽度、会话操作和折叠表现（线路 A 拥有）。
- `src/plugins/product/packages/builtin.pylon-workspace/styles/components/PrismSheet.css`：共享 Sheet 壳（线路 C 拥有）。
- `src/plugins/product/packages/builtin.pylon-workspace/styles/sheets/OverviewSheetView.css`、`RuntimeSheetView.css`、`browser/BrowserSheet.css`、`file/FileSheet.css`、`gateway/GatewaySheet.css`、`history/HistorySheet.css`、`search/SearchSheet.css`：内置 Sheet 内部样式（线路 C 拥有）。
- `src/components/sheets/**`、`src/sheets/**`：Sheet DOM/业务行为（只读；除非根 agent 单独授权）。

### 5.4 主题、Profile 和插件契约

- `src/themeFieldDefs.ts`、`src/domains/theme/visualSemantics.ts`、`src/domains/theme/themeCssSnapshot.ts`、`src/plugins/core/renderer/builtinPresentationProfiles.ts`：主题字段真值、公共 token 名、CSS 投影和内置 profile（线路 B 拥有；只允许表现字段/投影调整，不得另立平行真值）。
- `src/customPresets.ts`、`src/domains/theme/presetBundle.ts`、`src/domains/theme/presetReducer.ts`、`src/store.ts`：preset/persistence/store（只读）。
- `src/plugin-runtime/interface-mode/interfaceModeTypes.ts`、`src/plugin-runtime/pluginActivationContext.ts`、`src/domains/workbench/workbenchSkinContract.ts`：插件/宿主契约（只读）。

## 6. B-01～B-26 线路归属

“主线路”表示谁负责产生改动；“消费线路”表示谁必须在自己的视觉回归中验证，不代表可编辑对方文件。

| 候选 | 主线路 | 消费/联验线路 | 说明 |
|---|---|---|---|
| B-01 | B | A、C | 宿主/共享 token 收敛；插件内部直接值不因存在本身整改。 |
| B-02、B-03、B-17 | B | A、C | palette/scheme 成套投影；A 优先验证 terminal-like，C 验证 modern-gui/Sheet。 |
| B-04、B-05、B-16 | B | A、C | 宿主 radius/motion/disabled token；插件内部保持自由。 |
| B-06、B-10、B-12、B-23 | C | B | modern-gui 表面、Settings CSS、Sheet shell 和断点协商；不强制插件内部同构。 |
| B-07、B-09、B-11、B-13、B-14、B-20、B-24、B-26 | A | B、C | terminal-like 优先的壳、CLI、侧栏、标题栏、焦点和对比度呈现。 |
| B-08、B-15、B-18、B-19、B-21、B-22、B-25 | B | A、C | 状态/ARIA/Settings 语义、空态、辅助文字和纯展示映射；A/C 只消费结果。 |

## 7. 文件所有权矩阵

### 7.1 线路 A：terminal-like 宿主与 CLI

**可写（仅这些产品文件）**

- `src/plugins/product/packages/builtin.pylon-shell/styles/App.css`
- `src/plugins/product/packages/builtin.pylon-workspace/styles/components/Sidebar.css`
- `src/plugins/product/packages/builtin.pylon-renderers/styles/components/chat/ChatView.css`
- `src/plugins/product/packages/builtin.pylon-renderers/styles/components/chat/InputBar.css`
- 线路 A 文件中明确新增的、位于上述目录旁的 A 前缀测试/QA 文件。

**只读**：本文第 5 节全部源码地图，尤其线路 B 的 token/状态文件和线路 C 的 Sheet/Settings CSS。  
**禁止**：任何 TSX/TS 业务或状态文件、`src/index.css`、主题/preset/store、Sheet CSS、另两条线路文件。

### 7.2 线路 B：共享主题、语义、状态与可访问性

**可写（仅这些产品文件）**

- `src/index.css`
- `src/domains/theme/visualSemantics.ts`
- `src/themeFieldDefs.ts`
- `src/domains/theme/themeCssSnapshot.ts`
- `src/plugins/core/renderer/builtinPresentationProfiles.ts`
- `src/components/Settings.tsx`
- `src/components/chat/ChatView.tsx`
- `src/components/chat/InputBar.tsx`
- `src/components/chat/messageLookups.ts`
- `src/components/chat/chatRowPipeline.ts`
- `src/components/chat/toolIndicatorMotion.ts`
- `src/domains/tool/status.ts`
- `src/renderers/solid-workbench/chat/ToolInvocationCard.solid.tsx`
- `src/renderers/solid-workbench/chat/ToolCard.solid.tsx`
- 线路 B 文件中明确新增的、带 B 前缀的测试/QA 文件。

**只读**：线路 A/C 所有产品文件，所有 store/preset/interface-mode/runtime 文件。  
**特殊限制**：B-18 只可改纯展示映射；若需要改领域状态归一化、store、持久化或后端契约，必须停工提问。

### 7.3 线路 C：modern-gui、Settings 表面与 Sheet/插件表面

**可写（仅这些产品文件）**

- `src/plugins/product/packages/builtin.pylon-shell/styles/components/Settings.css`
- `src/plugins/product/packages/builtin.pylon-workspace/styles/components/PrismSheet.css`
- `src/plugins/product/packages/builtin.pylon-workspace/styles/sheets/OverviewSheetView.css`
- `src/plugins/product/packages/builtin.pylon-workspace/styles/sheets/RuntimeSheetView.css`
- `src/plugins/product/packages/builtin.pylon-workspace/styles/sheets/browser/BrowserSheet.css`
- `src/plugins/product/packages/builtin.pylon-workspace/styles/sheets/file/FileSheet.css`
- `src/plugins/product/packages/builtin.pylon-workspace/styles/sheets/gateway/GatewaySheet.css`
- `src/plugins/product/packages/builtin.pylon-workspace/styles/sheets/history/HistorySheet.css`
- `src/plugins/product/packages/builtin.pylon-workspace/styles/sheets/search/SearchSheet.css`
- 线路 C 文件中明确新增的、带 C 前缀的测试/QA 文件。

**只读**：线路 A/B 所有产品文件、Sheet/Settings TSX 业务行为、plugin runtime/interface mode 文件。  
**特殊限制**：`PrismSheet.css` 的宿主 Sheet shell 必须消费公共语义 token；各 Sheet 内部可以保留插件/领域专属几何，但必须满足 Q2/Q4。

## 8. 并行操作与交接协议

1. 每个 agent 启动首个回复必须写出：已阅读的文档、当前分支/工作树状态、将要编辑的文件列表、不会编辑的文件列表。
2. agent 只能在自己的所有权内工作；不能为了“顺手修复”编辑邻线文件。发现跨线需要时，向根 agent 发出“契约请求”，包含文件、原因、最小改动、替代方案和阻塞卡号。
3. 根 agent 负责将契约请求转化为公共契约变更。公共 token 名、mode 语义、状态语义、ARIA 规则和布局槽位一旦冻结，子 agent 不得私自改名。
4. 三条线路不得互相 cherry-pick 或覆盖工作树；根 agent 负责逐线审阅 diff、运行跨模式回归并合并。不得执行 `git reset --hard`、`git clean`、覆盖式 checkout 或全仓库格式化。
5. 每个完整功能/任务卡完成后，agent 必须先运行所属文件的 targeted 检查，再只 stage 白名单文件、核对 `git diff --cached --name-only` 并创建一个独立 commit；随后直接继续下一卡。线路文件在最终交接时一次性追加 commit、验证、证据和遗留风险，不要求例行汇报。
6. 根 agent 发现两个 agent 同时触碰同一文件时，立即暂停后启动的那条线路；不得通过手工拼接解决所有权冲突。
7. agent 无法裁决时先问根 agent；根 agent 无法从 Q1～Q6、原始施工书和本契约裁决时，再向用户提问并将答案写入第 4 节决策记录。
8. 子 agent 只运行自己文件所有权相关的 targeted lint/test/visual QA；不得主动运行全量 `test`、`check:frontend`、`check:all`、全仓库 `build` 或其他会扫描/改写无关线路的命令。三线完成后由根 agent 统一执行集成级全量检查。
9. 长程自治必须由根 agent 用 `[AUTONOMY-OPEN]` 明确授权卡片序列、scope、worktree 和 branch；agent 只能顺序推进，不得自行扩展任务。除真正 `BLOCKED` 或整线完成外不发送例行消息；根 agent 可用 `[AUTONOMY-PAUSE]` 随时暂停。
10. 子 agent 只为“长期稳定的契约不变量”新增自动化测试；禁止为了提高覆盖率或固定当前实现而新增脆弱测试。预设/插件/Sheet/状态的数量、数组顺序、完整枚举快照、固定文案、固定 CSS class、具体像素/颜色、DOM 层数和截图不是长期单测对象；这些由 schema/conformance 或视觉 QA 证据验证。

## 9. 统一验收协议

- 模式优先级：`terminal-like` 先验收，再覆盖 `modern-gui`；每个模式都要测 dark/light。
- 视口：`1280×720`、`900×720`、`680×720`、`480×720`，并保留标准 `1738×819` 对照。
- 字号：默认、至少 125%、150%（环境可用时）；记录横向溢出、截断、按钮可达性和中心输入宽度。
- 状态：空态、长标题、长词、多语言、reasoning 四态、工具七态、错误/取消/输出、Settings 打开态、hover/focus/disabled/loading。
- scheme/profile：`terminal-like` + `terminal-classic`、`modern-gui` + `modern-gui`，dark/light，至少一次自定义 preset 应用后切换。
- 可访问性：computed contrast 数值、Tab 顺序、`focus-visible` 可见性、状态可读名称、reduced-motion 下 `animation/transition`。
- 布局：中心 workbench/CLI 不得因侧栏固定宽度归零；收起后必须能通过既有 launcher、键盘或恢复入口取回。
- 静态范围：每条线路结束前检查 `git diff --name-only` 只包含自己的所有权表；不得以截图主观印象替代数值/DOM/Computed Style 证据。

## 10. 代码开工闸门

用户已经授权派发，但根 agent 在发送 `[CODE-GATE-OPEN]` 前，必须完成并在本文末尾记录：

- [x] 用户确认 `docs/Pylon-外观设计施工书.md` 1.7.1 的 B-01～B-26 最终归类；
- [x] 阶段 1 的重点 token、色板、字体层级、动效档位和可访问性加严项已拍板；实现级默认已由根 agent 冻结；
- [x] [自治冻结清单](./Pylon-外观并行施工-自治冻结清单.md) 的 DF-01～DF-10（含扩展项）已记录；
- [x] 公共 token 名、palette 角色、布局槽位、状态/ARIA 规则形成冻结快照，并通过“不另立中央”审计；
- [x] 三份线路文件的可写路径没有重叠；
- [x] 每条线路的首卡依赖、验证命令和失败升级路径已明确；
- [x] 工作树中的既有用户改动已登记，派发提示中明确不得触碰；
- [x] 根 agent 已向三个子 agent 发送“只读主契约 + 单线所有权 + 先问后改”的启动消息，并分别收到 `[PREFLIGHT-OK]`；
- [x] 根 agent 完成 B-18 diff 复核：纯展示映射、targeted ESLint/Vitest/git diff check 均通过；测试保护长期状态语义，不固定数量/顺序/文案/像素，纳入当前交付批次。

**当前状态：A/B/C 三线已完成并合并到当前分支；隔离 worktree/branch 已清理。根集成检查已完成，后续只按本契约维护 ABI 和回归证据。**

## 11. 变更记录

| 时间 | 变更 | 原因/影响 |
|---|---|---|
| 2026-08-28 | 初版并行施工总契约 | 将 Q1～Q6、B-01～B-26 和源码地图重整为三条互斥线路；当前仅准备，不启动 agent。 |
| 2026-08-28 | 用户授权开始派发 | 三条线路并行进入 PREFLIGHT；未收到逐线 `[PREFLIGHT-OK]` 前不得修改产品代码。 |
| 2026-08-28 | 用户确认聊设计期间同步开工 | 三线通过 PREFLIGHT 后进入有界执行；允许实现不依赖阶段 1 新数值的样式/ARIA/布局卡片，未决 token/色板/字体/动效值不得由 agent 自行决定。 |
| 2026-08-28 | 首批有界代码闸门 | A-02、B-18、C-02 获 `scope=bounded`；三线仅可消费现有 token/已冻结语义，按卡片 checkpoint 回报，未决数值相关卡片保持 BLOCKED。 |
| 2026-08-28 | 自治冻结暂停 | 用户要求先预先拍板所有会阻塞完全自治的判断；三线收到 `[AUTONOMY-PAUSE]`。B-18 保留最小纯展示 diff待根复核，A/C 未产生产品改动。 |
| 2026-08-28 | DF-01 交互控件语义冻结 | 用户选择原生语义控件；command suggestion 固定使用 `button type="button"`，B 允许纯 DOM/ARIA 修改，A 继续只改 CSS；总契约版本升至 0.2。 |
| 2026-08-28 | DF-02 尺度 token 冻结 | 用户选择 4px 网格 + 少量语义档位；冻结当前 `index.css` spacing/radius/shadow/motion 数值，不新增 `xl` 档位；总契约版本升至 0.3。 |
| 2026-08-28 | DF-03p 预设兼容策略冻结 | 用户选择“预设拥有完整角色色板，宿主验证并逐角色同套件回退”；旧 Theme-only preset 运行时 adapter 补齐，不改持久化格式；总契约版本升至 0.4。 |
| 2026-08-28 | DF-04 字体/排版冻结 | 用户选择三角色字体阶梯；冻结 interface/content/code 的字号别名、默认字体族、行高和缩放规则；总契约版本升至 0.5。 |
| 2026-08-28 | 现有权威源审计 | 确认 themeFieldDefs、visualSemantics、themeCssSnapshot、Preset Provider、Presentation Profile、Font Registry、Skin/Workbench Contract、Workspace/UI registries 为现有真值；删除新增 paletteResolver/平行 registry 倾向。 |
| 2026-08-28 | DF-07 材质层级冻结 | 用户选择宿主三层上限；宿主复用现有 surface token/Skin surface，单层单一材质 recipe，插件内部材质自由；总契约版本升至 0.6。 |
| 2026-08-28 | 设计冻结完成 | 用户确认 DF-04 字体和 DF-07 材质；根 agent 冻结实现级默认并完成“不另立中央”审计；总契约版本升至 0.7。 |
| 2026-08-28 | B-18 根复核通过 | 展示 lookup 排除带输出 cancelled/canceled 被提升为 completed；targeted ESLint/Vitest/diff check 通过，测试仅保护长期语义不变量。 |
| 2026-08-28 | 基线确认与自治开放 | 用户确认 B-01～B-26 归类并要求三线自治；版本升至 0.8，采用隔离 worktree、一完整功能一 commit、无例行汇报。 |
| 2026-08-29 | 三线完成并合并 | A/B/C 按隔离 branch/worktree 完成全部任务卡；根 agent 完成审核、C-04 集成复测、类型修正、构建与定向测试；删除三条临时 worktree/branch，保留提交历史；版本升至 0.9。 |
