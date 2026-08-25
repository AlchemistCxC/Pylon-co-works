/**
 * C04 provider-neutral tool lifecycle render contracts.
 *
 * These kinds describe content accepted by renderer Slots. They deliberately
 * validate ToolInvocationSnapshot instead of provider envelopes or legacy
 * Message objects, keeping wire parsing in normalizers/projectors.
 */
import type { RenderKindDefinition } from '../../plugin-runtime/renderers/rendererTypes.ts'
import type { RendererSettingsSchema } from '../../plugin-runtime/renderers/rendererSettingsTypes.ts'
import { isJsonValue } from '../workbench/content/contentPartSchema.ts'
import { isValidNormalizedErrorInput } from '../workbench/lifecycle/lifecycleModel.ts'

function toolSettings(kindId: string): RendererSettingsSchema {
  return {
  schemaVersion: 1,
  groups: [
    {
      id: 'appearance', label: '工具卡外观', layout: 'grid', fields: [
        { key: 'foreground', label: '主文字颜色', type: 'color', presentation: 'palette+picker', alpha: true, default: 'var(--text)' },
        { key: 'mutedForeground', label: '次要文字颜色', type: 'color', presentation: 'palette+picker', alpha: true, default: 'var(--text-dim)' },
        { key: 'background', label: '背景色', type: 'color', presentation: 'palette+picker', alpha: true, default: 'transparent' },
        { key: 'borderColor', label: '边框颜色', type: 'color', presentation: 'palette+picker', alpha: true, default: 'var(--border)' },
        { key: 'statusPalette', label: '状态配色', type: 'choice', presentation: 'select', options: [
          { value: 'semantic', label: '语义色' }, { value: 'neutral', label: '中性色' }, { value: 'accent', label: '强调色' },
        ], optionTarget: `kind.${kindId}.statusPalette`, default: 'semantic' },
        { key: 'indicator', label: '状态指示器', type: 'choice', presentation: 'segmented', options: [
          { value: 'glyph', label: '图标' }, { value: 'dot', label: '圆点' }, { value: 'none', label: '隐藏' },
        ], optionTarget: `kind.${kindId}.indicator`, default: 'glyph' },
        { key: 'density', label: '密度', type: 'choice', presentation: 'segmented', options: [
          { value: 'comfortable', label: '舒适' }, { value: 'compact', label: '紧凑' },
        ], default: 'comfortable' },
        { key: 'maxWidth', label: '最大宽度', type: 'number', presentation: 'slider+input', min: 240, max: 1600, step: 20, unit: 'px', default: 960 },
        { key: 'maxHeight', label: '内容最大高度', type: 'number', presentation: 'slider+input', min: 80, max: 1200, step: 20, unit: 'px', default: 420 },
      ],
    },
    {
      id: 'behaviour', label: '工具卡内容', layout: 'grid', fields: [
        { key: 'defaultCollapsed', label: '默认折叠', type: 'boolean', presentation: 'toggle', default: true },
        { key: 'showRaw', label: '显示 raw 审计信息', type: 'boolean', presentation: 'toggle', default: false },
        { key: 'showMetadata', label: '显示 metadata', type: 'boolean', presentation: 'toggle', default: true },
        { key: 'showDuration', label: '显示耗时', type: 'boolean', presentation: 'toggle', default: true },
        { key: 'connectorMode', label: '连接线', type: 'choice', presentation: 'segmented', options: [
          { value: 'semantic', label: '语义关系' }, { value: 'none', label: '关闭' },
        ], default: 'semantic' },
        { key: 'connectorStyle', label: '连接线样式', type: 'choice', presentation: 'segmented', options: [
          { value: 'solid', label: '实线' }, { value: 'dashed', label: '虚线' },
        ], default: 'solid' },
        { key: 'connectorWidth', label: '连接线宽度', type: 'number', presentation: 'slider+input', min: 1, max: 8, step: 1, unit: 'px', default: 1 },
        { key: 'connectorOpacity', label: '连接线透明度', type: 'number', presentation: 'slider+input', min: 0, max: 1, step: 0.05, default: 0.6 },
      ],
    },
  ],
  } satisfies RendererSettingsSchema
}

const TOOL_DEFAULT_TOKENS = Object.freeze({
  foreground: 'var(--text)', mutedForeground: 'var(--text-dim)', background: 'transparent', borderColor: 'var(--border)',
  statusPalette: 'semantic', indicator: 'glyph', density: 'comfortable', maxWidth: 960, maxHeight: 420,
  defaultCollapsed: true, showRaw: false, showMetadata: true, showDuration: true,
  connectorMode: 'semantic', connectorStyle: 'solid', connectorWidth: 1, connectorOpacity: 0.6,
})

function toolFixture(id: (typeof ids)[number]): Readonly<Record<string, unknown>> {
  const base = {
    id: `fixture-${id}`,
    name: 'ProviderTool',
    canonicalName: 'provider_tool',
    title: 'Fixture tool',
    status: 'running',
    input: { path: '/fixture/input.txt' },
  }
  if (id === 'tool.progress') return Object.freeze({ ...base, progress: { completed: 1, total: 3, message: 'working' } })
  if (id === 'tool.output') return Object.freeze({ ...base, status: 'completed', result: { status: 'completed', parts: [{ kind: 'text', text: 'fixture output' }], durationMs: 1200 } })
  if (id === 'tool.error') return Object.freeze({
    ...base,
    status: 'failed',
    result: { status: 'failed', error: { userSummary: 'fixture failure', technicalMessage: 'fixture failure', recoverability: 'none' } },
  })
  return Object.freeze(base)
}

export function isToolInvocationSnapshotInput(input: unknown): boolean {
  if (!isRecord(input) || typeof input.id !== 'string' || input.id.trim().length === 0) return false
  if (input.status !== undefined && typeof input.status !== 'string') return false
  for (const key of ['title', 'canonicalName', 'name', 'semanticKind', 'kind', 'action', 'parentToolCallId'] as const) {
    if (input[key] !== undefined && typeof input[key] !== 'string') return false
  }
  for (const key of ['input', 'rawInput', 'locations', 'progress', 'capabilities'] as const) {
    if (input[key] !== undefined && !isJsonValue(input[key])) return false
  }
  if (input.result !== undefined) {
    if (!isRecord(input.result)) return false
    if (input.result.status !== undefined && typeof input.result.status !== 'string') return false
    if (input.result.error !== undefined && !isValidNormalizedErrorInput(input.result.error)) return false
    if (input.result.durationMs !== undefined && (!Number.isFinite(input.result.durationMs) || Number(input.result.durationMs) < 0)) return false
    if (input.result.parts !== undefined && (!Array.isArray(input.result.parts) || !isJsonValue(input.result.parts))) return false
    if (input.result.rawOutput !== undefined && !isJsonValue(input.result.rawOutput)) return false
  }
  return true
}

const ids = [
  'tool.generic', 'tool.input', 'tool.progress', 'tool.output', 'tool.error',
  'tool.read', 'tool.edit', 'tool.search', 'tool.fetch', 'tool.execute',
] as const

export const BUILTIN_TOOL_RENDER_KINDS: readonly RenderKindDefinition[] = Object.freeze(ids.map(id => Object.freeze({
  id,
  category: 'tool',
  fallbackKind: id === 'tool.generic' ? 'content.unknown' : 'tool.generic',
  priority: 1000,
  fixture: toolFixture(id),
  defaultTokens: TOOL_DEFAULT_TOKENS,
  settingsSchemaVersion: 1,
  settings: toolSettings(id),
  validateInput: isToolInvocationSnapshotInput,
} satisfies RenderKindDefinition)))

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
