# 并行施工线路 A：terminal-like 宿主与 CLI

> **状态：AUTONOMY-OPEN（隔离 worktree 施工）**  
> 线路 owner：root/appearance_line_a  
> 公共契约：[Pylon-外观并行施工-总契约](./Pylon-外观并行施工-总契约.md)  
> 设计依据：[Pylon-外观设计施工书](./Pylon-外观设计施工书.md)

> **测试约束**：子 agent 只运行本线路文件所有权对应的 targeted lint/test/visual QA；不得主动运行全量 `test`、`check:frontend`、`check:all` 或全仓库 `build`。三线合并后的全量检查由根 agent 执行。

> **测试长期性约束**：只测试不会随 preset/plugin/Sheet 扩展而失效的语义、安全和布局不变量；不测试数量、顺序、固定文案、具体像素/颜色、CSS class、DOM 层数或当前组件树。视觉数值使用 computed-style/contrast/viewport QA。

> **权威源/插件约束**：本线路不得创建字体、palette、layout 或状态中央，也不得把字号、字体族、颜色、间距、圆角、阴影或动效时长硬编码为新的组件真值；只消费现有 `visualSemantics`/`themeCssSnapshot`/Presentation Profile/Font Registry 输出。插件合法贡献优先，宿主数值仅为 fallback。

## 0. 线路使命

以 `terminal-like` 为第一验收对象，收敛宿主壳、标题栏、侧栏、消息/工具表面和 CLI 输入的视觉表现。线路 A 只改表现层，不改业务逻辑、数据流、preset/persistence、Interface Mode 注册或插件行为。`modern-gui` 不是本线路的主设计目标，但本线路拥有的混合 CSS 文件包含两模式选择器，任何改动都必须完成 modern-gui 冒烟回归。

本线路负责的核心问题：B-07、B-09、B-11、B-13、B-14、B-20、B-24、B-26；同时消费线路 B 的 B-01～B-05、B-16～B-19、B-25 公共契约结果。

## 1. 启动前必读

按顺序阅读：

1. `docs/Pylon-外观并行施工-总契约.md` 全文；
2. `docs/Pylon-外观设计施工书.md` 的 0.1～0.7、1.2、1.5、1.7.1、1.8、1.10～1.22、4.2；
3. `docs/Pylon-插件系统说明书-开发者版.md` 的 Interface Mode、Presentation Profile、Renderer、UI Surface 和视觉 token 章节；
4. `src/App.tsx`、`src/components/WorkspaceTitlebar.tsx`、`src/components/chat/ChatView.tsx`、`src/components/chat/InputBar.tsx`、`src/plugins/product/packages/builtin.pylon-workspace/styles/components/Sidebar.css` 的对应 DOM/class（只读）；
5. 本线路所有权文件的当前完整内容，以及线路 B 的 token/状态契约文件（只读）。

启动首条消息必须列出：已读文件、当前工作树既有改动、计划编辑文件、明确不编辑文件。

## 2. 可写文件所有权

### 2.1 允许编辑

- `src/plugins/product/packages/builtin.pylon-shell/styles/App.css`
- `src/plugins/product/packages/builtin.pylon-workspace/styles/components/Sidebar.css`
- `src/plugins/product/packages/builtin.pylon-renderers/styles/components/chat/ChatView.css`
- `src/plugins/product/packages/builtin.pylon-renderers/styles/components/chat/InputBar.css`
- 线路 A 新增的、文件名带 `A-` 前缀的测试/QA 文件；新增文件必须位于上述产品包或既有测试目录，且不覆盖其他线路文件。

### 2.2 只读/禁止

- `src/index.css`、`src/themeFieldDefs.ts`、`src/domains/theme/**`、`src/plugins/core/renderer/builtinPresentationProfiles.ts`：由线路 B 拥有；缺 token 只能提契约请求。
- `src/plugins/product/packages/builtin.pylon-shell/styles/components/Settings.css`、`src/plugins/product/packages/builtin.pylon-workspace/styles/components/PrismSheet.css` 和全部 Sheet CSS：由线路 C 拥有。
- 所有 TSX/TS 状态、store、preset、runtime、后端文件：只读。尤其不得编辑 `src/store.ts`、`src/customPresets.ts`、`src/domains/theme/presetReducer.ts`、`src/application/transactions/**`、`src/plugin-runtime/**`。
- 不得编辑总契约、原始施工书或其他线路文件；不得全仓库格式化。

