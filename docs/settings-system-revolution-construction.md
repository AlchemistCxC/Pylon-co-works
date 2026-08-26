# Pylon 设置系统视觉革命施工书

> 状态：施工中（Phase 1–5 已接线，补充边界已落地，待 Edge 产品验收）  
> 日期：2026-08-26  
> 配套视觉稿：[settings-system-revolution-prototype.html](./settings-system-revolution-prototype.html)  
> 原型方案：rail、canvas、ledger

## 0. 结论

本轮不推翻设置系统骨架，也不把设置页升级成新的参数所有者。

保留的核心原则是：

> Kernel 部件、Renderer 和插件声明自己拥有哪些参数；设置系统只有发现、编排、搜索、呈现、预览和调用参数所有者事务的权利。

三级导航继续存在，但重新明确职责：

1. 一级是稳定的管理领域。
2. 二级是具有明确 owner 的功能区域。
3. 三级是 owner 贡献的语义类别，不再直接等同于全部 schema object。

用户已选定网页原型的 **C — Index Ledger** 作为生产基线，吸收：

- B — Preview Canvas 的真实局部预览与后续点选能力。
- A — Studio Rail 对 owner、共享设置与 Kind 例外的清晰表达。

这不是三套方案的平均值。生产骨架选择 C；A/B 只贡献明确的局部能力。原型 C 的浅色 serif 账本只是结构验证，生产皮肤必须按 Terminal Workstation 重新实现。

### 0.1 本轮美术方向：Terminal Workstation

生产实现以 terminal-like 为第一验收目标，但不退化成纯命令行：

- 保留三级可视导航、图形控件、取色、滑块、Select、局部预览和鼠标操作。
- 采用复古工作站/编辑器面板气质：平直表面、硬朗分隔、紧凑节奏、克制的 mono 技术标注。
- 圆角只用于需要表达独立可点击边界的紧凑控件；主面板、导航区、字段组不使用大圆角卡片。
- Terminal-like 默认圆角建议为 0 / 2 / 4px；Modern GUI 可以在同一行为骨架上使用更柔和的皮肤。
- 不用持续霓虹、扫描线、CRT 噪点等装饰妨碍阅读；复古感来自排版、线条、状态色和层级，而不是滤镜。
- 原型 A 的排布是信息架构参考，不是生产视觉稿；生产 CSS 必须重新按 terminal-like 基调实现。

## 1. 本轮目标

### 1.1 信息架构

- 保留功能区域分明的三级设置导航。
- Renderer 不再把 Suite、Slot 和全部 Kind 当作一张长表单。
- 当前页面只挂载正在编辑的 category、object 和 schema。
- 搜索不依赖 DOM 是否已挂载，命中后定位三级路由、对象、组和字段。
- 插件仍可注册设置页、选项和 Renderer schema；没有友好编排元数据的贡献进入稳定 fallback。

### 1.2 视觉系统

- 重做菜单、字段行、取色器、滑块、开关、分段选择器、Select、折叠组和来源提示。
- 不再依靠“每组一张玻璃卡片加阴影”制造层级。
- 用表面明度、间距、字重、细分隔线和少量语义色建立秩序。
- Terminal-like 与 Modern GUI 可以有不同皮肤，但必须共享控件行为、焦点、尺寸和信息层级。

### 1.3 Renderer 设置

- 以语义类别编排 Renderer：
  - 基础与排版
  - Markdown 与文本
  - 代码与终端
  - 思考过程
  - 工具活动
  - 文件与资源
  - 交互与诊断
  - 插件扩展
  - 高级目录
- 共享工具设置只出现一次；具体 Kind 仅显示真正不同的例外。
- 使用真实 Suite、Slot、fixture 和 RenderSurface 做局部预览。
- 正确消费 collapsedByDefault、详细度和条件字段。

### 1.4 预设系统

- 预设不再只知道 Theme store。
- 参数所有者可以选择贡献版本化的预设快照 provider。
- 自定义预设至少能够覆盖 Theme、Presentation Profile、Renderer Suite 偏好与 Renderer settings overrides。
- 插件参数必须显式 opt-in，不能被设置页擅自捕获。
- 旧预设继续可用，并明确显示覆盖范围。
- 新增字段由所属 provider 的默认策略接管，不再由设置页维护字段白名单。

