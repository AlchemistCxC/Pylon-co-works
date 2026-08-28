# Pylon 外观并行施工：自治冻结清单

> **状态：AUTONOMY-OPEN（全部决策冻结）**  
> 版本：0.2｜更新时间：2026-08-28  
> 用途：在三条线路获得长程自治授权前，把所有会迫使 agent 猜测的设计/契约判断列出来。未标记“已冻结”的项目，agent 不得自行决定。

## 0. 使用规则

1. 本清单与 [并行施工总契约](./Pylon-外观并行施工-总契约.md)、[派发 Prompt 与工作流](./Pylon-外观并行施工-派发Prompt与工作流.md) 配套使用；它不替代原始施工书。
2. 每个冻结项都有唯一 `DF-*` 编号。用户拍板后，根 agent 必须把结果同步到：本清单、总契约版本、受影响线路文件和原始施工书第 4 节决策记录。
3. agent 只能消费 `已冻结` 项；本清单中 DF-01～DF-10（含 03p/03a/03b/03c/03r/03d、05a/05b、07a）均已冻结。若后续出现新的 `待拍板`/`待补证` 项，只能读、测量和提问，不能用“合理默认值”实现。
4. 变更已冻结项必须追加变更时间、原值、变更原因、受影响卡片和回归范围；不得静默覆盖。
5. B-01～B-26 基线归类、B-18 根复核和 DF-01～DF-10 均已完成；线路只等待根 agent 分配隔离 worktree/branch 并发送逐线自治序列。
6. **插件化优先于宿主默认值**：本文的字号、字体族、色板、间距、圆角、阴影、动效和材质数值都是宿主 fallback，不得硬编码进组件。宿主组件消费语义 CSS 变量/ThemeSettings/Presentation Profile；插件通过现有 font registry、Presentation Profile、renderer settings、skin token 和作用域 CSS 提供稳定 id/值。插件贡献合格且可用时优先，缺失/卸载/不合格时才回退宿主默认。

### 0.1 现有插件扩展接口（冻结前提）

| 外观维度 | 现有扩展路径 | 本轮约束 |
|---|---|---|
| 字体族 | `context.fonts.registerFont({ id, family, roles })`；角色已固定为 `interface/content/code`，宿主通过 `fontContributionCssVariable(id)` 生成 `--pylon-font-*` | 不把系统/等宽字体栈写入组件；组件消费角色 token。字体插件卸载时回退宿主角色默认，不丢失保存的稳定 id。 |
| 字号/行高/排版 | `PresentationProfileContribution.tokens`、已验证的 `themeFieldDefs` 字段、renderer settings number schema | DF-04 数值是宿主默认阶梯，不是封闭枚举；插件内部字号可通过自己的 renderer/settings/作用域 token 调整，但仍满足 Q2/Q4。 |
| palette/状态/资产 | Theme/Preset、Presentation Profile tokens/assets、renderer color settings、skin token | DF-03a 是宿主与安全回退色板；preset/plugin 显式角色合格时优先，不覆盖插件 namespace。 |
| 几何/密度/材质 | Presentation Profile token、renderer settings、UI Surface 作用域 CSS、插件 namespaced variables | DF-02/DF-07 只约束宿主 shell/shared primitive；插件内部可定义自己的 scale/radius/shadow/material。 |
| UI 表面与布局 | 现有 Workspace/UI Surface/Sidebar/ContextPanel/Sheet 槽位与作用域 CSS | 插件声明或遵守 Q4 内容预算/恢复入口；宿主不读取插件内部 class，不强制同一断点。 |

不得为本轮视觉施工新增封闭的 plugin 枚举或把插件字体/字号/色板复制进宿主组件。需要新增可配置维度时，优先通过现有 schema/provider 的稳定 id 和可序列化值表达；若现有接口确实无法承载，先发契约请求，不能用硬编码绕过。

### 0.2 现有权威源清单（禁止另立中央）

| 权威源 | 已有职责 | 本轮允许的动作 | 明确禁止 |
|---|---|---|---|
| `src/themeFieldDefs.ts` | ThemeSettings 字段、zone/tier/default/options、CSS var 映射的单一真值 | 补充已拍板的表现元数据或修正映射 | 新建第二张字段表/角色表；组件手写 preset 字段集合 |
| `src/domains/theme/visualSemantics.ts` | SDK 对外稳定的视觉 token 名 | 在现有对象中补缺失的公共 token 名 | 新建 palette/token registry |
| `src/domains/theme/themeCssSnapshot.ts` | ThemeSettings → CSS 变量的纯投影；Sheet 折叠宽度常量 | 在同一投影函数/现有 helper 中加入角色回退和派生变量 | 新建 `paletteResolver.ts` 或组件各自实现 palette 回退 |
| `src/plugin-runtime/skin/skinSchema.ts` / `skinResolver.ts` | 从 themeFieldDefs/status/DOM 结构派生 Skin Schema，复用 CSS 投影 | 继续复用 schema/投影并补 conformance | 新建平行 Skin Schema、surface 枚举或 CSS 投影 |
| `src/presets.ts` + `src/domains/theme/firstPartyPresetProviders.ts` + `src/domains/theme/presetBundle.ts` | 内置 preset、贡献 provider、PresetBundleV2 | 通过现有 provider/adapter 捕获或回退角色 | 新建 preset registry、manifest version 或持久化字段 |
| `src/plugin-runtime/fonts/fontContributionRegistry.ts` | 字体稳定 id、角色和 `--pylon-font-*` 变量 | 复用 registry 注入 interface/content/code 字体 | 组件硬编码插件字体族；新建字体表 |
| `src/plugin-runtime/presentation/presentationProfileRegistry.ts` | Profile tokens/assets 校验与注册 | 复用现有 profile tokens/assets 作为视觉增量 | 新建 profile 解析器或绕过校验写任意 token |
| `src/domains/tool/status.ts` / `src/components/chat/messageTypes.ts` | 工具状态/消息角色单一真值 | 纯展示映射和可访问 label 消费该真值 | 新建平行状态枚举或在 CSS 中重新归一化 |
| `src/workspace-sheets/workspaceRegistry.ts`、UI/Sidebar/ContextPanel registries | Sheet/UI surface/侧栏槽位权威 | 复用现有 slot/capability 与 Q4 conformance | 新建 Sheet registry、mode registry 或布局中央 |

任何新增 helper 必须放入其对应的已有权威模块，并在注释中写明“消费哪个真值、输出给谁”；不能因为“方便测试”再建一份镜像数据。

## 1. 已冻结的基础决策