## 3. 公共契约消费规则

1. 全局 token 只消费线路 B 已冻结的名字；不得删除、重命名或修改其值。
2. 线路 A 可以在自己拥有的 selector 内新增 `--pylon-terminal-*` 局部变量，但不得把局部变量冒充全局语义 token；新增全局 token 必须提交契约请求。
3. `terminal-like` 的硬边、低阴影、线性连接线和等宽字体是允许的模式语言，不因与 modern-gui 不同而整改；但文本/非文本边界仍必须满足 Q2 对比度。
4. 工具状态的分类、label、ARIA 和错误映射由线路 B 负责；线路 A 只为已有 `data-tool-state`/tone/class 提供视觉表现，不在 CSS 中重新推断状态。
5. 侧栏/标题栏收缩只能改变占位；不得通过 `display:none` 隐藏后让操作失去既有 launcher、键盘或恢复入口。
6. 任何 mode 专属直接值必须在本文件第 6 节登记 selector、值、原因、替代 token、影响模式和验证证据。外部插件内部直接值不在此登记。

## 4. 任务卡

### A-01｜宿主壳与标题栏的 terminal-like 视觉基线

- **归属**：terminal-like（兼顾混合文件中的 modern-gui 冒烟）
- **文件**：`src/plugins/product/packages/builtin.pylon-shell/styles/App.css`
- **问题映射**：B-01、B-11、B-13、B-14、B-17、B-24
- **优先级/工作量**：P0 / M
- **依赖**：总契约 0.8、DF-01～DF-10 已冻结；根 agent 已为本线路分配隔离 worktree 并发 `[CODE-GATE-OPEN]` + `[AUTONOMY-OPEN]`
- **改动描述**：
  1. 将标题栏、tab 区、窗口壳和宿主布局的共享值改为线路 B 冻结的语义 token；保留 terminal-like 的硬边/线宽作为登记例外。
  2. 在窄视口和字号放大时，保证活动 tab、模式切换和窗口系统按钮仍在布局预算内；文本允许 ellipsis，但不可把 tab region 挤成零宽。
  3. 对 hover/focus/disabled/overflow 状态提供不依赖颜色单一变化的可测反馈；不改变按钮数量、点击行为或快捷键。
- **验收标准**：
  - `terminal-like` + dark/light 在 `1738/1280/900/680/480×720` 下，布局 `scrollWidth <= clientWidth`；若浏览器系统按钮造成外框差异，记录实际 viewport 与原因。
  - 480px 场景 tab region `clientWidth > 0`，活动 tab 与 mode/窗口按钮均可通过 Tab 到达；长标题使用 ellipsis 或可滚动机制，不产生横向溢出。
  - CSS 共享 spacing/radius/shadow/motion/type 值均引用已冻结 token；每个保留直接值都出现在例外登记中。
  - blur/focus、enabled/disabled、overflow 前后至少有一项 computed `color/background/border/opacity/outline/transform` 可测变化；禁止仅依赖 hover 才存在的唯一操作入口。
  - modern-gui 同尺寸冒烟无新增 scrollWidth、tab 不可达或颜色对比度回退。

### A-02｜CLI 输入的 focus-within、队列与窄屏表现

- **归属**：terminal-like
- **文件**：`src/plugins/product/packages/builtin.pylon-renderers/styles/components/chat/InputBar.css`
- **问题映射**：B-11、B-14、B-24、B-26
- **优先级/工作量**：P0 / M
- **依赖**：DF-01 已冻结为 `button type="button"`；DF-02 已冻结现有 motion/scale token；B 线路负责 InputBar.tsx 纯 DOM/ARIA；A-01 的宿主内容预算规则
- **改动描述**：
  1. 为 `.input-row:focus-within` 或等价父级状态增加独立可见层；保留 textarea 的原生输入行为和现有快捷键。
  2. 统一输入行、建议列表、binding/命令/错误/队列提示的层级与间距；不改变提示出现条件和提交逻辑。
  3. 在 `480/680/900px` 和 125%/150% 字号下保护可输入区域，必要时让辅助区收缩或换行，但不把 textarea 宽度压成 0。