## 2. 非目标

- 不合并 Theme store 与 Renderer settings store。
- 不改变 Kernel、插件或 Renderer 对参数值的所有权。
- 不在本轮开放完整 Interface Mode 插件贡献。
- 不把任意插件私有设置自动塞进外观预设。
- 不在本轮实现 Preview Canvas 的所有“点击元素直接编辑”能力。第一阶段只建立真实预览和稳定元数据。
- 不 build release；构建与最终产品验收由用户完成。
- 不为纯视觉 CSS 编写大批像素快照测试。

## 3. 源码调查结果

### 3.1 当前三级导航的优点

src/settingsDomains.ts 已经提供稳定的一级 domain 与二级 section：

- 外观
- 工作区
- Agent 与连接
- 插件

src/components/Settings.tsx 再从 Theme group 或 Renderer registry 派生三级项。这个骨架符合“设置只编排”的原则，应保留。

### 3.2 Renderer 长表单不是视觉问题，而是投影方式错误

src/components/settings/RendererSettingsPanel.tsx 当前执行：

    active suite settings
    + matching slot settings
    + every kind settings
    → flatMap every group
    → mount one long form

结果：

- 大量 schema 同时挂载。
- Renderer catalog 的技术结构直接泄露给普通用户。
- 搜索依赖长表单过滤，而不是索引后定位对象。
- 左侧三级菜单与正文同时重复 catalog。
- collapsedByDefault 没有被消费。
- Renderer 详细度没有进入字段过滤。
- “恢复本组”调用 store.reset(namespace)，实际重置整个 object。

### 3.3 工具 schema 重复

src/domains/rendererContent/toolRenderKindCatalog.ts 为 10 个工具 Kind 分别生成相同的 17 项设置。

这不是 UI 去重能彻底解决的问题。共享工具外观应由能够表达共享语义的 Suite 或 Slot owner 声明，Kind 仅保留例外。

### 3.4 当前预览不可信

src/components/SettingsPreview.tsx 手写 PvUser、PvTool 和简化聊天结构，只读取 Theme store。

它没有经过：

- active Renderer Suite。
- 实际 Slot 选择。
- Render Kind fixture。
- resolveProductionRenderAppearance()。
- RenderSurface.mount、update 与 destroy。

Renderer section 因为没有 Theme zone，甚至没有右侧预览。继续美化这套 mock 不会解决漂移。

### 3.5 预设覆盖实况

Theme 当前有 159 个可持久化设置键。官方预设的显式字段覆盖如下：

- Claude：75 项，约 47%。
- Glass：79 项，约 50%。
- Nord：76 项，约 48%。
- Tokyo：80 项，约 50%。
- Solarized：79 项，约 50%。
- Amber：84 项，约 53%。
- 三套 Agent workflow：各 38 项，约 24%，另依赖 Presentation Profile token。

共有 63 个 Theme 字段从未被任何官方预设显式设计，其中聊天区 32 项、中控台 18 项。

setGlobalPresetReducer() 会先展开 THEME_DEFAULTS，因此不会产生 undefined；但“能回退默认”不等于“预设完整设计过新字段”。

更大的断层是：

- 自定义预设只捕获 ThemeSettings。
- Renderer settings overrides 不进入预设。
- Renderer Suite 偏好不进入预设。
- Presentation Profile 只在部分官方预设事务里间接激活。
- 插件设置无预设 opt-in 协议。
- TemplateLibrary 预览只注入 Theme CSS vars，无法显示真正 Renderer Profile。

## 4. 不可破坏的设计约束

### D1：参数所有者声明，设置只编排

设置系统不得复制业务默认值或在 UI 内推断参数语义。它消费 owner 提供的 schema、placement、fixture 和 preset provider。

### D2：三级路由稳定、可寻址

每个设置字段应能够被表示为：

    domain / section / category / object / group / field

前三段是用户信息架构；后三段是 owner schema 内部定位。

### D3：普通视图不泄露 Renderer graph

Suite、Slot、Kind、fallback 和 plugin namespace 仍然可见，但默认进入：

    外观 / 渲染器 / 高级目录

普通 category 使用友好名称，并显示 owner 来源。

