/**
 * widgetDefinitions — 中控元件两级定义表（组 + 成员）单一真值。
 *
 * 表形（issue #238 刀1·结构步）：
 * - **组**：可摆、可藏、可缩放的单元 —— 表里 `draggable` 的行才进
 *   `ccLayout` / `ccHidden` / `ccScale` 三份名单。共 8 行 = 控件 7 + 容器 1（`cc-surface`）。
 * - **成员**：组里一个有名字的部件 + 它自己那组字段 —— **只做归属**，不进任何名单。
 *
 * 其余全部派生：`CC_WIDGET_IDS` / `STATUS_WIDGET_IDS` / 常态放行名单 / 空态隐藏名单 /
 * 标签表 / 默认布局（`ccLayoutState.ts`）/ 目录三份（`widgetCatalog.ts`）/
 * 属性表单 / 编辑工具条（`ControlCenter.solid.tsx`）。
 *
 * ★ 依赖方向（#238 头号雷）：本表**不得在运行时 import `src/themeFieldDefs.ts`** ——
 * `themeFieldDefs → ccHeightState → 本文件` 已是一条运行时链，反向即成环，而且是**静默**环
 * （模块初始化期拿不到值，症状是 undefined / NaN，不报错）。所以这里对 themeFieldDefs
 * **只有 `import type`**（类型擦除，零运行时边），字段键本身写字符串；
 * 「每个字段都合法、83 个全覆盖且无重叠」由 `__tests__/widgetDefinitionTable.test.ts` 机检。
 *
 * ★ 间距栏位 `gap` 本刀**只记值不消费**：控件里硬编码的 `PERMISSION_GAP_PX` /
 * `REASONING_GAP_PX`（12px）仍原地生效，收编（改成消费表里的值）属内容步
 * —— 依据 #238 施工单停手条件 7（做不到像素级相同就退回原处）。
 *
 * ★ 中文名一律**照抄现状**（渲染出来的字逐字相同）：`cc-surface` 的现状字面量是
 * 「中控本体背景板」（骨架 §2 单元格写作「中控本体」，按其 §4 栏位字典「中文名照抄现状」
 * 取现状值）；`mode` 同理取「权限模式」而非骨架里的「权限」。
 * 新增 widget：此处加一行 + `widgetRenderers` 补 renderer + 该行的 `propertyFields` 补表单。
 */
import type { ThemeSettings } from '../../store.ts'
import type { ThemeFieldKey } from '../../themeFieldDefs.ts'
import type { CcWidgetPlacement } from '../../ccLayoutState.ts'

export type CcColorPropertyKey = 'inputBg' | 'inputTextColor' | 'cliLineColor'
export type CcNumberPropertyKey =
  | 'inputFontSize' | 'inputMinHeight' | 'inputHeight' | 'inputOffsetTop' | 'cliLineWidth' | 'cliLinePadding'
  | 'modelWidth' | 'modelHeight' | 'modelRadius' | 'modelFontSize'
  | 'reasoningWidth' | 'reasoningHeight' | 'reasoningRadius' | 'reasoningFontSize'
  | 'permissionWidth' | 'permissionHeight' | 'permissionRadius' | 'permissionFontSize'
export type CcStringPropertyKey = 'inputMode' | 'inputVariant' | 'inputLineHeight' | 'modelSwitchMode' | 'modelBgColor' | 'modelTextColor' | 'sendVariant' | 'reasoningSwitchMode' | 'reasoningBgColor' | 'reasoningTextColor' | 'permissionSwitchMode' | 'permissionBgColor' | 'permissionTextColor'
export type CcEditablePropertyKey = CcColorPropertyKey | CcNumberPropertyKey | CcStringPropertyKey

export type WidgetPropertyField =
  | { kind: 'section'; title: string }
  | { kind: 'color'; key: CcColorPropertyKey; label: string }
  | { kind: 'number'; key: CcNumberPropertyKey; label: string; min: number; max: number; step?: number; suffix?: string }
  | {
      kind: 'chips'
      key: CcStringPropertyKey
      label: string
      options: { value: string; label: string; sync?: { key: CcStringPropertyKey; value: string } }[]
    }

