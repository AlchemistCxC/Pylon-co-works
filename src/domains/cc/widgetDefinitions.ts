/**
 * widgetDefinitions — 中控元件两级定义表（组 + 成员）单一真值。
 *
 * 表形（issue #238 刀1 立表 / 刀3 起位置改两轴）：
 * - **组**：可摆、可藏的单元 —— 表里 `draggable` 的行才进
 *   `ccLayout` / `ccHidden` 两份名单（刀7 起缩放已删，原第三份 `ccScale` 退场）。共 8 行 = 控件 7 + 容器 1（`cc-surface`）。
 * - **成员**：组里一个有名字的部件 + 它自己那组字段 —— **只做归属**，不进任何名单。
 * - ★ **位置**（刀3）：每行自己声明 `layout: { x: {锚点, 方位, 间距?}, y: {…}, order }`
 *   —— 不再有「先分槽、再在槽里排序」两段式。渲染按**落脚处**（`ccWidgetLanding` =
 *   `(y.anchor, y.side)`）自动成组，组内按 `order` 排。声明为 `floating` 的行不进文档流。
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
 * ★ 间距：两个轴上的「贴边间距」写在 `layout.x/y.gap`；**同落脚处内的前置间距**用行级 `gap`
 * （思考强度 / 权限各 12px，就是控件里原先硬编码的那两个常量；#238 刀3 起由控件读表）。
 *
 * ★ 中文名一律**照抄现状**（渲染出来的字逐字相同）：`cc-surface` 的现状字面量是
 * 「中控本体背景板」（骨架 §2 单元格写作「中控本体」，按其 §4 栏位字典「中文名照抄现状」
 * 取现状值）；`mode` 同理取「权限模式」而非骨架里的「权限」。
 * 新增 widget：此处加一行 + `widgetRenderers` 补 renderer + 该行的 `propertyFields` 补表单。
 */
import type { ThemeSettings } from '../../store.ts'
import type { ThemeFieldKey } from '../../themeFieldDefs.ts'

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
  /**
   * ★ #238 刀6：这里**不再有 `fields`** —— 字段归属的**唯一真值 = 每个字段自己身上的 `group`**
   * （值就是本成员的 `label`；用户口径「归属放在字段」）。
   * 派生视图见 `themeFieldDefs.ts` 的 `CC_MEMBER_FIELDS` —— 那是唯一能同时看见两边的地方；
   * 本表若自己算就得运行时 import `themeFieldDefs.ts`，正是表头写明的「头号雷」（成环、症状静默）。
   * ⇒ 加字段时只改两处：字段定义（`group` 写本成员的中文名）+ 本表（若新增子部件行）。
   */
  visibility: CcMemberVisibility
  /** 外观字段**借用**另一行（用量借模型）——显式化隐式耦合，不留暗线（规范 §5.3） */
  borrowsFrom?: string
  note?: string
}

// ── 组层 ──

/** x 轴方位（`stretch` = 两侧都贴、撑满；`center` = 贴中线） */
export type CcAxisX = 'left' | 'right' | 'center' | 'stretch'
/** y 轴方位（`stretch` = 上下都贴、撑满；`center` = 贴中线） */
export type CcAxisY = 'top' | 'bottom' | 'center' | 'stretch'

export interface CcPlacementX {
  /** 贴谁（指向表内 id，或最外的容器 `cc-surface`） */
  readonly anchor: string
  readonly side: CcAxisX
  /** 与该边之间的间距（★ 数值来源见各行的 note；缺省 = 由既有 CSS 变量提供） */
  readonly gap?: number
}

export interface CcPlacementY {
  readonly anchor: string
  readonly side: CcAxisY
  readonly gap?: number
}

/**
 * ★★ 位置（#238 刀3）：**两轴各声明一次「贴着谁」**，取代原来的「槽位 + 行内序」两段式。
 * `order` = 同一**落脚处**（`(y.anchor, y.side)`，见 `ccWidgetLanding`）组内的次序。
 */
export interface CcWidgetLayout {
  readonly x: CcPlacementX
  readonly y: CcPlacementY
  readonly order: number
}

/**
 * `align` 简写：两轴共用同一锚点（各自再细化 `side` / `gap`）。
 * 例：发送按钮 `alignLayout('input', { x: { side: 'right' }, y: { side: 'center' }, order: 1 })`
 * —— 贴输入栏、右边 + 中线。
 */
