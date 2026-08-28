# Pylon 外观设计施工书

> **状态：三线已完成｜已合并｜集成复核通过（2026-08-29）**  
> 更新时间：2026-08-28  
> 本文是 Pylon 外观设计探讨的独立文档，不并入渲染引擎施工台账体系。

> **并行施工指针（INTEGRATED）**：B-01～B-26 基线归类、设计决策、A/B/C 三线施工及 C-04 集成复测均已完成，并合并到当前分支。见 [并行施工总契约](./Pylon-外观并行施工-总契约.md)、[派发 Prompt 与工作流](./Pylon-外观并行施工-派发Prompt与工作流.md)、[自治冻结清单](./Pylon-外观并行施工-自治冻结清单.md)、三份线路文档。

## 0. 总览

### 0.1 目标

在不改变业务逻辑、数据流、接口契约和功能行为的前提下，收敛 Pylon 两种整体外观模式（`terminal-like`、`modern-gui`）的视觉语言，使后续施工可以按文件、组件、状态和可判定验收项执行。必要时可以有意识地打破现有视觉契约，但必须在阶段 1 的议题决策和第 4 节决策记录中明确记录。

### 0.1.1 开发优先级约束（已确认）

`terminal-like` 是本项目的重点开发模式。后续施工顺序、示例数据、视觉回归和验收证据均优先覆盖 `terminal-like`；`modern-gui` 在共享基础收口后跟进，不得以 modern-gui 的局部效果替代 terminal-like 的验收。该约束不改变两种模式都必须可用的范围要求。

### 0.2 范围边界

**允许修改**

- CSS、CSS 变量、主题/Presentation Profile 的表现字段映射（不改变字段语义和接口契约）。
- 组件的 DOM 外观结构、class、布局表现、可见状态反馈以及 hover/active/focus/disabled/loading 的呈现。
- 过渡、动画、焦点环、空态、错误态、响应式断点和字号缩放下的排版表现。

**禁止修改**

- 业务逻辑、状态机语义、数据流、持久化格式、后端调用、接口契约和用户可执行功能。
- 为了“看起来更好”而删除或改变现有操作、快捷键、语义标签或可访问名称。

### 0.3 当前采用的判定维度

以下六项均已有冻结的工程判定方法；摘要见第 2 节，完整 ABI 见自治冻结清单：

1. 视觉一致性：色彩、间距、圆角、阴影、字体是否 token 化并全局统一。
2. 视觉层级与可读性：信息主次、对比度、留白是否符合阅读路径。
3. 控件状态完备性：hover、active、focus、disabled、loading、空态、错误态是否都有明确呈现。
4. 动效与节奏：过渡时长、缓动曲线、是否克制且不遮蔽任务信息。
5. 暗色/亮色适配：两种 interface mode 在两种 UI scheme 下均可成立。
6. 可访问性：对比度、键盘可达性、字号缩放和 reduced-motion 行为。

若后续增补判定维度，必须同时写出可复现的判定方法，并追加到第 4 节。

### 0.4 任务卡总表

| 卡号 | 主题 | 归属模式 | 优先级 | 状态 |
|---|---|---|---|---|
| A-01 | 宿主壳与标题栏 terminal-like 基线 | terminal-like | P0 | 已合并 |
| A-02 | CLI focus、队列与窄屏表现 | terminal-like | P0 | 已合并 |
| A-03 | 消息、工具与连接线表面 | terminal-like | P0 | 已合并 |
| A-04 | 侧栏与宿主收缩顺序 | terminal-like | P0 | 已合并 |
| A-05 | 线路 A 视觉回归证据 | terminal-like | P1 | 已合并 |
| B-01 | 语义 token、scheme 与 palette 投影 | 共享 | P0 | 已合并 |
| B-02 | 状态、ARIA 与纯展示映射 | 共享 | P0 | 已合并（含 B-18） |
| B-03 | Settings dialog 与焦点路径 | 共享 | P0 | 已合并 |
| B-04 | focus、reduced-motion 与 conformance | 共享 | P1 | 已合并 |
| C-01 | modern-gui 与 Settings 表面层级 | modern-gui | P0 | 已合并 |
| C-02 | PrismSheet 壳与 surface contract | 共享/modern-gui | P0 | 已合并 |
| C-03 | 内置 Sheet 响应式与内容预算 | modern-gui | P0 | 已合并 |
| C-04 | modern-gui/Sheet 回归与 conformance | modern-gui | P1 | 已合并 |

每张卡的文件白名单、改动描述、可判定验收、依赖和工作量以对应线路文件为执行真值；本文只维护总表，避免复制后产生两套施工真值。

### 0.5 当前进度与已得结论（阶段 0）

| 项目 | 已完成工作/结论 |
|---|---|
| 源码通读 | 已阅读入口、模式壳、标题栏、Sheet 布局、左右栏、消息/工具/推理、输入栏、Settings、主题字段与 Presentation Profile；具体文件见 1.2～1.4。 |
| 证据采集 | 完成静态扫描及动态批次 A～N：标准视口、窄屏、字号放大、两种模式/两种 scheme、工具/推理状态、空会话、Settings 焦点、Sheet 断点、reduced-motion 规则、CLI 焦点和 mode 切换对照。 |
| 当前诊断 | B-01～B-26 共 26 条可复现问题已按 1.7.1 定稿；每条均带文件/组件/现象证据和插件化边界。 |
| 重点模式 | 用户已确认 `terminal-like` 为重点开发模式；后续施工、示例、回归与验收均先覆盖 terminal-like，再覆盖 modern-gui。 |
| 范围执行 | A/B/C 三线已合并；仅修改样式、DOM/ARIA 表现、布局和展示映射，业务逻辑、数据流、接口契约、持久化和功能行为未改。 |
| 当前阶段门槛 | 三线代码闸门已关闭；进入根集成维护阶段。 |

### 0.5.1 并行施工拆线状态（INTEGRATED）

| 线路 | 主责范围 | 独立文件 | 当前状态 |
|---|---|---|---|
| A | terminal-like 宿主壳、标题栏、侧栏、消息/工具/CLI CSS | `docs/Pylon-外观并行施工-线路A-terminal-like宿主.md` | LINE_DONE；已合并 |
| B | 共享 token、palette 投影、状态/ARIA、Settings DOM 语义 | `docs/Pylon-外观并行施工-线路B-共享语义与状态.md` | LINE_DONE；已合并 |
| C | modern-gui 表面、Settings CSS、Sheet shell 与内置 Sheet CSS | `docs/Pylon-外观并行施工-线路C-modern-gui与插件表面.md` | LINE_DONE；已合并 |

三条线路的可写文件没有重叠；根 agent 独占本文、并行总契约和派发工作流。公共 token、palette、布局槽位、状态/ARIA 和 Q2/Q4 验收规则在派发前冻结，任何跨线请求必须先回到总契约。

### 0.5.2 根集成结果

三线提交已按 A → B → C 顺序合并到当前 `ACh/dev`：`d581c802`、`3b657716`、`af8b8155`，并补充构建类型修正 `6a7dba96`。A/B/C 隔离 worktree 与分支引用已删除；保留所有功能提交历史。

根集成验证：`check:first-party-styles` 通过（28 files）；本次变更相关定向测试 11 files / 49 tests 通过；`check:solid` 通过；ESLint 与 `git diff --check` 通过；`npm run build` 通过并产出本地 `onig.wasm` asset。另有一个未触碰的既有 `Sidebar.sections.test.tsx` 因主分支先前 session 改动失败，未纳入本次外观变更结论。

### 0.6 插件化边界（已确认）

Pylon 的 Sheet、侧栏和工作台可能由外部插件提供。因此“视觉一致性”不能直接等同于“所有表面使用同一套几何值”。后续定性将把视觉要求拆成三层：

1. **宿主硬约束**：窗口/标题栏槽位、主题语义变量、键盘焦点、对比度、reduced-motion、状态可访问名称和布局安全边界。
2. **插件契约**：插件必须声明的最小内容宽度、可折叠/可收缩能力、状态语义和 surface 能力；宿主语义 token 由插件按需消费，宿主只验收已声明的契约，不强制内部几何或尺度 token。
3. **插件自由区**：Sheet/侧栏内部的圆角、阴影、密度、图标、装饰层和断点实现，可以与 built-in 组件不同，但需满足前两层。

Q1/Q2/Q3b/Q4/Q5/Q6 已确认宿主硬约束、插件语义底线、现有 mode 身份边界、内容预算/收缩协商方向、token 治理层级以及状态反馈的自由边界；B-01～B-26 的最终归类见 1.7.1，具体数值和 ABI 见第 2 节与自治冻结清单。

### 0.7 用关键问题定性全部候选（讨论框架）

为避免把“可扩展性”误判成“缺乏统一”，拟用 6 个总闸门覆盖 B-01～B-26。每个总闸门仍按一题一轮推进，回答后立即回填映射表。

| 闸门 | 核心问题 | 覆盖候选 | 主要判定结果 |
|---|---|---|---|
| Q1 视觉所有权 | 哪些属性由宿主强制，哪些由插件自行决定？ | B-01、B-04、B-06、B-10、B-12、B-23 | 把“统一”限定为宿主/契约层，还是扩展到插件内部几何 |
| Q2 语义与可访问性底线 | 所有内置/外部表面必须满足哪些不可豁免的对比度、焦点、状态和动效条件？ | B-07、B-08、B-09、B-15、B-16、B-18、B-19、B-20、B-21、B-22、B-24、B-25、B-26 | 将硬性缺陷与可选视觉偏好分开 |
| Q3 主题与 mode 优先级 | scheme、interface mode、profile、用户自定义字段和插件字段发生冲突时谁优先？ | B-02、B-03、B-07、B-17、B-20、B-25 | 定义 palette 回退/覆盖契约，避免切换后混色 |
| Q4 布局与响应式协商 | 宿主是否保证内容预算，插件是否声明最小宽度和收缩策略？ | B-11、B-13、B-14、B-23 | 统一安全边界，而非强行统一每个 Sheet 的断点 |
| Q5 尺度、密度与动效治理 | spacing/radius/shadow/motion token 是所有插件必用、推荐使用，还是只约束宿主？ | B-01、B-04、B-05、B-14、B-16、B-19 | 定义 token 覆盖率、例外登记和模式优先级 |
| Q6 状态表现契约 | 状态真值、DOM/ARIA 语义和视觉 tone 是否分离；插件可否自定义 glyph/动画？ | B-08、B-15、B-18、B-19、B-21、B-24、B-26 | 保证状态可辨认，同时保留插件表现自由 |

Q1～Q6 是基线定性用的决策入口，不等同于阶段 1 的最终实现方案；同一 B 编号可受多个闸门约束，最终以最严格的已拍板底线为准。

#### Q1 当前讨论：视觉所有权边界（已拍板：B）

需要先决定：外部插件提供 Sheet/侧栏时，宿主对内部几何和材质约束到什么程度。这里不决定具体圆角或颜色数值，只决定约束层级。

| 选择 | 宿主约束范围 | 收益 | 代价/影响 |
|---|---|---|---|
| A 严格宿主皮肤 | 内置和外部 Sheet/侧栏都必须使用宿主 spacing、radius、shadow、surface token 与统一几何；插件只能添加内容和少量装饰 | 视觉回归与主题切换最简单，跨 Sheet 一致性最强 | 插件身份与实验性布局受限；外部 CSS 兼容和迁移成本高，可能把有意差异误判为缺陷 |
| B 语义契约 + 几何自由（建议） | 宿主强制语义 token、焦点/对比度/状态、布局槽位和安全边界；插件内部圆角、阴影、密度、图标和断点可自定义，也可选择宿主 skin | 保留扩展性，同时让主题、可访问性和宿主 chrome 可验收；适合 terminal-like 优先、modern-gui 与外部插件并存 | 需要定义插件契约、能力声明和 conformance 检查；不同插件仍可能有可见风格差异 |
| C 最小安全约束 | 宿主只要求插件不越出槽位并满足基础可访问性，其余 palette、token、材质和几何完全由插件负责 | 插件自治最大，宿主耦合最低 | 跨插件视觉语言容易分裂；scheme/mode 切换、回归和问题定位成本最高 |

**对现有候选的直接影响**：选择 A 会把 B-01/B-04/B-12/B-23 大范围纳入；选择 B 会把它们拆成“宿主/契约层必须收敛，插件内部差异可保留”；选择 C 只保留安全性相关部分，其余多转为观察项。B-02 的 palette 优先级也会在 Q3 再决定，不在本题提前拍板。

请只选择 Q1：**A 严格宿主皮肤 / B 语义契约 + 几何自由 / C 最小安全约束**。也可以提出自定义边界。

**Q1 结论（2026-08-28）**：用户选择 B“语义契约 + 几何自由”。宿主强制语义 token、焦点/对比度/状态、布局槽位和安全边界；内置与外部插件可自行决定内部圆角、阴影、密度、图标和断点，也可选择宿主 skin。B-01 的后续迁移范围因此限定为宿主/契约层；插件内部直接值不因存在本身被判为缺陷，除非违反契约或造成可复现的可用性问题。

#### Q2 当前讨论：不可豁免的语义与可访问性底线（已拍板：A）

Q2 用来区分“必须修复的表现缺陷”和“允许插件自行选择的风格差异”。它只决定验收底线，不决定具体色板或组件造型。

| 选择 | 宿主与插件都必须满足 | 收益 | 代价/影响 |
|---|---|---|---|
| A WCAG + 完整状态底线（建议） | 普通文本对比度至少 `4.5:1`、大文本至少 `3:1`；非文本控件/边界至少 `3:1`；所有键盘可达控件有可见 `focus-visible`；disabled/hover/active/loading/空态/错误态有可辨识反馈；`prefers-reduced-motion` 下禁用非必要动效；状态必须有可读名称，插件可自选颜色/glyph | 把 B-07～B-10、B-15～B-26 中的可用性风险变成统一硬门槛，同时保留插件表现自由 | 外部插件需要补 conformance 检查和状态 fixture；部分现有低对比度/无焦点反馈视觉契约会被有意打破 |
| B 仅可访问性底线 | 只强制键盘可达、可见焦点、语义名称、禁用可识别和 reduced-motion；对比度、状态细分和空态由各插件自行决定 | 外部插件接入门槛较低，保留更多视觉实验空间 | 颜色/状态仍可能不可读；宿主无法对 B-07、B-20、B-25 等问题给出统一验收结论 |
| C 宿主硬底线、插件声明例外 | 宿主内置组件执行 A；插件只需声明其对比度/状态/动效策略，未声明部分按安全回退；允许经登记的局部例外 | 兼顾遗留插件兼容与可追踪性，迁移可分阶段进行 | 例外清单和运行时回退复杂；用户可能在未察觉时看到不一致的安全等级 |

