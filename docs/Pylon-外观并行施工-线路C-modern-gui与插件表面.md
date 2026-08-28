# 并行施工线路 C：modern-gui、Settings 表面与 Sheet/插件表面

> **状态：AUTONOMY-OPEN（隔离 worktree 施工）**  
> 线路 owner：root/appearance_line_c  
> 公共契约：[Pylon-外观并行施工-总契约](./Pylon-外观并行施工-总契约.md)  
> 设计依据：[Pylon-外观设计施工书](./Pylon-外观设计施工书.md)

> **测试约束**：子 agent 只运行本线路文件所有权对应的 targeted lint/test/visual QA；不得主动运行全量 `test`、`check:frontend`、`check:all` 或全仓库 `build`。三线合并后的全量检查由根 agent 执行。

> **测试长期性约束**：只测试不会随新增 preset/plugin/Sheet 而失效的宿主 slot、Q2/Q4、可达性和恢复入口不变量；不测试数量、顺序、固定文案、具体像素/颜色、CSS class、DOM 层数或当前 Sheet 列表。表面层级/断点用 computed-style/viewport QA。

> **权威源/插件约束**：本线路不得创建 material、palette、typography、layout 或 Sheet registry；不得把字号、字体族、颜色、间距、圆角、阴影、blur 或动效时长硬编码为新的组件真值。宿主 shell 只消费现有 `visualSemantics`/`themeCssSnapshot`/Skin surface 输出；插件内部继续通过作用域 CSS、Presentation Profile 或 renderer settings 自定义。

## 0. 线路使命

线路 C 负责 `modern-gui` 的表面层级、Settings 的材质与可读性、共享 Sheet 壳，以及内置 Sheet 的响应式实现。它必须尊重 Q1/Q5：宿主 Sheet shell 和契约表面消费公共语义 token，插件/Sheet 内部可以保留自己的圆角、阴影、密度、材质和断点；不可把外部插件的有意差异改成宿主皮肤。

本线路主责问题：B-06、B-10、B-12、B-23；同时联验线路 B 的 palette/contrast/focus 和线路 A 混合 CSS 的 modern-gui 冒烟结果。

## 1. 启动前必读

按顺序阅读：

1. `docs/Pylon-外观并行施工-总契约.md` 全文；
2. `docs/Pylon-外观设计施工书.md` 的 0.1～0.7、1.2～1.4、1.5、1.7.1、1.8、1.9、1.16～1.22、4.2；
3. `docs/Pylon-插件系统说明书-开发者版.md` 的 Interface Mode、UI Surface、Sheet、Presentation Profile、作用域 CSS 和视觉 token 章节；
4. `src/App.tsx`、`src/components/Settings.tsx`、`src/components/sheets/**`、`src/sheets/**`（只读，确认 DOM/slot/行为）；
5. 本线路所有权内的 Settings/Sheet CSS 全文，以及线路 B 的 token/palette/focus 契约、线路 A 的 `App.css`（只读）。

启动首条消息必须列出：已读文件、当前工作树既有改动、计划编辑文件、明确不编辑文件。

## 2. 可写文件所有权

### 2.1 允许编辑

- `src/plugins/product/packages/builtin.pylon-shell/styles/components/Settings.css`
- `src/plugins/product/packages/builtin.pylon-workspace/styles/components/PrismSheet.css`
- `src/plugins/product/packages/builtin.pylon-workspace/styles/sheets/OverviewSheetView.css`
- `src/plugins/product/packages/builtin.pylon-workspace/styles/sheets/RuntimeSheetView.css`
- `src/plugins/product/packages/builtin.pylon-workspace/styles/sheets/browser/BrowserSheet.css`
- `src/plugins/product/packages/builtin.pylon-workspace/styles/sheets/file/FileSheet.css`
- `src/plugins/product/packages/builtin.pylon-workspace/styles/sheets/gateway/GatewaySheet.css`
- `src/plugins/product/packages/builtin.pylon-workspace/styles/sheets/history/HistorySheet.css`
- `src/plugins/product/packages/builtin.pylon-workspace/styles/sheets/search/SearchSheet.css`
- 线路 C 新增的、文件名带 `C-` 前缀的测试/QA 文件。

### 2.2 只读/禁止

- 线路 A 的 `App.css`、`Sidebar.css`、renderer `ChatView.css`、`InputBar.css`：只读；不得在混合 CSS 中插入 modern-gui 规则。
- 线路 B 的 `index.css`、主题/Profile、Settings/Chat/状态 TSX/TS：只读；需要 token 或 ARIA class 只能提契约请求。
- `src/components/Settings.tsx`、`src/components/sheets/**`、`src/sheets/**`、`src/App.tsx`：业务/DOM 行为只读；焦点语义由线路 B 处理。
- 所有 store/preset/runtime/interface-mode/backend 文件：禁止编辑；不得全仓库格式化。