export type CcPropertyCommand =
  | { readonly type: 'set-cc-property'; readonly key: CcColorPropertyKey | CcStringPropertyKey; readonly value: string }
  | { readonly type: 'set-cc-property'; readonly key: CcNumberPropertyKey; readonly value: number }

export type WidgetPropertyVisibilityContext = Pick<ThemeSettings, 'inputMode'>

export interface WidgetPropertyDef {
  /** 条件显示（cli 字段只在 inputMode==='cli' 时出现） */
  showIf?: (theme: WidgetPropertyVisibilityContext) => boolean
}

/** 每 widget 的属性表单（纯数据）。inputMode↔inputVariant 双写经 chips 的 sync 表达
 * （主键写 value 时同步写 sync.key），保持与 Settings 双写一致。 */
export type WidgetPropertyForm = readonly (WidgetPropertyField & WidgetPropertyDef)[]

// ── 成员层（两级中的第二级）──

/**
 * 成员显隐：**引用已有字段，不新增字段**（规范 §4.3）。
 * `field` 取值命中 `visibleWhen` 即显示；`content` = 内容驱动；`host` = 宿主注入。
 */
export type CcMemberVisibility =
  | { kind: 'always' }
  | { kind: 'field'; field: ThemeFieldKey; visibleWhen: readonly (string | boolean)[] }
  | { kind: 'content' }
  | { kind: 'host' }

export interface CcWidgetMember {
  id: string
  /** 中文名（★ 照抄现状口径，渲染出来的字逐字相同） */
  label: string
  /** 该成员拥有的字段键（★ 字符串键，不在运行时 import themeFieldDefs） */
  fields: readonly ThemeFieldKey[]
  visibility: CcMemberVisibility
  /** 外观字段**借用**另一行（用量借模型）——显式化隐式耦合，不留暗线（规范 §5.3） */
  borrowsFrom?: string
  note?: string
}

// ── 组层 ──

export interface CcWidgetGroup {
  id: string
  /** 容器 = 不可拖、不占槽、承载外观项、可作锚点；控件 = 可拖、有成员、挂在锚点上 */
  type: 'widget' | 'container'
  label: string
  category: string
  /** 渲染轨：`builtin` = 内置渲染器；`registered` = 注册轨（宿主渲染，经 ccWidgetRegistry） */
  rail: 'builtin' | 'registered'
  /** 锚点 = 贴哪一行（指向表内 id）；最外的容器无锚点。★ 必须无环，顺锚点必到 `cc-surface` */
  anchor?: string
  /** 方位（★ 值属内容层，结构步照抄现状） */
  side?: string
  /** 间距（★ 值属内容层；结构步只记值不消费，见文件头） */
  gap?: number
  /** 是否进 `ccLayout` / `ccHidden` / `ccScale` 三份名单 */
  draggable: boolean
  /** 常态放行：活跃会话里也显示（派生 `ALWAYS_VISIBLE_STATUS_WIDGET_IDS`） */
  alwaysVisibleInActiveSession?: boolean
  /** 空态隐藏（派生 `EMPTY_STATE_HIDDEN_WIDGET_IDS`） */
  hiddenInEmptyState?: boolean
  /** 容器不占位 ⇒ 缺此项 */
  defaultPlacement?: CcWidgetPlacement
  /** 属性表单（PropertyPanel 消费） */
  propertyFields?: WidgetPropertyForm
  members: readonly CcWidgetMember[]
  note?: string
}

/**
 * 行的类型：`id` / `type` / `rail` / `draggable` 保成**字面量**（供 `Extract` 派生 id 联合与名单），
 * 其余栏位走 `CcWidgetGroup` 的上下文类型检查（漏字/写错键当场报错）。
 */
type CcWidgetGroupRowOf<
  Id extends string,
  Type extends 'widget' | 'container',
  Rail extends 'builtin' | 'registered',
  Draggable extends boolean,
> = Omit<CcWidgetGroup, 'id' | 'type' | 'rail' | 'draggable'> & {
  id: Id
  type: Type
  rail: Rail
  draggable: Draggable
}