**对现有候选的直接影响**：选择 A 会把对比度、焦点、状态和 reduced-motion 相关问题作为跨插件硬验收；选择 B 只能硬性收纳键盘/语义类问题；选择 C 则需要为每个外部插件增加例外声明和回退记录。具体数值若需更严格，仍可在阶段 1 的可访问性议题中细化。

请只选择 Q2：**A WCAG + 完整状态底线 / B 仅可访问性底线 / C 宿主硬底线、插件声明例外**。也可以提出自定义底线。

**Q2 结论（2026-08-28）**：用户选择 A“WCAG + 完整状态底线”。内置与外部插件均须满足普通文本 `4.5:1`、大文本 `3:1`、非文本控件/边界 `3:1` 的候选门槛；键盘可达控件必须有可见 `focus-visible`；hover/active/disabled/loading/空态/错误态必须可辨识；`prefers-reduced-motion` 下关闭非必要动效；每个状态必须有可读名称。插件可自定义颜色、glyph、几何和动画形式，但不能豁免这些语义底线。受影响的 B-07、B-08、B-09、B-10（可读性部分）、B-15、B-16、B-18、B-19、B-20、B-21、B-22、B-24、B-25、B-26 将在最终定性时归入“必须满足底线”的改造/验收范围；具体实现仍受 Q3～Q6 约束。

#### Q3 当前讨论：主题与 mode 优先级（已拍板：B；Q3a/Q3b 已补充定性）

Q3 需要决定 scheme、interface mode、Presentation Profile、用户自定义字段和插件字段发生冲突时的优先级。目标是消除 B-02/B-03/B-17 的混合 palette，同时不让宿主覆盖插件内部合法的局部主题。

| 选择 | 优先级与行为 | 收益 | 代价/影响 |
|---|---|---|---|
| A 语义角色分层 + 安全回退（建议） | `scheme` 提供基础语义角色；mode/profile 只能提供默认值；用户显式覆盖只作用于对应语义角色；插件颜色必须在自身 namespace，并通过对比度校验；缺失/不合格值回退到宿主安全值 | 保留用户与插件定制，同时避免切换后黑字/白字/背景错配；适合 Q1/Q2 的契约模型 | 需要定义“显式覆盖”标记、角色映射和运行时对比度回退；主题解析链更复杂 |
| B mode/profile 完整 palette 套件 | 每个 mode/profile 提供完整背景、前景、边界和状态色；切换时原子应用整套 palette；用户自定义字段按套件重置或另存 | 视觉一致性和切换可预测性最高，B-02/B-03/B-17 最容易收敛 | 会覆盖或迁移用户自定义颜色；外部插件若依赖自身颜色，需要适配 palette 套件 |
| C 用户/插件覆盖优先，scheme 只作默认 | 保持现有覆盖方向：任何显式用户或插件值都优先，scheme/mode 不主动替换；仅在对比度失败时报警或局部回退 | 最大限度保留现有主题和插件自主权，改动最小 | 混合 palette 仍可能出现；宿主只能事后发现 B-03/B-17 类问题，无法保证切换后的整体成立 |

请只选择 Q3：**A 语义角色分层 + 安全回退 / B mode/profile 完整 palette 套件 / C 用户/插件覆盖优先**。也可以提出自定义优先级。

**Q3 结论（2026-08-28）**：用户选择 B“mode/profile 完整 palette 套件”。后续设计将把每个 mode/profile 的背景、前景、边界和状态色作为一个原子视觉套件应用；套件作用于宿主语义角色，外部插件仍在 Q1 约定的 namespace 内映射自己的局部角色，不被强制采用宿主几何。该决定把 B-02、B-03、B-17 的“切换后 palette 不成套”确认为必须收敛的问题。用户自定义字段的切换策略由 Q3a 定义，自定义 mode 的身份由 Q3b 定义。

#### Q3a 当前讨论：用户自定义 palette 的切换策略（已拍板：B；Q3b 已补充定性）

Q3 选择 B 后仍需明确：用户显式设置的背景/前景/状态色，在 mode/profile 套件切换时如何处理。这个选择会影响持久化表现，但不改变业务数据。

| 选择 | 行为 | 收益 | 代价/影响 |
|---|---|---|---|
| A 按 mode/profile 分开保存（建议） | 为每个 mode/profile 保存用户对语义角色的覆盖；切换时恢复该套件对应覆盖，未覆盖角色取套件默认 | 兼顾完整套件与用户定制，返回某 mode 时视觉可预测 | 需要增加/明确 per-mode 覆盖记录和迁移规则；插件需声明覆盖角色 |
| B 切换时重置为套件默认 | 应用完整 palette 时清空当前用户覆盖，用户之后重新调整 | 实现和验收最简单，每次切换结果完全一致 | 用户自定义颜色会丢失或需要另行备份；破坏现有主题持久化预期 |
| C 保留全局覆盖并做安全校验 | 用户覆盖跨 mode/profile 保持；若与套件对比度或角色契约冲突，则仅该角色回退到安全值 | 保留现有自定义习惯，改动较温和 | 仍可能产生风格错配；需要向用户解释哪些字段被回退 |

请只选择 Q3a：**A 按 mode/profile 分开保存 / B 切换时重置 / C 保留全局覆盖并做安全校验**。也可以提出自定义策略。

**Q3a 结论（2026-08-28）**：用户选择 B“切换时重置为套件默认”，并补充要求“在 mode 层增加全局预设，用户可以保存自己的自定义 mode”。本项目将按以下语义理解：切换到另一个 mode/profile 时，不携带当前未保存的散落覆盖；用户若要保留一套定制，应将完整 palette + presentation/profile + 允许的插件贡献保存为一个命名的全局自定义 mode，之后像内置套件一样选择。保存的自定义 mode 不修改内置套件本身。现有代码已有 `CustomPreset`/`PresetBundleV2`，可捕获 theme、presentation 和 renderer 贡献；Q3b 已将其身份限定为现有 interface mode 下的命名套件，不创建新的 interface-mode 身份。

#### Q3b 当前讨论：自定义 mode 的身份范围（已拍板：A）

| 选择 | 自定义 mode 的含义 | 收益 | 代价/影响 |
|---|---|---|---|
| **A 基于现有 mode 的命名套件（已拍板）** | 自定义 mode 保存为 `terminal-like` 或 `modern-gui` 的一个命名 preset；运行时仍使用原宿主 mode id，只替换完整视觉套件和已声明插件贡献 | 不改变宿主生命周期/Sheet 注册契约；最容易复用现有 `CustomPreset`/`PresetBundleV2`，terminal-like 与 modern-gui 可分别保存 | 自定义 mode 不能新增新的 chrome/workbench 类型；若插件需要新布局能力，仍需单独注册真正的 Interface Mode |
| B 新的第一类 interface mode | 每个自定义 mode 都有独立 id、chrome/workbench 能力、默认 profile 和插件贡献，像插件 mode 一样出现在 mode 切换器 | 表达能力最强，可保存完整应用级体验 | 需要持久化用户 mode registry、id/版本/依赖校验、卸载/迁移和安全回退；会扩大 mode 生命周期改动 |
| C 混合身份 | 用户保存的是全局命名套件，但套件可指定基础 mode；切换时先激活基础 mode，再原子应用自定义套件；不生成新的 mode id | 兼顾跨 mode 复用和现有注册契约，适合“自定义 terminal 工作站” | 需要定义套件与基础 mode 的兼容矩阵；跨 mode 套件可能隐藏不支持的插件能力 |

**Q3b 结论（2026-08-28）**：用户选择 A“基于现有 mode 的命名套件”。自定义 mode 是现有 `terminal-like` 或 `modern-gui` 宿主 mode 下的命名视觉套件，不生成新的 `InterfaceModeContribution`、mode id、chrome/workbench 类型或 shell 槽位；运行时保留原宿主 mode 的注册、生命周期和 Sheet/侧栏布局契约，仅原子应用该套件保存的 palette、Presentation Profile 及已声明的插件贡献。现有 `CustomPreset`/`PresetBundleV2` 作为实现承载，不能借此改动持久化格式或业务接口。插件内部仍遵守 Q1/Q2：可自定义几何、材质、glyph 和动画形式，但必须满足宿主语义、对比度、焦点、状态和 reduced-motion 底线；若插件需要新的应用级布局能力，必须另行注册真正的 Interface Mode，不得伪装成自定义 mode。后续施工与回归先覆盖以 `terminal-like` 为宿主基座的自定义套件。

Q3b 已定性后，下一题只讨论宿主与插件 Sheet/侧栏的布局安全边界，不重新讨论自定义 mode 身份。

#### Q4 当前讨论：宿主与插件 Sheet/侧栏的布局安全边界（已拍板：A）

Q4 针对 B-11、B-13、B-14、B-23：当窗口变窄或字号放大时，宿主如何给中心工作区、CLI 输入和外部 Sheet 分配空间。Q1 已允许插件内部几何自由，因此本题只决定宿主槽位、安全预算和协商方式，不规定每个插件内部必须采用同一断点。任何“收起”都只能改变呈现占位，不能删除操作；被收起的能力必须仍可通过既有 launcher、键盘或恢复入口访问。

| 选择 | 宿主与插件的布局规则 | 收益 | 代价/影响 |
|---|---|---|---|
| A 宿主预算 + 能力协商（建议） | 宿主先为中心 workbench/terminal 输入保留可用最小宽度，再按优先级收缩可选侧栏；Sheet 声明最小内容宽度、可收缩/可堆叠能力和恢复入口，内部断点由插件自行决定；terminal-like 的 CLI 与消息列优先获得预算 | 能直接阻止 480px 场景的主区/输入栏归零，同时保留外部 Sheet 的视觉自由；可把“能否收缩”变成可测试契约 | 需要定义最小宽度、收缩优先级和缺失声明的安全回退，并为内置/外部 Sheet 增加组合测试 |
| B 宿主统一断点与固定槽位 | 宿主规定统一断点、侧栏宽度和折叠顺序，所有内置/外部 Sheet 必须遵守；插件只在槽位内部布局 | 规则最简单，跨 Sheet 的响应式验收最直接；窄屏行为高度可预测 | 限制插件特殊布局和密度；现有外部 Sheet 可能需要较大迁移，容易把有意差异变成契约冲突 |
| C 内容优先的弹性流式布局 | 宿主只提供 `minmax`/溢出安全和滚动容器，不要求插件声明能力；侧栏与 Sheet 尽量压缩，具体收缩/堆叠由各自 CSS 决定 | 接入成本最低，插件自治最大，宿主 API 变化最少 | 无法保证中心输入和消息列的最低可用宽度；不同 Sheet 的断点分裂及 B-11/B-23 风险可能继续存在 |

**Q4 结论（2026-08-28）**：用户选择 A“宿主预算 + 能力协商”。宿主必须先为中心 workbench、消息列和 CLI 输入保留可用的最小内容预算，再按优先级收缩可选侧栏或 Sheet；`terminal-like` 的中心工作区和输入栏优先获得预算。Sheet/侧栏需要声明（或通过现有 UI surface 能力表达）最小内容宽度、可收缩/可堆叠能力和恢复入口，内部几何与断点仍由插件自行决定。收起只改变呈现占位，不删除操作；被收起的能力必须可由既有 launcher、键盘或恢复入口访问。具体最小宽度、折叠顺序、缺失声明的安全回退和数值断点留到阶段 1/任务卡定义。该决定将 B-11、B-13、B-14、B-23 纳入宿主/契约层布局改造范围；插件内部仅在违反该安全边界时整改，不因断点或几何不同本身判为缺陷。此处的能力声明属于视觉/布局契约，不得改变业务数据、接口行为或持久化格式。

#### Q5 当前讨论：尺度、密度与动效的 token 治理（已拍板：C）

Q5 针对 B-01、B-04、B-05、B-14、B-16、B-19：决定 spacing、radius、shadow、字号/行高、disabled 透明度和 motion 是否必须消费 token，以及外部插件如何保留自己的密度与材质。Q1 已允许插件内部几何自由，Q2 已把对比度、状态反馈和 reduced-motion 设为硬底线；本题只决定 token 的治理层级，不提前规定具体档位数值。

| 选择 | token 与动效规则 | 收益 | 代价/影响 |
|---|---|---|---|
| A 分层 token 契约 + 登记例外（建议） | 宿主 shell、共享 primitive 和插件契约表面必须使用语义 spacing/radius/shadow/type/motion/disabled token；各 mode/profile 可把同一语义映射到不同档位（终端可保持硬边/低阴影）。插件内部几何、材质和密度可自定义；宿主/契约层出现直接值必须登记 owner、原因和替代 token，并通过静态扫描。非必要动效统一走 motion token，`prefers-reduced-motion` 下关闭 | 在不抹平 terminal-like 与外部插件身份的前提下，能验证宿主一致性、减少漂移并保留有意例外 | 需要维护 token 语义表、例外清单、扫描规则和插件 conformance fixture；迁移面中等 |
| B 全局统一 token 网格 | 内置和外部插件的 spacing、radius、shadow、type、disabled 和 motion 全部只能使用同一组全局档位；仅系统按钮、发丝线和浏览器兼容值可例外 | 静态验收最简单，跨模式数值可预测，B-01/B-04/B-05/B-16 收敛最快 | 与 Q1 的插件几何自由和 terminal-like 的硬朗密度冲突；外部 Sheet 迁移成本最高，可能消除有意的视觉差异 |
| **C 仅宿主强制、插件自愿采用（已拍板）** | token 只对窗口壳、共享 primitive 和内置组件强制；插件可使用自己的 token/字面值，只需满足 Q2 的可访问性与状态底线；不建立统一例外登记 | 接入和迁移成本最低，插件自治最大，几乎不增加扩展契约 | 跨插件尺度、禁用透明度和动效节奏无法静态收敛；B-01/B-04/B-05 的漂移可能持续，回归依赖逐插件检查 |