## 3. 公共契约消费规则

1. `PrismSheet.css` 的共享 Sheet shell 属于宿主契约表面，必须消费线路 B 冻结的语义 surface/space/radius/shadow/focus token；各具体 Sheet 的内部内容区可保留 plugin/领域专属直接值。
2. Settings terminal-like 与 modern-gui 可以使用不同材质、radius、shadow 和 blur；两者合成后的文本/控件/边界仍必须满足 Q2 对比度和 focus-visible。
3. 不创建第三种 mode、第三套 shell 生命周期或新的 Sheet 注册 API。CSS 只消费现有 `data-interface-mode`、`data-ui-scheme`、既有 slot/class 和现有 UI surface 能力。
4. Q4 采用宿主预算 + 能力协商：Sheet 内部断点可自定义，但不能越出宿主槽位、把中心 workbench/CLI 压成不可用宽度，或让收起后的能力失去既有恢复入口。
5. Q6 允许每个 Sheet/插件自定义状态 tone、glyph、动画、空态和操作显现；C 只确保共享 shell 与本线路内置 Sheet 不违反 Q2/Q4，不建立跨插件统一状态配方。
6. 任何新全局 token、plugin runtime capability 或 TSX 行为需求都必须提契约请求，不能直接越界编辑。

## 4. 任务卡

### C-01｜modern-gui 与 Settings 表面层级

- **归属**：modern-gui 宿主
- **文件**：`src/plugins/product/packages/builtin.pylon-shell/styles/components/Settings.css`
- **问题映射**：B-06、B-10、B-25
- **优先级/工作量**：P0 / M
- **依赖**：线路 B 的 palette/text/focus token；线路 B 的 Settings DOM/ARIA class 只读消费
- **改动描述**：
  1. 让 Settings 遮罩、导航、header、content、preview pane 的可见层级可由 surface/background/border/shadow/blur 的 computed 值区分；保留 terminal-like/modern-gui 两种有意材质差异。
  2. 清理宿主共享层的直接值，消费线路 B token；局部 GUI 玻璃/阴影仅在本线路例外登记。
  3. 为 header 说明、关闭按钮、导航项、危险操作和 disabled/loading 状态提供不依赖 hover 的可测反馈；不改变 Settings DOM 行为。
- **验收标准**：
  - `terminal-like`/`modern-gui` × dark/light 下，Settings 文本 `>=4.5:1`，大文本 `>=3:1`，按钮/边界 `>=3:1`；记录合成后的 computed 前景/背景。
  - 每个可见 Settings surface 至少通过 background、border、shadow 或 blur 中一项与相邻 surface 形成可测差异；不得因透明叠加导致底层文字穿透并降低对比度。
  - Tab/focus-visible、disabled、危险操作和关闭入口在无 hover 状态下均有可辨识 computed 反馈；CSS 不隐藏线路 B 新增的 ARIA/焦点节点。
  - 125%/150% 字号和 `480/680/900px` 下 Settings 内容不出现未声明的横向溢出；若保留 `min-width`，必须记录与 Q4 宿主预算的关系。
  - 不编辑 `Settings.tsx`、store、preset、runtime 或线路 A 文件。

### C-02｜共享 PrismSheet 壳与 surface contract

- **归属**：共享 Sheet 宿主壳
- **文件**：`src/plugins/product/packages/builtin.pylon-workspace/styles/components/PrismSheet.css`
- **问题映射**：B-01、B-06、B-12、B-23
- **优先级/工作量**：P0 / M
- **依赖**：DF-02 已冻结的 space/radius/shadow/motion 档位及线路 B 的 surface/focus token；Q4 宿主预算
- **改动描述**：
  1. 把重复的 modern-gui 外壳值集中到共享 Sheet shell 的语义 token；保留具体 Sheet 内部的 plugin/领域样式自由。
  2. 明确 Sheet header、tab、body、empty/loading/error、close/focus 和收起占位的宿主边界；不改变 Sheet 注册、导航、关闭和数据行为。
  3. 为窄屏/字号放大提供不会越过宿主槽位的 shell 保护，具体内容区断点交给各 Sheet 文件。
- **验收标准**：
  - 8 个内置 Sheet 的外壳 background/border/radius/shadow 由共享 shell 或语义 token 提供；不再复制同一 modern-gui 壳值到每个文件。
  - Sheet 打开、活动 tab、关闭、disabled/loading/error/empty 和 focus-visible 在 dark/light 下均有 computed 可测反馈，满足 Q2 对比度。
  - `480/680/900/1280px` 下 shell 不产生超出宿主 viewport 的横向 scrollWidth；中心 workbench/CLI 预算由宿主布局保留。
  - 外部插件可以不使用本 shell 的内部几何；本文件只规定宿主槽位/语义表面，不增加 plugin runtime API。