### D4：现有值不能因插件暂时不可用而丢失

未加载 owner、旧 namespace、不可用 option 和旧预设 payload 必须保留。设置页可以标记不可用，但不能静默删除或改写。

### D5：真实预览与生产解析同源

Inspector 显示值、预览值和生产值必须共享 appearance/value resolution 服务，不能再维护第二套 effectiveValues()。

### D6：视觉重构不改变业务事务

滑块、取色器等高频交互可使用 session preview；完成拖动后才提交 owner store。按钮、开关和选择器继续调用现有事务。

### D7：禁止“设置页孤儿选项”

新增或保留的每一个生产设置必须能够追溯完整链路：

    owner schema / field definition
    → 设置控件
    → 持久化或 session preview
    → production resolver / consumer
    → 可观察渲染结果

如果找不到 production consumer，不得仅为了丰富界面把字段展示出来。处理方式只能是：补齐正式 consumer、标记为尚未支持且不提供写入，或从生产设置移除。

Renderer 设置验收必须逐字段检查 resolveProductionRenderAppearance()、Suite/Slot surface 或真实 CSS token 消费点；Theme 设置验收必须检查 THEME_CSS_VAR_MAP、workbench appearance 或对应组件消费者。

### D8：上下文恢复纪律

发生上下文压缩或跨轮续作时，在继续修改前必须重新阅读：

- 本施工书。
- 当前阶段涉及的 schema/field definition。
- 对应 store、transaction 与 production consumer。
- 当前 git diff，避免覆盖用户或前序未提交改动。

不得只凭对话摘要继续大规模改造。

## 5. 三级信息架构 v3

### 5.1 一级：管理领域

一级保持稳定：

    外观
    工作区
    Agent 与连接
    插件

一级不由任意插件自由创建，避免设置中心失控。插件页面默认归入“插件”；第一方稳定能力可通过受控贡献进入其他 domain。

### 5.2 二级：功能区域

外观域建议：

    模板与预设
    全局界面
    侧栏
    消息流
    渲染器
    中控台
    右栏

工作区、Agent 与连接、插件继续沿用现有 section 边界。二级是参数 owner 或稳定聚合 owner，不是字段类型。

### 5.3 三级：owner 贡献的语义类别

Theme section 的三级项继续来自 group metadata，但允许增加稳定 category id。

Renderer 的三级项不再是全部 Suite、Slot、Kind label，而是：

    基础与排版
    Markdown 与文本
    代码与终端
    思考过程
    工具活动
    文件与资源
    交互与诊断
    插件扩展
    高级目录

“插件扩展”收纳已提供 placement 但没有进入内置类别的第三方能力。

“高级目录”提供完整 Suite、Slot、Kind object browser、不可用设置、fallback 诊断和精细例外。

### 5.4 编排投影

建议增加一个只读设置投影层。它不拥有值：

    export interface SettingsPlacement {
      readonly domainId: SettingsDomainId
      readonly sectionId: SettingsSectionId
      readonly categoryId: string
      readonly categoryLabel: string
      readonly categoryOrder?: number
      readonly objectOrder?: number
      readonly disclosure?: 'essential' | 'detail' | 'technical'
    }

    export interface SettingsObjectDescriptor {
      readonly ref:
        | { namespace: 'theme'; id: string }
        | { namespace: 'suite' | 'slot' | 'kind'; id: string }
        | { namespace: 'plugin'; id: string }
      readonly ownerPluginId: string
      readonly label: string
      readonly description?: string
      readonly placement: SettingsPlacement
      readonly schema: RendererSettingsSchema | ThemeSettingsSchemaProjection
      readonly preview?: SettingsPreviewContribution
    }

    export interface SettingsOrchestrationCatalog {
      getSnapshot(): readonly SettingsObjectDescriptor[]
      subscribe(listener: () => void): () => void
      search(query: string): readonly SettingsSearchHit[]
    }

Theme、Renderer 和插件适配器把现有 registry/schema 投影成 descriptor。React 页面只消费 catalog，不直接拼接所有 registry。

未声明 placement 的 Renderer object 进入“插件扩展”，再无法归类时进入“高级目录”。

## 6. 推荐生产布局

采用原型 C — Index Ledger，并将其浅色账本皮肤替换为 Terminal Workstation 视觉。