| 编号 | 事项 | 冻结结果 | 影响 |
|---|---|---|---|
| Q1 | 视觉所有权 | 语义契约 + 几何自由 | 宿主强制语义/安全；插件内部几何、材质、密度和断点可自由。 |
| Q2 | 可访问性底线 | WCAG + 完整状态底线 | 文本 `4.5:1`、大文本 `3:1`、非文本 `3:1`、可见 focus-visible、状态反馈、可读名称、reduced-motion。 |
| Q3 | mode/palette 优先级 | mode/profile 完整 palette 套件 | 宿主背景、前景、边界和状态成套应用；插件颜色在自身 namespace。 |
| Q3a | 用户自定义 palette | 切换重置；另存全局自定义 mode | 未保存覆盖不跨 mode；自定义套件不修改内置套件。 |
| Q3b | 自定义 mode 身份 | 现有 mode 下的命名套件 | 不创建新 Interface Mode、mode id、shell 槽位或生命周期。 |
| Q4 | 布局响应式 | 宿主预算 + 能力协商 | 中心 workbench/CLI 优先；侧栏/Sheet 收缩不删除操作；插件声明最小宽度/收缩能力/恢复入口。 |
| Q5 | token 治理 | 仅宿主强制、插件自愿采用 | 宿主/共享 primitive 用语义 token；外部插件内部 token/直接值可自定义。 |
| Q6 | 状态表现 | 语义底线 + 插件自定义状态 | 不强制统一 tone/glyph/动画/空态配方；源状态不得误标。 |

## 2. 必须在“全自治开工”前拍板的项目

### DF-01｜交互控件 DOM/ARIA 形态（已冻结：A）

**证据**：`src/components/chat/InputBar.tsx:552-560` 的 command suggestion 是 click-only `<div class="cmd-item">`；CSS 无法让它进入 Tab 顺序。A-02 原验收要求 suggestion 可键盘到达，因此出现跨线需求。

| 方案 | 规则 | 收益 | 代价/影响 | 影响线路 |
|---|---|---|---|---|
| A 原生语义控件（建议） | suggestion 使用 `button` 或合法 `option` 语义；保留现有 Enter/Arrow 行为和选择结果；B 线路负责纯 DOM/ARIA，A 线路只做 CSS | 键盘/读屏语义稳定，CSS 选择器简单，最符合 Q2 | 需要核对 React 事件和列表焦点，B 触及 `InputBar.tsx` | B，联验 A |
| B ARIA listbox + roving tabindex | 保留 div 外形，容器 `role=listbox`，条目 `role=option`，只让一个条目进入 Tab，箭头移动 `aria-activedescendant` | 保留现有 DOM/class，适合复杂建议列表 | 键盘状态和焦点同步更复杂，需额外 fixture | B，联验 A |
| C 维持 click-only，降低验收 | 不改 DOM，只验收输入框本身 focus；suggestion 继续依赖点击/既有 Enter 逻辑 | 改动最小 | 无法满足“每个键盘可达控件”底线，触屏/读屏风险保留 | A/B |

**DF-01 结论（2026-08-28）**：用户选择 A“原生语义控件”。工程落地固定使用 `button type="button"` 作为每个 command suggestion 的交互节点；保留现有 click、Enter 和 Arrow 选择结果，不改变命令建议数据、过滤条件或提交逻辑。B 线路获准编辑 `InputBar.tsx` 的纯 DOM/ARIA 表现，A 线路继续只编辑 `InputBar.css`；`cmd-item` 的可视 class 可保留或通过兼容 selector 过渡，但不得改变业务事件。

### DF-02｜宿主尺度与 token 数值包（已冻结：A）

需要冻结 spacing 网格基数、radius 档位、shadow 档位、disabled 透明度、font size/line-height 档位和 motion duration/easing；Q5 只决定治理范围，尚未决定数值。若不冻结，A/C 会对同一 selector 选择不同值。

候选策略：

- **A 4px 网格 + 少量语义档位（建议）**：spacing 仅 `4n`；radius/shadow/motion 以 `none/sm/md/lg` 语义别名表达，terminal-like 与 modern-gui 映射不同数值；一致性高且保留模式差异。
- **B 8px 主网格 + 2px 微调**：主要布局用 `8n`，控件内部允许 `2px`；GUI 密度清晰，但 terminal-like 紧凑表面迁移成本较高。
- **C 现有值收敛**：不设新网格，只把重复值别名化；迁移最小，但跨文件和跨模式仍难静态推断。

**DF-02 结论（2026-08-28）**：用户选择 A“4px 网格 + 少量语义档位”。为避免 agent 再次猜测，采用当前 `src/index.css` 已存在的宿主 token 数值作为**默认 fallback**：spacing 为 `4/8/12/16/24/32/48px`（`--ui-space-1..7`，所有值均为 4px 网格）；radius 为 `none=0px`、`xs=2px`、`sm=4px`、`md=6px`、`lg=8px`、`pill=999px`；motion 为 `fast=120ms`、`standard=180ms`、`slow=260ms`，缓动使用现有 `--ease-standard`/`--ease-emphasized`/`--ease-decelerate`。现有 `--shadow-soft`/`--shadow-raised`/`--shadow-float` 作为宿主阴影档位。宿主组件不得写死这些数值，必须消费 token/profile；插件内部可通过 namespaced token/renderer settings 使用自己的档位。宿主不得自行新增 `xl`；现有 16px/24px 等直接几何值只能作为登记的宿主模式例外或插件内部值。该冻结影响 A/B/C；B-01、A-01/A-02、C-01/C-02 可直接消费，不再等待新的宿主默认数值决策。

### DF-03｜宿主 palette 角色与具体色板（已冻结：A）

需要为 terminal-like/modern-gui × dark/light 冻结最终解析后的宿主视觉角色；“完整”不要求每个插件 Profile 物理声明全部角色，Profile 仍是现有 delta，缺失项由当前 mode/preset fallback 补齐。

候选策略：

- **A 角色色板 + 对比度自动验收（建议）**：每个 mode/profile 有完整角色表；不合格值回退到同套件安全值。
- **B 固定品牌色板**：四种组合尽量共用品牌 accent/state 色，仅调整背景/文字；品牌识别强，但 terminal-like/GUI 的语义差异较小。
- **C 模式独立色板**：终端和 GUI 各自完全独立，插件只消费自身 namespace；表现自由最大，但跨 mode 回归成本高。

