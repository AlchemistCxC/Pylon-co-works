/**
 * widgetDefinitions — 中控 widget 单一真值（C1）。
 *
 * widget id 列表/状态 widget 集合派生自此处；ccLayoutState（CcWidgetId）、
 * widgetRegistry（渲染注册表）、ccHeightState（高度约束）全部消费同一来源。
 * 新增 widget：此处加 id + widgetRenderers 补 renderer（C 阶段类型保证覆盖）。
 */

/** 全部中控 widget id（8 个，含输入栏/动作按钮） */
export const CC_WIDGET_IDS = ['input', 'ekg', 'pct', 'tokens', 'model', 'mode', 'send', 'attach'] as const
export type CcWidgetId = (typeof CC_WIDGET_IDS)[number]

/** 状态区 widget（除 input 外全部计入中控最小高度约束）——由 id 列表派生，不平行维护 */
export const STATUS_WIDGET_IDS: readonly CcWidgetId[] = CC_WIDGET_IDS.filter(id => id !== 'input')

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
    const externalBtnMode = ctx.inputMode !== 'cli' && ctx.submitButtonMode === 'external'
    if (!edit && !externalBtnMode) return false
  }
  return true
}
