# 并行施工线路 B：共享语义、主题、状态与可访问性

> **状态：AUTONOMY-OPEN（隔离 worktree 施工）**  
> 线路 owner：root/appearance_line_b  
> 公共契约：[Pylon-外观并行施工-总契约](./Pylon-外观并行施工-总契约.md)  
> 设计依据：[Pylon-外观设计施工书](./Pylon-外观设计施工书.md)

> **测试约束**：子 agent 只运行本线路文件所有权对应的 targeted lint/test/visual QA；触及 Solid 时可运行 `check:solid`，但不得主动运行全量 `test`、`check:frontend`、`check:all` 或全仓库 `build`。三线合并后的全量检查由根 agent 执行。

> **测试长期性约束**：只测试长期稳定的状态/ARIA/palette 回退/可访问性不变量；不测试 preset/plugin/Sheet 数量、顺序、固定文案、完整枚举快照、具体像素/颜色、CSS class、DOM 层数或当前组件树。视觉值使用 computed-style/contrast/viewport QA；B-18 的 cancelled 不得误显示 completed 属于稳定语义，可测试。

> **权威源约束**：不得新建 palette resolver、palette registry、字体/布局中央或第二套字段映射；角色元数据扩展 `themeFieldDefs.ts`，公共 token 名扩展现有 `visualSemantics.ts`，投影与安全回退扩展现有 `themeCssSnapshot.ts`，preset/profile/font/skin 继续复用现有 registry/provider。

## 0. 线路使命

线路 B 维护宿主共享的视觉语义、主题投影、状态可访问性和 Settings 模态语义。它是三条线路唯一可以编辑全局 token/主题投影/状态呈现源文件的线路，但不得改变业务状态机、数据流、接口契约、preset 持久化或 mode 生命周期。线路 B 只建立“宿主必须满足什么”和“状态如何正确呈现”的公共底座，不把外部插件内部几何或状态配方强行统一。

本线路主责问题：B-01、B-02、B-03、B-04、B-05、B-08、B-15、B-16、B-17、B-18、B-19、B-21、B-22、B-25；线路 A/C 只消费本线路冻结的 token、ARIA/状态语义和 palette 结果。

## 1. 启动前必读

按顺序阅读：

1. `docs/Pylon-外观并行施工-总契约.md` 全文；
2. `docs/Pylon-外观设计施工书.md` 的 0.1～0.7、1.5、1.6、1.7、1.7.1、1.8、1.10～1.22、4.2；
3. `docs/Pylon-插件系统说明书-开发者版.md` 的 Theme、Presentation Profile、Renderer、UI Surface、ARIA/可访问性相关章节；
4. `src/index.css`、`src/themeFieldDefs.ts`、`src/domains/theme/visualSemantics.ts`、`src/domains/theme/themeCssSnapshot.ts`、`src/plugins/core/renderer/builtinPresentationProfiles.ts`；
5. `src/components/Settings.tsx`、`src/components/chat/ChatView.tsx`、`src/components/chat/InputBar.tsx`、`src/components/chat/messageLookups.ts`、`src/components/chat/chatRowPipeline.ts`、`src/components/chat/toolIndicatorMotion.ts`、`src/domains/tool/status.ts`、`src/renderers/solid-workbench/chat/ToolInvocationCard.solid.tsx`、`ToolCard.solid.tsx`；
6. 线路 A/C 文件的当前内容（只读），确认其只消费公共契约、不编辑本线路文件。

启动首条消息必须列出：已读文件、当前工作树既有改动、计划编辑文件、明确不编辑文件。

## 2. 可写文件所有权

### 2.1 允许编辑

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
- 线路 B 新增的、文件名带 `B-` 前缀的测试/QA 文件。

### 2.2 只读/禁止

- 线路 A 的 `App.css`、`Sidebar.css`、renderer `ChatView.css`、`InputBar.css`；线路 C 的 Settings/Sheet CSS：只读。
- `src/store.ts`、`src/customPresets.ts`、`src/domains/theme/presetBundle.ts`、`src/domains/theme/presetReducer.ts`、`src/application/transactions/**`、`src/domains/interface/**`、`src/plugin-runtime/**`：禁止编辑。
- 后端、命令、会话、工具领域状态机和任何持久化/迁移文件：禁止编辑。
- 总契约、原始施工书和其他线路文件：禁止编辑；不得全仓库格式化。

### 2.3 特殊纯展示限制