**Q5 结论（2026-08-28）**：用户选择 C“仅宿主强制、插件自愿采用”。窗口壳、共享 primitive、内置组件和宿主契约表面必须消费现有语义 token；外部插件及其 Sheet/侧栏内部可以使用自己的 token 或直接值，不因数值、密度、圆角、阴影或动效与宿主不同而被判为缺陷。插件仍不可豁免 Q2 的对比度、可见焦点、完整状态反馈、可读名称和 `prefers-reduced-motion` 底线。对于 built-in `terminal-like`/`modern-gui`，共享宿主值继续纳入 B-01/B-04/B-05/B-16 的 token 收敛；模式专属硬边、发丝线和其他有意值可作为宿主例外登记。外部插件不建立统一直接值例外清单，改由逐插件回归与 Q2 conformance 检查负责。动效 token 对插件是推荐而非强制，但 reduced-motion 下的非必要动效关闭仍是硬要求。该决定将 B-01、B-04、B-05、B-14、B-16 的强制范围限定为宿主/共享层；插件内部只有在违反 Q2 或 Q4 安全边界时整改，B-19 的插件动画也按此边界验收。

#### Q6 当前讨论：状态表现与交互反馈契约（已拍板：C）

Q6 针对 B-08、B-15、B-18、B-19、B-21、B-24、B-26：决定领域状态真值、DOM/ARIA 语义、视觉 tone、glyph、动画和可发现性如何分层。Q2 已要求所有内置/外部插件的状态可辨识、可读命名、键盘焦点和 reduced-motion；本题只决定宿主是否提供更细的规范化状态映射，以及插件在满足底线后可以自由到什么程度。任何修正只允许改变展示映射，不改变后端状态机、业务数据或操作语义。

| 选择 | 状态与反馈规则 | 收益 | 代价/影响 |
|---|---|---|---|
| A 规范化状态语义 + 插件表现自由（建议） | 宿主维护 canonical 状态集合与可读名称，DOM/ARIA 真值与视觉 tone 分离；每个状态必须有可辨识的文本、glyph、形状或边界组合，插件可自定义颜色、glyph、动画和几何但必须逐态映射并通过状态 fixture；`cancelled` 不得因存在输出而显示为 `completed`，CLI/隐含操作必须有可见 focus/非 hover 入口 | 能同时修正 B-15/B-18/B-19/B-21/B-24/B-26 的语义缺口和发现性问题，保留插件表达空间；适合 terminal-like 先建立清晰状态语言 | 需要 canonical 状态映射表、逐态 fixture、ARIA 检查和缺失映射的安全回退；内置 renderer 与插件都要补测 |
| B 宿主统一视觉配方 | 宿主规定每个状态的固定 tone、glyph、动画、布局和操作显现方式，内置与外部插件直接复用同一套 renderer/组件外壳 | 视觉回归和验收最简单，状态之间差异最容易比较 | 强行覆盖插件身份和材质；外部 Sheet/renderer 迁移成本高，与 Q1/Q5 的自由边界冲突 |
| **C 语义底线 + 插件自定义状态（已拍板）** | 宿主不规定统一状态分类、tone、glyph、空态或操作显现配方；各插件自行设计，但必须满足 Q2 的 ARIA/可读名称、键盘焦点、对比度、状态可辨识和 reduced-motion 底线，并保持源状态语义不被误标 | 改动最小，插件自治最大，不需维护统一视觉状态矩阵 | 7 态工具可能继续共享 tone；跨插件的状态比较和视觉回归成本较高，仍需逐插件检查取消/完成、空态、焦点和操作发现性 |

**Q6 结论（2026-08-28）**：用户选择 C“语义底线 + 插件自定义状态”。宿主不建立强制性的统一状态分类、tone、glyph、动画、空态或操作显现配方；内置组件和外部插件可按自身语义与视觉语言设计状态。该选择不覆盖或削弱 Q2：所有状态仍必须有可读名称和可辨识反馈，键盘可达控件必须有可见 `focus-visible`，普通/大文本与非文本边界须满足已拍板对比度门槛，非必要动效在 `prefers-reduced-motion` 下关闭。插件可以让多个业务状态共享颜色或 glyph，但不得把源状态误标为另一个状态（例如 `cancelled` 显示为 `completed`）；空态、hover/active/disabled/loading、CLI focus 等可自定义呈现形式，但不能省略可达/可辨识反馈。B-08、B-15、B-19、B-21、B-24、B-26 的整改范围因此以逐插件 Q2 conformance 为准，不要求跨插件统一视觉配方；B-18 的错误状态映射仍属于必须修正的语义错误。任何修正只允许改变展示映射，不改变后端状态机、业务数据或操作语义。

Q6 完成后，阶段 0 进入“B-01～B-26 最终归类与用户基线确认”；在确认前不进入阶段 1 或生成任务卡。

## 1. 现状基线

### 1.1 证据环境与方法

| 项目 | 当前记录 |
|---|---|
| 代码范围 | `src/` 下入口、布局、主题、Presentation Profile、核心组件及产品 CSS |
| 静态证据 | 文件路径 + 行号 + 选择器/组件名；行号以本草稿生成时的源码快照为准 |
| 动态证据 | 本地预览 `http://127.0.0.1:5173/?demo-scenario=visual&demo-reset=1` |
| 已测视口 | 标准 `1738×819` CSS px（DPR 约 `1.1`），并已覆盖请求 `1280/900/680/480×720`；150% 字号与真实系统 reduced-motion 仍待补测 |
| 已观测组合 | `terminal-like`/`modern-gui` 的暗色与浅色、默认主题重置后的明暗对照、Tokyo Night 后切换 scheme；批次 A～M 记录逐项条件 |
| 主题注意事项 | `demo-reset=1` 可重置演示场景，但当前主题字段可能有此前持久化的自定义值；“默认 profile 缺陷”和“用户自定义值”需在后续复测中区分 |
| 业务改动 | 本阶段未修改产品代码、业务逻辑、数据流或接口 |

动态检查只记录可观察几何、颜色、状态和交互反馈，不把截图中的主观印象直接当作缺陷。B-01～B-26 均是已具备证据的候选问题；“待确认”表示是否纳入后续改造仍由用户拍板，不表示证据尚未采集。

### 1.2 `terminal-like` 设计语言与元素清单

**总体语言**

- 黑色或深色画布，主 accent 常见为 `#D77757`（具体值由主题字段决定）。
- JetBrains Mono 等宽栈用于正文、CLI 输入、路径和工具输出。
- 以细边框、单像素左侧导引线、状态 glyph 和连接线表达层级，而不是大面积浮层。
- 表面大多平直，常见 `border-radius: 0/2/4px`；阴影较少，层级依靠边界和留白。
- 常见语义 glyph：`❯`、`●`、`✓`、`!`、`×`。

**元素清单**

| 区域 | 当前表现 | 主要证据 |
|---|---|---|
| App 壳 | 标题栏约 44px；透明/半透明 canvas；标题栏有 blur 和底部边界 | `src/plugins/product/packages/builtin.pylon-shell/styles/App.css:1-26` |
| 标题栏 | 左侧栏轨道 + Sheet 标签 + launchers + 窗口按钮；glyph 版控件可切换 | `src/workspace-sheets/WorkspaceTitlebar.tsx:77-125`；`App.css:17-66` |
| 左栏 | 默认约 250px；搜索、模式 tab、会话/工作区列表、状态灯；控件多为直角 | `src/plugins/product/packages/builtin.pylon-workspace/styles/components/Sidebar.css:1-36,152-185` |
| 主消息区 | `.term` 使用聊天字体/字号变量；消息行按 user/assistant/reasoning/tool 分型；工具输出以左线和内缩表达 | `src/plugins/product/packages/builtin.pylon-renderers/styles/components/chat/ChatView.css:19-36,760-787,1601-1615` |
| 工具状态 | glyph、连接线、输出折叠和状态标签组成视觉反馈；演示数据有多状态 | `ChatView.css:213-240,630-682`；`src/demo/visualQaData.ts:136-154` |
| 输入栏 | CLI 线条式输入、错误/绑定/命令/历史/队列浮层；按钮和 chip 以直角为主 | `src/plugins/product/packages/builtin.pylon-renderers/styles/components/chat/InputBar.css:1-36,198-227` |
| 右栏 | 默认约 260px；左边界、透明背景、可选背景图/blur | `src/plugins/product/packages/builtin.pylon-workspace/styles/components/right-panel/ContextPanel.css:3-20` |
| 空态 | 品牌标记、eyebrow、标题、说明、两列开始步骤；窄屏变单列 | `src/components/chat/AgentEmptyState.tsx:10-24`；`ChatView.css:1-17` |
| 动效/无障碍 | 全局 reduced-motion 将 motion token 压到 1ms；聊天组件关闭 cursor、spinner、tool pulse 等动画 | `src/index.css:170-181`；`ChatView.css:539-557` |

**同一 interface mode 下的 profile 变体**

`terminal-like` 目前不只一个 profile：`terminal-classic`、`terminal-modern`、`paper-low-contrast`、`console-glass` 等会改变消息布局、字体、输入形态、radius、连接线和 glyph。来源：`src/plugins/core/renderer/builtinPresentationProfiles.ts:46-137`。

### 1.3 `modern-gui` 设计语言与元素清单

**总体语言**

- 几何上采用现代 GUI：圆角容器、分层表面、边框、阴影、渐变和 blur。
- 标题栏约 58px，外层 layout 使用 `gap: 8px; padding: 0 8px 8px`，侧栏和主工作台呈浮动块状。
- 消息列居中，最大宽度约 900px；消息卡约 15–16px radius，工具卡约 12px，输入 dock 约 15–16px。
- 使用 lucide 图标和语义化图形；但大量 profile 仍沿用黑底、橙色 accent、终端状态色和白字。

**元素清单**

| 区域 | 当前表现 | 主要证据 |
|---|---|---|
| App 壳 | radial-gradient + canvas；标题栏覆盖为 58px | `src/plugins/product/packages/builtin.pylon-shell/styles/App.css:314-325` |
| 标题栏 | 三个带边框/圆角/阴影的 cell（sidebar、workspace、window controls），内部有 14px radius | `App.css:322-335` |
| 左栏 | 8px 外间距、16px radius、半透明 panel、阴影；模式 tab 12px radius、会话项 12px radius | `src/plugins/product/packages/builtin.pylon-workspace/styles/components/Sidebar.css:254-275` |
| 工作台 | 外层 16px radius、边框和阴影；内部 header、body、action/status chip 继续分层 | `src/plugins/product/packages/builtin.pylon-renderers/styles/components/chat/ChatView.css:346-365` |
| 消息 | 中央列约 900px；user/assistant/reasoning 卡使用 profile 背景、边框和 16px radius | `ChatView.css:366-400`；`src/plugins/core/renderer/builtinPresentationProfiles.ts:48-62` |
| 工具卡 | 12px 左右 radius、状态色、连接线、输出 section 和折叠交互 | `ChatView.css:788-850`（及同文件后续 tool 规则） |
| 输入 dock | composer 形态、约 64.8px 高、圆角约 16px；focus 有上移和 focus ring | `src/plugins/product/packages/builtin.pylon-renderers/styles/components/chat/InputBar.css:80-195,228-238` |
| 右栏/设置 | 右栏与 Settings 继续消费透明 surface、边框、blur；Settings 还包含导航、字段组和预览 pane | `src/plugins/product/packages/builtin.pylon-shell/styles/components/Settings.css:1-11,261-296` |

`modern-gui` profile 的核心 token 见 `src/plugins/core/renderer/builtinPresentationProfiles.ts:48-63`：`messageRadius: 16`、`inputRadius: 16`、`inputFocusRingWidth: 4`、`ccVariant: 'glass'` 等。

### 1.4 Sheet 与主要视觉组件清单

**内置 Workspace 类型**（`src/plugins/core/sheet/builtinWorkspacePlugins.ts:64-74`）：

`agent`、`prism`、`runtime`、`file`、`overview`、`search`、`history`、`browser`、`gateway`。

**公共壳与核心组件**

| 组件 | 文件 |
|---|---|
| App 入口/模式壳 | `src/App.tsx`、`src/plugins/product/packages/builtin.pylon-shell/styles/App.css` |
| 标题栏/Sheet 标签 | `src/workspace-sheets/WorkspaceTitlebar.tsx`、`src/plugins/product/packages/builtin.pylon-shell/styles/App.css` |
| Sheet 布局 | `src/workspace-sheets/SheetLayout.tsx`、`src/workspace-sheets/SheetSidebarSlot.tsx`、`src/workspace-sheets/SheetRightSlot.tsx` |
| 左栏 | `src/components/Sidebar.tsx`、`src/plugins/product/packages/builtin.pylon-workspace/styles/components/Sidebar.css` |
| 消息/空态 | `src/components/chat/ChatView.tsx`、`src/components/chat/AgentEmptyState.tsx`、`.../ChatView.css` |
| 输入 | `src/components/chat/InputBar.tsx`、`.../InputBar.css` |
| 控制中心 | `src/components/ControlCenter.tsx`、对应 shell CSS |
| 右栏 | `src/components/right-panel/ContextPanelHost.tsx`、`.../ContextPanel.css` |
| Settings | `src/components/Settings.tsx`、`src/plugins/product/packages/builtin.pylon-shell/styles/components/Settings.css` |

**各 Sheet 的重复样式入口（待统一性核验）**

- `src/plugins/product/packages/builtin.pylon-workspace/styles/sheets/OverviewSheetView.css`
- `src/plugins/product/packages/builtin.pylon-workspace/styles/sheets/RuntimeSheetView.css`
- `src/plugins/product/packages/builtin.pylon-workspace/styles/sheets/browser/BrowserSheet.css`
- `src/plugins/product/packages/builtin.pylon-workspace/styles/sheets/file/FileSheet.css`
- `src/plugins/product/packages/builtin.pylon-workspace/styles/sheets/gateway/GatewaySheet.css`
- `src/plugins/product/packages/builtin.pylon-workspace/styles/sheets/history/HistorySheet.css`
- `src/plugins/product/packages/builtin.pylon-workspace/styles/sheets/search/SearchSheet.css`
- `src/plugins/product/packages/builtin.pylon-workspace/styles/components/PrismSheet.css`

### 1.5 可判定问题候选清单

下表是阶段 0 的“证据化候选”，不是已经拍板的改造清单。`待补证` 表示仍需要指定环境或 fixture；`待确认` 表示证据已存在，但设计意图、是否保留或是否纳入后续改造需用户拍板。