/** 行工厂：见 `CcWidgetGroupRowOf` 的说明。 */
function widgetGroup<
  Id extends string,
  Type extends 'widget' | 'container',
  Rail extends 'builtin' | 'registered',
  Draggable extends boolean,
>(row: CcWidgetGroupRowOf<Id, Type, Rail, Draggable>): CcWidgetGroupRowOf<Id, Type, Rail, Draggable> {
  return row
}

/**
 * ★★ 定义表本体：8 行 = 控件 7 + 容器 1（结构冻结件 `03-结构-定义表骨架-20260922.md` §2）。
 * 值一律照抄现状，本表落地即「行为零变化」。
 */
export const CC_WIDGET_GROUPS = [
  widgetGroup({
    id: 'cc-surface',
    type: 'container',
    label: '中控本体背景板',
    category: 'surface',
    rail: 'registered',
    draggable: false,
    members: [
      {
        id: 'surface-body',
        label: '中控本体面',
        fields: ['ccHeight', 'ccMarginX', 'ccMarginBottom', 'ccRadius', 'ccBg', 'ccSurfaceOpacity', 'ccBgImage', 'ccVariant'],
        visibility: { kind: 'always' },
      },
    ],
    note: '最外的容器：不开槽位、不可拖不可藏，是所有其它行的锚点终点（其值在设置页编辑）。',
  }),
  widgetGroup({
    id: 'input',
    type: 'widget',
    label: '输入栏',
    category: 'input',
    rail: 'builtin',
    anchor: 'cc-surface',
    side: 'peri=文档流首项／free=绝对浮起',
    draggable: true,
    defaultPlacement: { slot: 'input', order: 0, offsetX: 0, offsetY: 0 },
    propertyFields: [
      { kind: 'section', title: '输入栏设置' },
      { kind: 'color', key: 'inputBg', label: '背景色' },
      { kind: 'color', key: 'inputTextColor', label: '文字色' },
      { kind: 'number', key: 'inputFontSize', label: '字号', min: 12, max: 22, step: 1 },
      { kind: 'number', key: 'inputMinHeight', label: '最小高度', min: 36, max: 120, step: 0.1 },
      {
        kind: 'chips', key: 'inputMode', label: '模式',
        options: [
          { value: 'default', label: '标准输入', sync: { key: 'inputVariant', value: 'composer' } },
          { value: 'cli', label: '命令行', sync: { key: 'inputVariant', value: 'cli' } },
        ],
      },
      { kind: 'number', key: 'cliLineWidth', label: '边框宽度', min: 1, max: 6, step: 0.1, showIf: t => t.inputMode === 'cli' },
      { kind: 'color', key: 'cliLineColor', label: '边框颜色', showIf: t => t.inputMode === 'cli' },
      { kind: 'number', key: 'cliLinePadding', label: '内边距', min: 0, max: 24, step: 0.1, showIf: t => t.inputMode === 'cli' },
    ],
    members: [
      {
        id: 'textarea',
        label: '输入框本体',
        fields: [
          'inputOffsetTop', 'inputHeight', 'inputMarginX',
          'inputSurfaceBg', 'inputSurfaceOpacity', 'inputFocusRingEnabled', 'inputFocusRingColor',
          'inputHighlightOpacity', 'inputShadowEnabled', 'inputBg', 'inputBgImage',
          'inputTextColor', 'inputPlaceholder', 'inputShowPlaceholder',
          'inputBorderColor', 'inputFocusBorder', 'inputBorder', 'inputBorderWidth', 'inputBorderOpacity',
          'inputRadius', 'inputFontSize', 'inputLineHeight', 'inputMinHeight',
          'inputMode', 'inputVariant', 'cliTextColor', 'cliContentOffsetY', 'cliOverflowMode',
        ],
        visibility: { kind: 'always' },
      },
      {
        id: 'cli-prefix',
        label: '提示符 ❯',
        fields: ['cliPromptColor'],
        visibility: { kind: 'field', field: 'inputMode', visibleWhen: ['cli'] },
      },
      {
        id: 'cli-lines',
        label: '上下两条线',
        fields: ['cliLineWidth', 'cliLineColor', 'cliLinePadding'],
        visibility: { kind: 'field', field: 'inputMode', visibleWhen: ['cli'] },
        note: '三个字段都带 showIf: inputMode === "cli"。',
      },
      { id: 'command-palette', label: '/ 命令菜单', fields: [], visibility: { kind: 'content' } },
      {
        id: 'history-hint',
        label: '历史快捷提示',
        fields: ['inputShowHistoryHint'],
        visibility: { kind: 'field', field: 'inputShowHistoryHint', visibleWhen: ['shown', true] },
      },
      { id: 'prediction', label: '输入预测', fields: [], visibility: { kind: 'content' } },
      { id: 'queue', label: '待发送队列', fields: [], visibility: { kind: 'content' } },
      { id: 'error', label: '报错条', fields: [], visibility: { kind: 'content' } },
      { id: 'empty-slot', label: '空态插槽', fields: [], visibility: { kind: 'host' } },
    ],
    note: '间距走 CSS 变量 --cc-input-offset-top / --cc-input-margin-x，不是表内 gap。',
  }),
  widgetGroup({
    id: 'model',
    type: 'widget',
    label: '模型',
    category: 'runtime',
    rail: 'builtin',
    anchor: 'cc-surface',
    side: '底部区域',
    gap: 0,
    draggable: true,
    alwaysVisibleInActiveSession: true,
    hiddenInEmptyState: true,
    defaultPlacement: { slot: 'status-secondary', order: 2, offsetX: 0, offsetY: 0 },
    propertyFields: [
      { kind: 'section', title: '模型控件' },
      {
        kind: 'chips', key: 'modelSwitchMode', label: '模型切换方式',
        options: [
          { value: 'menu', label: '弹菜单' },
          { value: 'cycle', label: '点击轮换' },
        ],
      },
      { kind: 'chips', key: 'modelBgColor', label: '模型背景色', options: [{ value: 'white', label: '白' }, { value: 'black', label: '黑' }] },
      { kind: 'number', key: 'modelWidth', label: '模型宽度', min: 40, max: 400, step: 1 },
      { kind: 'number', key: 'modelHeight', label: '模型高度', min: 16, max: 80, step: 1 },
      { kind: 'number', key: 'modelRadius', label: '模型圆角', min: 0, max: 40, step: 1 },
      { kind: 'number', key: 'modelFontSize', label: '模型字号', min: 8, max: 32, step: 1 },
      { kind: 'chips', key: 'modelTextColor', label: '模型文字颜色', options: [{ value: 'black', label: '黑' }, { value: 'white', label: '白' }] },
    ],
    members: [
      {
        id: 'trigger',
        label: '模型触发器',
        fields: ['modelSwitchMode', 'modelBgColor', 'modelWidth', 'modelHeight', 'modelRadius', 'modelFontSize', 'modelTextColor'],
        visibility: { kind: 'always' },
      },
      { id: 'menu', label: '模型菜单', fields: [], visibility: { kind: 'content' } },
    ],
  }),
  widgetGroup({
    id: 'reasoning',
    type: 'widget',
    label: '思考强度',
    category: 'runtime',
    rail: 'builtin',
    anchor: 'cc-surface',
    side: '底部区域',
    gap: 12,
    draggable: true,
    alwaysVisibleInActiveSession: true,
    hiddenInEmptyState: true,
    defaultPlacement: { slot: 'status-secondary', order: 3, offsetX: 0, offsetY: 0 },
    propertyFields: [
      { kind: 'section', title: '思考强度控件' },
      { kind: 'chips', key: 'reasoningSwitchMode', label: '切换方式', options: [{ value: 'menu', label: '弹菜单' }, { value: 'cycle', label: '点击轮换' }] },
      { kind: 'chips', key: 'reasoningBgColor', label: '背景色', options: [{ value: 'white', label: '白' }, { value: 'black', label: '黑' }] },
      { kind: 'number', key: 'reasoningWidth', label: '宽度', min: 40, max: 400, step: 1 },
      { kind: 'number', key: 'reasoningHeight', label: '高度', min: 16, max: 80, step: 1 },
      { kind: 'number', key: 'reasoningRadius', label: '圆角', min: 0, max: 40, step: 1 },
      { kind: 'number', key: 'reasoningFontSize', label: '字号', min: 8, max: 32, step: 1 },
      { kind: 'chips', key: 'reasoningTextColor', label: '文字颜色', options: [{ value: 'black', label: '黑' }, { value: 'white', label: '白' }] },
    ],
    members: [
      {
        id: 'trigger',
        label: '思考强度触发器',
        fields: ['reasoningSwitchMode', 'reasoningBgColor', 'reasoningWidth', 'reasoningHeight', 'reasoningRadius', 'reasoningFontSize', 'reasoningTextColor'],
        visibility: { kind: 'always' },
      },
      { id: 'menu', label: '思考强度菜单', fields: [], visibility: { kind: 'content' } },
    ],
    note: 'gap=12 现状由控件内的 REASONING_GAP_PX 施加（本刀只记值不消费）。',
  }),
  widgetGroup({
    id: 'mode',
    type: 'widget',
    label: '权限模式',
    category: 'runtime',
    rail: 'builtin',
    anchor: 'cc-surface',
    side: '底部区域',
    gap: 12,
    draggable: true,
    alwaysVisibleInActiveSession: true,
    hiddenInEmptyState: true,
    defaultPlacement: { slot: 'status-secondary', order: 4, offsetX: 0, offsetY: 0 },
    propertyFields: [
      { kind: 'section', title: '权限控件' },
      { kind: 'chips', key: 'permissionSwitchMode', label: '切换方式', options: [{ value: 'menu', label: '弹菜单' }, { value: 'cycle', label: '点击轮换' }] },
      { kind: 'chips', key: 'permissionBgColor', label: '背景色', options: [{ value: 'white', label: '白' }, { value: 'black', label: '黑' }] },
      { kind: 'number', key: 'permissionWidth', label: '宽度', min: 40, max: 400, step: 1 },
      { kind: 'number', key: 'permissionHeight', label: '高度', min: 16, max: 80, step: 1 },
      { kind: 'number', key: 'permissionRadius', label: '圆角', min: 0, max: 40, step: 1 },
      { kind: 'number', key: 'permissionFontSize', label: '字号', min: 8, max: 32, step: 1 },
      { kind: 'chips', key: 'permissionTextColor', label: '文字颜色', options: [{ value: 'mode', label: '跟模式' }, { value: 'black', label: '黑' }, { value: 'white', label: '白' }] },
    ],
    members: [
      {
        id: 'trigger',
        label: '权限触发器',
        fields: [
          'permissionSwitchMode', 'permissionBgColor', 'permissionWidth', 'permissionHeight',
          'permissionRadius', 'permissionFontSize', 'permissionTextColor', 'modeAutoColor', 'modeEditColor',
        ],
        visibility: { kind: 'always' },
        note: 'permissionTextColor = "mode" 时不写 inline color，交给 CSS [data-mode] 语义色。',
      },
      { id: 'menu', label: '权限菜单', fields: [], visibility: { kind: 'content' } },
    ],
    note: 'gap=12 现状由控件内的 PERMISSION_GAP_PX 施加（本刀只记值不消费）。',
  }),
  widgetGroup({
    id: 'tokens',
    type: 'widget',
    label: '用量',
    category: 'context',
    rail: 'builtin',
    anchor: 'cc-surface',
    side: '底部区域',
    gap: 0,
    draggable: true,
    alwaysVisibleInActiveSession: true,
    hiddenInEmptyState: true,
    defaultPlacement: { slot: 'status-secondary', order: 5, offsetX: 0, offsetY: 0 },
    propertyFields: [],
    members: [
      {
        id: 'pill',
        label: '用量胶囊',
        fields: ['pillText', 'prismOnColor'],
        visibility: { kind: 'always' },
        borrowsFrom: 'model',
        note: '★★ 自己没有外观字段，宽度/高度/圆角/字号/底色/文字色全部读 model 那一套 —— 显式化，不许留成暗耦合。',
      },
    ],
    note: '单件组：成员行即它自己（字段归属需要一个具名行，成员不进任何名单）。',
  }),
  widgetGroup({
    id: 'cc-command-hint',
    type: 'widget',
    label: '命令行提示',
    category: 'input',
    rail: 'builtin',
    anchor: 'cc-surface',
    side: '行尾（cli 时整行靠右）',
    gap: 0,
    // ★ 结构步必须为 false：渲染仍走 ControlCenter 的裸渲染 commandHint()，
    //   归位（删裸渲染 + 承担工具条 6→7）属内容步（规范 §11.7）。
    draggable: false,
    members: [
      {
        id: 'hint-line',
        label: '提示行',
        fields: ['cliHintMode'],
        visibility: { kind: 'field', field: 'inputMode', visibleWhen: ['cli'] },
      },
    ],
    note: '升格为正式控件的结构已完成（表里有行），但拖拽/工具条归位属内容步。',
  }),
  widgetGroup({
    id: 'cc-send-button',
    type: 'widget',
    label: '发送按钮',
    category: 'action',
    rail: 'registered',
    anchor: 'input',
    side: '右端（骑边）',
    draggable: true,
    hiddenInEmptyState: true,
    defaultPlacement: { slot: 'actions', order: 0, offsetX: 0, offsetY: 0 },
    members: [
      {
        id: 'button',
        label: '按钮本体',
        fields: ['inputSubmitButtonMode', 'sendButtonColor', 'sendButtonRadius', 'sendButtonBorderColor', 'sendVariant'],
        visibility: { kind: 'always' },
        note: 'sendVariant 是「能改没人读」的僵尸字段（规范 §11.3）：本刀照现状保留，只在表里标注。',
      },
      {
        id: 'icon',
        label: '图标层',
        fields: ['sendButtonIcon', 'sendButtonIconGenerating', 'sendButtonIconRound', 'sendButtonIconColor'],
        visibility: { kind: 'always' },
      },
    ],
    note: '间距由 CSS calc() 从 --cc-input-offset-top / --cc-input-margin-x 算出，不是表内 gap；外观字段在设置页编辑，属性面板只给布局四项。',
  }),
]