- `messageLookups.ts`、`chatRowPipeline.ts` 只能修正“已有领域状态如何映射成 UI 展示状态”的纯函数路径；不得改变状态归一化输入、后端事件、store 结构、命令行为或数据排序。
- `src/domains/tool/status.ts` 的修改只能涉及视觉 tone/label 的展示映射；不得新增、删除或重命名后端状态字符串。
- `Settings.tsx` 允许补充 `role="dialog"`、`aria-modal`、焦点移入/恢复/循环和可见状态 class；不得改变设置字段、保存、删除、导航和关闭动作的业务条件。
- `themeFieldDefs.ts`/`themeCssSnapshot.ts`/`builtinPresentationProfiles.ts` 只允许调整表现字段、CSS 变量投影和 profile token；不得改变 schema 版本、持久化 key、迁移规则或接口类型。

## 3. 公共契约发布规则

1. `src/index.css` 是全局 token 的唯一写入口。新增变量必须同时在本文件第 6 节记录名称、语义、scheme/mode 回退和消费线路；不得删除或重命名已有变量。
2. Q5 C 只强制宿主壳、共享 primitive、内置组件和宿主契约表面消费 token；外部插件内部 token/直接值不由本线路扫描整改。
3. Q3 B 的 palette 套件必须覆盖宿主背景、前景、边界和状态角色；`data-interface-mode` 仍只有 `terminal-like`/`modern-gui`，`data-ui-scheme` 仍只有 `dark`/`light`。
4. 自定义 mode 只使用现有 `CustomPreset`/`PresetBundleV2` 承载；不得添加 `baseModeId`、新 mode registry、Interface Mode id 或新的持久化字段。若现有 bundle 无法表达纯视觉需求，先提契约请求。
5. Q6 C 不要求每个状态独立 tone/glyph；必须保留源状态的可读名称、可辨识反馈和正确映射。`cancelled` 不得显示成 `completed`。
6. 所有线路都可消费本线路发布的 token 和语义；线路 A/C 如需新增 token，只提交请求，不能直接编辑 `index.css`。
7. DF-03p 已冻结：预设显式角色色板优先，缺失/不合格角色才回退到该 preset 绑定 mode/scheme 的安全值。旧 Theme-only preset 只能通过运行时 adapter 推导角色，禁止改 `CustomPreset`/`PresetBundleV2` schema；Presentation Profile 的透明局部表面必须从当前角色派生。

## 4. 任务卡

### B-01｜宿主语义 token、scheme 和 mode palette 投影

- **归属**：共享宿主
- **文件**：`src/index.css`、`src/themeFieldDefs.ts`、`src/domains/theme/visualSemantics.ts`、`src/domains/theme/themeCssSnapshot.ts`、`src/plugins/core/renderer/builtinPresentationProfiles.ts`
- **问题映射**：B-01、B-02、B-03、B-04、B-05、B-16、B-17、B-25
- **优先级/工作量**：P0 / L
- **依赖**：总契约 0.8、DF-01～DF-10 已冻结；B-18 已由根 agent 复核；根 agent 已为本线路分配隔离 worktree 并发 `[CODE-GATE-OPEN]` + `[AUTONOMY-OPEN]`
- **改动描述**：
  1. 保留现有字段和持久化 key，只整理宿主共享 primitive、背景、前景、边界、状态、字号、disabled 和 motion 的语义变量/别名；公共 token 名只能扩展现有 `visualSemantics.ts`，字段元数据只能扩展现有 `themeFieldDefs.ts`。
  2. 为 `terminal-like` 与 `modern-gui` 的 dark/light 提供成套宿主 palette 投影，避免 scheme 只替换部分通用变量而留下显式背景/前景残留；投影继续走 `themeCssSnapshot.ts`，不新增 resolver/registry。
  3. 让 Presentation Profile 只写已验证的表现 token；不得借 profile 激活改写业务状态或新增 mode 身份。
  4. 把低对比度工具线、浅色状态色、Settings 辅助文字和 disabled 透明度纳入宿主 token 角色；具体值使用总契约 0.8 的宿主 fallback 与 preset/plugin 覆盖规则。
  5. 按 DF-03p 保留 preset 显式角色值；仅对缺失或不满足 Q2 的单角色应用同一 preset 绑定 mode/scheme 的安全回退，不跨套件借色，不改持久化 schema。
- **验收标准**：
  - 既有 `ThemeSettings` 字段名、schema version、持久化 key、迁移输出和接口类型与改动前一致；对比 `git diff` 不得出现 store/preset/runtime 文件。
  - `terminal-like`/`modern-gui` × dark/light 切换后，宿主背景、前景、边界和状态角色均有 computed 值；不得出现“几何已切换但 palette/background 沿用上一套”的混合组合。
  - 内置与自定义 preset 的显式角色值在合格时保持可见；不合格角色的回退只影响该角色，且回退来源属于同一 preset 的 mode/scheme 套件。
  - 普通文本 `>=4.5:1`、大文本 `>=3:1`、承担控件/边界辨识的非文本 `>=3:1`；每个结果记录 computed 前景/背景和测量元素。
  - 宿主共享 CSS 的 spacing/radius/shadow/type/motion/disabled 值引用语义 token；模式专属直接值在对应线路例外登记中可追溯。
  - 线路 A/C 只需消费稳定 token 名即可完成样式施工；任何变量新增/变更都有本线路契约记录。