| 编号 | 模式 | 可判定现象 | 证据 | 状态 |
|---|---|---|---|---|
| B-01 | 共享 | 全局已定义 spacing/radius/shadow/motion token，但产品 CSS 仍直接出现独立 px、颜色、阴影和 transition；同语义值不能仅通过 token 追溯 | `src/index.css:20-90`；示例 `App.css:314-371`、`Sidebar.css:254-285`、`ChatView.css:346-400`；当前源码扫描 481 行含 `border-radius:`、152 行含 `box-shadow:`，其中约 205/26 行不含 `var(...)` | 已确认纳入后续改造 |
| B-02 | 共享/模式 | 切换 interface mode 的实现只应用 profile token，不重置 palette、背景或用户资产；几何切换与色彩切换不是同一事务 | `src/application/transactions/applyPresentationProfile.ts:10-23`；`src/application/transactions/activateInterfaceMode.ts:74-96`；`builtinPresentationProfiles.ts:48-62`；动态批次 N | 待确认 |
| B-03 | 共享/两模式 | `uiScheme` 切换只覆盖通用语义变量；显式的 `globalBgColor/chatTextColor/msgTextColor/titlebar*` 仍可来自上一模式或持久化值，导致浅色/深色下同一画面出现相反前景与表面组合。切换 Tokyo Night 后再点浅色仍保留 `--global-bg-color:#1a1b26`、`--chat-text-color/#msg-text:#c0caf5`、`--titlebar-bg:#16161e`，而通用 `--text` 已变为黑色；modern-gui 标题栏/assistant row 因此在浅色 surface 上消费浅色前景 | `src/index.css:115-146` 只重写 `--text/--border` 等；`src/domains/theme/themeCssSnapshot.ts:36-50` 循环注入显式字段；`src/application/transactions/applyPresentationProfile.ts:10-23` 明确不重置 palette/background/user assets；动态批次 C、I、L | 证据已确认，是否改为 scheme/profile 成对 palette 待确认 |
| B-04 | 共享 | radius 同时出现 `0/1/2/4/6/7/8/9/10/11/12/13/14/15/16/18/22px` 等值，以及多个 token/fallback；不存在单一档位表 | `index.css:48-52`；`App.css:350-371`；`Sidebar.css:255-284`；`ChatView.css:346-400` | 待确认 |
| B-05 | 共享 | 全局 motion token 为 120/180/260ms，但组件另有 100/140/150/210/250ms 以及 1.2s/1.8s/3s 动画周期；同类反馈无法按同一节奏推断 | `index.css:85-90`；`ChatView.css:141-158,343-345,1611-1614`；`InputBar.css:29-34` | 待确认 |
| B-06 | modern-gui | 标题栏 cell、sidebar、workbench、message row、tool card、input dock、Settings/右栏同时叠加背景/边框/阴影/blur；层级数量需以可见表面计数复核 | `App.css:322-345`；`Sidebar.css:255-284`；`ChatView.css:347-395`；`Settings.css:261-269`；动态批次 J 逐层采样 | 证据已确认，层级是否收敛待确认 |
| B-07 | terminal-like | 文字和边界大量使用低透明度值；工具区使用单像素低透明度左线。Tokyo Night 一致深色预设下 `--tool-connector-color:#414868` 对 `#1a1b26` 约 `1.91:1`，CLI 线 `#565f89` 约 `2.76:1`，均低于 UI 边界常用 `3:1`；默认混合主题下白色 `.48/.14` 线更低 | `index.css:118-126`；`ChatView.css:98,1562-1570`；动态批次 I/J 与 Tokyo Night 复测 | 证据已确认，最终门槛/是否改线条语义待确认 |
| B-08 | 共享 | 演示数据覆盖 7 个工具状态（含未知字符串），领域真值另有 `unknown`；真实会话只覆盖 reasoning complete，redacted/missing 仅在单测存在；工具头交互可展开输出但没有逐状态 × hover/focus/disabled/loading 的视觉验收矩阵 | `src/demo/visualQaData.ts:136-154,168-170`；`src/domains/tool/status.ts:9-53`；`ChatView.tsx:592-682`；`ReasoningStates.solid.test.tsx:28-65`；动态批次 J | 证据已确认，状态 fixture/交互覆盖待确认 |
| B-09 | 左栏 | 会话 gear/delete 主要在 hover 或 `focus-within` 时显示；未 hover/focus 时 computed `opacity:0`；唯一的 `@media (hover:none)` 规则只覆盖 `.cwd-group-actions`，不覆盖 `.session-gear/.session-del`，因此触屏上的会话操作没有同等常驻/显式入口 | `src/plugins/product/packages/builtin.pylon-workspace/styles/components/Sidebar.css:76-82,252`；标准视口动态采样见 1.10（Tab 聚焦后才变为 `opacity:1`） | 证据已确认，触屏呈现/是否改为显式菜单待确认 |
| B-10 | Settings | Settings 的遮罩材质按模式分裂：terminal-like 专门覆盖为 `background:var(--surface-canvas); backdrop-filter:none`，modern-gui 则为圆角/阴影/`blur(16px)` 浮层；两者都允许底层 canvas 通过透明色混入。浅色/深色均需按最终合成像素检查字段与当前导航可读性 | `src/plugins/product/packages/builtin.pylon-shell/styles/components/Settings.css:8-11,948-970`；动态批次 K（terminal/modern 对照及 Settings 子面板） | 证据已确认，遮罩材质/可读性门槛待确认 |
| B-11 | 共享（terminal-like 优先） | 固定宽度/最小宽度较多：标题栏轨道默认 250px、右栏 260px、Settings body `min-width:420px`，另有 196/218/224/244/250px 和 `min-width:640px`；窄屏/字号放大挤压主内容已复现 | `App.css:21`；`ContextPanel.css:8`；`Settings.css:91-95`；各 Sheet CSS 固定列定义；动态批次 A/B | 动态证据已复现，待确认 |
| B-12 | Sheet | 8 个 Sheet 样式文件各自维护 mode skin；7 个文件重复写入同一 modern-gui 外壳（`border-radius:16px`、`box-shadow:0 16px 44px ...`），侧栏又重复写入 `margin:8px`/`border-radius:13px`，未通过共享 token 或单一 skin 选择器收口 | `src/plugins/product/packages/builtin.pylon-workspace/styles/sheets/OverviewSheetView.css:24-26`、`RuntimeSheetView.css:251-254`、`browser/BrowserSheet.css:11-14`、`file/FileSheet.css:1095-1098`、`gateway/GatewaySheet.css:304-307`、`history/HistorySheet.css:11-14`、`search/SearchSheet.css:11-14`、`src/plugins/product/packages/builtin.pylon-workspace/styles/components/PrismSheet.css:11-14`；静态扫描：`border-radius:16px` 9 行（含壳与 sidebar）、`box-shadow:0 16px 44px` 8 行 | 证据已确认，是否合并为共享 Sheet skin 待确认 |
| B-13 | 标题栏 | terminal tab 有固定约 160px 宽，modern tab 为 132–190px；窄视口下即使启用 `.overflowed`，标签区可能被固定左栏/窗口按钮压到零宽，标题文本只能在固定 tab 内 ellipsis | `src/plugins/product/packages/builtin.pylon-shell/styles/App.css:86-90`；`WorkspaceTitlebar.tsx:96-110`；终端模式请求 `480×720`（实际 `436×655`）动态采样见 1.16：tab region `w=0`、`scrollWidth=32`，tab 仍 `120px` | 动态证据已复现，最小宽度/标签保留规则待确认 |
| B-14 | 共享（terminal-like 优先） | 根字号、主题字段默认字号、chat/message/profile 字号和 line-height 并行存在；把基础字号调到 22.5px/24px 时标题栏仍为 12px、消息列仍为 15px，而侧栏/输入继承根字号；窄宽下长词还会出现 row `scrollWidth > clientWidth` | `index.css:147`；`src/themeFieldDefs.ts:98` 附近；`builtinPresentationProfiles.ts:55-59`；`ChatView.css:22,368-372`；动态采样见 1.12 | 证据已确认，是否纳入改造待确认 |
| B-15 | 共享（terminal-like 优先） | 工具状态标签有 7 态/未知态，但视觉 tone 只有 `ok/err/run` 三档；`queued`、`running`、`waiting`，以及无输出 `unknown` 都映射为同一 `run` 色和同一 indicator class，是否需要进一步区分尚未拍板 | `src/domains/tool/status.ts:61-83`；运行时 `.term-tool-indicator.run` 的动态采样：`运行中/等待中/排队中/状态未知` 均为 `rgb(215,119,87)`、背景 alpha `.1`、radius `8px` | 证据已确认，设计意图待确认 |
| B-16 | 共享 | 禁用态透明度至少同时出现全局 `.42`、标题栏 `.25/.26`、Sheet launcher `.38`、浏览器 `.35/.4`、FileSheet `.38/.42/.45/.5`、Settings `.38/.42/.45` 等档位；同一禁用语义无法从 token 推断统一呈现 | `src/index.css:191-200`；`src/plugins/product/packages/builtin.pylon-shell/styles/App.css:56,66,132,179`；`src/plugins/product/packages/builtin.pylon-shell/styles/components/Settings.css:169,180,607`；`src/plugins/product/packages/builtin.pylon-workspace/styles/sheets/browser/BrowserSheet.css:72,92`；`.../file/FileSheet.css:236,353,575,950,969,1032`；动态采样重开 Sheet 按钮 computed `opacity:.26` | 证据已确认，设计意图待确认 |
| B-17 | 共享（terminal-like 优先） | 默认主题重置后切到深色时，`data-ui-scheme=dark` 仅改变通用文字/边框 token；`body::before` 仍消费浅色 `--global-bg-color:#e8e8ec`，消息行仍消费显式黑色 `--chat-text-color/#msg-text`，工具行又继承白色 `--text`，同一深色画布出现浅灰背景、黑字消息和白字工具的混合对比 | `src/index.css:115-163`；`src/themeFieldDefs.ts:89-116`；`src/domains/theme/themeCssSnapshot.ts:36-50`；默认重置 + 深色动态采样见 1.11（截图背景样本约 RGB 173–179，白色 90% 前景计算对比度约 1.97–2.11:1，低于普通文本 4.5:1） | 证据已确认，设计意图/修复边界待确认 |
| B-18 | 共享（terminal-like 优先） | 带输出的 `cancelled` 工具会先被 `resolvedToolIds` 判为 `completed`，因此取消态在 DOM 中显示完成 glyph/色和“已完成”标签；状态矩阵无法保留取消语义 | `src/components/chat/messageLookups.ts:18-27` 将任意 `toolOutput !== undefined` 加入 resolved；`src/components/chat/chatRowPipeline.ts:33-43` 在 normalize 前优先返回 `completed`；fixture `src/components/chat/chatMockData.ts:124-149` 提供带输出的 cancelled 样本；动态 task-swarm 见 1.13 | 证据已确认，是否允许修正展示态需确认（不改变后端状态机） |
| B-19 | 共享（Solid renderer） | `prefers-reduced-motion=false` 时，运行/等待工具指示器的 computed `animation` 仍为 `none`；Solid snapshot 路径只输出 tone class，未输出 motion class，React fallback 路径才调用 motion class | `src/renderers/solid-workbench/chat/ToolInvocationCard.solid.tsx:76-88`；对照 `src/renderers/solid-workbench/chat/ToolCard.solid.tsx:91-97`；`src/components/chat/toolIndicatorMotion.ts:18-31`；动态采样见 1.13 | 证据已确认，设计意图待确认 |
| B-20 | terminal-like（默认浅色） | 默认浅色主题的工具状态色直接用于 indicator/name：`run #93A5FF`、`ok #4EBA65`、`err #FF6B80` 对 `#e8e8ec` 的计算对比度分别约 `1.90:1/2.01:1/2.24:1`，均低于普通 UI 图形 3:1 门槛 | `src/themeFieldDefs.ts:146-151`；`src/plugins/product/packages/builtin.pylon-renderers/styles/components/chat/ChatView.css:273-292`；默认浅色动态变量与计算见 1.14 | 证据已确认，色板调整边界待确认 |
| B-21 | 共享（terminal-like 优先） | 会话存在但消息数组为空时不进入品牌空态：`ChatView` 只以 `sessionId` 是否存在决定空态，`demo-empty` 的可见工作台因此只有空白消息区和输入栏，没有空态标题/说明/开始步骤 | `src/components/chat/ChatView.tsx:187-192`；`src/demo/visualQaData.ts:168-170`；动态采样见 1.15 | 证据已确认，空会话是否采用同一品牌空态待确认 |
| B-22 | 共享（Settings） | Settings 视觉上是覆盖层，但根节点是无语义 `<div class="settings">`，没有 `role="dialog"`、`aria-modal` 或 `aria-labelledby`；打开时没有把焦点移入设置，也没有焦点循环/背景 inert。动态首轮 Tab 仍落到设置外标题栏窗口按钮与错误中心 | `src/components/Settings.tsx:571-580`；`src/App.tsx` 的条件挂载；`src/plugins/product/packages/builtin.pylon-shell/styles/App.css:377-395` 仅禁用部分 pointer 事件；动态采样见 1.16 | 证据已确认，是否采用真正 modal 焦点模型（并保留窗口三按钮例外）待确认 |
| B-23 | 共享（Sheet） | 同一窗口宽度下不同 Sheet 采用互不一致的响应式策略：Overview 在 `1060/760/520` 分级，Browser 在 `720` 把侧栏折为 `42px`，File 在 `900` 仍保持 `250px`，Gateway 在 `720` 仍保持 `250px`，History/Search 在 `720` 改为 `190px`，Prism 在 `820` 只堆叠内部列表，Runtime 没有媒体断点；同一 viewport 无法推断统一的内容保留规则 | `src/plugins/product/packages/builtin.pylon-workspace/styles/sheets/OverviewSheetView.css:21-23`；`browser/BrowserSheet.css:107-114`；`file/FileSheet.css:923-928`；`gateway/GatewaySheet.css:279-285`；`history/HistorySheet.css:150-155`；`search/SearchSheet.css:161-166`；`styles/components/PrismSheet.css:241-246`；Runtime 无 `@media` | 证据已确认，断点与侧栏策略待确认 |
| B-24 | 共享（terminal-like 优先） | 多个操作只在 hover 时显现：助手复制按钮默认 `opacity:0`、Sheet tab 关闭按钮默认 `visibility:hidden/opacity:0`、工具对象操作默认 `opacity:0`；部分有 `focus-within` 或窄屏补偿，但不存在覆盖所有触屏/无 hover 场景的统一规则，导致同一类“可操作但不可发现”状态不一致 | `src/plugins/product/packages/builtin.pylon-renderers/styles/components/chat/ChatView.css:68-74,901-904`；`src/plugins/product/packages/builtin.pylon-shell/styles/App.css:111-118`；`src/plugins/product/packages/builtin.pylon-workspace/styles/components/Sidebar.css:76-82,252`；仅 `.tool-object-actions` 在 `ChatView.css:979-985` 的 `max-width:720px` 常驻 | 证据已确认，是否统一为常驻/触屏常驻/显式菜单待确认 |
| B-25 | 共享（light/Settings 优先） | 浅色 scheme 的辅助文字统一使用 `rgba(0,0,0,.40)`；Settings 标题说明为 `9px`，导航/提示多为 `10–12px`。以实际 header 背景 `color(srgb .913333 .920392 .943137)` 合成，`.settings-header p` 与关闭按钮前景对比度约 `2.78:1`，低于普通文本 `4.5:1`；同一 dim 色还被复用于大量可操作导航/状态摘要 | `src/index.css:99-101`；`src/plugins/product/packages/builtin.pylon-shell/styles/components/Settings.css:17-24,40`；动态批次 K（浅色统计）与对比度计算 | 证据已确认，辅助文字是否提升为正文级 token 待确认 |
| B-26 | terminal-like（重点） | CLI 输入的 textarea `:focus` 明确设置 `outline:none; border:none; box-shadow:none`，且经典终端 token `--input-focus-ring-width=0px`；CLI 行的上下 accent 边线在聚焦前后保持同值，没有 focus-within 差异，键盘焦点只能依赖 caret | `src/plugins/product/packages/builtin.pylon-renderers/styles/components/chat/InputBar.css:198-223`；`src/index.css:184-189` 的全局 focus 规则被 CLI 规则覆盖；动态批次 M | 证据已确认，焦点反馈是否增加独立可见层待确认 |