**DF-03 结论（2026-08-28）**：用户选择 A“角色色板 + 对比度自动回退”。每个 `terminal-like`/`modern-gui` × `dark`/`light` 组合必须通过现有 `VISUAL_SEMANTIC_TOKENS` 提供完整的 `surface.canvas / surface.panel / surface.raised / content.text / content.muted / stroke.default / accent / state.success / state.warning / state.danger / state.focusRing / connector.default` 角色表；用户自定义或插件映射后的宿主角色如果低于 Q2 门槛，只回退该角色到当前 mode/profile 套件的安全值，不跨套件借色，也不覆盖插件 namespace 内的合法局部角色。普通文本按 `4.5:1`、大文本和非文本控件/边界按 `3:1` 校验。

### DF-03p｜预设与宿主安全色板的兼容策略（已冻结：A）

**源码证据**：

- `src/presets.ts:43-49` 明确说明 terminal-like 预设是完整快照；Claude、Nord、Tokyo、Solarized、Amber、Matrix 均直接声明背景、文字、工具状态、连接线和编辑器颜色。
- `setGlobalPresetReducer` 与 `applyCustomPresetReducer` 都以 `DEFAULTS + preset.theme` 原子应用；自定义预设可包含 `PresetBundleV2`，旧 Theme-only 预设通过 adapter 读取而不重写持久化数据。
- 因此宿主默认色板若在应用预设后无条件覆盖颜色，会抹掉 Nord/Tokyo 等预设身份；若完全不校验，又会继续产生 B-03/B-17/B-20/B-25 的混色和低对比度。

| 方案 | 规则 | 收益 | 代价/影响 |
|---|---|---|---|
| A 预设拥有完整角色色板，宿主提供验证与同套件回退（建议） | 每个内置预设适配/补齐 12 个语义角色；预设显式值优先，缺失或低于 Q2 的单个角色回退到该预设绑定 mode/scheme 的安全值。旧自定义预设通过运行时 adapter 推导角色，不修改持久化格式；重新保存时按现有完整 theme/bundle 捕获。Presentation Profile 的透明局部表面只能从当前角色派生，不覆盖整套 palette | 保留 Nord/Tokyo/Solarized/Amber/Matrix 和用户自定义预设身份，同时消除缺失/不合格角色；不引入新 mode id 或 persistence schema | 需要为每个内置预设做完整角色覆盖/对比度 fixture，旧自定义预设首次应用可能有个别角色被安全回退 |
| B 宿主 mode palette 永远覆盖预设颜色 | preset 只保留字体、几何、glyph、renderer/profile；背景/文字/状态色全部取当前 mode palette | 切换最可预测，回归组合最少 | 现有主题预设大部分视觉身份消失；Nord/Tokyo 等将退化为布局/字形预设，属于明显破坏 |
| C 旧预设原样优先，仅报警不回退 | 内置和自定义预设继续直接覆盖所有主题字段；宿主只显示对比度警告 | 最大限度保持旧视觉输出和持久化行为 | 无法保证 Q2，也无法根治 scheme/mode 混色；三条线仍无法完全自治验收 |

**DF-03p 结论（2026-08-28）**：用户选择 A“预设拥有完整角色色板，宿主提供验证与同套件回退”。每个内置预设继续拥有自己的完整语义角色色板；预设显式值优先保留，缺失或低于 Q2 门槛的单个角色才回退到该预设绑定的 mode/scheme 安全值，不跨套件借色。旧 Theme-only 自定义预设通过运行时 adapter 推导缺失角色，不重写其持久化数据；重新保存仍使用现有 `CustomPreset`/`PresetBundleV2` 承载。Presentation Profile 的局部透明表面从当前角色派生，不得覆盖整套 palette。无论后续色板选择如何，都不得修改 `PresetBundleV2` manifest version、`CustomPreset` 持久化字段或新增 Interface Mode。该决策影响 B-01～B-03、B-07、B-17、B-20、B-25 及 A/C 联验。

### DF-03a｜具体色彩方向与角色表（已冻结：A）

DF-03 已冻结回退机制，但三线仍需要同一套具体角色值。下列候选只用于比较色彩方向，不是实现值；最终以本节后面的“冻结角色表”和对比度表为唯一 ABI。候选表与冻结表若有差异（例如 terminal dark 的 stroke 从 `#5F6D64` 校正为 `#718178`），以冻结表为准。

| 方案 | terminal-like dark / light 核心值 | modern-gui dark / light 核心值 | 收益 | 代价 |
|---|---|---|---|---|
| A 铜橙终端 + 靛蓝 GUI（建议） | dark：canvas `#141916`、text `#F1F4F2`、muted `#A7B0AA`、border `#5F6D64`、accent `#D77757`、success `#69D08F`、warning `#E7B85C`、danger `#F27D82`；light：canvas `#F3F1EC`、text `#1C211E`、muted `#59635D`、border `#7A847E`、accent `#A94D35`、success `#237A47`、warning `#8A5A00`、danger `#B83B46` | dark：canvas `#181C27`、text `#F7F8FC`、muted `#B7BED0`、border `#65708A`、accent `#8B9EFF`、success `#61D095`、warning `#F1BD68`、danger `#FF7F91`；light：canvas `#F5F7FC`、text `#1B2030`、muted `#56627A`、border `#7986A1`、accent `#465FD1`、success `#1D7A50`、warning `#8A5900`、danger `#B9344D` | 延续现有 terminal 铜橙记忆点，同时让 GUI 有冷色工作台；四组中性面可独立调层级，重点角色对比度可达标 | 两种 mode 的色彩性格差异明显；需要维护两套状态色回归 |
| B 荧光磷绿终端 + 靛紫 GUI | dark：canvas `#07100B`、text `#E6FFE9`、muted `#A8C6AD`、border `#4E7156`、accent/success `#7AFF9C`、warning `#FFD166`、danger `#FF7A90`；light：canvas `#F0F7F1`、text `#132119`、muted `#4A6450`、border `#69836F`、accent/success `#176A34`、warning `#7A4E00`、danger `#AE2F45` | dark：canvas `#11131A`、text `#F7F8FC`、muted `#B7BED0`、border `#59627A`、accent `#8B9EFF`、success `#61D095`、warning `#F1BD68`、danger `#FF7F91`；light：canvas `#F5F7FC`、text `#1B2030`、muted `#56627A`、border `#7986A1`、accent `#465FD1`、success `#1D7A50`、warning `#8A5900`、danger `#B9344D` | 终端识别度最强，运行态与成功态可形成强烈即时反馈；GUI 仍保持冷色 | 荧光绿长时间阅读疲劳风险较高；accent 与 success 语义接近，需要额外 glyph/label 约束 |
| C 中性黑白 + mode accent | dark：canvas `#111316`、text `#F5F6F7`、muted `#A7ADB5`、border `#626A73`、terminal accent `#E0A35A`、GUI accent `#5B6FFF`、success `#59C98B`、warning `#E9B95F`、danger `#F07882`；light：canvas `#F6F7F8`、text `#1B1F24`、muted `#56606A`、border `#7B858F`、terminal accent `#A85C24`、GUI accent `#4D63D6`、success `#18754C`、warning `#865600`、danger `#B12F46` | 两种 mode 共用中性面和状态色，只切换 terminal/GUI accent；完整角色的中性对比度统一 | 跨 mode 一致性最高、维护成本最低；终端模式的个性和品牌温度较弱 |