### 6.1 双栏目录

导航继续保留用户喜欢的三级结构：

- 最左窄栏：一级 domain，使用短标签或克制图形标记，不做纯图标猜谜。
- 次左目录栏：二级 section。
- section 展开后：在同一目录栏显示三级 category。

三级只显示稳定语义类别，不显示几十个 object。

### 6.2 正文

正文一次只编辑一个 category 下的一个 object：

    面包屑
    category 标题 + owner
    object / shared-vs-exception 选择
    schema groups
    field rows
    technical disclosure

正文不再给每个 group 套高阴影卡片。推荐使用平面章节与 hairline divider。

### 6.3 预设与预览侧栏

右侧首先呈现 C 方案的预设包、provider 覆盖和当前来源；进入具体 Renderer category 后，可在“预设 / 预览”之间切换，预览展示局部 1:1 surface：

- Renderer Kind 对应 fixture。
- 工具提供 running、completed、failed。
- 思考提供 collapsed、expanded、streaming。
- Markdown 提供正文、列表、表格、代码组合。
- Diff 提供 unified、split 和状态变体。

宽度不足时，预览变成 drawer 或 sheet，不得直接隐藏。

### 6.4 高级目录

高级目录使用对象检查器：

    当前 Suite
    共享 Slots
    Kinds by category
    插件对象
    不可用设置

它是插件作者和高级用户的后门，不支配常规设置体验。

## 7. 视觉系统规范

### 7.1 表面层级

只保留三个稳定层级：

1. Canvas：应用或设置页背景。
2. Navigation / Inspector：连续平面。
3. Raised control / popover：仅弹层、选择器、预览样例。

禁止默认给每个 group 同时使用边框、圆角、渐变和阴影。

生产颜色必须从现有宿主视觉语义派生，不复制原型硬编码色板：

    页面画布       --surface-canvas
    一级窄栏       --surface-sunken
    二三级目录     --surface-panel
    设置表面       --surface-raised / transparent
    弹层           --surface-overlay
    普通分隔       --stroke-subtle
    强分隔         --stroke-default / --stroke-strong
    选中           --state-selected-bg / --state-selected-stroke
    焦点           --state-focus-ring / --accent
    状态           --success / --warning / --danger

这些 token 最终受 ThemeSettings、UI scheme 与现有 visual semantics 控制。设置页不得再写一组固定黑、紫、灰作为自己的主题。

Terminal-like 圆角纪律：

- 页面、一级栏、目录栏、正文、字段 group：0px。
- 输入、Select、segment、按钮：2px。
- popover、dialog、浮动预览：最多 4–6px。
- 只有真正的语义 badge、开关轨道和状态点允许 pill/圆形。
- C 原型中的大圆角 preset card、浅色 serif 皮肤和装饰阴影不进入生产实现。

### 7.2 字体层级

- 页面标题：24–28px，680–720。
- category 标题：18–22px，660–700。
- group 标题：13px，650–680。
- field label：12–13px，620–660。
- 描述：11–12px，1.45–1.55 行高。
- owner id、namespace、技术值：9–11px mono。

普通中文说明不使用 mono。

### 7.3 色彩

- Accent 只表达选中、焦点和 active owner。
- Success、Warning、Error 只表达真实状态。
- 普通边界使用低对比 hairline。
- 取色器中的颜色是内容，不让大量彩色色块污染菜单层级。
- Modern GUI 可使用柔和 surface wash；Terminal-like 使用更平直的边界和更少圆角。

### 7.4 间距与圆角

建议 token：

    space: 4 / 8 / 12 / 16 / 24 / 32
    terminal radius: surface 0 / control 2 / popover 4–6
    modern radius: 6 / 10 / 14（只由 Modern GUI 皮肤消费）
    control-height: 30 / 34 / 38

字段行默认高约 64–72px；紧凑模式可以降至 50–56px。

### 7.5 菜单

- 一级用 tile 或短 tab，明确“领域”。
- 二级使用常规导航行，active 有 surface wash 加 2px rail。
- 三级缩进并降低字号，但 active 仍有明确色彩和背景。
- dirty、unavailable、plugin owner 使用文字 badge，不堆多个无含义圆点。
- pinned 仅 hover/focus 常显，已置顶常显。