**静态复杂度指标（用于定位，不等于缺陷数）**

- CSS 文件：28。
- 含 `border-radius:` 的声明行：481；不含 `var(...)` 的行约 205（按当前源码逐行扫描，单行多声明仍计 1 行）。
- 含 `box-shadow:` 的声明行：152；不含 `var(...)` 的行约 26（同上计数规则）。
- 含 transition/animation 的声明行：162。
- 含 hex/rgb/rgba/color-mix 等颜色文本的行：约 630（含同一行多处颜色和注释匹配，作为扫描量而非缺陷数）。

### 1.6 当前状态矩阵（初版）

| 组件/状态 | 代码覆盖证据 | 初步观察 | 尚缺证据 |
|---|---|---|---|
| 空态 | `ChatView.tsx:187-192`、`AgentEmptyState.tsx:10-24` | 有品牌、说明、步骤和窄屏单列规则 | 两种 mode × light/dark × 字号放大 |
| user/assistant/reasoning 消息 | `ChatView.tsx:401-439`；`ChatView.css:25-36,346-400` | 两种 mode 有不同几何；profile 可改变背景/radius/字体 | 对比度、长词、滚动位置、窄屏 |
| reasoning | `ChatView.tsx:592-627` | `running/complete/redacted/missing` 四态有渲染分支；当前压力场景只出现 `complete` | `redacted`、`missing` 没有 visual QA fixture，四态在两主题下的颜色/动画/键盘表现仍需补样例 |
| tool | `ChatView.tsx:630-682`；`status.ts:9-53` | 7 态归一化与标签已有单一真值 | 每态的图形、色彩、连接线、hover/focus/disabled |
| 输入栏 | `InputBar.tsx:51-99`；`InputBar.css:1-36,80-238` | 错误、binding、命令建议、历史、队列、附件均有入口 | 叠加顺序、键盘焦点、窄屏和 disabled/loading |
| 会话操作 | `Sidebar.css:76-82` | hover/focus-within 显示操作 | 键盘初次发现、触屏持久显示、字号放大 |
| Settings | `Settings.tsx:571-721`；`Settings.css:1-11,261-296` | 多层导航/字段/预览 pane，使用透明材质；打开时标题栏仅部分 pointer 事件被禁用 | 遮罩对比度、焦点顺序、420px 最小宽度、modal 语义 |
| 标题栏/Sheet tab | `WorkspaceTitlebar.tsx:77-125`；`App.css:86-90` | mode 有不同高度和控件图形；有 overflow 分支 | 480/680/900px、超长标题、禁用态 |
| reduced motion | `index.css:170-181`；`ChatView.css:539-557` | 全局 token 与局部动画均有降级 | 实际开启系统设置后的全部状态截图/录屏 |

补充：Settings 的“视觉覆盖层”本身也列入键盘状态验收；不能只检查颜色和几何，还要记录打开/关闭时焦点起点、Tab 是否越出覆盖层、背景控件是否仍可聚焦。

### 1.7 基线问题归类

下表记录 26 条问题的归类维度；最终结果以 1.7.1 为准。

| 议题 | 候选编号 | 需要确认的边界 |
|---|---|---|
| token 与基础尺度 | B-01、B-04、B-05、B-16 | 是否收敛 spacing/radius/shadow/motion/disabled 档位，以及允许保留多少局部例外 |
| palette、scheme 与对比度 | B-02、B-03、B-07、B-17、B-20、B-25 | mode 是否拥有独立 palette；显式 preset 值如何与 light/dark 共存；线条、状态色、辅助文字的最低对比度边界 |
| modern-gui / Settings 表面 | B-06、B-10、B-12 | 多层玻璃与 Sheet 外壳是否保留；若收敛，哪些层是语义必需层 |
| 尺寸、标题与响应式 | B-11、B-13、B-14、B-23 | 最小窗口宽度、字号范围、长标题策略、各 Sheet 是否采用统一断点/侧栏收缩规则 |
| 状态与交互反馈 | B-08、B-15、B-18、B-19、B-21、B-24、B-26 | 工具/推理状态是否逐态区分；取消态展示边界；空会话、hover-only、CLI focus-within 的目标反馈 |
| 键盘与 modal | B-09、B-22 | 会话操作发现方式；Settings 是否采用 modal 焦点移入、循环和背景 inert，窗口三按钮是否例外 |

请同时补充源码/演示数据尚未覆盖的具体问题（截图、操作步骤或期望结果均可）；新增问题会按 `B-27` 起连续编号并写入本节与第 4 节。

建议回执格式：

```text
纳入后续改造：B-…
保留现状：B-…
需要补证据：B-…（希望补哪种环境/fixture：…）
新增问题：…
```

#### B-01 当前讨论（已确认纳入后续改造）

**问题边界**：全局已有 `--ui-space-*`、`--ui-radius-*`、`--shadow-*`、`--motion-*` 等 token，但共享/模式 CSS 仍直接写入大量 radius、shadow、transition、颜色和间距值。该事实不意味着每一个字面值都必须删除：终端线宽、窗口系统按钮等模式专属值可能需要保留并登记例外。

**基线处置候选**：

| 选择 | 含义 | 收益 | 代价/影响 |
|---|---|---|---|
| 保留现状 | 将 B-01 从后续改造范围移除，只在新增样式时自愿使用 token | 不动既有视觉契约，改动面最小 | 481 行 radius / 152 行 shadow 的分散值继续存在，主题和跨模式一致性无法由源码直接验证 |
| 纳入后续改造（建议） | 将共享 primitive 迁移到语义 token；模式专属例外逐项登记，不要求 terminal-like 与 modern-gui 使用同一几何值 | 可用静态扫描验收 token 覆盖率，降低后续主题漂移；先做 terminal-like 不会阻止其保留硬朗几何 | CSS 改动面较大，可能有意改变部分现有圆角/阴影，需要视觉回归和例外清单 |
| 需要补证据 | 先输出 481/152 行逐条分类（共享值、模式值、状态值、浏览器/系统值），再决定迁移范围 | 避免把有意的模式差异误收敛 | 延后收益；分类本身增加一轮审计工作 |

本条只请确认 B-01 是否作为“问题”纳入基线及采用哪种处置；具体 token 档位、例外规则和迁移顺序留到阶段 1 再拍板。

**B-01 结论（2026-08-28）**：用户选择“纳入后续改造”。后续范围限定为宿主/契约层的共享 primitive 优先迁移到语义 token；`terminal-like`/`modern-gui` 的宿主模式专属值可以保留，但按 Q1/Q5 的边界逐项登记例外并纳入静态扫描验收；外部插件内部专属值在满足 Q2/Q4 的前提下可自由保留，不建立统一直接值例外清单，改由逐插件回归与 conformance 检查验证。具体档位与迁移顺序尚未拍板。

#### B-02 当前讨论（待用户选择）

**问题边界**：interface mode 切换会应用所选 Presentation Profile 的几何/状态 token，但不会同时重置 palette、背景或用户资产。也就是说，模式变化和颜色变化不是一个成对提交的视觉事务；显式主题字段可能继续沿用切换前的值。

**证据摘要**：`applyPresentationProfile.ts:10-23` 按 profile token 分区写入并设置 active profile，函数注释明确“不重置 palette、background 或 user assets”；`activateInterfaceMode.ts:74-96` 通过该路径激活模式。动态批次 N 中，`terminal-classic → modern-gui` 使 `--input-radius` 从 `0px` 变为 `16px`、`--message-radius` 从 `0px` 变为 `16px`、`--input-focus-ring-width` 从 `0px` 变为 `4px`，但 `--global-bg-color`、`--chat-text-color`、`--msg-text`、`--text` 和 `--border` 保持原值。

**基线处置候选**：

| 选择 | 含义 | 收益 | 代价/影响 |
|---|---|---|---|
| 保留现状 | 认为 mode 只负责几何/排版，颜色由用户独立维护；B-02 不进入后续改造 | 保留用户自定义主题，切换模式不会覆盖资产 | 可能出现模式几何与 palette 不匹配；跨 scheme 的混合前景问题继续由用户自行承担 |
| 纳入后续改造（建议） | 把“模式 + profile + palette 兼容性”作为视觉层联动规则；切换时至少校验/补齐缺失语义值，不改变业务状态 | 减少浅深色和模式切换后的混合表面；终端优先时可定义 terminal-safe palette | 可能改变现有自定义主题的呈现；需要明确哪些用户字段保留、哪些字段按 scheme/profile 回退 |
| 需要补证据 | 以多个自定义 preset、用户资产和两种 scheme 重复切换，记录哪些字段应保留、哪些字段造成不可读组合 | 先厘清“用户有意覆盖”与“视觉冲突”边界 | 增加组合测试成本，暂不解决现象 |

本条只请确认 B-02 是否纳入基线及处置方向；具体 palette token、回退优先级和切换动画留到阶段 1 再讨论。

### 1.7.1 六个闸门后的最终归类（已确认）

以下归类只把已经拍板的边界应用到现有证据，不替代阶段 1 的具体 token 数值或组件方案。状态含义：

- **纳入后续改造**：宿主/共享层需要产生可执行改动，或必须补齐跨插件 conformance；插件内部差异仍按右栏边界处理。
- **保留现状（附底线验收）**：差异本身不构成缺陷，但仍必须满足 Q2/Q4 的硬底线；若验收失败，再转为改造项。
- **纳入宿主边界、保留插件差异**：只修宿主槽位/契约，不要求外部插件采用同一几何或断点。

| 编号 | 建议归类 | 适用范围 | 归类依据与后续边界 |
|---|---|---|---|
| B-01 | 纳入后续改造 | 宿主/共享 primitive | 按 Q5 C 迁移共享宿主值到语义 token；`terminal-like`/`modern-gui` 专属值可登记保留；外部插件直接值不因存在本身整改。 |
| B-02 | 纳入后续改造 | mode/profile 宿主链路 | 按 Q3 B 将几何、palette、背景和状态色作为成套视觉事务；不改变业务状态。 |
| B-03 | 纳入后续改造 | scheme 与宿主显式主题字段 | 修复 scheme 切换后显式背景/前景残留和混合 palette；插件 namespace 不被宿主覆盖。 |
| B-04 | 纳入后续改造 | 宿主/共享 radius | 统一宿主语义档位并保留已登记的模式专属例外；外部插件内部半径自由。 |
| B-05 | 纳入后续改造 | 宿主/共享 motion | 宿主过渡/动画消费 motion 规则；插件可自定义节奏，但所有非必要动效都必须遵守 reduced-motion。 |
| B-06 | 纳入后续改造 | modern-gui 宿主表面 | 复核可见表面层级、叠加和对比度；允许外部 Sheet 保留自己的材质层，不要求全局削成同一层数。 |
| B-07 | 纳入后续改造 | terminal-like 工具线/边界 | 按 Q2 修正低于 `3:1` 的非文本边界；线宽、颜色和 glyph 形式可由模式决定。 |
| B-08 | 纳入后续改造 | 内置与外部状态 fixture | 补齐 7 态工具、reasoning、hover/focus/disabled/loading 等逐插件 Q2 验收；不要求每态使用独立 tone。 |
| B-09 | 纳入后续改造 | 内置 Sidebar 操作 | 为键盘、触屏和无 hover 环境提供可发现且可聚焦的入口；外部插件只受 Q2/Q4 契约约束。 |
| B-10 | 纳入后续改造 | Settings 宿主覆盖层 | 可保留 terminal/GUI 不同材质，但必须修正合成后的可读性、遮罩层级和焦点呈现。 |
| B-11 | 纳入后续改造 | 宿主布局预算 | 按 Q4 保护中心 workbench/CLI 最小内容预算，侧栏按优先级收缩；不以强制统一插件内部宽度解决。 |
| B-12 | 纳入宿主边界、保留插件差异 | 共享/内置 Sheet 外壳 | 收口宿主 Sheet shell 的语义表面和可追溯 token；外部 Sheet 内部圆角、阴影和材质可自定义。 |
| B-13 | 纳入后续改造 | 宿主标题栏与 tab 区 | 保证窄视口下标题栏按钮、活动 tab 和恢复入口仍可用；不改变 tab 操作语义。 |
| B-14 | 纳入后续改造 | 宿主字号、行高与内容预算 | 建立宿主 type/line-height 缩放和长词保护；插件内部排版可不同，但不得越过 Q2/Q4 安全边界。 |
| B-15 | 保留现状（附底线验收） | 工具状态视觉 tone | Q6 C 允许多个业务态共享 tone/glyph；必须保留可读状态名称和至少一种非颜色辨识线索，否则按 Q2 失败转改造。 |
| B-16 | 纳入后续改造 | 宿主/共享 disabled 表现 | 收敛宿主禁用 token 和可读性；外部插件透明度可自定义，但 disabled 必须可辨识且不可误操作。 |
| B-17 | 纳入后续改造 | scheme 与 terminal-like palette | 修复默认深色下背景、消息、工具文字的混合对比；终端专属硬边/线条仍可保留。 |
| B-18 | 纳入后续改造 | 展示映射层 | 修正带输出 `cancelled` 被显示为 `completed` 的错误映射；不得修改后端状态机、业务数据或命令行为。 |
| B-19 | 保留现状（附底线验收） | renderer/plugin 动画 | 动画不是必需的视觉配方；静态 running/waiting 也可通过其他线索满足 Q2，但不得缺少可辨识状态，且非必要动画须支持 reduced-motion。 |
| B-20 | 纳入后续改造 | terminal-like 浅色状态色 | 按 Q2 提升工具状态及其边界的对比度至门槛；具体色相和 glyph 仍由模式 palette 决定。 |
| B-21 | 纳入后续改造 | 内置空会话 | 空消息区必须有可辨识的空态反馈；品牌标题、说明和步骤的具体形式可由 terminal-like 设计决定，不强制外部插件复用。 |
| B-22 | 纳入后续改造 | Settings modal 宿主 | 补齐 dialog 语义、可见焦点、焦点移入/恢复和背景不可误聚焦；保留窗口系统按钮例外规则。 |
| B-23 | 纳入宿主边界、保留插件差异 | Sheet 响应式 | 不把不同插件断点本身判为缺陷；宿主必须执行 Q4 内容预算、收缩/堆叠声明和恢复入口，内置 Sheet 先补齐声明。 |
| B-24 | 纳入后续改造 | 内置交互控件；外部插件 conformance | 内置 hover-only 操作增加键盘/触屏可发现路径；插件可选常驻、focus-within 或菜单形式，但不能违反 Q2/Q4。 |
| B-25 | 纳入后续改造 | light/Settings 宿主辅助文字 | 提升低于 Q2 门槛的辅助文字和可操作摘要；字号层级可重设但不得依赖更小字号解决对比度。 |
| B-26 | 纳入后续改造 | terminal-like CLI 输入 | 增加可见 `focus-visible`/`focus-within` 层；具体线条、accent 或 glyph 可保持终端语言，但聚焦前后必须有可测差异。 |