**DF-03a 结论（2026-08-28）**：用户选择 A“铜橙终端 + 靛蓝 GUI”。以下 4 套角色表成为公共 palette ABI；颜色值均为不带 alpha 的基色，局部 surface 可按既有语义 `color-mix` 派生，但派生后的 computed 对比度仍按 Q2 验收。`border`/`connector` 选用在 canvas、surface、raised 三类宿主面上均达到 `3:1` 的安全值；不合格的用户/插件覆盖只回退对应角色，不改变其他角色。

| mode/scheme | canvas | panel | raised | text | muted | stroke | accent | success | warning | danger | focusRing | connector |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `terminal-like` / dark | `#141916` | `#1B211D` | `#232B26` | `#F1F4F2` | `#A7B0AA` | `#718178` | `#D77757` | `#69D08F` | `#E7B85C` | `#F27D82` | `#F0A080` | `#718178` |
| `terminal-like` / light | `#F3F1EC` | `#FAF9F5` | `#FFFFFF` | `#1C211E` | `#59635D` | `#7A847E` | `#A94D35` | `#237A47` | `#8A5A00` | `#B83B46` | `#8C3C27` | `#69746D` |
| `modern-gui` / dark | `#181C27` | `#202636` | `#2A3143` | `#F7F8FC` | `#B7BED0` | `#6F7A95` | `#8B9EFF` | `#61D095` | `#F1BD68` | `#FF7F91` | `#A7B5FF` | `#6F7A95` |
| `modern-gui` / light | `#F5F7FC` | `#EEF2FA` | `#FFFFFF` | `#1B2030` | `#56627A` | `#7986A1` | `#465FD1` | `#1D7A50` | `#8A5900` | `#B9344D` | `#344BB8` | `#6B7892` |

抽样对比度（角色对 canvas / panel / raised，四舍五入）：

| mode/scheme | text | muted | border | accent | success | warning | danger | focus | connector |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| terminal-like / dark | 16.06/14.79/13.12 | 7.99/7.36/6.53 | 4.33/3.99/3.54 | 5.65/5.20/4.61 | 9.34/8.60/7.63 | 9.67/8.90/7.90 | 6.80/6.27/5.56 | 8.51/7.84/6.95 | 4.33/3.99/3.54 |
| terminal-like / light | 14.47/15.50/16.33 | 5.52/5.92/6.24 | 3.43/3.67/3.87 | 4.90/5.25/5.53 | 4.71/5.05/5.32 | 5.25/5.63/5.93 | 4.96/5.31/5.60 | 6.67/7.14/7.52 | 4.31/4.61/4.86 |
| modern-gui / dark | 16.03/14.22/12.22 | 9.15/8.11/6.97 | 3.96/3.52/3.02 | 6.83/6.06/5.21 | 8.88/7.88/6.77 | 9.90/8.78/7.55 | 7.05/6.25/5.37 | 8.67/7.68/6.61 | 3.96/3.52/3.02 |
| modern-gui / light | 15.12/14.44/16.21 | 5.72/5.47/6.13 | 3.41/3.26/3.66 | 5.13/4.90/5.50 | 4.96/4.74/5.31 | 5.58/5.33/5.98 | 5.35/5.11/5.74 | 6.89/6.58/7.38 | 4.14/3.96/4.44 |

三元组顺序均为 `canvas / panel / raised`；这些是静态基色抽样，局部 alpha/mix、图片和插件 namespace 仍需运行态复核。**当前状态：已冻结。**

### 2.1 根 agent 自行冻结的实现级默认（不再向用户提问）

以下项目会影响实现一致性，但不改变已拍板的视觉方向、预设身份或插件自由边界；由根 agent 直接定稿，agent 按此执行。

#### DF-03b｜preset 字段到语义角色映射（根冻结）

| 语义角色 | 现有字段优先级 | 规则 |
|---|---|---|
| `canvas` | `globalBgColor` → mode/scheme 基色 | `globalBgImage` 只作为图像资产，不替换基色角色；空值取当前套件 `canvas`。 |
| `surface.panel` | `chatBg`/`sidebarBg`/`rightBg`/`statusBg`/`titlebarBg`/`ccBg`（按 zone）→ 套件 `surface.panel` | zone 显式值在合格时保留；不合格只回退该 zone，不牵连其他表面。 |
| `surface.raised` | `inputBg`/Settings/Sheet raised surface → 套件 `surface.raised` | 透明/空值按当前 zone 的 `surface.panel` 派生；不把插件内部 surface 改写为宿主值。 |
| `content.text` | `chatTextColor`/`sidebarTextColor`/`titlebarTextColor`/`cliTextColor`/`msgTextColor`（按 zone）→ 套件 `content.text` | 合格时保留 zone 显式值；空值或低对比度回退同一 zone 的安全 text。 |
| `content.muted` | `textDim`/辅助文字字段 → 套件 `content.muted` | 不用降低字号代替对比度修复；低于 `4.5:1` 时回退。 |
| `stroke.default` | `border`/zone border → 套件 `stroke.default` | 控件/边界目标 `>=3:1`；终端发丝线可用 connector 角色但不得低于门槛。 |
| `accent` | `accent`/`assistantDotColor`/`editorTabActive` → 套件 `accent` | `accent` 只负责品牌/选中/焦点语义；插件 renderer 自有 accent 在 namespace 内保留。 |
| `success` | `toolOk`/`ekgGreen`/`diffAdded` → 套件 `success` | 可与 accent 同色，但必须有 label 或其他非颜色线索。 |
| `warning` | `warning`/`ekgYellow`/`editorModifiedMark` → 套件 `warning` | 低对比度时仅回退 warning，不改 success/danger。 |
| `danger` | `toolErr`/`ekgRed`/`diffRemoved` → 套件 `danger` | `cancelled` 可共享 danger tone，但源状态 label/ARIA 不变。 |
| `state.focusRing` | `borderFocus`/`inputFocusBorder`/focus 专用字段 → 套件 `state.focusRing` | 仅作为焦点/选中边界；不得把普通 stroke 提升为 focus。 |
| `connector.default` | `toolConnectorColor`/`cliLineColor` → 套件 `connector.default` | 连接线可被 mode/profile 关闭；开启时仍按非文本 `3:1` 验收。 |

