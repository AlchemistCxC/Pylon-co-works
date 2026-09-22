import { CC_WIDGET_IDS, WIDGET_PROPERTY_FIELDS, resolveCcWidgetGroup } from './widgetDefinitions.ts'
import type { CcWidgetContribution } from '../../plugin-runtime/cc-widget/ccWidgetTypes.ts'

/**
 * 表里那一行的取用口（表是唯一真值）。
 * 缺行 = 定义表被改坏，直接抛，不做静默降级。
 */
function groupOf(id: string) {
  const row = resolveCcWidgetGroup(id)
  if (!row) throw new Error(`中控定义表缺少组：${id}`)
  return row
}

/** Legacy widget definitions retained for the switch renderer. */
export const BUILTIN_CC_WIDGET_DEFINITIONS = Object.freeze(CC_WIDGET_IDS.map(id => {
  const row = groupOf(id)
  const propertyFields = WIDGET_PROPERTY_FIELDS[id]
  return {
    id,
    label: row.label,
    category: row.category,
    defaultPlacement: { ...row.defaultPlacement! },
    ...(propertyFields.length > 0 ? { propertyFields } : {}),
  }
}) as CcWidgetContribution[])

/** The control-center body surface is the first builtin widget migrated to the
 * registration channel. The twelve legacy widgets remain catalog definitions,
 * but their switch-based renderers are intentionally not registered yet. */
export const BUILTIN_CC_SURFACE_CONTRIBUTION: CcWidgetContribution = Object.freeze({
  id: 'cc-surface',
  label: groupOf('cc-surface').label,
  category: groupOf('cc-surface').category,
  render: { kind: 'host-renderer' as const, rendererKey: 'cc-surface' },
  propertyFields: Object.freeze([
    { kind: 'theme-field', key: 'ccHeight', label: '中控区高度' },
    { kind: 'theme-field', key: 'ccMarginX', label: '左右边距' },
    { kind: 'theme-field', key: 'ccMarginBottom', label: '底边距' },
    { kind: 'theme-field', key: 'ccRadius', label: '圆角' },
    { kind: 'theme-field', key: 'ccBg', label: '中控区背景' },
    { kind: 'theme-field', key: 'ccSurfaceOpacity', label: '透明度' },
  ]),
})

export const BUILTIN_CC_SEND_BUTTON_CONTRIBUTION: CcWidgetContribution = Object.freeze({
  id: 'cc-send-button',
  label: groupOf('cc-send-button').label,
  category: groupOf('cc-send-button').category,
  // legacy `send` 槽位事实迁到注册轨（F1=A）：默认仍在操作区首位。
  defaultPlacement: { ...groupOf('cc-send-button').defaultPlacement! },
  render: { kind: 'host-renderer' as const, rendererKey: 'cc-send-button' },
  propertyFields: Object.freeze([
    { kind: 'theme-field', key: 'inputSubmitButtonMode', label: '位置' },
    { kind: 'theme-field', key: 'sendButtonColor', label: '颜色' },
    { kind: 'theme-field', key: 'sendButtonRadius', label: '圆角' },
    { kind: 'theme-field', key: 'sendButtonBorderColor', label: '边框' },
    { kind: 'theme-field', key: 'sendButtonIcon', label: '图标' },
    { kind: 'theme-field', key: 'sendButtonIconGenerating', label: '生成中图标' },
    { kind: 'theme-field', key: 'sendButtonIconRound', label: '图标圆角' },
    { kind: 'theme-field', key: 'sendButtonIconColor', label: '图标颜色' },
  ]),
})

/** Registered builtin contributions exposed through the CC widget channel. */
export const BUILTIN_CC_WIDGET_CONTRIBUTIONS = Object.freeze([
  BUILTIN_CC_SURFACE_CONTRIBUTION,
  BUILTIN_CC_SEND_BUTTON_CONTRIBUTION,
] as const)

export type BuiltinCcWidgetId = typeof CC_WIDGET_IDS[number]
export type CcWidgetRuntimeId = BuiltinCcWidgetId | (string & {})