- **验收标准**：
  - textarea blur → focus 前后，父行至少一项 computed `outline/border/box-shadow/background/::before/::after` 有非零且可见差异；差异在 dark/light 下均达到 Q2 非文本边界 `3:1`。
  - `focus-visible` Tab 路径可到达 textarea、建议项、错误关闭/恢复入口；焦点环不被 `overflow:hidden` 裁切。
  - 480px 实际 viewport 下 textarea `clientWidth > 0`，输入行不产生横向滚动；125%/150% 字号下提示文本不覆盖提交按钮。
  - command suggestion 的键盘语义由 B 线路的 `button type="button"` 提供；A 只验证 CSS focus/hover/disabled 表现，不在本线路新增或修改 TSX。
  - `prefers-reduced-motion: reduce` 下输入行、建议和队列提示无非必要 animation/transition。

### A-03｜terminal-like 消息、工具和连接线表面

- **归属**：terminal-like（ChatView.css 混合选择器需做两模式回归）
- **文件**：`src/plugins/product/packages/builtin.pylon-renderers/styles/components/chat/ChatView.css`
- **问题映射**：B-01、B-05、B-07、B-15、B-17、B-19、B-20、B-21、B-24
- **优先级/工作量**：P0 / L
- **依赖**：线路 B 的 palette、状态 label/ARIA 和 motion 约束；不依赖线路 B 修改同一文件
- **改动描述**：
  1. 只消费线路 B 的宿主语义 palette/token，修正 terminal-like 工具连接线、状态边界、辅助文字和空态表面的可读性。
  2. 保持插件/renderer 可自定义 glyph/tone 的契约；不在 CSS 中增加第二套状态归一化。
  3. 为复制、工具对象、输出展开、reasoning 展开等已有操作补齐非 hover 的 focus/触屏呈现，不改变操作条件。
- **验收标准**：
  - 普通文本前景/背景对比度 `>=4.5:1`，大文本 `>=3:1`，承担边界/状态辨识的非文本线条 `>=3:1`；每个测量记录 computed 前景、背景和公式结果。
  - 工具七态/unknown 的可读名称来自 DOM/ARIA 现有状态；CSS 不把 `cancelled`、`failed`、`completed` 重新映射。
  - hover 移除后，键盘 focus-visible 和触屏媒体条件仍能发现复制/展开/工具对象入口；不以 `opacity:0` 隐藏唯一入口。
  - 有 sessionId 且无消息时，空态区域存在可辨识的文本、glyph、边界或操作提示；具体品牌造型可由 terminal-like 决定。
  - running/waiting 静态表现可接受，但必须有非颜色辨识线索；reduced-motion 下不得出现非必要动画。

### A-04｜侧栏宽度、会话操作和 terminal-like 收缩顺序

- **归属**：terminal-like 宿主侧栏
- **文件**：`src/plugins/product/packages/builtin.pylon-workspace/styles/components/Sidebar.css`
- **问题映射**：B-09、B-11、B-13、B-14、B-24
- **优先级/工作量**：P0 / L
- **依赖**：Q4 宿主预算和恢复入口契约；若现有 DOM 没有恢复入口，立即提问，不新增业务入口
- **改动描述**：
  1. 将固定 `min-width/width` 改为宿主预算允许的弹性/收缩表现；优先保护中心 terminal workbench 与 CLI。
  2. 会话 gear/delete 等操作在 hover、focus-within、触屏/无 hover 条件下具有明确且不冲突的显示规则；不改变点击目标和删除确认逻辑。
  3. 对字号放大和长会话标题使用 ellipsis、换行或滚动，不把主区压成不可用窄条。