**基线确认（2026-08-28）**：用户以“开始派发”确认上表为阶段 0 的唯一问题归类。后续新增观察从 B-27 起编号；推翻现有归类必须追加到第 4 节，不静默改写原决策。

### 1.8 阶段 0 后续复测协议

基线定稿前已按以下协议完成 A～N 的大部分采样；若用户把某项标为“需要补证据”，补测仍沿用同一变量组合并把结果追加到本节：

- 视口：`1280×720`、`900×720`、`680×720`、`480×720`。
- interface mode：`terminal-like`、`modern-gui`。
- UI scheme：`dark`、`light`，并在 Settings 中执行一次明确“重置主题/预设”后复测。
- 字号：默认值、至少放大到 125% 和 150%；已完成默认/125%/字段上限 24px，150% 系统级缩放仍待指定环境；记录横向溢出、截断、按钮可达性。
- 状态：空态、长标题、长词、多语言、reasoning 四态、工具七态、输入错误/binding/命令/队列、Settings 打开态。
- 可访问性：键盘 Tab 顺序、`focus-visible` 可见性、禁用态指针/键盘反馈已采样；`prefers-reduced-motion: reduce` 仍需在真实匹配环境复测 computed `animation/transition`。
- Sheet 一致性：同一 viewport 逐个打开 Overview/Runtime/Browser/File/Gateway/History/Search/Prism，记录侧栏宽度、主区最小宽度、输入控件是否仍可用；不以单个 Sheet 的“看起来能挤下”作为通过条件。
- Settings 模态：记录打开后的焦点元素、连续 12 次 Tab 的内外归属、关闭后的焦点恢复元素，以及窗口三按钮例外是否符合拍板规则。

对比度将用计算后的前景/背景颜色记录数值（普通文本目标至少 4.5:1，大文本目标至少 3:1；若项目决定更严格标准，写入阶段 1 决策），不以“看起来清楚”作为验收语句。

### 1.9 动态核验批次 A：modern-gui 响应式与浅色基线（2026-08-28）

本批使用浏览器 viewport capability 设置请求尺寸；浏览器宿主保留的外框使页面实际 `innerWidth/innerHeight` 比请求值少约 `116/65px`，以下统一记录页面实际 CSS viewport。页面状态为 `modern-gui` + `builtin.presentation.modern-gui` + `light`，右栏未手动关闭。

| 请求尺寸 | 页面实际 viewport | 左栏 rect | 右栏 rect | 主 `.term` 宽度 | 输入栏宽度 | 结果 |
|---:|---:|---:|---:|---:|---:|---|
| 1280×720 | 1164×655 | 250px | 260px | 616.2px | 597.7px | 主区仍可用；Sheet tab region 已 `overflowed=true` |
| 900×720 | 818×655 | 250px | 260px | 270.7px | 252.2px | 主区显著收窄；tab region 仅约 114px |
| 680×720 | 618×655 | 250px | 260px | 70.7px | 52.2px | 主区被固定两侧栏挤压；tab region 约 14px |
| 480×720 | 436×655 | 250px | 260px | 28px | 17.8px | 右栏从 x=274 延伸到 534px，超出 viewport；layout scrollWidth=542px，主区不可实际阅读 |

补充 DOM/样式证据：四个尺寸下 `.sidebar` 均保持 `min-width:250px`、`.context-panel` 均保持 `width:260px`，右栏 `display:flex` 未自动收起；`layout` 虽 `overflow-x:hidden`，但未改变两侧栏占用的 flex 空间。该结果将 B-11 从“待复测”更新为“动态证据已复现，是否纳入改造待确认”。

同一批次在默认大视口（1738×819）采集到的浅色 computed style：

| 元素 | computed 前景/背景 |
|---|---|
| `.workspace-titlebar` | `color: rgb(255,255,255)`；背景 `color(srgb 0.810353 0.813647 0.826824 / 0.5772)` |
| `.sidebar` | 背景 `color(srgb 0.852392 0.855843 0.869647 / 0.602)`；前景 `rgba(0,0,0,.85)` |
| `.term` | 前景 `rgba(0,0,0,.85)`；本身透明，实际背景由 `::before`/`--chat-bg` 提供 |
| `.input-bar` | 背景 `rgba(148,163,184,.1)`、radius `16px`、height `64.8px`；文字继承深色 `--text` |

标题栏白字与浅色半透明背景的组合已被复现；消息文字/聊天画布需在“重置主题”后再次采集，暂不把单次持久化状态直接定性为默认 profile 缺陷。

### 1.10 动态核验批次 B：terminal-like 响应式、模式耦合与状态反馈（2026-08-28）

本批在不改主题字段的前提下切换到重点模式 `terminal-like`，页面实际 CSS viewport 与批次 A 相同。右栏保持打开，默认左栏保持 250px。

| 请求尺寸 | 页面实际 viewport | `.term` 宽度 | 输入栏宽度 | 右栏 | layout scrollWidth | 结果 |
|---:|---:|---:|---:|---:|---:|---|
| 1280×720 | 1164×655 | 648.2px | 629.7px | 260px | 1164px | tab region `overflowed=true` |
| 900×720 | 818×655 | 302.7px | 284.2px | 260px | 818px | 主消息列明显收窄 |
| 680×720 | 618×655 | 102.7px | 84.2px | 260px | 618px | 输入控件只剩窄条 |
| 480×720 | 436×655 | 32px | 0px | 260px（x=250） | 510px | 主区和输入栏不可实际使用，布局横向内容超出 viewport |

终端模式浅色自定义主题的同屏 CSS 变量快照：`uiScheme=light`，但 `--global-bg-color/#chat-bg/#sidebar-bg/#right-bg/#titlebar-bg` 均为 `#000000`，`--chat-text-color/--msg-text/--titlebar-text` 均为 `#FFFFFF`，而全局 `--text` 为 `rgba(0,0,0,0.85)`。因此终端消息行是白字黑底，侧栏/右栏/输入栏继承深色文字变量；这证明“模式切换保留 palette/background”在当前自定义状态下会产生跨区域色彩语义不一致（默认值仍需独立复测）。

工具状态动态采样（当前 `terminal-like` 页面可见样本）：

| 语义标签 | indicator class | 前景色 | 背景 | radius |
|---|---|---|---|---:|
| 已完成 | `.term-tool-indicator.ok` | `rgb(74,222,128)` | `color(srgb .290196 .870588 .501961 / .1)` | 8px |
| 失败 | `.term-tool-indicator.err` | `rgb(248,113,113)` | `color(srgb .972549 .443137 .443137 / .1)` | 8px |
| 运行中 | `.term-tool-indicator.run` | `rgb(215,119,87)` | `color(srgb .843137 .466667 .341177 / .1)` | 8px |
| 等待中 / 排队中 / 状态未知 | `.term-tool-indicator.run` | `rgb(215,119,87)` | 同上 | 8px |

键盘焦点采样：会话 gear/delete 在未 hover/focus 时 computed `opacity:0`；Tab 进入第一个 gear 后约 180ms，`opacity:1`、`:focus-visible=true`、outline 为 accent 实线（DPR 1.1 下约 1.82px）。这证明键盘路径存在，但操作在获得焦点前不可见；触屏常驻显示仍需单独设备/媒体能力证据。

动效代表值采样与源码交叉核对：搜索框 transition 为 `120ms cubic-bezier(.2,0,0,1)`，会话项同为 120ms；输入区局部 transition 使用 140/160/180ms；reasoning pulse/shimmer 使用 1.4s/1.8s；工具 connector/indicator 另有 1.1s、1.3s、1.8s、320/360ms；这些值与全局 120/180/260ms token 并行存在（详见 B-05）。

### 1.11 动态核验批次 C：默认主题明暗切换对照（2026-08-28）

本批先在 Settings 执行“重置主题”，再分别点击“浅色/深色”，以排除之前持久化自定义值的影响；视口请求为 `900×720`，页面实际 CSS viewport 为 `818×655`。测试只读取渲染结果，未修改产品代码。

| 条件 | `data-ui-scheme` | `--global-bg-color` | 消息行颜色 | body 背景伪元素 | 结果 |
|---|---|---|---|---|---|
| 重置后浅色 | `light` | `#e8e8ec` | `rgba(0,0,0,.85)` | `rgb(232,232,236)`，opacity `.85` | 主要正文前景/画布组合可读；仍需对状态色、边界和预设逐项算对比度 |
| 重置后深色 | `dark` | 仍为 `#e8e8ec` | 仍为 `rgba(0,0,0,.85)` | `rgb(232,232,236)`，opacity `.85` | 通用 token 已变白，但显式主题字段未变；工具行继承 `rgba(255,255,255,.90)`，形成黑字/白字并存 |

深色截图（同一批次）背景像素样本为 RGB `[173,172,176]`、`[179,178,182]`、`[175,174,178]`。按 CSS 前景 `rgba(255,255,255,.90)` 与这些背景合成后，普通文本对比度约 `1.97–2.11:1`；低于本项目暂定的普通文本 `4.5:1` 门槛。该数值用于确认 B-17 的可判定性，不等同于阶段 1 的最终色板标准。

源码链路核对：`index.css:115-142` 的 scheme 规则只覆盖通用 surface/text token；`index.css:153-163` 的 body 背景继续读取 `--global-bg-color`；`themeCssSnapshot.ts:36-50` 把非空主题字段显式注入 body。由此可将“默认深色缺陷”与“自定义值导致的混合”区分为同一机制的两种复现路径。

### 1.12 动态核验批次 D：基础字号放大与固定字阶（2026-08-28）

通过 Settings 的“基础字号”字段先设为 `22.5px`（相对默认 `18px` 为 125%），再设为字段上限 `24px`；视口请求 `900×720`（实际 `818×655`）。

| 基础字号 | 根/输入栏 computed | 标题栏 computed | 聊天/工具 computed | 布局证据 |
|---:|---:|---:|---:|---|
| `22.5px` | body/input `22.5px` | titlebar `12px` | `.term`/消息/工具约 `15px` | 标准视口无文档级横向溢出，但字阶没有按比例同步 |
| `24px`（字段上限） | body/input `24px` | titlebar `12px` | `.term`/消息/工具约 `15px` | 在实际 `818px` 宽度下，首个 user row `scrollWidth=274px`、`clientWidth=239px`；其父消息列宽约 `303px`，长词内容已产生内部横向溢出压力 |

该批同时观察到：根字号变化会放大继承 `var(--global-font-size)` 的侧栏/输入文本，但 `ChatView.css:22,368-372` 和 `App.css` 中的固定 `12/13/14/15px` 字阶保持不变；因此“基础字号”不是覆盖所有主要文本的单一缩放入口。应用字段上限为 `24px`，无法仅靠该控件复现 150%（`27px`）场景，150% 仍列为后续验收环境而非当前已通过项。

### 1.13 动态核验批次 E：terminal-like 工具/推理状态矩阵（2026-08-28）

切换到重点模式的 `Pi` 工作台并选择演示会话“并行任务与工具状态压力场景”。浏览器报告 `prefers-reduced-motion=false`。可见工具卡的实际 DOM 状态如下（同一序列会在压力场景中重复）：

| fixture 预期 | 可见 `data-tool-state` | tone/glyph | 可见 motion class | 结论 |
|---|---|---|---|---|
| completed | `completed` | `ok` / `✓` | 仅 `term-tool-indicator ok` | 完成态可见 |
| in_progress / running | `running` | `run` / `●` | 仅 `term-tool-indicator run`，computed `animation:none` | B-19：运行态没有进入动画规则 |
| waiting | `waiting` | `run` / `●` | 同上，computed `animation:none` | B-19：等待态与运行态共享静态呈现 |
| queued | `queued` | `run` / `●` | 同上，computed `animation:none` | 只有 opacity 规则，未形成独立节奏 |
| failed | `failed` | `err` / `×` | 仅 `term-tool-indicator err` | 失败态可见 |
| cancelled（fixture 带输出） | `completed` | `ok` / `✓` | 仅 `term-tool-indicator ok` | B-18：预期取消态被 resolved lookup 覆盖 |
| future-status/unknown | `unknown` | `run` / `●` | 仅 `term-tool-indicator run` | 未知态与运行色共享 |

同批次可见推理块均为 `data-state="complete"`、可折叠 `<button>`；`redacted`、`missing` 两个分支在当前压力场景没有 fixture，尚无真实渲染截图/对比度证据。该缺口暂记为状态矩阵待补样例，不直接推断为实现缺陷。

### 1.14 动态核验批次 F：默认浅色 terminal 状态色对比度（2026-08-28）

在“重置主题 → 浅色”后采集 body 主题变量：`--global-bg-color=#e8e8ec`、`--tool-run=#93A5FF`、`--tool-ok=#4EBA65`、`--tool-err=#FF6B80`。CSS 将这三色同时用于工具指示器和工具名（`ChatView.css:273-292`）。按 sRGB 相对亮度公式计算：