### 7.6 字段行

字段行标准结构：

    label                      control
    description
    source / inherited / exception              reset

“恢复默认”改为更准确的：

- 重新跟随。
- 恢复此字段。
- 恢复本组。
- 恢复当前对象。

三者的 reset scope 必须严格区分。

### 7.7 取色器

取色器不再只是圆形 swatch 加原生 picker：

- 当前颜色大样。
- Hex/RGBA 文本。
- owner 私有 palette。
- Alpha 轨道。
- 最近使用。
- “跟随语义色”入口。
- 无效值和 CSS token 值可辨识展示。

Renderer schema 当前允许 var(--text)、transparent 等值；控件不能只接受六位 hex。

### 7.8 滑块

- 使用 Radix Slider。
- track、range、thumb 具有清晰但克制的层级。
- 与数值输入成对出现。
- 键盘修改继续可用。
- 拖动期间写 session preview，结束后 commit。
- 单位、范围和 reset 不挤进 track。

### 7.9 开关与分段选择

- 开关至少 38×22，thumb 14–16px。
- on/off 不只依赖颜色，thumb 位置必须明确。
- 分段选择用于 2–4 个短选项；更多选项使用 Select 或 radio list。
- active segment 使用 surface 与字重，不使用满屏高饱和 accent 底。

### 7.10 Select

- trigger 保持单行清晰。
- option 支持 label、description、disabled 和来源。
- 插件 option 暂不可用时保留当前值并显示 recovery 状态。
- namespace 不作为普通 option label。

### 7.11 动效

- 120–180ms。
- 只用于菜单选择、popover、group disclosure、preview state。
- 不使用持续发光装饰。
- 完整尊重 prefers-reduced-motion。

## 8. Renderer 设置重编排

### 8.1 Catalog 投影

新增 RendererSettingsCatalogProjection：

- 订阅 Renderer registry。
- 解析 active Interface Mode 与 Suite preference。
- 按 placement/category 生成 object descriptor。
- 建立独立搜索索引。
- 插件热装卸后修复当前 selection。
- 不挂载未选中的 schema。

### 8.2 共享工具设置

把以下共享项从 10 个 tool Kind 上移到 Suite 或 Slot owner：

- foreground / mutedForeground。
- background / borderColor。
- statusPalette。
- indicator。
- density。
- maxWidth / maxHeight。
- defaultCollapsed。
- showRaw / showMetadata / showDuration。
- connectorMode / style / width / opacity。

具体 Kind 仅声明：

- 特有内容字段。
- 与共享默认不同的可选例外。
- fixture / preview states。

旧 kind.tool override 不删除，迁移为“Kind 例外”或“遗留 override”。

### 8.3 值来源

Inspector 与生产预览共享解析结果：

    schema default
    → host semantic default
    → kind default token
    → presentation profile
    → suite / slot shared override
    → kind exception
    → session preview

UI 至少显示当前值、来源、继承状态、Kind 例外和 owner 可用状态。

### 8.4 搜索

搜索索引在 catalog 层生成，不遍历 DOM。

命中结果应携带：

    interface SettingsSearchHit {
      domainId: string
      sectionId: string
      categoryId: string
      objectRef: SettingsObjectRef
      groupId: string
      fieldKey: string
      label: string
      path: string
      disclosure: 'essential' | 'detail' | 'technical'
    }

点击后切换 domain、section、category、object，展开 group 并聚焦 field。

### 8.5 Group disclosure

- 必须消费 collapsedByDefault。
- Essential 默认展开。
- Detail 可以折叠。
- Technical 默认折叠并进入“全部”详细度。
- 搜索命中 technical 字段时只临时揭示目标。

### 8.6 Reset scope 修复

Renderer store 现有 reset(scope) 可以重置 object namespace，但没有 group reset。

Group reset 必须枚举 group field keys 并逐项 removeOverride，不能再使用 object namespace。

## 9. 真实预览架构

### 9.1 Preview contribution

    export interface SettingsPreviewContribution {
      readonly kindIds: readonly string[]
      readonly defaultKindId?: string
      readonly states?: readonly {
        id: string
        label: string
        fixture?: unknown
      }[]
      readonly preferredWidth?: number
    }

