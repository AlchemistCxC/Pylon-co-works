/**
 * widgetDefinitions — 中控 widget 单一真值（C1/C4）。
 *
 * widget id 列表/状态 widget 集合/属性表单 schema 派生自此处；ccLayoutState（CcWidgetId）、
 * widgetRegistry（渲染注册表）、ccHeightState（高度约束）、ControlCenter PropertyPanel
 * （属性表单）全部消费同一来源。
 * 新增 widget：此处加 id + widgetRenderers 补 renderer + propertyFields 补表单。
 */
import type { ThemeSettings } from '../../store.ts'

/** 全部中控 widget id（含输入栏、上下文、会话身份、运行态与动作按钮）。 */
export const CC_WIDGET_IDS = ['input', 'model', 'reasoning', 'mode', 'tokens'] as const
export type CcWidgetId = (typeof CC_WIDGET_IDS)[number]

/** 状态区 widget（除 input 外全部计入中控最小高度约束）——由 id 列表派生，不平行维护 */
export const STATUS_WIDGET_IDS: readonly CcWidgetId[] = CC_WIDGET_IDS.filter(id => id !== 'input')

// ── C4：属性表单 schema（PropertyPanel 由 registry 派生，消灭硬编码）──

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

/**
 * 每 widget 的属性表单（纯数据）。inputMode↔inputVariant 双写经 chips 的 sync 表达
 * （主键写 value 时同步写 sync.key），保持与 Settings 双写一致。
 */
export const WIDGET_PROPERTY_FIELDS: Record<CcWidgetId, readonly (WidgetPropertyField & WidgetPropertyDef)[]> = {
  input: [
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
  model: [
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
  reasoning: [
    { kind: 'section', title: '思考强度控件' },
    { kind: 'chips', key: 'reasoningSwitchMode', label: '切换方式', options: [{ value: 'menu', label: '弹菜单' }, { value: 'cycle', label: '点击轮换' }] },
    { kind: 'chips', key: 'reasoningBgColor', label: '背景色', options: [{ value: 'white', label: '白' }, { value: 'black', label: '黑' }] },
    { kind: 'number', key: 'reasoningWidth', label: '宽度', min: 40, max: 400, step: 1 },
    { kind: 'number', key: 'reasoningHeight', label: '高度', min: 16, max: 80, step: 1 },
    { kind: 'number', key: 'reasoningRadius', label: '圆角', min: 0, max: 40, step: 1 },
    { kind: 'number', key: 'reasoningFontSize', label: '字号', min: 8, max: 32, step: 1 },
    { kind: 'chips', key: 'reasoningTextColor', label: '文字颜色', options: [{ value: 'black', label: '黑' }, { value: 'white', label: '白' }] },
  ],
  mode: [
    { kind: 'section', title: '权限控件' },
    { kind: 'chips', key: 'permissionSwitchMode', label: '切换方式', options: [{ value: 'menu', label: '弹菜单' }, { value: 'cycle', label: '点击轮换' }] },
    { kind: 'chips', key: 'permissionBgColor', label: '背景色', options: [{ value: 'white', label: '白' }, { value: 'black', label: '黑' }] },
    { kind: 'number', key: 'permissionWidth', label: '宽度', min: 40, max: 400, step: 1 },
    { kind: 'number', key: 'permissionHeight', label: '高度', min: 16, max: 80, step: 1 },
    { kind: 'number', key: 'permissionRadius', label: '圆角', min: 0, max: 40, step: 1 },
    { kind: 'number', key: 'permissionFontSize', label: '字号', min: 8, max: 32, step: 1 },
    { kind: 'chips', key: 'permissionTextColor', label: '文字颜色', options: [{ value: 'mode', label: '跟模式' }, { value: 'black', label: '黑' }, { value: 'white', label: '白' }] },
  ],
  tokens: [],
}

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