### B-02｜状态/ARIA 纯展示映射与工具状态语义

- **归属**：共享状态呈现
- **文件**：`src/components/chat/ChatView.tsx`、`src/components/chat/messageLookups.ts`、`src/components/chat/chatRowPipeline.ts`、`src/domains/tool/status.ts`、`src/components/chat/toolIndicatorMotion.ts`、`src/renderers/solid-workbench/chat/ToolInvocationCard.solid.tsx`、`ToolCard.solid.tsx`
- **问题映射**：B-08、B-15、B-18、B-19、B-21、B-24、B-26
- **优先级/工作量**：P0 / L
- **依赖**：B-01 的状态/文本 token；不得等待或编辑线路 A/C 文件
- **改动描述**：
  1. 保留现有工具领域状态集合和输入，确保每个状态的可读名称、`data-*` 标记和 ARIA label 与源状态一致。
  2. 修正带输出 `cancelled` 被 `resolvedToolIds` 优先当作 `completed` 的纯展示映射；不触碰后端状态机、工具输出数据或命令行为。
  3. 为空会话、reasoning redacted/missing、工具七态和 unknown 建立可执行的视觉 QA fixture/DOM 断言；不要求每态独立 tone。
  4. 为内置键盘操作提供 `focus-visible`/非 hover 可发现 class；插件可自定义视觉形式，但不得省略 Q2 反馈。
  5. 按 DF-01 将 command suggestion 交互节点落地为 `button type="button"`；保留现有 click、Enter、Arrow 选择结果和 `cmd-item` 兼容样式，不改建议数据、过滤条件或提交逻辑。
- **验收标准**：
  - 输入 fixture 的 `queued/running/waiting/completed/failed/cancelled/unknown` 在 DOM `data-tool-state`、可读 label 和 ARIA label 中逐一保持同名语义；`cancelled` 永不输出“已完成”。
  - 每个状态至少有文本、glyph、形状、边界或其他非颜色线索中的一种可测反馈；共享 tone 不判失败。
  - `sessionId` 存在且消息为空时，空态区域有可读名称和可辨识 DOM；具体品牌内容由线路 A 决定。
  - Tab 进入复制、展开、工具对象和 CLI 控件时，`focus-visible` 可见；不依赖 hover 才能获得唯一入口。
  - command suggestion 每一项可通过 Tab 到达并具有可读名称；现有 Enter/Arrow/click 选择结果与改动前一致。
  - `prefers-reduced-motion: reduce` 下所有本线路新增/修改的非必要动画为 `none` 或等价无动画状态；状态仍可辨识。
  - `git diff` 不包含 `src/store.ts`、`src/domains/tool` 中非视觉状态机文件、后端或接口契约。

### B-03｜Settings dialog 语义与焦点路径

- **归属**：共享宿主可访问性
- **文件**：`src/components/Settings.tsx`
- **问题映射**：B-09、B-22、B-24、B-25
- **优先级/工作量**：P0 / M
- **依赖**：B-01 focus/text token；线路 C 负责对应 CSS，不编辑本文件
- **改动描述**：
  1. 为 Settings 根节点补齐 dialog 语义、可读标题关联和 modal 状态；保留已有导航、字段、保存和关闭逻辑。
  2. 打开时将焦点移入首个可用控件，Tab/Shift+Tab 不越出 Settings 内容，关闭后恢复到打开入口；窗口系统三按钮按既有例外规则处理。
  3. 为关闭、导航、preset chip、危险操作等控件提供不依赖 hover 的语义状态 class/ARIA 属性，样式由线路 C 消费。
- **验收标准**：
  - 根节点 `role="dialog"`、`aria-modal="true"` 和标题关联稳定存在；打开时屏幕阅读器可读出名称。
  - 连续 12 次 Tab/Shift+Tab 的焦点均在 Settings 内或明确登记的窗口三按钮例外；关闭后焦点回到打开前元素。
  - Settings 背景控件在 modal 打开时不能被键盘意外聚焦；不改变设置字段值、保存/删除/导航事件调用次数。
  - 125%/150% 字号下 DOM 顺序、焦点顺序和可读名称不丢失；dark/light 下由线路 C 验证合成对比度。

### B-04｜共享 focus、reduced-motion 与 conformance 验收

