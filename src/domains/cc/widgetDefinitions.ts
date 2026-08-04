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