### C-03｜各内置 Sheet 的响应式与内容预算

- **归属**：内置 Sheet 内部；对外部插件仅提供 conformance 参考
- **文件**：本线路 2.1 中列出的 7 个 Sheet CSS 文件
- **问题映射**：B-11、B-12、B-23、B-14
- **优先级/工作量**：P0 / L
- **依赖**：C-02；线路 B 的 token/focus 结果；Q4 最小内容预算数值冻结
- **改动描述**：
  1. 保留 Sheet 各自有意断点，但统一遵守宿主声明的最小内容预算、可收缩/可堆叠能力和恢复入口。
  2. 对 Browser/File/Gateway 等带侧栏的 Sheet，明确侧栏收缩、堆叠或滚动策略；对 Overview/History/Search/Prism 等列表 Sheet，明确长词/长标题/空态/错误态的内容保护。
  3. 不把所有 Sheet 强制改成同一个断点；只消除“侧栏挤出 viewport、内容 clientWidth 归零、操作无恢复入口”的情况。
- **验收标准**：
  - 每个 Sheet 在 `480/680/900/1280px` 实际 viewport、默认/125%/150% 字号下均记录侧栏宽度、主体 `clientWidth`、scrollWidth、折叠/堆叠结果和恢复入口。
  - 任一 Sheet 不得令宿主 viewport `scrollWidth > clientWidth`；主体关键内容不得归零；收起的侧栏/子面板可通过现有 launcher、Tab 或恢复入口取回。
  - 长标题、长词、多语言和空/错误/加载内容不会覆盖 header、tab、关闭和主要操作；不修改组件数据、路由、请求或操作条件。
  - 每个文件中的内部直接值只要属于插件/领域内部就可保留；共享 shell/slot 值必须引用公共 token 或在本文件例外登记。

### C-04｜modern-gui/Sheet 跨主题回归与插件 conformance 证据

- **归属**：modern-gui 优先，覆盖内置 Sheet
- **文件**：只新增 C 前缀 QA/test 文件或更新本线路文件第 6 节
- **问题映射**：C 线路全部
- **优先级/工作量**：P1 / M
- **依赖**：C-01～C-03、线路 B 的 palette/focus 结果、线路 A 的混合 CSS 回归
- **改动描述**：建立逐 Sheet 的 viewport/scheme/profile/focus/contrast 证据；外部插件 fixture 只检查 Q2/Q4，不检查内部几何是否宿主化。
- **验收标准**：
  - 每个内置 Sheet 都有 dark/light、modern-gui/terminal-like（若可见）、四个窄视口和字号放大的记录；失败输出具体 selector/尺寸/对比度。
  - 外部插件 conformance fixture 只断言 slot 安全、最小内容预算、恢复入口、Q2 对比度/focus/state/reduced-motion；不断言 radius/shadow/spacing 相等。
  - `git diff --name-only` 只命中 C 所有权表和 C 前缀新增文件。

## 5. Sheet surface/断点例外登记（执行时填写）

| 文件/selector | 直接值或断点 | 属于宿主 shell 还是插件内部 | 保留原因 | Q2/Q4 证据 | 状态 |
|---|---|---|---|---|---|
| `PrismSheet.css` `.prism-card/.prism-section/.prism-form` | `radius:12px`、`shadow:0 6px 18px …` | Prism 插件内部 | Q1/Q5 允许插件/领域自有几何；共享 shell 已改用语义 token | 由 C-04 visual QA 检查对比度、溢出与焦点，不比较内部几何 | 保留，待集成回归 |
| 内置 Sheet 内容区（Overview/Runtime/Browser/File/Gateway/History/Search） | 各自断点/列表行几何 | 内置插件内部 | Q4 允许内部断点；共享根壳和侧栏预算由 PrismSheet.css 统一提供 | C-03 已记录 480/680/900 实际 viewport 下 root `scrollWidth=clientWidth`；侧栏按既有折叠入口收缩 | 已通过结构检查 |

## 6. 契约请求（执行时填写）

| 请求 | 影响文件 | 为什么现有 CSS/slot 无法表达 | 最小替代方案 | 根 agent 决定 | 状态 |
|---|---|---|---|---|---|
| C-04 dark `--stroke-default` alias 观测 | B 线路 `index.css`/`themeCssSnapshot.ts`（C 只读） | dark scheme 下 C worktree 基线 alias 仍解析浅色边框；C 无权修改公共投影 | 等 B-01/B-04 合并后重新采集 computed token 与对比度；C 不局部改 `--border` | B-01/B-04 合入 C 临时集成树后，dark modern-gui computed `--stroke-default=#6F7A95`，Sheet/Settings 边界跟随公共角色；C 无越权改动 | **已通过集成复测** |

## 7. 交接记录（执行时填写）