type CcWidgetGroupRow = (typeof CC_WIDGET_GROUPS)[number]
/** 表里全部行的 id（含容器与不可拖行） */
export type CcWidgetGroupId = CcWidgetGroupRow['id']

const GROUP_BY_ID: ReadonlyMap<string, CcWidgetGroupRow> = new Map(
  CC_WIDGET_GROUPS.map(row => [row.id as string, row] as const),
)

/** 按 id 取表里的行（测试与派生用；渲染主路径不查表） */
export function resolveCcWidgetGroup(id: string): CcWidgetGroupRow | undefined {
  return GROUP_BY_ID.get(id)
}

// ── 派生：名单 / 标签表 / 属性表单 ──

/** 内置轨控件 id（可落槽的内置渲染控件）。顺序 = 表序 */
export type CcWidgetId = Extract<
  CcWidgetGroupRow,
  { type: 'widget'; rail: 'builtin'; draggable: true }
>['id']

/** 注册轨里**占槽位**的控件 id（不占槽的组不许进来，如 `cc-surface`） */
export type CcRegisteredSlotId = Extract<
  CcWidgetGroupRow,
  { type: 'widget'; rail: 'registered'; draggable: true }
>['id']

/** 全部中控 widget id（含输入栏、模型、思考强度、权限、用量）。 */
export const CC_WIDGET_IDS: readonly CcWidgetId[] = CC_WIDGET_GROUPS
  .filter(row => row.type === 'widget' && row.rail === 'builtin' && row.draggable)
  .map(row => row.id) as readonly CcWidgetId[]

