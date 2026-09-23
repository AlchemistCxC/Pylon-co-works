import { CC_WIDGET_IDS, resolveCcWidgetGroup } from './widgetDefinitions.ts'
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

/**
 * 表里那一行的**默认位置**（插件契约形状）。
 * ★ #238 刀3：槽位退场后改成 `anchor` + `side`；两轴当前共用同一锚点（`layout.x.anchor === layout.y.anchor`），
 * 这里报 x 轴那份（水平侧的落位更有信息量）。缺 `layout` = 容器，返回 undefined。
 */
function defaultPlacementOf(id: string) {
  const layout = groupOf(id).layout
  return layout
    ? { anchor: layout.x.anchor, side: layout.x.side, order: layout.order, offsetX: 0, offsetY: 0 }
    : undefined
}

/**
 * The control-center body surface is the first builtin widget migrated to the
 * registration channel. The remaining builtin widgets render through the
 * definition table's own rails, not through this channel.
 */
export const BUILTIN_CC_SURFACE_CONTRIBUTION: CcWidgetContribution = Object.freeze({
  id: 'cc-surface',
  label: groupOf('cc-surface').label,
  category: groupOf('cc-surface').category,
  render: { kind: 'host-renderer' as const, rendererKey: 'cc-surface' },
})

export const BUILTIN_CC_SEND_BUTTON_CONTRIBUTION: CcWidgetContribution = Object.freeze({
  id: 'cc-send-button',
  label: groupOf('cc-send-button').label,
  category: groupOf('cc-send-button').category,
  // legacy `send` 槽位事实迁到注册轨（F1=A）：默认仍在输入栏右端、垂直居中。
  defaultPlacement: defaultPlacementOf('cc-send-button')!,
  render: { kind: 'host-renderer' as const, rendererKey: 'cc-send-button' },
})

/** Registered builtin contributions exposed through the CC widget channel. */
export const BUILTIN_CC_WIDGET_CONTRIBUTIONS = Object.freeze([
  BUILTIN_CC_SURFACE_CONTRIBUTION,
  BUILTIN_CC_SEND_BUTTON_CONTRIBUTION,
] as const)

export type BuiltinCcWidgetId = typeof CC_WIDGET_IDS[number]
export type CcWidgetRuntimeId = BuiltinCcWidgetId | (string & {})