| 颜色 | 与 `#e8e8ec` 对比度 |
|---|---:|
| `#93A5FF`（run） | `1.90:1` |
| `#4EBA65`（ok） | `2.01:1` |
| `#FF6B80`（err） | `2.24:1` |
| `#3b82f6`（accent，参照） | `3.01:1` |

以上均未达到普通 UI 图形/非文字控件常用的 `3:1`，更未达到普通文本 `4.5:1`。这是默认浅色值的静态计算与运行时变量采样，不把带透明 surface 的最终合成色误当成单一背景；后续验收仍需对实际 surface 合成后的前景/背景逐元素复算。

### 1.15 动态核验批次 G：零消息会话空态（2026-08-28）

在 `Pi` 工作台选择演示会话“空白新会话”（`demo-empty`）后，活动工作台 `data-session-id="demo-empty"`，`.chat-view` 的实际尺寸约 `1228.18×625.10px`；`.term` 文本为空，页面没有 `.agent-empty-state`、`role="region"` 空态标题或步骤列表，只有底部 `.input-bar`（约 `1204.20×37.61px`）。

代码路径明确：`ChatView.tsx:187-192` 仅在 `!sessionId` 时返回 `AgentEmptyState`；`visualQaData.ts:168-170` 的 `demo-empty` 是“有 sessionId、消息数组为空”。因此“未选会话空态”和“已有会话但零消息空态”目前是两条不同视觉路径，后者没有显式状态反馈（B-21）。

### 1.16 动态核验批次 H：Settings 模态焦点与 Sheet skin/断点静态核对（2026-08-28）

**Settings 焦点与语义（重点模式 terminal-like，标准视口 `1738×819`）**

- 打开 Settings 后，根节点 `.settings` 的 computed/DOM 属性为：`role=null`、`aria-modal=null`、`aria-label=null`、`tabindex=null`；`document.activeElement` 仍是设置按钮（位于 Settings 外）。
- 重新打开后连续按 Tab，前四个焦点依次落在 `.titlebar-window-btn` 的“最小化”“最大化或还原”“关闭窗口”和外部“查看运行错误”按钮，均 `inside=false`；焦点没有被覆盖层收束。
- 可见可聚焦控件统计为 Settings 外 179 个、Settings 内 81 个。`App.css:377-395` 只对标题栏的部分子节点设置 `pointer-events:none`，没有 `inert` 或键盘焦点边界。
- `.settings` 标准 terminal-like computed rect 约为 `x=0,y=44,w=1738,h=775`，自身 `z-index:50`；窗口按钮仍由标题栏 `z-index:60` 保留可点。这说明“保留系统窗口按钮”是现有实现事实，但其余外部焦点是否应可达仍需设计拍板（B-22）。

**Sheet skin 重复与断点**

- `builtin.pylon-workspace/styles/sheets` 及 `styles/components/PrismSheet.css` 共 8 个入口；其中 7 个入口重复写 modern-gui 壳的 `border-radius:16px` 与 `box-shadow:0 16px 44px color-mix(...)`，并重复写侧栏 `margin:8px`、`border-radius:13px`。这些值没有引用 `--ui-radius-*`/`--shadow-*` token（B-12）。
- 响应式媒体查询实际分布为：Overview `1060/760/520px`；Browser `720px` 时侧栏收为 `42px`；File `900px` 仍保留 `250px`；Gateway `720px` 仍保留 `250px`；History/Search `720px` 改为 `190px`；Prism `820px` 将内部 split 改为纵向；Runtime 没有 `@media`。同一窗口宽度因 Sheet 类型不同会得到不同侧栏和内容保留行为（B-23）。

**标题栏窄视口**

- terminal-like 请求 `480×720` 时页面实际 viewport 为 `436×655`；固定左栏与窗口按钮占满标题栏中间轨道，`.sheet-tab-region` 实测宽度 `0px`、`scrollWidth=32px`，但单个 tab 仍保持 `120px`。第一个活动 tab 的标题可视宽约 `49px`、内容滚动宽约 `71px`，其余 tab 的关闭按钮仍为 `visibility:hidden/opacity:0`（B-13）。

**会话操作触屏可发现性**

- `Sidebar.css:76-82` 的 `.session-gear/.session-del` 默认 `opacity:0`，只由 `.session-item:hover` 或 `:focus-within` 恢复；唯一 `@media (hover:none)`（同文件 252 行）只处理 `.cwd-group-actions`。因此触屏/无 hover 指针下，会话操作没有对应的常驻或显式菜单规则（B-09）。

**其他 hover-only 控件**

- terminal-like 助手复制按钮 `ChatView.css:68-74` 默认 `opacity:0`，只由 `.term-assistant:hover` 显现；Sheet tab 关闭按钮 `App.css:111-118` 默认 `visibility:hidden/opacity:0`，工具对象操作 `ChatView.css:901-902` 同样默认隐藏。只有工具对象操作在 `max-width:720px`（`ChatView.css:979-985`）被强制常驻，未形成跨控件的触屏规则（B-24）。

本批没有修改产品代码；所有数值均为运行态读取或源码静态扫描，待基线确认后再转为任务卡。

### 1.17 动态核验批次 I：terminal-like 深色变量与前景混合复核（2026-08-28）

本批在标准视口 `1738×819`、重点模式 `terminal-like`、`Peri/default`、`data-ui-scheme=dark` 下重新读取 body 行级样式；未改主题字段和产品代码。与批次 C 的默认主题重置路径交叉验证后，记录以下同屏快照：

| 变量/元素 | 运行时值 |
|---|---|
| `--global-bg-color` | `#e8e8ec` |
| `--chat-text-color` / `--msg-text` | `rgba(0,0,0,0.85)` |
| `--text` | `rgba(255,255,255,0.90)` |
| `--text-dim` | `rgba(255,255,255,0.48)` |
| `--border` / `--border-focus` | `rgba(255,255,255,0.14)` / `rgba(255,255,255,0.30)` |
| `--chat-transparency` / `--chat-blur` | `1` / `0px` |
| `body::before` | 背景 `rgb(232,232,236)`，`opacity:.85`，`filter:blur(16px)` |
| `.term` / `.term-tool` | 前景 `rgba(255,255,255,.90)` |
| `.term-user` / `.term-row-assistant` | 前景 `rgba(0,0,0,.85)`；user 行另有半透明紫色背景 |
| `.term-reasoning-head` / tool suffix | 前景 `rgba(255,255,255,.48)` |

该批把 B-17 的现象从“可能的持久化残值”收敛为可重复的组合检查项：同一 `dark` 页面同时存在浅色画布、黑色消息行和白色工具/终端行；即便不计算最终像素，前景来源也已经分裂。`body::before` 的浅色背景与 `rgba(255,255,255,.90)` 合成后的普通文本对比度仍落在约 `1.97–2.11:1`（批次 C），低于暂定 `4.5:1` 门槛。该结论只描述表现层映射，不改变主题状态机或持久化契约。

同批边界核验：`.term-reasoning-body` 使用 `0.909px solid rgba(255,255,255,.14)` 左边界，代码 gutter 的 computed `opacity` 为 `.45`，`.term-reasoning-head` 使用 `.48` 前景；这些值在深色页面并非同一可见层级，且实际消息行仍由黑色 `--msg-text` 继承。B-07 因此补充为“需以合成后的实际背景计算边界/辅助文本对比度”，不能只按声明颜色判断。

### 1.18 动态核验批次 J：modern-gui 表面层级与终端状态覆盖补证（2026-08-28）

**modern-gui 表面采样（标准视口 `1738×819`、dark、`builtin.presentation.modern-gui`）**

| 层/元素 | 几何 | computed 表面证据 |
|---|---:|---|
| 标题栏外壳 | `58px` 高 | 半透明背景 `…/.5624`、`backdrop-filter:blur(28px) saturate(1.18)` |
| 标题栏 sidebar/workspace/window cell | `44px` 高 | 各自半透明背景 `…/.7224`、`1px` 边框、`14px` radius、`0 8px 28px` 阴影 |
| 左栏 | `250px` 宽、`16px` radius | 半透明背景 `…/.588`、`1px` 边框、`0 14px 38px` 阴影 |
| 工作台消息 assistant row | 约 `804px` 宽 | 半透明背景 `…/.6552`、`1px` 边框、`16px` radius、`0 7px 24px` 阴影 |
| 工具卡 | 约 `804px` 宽 | `1px` 边框、`12px` radius；状态和输出继续叠加内部层 |
| 输入 dock | 约 `1172px × 64.8px` | 半透明背景、渐变、`1px` focus 边框、`16px` radius、双层阴影（含 `4px` focus ring） |

右栏容器本身透明，但其内部 Sheet/Context surface 仍有独立边框和材质；`.layout`、`.chat-view`、`.term` 不提供单一统一工作台 surface。可见路径至少包含“全局 canvas → 标题栏外壳 → 三个标题栏 cell → 左栏/Sheet 外壳 → assistant row → tool card → input dock”七级可能表面。B-06 的可判定补充为：应按上述选择器逐层记录 `background/border/shadow/backdrop-filter`，不能用“现代 GUI 有玻璃感”作为验收描述。

**reasoning/tool 补证**

- 当前视觉压力会话真实 DOM 只覆盖 reasoning `data-state="complete"`；源码与单元测试虽有 `running`、`redacted`、`missing` 分支，但 `visualQaData.ts` 没有对应 redacted/missing 会话样本，浏览器矩阵无法直接验收这两态（状态矩阵缺口，不直接判为实现缺陷）。
- 工具七态在同一会话可见；`queued/running/waiting/unknown` 仍消费 `.term-tool-indicator.run`，而 `cancelled` 带输出样本在 React 行管线中显示 `completed`。点击工具头仅改变 `aria-expanded` 和输出区域，不产生独立的 hover/focus/disabled 视觉 tone；这继续支持 B-08/B-15/B-18 的待确认范围。

### 1.19 动态核验批次 K：reduced-motion 环境与 Settings 表面可读性补证（2026-08-28）

**reduced-motion**

当前浏览器环境报告 `prefers-reduced-motion=false`，因此无法把系统级 `reduce` 作为已执行的真实截图证据。源码静态规则明确：`src/index.css:170-181` 将三个 motion token、所有 animation/transition duration 压到 `1ms`，`ChatView.css:539-557` 另行关闭 cursor、reasoning、spinner、tool indicator/connector 动画；Solid 组件还在 `ToolInvocationCard.solid.tsx:68` 读取显式 `reducedMotion`。现阶段可判定结论是“规则存在且覆盖面可枚举”，而不是“真实系统设置下已通过”。后续验收必须在 `matchMedia('(prefers-reduced-motion: reduce)') === true` 的环境重新测量 computed `animation/transition`。

**Settings 表面可读性**

在 Settings 打开态（terminal-like、dark、`1738×819`）读取到根 `.settings` 为 `position:fixed; top:44px; z-index:50`，背景由 `var(--surface-overlay)` + `backdrop-filter` 提供；标题栏窗口按钮仍位于 `z-index:60`。Settings 根无 `role="dialog"`、`aria-modal`、`aria-labelledby`，且打开后首个焦点不在覆盖层内（详见批次 H）。由于 overlay 使用透明/模糊表面而非不透明遮罩，字段与底层聊天对比度必须按最终合成像素复算；当前没有“覆盖层遮罩不透出底层”的证据，B-10 保持待确认。

本批仍未修改产品代码；新增证据只更新基线，不构成设计原则或施工承诺。

### 1.20 动态核验批次 L：preset 后切换 scheme 的跨区域前景复核（2026-08-28）

为区分“默认主题缺陷”和“显式 preset 字段残留”，先应用 `Tokyo Night`，再在同一页面只切换到 `light`；模式依次覆盖 `terminal-like` 与 `modern-gui`，标准视口 `1738×819`。结果：

| 区域 | scheme=light 下仍保留的显式值 | 同时生效的通用值 | 运行时表现 |
|---|---|---|---|
| 全局/聊天 | `--global-bg-color:#1a1b26`、`--chat-bg:#1a1b26`、`--chat-text-color/#msg-text:#c0caf5` | `--text:rgba(0,0,0,.85)` | assistant/message row 仍取浅色 `#c0caf5`，工具/输入部分取黑色 |
| 标题栏 | `--titlebar-bg:#16161e`、`--titlebar-text:#c0caf5` | light surface token | modern-gui 标题栏 computed 背景为浅色半透明层，文字仍为 `rgb(192,202,245)` |
| 左栏/右栏 | `--sidebar-bg:#16161e`、`--sidebar-text-color:#a9b1d6` | `--border:rgba(0,0,0,.10)` | 左栏文字与聊天文字的前景族不同；面板背景由 mode CSS 再次混合 |
| Settings | 同一显式背景值继续存在 | light `surface-*` 计算 | modern-gui Settings 仍为 `blur(16px)`/浅色浮层，预览缩略图显示深色画布，形成“浅色设置包裹深色预览”组合 |

该批确认 B-03 的触发条件不只发生在初始默认 profile：任意保留显式背景/前景字段的 preset，在 scheme 单独切换时都可能产生跨区域前景族分裂。该观察不判断用户是否有意保留 preset，只将组合列为后续设计决策的可复现输入。

### 1.21 动态核验批次 M：terminal-like CLI 输入焦点反馈（2026-08-28）

在重点模式 `terminal-like`、标准视口约 `1738×819`、浅色 scheme 的当前预览中，对可见 `textarea.input-textarea` 先移出焦点，再重新聚焦；只读取 DOM/computed 样式，不修改产品代码。当前运行态 token 与伪类结果如下：

| 项目 | 未聚焦 | 聚焦 | 结论 |
|---|---|---|---|
| textarea `:focus` / `:focus-visible` | `false/false` | `true/true` | 浏览器能识别键盘焦点 |
| textarea `outline` | `none`（宽度声明 `2.727px`，样式 none） | 相同 | 全局 `:focus-visible` outline 被 CLI 规则清空 |
| textarea `border` / `box-shadow` | `0px none` / `none` | 相同 | 输入控件自身无焦点边界或阴影 |
| 父 `.input-row:focus-within` | `false` | `true` | 只有结构伪类状态发生变化 |
| 父 `.input-row` 上边线 | `1.818px solid rgb(215,119,87)` | 相同 | 聚焦前后线色、线宽无差异 |
| 父 `.input-row` 下边线 | `1.818px solid rgb(215,119,87)` | 相同 | 聚焦前后线色、线宽无差异 |
| 父 `.input-row` `box-shadow/background` | `none` / `transparent` | 相同 | 没有 focus-within 的可见层 |

