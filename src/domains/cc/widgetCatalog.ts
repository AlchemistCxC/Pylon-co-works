import type { CcWidgetPlacement } from '../../ccLayoutState.ts'
import { CC_WIDGET_IDS, WIDGET_PROPERTY_FIELDS } from './widgetDefinitions.ts'
import type { CcWidgetContribution } from '../../plugin-runtime/cc-widget/ccWidgetTypes.ts'

const placement = (slot: CcWidgetPlacement['slot'], order: number): CcWidgetPlacement => ({ slot, order, offsetX: 0, offsetY: 0 })
const labels: Record<typeof CC_WIDGET_IDS[number], string> = {
  input: '输入栏', session: '当前会话', workspace: '工作区', activity: '运行状态', ekg: '用量条', pct: '百分比',
  tokens: 'Token数', model: '模型', mode: '权限模式', send: '发送按钮', attach: '附件按钮', tasks: '任务',
}
const categories: Record<typeof CC_WIDGET_IDS[number], string> = {
  input: 'input', session: 'runtime', workspace: 'runtime', activity: 'status', ekg: 'context', pct: 'context',
  tokens: 'context', model: 'runtime', mode: 'runtime', send: 'action', attach: 'action', tasks: 'status',
}
const placements: Record<typeof CC_WIDGET_IDS[number], CcWidgetPlacement> = {
  input: placement('input', 0), session: placement('status-secondary', 0), workspace: placement('status-secondary', 1),
  model: placement('status-secondary', 2), mode: placement('status-secondary', 3), activity: placement('status-primary', 0),
  ekg: placement('status-primary', 1), pct: placement('status-primary', 2), tokens: placement('status-primary', 3),
  send: placement('actions', 0), attach: placement('actions', 1), tasks: placement('status-primary', 4),
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
  render: { kind: 'host-renderer', rendererKey: 'cc-surface' },
  propertyFields: Object.freeze([
    { kind: 'theme-field', key: 'ccHeight', label: '中控区高度' },
    { kind: 'theme-field', key: 'ccMarginX', label: '左右边距' },
    { kind: 'theme-field', key: 'ccMarginBottom', label: '底边距' },
    { kind: 'theme-field', key: 'ccRadius', label: '圆角' },
    { kind: 'theme-field', key: 'ccBg', label: '中控区背景' },
    { kind: 'theme-field', key: 'ccSurfaceOpacity', label: '透明度' },
  ]),
})

/** Registered builtin contributions. P2 intentionally exposes only the body surface. */
export const BUILTIN_CC_WIDGET_CONTRIBUTIONS = Object.freeze([
  BUILTIN_CC_SURFACE_CONTRIBUTION,
] as const)

export type BuiltinCcWidgetId = typeof CC_WIDGET_IDS[number]
export type CcWidgetRuntimeId = BuiltinCcWidgetId | (string & {})
