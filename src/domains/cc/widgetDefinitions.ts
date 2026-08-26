/**
 * widgetDefinitions — 中控 widget 单一真值（C1/C4）。
 *
 * widget id 列表/状态 widget 集合/属性表单 schema 派生自此处；ccLayoutState（CcWidgetId）、
 * widgetRegistry（渲染注册表）、ccHeightState（高度约束）、ControlCenter PropertyPanel
 * （属性表单）全部消费同一来源。
 * 新增 widget：此处加 id + widgetRenderers 补 renderer + propertyFields 补表单。
 */
import type { ThemeSettings } from '../../store.ts'

export {
  BUILTIN_CC_WIDGET_CONTRIBUTIONS,
  CC_WIDGET_IDS,
  CC_WIDGET_LABELS,
  STATUS_WIDGET_IDS,
  WIDGET_PROPERTY_FIELDS,
} from './widgetCatalog.ts'
export type { BuiltinCcWidgetId, CcWidgetId, CcWidgetRuntimeId, CcWidgetRenderSpec } from './widgetCatalog.ts'

// ── C4：属性表单 schema（PropertyPanel 由 registry 派生，消灭硬编码）──

export type CcColorPropertyKey = 'inputBg' | 'inputTextColor' | 'cliLineColor' | 'ekgGreen' | 'ekgYellow' | 'ekgRed' | 'barTrackColor' | 'barFillColor'
export type CcNumberPropertyKey = 'inputFontSize' | 'inputMinHeight' | 'cliLineWidth' | 'cliLinePadding' | 'ekgWidth' | 'barHeight'
export type CcStringPropertyKey = 'inputMode' | 'inputVariant' | 'ccStyle' | 'modelVariant' | 'modeVariant' | 'sendVariant' | 'attachVariant'
export type CcBooleanPropertyKey = 'barFillFollow'
export type CcEditablePropertyKey = CcColorPropertyKey | CcNumberPropertyKey | CcStringPropertyKey | CcBooleanPropertyKey

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
  | { kind: 'chipsBool'; key: CcBooleanPropertyKey; label: string; trueLabel: string; falseLabel: string }

export type CcPropertyCommand =
  | { readonly type: 'set-cc-property'; readonly key: CcColorPropertyKey | CcStringPropertyKey; readonly value: string }
  | { readonly type: 'set-cc-property'; readonly key: CcNumberPropertyKey; readonly value: number }
  | { readonly type: 'set-cc-property'; readonly key: CcBooleanPropertyKey; readonly value: boolean }

export type WidgetPropertyVisibilityContext = Pick<ThemeSettings, 'inputMode' | 'ccStyle' | 'barFillFollow'>

export interface WidgetPropertyDef {
  /** 条件显示（cli 字段只在 inputMode==='cli'、ekg 三色只在 wave 等） */
  showIf?: (theme: WidgetPropertyVisibilityContext) => boolean
}

export interface WidgetVisibilityCtx {
  hidden: readonly string[]
  inputMode: string
  submitButtonMode: string
  ccStyle: string
  /** 编辑模式：全显（隐藏/模式互斥规则不生效） */
  editMode?: boolean
  /** 经典终端冻结：新增图形控件在正常态不进入其布局。 */
  presentationProfileId?: string
}

/**
 * widget 可见性单一真值（C2）：渲染（ControlCenter.renderWidget）与高度计数
 * （resolveVisibleStatusWidgetCount）消费同一谓词，杜绝"计数多算不渲染的 widget"。
 */
export function isWidgetVisible(id: string, ctx: WidgetVisibilityCtx): boolean {
  const edit = ctx.editMode === true
  if (!edit && ctx.hidden.includes(id)) return false
  if (!edit
    && ctx.presentationProfileId === 'builtin.presentation.terminal-classic'
    && (id === 'session' || id === 'workspace' || id === 'activity')) return false
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