Kind 已有 fixture，优先复用。owner 只在需要多状态时补充 state fixture。

### 9.2 Preview adapter

    export interface RendererSettingsPreviewAdapter {
      mount(container: HTMLElement, request: PreviewRequest): void
      update(request: PreviewRequest): void
      destroy(): void
    }

内部复用现有 workbench preview services、Suite activation graph、Slot 与 RenderSurface 生命周期。

### 9.3 生命周期要求

- 一次只挂载一个 preview surface。
- 每个 request 带 revision，过期异步结果不得覆盖新选择。
- category/object 切换时 destroy 旧 surface。
- renderer 崩溃显示真实 fallback 与 diagnostics。
- fixture 必须通过对应 Kind validator。
- slider/取色 preview 高频更新不得写持久化 store。

## 10. 预设系统 v2

### 10.1 设计判断

需要重构预设 envelope，但不需要推翻 Theme preset reducer。

Theme delta 与 zone preset 继续作为 Theme owner 的内部实现。新的预设系统只在外层聚合多个 owner provider。

### 10.2 Provider 协议

    export interface PresetProvider {
      readonly id: string
      readonly ownerPluginId: string
      readonly schemaVersion: number
      readonly label: string

      capture(scope: PresetCaptureScope): JsonValue
      prepareApply(payload: JsonValue, context: PresetApplyContext): PresetPreparedApply
      defaults(scope: PresetCaptureScope): JsonValue
      migrate?(fromVersion: number, payload: JsonValue): JsonValue
      describeCoverage(payload: JsonValue): PresetCoverage
    }

    export interface PresetPreparedApply {
      readonly summary: readonly PresetChangeSummary[]
      commit(): void | Promise<void>
      rollback(): void | Promise<void>
    }

设置页只列出 provider、捕获 payload、显示摘要并协调 prepare、commit、rollback。

值的校验、默认值、迁移和应用仍由 owner provider 负责。

### 10.3 Manifest

    export interface PresetBundleV2 {
      readonly manifestVersion: 2
      readonly id: string
      readonly name: string
      readonly source: 'builtin' | 'user' | 'plugin'
      readonly createdAt?: number
      readonly updatedAt?: number
      readonly contributions: Readonly<Record<string, {
        readonly ownerPluginId: string
        readonly providerVersion: number
        readonly policy: 'complete' | 'partial'
        readonly payload: JsonValue
      }>>
      readonly unavailable?: Readonly<Record<string, JsonValue>>
    }

### 10.4 第一方 provider

首批：

1. builtin.theme
   - 复用 THEME_SETTING_KEYS、Theme defaults、delta 与 zone reducer。
2. builtin.presentation
   - Interface Mode、Presentation Profile、Renderer Suite preference。
3. builtin.renderer-settings
   - Suite、Slot、Kind override 与 unavailable 值。

插件设置只有显式注册 PresetProvider 才进入预设。

### 10.5 complete 与 partial

- 官方完整皮肤使用 complete。
  - provider 先恢复当前版本默认值，再应用 delta。
  - 新字段如果旧预设未记录，跟随 owner 当前默认值。
- 局部预设使用 partial。
  - 只改 payload 中声明的字段。
  - 其他值保持不动。

UI 必须显示应用范围，不能把 partial 假装成完整主题。

### 10.6 新字段覆盖

预设不能保证未来字段具有作者当年不存在的审美决策，但可以保证确定性：

    显式 authored value
    或
    该 provider 当前版本 default

覆盖状态分为：

- 显式设计。
- 跟随 owner 默认。
- provider 未记录。
- owner 暂不可用。

官方预设应有轻量 coverage 检查，提醒新增视觉关键字段尚未被任何官方预设显式设计，但不要求每个 preset 复制全部默认值。

### 10.7 旧格式迁移

旧内置 GlobalPreset 的 theme 与 optional presentationProfileId 运行时适配为 builtin.theme 和 builtin.presentation。

旧 CustomPreset 的 theme delta 适配为只包含 builtin.theme 的 v2 bundle，并在 UI 显示：

    Theme：兼容
    Presentation：未记录
    Renderer overrides：未记录

用户下次覆盖保存时升级为 v2。