export function alignLayout(
  anchor: string,
  spec: { x: { side: CcAxisX; gap?: number }; y: { side: CcAxisY; gap?: number }; order: number },
): CcWidgetLayout {
  return {
    x: { anchor, side: spec.x.side, ...(spec.x.gap === undefined ? {} : { gap: spec.x.gap }) },
    y: { anchor, side: spec.y.side, ...(spec.y.gap === undefined ? {} : { gap: spec.y.gap }) },
    order: spec.order,
  }
}

/**
 * 运行期**状态检测条件**（#238 刀5B；条件表见文件末 `CC_VISIBILITY_CONDITIONS`）。
 *
 * ★ 为什么不做成「三档枚举」：工况只会增加。新增一种工况 = **往条件表加一行** + 需要它的行引用它，
 * 不动任何行的枚举值、也不动判定顺序（用户口径：「三档还是局限……万一以后不止有这三种工况呢？」）。
 */
export type CcVisibilityCondition = 'has-session' | 'cli-mode' | 'hint-visible'

export interface CcWidgetGroup {
  id: string
  /** 容器 = 不可拖、不占槽、承载外观项、可作锚点；控件 = 可拖、有成员、挂在锚点上 */
  type: 'widget' | 'container'
  label: string
  category: string
  /** 渲染轨：`builtin` = 内置渲染器；`registered` = 注册轨（宿主渲染，经 ccWidgetRegistry） */
  rail: 'builtin' | 'registered'
  /** ★ 位置声明（两轴）；最外的容器 `cc-surface` 无此项（它是所有锚点的终点） */
  layout?: CcWidgetLayout
  /**
   * ★ **同落脚处内的前置间距**（与同组前一个元件之间的距离，落在元件自己身上）。
   * 现状：思考强度 / 权限各 12px（原先硬编码在控件里的 `REASONING_GAP_PX` / `PERMISSION_GAP_PX`，
   * #238 刀3 起由控件读本值）。两轴上的「贴边间距」不走这里，走 `layout.x/y.gap`。
   */
  gap?: number
  /** ★ 声明为**悬浮**（不参与文档流成组；占区叠加约束对它豁免，见刀4） */
  floating?: boolean
  /** 是否进 `ccLayout` / `ccHidden` 两份名单 */
  draggable: boolean
  /**
   * ★ **活跃会话里显示还是收起**（#238 刀5B）—— 只有两个值，缺省 `'hide'`（= 活跃会话里收起）。
   * 与 `conditions` 是**两件正交的事**：本项答"活跃会话里要不要"，`conditions` 答"运行期满不满足"。
   */
  inActiveSession?: 'show' | 'hide'
  /**
   * ★ 附带的**运行期状态检测**（可多选，**全部满足**才可见）。与 `inActiveSession` 正交。
   * 例：命令行提示要"有会话 + 命令行模式 + 详细档不是 hidden"三条同时成立。
   */
  conditions?: readonly CcVisibilityCondition[]
  /** 空态隐藏（派生 `EMPTY_STATE_HIDDEN_WIDGET_IDS`） */
  hiddenInEmptyState?: boolean
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
        visibility: { kind: 'always' },
      },
    ],
    note: '最外的容器：不参与排布（所有其它行的锚点终点）、不可拖不可藏（其值在设置页编辑）。★ `footerLayout` 由 #238 刀3 从「跨元件系统字段」桶转入本行（只做**归属转移**：字段与 peri/free 两种实现都不动）。',
  }),
  widgetGroup({
    id: 'input',
    type: 'widget',
    label: '输入栏',
    category: 'input',
    rail: 'builtin',
    layout: { x: { anchor: 'cc-surface', side: 'stretch' }, y: { anchor: 'cc-surface', side: 'top' }, order: 0 },
    draggable: true,
    // ★ 输入栏在活跃会话里**一直显示**（#238 刀5B 之前由门户里的 `id === 'input'` 特例承担）。
    //   写进表里让「活跃会话显隐」这条轴**对每一行都成立**，不必再留硬编码豁免。
    inActiveSession: 'show',
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
        visibility: { kind: 'always' },
      },
      {
        id: 'cli-prefix',
        label: '提示符 ❯',
        visibility: { kind: 'field', field: 'inputMode', visibleWhen: ['cli'] },
      },
      {
        id: 'cli-lines',
        label: '上下两条线',
        visibility: { kind: 'field', field: 'inputMode', visibleWhen: ['cli'] },
        note: '三个字段都带 showIf: inputMode === "cli"。',
      },
      { id: 'command-palette', label: '/ 命令菜单', visibility: { kind: 'content' } },
      {
        id: 'history-hint',
        label: '历史快捷提示',
        visibility: { kind: 'field', field: 'inputShowHistoryHint', visibleWhen: ['shown', true] },
      },
      { id: 'prediction', label: '输入预测', visibility: { kind: 'content' } },
      { id: 'queue', label: '待发送队列', visibility: { kind: 'content' } },
      { id: 'error', label: '报错条', visibility: { kind: 'content' } },
      { id: 'empty-slot', label: '空态插槽', visibility: { kind: 'host' } },
    ],
    note: '间距不写死在表里：横向上/纵向上的实际数值由既有的两个 CSS 变量提供（`--cc-input-margin-x` = 输入栏左右间距、`--cc-input-offset-top` = 输入栏上间距，都是设置页字段），`x.side=stretch` + `y.side=top` 描述的就是它们。peri 下由 `.cc-footer-peri` 让它回到文档流当第一个，free 下由绝对定位浮起 —— 这套差值仍在 CSS 里（本刀不动）。',
  }),
  widgetGroup({
    id: 'model',
    type: 'widget',
    label: '模型',
    category: 'runtime',
    rail: 'builtin',
    layout: { x: { anchor: 'cc-surface', side: 'left' }, y: { anchor: 'cc-surface', side: 'bottom' }, order: 2 },
    gap: 0,
    draggable: true,
    inActiveSession: 'show',
    hiddenInEmptyState: true,
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
        visibility: { kind: 'always' },
      },
      { id: 'menu', label: '模型菜单', visibility: { kind: 'content' } },
    ],
  }),
  widgetGroup({
    id: 'reasoning',
    type: 'widget',
    label: '思考强度',
    category: 'runtime',
    rail: 'builtin',
    layout: { x: { anchor: 'cc-surface', side: 'left' }, y: { anchor: 'cc-surface', side: 'bottom' }, order: 3 },
    gap: 12,
    draggable: true,
    inActiveSession: 'show',
    hiddenInEmptyState: true,
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
        visibility: { kind: 'always' },
      },
      { id: 'menu', label: '思考强度菜单', visibility: { kind: 'content' } },
    ],
    note: 'gap=12 现状由控件内的 REASONING_GAP_PX 施加（本刀只记值不消费）。',
  }),
  widgetGroup({
    id: 'mode',
    type: 'widget',
    label: '权限模式',
    category: 'runtime',
    rail: 'builtin',
    layout: { x: { anchor: 'cc-surface', side: 'left' }, y: { anchor: 'cc-surface', side: 'bottom' }, order: 4 },
    gap: 12,
    draggable: true,
    inActiveSession: 'show',
    hiddenInEmptyState: true,
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
        visibility: { kind: 'always' },
        note: 'permissionTextColor = "mode" 时不写 inline color，交给 CSS [data-mode] 语义色。',
      },
      { id: 'menu', label: '权限菜单', visibility: { kind: 'content' } },
    ],
    note: 'gap=12 现状由控件内的 PERMISSION_GAP_PX 施加（本刀只记值不消费）。',
  }),
  widgetGroup({
    id: 'tokens',
    type: 'widget',
    label: '用量',
    category: 'context',
    rail: 'builtin',
    layout: { x: { anchor: 'cc-surface', side: 'left' }, y: { anchor: 'cc-surface', side: 'bottom' }, order: 5 },
    gap: 0,
    draggable: true,
    inActiveSession: 'show',
    hiddenInEmptyState: true,
    propertyFields: [],
    members: [
      {
        id: 'pill',
        label: '用量胶囊',
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
    layout: { x: { anchor: 'cc-surface', side: 'left' }, y: { anchor: 'cc-surface', side: 'bottom' }, order: 5 },
    gap: 0,
    draggable: true,
    // ★ 显示条件是**另一类**（有会话 + 命令行模式 + 详细档不为 hidden）⇒ 用 `conditions` 表达，
    //   不用「三档枚举」。★ 少了 `inActiveSession: 'show'` 这一条，升格后它会在活跃会话里
    //   被状态行门户滤掉（刀5A 实测过的"不出现"）——所以它与常态放行的四个元件同列。
    inActiveSession: 'show',
    conditions: ['has-session', 'cli-mode', 'hint-visible'],
    members: [
      {
        id: 'hint-line',
        label: '提示行',
        visibility: { kind: 'field', field: 'inputMode', visibleWhen: ['cli'] },
      },
    ],
    note: '★ #238 刀5B：已升格为**普通行内元件**（有多宽占多宽）—— 不再是裸渲染、也不再整行特化；进编辑工具条、受占区约束、也当障碍。',
  }),
  widgetGroup({
    id: 'cc-send-button',
    type: 'widget',
    label: '发送按钮',
    category: 'action',
    rail: 'registered',
    // ★ 悬浮声明：它一直是绝对定位的悬浮件（骑在输入栏右端），不进文档流成组；
    //   占区叠加约束对它豁免（刀4）。`alignLayout('input', …)` = 贴输入栏、右边 + 中线。
    layout: alignLayout('input', { x: { side: 'right' }, y: { side: 'center' }, order: 0 }),
    floating: true,
    draggable: true,
    // ★ 它在活跃会话里确实显示（受 `inputSubmitButtonMode` 与 `ccHidden` 管），故据实声明；
    //   它的渲染目前走单独一行、不经过 `isWidgetVisible`，本项是为"声明与事实一致"而写。
    inActiveSession: 'show',
    hiddenInEmptyState: true,
    members: [
      {
        id: 'button',
        label: '按钮本体',
        visibility: { kind: 'always' },
        note: 'sendVariant 是「能改没人读」的僵尸字段（规范 §11.3）：本刀照现状保留，只在表里标注。',
      },
      {
        id: 'icon',
        label: '图标层',
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

/**
 * ★ 落脚处（#238 刀3）：**同一 `(y.anchor, y.side)` 的元件归入同一个容器**，组内按 `order` 排。
 * 取代原来的三份槽位包装 div（`.cc-status-primary/-secondary/.cc-actions`）。
 * 返回 `undefined` = 该行不参与排布（容器 `cc-surface`，或缺 `layout` 的行）。
 */
export function ccWidgetLanding(id: string): string | undefined {
  const layout = resolveCcWidgetGroup(id)?.layout
  return layout ? `${layout.y.anchor}:${layout.y.side}` : undefined
}

/** 声明为**悬浮**的行（不进文档流成组；占区叠加约束豁免，见刀4） */
export const CC_FLOATING_WIDGET_IDS: readonly string[] = CC_WIDGET_GROUPS
  .filter(row => row.floating === true)
  .map(row => row.id as string)

/**
 * ★ **输入栏落脚处独占守卫**（#238 刀3）——原 `input` 槽「只允许输入栏」规则的替代。
 *
 * 槽位层拆掉后，「元件落在哪个容器」完全由定义表声明；拖拽只改 `offset`/`order`、
 * 改不了归属，所以老问题（「别的元件挪进输入栏 → 槽位过滤把它剔掉 → 控件凭空消失」）
 * 的**新形式**是「表被改坏 / 将来允许改锚点 ⇒ 非输入栏落在输入栏容器里被拉伸」。
 * 判据：凡声明落在输入栏落脚处、自己却不是输入栏的，**退回默认信息落脚处**
 * —— 宁可换位置，也不让它凭空消失。
 */
export function coerceInputLanding(id: string, declaredLanding: string | undefined): string | undefined {
  const inputLanding = ccWidgetLanding('input')
  if (declaredLanding !== inputLanding) return declaredLanding
  return id === 'input' ? declaredLanding : ccWidgetLanding('model')
}

/** 表自身的输入栏落脚处违规项（空 = 合规；渲染层与测试共用同一判据） */
export function ccInputLandingViolations(ids: readonly string[]): string[] {
  return ids.filter(id => coerceInputLanding(id, ccWidgetLanding(id)) !== ccWidgetLanding(id))
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
 * 对话界面干净（旧控件多）。模型等每轮对话都要看的当前状态，不属于该类，
 * 故由表里的 `inActiveSession: 'show'` 标出。渲染过滤（`idsForLanding`）与状态行门户
 * （`statusRowContent`）共用同一名单，保持单一真值。
 *
 * ★ #238 刀5B：来源布尔 `alwaysVisibleInActiveSession` 换成两值字段 `inActiveSession`；
 *   名单口径不变（**状态控件**里"活跃会话里也放行"的那些）⇒ 仍从 `STATUS_WIDGET_IDS` 收，
 *   输入栏天然不在其中（它是常驻件，不进"状态控件"这个概念）。
 *   ★ 命令行提示本刀起也标 `'show'`（它要能在活跃会话里显示，否则会被门户滤掉）
 *   ⇒ 名单由 4 条变 5 条，这是**预期变化**。
 */
export const ALWAYS_VISIBLE_STATUS_WIDGET_IDS: readonly CcWidgetId[] = STATUS_WIDGET_IDS
  .filter(id => resolveCcWidgetGroup(id)?.inActiveSession === 'show')

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
 * - `ccLayout` / `ccHidden`：两份名单本体（值为元件名，属布局状态）。
 *   ★ 刀5 后「信息行」名下那三项（`ccStatusFontSize` / `statusBg` / `statusBgImage`）已**删除**
 *   （前两项是僵尸，第三项的字号收窄成 `cc-command-hint` 成员自己的 `ccHintFontSize`）；
 *   `footerLayout` 已由刀3 移入容器行 `cc-surface`；
 *   ★ 刀7：`ccScale`（缩放）已**整体删除**（用户口径「我预期里没有缩放这一项」）⇒ 名单由三份变两份。
 */
export const CC_SYSTEM_FIELDS = [
  'ccLayout', 'ccHidden',
] as const satisfies readonly ThemeFieldKey[]

export interface WidgetVisibilityCtx {
  hidden: readonly string[]
  inputMode: string
  submitButtonMode: string
  /** 编辑模式：全显（隐藏/模式互斥规则不生效） */
  editMode?: boolean
  /** 当前是否处于**活跃会话**（`conditions` 的 `'has-session'` 用；缺省 = 未知） */
  hasSession?: boolean
  /** 命令行提示的详细档（`conditions` 的 `'hint-visible'` 用；缺省 = 未知） */
  hintMode?: string
}

/**
 * ★ 运行期状态检测条件表（#238 刀5B）——**一行一个纯函数**，全部满足该行才可见。
 * 新增工况只在这里加一行；哪一行需要它就在那行的 `conditions` 里写上名字。
 */
const CC_VISIBILITY_CONDITIONS: Record<CcVisibilityCondition, (ctx: WidgetVisibilityCtx) => boolean> = {
  'has-session': ctx => ctx.hasSession === true,
  'cli-mode': ctx => ctx.inputMode === 'cli',
  'hint-visible': ctx => ctx.hintMode !== 'hidden',
}

/**
 * widget 可见性单一真值（C2）：渲染（ControlCenter.renderWidget）与高度计数
 * （resolveVisibleStatusWidgetCount）消费同一谓词，杜绝"计数多算不渲染的 widget"。
 *
 * ★ 判定顺序（#238 刀5B）——**按序，全部满足才可见**：
 * 1. 用户显隐 `ccHidden`（**编辑态豁免**：编辑时要把藏起来的元件露出来才好操作）；
 * 2. `inActiveSession`（活跃会话里显/隐；**编辑态同样豁免**，与门户里"编辑态全显"一致）；
 * 3. `conditions`（运行期状态检测）。★ **不豁免编辑态** —— 与升格前的裸渲染条件一致
 *    （那时没会话/非命令行模式下，编辑态也看不到提示）。
 */
export function isWidgetVisible(id: string, ctx: WidgetVisibilityCtx): boolean {
  const edit = ctx.editMode === true
  if (!edit && ctx.hidden.includes(id)) return false
  const row = resolveCcWidgetGroup(id)
  if (!edit && (row?.inActiveSession ?? 'hide') !== 'show' && ctx.hasSession === true) return false
  for (const condition of row?.conditions ?? []) {
    if (!CC_VISIBILITY_CONDITIONS[condition](ctx)) return false
  }
  return true
}
