import type { CcWidgetPlacement } from '../../ccLayoutState.ts'
import type { WidgetPropertyDef, WidgetPropertyField } from './widgetDefinitions.ts'

export type CcWidgetRenderSpec = {
  kind: 'host-renderer'
  rendererKey: string
}

export interface CcWidgetCatalogEntry {
  id: string
  label: string
  category: 'input' | 'status' | 'context' | 'runtime' | 'action'
  defaultPlacement: CcWidgetPlacement
  naturalSize: boolean
  propertyFields: readonly (WidgetPropertyField & WidgetPropertyDef)[]
  render?: CcWidgetRenderSpec
}

const placement = (slot: CcWidgetPlacement['slot'], order: number): CcWidgetPlacement => ({
  slot,
  order,
  offsetX: 0,
  offsetY: 0,
})

const propertyFields: Record<string, readonly (WidgetPropertyField & WidgetPropertyDef)[]> = {
  input: [
    { kind: 'section', title: '输入栏设置' },
    { kind: 'color', key: 'inputBg', label: '背景色' },
    { kind: 'color', key: 'inputTextColor', label: '文字色' },
    { kind: 'number', key: 'inputFontSize', label: '字号', min: 12, max: 22, step: 0.1 },
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
  ekg: [
    { kind: 'section', title: '用量条显示' },
    {
      kind: 'chips', key: 'ccStyle', label: '仪表类型',
      options: [
        { value: 'wave', label: '活动波形' },
        { value: 'bar', label: '用量进度条' },
        { value: 'ring', label: '环形进度' },
        { value: 'numeric', label: '百分比数值' },
      ],
    },
    { kind: 'number', key: 'ekgWidth', label: '宽度', min: 80, max: 400, step: 0.1 },
    { kind: 'color', key: 'ekgGreen', label: '正常状态', showIf: t => t.ccStyle === 'wave' },
    { kind: 'color', key: 'ekgYellow', label: '警示状态', showIf: t => t.ccStyle === 'wave' },
    { kind: 'color', key: 'ekgRed', label: '危险状态', showIf: t => t.ccStyle === 'wave' },
    { kind: 'color', key: 'barTrackColor', label: '轨道颜色', showIf: t => t.ccStyle === 'bar' },
    { kind: 'number', key: 'barHeight', label: '高度', min: 4, max: 40, step: 0.1, showIf: t => t.ccStyle === 'bar' },
    { kind: 'chipsBool', key: 'barFillFollow', label: '填充色跟随用量', trueLabel: '三段色', falseLabel: '固定色', showIf: t => t.ccStyle === 'bar' },
    { kind: 'color', key: 'barFillColor', label: '填充颜色', showIf: t => t.ccStyle === 'bar' && t.barFillFollow === false },
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
  pct: [], tokens: [], tasks: [], session: [], workspace: [], activity: [],
}

export const BUILTIN_CC_WIDGET_CONTRIBUTIONS = [
  { id: 'input', label: '输入栏', category: 'input', defaultPlacement: placement('input', 0), naturalSize: false, propertyFields: propertyFields.input },
  { id: 'session', label: '当前会话', category: 'runtime', defaultPlacement: placement('status-secondary', 0), naturalSize: true, propertyFields: propertyFields.session, render: { kind: 'host-renderer', rendererKey: 'session' } },
  { id: 'workspace', label: '工作区', category: 'runtime', defaultPlacement: placement('status-secondary', 1), naturalSize: true, propertyFields: propertyFields.workspace, render: { kind: 'host-renderer', rendererKey: 'workspace' } },
  { id: 'activity', label: '运行状态', category: 'status', defaultPlacement: placement('status-primary', 0), naturalSize: true, propertyFields: propertyFields.activity, render: { kind: 'host-renderer', rendererKey: 'activity' } },
  { id: 'ekg', label: '用量条', category: 'context', defaultPlacement: placement('status-primary', 1), naturalSize: true, propertyFields: propertyFields.ekg, render: { kind: 'host-renderer', rendererKey: 'ekg' } },
  { id: 'pct', label: '百分比', category: 'context', defaultPlacement: placement('status-primary', 2), naturalSize: true, propertyFields: propertyFields.pct, render: { kind: 'host-renderer', rendererKey: 'pct' } },
  { id: 'tokens', label: 'Token数', category: 'context', defaultPlacement: placement('status-primary', 3), naturalSize: true, propertyFields: propertyFields.tokens, render: { kind: 'host-renderer', rendererKey: 'tokens' } },
  { id: 'model', label: '模型', category: 'runtime', defaultPlacement: placement('status-secondary', 2), naturalSize: true, propertyFields: propertyFields.model, render: { kind: 'host-renderer', rendererKey: 'model' } },
  { id: 'mode', label: '权限模式', category: 'runtime', defaultPlacement: placement('status-secondary', 3), naturalSize: true, propertyFields: propertyFields.mode, render: { kind: 'host-renderer', rendererKey: 'mode' } },
  { id: 'send', label: '发送按钮', category: 'action', defaultPlacement: placement('actions', 0), naturalSize: true, propertyFields: propertyFields.send },
  { id: 'attach', label: '附件按钮', category: 'action', defaultPlacement: placement('actions', 1), naturalSize: true, propertyFields: propertyFields.attach },
  { id: 'tasks', label: '任务', category: 'status', defaultPlacement: placement('status-primary', 4), naturalSize: true, propertyFields: propertyFields.tasks, render: { kind: 'host-renderer', rendererKey: 'tasks' } },
] as const satisfies readonly CcWidgetCatalogEntry[]

export type BuiltinCcWidgetId = typeof BUILTIN_CC_WIDGET_CONTRIBUTIONS[number]['id']
export type CcWidgetId = BuiltinCcWidgetId
export type CcWidgetRuntimeId = CcWidgetId | (string & {})
export const CC_WIDGET_IDS = BUILTIN_CC_WIDGET_CONTRIBUTIONS.map(item => item.id)
export const STATUS_WIDGET_IDS = CC_WIDGET_IDS.filter(id => id !== 'input')
export const WIDGET_PROPERTY_FIELDS: Record<CcWidgetId, readonly (WidgetPropertyField & WidgetPropertyDef)[]> = Object.fromEntries(
  BUILTIN_CC_WIDGET_CONTRIBUTIONS.map(item => [item.id, item.propertyFields]),
) as unknown as Record<CcWidgetId, readonly (WidgetPropertyField & WidgetPropertyDef)[]>
export const CC_WIDGET_LABELS: Readonly<Record<CcWidgetId, string>> = Object.fromEntries(
  BUILTIN_CC_WIDGET_CONTRIBUTIONS.map(item => [item.id, item.label]),
) as Record<CcWidgetId, string>