缺失插件 provider 的 payload 放入 unavailable 原样保存；插件恢复后允许重新挂接。

### 10.8 预设 UI

预设卡片不再放一个不可读的整应用缩略图。

每张卡显示：

- 色彩与排版小样。
- 来源与版本。
- provider 覆盖数。
- 显式、跟随、缺失状态。
- 完整应用或选择区域应用。

应用流程：

1. 选择预设。
2. 查看涉及 owner 与覆盖范围。
3. 选择“全部”或指定功能区域。
4. prepare 所有 provider。
5. commit；失败时 rollback。

## 11. 施工阶段

### Phase 0：保留设计决策

- 施工书与原型进入仓库。
- 用户选定生产骨架。
- 原型明确标记 throwaway，生产落地后删除。

### Phase 1：视觉基础控件

目标：

- 整理 Settings CSS token。
- 重做菜单、字段行、取色器、Slider、Switch、Segmented、Select、折叠组。
- 不改变 store 或业务事务。

主要文件：

- src/plugins/product/packages/builtin.pylon-shell/styles/components/Settings.css
- src/plugins/product/packages/builtin.pylon-shell/styles/components/SettingsCommon.css
- src/components/ColorPopover.tsx
- src/components/ui/Select.tsx
- src/components/settings/RendererSettingField.tsx
- Theme field renderer 对应文件。

### Phase 2：三级编排 catalog

- 抽取 SettingsOrchestrationCatalog。
- 把 Settings.tsx 的 registry 拼装与搜索索引移出 React。
- Renderer 三级菜单改为语义 category。
- 保留 Plugins 页和 fallback。

### Phase 3：Renderer 单对象 Inspector

- 删除全 catalog 长表单。
- 一次挂载一个 category、object、schema。
- 正确处理 disclosure、条件字段、来源与 reset scope。
- 工具共享 schema 上移，旧 Kind override 显示为例外。

### Phase 4：真实局部预览

- 复用真实 workbench services 与 fixtures。
- Renderer section 有局部预览。
- Theme section 根据 zone 使用局部可读预览，逐步淘汰整应用缩略图。

### Phase 5：Preset Provider v2

- Provider registry 与 bundle envelope。
- Theme、Presentation、Renderer 三个第一方 provider。
- v1 adapter 与惰性升级。
- 新 Template Library 与 coverage UI。

### Phase 6：清理

- 删除失败原型与旧假预览代码。
- 删除旧 Renderer 全量导航和重复样式。
- 更新插件设置贡献文档。
- 保留必要 migration。

## 12. 提交纪律

建议按可回滚的窄提交实施：

1. docs(settings): add settings revolution design
2. style(settings): establish navigation and control primitives
3. refactor(settings): add orchestration catalog projection
4. refactor(renderer-settings): mount selected schema only
5. feat(renderer-settings): add real fixture preview
6. refactor(tool-settings): move shared fields to shared owner
7. feat(presets): add provider manifest v2
8. style(settings): replace template and coverage surfaces
9. chore(settings): remove obsolete prototype and fake preview

每个提交不混入聊天 journal、会话重放或 ACP 主链变更。

## 13. 测试与验收纪律

用户已明确：本轮主要是视觉和编排重构，不需要堆大量测试。

### 13.1 不写

- 不写像素截图快照。
- 不为每个 CSS selector 写字符串测试。
- 不为三个原型方案写测试。
- 不重复现有 Radix 键盘行为测试。

### 13.2 最小自动化

只保留高风险边界：

1. Catalog projection：
   - 插件热装卸后 selection 不指向不存在对象。
   - 未选中 schema 不挂载。
2. Reset scope：
   - group reset 不会重置同 object 的其他 group。
3. Preset v1 → v2：
   - 旧 Theme delta 仍可应用。
   - unavailable provider payload 不丢失。
4. Preset provider：
   - prepare 失败时不发生半应用。
5. 现有 style ownership 守卫继续通过。

预计只新增或修改少量聚焦测试，不建立庞大新测试矩阵。

### 13.3 Edge 人工验收