- **验收标准**：
  - `480/680/900/1280px` 实际 viewport 下，中心消息区和 CLI 均 `clientWidth > 0`；侧栏收缩时既有恢复入口可 Tab 到达。
  - 无 hover 时，键盘 Tab 可聚焦 gear/delete，`focus-visible` 可见；触屏能力（`(hover:none)`）下操作不是唯一依赖 hover 的隐藏控件。
  - 会话长标题不造成父行 `scrollWidth > clientWidth`；标题 ellipsis/换行行为在 125%/150% 字号下可测。
  - 侧栏直接值按 token 或例外登记；不修改 Sidebar 组件的会话数据、删除、排序和导航逻辑。

### A-05｜线路 A 视觉回归与交接证据

- **归属**：terminal-like 优先
- **文件**：只新增 A 前缀 QA/test 文件或更新本线路文件第 7 节
- **问题映射**：A 线路全部
- **优先级/工作量**：P1 / M
- **依赖**：A-01～A-04
- **改动描述**：建立可重复的 computed-style/viewport/键盘证据，记录 terminal-like 先、modern-gui 后的对照；不新增业务 fixture，不改其他线路测试文件。
- **验收标准**：
  - 每个已完成卡片都有文件 diff 清单、视口、scheme、profile、字号、状态和对比度数据。
  - `git diff --name-only` 只命中本线路所有权表和 A 前缀新增文件。
  - 若发现 token/状态/Sheet 契约缺口，记录契约请求而非越界编辑。

## 5. 验收顺序

1. `terminal-like + terminal-classic + dark`：先完成 A-01～A-04 的结构和 focus/宽度证据；
2. `terminal-like + light`：复核 palette、工具线和辅助文字对比度；
3. terminal-like 自定义 preset：确认应用套件不创建新 mode id，样式仍由现有 mode 选择器消费；
4. `modern-gui + dark/light`：对 `App.css`、`ChatView.css`、`InputBar.css` 做冒烟回归，不能出现新增溢出、不可达或对比度回退；
5. 在根 agent 合并线路 B/C 后重跑完整 Q2/Q4 矩阵。

## 6. terminal-like 例外登记（执行时填写）

| selector/文件:行 | 直接值 | 允许原因 | 替代 token/不适用原因 | 验收证据 | 状态 |
|---|---|---|---|---|---|
| `App.css` `.sheet-tab` / `@media(max-width:1100px)` | `160px` / `120px` tab 宽度 | terminal-like 标签密度与长标题 ellipsis；保留 tab 操作 | 无等价语义尺度 token；属于宿主标签轨道例外 | A-01 viewport matrix：tab region 在 1738/1280/900/680/480 均 `>0` | 已验收 |
| `Sidebar.css` `@media(max-width:1100px)` | `min-width:200px` | DF-05a 中等视口左栏可收缩范围下限 | 布局预算数值，非 spacing token | A-04 matrix：900 请求（inner 818）左栏约 `229px`，主区 `360px` | 已验收 |
| `Sidebar.css` `@media(max-width:760px)` / `max-width:520px` | 左栏 `42px`、主区 `360px`/`280px` 最小 | DF-05a emergency 内容预算与现有折叠控制轨道 | `--workspace-sidebar-collapsed-width` 提供 42px；主区最小值为宿主布局硬底线 | A-04 matrix：680 inner 618 主区 `447px`；480 inner 436 主区 `306px` | 已验收 |
| `App.css` touch media `--pylon-terminal-touch-target` | `44px` 命中区 | DF-02d 粗指针/无 hover 可操作目标命中下限 | 无公共 touch token；线路局部 namespaced 变量，不改变视觉尺寸语义 | CSS media 静态核验；默认 Edge 指针为 fine，需设备级 coarse 复测 | 待设备复测 |
| `App.css` host layer selectors | z-index `50/70/71/90/100` | DF-07a 宿主 shell overlay、modal、error、titlebar 层级 | 层级 ABI 直接值，无 spacing/radius 替代 | computed titlebar z-index `100`；窄屏/现代 GUI 冒烟无遮挡 | 已验收 |

## 7. 交接记录（执行时填写）