/** 注册轨里占槽位的控件 id（F1=A：legacy `send` 的槽位事实迁到这里）。 */
export const CC_REGISTERED_SLOT_IDS: readonly CcRegisteredSlotId[] = CC_WIDGET_GROUPS
  .filter(row => row.type === 'widget' && row.rail === 'registered' && row.draggable)
  .map(row => row.id) as readonly CcRegisteredSlotId[]

/** 状态区 widget（除 input 外全部计入中控最小高度约束）——由 id 列表派生，不平行维护 */
export const STATUS_WIDGET_IDS: readonly CcWidgetId[] = CC_WIDGET_IDS.filter(id => id !== 'input')

/**
 * 常态显示的状态控件（2026-09-14）——不受"活跃会话收起旧状态控件"影响。
 *
 * 背景：`showStatusSlots()` 原先只在空态或编辑模式放行状态行，目的是让活跃
 * 对话界面干净（旧控件多）。模型控件是每轮对话都要看的当前状态，不属于该类，
 * 故由表里的 `alwaysVisibleInActiveSession` 标出。渲染过滤（idsForSlot）与状态行门户
 * （statusRowContent）共用同一名单，保持单一真值。
 */
export const ALWAYS_VISIBLE_STATUS_WIDGET_IDS: readonly CcWidgetId[] = CC_WIDGET_GROUPS
  .filter(row => row.type === 'widget' && row.alwaysVisibleInActiveSession === true)
  .map(row => row.id) as readonly CcWidgetId[]

