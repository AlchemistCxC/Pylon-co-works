/**
 * widgetDefinitions — 中控 widget 单一真值（C1/C4）。
 *
 * widget id 列表/状态 widget 集合/属性表单 schema 派生自此处；ccLayoutState（CcWidgetId）、
 * widgetRegistry（渲染注册表）、ccHeightState（高度约束）、ControlCenter PropertyPanel
 * （属性表单）全部消费同一来源。
 * 新增 widget：此处加 id + widgetRenderers 补 renderer + propertyFields 补表单。
 */
import type { ThemeSettings } from '../../store.ts'

/** 全部中控 widget id（9 个，含输入栏/动作按钮/任务 pill） */
export const CC_WIDGET_IDS = ['input', 'ekg', 'pct', 'tokens', 'model', 'mode', 'send', 'attach', 'tasks'] as const
export type CcWidgetId = (typeof CC_WIDGET_IDS)[number]

/** 状态区 widget（除 input 外全部计入中控最小高度约束）——由 id 列表派生，不平行维护 */
export const STATUS_WIDGET_IDS: readonly CcWidgetId[] = CC_WIDGET_IDS.filter(id => id !== 'input')

// ── C4：属性表单 schema（PropertyPanel 由 registry 派生，消灭硬编码）──

export type WidgetPropertyField =
  | { kind: 'section'; title: string }
  | { kind: 'color'; key: keyof ThemeSettings; label: string }
  | { kind: 'number'; key: keyof ThemeSettings; label: string; min: number; max: number; step?: number; suffix?: string }
  | {
      kind: 'chips'
      key: keyof ThemeSettings
      label: string
      options: { value: string; label: string; sync?: { key: keyof ThemeSettings; value: string } }[]
    }
  | { kind: 'chipsBool'; key: keyof ThemeSettings; label: string; trueLabel: string; falseLabel: string }

export interface WidgetPropertyDef {
  /** 条件显示（cli 字段只在 inputMode==='cli'、ekg 三色只在 wave 等） */
  showIf?: (theme: ThemeSettings) => boolean
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
    { kind: 'number', key: 'inputFontSize', label: '字号', min: 12, max: 22, step: 0.1 },
    { kind: 'number', key: 'inputMinHeight', label: '最小高', min: 36, max: 120, step: 0.1 },
    {
      kind: 'chips', key: 'inputMode', label: '模式',
      options: [
        { value: 'default', label: '默认', sync: { key: 'inputVariant', value: 'composer' } },
        { value: 'cli', label: 'CLI', sync: { key: 'inputVariant', value: 'cli' } },
      ],
    },
    { kind: 'number', key: 'cliLineWidth', label: '线宽', min: 1, max: 6, step: 0.1, showIf: t => t.inputMode === 'cli' },
    { kind: 'color', key: 'cliLineColor', label: '线色', showIf: t => t.inputMode === 'cli' },
    { kind: 'number', key: 'cliLinePadding', label: '行距', min: 0, max: 24, step: 0.1, showIf: t => t.inputMode === 'cli' },
  ],
  ekg: [
    { kind: 'section', title: '用量条显示' },
    {
      kind: 'chips', key: 'ccStyle', label: '仪表类型',
      options: [
        { value: 'wave', label: '心电图' },
        { value: 'bar', label: '柱状' },
        { value: 'ring', label: '环形' },
        { value: 'numeric', label: '数值' },
      ],
    },
    { kind: 'number', key: 'ekgWidth', label: '宽度', min: 80, max: 400, step: 0.1 },
    { kind: 'color', key: 'ekgGreen', label: '绿色', showIf: t => t.ccStyle === 'wave' },
    { kind: 'color', key: 'ekgYellow', label: '黄色', showIf: t => t.ccStyle === 'wave' },
    { kind: 'color', key: 'ekgRed', label: '红色', showIf: t => t.ccStyle === 'wave' },
    { kind: 'color', key: 'barTrackColor', label: '外壳背景', showIf: t => t.ccStyle === 'bar' },
    { kind: 'number', key: 'barHeight', label: '高度', min: 4, max: 40, step: 0.1, showIf: t => t.ccStyle === 'bar' },
    { kind: 'chipsBool', key: 'barFillFollow', label: '柱子跟随用量', trueLabel: '三段色', falseLabel: '固定色', showIf: t => t.ccStyle === 'bar' },
    { kind: 'color', key: 'barFillColor', label: '柱子颜色', showIf: t => t.ccStyle === 'bar' && t.barFillFollow === false },
  ],
  model: [
    { kind: 'section', title: '模型控件外观' },
    {
      kind: 'chips', key: 'modelVariant', label: '外观风格',
      options: [
        { value: 'dropdown', label: '下拉' },
        { value: 'minimal', label: '简洁' },
        { value: 'badge', label: '徽章' },
      ],
    },
  ],
  mode: [
    { kind: 'section', title: '模式控件外观' },
    {
      kind: 'chips', key: 'modeVariant', label: '外观风格',
      options: [
        { value: 'pill', label: '胶囊' },
        { value: 'badge', label: '方括号' },
        { value: 'minimal', label: '极简' },
      ],
    },
  ],
  send: [
    { kind: 'section', title: '发送按钮外观' },
    {
      kind: 'chips', key: 'sendVariant', label: '外观风格',
      options: [
        { value: 'icon', label: '圆形' },
        { value: 'square', label: '方形' },
        { value: 'minimal', label: '极简' },
      ],
    },
  ],
  attach: [
    { kind: 'section', title: '附件按钮外观' },
    {
      kind: 'chips', key: 'attachVariant', label: '外观风格',
      options: [
        { value: 'icon', label: '圆形' },
        { value: 'square', label: '方形' },
        { value: 'minimal', label: '极简' },
      ],
    },
  ],
  pct: [],
  tokens: [],
  tasks: [],
}

export interface WidgetVisibilityCtx {
  hidden: readonly string[]
  inputMode: string
  submitButtonMode: string
  ccStyle: string
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
  // numeric 由 pct 表达；ring 由用量 widget 表达，避免重复上下文百分比
  if (!edit && ctx.ccStyle === 'numeric' && id === 'ekg' && !ctx.hidden.includes('pct')) return false
  if (!edit && ctx.ccStyle === 'ring' && id === 'pct' && !ctx.hidden.includes('ekg')) return false
  // 独立 send/attach widget 仅在"外部按钮模式"下渲染；CLI/内联模式走 InputBar 自带按钮
  if (id === 'send' || id === 'attach') {
    if (!edit && !isExternalSubmitMode(ctx)) return false
  }
  return true
}

/**
 * 外部按钮模式（send/attach 独立 widget 渲染的前提）：非 CLI + submitButtonMode=external。
 * 单一真值：isWidgetVisible 与 ControlCenter 的 InputBar externalSend/externalAttach 传参
 * 共同消费，改判定一处即可。
 */
export function isExternalSubmitMode(ctx: Pick<WidgetVisibilityCtx, 'inputMode' | 'submitButtonMode'>): boolean {
  return ctx.inputMode !== 'cli' && ctx.submitButtonMode === 'external'
}