| 卡片 | 改动文件 | 未改动的越界文件 | 验证命令/结果 | 截图或 computed 证据 | 遗留风险/契约请求 |
|---|---|---|---|---|---|
| AUTONOMY-OPEN | — | 本线路白名单 | targeted 审计已完成；仅按卡片运行定向检查 | — | 按 A-02 → A-01 → A-04 → A-03 → A-05 自治施工；一功能一 commit |
| A-02 | `builtin.pylon-renderers/styles/components/chat/InputBar.css` | TSX/TS、B/C、store/preset/runtime/backend | `vitest InputBarBindingGate.test.tsx` 8/8；`check:first-party-styles` 28 files；`git diff --check` 通过 | terminal-like CLI blur→focus：父行 border `rgb(127,142,163)` → `rgba(0,0,0,.22)`，outline `1.818px solid rgb(136,192,208)`，box-shadow `0 0 0 2px`；480 inner 436 textarea `239px` | scheme/preset 显式值仍由 B 线路 DF-03p 回退；设备级 coarse hit-area 需复测 |
| A-01 | `builtin.pylon-shell/styles/App.css` | TSX/TS、B/C、store/preset/runtime/backend | titlebar targeted tests 3 files/11 tests；ownership check 通过；独立 commits `ac8b24b3`, `d30d44ab` | terminal-like titlebar/region client widths（inner）：1738→`1580/515`、1280→`1164/306`、900→`818/146`、680→`618/150`、480→`436/85`；modern-gui rework 后 680→`118`、480→`27`；layout scrollWidth=clientWidth | touch media 需真实 coarse 设备复测；GUI 窄屏修复追加 commit `eff8ef1d` |
| A-04 | `builtin.pylon-workspace/styles/components/Sidebar.css` | TSX/TS、B/C、store/preset/runtime/backend | Sidebar/Sheet collapse tests 2 files/3 tests；ownership check 通过；commit `296870d4` | terminal-like inner 818：sidebar `229px`、main `360px`、right `229px`；inner 618：sidebar `42px`、main `447px`；inner 436：sidebar `42px`、main `306px`、textarea `261px`；layout scrollWidth=clientWidth | 42px 视觉轨道下 Sidebar 内容密度依赖现有 DOM；Q4 右栏收缩仍由 flex/host state 协同 |
| A-03 | `builtin.pylon-renderers/styles/components/chat/ChatView.css` | TSX/TS、B/C、store/preset/runtime/backend | `ToolConnector/AgentEmptyState/spinnerPreviewTerminal` 3 files/8 tests；ownership check、diff check 通过；commit `2b71e6ed` | status label/ARIA 保留（completed/failed/running/waiting/queued/unknown）；copy button focus-visible computed opacity `1`、outline `1.818px solid rgb(136,192,208)`；terminal tool body connector border consumes `--connector-default` fallback | MessageRow/messageRendererConsumption tests在隔离 junction 环境因 `vscode-oniguruma/onig.wasm?url` denied，需根 agent 集成环境复跑；最终 palette 对比度依赖 B DF-03a/03p |
| A-05 | 线路 A 白名单 + 本线路文档 | 其他线路/高风险文件 | 聚合 targeted 命令共 9 files/30 tests 通过；`check:first-party-styles` 通过；`git diff --check` 通过；提交序列：`b82dd4de`, `ac8b24b3`, `d30d44ab`, `296870d4`, `2b71e6ed`, `eff8ef1d` | terminal-like dark/light 及 modern-gui viewport/computed 证据见上；reduced-motion 规则静态存在（运行环境 `prefers-reduced-motion=false`）；scheme light/dark focus delta 已测 | 需根 agent 合并 B palette 后重跑 Q2 contrast、预设切换和真实 reduced-motion/coarse 设备；MessageRow wasm 环境问题见 A-03 |

## 8. 不确定事项处理

- 如果需要改 `ChatView.tsx`、`InputBar.tsx`、`Sidebar` TSX、`index.css` 或任一主题/preset/runtime 文件，先问根 agent。
- 如果问题是“是否必须每个状态使用不同颜色/glyph”，按 Q6 C 默认允许共享，只有 Q2 可辨识失败才升级。
- 如果根 agent 无法从总契约、原始施工书和自治冻结清单裁决，暂停当前卡片，由根 agent 向用户提问并把答案记录到决策记录。