运行时 `body[data-interface-mode="terminal-like"]` 的 `--input-focus-ring-width` 为 `0px`，`--cli-line-width` 为 `2px`（设备像素换算后的 computed 边线约 `1.818px`）。源码中 `InputBar.css:222` 的 `.input-textarea:focus` 同时指定 `outline:none; border:none; box-shadow:none`，而全局 `index.css:185-189` 的 `:focus-visible` 规则只对元素本身生效，未给 `.input-row:focus-within` 提供样式。

可判定结论：该输入框存在 DOM 焦点状态，但聚焦前后可见几何/颜色/阴影值没有变化；键盘用户只能通过 caret 位置或系统级非 CSS 提示判断焦点。该结论补强 B-26，是否增加独立 focus-within 视觉层待阶段 1 拍板。

### 1.22 动态核验批次 N：interface mode 切换的 profile/palette 对照（2026-08-28）

在预览恢复为 `terminal-like + terminal-classic + dark` 后，点击标题栏的模式切换按钮进入 `modern-gui`，等待渲染稳定，再切回 `terminal-like`。全程只读取运行态变量；未修改产品代码。

| 项目 | 切换前：terminal-like / terminal-classic | 切换后：modern-gui / modern-gui | 结论 |
|---|---|---|---|
| `data-interface-mode` / active profile | `terminal-like` / `builtin.presentation.terminal-classic` | `modern-gui` / `builtin.presentation.modern-gui` | 模式与 profile 确实切换 |
| `--input-radius` | `0px` | `16px` | profile 几何 token 被应用 |
| `--message-radius` | `0px` | `16px` | profile 几何 token 被应用 |
| `--input-focus-ring-width` | `0px`（终端 profile） | `4px`（GUI profile） | profile 状态 token 被应用 |
| `--global-bg-color` | `#e8e8ec` | `#e8e8ec` | mode 切换未重置背景字段 |
| `--chat-text-color` / `--msg-text` | `rgba(0,0,0,.85)` | `rgba(0,0,0,.85)` | mode 切换未重置消息前景字段 |
| `--text` / `--border` | `rgba(255,255,255,.90)` / `rgba(255,255,255,.14)` | 相同 | 通用 palette 字段保持原值 |

源码链路：`activateInterfaceMode.ts:74-96` 先调用 `applyModeProfile`，再设置 interface mode；`applyPresentationProfile.ts:10-23` 只按 profile token 分区写入并设置 active profile，函数注释明确“不重置 palette、background 或 user assets”。本批因此把 B-02 从纯静态推断补为运行态可复现：模式切换会改变 profile 几何/状态 token，但不会形成 palette/background 的成对切换事务。带有显式自定义背景/前景字段的 preset 在批次 L 中进一步复现了跨 scheme 的残留。

## 2. 设计原则（已冻结）

1. 宿主强制语义、一致的安全边界和可访问性；插件内部几何、材质、密度、图标与断点自由。
2. 普通文本对比度 `>=4.5:1`；大文本及非文本边界 `>=3:1`；键盘控件有可见焦点，状态具有可读名称和至少一种非颜色线索。
3. palette 的 12 个公共角色固定为 `surface.canvas`、`surface.panel`、`surface.raised`、`content.text`、`content.muted`、`stroke.default`、`accent`、`state.success`、`state.warning`、`state.danger`、`state.focusRing`、`connector.default`。它们只能扩展现有 `VISUAL_SEMANTIC_TOKENS`，由 `themeFieldDefs.ts` 提供字段元数据、由 `themeCssSnapshot.ts` 完成唯一投影；不得建立平行 resolver/registry。
4. mode/profile/preset 最终解析为完整 palette；显式且合格的 preset 角色优先，缺失/不合格角色仅回退到同 mode/scheme 安全值。自定义 mode 是现有 mode 下的命名 preset，不新增 mode id 或持久化 schema。
5. 宿主 fallback 尺度为 spacing `4/8/12/16/24/32/48`、radius `0/2/4/6/8/999`、motion `120/180/260ms` 和现有 `soft/raised/float` 阴影；组件只消费 token，不硬编码 fallback。插件可通过现有 Profile、Font Registry、renderer settings、skin token 和作用域 CSS 覆盖。
6. 宿主字体角色为 interface/content/code；已冻结字阶与行高仅是 fallback，不建立第二套字体或字号 registry。
7. 宿主内容预算按 `>=1100 / 760–1099 / <760 / <520` 分段，先收右侧、再把左侧收为现有 42px rail；中心 hard min 360px、紧急 280px，未知 Sheet 主区 min 320px。terminal-like 中心 workbench/CLI 先验收。
8. 宿主表面最多 canvas→panel→raised/overlay 三层，复用现有 Skin surface；单一宿主表面只采用一种 material recipe。插件内部层级仍服从 Q2/Q4，不强制与宿主相同。
9. 宿主 focus 默认 `2px + 2px offset`；running/waiting/loading 可动，终态静态；reduced-motion 关闭非必要动效。terminal-like 优先 glyph/ASCII，modern-gui 宿主操作优先现有 Lucide，插件图标自由。

候选方案、代价、精确 palette、字号阶梯、材质及变更原因完整保存在第 4 节和自治冻结清单，二者共同构成实现 ABI。

## 3. 任务卡

13 张可执行任务卡分别保存在三份互斥线路文件中；它们包含具体文件、改动程度、可判定验收、依赖、优先级和工作量。主表见 0.4。本节不复制卡片正文，以线路文件作为单一执行真值；根 agent 只在本文记录跨线决策与最终状态。

## 4. 决策记录

### 4.1 基线阶段记录（非设计拍板）

| 时间 | 事项 | 记录 |
|---|---|---|
| 2026-08-28 | 阶段 0 启动 | AI 完成关键源码阅读和首轮真实渲染检查；形成 B-01～B-14 候选问题，等待用户确认。 |
| 2026-08-28 | 阶段 0 补证（批次 C/D） | 默认主题重置后的明暗切换、字号放大和窄宽布局完成动态采样；新增 B-17，并将 B-03、B-14 更新为“证据已确认，设计边界待确认”。 |
| 2026-08-28 | 模式优先级确认 | 用户确认 `terminal-like` 为重点开发模式；后续施工、回归与验收优先 terminal-like，modern-gui 随后覆盖。 |
| 2026-08-28 | 阶段 0 补证（批次 H） | 校正 Sheet 样式真实路径；确认 B-09、B-12、B-16 的静态/动态证据；新增 B-22（Settings modal 焦点/语义）、B-23（Sheet 断点策略分裂）与 B-24（hover-only 操作发现性）；补充 Settings、Sheet 与触屏一致性验收协议。 |
| 2026-08-28 | 阶段 0 补证（批次 I/J/K） | 复核 terminal-like dark 的显式变量混合；量化 modern-gui 多级表面；记录 reasoning redacted/missing fixture 缺口、工具交互状态覆盖和 reduced-motion 当前环境限制；补充 B-06、B-07、B-08、B-10、B-17 的证据。 |
| 2026-08-28 | 阶段 0 补证（批次 L） | 先应用 Tokyo Night 再切换 light，确认显式背景/前景字段跨 scheme 持留；更新 B-03，并新增浅色辅助文字低对比度候选 B-25。 |
| 2026-08-28 | 阶段 0 补证（批次 M） | 在 terminal-like CLI 输入框移焦/聚焦对照中确认 `outline/border/box-shadow` 与上下 accent 线均无可见变化；记录 `--input-focus-ring-width:0px` 和 B-26，待阶段 1 决定焦点层策略。 |
| 2026-08-28 | 基线确认方式 | 用户要求先用 Q1～Q6 总闸门逐题定性 B-01～B-26；Q1～Q6 已拍板，下一步汇总 B-01～B-26 并请用户确认基线，未提前进入阶段 1 的具体 token/施工方案。 |
| 2026-08-28 | B-01 证据计数校正 | 按当前 `src/` CSS 逐行重算：`border-radius:` 481 行（其中约 205 行不含 `var(...)`），`box-shadow:` 152 行（其中约 26 行不含 `var(...)`）；替换早期 477/149 快照数字。 |
| 2026-08-28 | B-01 基线处置 | 用户选择“纳入后续改造”；共享 primitive 迁移与模式专属例外登记进入后续范围，具体 token 档位留待阶段 1。 |
| 2026-08-28 | 阶段 0 基线确认 | 用户以“开始派发”确认 1.7.1 的 B-01～B-26 全部归类；三线进入隔离 worktree 自治施工。 |
| 2026-08-28 | 阶段 0 补证（批次 N） | 实际切换 terminal-like ↔ modern-gui，确认 profile 几何/焦点 token 改变而背景、消息前景和通用边框 token 保持不变；补强 B-02 的运行态证据。 |
| 2026-08-28 | 基线讨论框架调整 | 用户指出 Pylon 允许外部插件引入 Sheet/侧栏，一味统一可能误伤扩展性；改用 Q1～Q6 总闸门及必要子问题定性 B-01～B-26，仍按一题一轮推进。Q1/Q2/Q3/Q3a/Q3b/Q4/Q5/Q6 已拍板，下一步汇总基线。 |
| 2026-08-28 | Q1 视觉所有权拍板 | 用户选择“语义契约 + 几何自由”；宿主/契约层强制语义与安全边界，插件内部几何和材质可自定义。B-01 范围相应限定为宿主/契约层。 |
| 2026-08-28 | Q3b 自定义 mode 身份拍板 | 用户选择“基于现有 mode 的命名套件”；自定义 mode 不创建新的 `InterfaceModeContribution` 或 mode id，保留宿主 Sheet/侧栏注册、生命周期和布局契约；后续施工/回归先覆盖 terminal-like 基座。 |
| 2026-08-28 | Q4 布局安全边界拍板 | 用户选择“宿主预算 + 能力协商”；宿主优先保护 terminal-like 中心 workbench/消息列/CLI 输入的最小内容预算，侧栏按优先级收缩；Sheet/侧栏声明最小宽度与收缩/堆叠能力，内部断点保持插件自由。 |
| 2026-08-28 | Q5 token 治理拍板 | 用户选择“仅宿主强制、插件自愿采用”；窗口壳、共享 primitive、内置组件和宿主契约表面强制消费语义 token，外部插件内部可使用自有 token/直接值，但仍受 Q2 对比度、焦点、状态命名和 reduced-motion 底线约束。 |
| 2026-08-28 | Q6 状态反馈拍板 | 用户选择“语义底线 + 插件自定义状态”；宿主不规定统一状态分类、tone、glyph、动画或空态配方，所有内置/外部插件仍须满足 Q2 的可读名称、可辨识反馈、焦点、对比度和 reduced-motion 底线；`cancelled` 等源状态不得误标。 |

### 4.2 基线定性总闸门记录

| 时间 | 闸门 | 候选摘要 | 拍板结果 | 影响范围 |
|---|---|---|---|---|
| 2026-08-28 | Q1 视觉所有权 | A 严格宿主皮肤；B 语义契约 + 几何自由；C 最小安全约束 | **B：语义契约 + 几何自由** | 宿主强制语义 token、焦点/对比度/状态、布局槽位和安全边界；插件内部几何/材质/密度/图标/断点可自定义。 |
| 2026-08-28 | Q2 语义与可访问性底线 | A WCAG + 完整状态底线；B 仅基础可访问性；C 宿主硬底线 + 插件声明例外 | **A：WCAG + 完整状态底线** | 内置与外部插件均需满足对比度、可见焦点、状态可辨识、reduced-motion 和可读名称要求；颜色/glyph/几何仍可自定义。 |
| 2026-08-28 | Q3 主题与 mode 优先级 | A 语义角色分层 + 安全回退；B mode/profile 完整 palette 套件；C 用户/插件覆盖优先 | **B：mode/profile 完整 palette 套件** | 宿主每个 mode/profile 以原子套件提供背景、前景、边界和状态色；套件不强制插件内部几何；用户自定义字段处理转入 Q3a。 |
| 2026-08-28 | Q3a 用户自定义 palette | A 按 mode/profile 分开保存；B 切换时重置；C 保留全局覆盖并安全校验 | **B：切换时重置；补充“保存为全局自定义 mode”** | 未保存覆盖不跨 mode 携带；用户可将完整视觉套件及允许的插件贡献另存为命名自定义 mode；Q3b 再将其限定为现有 mode 下的命名套件。 |
| 2026-08-28 | Q3b 自定义 mode 身份 | A 基于现有 mode 的命名套件；B 新的第一类 interface mode；C 混合身份 | **A：基于现有 mode 的命名套件** | 自定义项只替换现有宿主 mode 的完整视觉套件和已声明插件贡献；不新增 mode registry/id、chrome/workbench 或 shell 槽位，不改变既有持久化格式与业务接口；新应用级布局仍须由真正的 Interface Mode 提供。 |
| 2026-08-28 | Q4 布局与响应式协商 | A 宿主预算 + 能力协商；B 宿主统一断点与固定槽位；C 内容优先的弹性流式布局 | **A：宿主预算 + 能力协商** | 宿主先保护中心 workbench/CLI 的最小可用预算，再收缩可选侧栏/Sheet；插件声明最小内容宽度、可收缩/可堆叠能力和恢复入口，内部断点/几何不强制统一；收起不得删除操作。 |
| 2026-08-28 | Q5 尺度、密度与动效治理 | A 分层 token 契约 + 登记例外；B 全局统一 token 网格；C 仅宿主强制、插件自愿采用 | **C：仅宿主强制、插件自愿采用** | 窗口壳、共享 primitive、内置组件和宿主契约表面必须使用语义 token；外部插件内部 token/直接值自定义，不建立统一例外清单；Q2 的可访问性、状态和 reduced-motion 底线仍适用于所有插件。 |
| 2026-08-28 | Q6 状态表现与交互反馈契约 | A 规范化状态语义 + 插件表现自由；B 宿主统一视觉配方；C 语义底线 + 插件自定义状态 | **C：语义底线 + 插件自定义状态** | 宿主不强制统一状态视觉配方；插件可自定义分类映射、tone、glyph、动画、空态和操作显现，但必须满足 Q2 底线并保持源状态不误标；B-18 的取消/完成错误映射仍须修正。 |

### 4.3 阶段 1 设计议题记录

阶段 1 与实现级默认已冻结：Q1～Q6、DF-01～DF-10 及扩展项共同约束施工；完整候选、收益、代价、拍板理由和数值见本节前表与自治冻结清单。后续任何推翻/变更必须追加变更时间、原决策、变更原因和受影响任务卡。