映射是“字段→角色”的展示投影，不新增 ThemeSettings 字段，不改变旧 preset 数据；zone 显式值合格时优先级高于套件基色，低于门槛时只做单角色/单 zone 回退。

#### DF-03c｜自定义 preset 基础 mode 推断与应用顺序（根冻结）

1. 保存时继续捕获现有 `activeProfileId`、`rendererSuiteIdByMode`；不新增 `baseModeId`。
2. 应用时先解析捕获的 `activeProfileId`：profile 存在则使用其 `interfaceMode`（省略时按现有兼容规则为 `terminal-like`）作为基础 mode；然后按该 mode 应用 preset palette/Presentation Profile/renderer 贡献。
3. profile 不可用时不创建新 mode、不修改 registry；保留当前 mode，应用可用的 theme 角色并把缺失 profile 作为 unavailable 证据。
4. 预设贡献的应用顺序固定为：基础 mode/profile → preset 显式角色值 → 单角色 Q2 安全回退 → renderer/plugin 局部贡献；不跨 mode 借用其他 preset 的颜色。

#### DF-03r｜palette 回退位置（根冻结，修订）

安全回退继续放在现有 `src/domains/theme/themeCssSnapshot.ts` 的纯投影链路中：在 `selectThemeCssSnapshot` 或同文件 helper 内消费 `themeFieldDefs`/`visualSemantics` 的字段与角色，不新建 `paletteResolver.ts`、palette registry 或第二张字段表。`src/plugin-runtime/skin/skinResolver.ts` 继续调用同一 `selectThemeCssSnapshot`；组件只消费投影结果，不能各自实现回退。回退诊断作为投影返回值或 QA 证据输出，不写 store、localStorage、preset bundle 或 registry。

#### DF-03d｜背景图/透明材质 scrim（根冻结）

背景图资产永不被重着色或删除。若图像、透明度或 blur 使文本/控件在运行态低于 Q2，对受影响的文本组/控件组增加局部不透明 `surface`/`canvas` backing；不通过全局降低透明度、修改用户图片或覆盖插件 namespace 来“修复”。scrim 只在对比度失败时出现，合格组合不增加额外层。

#### DF-02d｜宿主密度与点击目标（根冻结）

- `terminal-like` 宿主壳、标题栏、侧栏和 CLI 默认使用 compact 密度；`modern-gui` 宿主壳和 Settings/Sheet shell 默认使用 standard 密度；插件内部密度自由。
- 宿主控件沿用现有 `--ui-control-compact/standard/emphasis`；`(pointer: coarse)` 或 `(hover: none)` 下，任何可操作目标的实际命中区域不得小于 `44×44px`，允许用 padding/伪元素扩大而不改变视觉尺寸。
- 不新增 `xl` 尺度档位；触屏命中目标是可访问性命中区，不等同于视觉控件高度。

`radius.none`、`type.interface/content/code` 的语义别名必须增量加入现有 `visualSemantics.ts`/`index.css`，由 `themeCssSnapshot.ts` 从现有 `themeFieldDefs`、FontContributionRegistry 和 profile 角色值投影；不得在组件 CSS 直接写 0px、字号或字体族作为新真值。

#### DF-05b｜宿主阅读宽度（根冻结）

- `terminal-like`：自然语言行宽目标 `72–96ch`；代码、diff、工具输出允许占满剩余宽度并在必要时横向滚动。
- `modern-gui`：自然语言行宽目标 `64–84ch`；卡片/表单主体最大宽度 `960px`，超出部分通过内部滚动而不是压缩字号。
- 外部插件内部阅读宽度自由，但不得越过 Q4 宿主最小预算和 Q2 可读性。

#### DF-07a｜宿主 overlay/z-index 栈（根冻结）

宿主层级语义固定为：base `0` → sidebar `10` → sheet `30` → shell overlay `50` → Settings/modal `70` → toast/error center `90` → titlebar/window controls `100`。插件内部可以使用自己的局部 stacking context，但不得穿透宿主 modal 或遮挡窗口系统按钮。

#### DF-08｜focus-visible 形态（根冻结）

默认键盘焦点使用 `2px solid var(--focus)` + `2px` offset；父容器 `focus-within` 可用等效 `2px` 外圈或边线。终端 accent 线可保留，但聚焦前后至少一个 computed outline/border/box-shadow 值必须变化，且非文本焦点边界 `>=3:1`。焦点环不得被宿主 `overflow:hidden` 裁切；不为鼠标点击强制常驻。

#### DF-09｜非 reduced-motion 动画矩阵（根冻结）

- hover/focus/pressed/展开收起只允许 `fast` 或 `standard` 过渡；不得使用 layout spring 或无限循环。
- `running/waiting/loading` 可使用 `standard/slow` 的 pulse/spinner，但必须同时有静态 label/glyph/shape 线索。
- `completed/failed/cancelled/empty/disabled` 默认静态；不因状态结束继续闪烁或呼吸。
- `prefers-reduced-motion: reduce` 下关闭所有非必要 pulse/glow/slide/scale，仅保留不改变空间位置的即时状态切换。

#### DF-10｜宿主图标/glyph 语言（根冻结）

- `terminal-like`：prompt、工具状态、连接线节点优先使用文本 glyph/ASCII；copy/close/settings 等通用操作可使用现有图标，但同一 mode 内不混用两套状态 glyph。
- `modern-gui`：宿主 chrome/操作优先使用现有 Lucide 图标；状态 glyph 可由 profile 指定；不要求外部插件使用 Lucide。
- 图标/glyph 必须保留可读名称，不能仅以形状承担唯一语义；尺寸由 DF-02 的宿主控件档位和插件局部规则决定。

### DF-04｜宿主字体与缩放层级（已冻结：A）

需要冻结 interface/content/code 三类字体角色、字号阶梯、line-height、长词换行和 125%/150% 缩放策略；插件内部字体仍按 Q1/Q5 自由。

候选策略：

- **A 三角色阶梯（建议）**：interface/content/code 分离，各有 `xs/sm/md/lg`；terminal-like code 角色优先，GUI content 角色可变。
- **B 两角色阶梯**：只区分 interface 与 content，code 继承 content/局部覆盖；实现简单但 CLI/工具输出容易互相牵制。
- **C 只冻结最小字号与行高底线**：其余由组件自行决定；自治最大但 B-14 的跨组件缩放风险持续。