- 三级导航层级在 100%、125%、150% 缩放下清晰。
- Renderer 只挂载当前 object，切 category 不发生明显迟滞。
- 颜色、滑块、开关、Select 键盘与鼠标均可操作。
- dark/light、Modern GUI、Terminal-like 均有足够对比。
- 预览不缩成不可读的完整应用。
- 插件加载或卸载后菜单、搜索和 unavailable 状态正确。
- v1 自定义预设显示覆盖缺口，应用后不丢 Theme 数据。

## 14. 验收标准

### 信息架构

- 一级、二级、三级职责清晰。
- 普通 Renderer 用户不需要理解 Suite、Slot、Kind。
- 高级用户仍能进入完整技术目录。
- 每个字段能显示 owner 与来源。

### 性能

- 进入 Renderer 设置时不挂载全部 Kind schema。
- 搜索不要求预先渲染所有字段。
- 一次只运行一个 preview surface。

### 视觉

- 菜单、字段、控件与预览形成稳定层级。
- 取色、滑块、开关不再呈现为轻微修饰的浏览器默认控件。
- 不依赖大量卡片、玻璃和阴影。
- 功能区域辨识度比当前更强。

### 预设

- UI 能解释一个预设覆盖了哪些 owner。
- 旧预设可用。
- Renderer Profile 与 overrides 可以被新预设捕获。
- 新字段至少确定性跟随 owner 默认。
- 插件缺席时 payload 不丢失。

## 15. 风险与回滚

### 风险：编排 metadata 变成第二套 schema

约束：placement 只描述“放在哪里、如何披露”，不复制字段默认值、选项或业务条件。

### 风险：共享工具 schema 迁移改变已有外观

约束：旧 Kind override 先作为例外接入解析链，完成对账后再考虑清理。

### 风险：真实 Preview 引入 Renderer 生命周期问题

约束：复用已有 smoke/QA services；一次一个 surface；revision 取消；独立 Error Boundary。

### 风险：跨 provider 预设半应用

约束：prepare、commit、rollback；应用前保存内存快照；失败时恢复。

### 回滚

- Phase 1 纯视觉可按 CSS/组件提交回滚。
- Phase 2/3 保留旧 Panel feature flag，直到新 Inspector 完成验收。
- Phase 5 保留 v1 reader；v2 写入出现问题时可停止创建新 bundle，不影响旧预设读取。

## 16. 网页原型评审方法

用浏览器打开：

    /docs/settings-system-revolution-prototype.html?variant=rail

底部切换器或键盘左右键可切换：

- rail：最贴近当前三级导航，推荐生产基线。
- canvas：强调真实预览与直接操作。
- ledger：强调密集目录和预设覆盖。

评审时重点回答：

1. 一级 domain 更适合 2×2 tile，还是横向 tab 或 icon rail？
2. 二级与三级的视觉缩进是否足够清晰？
3. Renderer 是否接受“语义 category 为普通入口、高级目录看 graph”？
4. 右侧 preview 是否需要常驻？
5. 预设覆盖信息应该常显，还是只在应用前显示？

用户选定后，保留结论并删除未采用的 prototype 代码；生产实现重新按正式组件质量编写，不能直接复制原型。

## 17. 增量施工记录（2026-08-26）

以下约束已在生产代码中继续收口，后续修改不得回退：

- `projectRendererSettingsCatalog()` 是 Renderer 设置导航、搜索和 Inspector 共用的只读投影入口；它不持有值，也不复制 schema 默认值。
- 未知或第三方自定义 `categoryId` 必须归一到“插件扩展”，不得因为内置导航没有对应条目而静默丢失。
- Renderer 真实预览必须按语义类别选择 fixture Kind：工具优先工具 Kind，代码/终端优先对应内容 Kind；不得按 Slot 原始注册顺序随意显示文本 fixture。
- 预览状态切换是只读演示态，不新增持久化设置字段：工具提供运行中/完成/失败，思考提供思考中/完成，文本提供静态/流式。
- Renderer store 的 `reset(scope)` 必须同时清掉 scope 内的 `sessionPreview`；组级恢复必须逐字段清理持久化 override 与临时 preview，不能让旧临时值继续遮蔽 owner 默认值。
- Terminal-like 的普通中文标题、对象名、组名和描述使用 `--font`；`--mono` 仅用于 owner、namespace、路径、来源和技术标注。结构面仍为 0px，控件 2px，浮层 4px。