| 卡片 | 改动文件 | 未改动的越界文件 | 验证命令/结果 | 公共契约变更 | 遗留风险/待根 agent 决策 |
|---|---|---|---|---|---|
| AUTONOMY-OPEN | — | 本线路白名单 | PREFLIGHT/只读审计已完成 | 无 | 按 C-02 → C-01 → C-03 → C-04 自治施工；一功能一 commit |
| C-02 | `styles/components/PrismSheet.css` | Settings/Sheet TSX、A/B、runtime/store/preset 未改 | `check:first-party-styles` 通过；`git diff --check` 通过 | 共享 Prism Sheet 壳改消费 `--surface-*`/`--stroke-*`/`--ui-*`/`--shadow-*`，无新增 token | commit `75463e1d`；待根集成审阅 |
| C-01 | `styles/components/Settings.css` | Settings.tsx、公共 token/ARIA、A/B 文件未改 | `radiusContract.test.ts` 3/3；`check:first-party-styles`、`git diff --check` 通过；浏览器 light/dark 与 480px overflow 采样 | modern Settings root/header/nav/body/preview 改用语义 surface/radius/shadow；窄屏 set-row wrap、mode grid 单列 | commits `659a3e39`, `bf3af466`, `48e5162b`；dark 对比度依赖 B token 集成 |
| C-03 | 7 个内置 Sheet CSS + PrismSheet.css | Sheet/Settings TSX、A/B、runtime/store/preset 未改 | targeted Sheet sidebar tests 16/16；`check:first-party-styles`、`git diff --check` 通过；浏览器 480/680/900/desktop root geometry 采样 | 共享根壳集中到 PrismSheet.css；各 Sheet 保留内部断点并加 Q4 内容换行/预算保护 | commit `7dd15abe`；File/B-13 titlebar narrow 依赖宿主 A 线 |
| C-04 | 仅视觉 QA，不新增脆弱单测 | 全部越界文件未改 | B-01/B-04 合入后的浏览器采样：modern-gui dark/light 7 个内置 Sheet 在 1280 请求视口均 `layout scrollWidth=clientWidth`；dark `--stroke-default=#6F7A95`，light `#7986A1`；480 请求视口 Settings dialog `scrollWidth=clientWidth`；既有 light 818/618/436 窄屏证据保持通过 | 无公共契约变更；消费 DF-03/DF-05/DF-07/DF-08/DF-09 | **已完成；待根分支合并 A/B/C 后做一次最终矩阵复跑** |

### 7.1 C-04 集成复测证据（2026-08-28）

| mode/scheme | 请求视口→实际 innerWidth | 宿主结果 | 公共角色/对比度证据 |
|---|---:|---|---|
| modern-gui/light | `1280×720 → 1164×655` | Overview、Runtime、Browser、File、Gateway、History、Search 的可见根节点均未超出 `.layout`；根 `scrollWidth=1164`、`clientWidth=1164` | `--surface-canvas=#F5F7FC`、`--content-text=#1B2030`、`--stroke-default=#7986A1`、`--connector-default=#6B7892`；B-04 角色计算满足 text/muted `≥4.5:1`、非文本边界 `≥3:1` |
| modern-gui/dark | `1280×720 → 1164×655` | 同一 7 个 Sheet 的可见根节点均未超出 `.layout`；根 `scrollWidth=1164`、`clientWidth=1164` | `--surface-canvas=#181C27`、`--content-text=#F7F8FC`、`--stroke-default=#6F7A95`、`--connector-default=#6F7A95`；B-04 角色计算满足 text/muted `≥4.5:1`、非文本边界 `≥3:1` |
| modern-gui/dark Settings | `480×720 → 436×655` | `dialog width=428`；Settings body `scrollWidth=188`、`clientWidth=188`，无横向溢出；宿主边界消费 `--stroke-default` | dialog computed surface 为 dark overlay，文字 `rgb(247,248,252)`；Settings domain rail/body border `rgb(111,122,149)`，对应 `#6F7A95` |

复测说明：C worktree 通过 merge commit `fb52baca` 临时消费 B-01～B-04 的公共 ABI；最终根分支应分别合并 A/B/C 原线路提交。标题栏在 480/680 的 modern-gui 规则由 A-01 rework 负责，C 不复制或局部覆盖该 CSS。

## 8. 不确定事项处理

- 需要编辑 Settings/Sheet TSX、App.tsx、plugin runtime、Interface Mode 或 store/preset 文件时，先停工问根 agent。
- 如果某个 Sheet 的内部断点与其他 Sheet 不同，按 Q4 先检查宿主预算、槽位和恢复入口；不要仅因数字不同判为缺陷。
- 如果层数、玻璃、阴影或圆角是否“太多”无法用 computed surface、对比度、溢出或可达性证据判断，记录为待根 agent/用户决策，不自行改成统一平面。