**DF-04 结论（2026-08-28）**：用户选择 A“三角色阶梯”。为避免 agent 自行发明字号，把现有 `index.css` 字号 token 映射为三类**宿主默认角色**；组件只消费角色变量，不硬编码表中数值：

| 角色 | xs | sm | md | lg | 默认字体族 | 默认行高 |
|---|---|---|---|---|---|---:|
| `interface` | `--font-size-xs` = 11px | `--font-size-sm` = 12px | `--font-size-base` = 13px | `--font-size-md` = 14px | `--font-system` | 1.25 |
| `content` | `--font-size-sm` = 12px | `--font-size-base` = 13px | `--font-size-lg` = 15px | `--font-size-xl` = 17px | terminal-like 默认 `--font-mono-default`；modern-gui 默认 `--font-system` | 1.5 |
| `code` | `--font-size-2xs` = 10px | `--font-size-xs` = 11px | `--font-size-sm` = 12px | `--font-size-base` = 13px | `--font-mono-default` | 1.55 |

terminal-like 的普通消息/工具输出默认消费 `content/code` 的 mono 角色；modern-gui 的自然语言/Settings/Sheet 默认消费 `content/interface` 的 system 角色。插件字体族通过现有 FontContributionRegistry 的稳定 id/角色注入，Presentation Profile/renderer settings 可为插件内部选择字号/行高；插件贡献缺失或卸载时回退表中宿主默认。`125%`/`150%` 缩放按角色整体放大，不通过降低字号解决溢出；自然语言使用 `overflow-wrap:anywhere`，代码/路径允许内部横向滚动。宿主默认的 10–11px 只允许非正文辅助/标记，不能承载唯一操作名称或状态名称；插件内部仍需满足 Q2。该冻结影响 A-01/A-02/A-03/A-04、B-01/B-04、C-01/C-03。

### DF-05a｜Q4 布局预算的数值与收缩顺序（根冻结：A）

Q4 已冻结“中心优先、侧栏协商”，但尚未冻结中心最小宽度、左栏/右栏收缩顺序、Sheet 侧栏 42px/190px 等策略的适用范围。

候选策略：

- **A 中心硬底线 + 可选侧栏阶梯（建议）**：先保护 CLI/消息列最小宽度；再收缩右栏；最后收缩左栏；收起项保留 launcher/键盘恢复。
- **B 统一三断点**：所有宿主槽位在同一组断点执行固定折叠顺序；验收简单，但插件特殊布局受限。
- **C 只设 overflow 安全，不冻结顺序**：各 Sheet 自行决定；扩展自由最大，但 480px 行为难以预测。

**DF-05a 结论（根 agent，2026-08-28）**：沿用用户已选择的 Q4 A，冻结为“中心硬底线 + 可选侧栏阶梯”。`>=1100px` 可保持左右栏；`760–1099px` 先收起右栏，左栏可在 `200–280px` 范围内；`<760px` 左栏收至现有 `42px` 控制轨道，右栏保持收起；`<520px` 使用 emergency 布局。中心 workbench/消息列硬最小宽度为 `360px`，emergency 最小 `280px`；CLI textarea 在可用中心区内不得归零。所有收起项必须保留既有 launcher/键盘恢复入口。Sheet/插件未声明能力时，宿主默认其主内容最小 `320px`、内部允许滚动、可选侧栏优先收至 `42px`；不新增业务操作或 plugin runtime 字段。

### DF-06｜状态可辨识的最低非颜色线索（根冻结：A）

Q6 允许共享 tone/glyph，但 Q2 要求状态可辨识；需冻结“可读 label 是否足够、哪些状态必须额外 glyph/shape/边界”的规则，避免 B-15 在三条线之间反复争论。

候选策略：

- **A 文本/ARIA + 一种非颜色线索（建议）**：每个状态有可读 label/ARIA，并至少有 glyph、shape、边界、位置或纹理中的一项；不要求独立色相。
- **B 仅文本/ARIA**：只要读屏和可见 label 正确即可共享所有 tone/glyph；改动最小，但视觉用户区分成本高。
- **C 每态独立 tone/glyph**：七态都必须独立；辨识最强，但与 Q6 插件自由及外部插件迁移冲突。

**DF-06 结论（根 agent，2026-08-28）**：采用 A。每个状态必须有可读可见 label 或等价文本、正确 ARIA 名称，并至少具有 glyph、shape、边界、位置或纹理中的一种非颜色线索；不要求独立色相。插件可自由选择线索形式。仅 ARIA 而无视觉用户可辨识线索不通过；多个业务状态共享 tone/glyph 时，必须依靠 label 或其他非颜色线索区分源状态。

### DF-07｜modern-gui 表面层数与玻璃材质上限（已冻结：A）

需要冻结宿主 Settings/Sheet shell 是否允许 blur、透明叠加和多级 shadow，以及插件内部是否完全自由；Q1/Q5 已允许插件内部差异，但 built-in shell 仍需可验收。

候选策略：

- **A 宿主三层上限（建议）**：canvas → surface → raised/overlay，单层最多一种材质增强；插件内部不受此上限。
- **B 双层平面化**：宿主只允许 canvas + surface，不使用 blur/多级阴影；可读性和性能最稳，但现代 GUI 表现收缩明显。
- **C 不设层数上限**：只检查对比度/焦点/溢出；视觉自由最大，但层级漂移需要逐项回归。

**DF-07 结论（2026-08-28）**：用户选择 A“宿主三层上限”。宿主只使用现有 `VISUAL_SEMANTIC_TOKENS.surface` 的 `canvas → panel → raised/overlay` 材质层级；`sunken/glass` 是材质变体，不增加第四层。单一宿主 DOM surface 只能选一个材质 recipe：`solid`（背景+边界）、`glass`（透明背景+一个 blur、无 shadow）或 `elevated`（近不透明背景+一个 shadow、无 blur）。现有 Skin surface `app/workspace/sidebar/main/right/dialog` 仍是 DOM 作用域真值，不新增 canvas/panel/raised Skin surface 枚举；材质 token 只投影到这些现有 DOM surface。该上限只约束 Application Shell、Settings、共享 Sheet shell 和宿主 primitive；插件/Sheet 内部材质自由，只需满足 Q2/Q4、modal/z-index 和 scoped CSS。

## 3. 已有实现的安全例外

| 项目 | 当前处理 | 原因 |
|---|---|---|
| B-18 `cancelled → completed` | 允许线路 B 先修纯展示 lookup，并用 targeted test 验证 | 已有明确源代码证据；不涉及业务状态机或持久化。 |
| A-02 CLI 父行 focus-within | 可在 bounded scope 使用现有 token/值先实现 | 不依赖新色板数值；但 suggestion 的键盘语义等 DF-01 拍板。 |
| C-02 Sheet shell token 替换 | 可在 bounded scope 只替换为现有语义 token | 不改变 Sheet 行为；新 token/新数值仍需冻结。 |