- **归属**：共享验证
- **文件**：`src/index.css` 及线路 B 新增 B 前缀测试/QA 文件
- **问题映射**：B-05、B-07、B-08、B-16、B-19、B-20、B-25、B-26
- **优先级/工作量**：P1 / M
- **依赖**：B-01～B-03
- **改动描述**：建立只读的 CSS/DOM/contrast/reduced-motion 断言，覆盖内置宿主和可注入插件 fixture；不要求插件内部消费宿主 token。
- **验收标准**：
  - 断言报告包含模式、scheme、profile、viewport、字号、状态和 computed 前景/背景；失败输出具体 selector 与数值。
  - 所有键盘控件均有可见 `focus-visible`，非必要动效在 reduced-motion 下关闭。
  - 外部插件 fixture 只检查 Q2/Q4，不检查其内部 radius/shadow/spacing 是否等于宿主。
  - 新增测试文件名带 `B-`，不得修改线路 A/C 既有测试文件。

## 5. 公共 token 发布快照（执行前填写/冻结）

| token 名 | 语义角色 | dark/light 规则 | terminal-like 消费点 | modern-gui/Sheet 消费点 | 状态 |
|---|---|---|---|---|---|
| 现有 `--ui-space-*` / `--ui-radius-*` / `--shadow-*` / `--motion-*` | 宿主尺度/层级/动效 | DF-02 已冻结：spacing 4/8/12/16/24/32/48px；radius 0/2/4/6/8/999px；motion 120/180/260ms | A | C | 已冻结 |
| `--surface-canvas` / `--surface-panel` / `--surface-raised` | `surface.canvas` / `surface.panel` / `surface.raised` | DF-03a 四套 mode/scheme fallback；preset 显式角色合格时优先，空值/低对比度仅回退对应角色 | A | C | 已冻结 |
| `--content-text` / `--content-muted` | `content.text` / `content.muted` | 同套件 text/muted fallback；普通文本 `>=4.5:1` | A | C | 已冻结 |
| `--stroke-default` / `--connector-default` | `stroke.default` / `connector.default` | 同套件边界 fallback；非文本边界 `>=3:1` | A | C | 已冻结 |
| `--accent` | `accent` | 同套件 accent fallback；显式主题字段合格时优先 | A | C | 已冻结 |
| `--state-success` / `--state-warning` / `--state-danger` / `--state-focus-ring` | `state.success` / `state.warning` / `state.danger` / `state.focusRing` | 同套件状态/焦点 fallback；状态保留 label/ARIA/非颜色线索 | A | C | 已冻结 |
| `--ui-radius-none` / `--state-disabled-opacity` / `--type-interface-*` / `--type-content-*` / `--type-code-*` | DF-02/02d/04 宿主尺度、禁用与三角色字体别名 | 继续消费现有 spacing/radius/motion/type fallback；插件通过 Font Registry/Profile/renderer settings 覆盖 | A | C | 已冻结 |

## 6. 例外与契约请求

| 请求/例外 | 影响文件 | 原因 | 根 agent 决定 | 状态 |
|---|---|---|---|---|
| 待填写 | 待填写 | 不得直接扩展 persistence/interface contract | 待填写 | 待审 |

## 7. 交接记录（执行时填写）

| 卡片 | 改动文件 | 未改动的越界文件 | 验证命令/结果 | 公共契约变更 | 遗留风险/待根 agent 决策 |
|---|---|---|---|---|---|
| AUTONOMY-OPEN | — | 本线路白名单 | PREFLIGHT/只读审计已完成 | 无 | 按 B-01 → B-02 → B-03 → B-04 自治施工；一功能一 commit |
| B-18 | `src/components/chat/messageLookups.ts`；新增 `src/components/chat/__tests__/B-18-cancelled-display.test.ts` | store/preset/runtime/backend、其他领域状态机、线路 A/C、公共 token/色板/字体/动效、总契约/原始施工书；既有外部工作树改动未触碰 | 根 agent 复跑：targeted ESLint exit 0；targeted Vitest exit 0（1 file/3 tests）；`git diff --check` exit 0。测试只保护长期语义不变量：带输出 `cancelled/canceled` 不得进入 completed lookup | 无 | **ACCEPTED（2026-08-28）**；已纳入线路基线提交，后续按自治序列继续 |

## 8. 不确定事项处理

- 若需要编辑 `store.ts`、`customPresets.ts`、`presetReducer.ts`、`activateInterfaceMode.ts`、`applyPresentationProfile.ts`、`interfaceModeTypes.ts` 或后端/领域状态机文件，先停工问根 agent。
- 若需要让插件强制采用宿主 radius/spacing/shadow/motion，按 Q5 C 默认拒绝；只能提交“自愿消费 token”的契约请求。
- 若无法判断某个修改是纯展示映射还是业务语义变更，保留现状并提问；根 agent 无法裁决时向用户升级。
