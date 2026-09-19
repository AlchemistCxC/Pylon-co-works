import type { CcWidgetPlacement } from '../../ccLayoutState.ts'
import { CC_WIDGET_IDS, WIDGET_PROPERTY_FIELDS } from './widgetDefinitions.ts'
import type { CcWidgetContribution } from '../../plugin-runtime/cc-widget/ccWidgetTypes.ts'

const placement = (slot: CcWidgetPlacement['slot'], order: number): CcWidgetPlacement => ({ slot, order, offsetX: 0, offsetY: 0 })
const labels: Record<typeof CC_WIDGET_IDS[number], string> = {
  input: '输入栏', tokens: '用量', model: '模型', reasoning: '思考强度', mode: '权限模式',
}
const categories: Record<typeof CC_WIDGET_IDS[number], string> = {
  input: 'input', tokens: 'context', model: 'runtime', reasoning: 'runtime', mode: 'runtime',
}
const placements: Record<typeof CC_WIDGET_IDS[number], CcWidgetPlacement> = {
  input: placement('input', 0), model: placement('status-secondary', 2), reasoning: placement('status-secondary', 3),
  mode: placement('status-secondary', 4), tokens: placement('status-secondary', 5),
}

/** Legacy widget definitions retained for the switch renderer. */
export const BUILTIN_CC_WIDGET_DEFINITIONS = Object.freeze(CC_WIDGET_IDS.map(id => ({
  id,
  label: labels[id],
  category: categories[id],
  defaultPlacement: placements[id],
  ...(WIDGET_PROPERTY_FIELDS[id].length > 0 ? { propertyFields: WIDGET_PROPERTY_FIELDS[id] } : {}),
})) as CcWidgetContribution[])

/** The control-center body surface is the first builtin widget migrated to the
 * registration channel. The twelve legacy widgets remain catalog definitions,
 * but their switch-based renderers are intentionally not registered yet. */
export const BUILTIN_CC_SURFACE_CONTRIBUTION: CcWidgetContribution = Object.freeze({
  id: 'cc-surface',
  label: '中控本体背景板',
  category: 'surface',
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
  label: '发送按钮',
  category: 'action',
  // legacy `send` 槽位事实迁到注册轨（F1=A）：默认仍在操作区首位。
  defaultPlacement: placement('actions', 0),
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