## 4. 全自治开工条件

全部满足后，根 agent 才能发送 `scope=full` 的 `[CODE-GATE-OPEN]` 和 `[AUTONOMY-OPEN]`：

- [x] DF-01～DF-07（含 03p/03a/03b/03c/03r/03d、05a/05b、07a）均已拍板并记录；
- [ ] 26 条基线归类已由用户确认或逐项记录调整；
- [ ] 阶段 1 token/色板/字体/动效值已写入公共快照；
- [ ] A/B/C 三份线路文件的任务卡依赖更新为冻结版本；
- [ ] B-18 diff 通过根 agent 复核，或明确退回；
- [ ] 所有 agent 收到同一契约版本和允许卡片序列；
- [ ] 子 agent 测试命令仍限制为 targeted，根 agent 才拥有全量集成检查权限。

## 5. 设计树缺口审计与完成收益

### 5.1 曾识别且现已冻结的自治阻塞项

前面的 Q1～Q6 已覆盖方向；以下实现级判断曾是自治阻塞项，目前均已通过用户或根 agent 决策冻结：

| 编号 | 缺口 | 为什么会阻塞自主施工 | 影响线路 |
|---|---|---|---|
| DF-03b | `ThemeSettings`/旧 preset 字段到 12 个语义色角色的映射 | 现有 preset 直接保存 `globalBgColor/chatTextColor/toolOk/toolRun/toolErr/titlebar*` 等字段；没有字段→角色表，palette 投影和安全回退会出现多套解释 | B，联验 A/C |
| DF-03c | 自定义 preset 的基础 mode 绑定与应用顺序 | `PresetBundleV2` 当前捕获 active profile/renderer suite，但没有 `baseModeId`；必须明确用现有 profile 推断宿主 mode，避免自定义 terminal 套件误应用到 GUI shell | B，联验 A/C |
| DF-03r | palette 解析与安全回退的运行时边界 | CSS cascade 无法可靠判断 rgba/color-mix/背景图上的最终对比度；若不决定纯 resolver 放在哪里，agent 可能改 preset reducer/store 或把安全逻辑散到组件 | B，根 agent 协调只读高风险调用点 |
| DF-03d | 背景图、透明度和 blur 下的 scrim 规则 | 当前支持背景图和透明材质；纯色角色表不能保证图片上的文字对比度，需要决定宿主 scrim/overlay 的最低不透明度和用户资产边界 | B/C，联验 A |
| DF-05a | Q4 数值预算、收缩顺序和缺失能力声明的回退 | “中心优先”仍不足以决定 480px 下先收起右栏还是左栏、Sheet 未声明时取何种最小宽度 | A/C，联验 B |
| DF-05b | 阅读路径、内容列最大宽度和对齐 | Q4 只冻结最小预算，未决定大视口下消息列/工具输出是否满宽；不冻结会让 terminal-like 与 GUI 的阅读节奏继续漂移 | A/C，联验 B |
| DF-04 | 字体角色、字号阶梯、行高和 125%/150% 缩放 | 现有 interface/content/code 字段和组件字号并行存在；没有阶梯会让 A/C 各自处理长词、标题和 CLI 密度 | A/B/C |
| DF-02d | 宿主密度、控件高度和最小点击目标 | DF-02 冻结了 token 数值，但未决定 terminal/GUI 分别使用 compact/standard 的规则，也未冻结 pointer coarse 下的最小目标 | A/B/C |
| DF-06 | 状态最低非颜色线索 | Q6 允许共享 tone/glyph，但 Q2 要求可辨识；没有“label 是否足够”的规则，B-15 会反复争论 | B，联验 A/C |
| DF-07 | modern-gui 宿主表面层数与玻璃上限 | 需要决定 Settings/Sheet shell 是否允许多层 blur/shadow；否则 C 只能凭审美判断“删层”或“保留层” | C，联验 B |
| DF-07a | overlay/z-index 与 modal 层级栈 | Settings、Sheet overlay、shell surface、titlebar/window controls 和错误中心会同时出现；不冻结层级语义会产生遮挡和焦点层与视觉层不一致 | A/B/C |
| DF-08 | focus-visible 的具体形态与焦点预算 | “可见焦点”还不足以决定 outline 厚度、offset、focus-within 是否允许覆盖 terminal accent；A/B/C 会出现不同实现 | A/B/C |
| DF-09 | 非 reduced-motion 的动画许可矩阵 | DF-02 只冻结时长/easing，未决定哪些状态允许 pulse/glow/slide；同一 running 状态可能被不同线路重复加动画 | A/B/C |
| DF-10 | 宿主图标/glyph 语言与尺寸 | terminal-like 使用文本 glyph，modern-gui 使用 Lucide/图形图标；需要冻结宿主 chrome、危险操作、状态和插件自有图标的边界，避免同一按钮在不同 Sheet 采用不同视觉语法 | A/B/C |

DF-03b/DF-03c/DF-03r 复用现有预设/投影权威；DF-05a/DF-05b/DF-08/DF-09 已转成宿主 fallback 和 QA 规则；DF-03d/DF-07a 已转成现有 surface/layer token 的安全约束。它们不新增 registry、持久化字段或平行真值。

### 5.2 不需要用户拍板的实现细节

以下内容可由 agent 按冻结契约自主选择，不再增加讨论议题：

- 具体 CSS selector 合并顺序、是否使用 `:where()`/`:is()`，前提是不改变 specificity 契约；
- targeted test/fixture 的文件名和内部组织，只要位于线路白名单；
- 使用 outline、box-shadow 或 pseudo-element 实现已冻结的 focus 形态；
- token 迁移的机械顺序、注释格式和内部 helper 命名；
- screenshot/Computed Style 证据的文件组织；
- 不改变 DOM/ARIA ABI 的局部 class 重命名（若跨线路消费则仍须契约请求）。

### 5.3 任务完成后的可验证收益