/**
 * 空态追加隐藏的控件（`hiddenWidgetIds()` 的唯一真值）。
 * `cc-send-button` 是注册轨 id（不是刀4 前的 legacy `send`）。
 */
export const EMPTY_STATE_HIDDEN_WIDGET_IDS: readonly CcWidgetGroupId[] = CC_WIDGET_GROUPS
  .filter(row => row.hiddenInEmptyState === true)
  .map(row => row.id)

/** 表里每行的中文名 —— 标签表唯一出处（ControlCenter 与 widgetCatalog 共用） */
export const CC_WIDGET_LABELS: Readonly<Record<CcWidgetGroupId, string>> = Object.freeze(
  Object.fromEntries(CC_WIDGET_GROUPS.map(row => [row.id as string, row.label])) as Record<CcWidgetGroupId, string>,
)

/** 属性表单唯一出处 = 表里每行的 `propertyFields`（按 id 索引，供既有消费点与目录派生用） */
export const WIDGET_PROPERTY_FIELDS: Record<CcWidgetId, WidgetPropertyForm> = Object.fromEntries(
  CC_WIDGET_IDS.map(id => [id, resolveCcWidgetGroup(id)?.propertyFields ?? []]),
) as Record<CcWidgetId, WidgetPropertyForm>

/**
 * 跨元件的系统字段：不属于任何单个组/成员的字段。
 *
 * - `ccLayout` / `ccHidden` / `ccScale`：三份名单本体（值为元件名，属布局状态）。
 * - `ccStatusFontSize` / `statusBg` / `statusBgImage` / `footerLayout`：原「信息行」名下的 4 项，
 *   作用面是**整条状态行**而非某个元件。其收尾（2 项僵尸废弃 / 字号收窄 / 底排布改由锚点表达）
 *   属 #238 内容步，本刀照现状保留。
 */
export const CC_SYSTEM_FIELDS = [
  'ccLayout', 'ccHidden', 'ccScale',
  'ccStatusFontSize', 'statusBg', 'statusBgImage', 'footerLayout',
] as const satisfies readonly ThemeFieldKey[]

export interface WidgetVisibilityCtx {
  hidden: readonly string[]
  inputMode: string
  submitButtonMode: string
  /** 编辑模式：全显（隐藏/模式互斥规则不生效） */
  editMode?: boolean
}

/**
 * widget 可见性单一真值（C2）：渲染（ControlCenter.renderWidget）与高度计数
 * （resolveVisibleStatusWidgetCount）消费同一谓词，杜绝"计数多算不渲染的 widget"。
 */
export function isWidgetVisible(id: string, ctx: WidgetVisibilityCtx): boolean {
  const edit = ctx.editMode === true
  if (!edit && ctx.hidden.includes(id)) return false
  return true
}