| 收益层 | 完成后可观察结果 | 判定方法 |
|---|---|---|
| 用户视觉 | `terminal-like` 优先的四种 mode/scheme 组合使用成套角色色板；切换和应用 preset 后不出现背景/前景/状态混色 | 运行四组合 + 至少两个内置 preset + 一个自定义 preset，记录 12 角色 computed 值和逐角色对比度；不合格只回退对应角色 |
| 终端工作流 | 480/680/900px 与字号放大时，中心消息列和 CLI 保持可用；侧栏/Sheet 收缩后可恢复 | 记录实际 viewport、中心/输入 `clientWidth`、scrollWidth、折叠顺序和恢复入口；`clientWidth=0` 或无恢复入口即失败 |
| 状态可读性 | 工具、reasoning、空态、错误、取消和加载状态可读、可聚焦、可辨识；取消不会显示完成 | 对每个状态检查 DOM label/ARIA、至少一种非颜色线索、focus-visible 和 reduced-motion；`cancelled` fixture 不得产生 completed 展示 |
| 预设兼容 | Tokyo/Nord/Amber/Matrix 等现有预设仍保留显式色彩身份；低对比度只影响对应角色并回退到同套件安全值 | 应用 preset 前后比较显式角色字段；验证回退来源属于同一 preset 的 mode/scheme，不改 bundle/schema |
| 插件生态 | 外部 Sheet/侧栏可保留自己的圆角、阴影、密度、断点和状态配方，只要满足语义、Q2 和 Q4 | 使用外部插件 fixture 检查 slot、最小预算、恢复入口、对比度、focus、状态名称和 reduced-motion；不比较内部几何数值 |
| 维护与扩展 | 新增内置 primitive 可直接消费 token；新增 Sheet 按能力声明接入，不需重新解释宿主视觉规则 | 静态检查 token/DOM ABI、文件 ownership 和契约版本；新增卡片必须能引用本清单中的冻结项 |
| 并行稳定性 | 三条线可独立开发、定向测试、逐卡 checkpoint，最终由根 agent 做一次集成验证 | 每条线 `git diff --name-only` 只命中白名单；无跨线覆盖、无全量测试越权、无未决契约猜测 |

### 5.4 从当前基线到目标状态的关键变化

| 当前证据 | 完成后的目标 | 可量化收益 |
|---|---|---|
| mode/profile 切换只改几何，palette/background 残留 | mode/profile/preset 形成完整角色事务，预设显式角色合格时保留 | 消除 B-02/B-03/B-17 的混合色板；每次切换 12 个宿主角色均有唯一来源 |
| terminal-like 请求 480px 时输入栏 `0px` | 中心 CLI/消息列先获得冻结最小预算，侧栏按顺序收缩且可恢复 | B-11/B-13/B-14/B-23 从不可用变为可测可用；无中心列归零 |
| CLI focus 前后 outline/border/shadow 均无变化 | focus-visible/focus-within 使用统一预算，dark/light 下非文本对比度 `>=3:1` | B-26 从“只能看 caret”变为键盘焦点可见 |
| 默认浅色工具状态色约 `1.90:1～2.24:1`；工具线约 `1.91:1～2.76:1` | 状态/边界角色按四套安全 palette 或同预设角色回退 | B-07/B-20 达到非文本 `>=3:1`；状态文字按普通文本 `>=4.5:1` |
| Settings 浅色辅助文字约 `2.78:1`，modal 焦点可越出 | 辅助文字使用 muted/text 安全角色，Settings 采用真实 dialog/focus 栈 | B-22/B-25 达到可读和键盘闭环；关闭后焦点恢复 |
| 带输出 cancelled 显示 completed | 纯展示映射保留 cancelled | B-18 fixture 3 项 targeted test 已通过，后端状态与输出不变 |
| 共享 Sheet 壳重复、内部断点互不一致 | 宿主 shell token 化，内部断点自由但服从 Q4 能力/预算 | B-12/B-23 降低重复与跨插件误统一；新增 Sheet 接入有明确检查表 |

## 6. 决策记录

| 时间 | 编号 | 结论 | 影响 |
|---|---|---|---|
| 2026-08-28 | 初版 | 创建自治冻结清单；当前暂停三线改码，等待 DF-01～DF-07 逐项拍板。 | 防止 agent 在长程运行中自行填补设计空白。 |
| 2026-08-28 | DF-01 | 用户选择原生语义控件；工程固定为 `button type="button"`，B 可修改纯 DOM/ARIA，A 继续负责 CSS。 | 解除 A-02 suggestion 键盘可达性阻塞，不改变命令建议业务行为。 |
| 2026-08-28 | DF-02 | 用户选择 4px 网格 + 少量语义档位；冻结当前 `index.css` 的 spacing/radius/shadow/motion 数值，不新增 `xl` 档位。 | 三条线路可消费同一组现有 token；16px/24px 等其他值必须登记为宿主例外或插件内部值。 |
| 2026-08-28 | DF-03 | 用户选择角色色板 + 对比度自动回退；冻结 12 个宿主语义角色和逐角色同套件安全回退。 | 解决 mode/scheme 混色并保留插件 namespace；具体色值转入 DF-03a。 |
| 2026-08-28 | DF-03p | 用户选择预设拥有完整角色色板，宿主验证并逐角色同套件回退。 | 保留现有内置/自定义预设身份，不改 preset 持久化格式；低对比度角色不得直接进入宿主。 |
| 2026-08-28 | DF-03a | 用户选择铜橙终端 + 靛蓝 GUI；冻结四种 mode/scheme 的 12 角色基色和抽样对比度表。 | B 线路可直接发布 palette ABI；A/C 不再自行选色，所有覆盖按逐角色安全回退。 |
| 2026-08-28 | DF-04 | 用户选择三角色字体阶梯；冻结 interface/content/code 的字号别名、默认字体族、行高和 125%/150% 缩放规则。 | A/B/C 使用同一 type ABI；terminal-like 以 mono 为内容默认，modern-gui 以 system 为内容默认。 |
| 2026-08-28 | 缺口审计 | 补齐 preset 字段映射、palette 投影、背景图 scrim、密度/点击目标、内容列、overlay 栈、focus、motion 和图标语言等自治阻塞项，并记录当前基线到目标状态的量化收益。 | 所有项目最终挂接现有权威源；删除新增 palette resolver/平行 registry 倾向。 |
| 2026-08-28 | 根 agent 微决策冻结 | 自行冻结 DF-03b/03c/03r/03d、DF-02d、DF-05a/05b、DF-06、DF-07a、DF-08、DF-09、DF-10；DF-04 与 DF-07 经用户拍板后再写入公共 ABI。 | 将实现级分支从用户议程移除，同时给三线提供完整 ABI。 |
| 2026-08-28 | DF-07 | 用户选择宿主三层上限；宿主复用现有 surface token/Skin surface，单层只选一个材质 recipe，插件内部材质自由。 | C 线可收敛宿主层级而不另建 material registry；外部 Sheet 不因内部层数不同被判缺陷。 |
